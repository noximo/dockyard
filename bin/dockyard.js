#!/usr/bin/env node
import {
  closeSync, existsSync, mkdirSync, openSync,
  readFileSync, rmSync, unlinkSync, writeFileSync
} from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

const DATA_DIR = resolve(process.env.DOCKYARD_HOME || join(process.env.XDG_STATE_HOME || join(process.env.HOME || '.', '.local', 'state'), 'dockyard'));
const STATE_FILE = join(DATA_DIR, 'projects.json');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const CADDYFILE = join(DATA_DIR, 'Caddyfile');
const PID_FILE = join(DATA_DIR, 'caddy.pid');
const LOCK_FILE = join(DATA_DIR, 'state.lock');
const PORT_MIN = Number(process.env.DOCKYARD_PORT_MIN || 20000);
const PORT_MAX = Number(process.env.DOCKYARD_PORT_MAX || 45000);

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
function fail(message) { console.error(`Error: ${message}`); process.exitCode = 1; }
function ensureDir() { mkdirSync(DATA_DIR, { recursive: true }); }
function slug(value) {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!result) throw new Error('Name must contain at least one letter or number.');
  return result;
}
function safeHost(value) {
  const host = value.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw new Error(`Invalid URL host: ${value}`);
  return host;
}
function gitOutput(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
function boundedSlug(value, fallback, max = 63) {
  let result;
  try { result = slug(value); } catch { result = fallback; }
  if (result.length <= max) return result;
  const hash = createHash('sha256').update(result).digest('hex').slice(0, 8);
  return `${result.slice(0, max - 9).replace(/-+$/, '')}-${hash}`;
}
function worktreeIdentity(folder, nameOverride, projectOverride) {
  const root = gitOutput(folder, ['rev-parse', '--show-toplevel']);
  const commonDir = gitOutput(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const branch = gitOutput(folder, ['branch', '--show-current']);
  const commit = gitOutput(folder, ['rev-parse', '--short=8', 'HEAD']) || 'unknown';
  const project = boundedSlug(projectOverride || (commonDir ? basename(dirname(commonDir)) : root ? basename(root) : basename(folder)), 'project');
  const instance = boundedSlug(nameOverride || branch || `detached-${commit}`, `detached-${commit}`);
  return { project, instance, root: root || folder, branch: branch || null, commit, explicitInstance: Boolean(nameOverride) };
}
function worktreeHost(identity, instance, domain) {
  return identity.branch === 'main' && !identity.explicitInstance
    ? `${identity.project}.${domain}`
    : `${instance}.${identity.project}.${domain}`;
}
function isPidRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    const procStat = `/proc/${Number(pid)}/stat`;
    if (existsSync(procStat) && readFileSync(procStat, 'utf8').split(' ')[2] === 'Z') return false;
    return true;
  } catch { return false; }
}

function defaultConfig() { return { version: 1, domain: 'dev.test', https: false }; }
function readConfig() {
  ensureDir();
  if (!existsSync(CONFIG_FILE)) return defaultConfig();
  const stored = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  const defaults = defaultConfig();
  return { ...defaults, ...stored };
}
function writeConfig(config) { ensureDir(); writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); }

function readState() {
  ensureDir();
  if (!existsSync(STATE_FILE)) return { version: 1, projects: [] };
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!Array.isArray(state.projects)) throw new Error('projects must be an array');
    for (const project of state.projects) {
      project.runtime ||= {};
      if (project.runtime.projectPid && !isPidRunning(project.runtime.projectPid)) delete project.runtime.projectPid;
    }
    return state;
  }
  catch { throw new Error(`Could not parse ${STATE_FILE}`); }
}
function writeState(state) { ensureDir(); state.version = 1; writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); }
async function withLock(fn) {
  ensureDir(); let fd;
  for (let i = 0; i < 100; i++) {
    try { fd = openSync(LOCK_FILE, 'wx', 0o600); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await sleep(50); }
  }
  if (fd === undefined) throw new Error('Another dockyard command is updating state; try again.');
  try { return await fn(); } finally { closeSync(fd); try { unlinkSync(LOCK_FILE); } catch {} }
}

function isPortFree(port) {
  return new Promise(resolvePort => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => server.close(() => resolvePort(true)));
    server.listen(port, '127.0.0.1');
  });
}
async function allocatePorts(state) {
  const used = new Set(state.projects.flatMap(project => [project.httpPort, project.httpsPort]));
  for (let attempts = 0; attempts < 500; attempts++) {
    const httpPort = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
    const httpsPort = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
    if (httpPort !== httpsPort && !used.has(httpPort) && !used.has(httpsPort) && await isPortFree(httpPort) && await isPortFree(httpsPort)) return { httpPort, httpsPort };
  }
  throw new Error(`Could not find two free ports in ${PORT_MIN}-${PORT_MAX}.`);
}

function caddyfile(state) {
  const blocks = state.projects.map(project => {
    const scheme = project.https ? '' : 'http://';
    const tls = project.https ? '\n\ttls internal' : '';
    const local = `${scheme}${project.url} {${tls}\n\treverse_proxy 127.0.0.1:${project.httpPort}\n}`;
    return local;
  }).join('\n\n');
  return `# Generated by dockyard. Do not edit; it is regenerated on every change.\n{\n\tadmin 127.0.0.1:2019\n}\n\n${blocks}\n`;
}
function writeCaddyfile(state) { ensureDir(); writeFileSync(CADDYFILE, caddyfile(state), { mode: 0o600 }); }
function caddyRunning() { return existsSync(PID_FILE) && isPidRunning(readFileSync(PID_FILE, 'utf8').trim()); }
function reloadCaddy() {
  if (!caddyRunning()) return;
  const child = spawn('caddy', ['reload', '--config', CADDYFILE, '--adapter', 'caddyfile'], { stdio: 'ignore' });
  child.on('error', error => console.warn(`Warning: Caddy config changed but reload failed: ${error.message}`));
}
function startCaddy(state) {
  writeCaddyfile(state);
  if (caddyRunning()) return false;
  const log = openSync(join(DATA_DIR, 'caddy.log'), 'a');
  const child = spawn('caddy', ['run', '--config', CADDYFILE, '--adapter', 'caddyfile'], { detached: true, stdio: ['ignore', log, log] });
  child.on('error', error => console.error(`Could not start Caddy: ${error.message}`));
  child.unref(); writeFileSync(PID_FILE, String(child.pid)); return true;
}

function projectUrl(project) { return `${project.https ? 'https' : 'http'}://${project.url}`; }
function envFor(project) {
  return {
    ...process.env,
    HTTP_PORT: String(project.httpPort),
    HTTPS_PORT: String(project.httpsPort),
    COMPOSE_PROJECT_NAME: project.composeProjectName || project.id,
    LOCAL_URL: projectUrl(project),
    TAILSCALE_URL: projectUrl(project)
  };
}
async function spawnProject(project, foreground) {
  if (!existsSync(project.folder)) throw new Error(`Project folder does not exist: ${project.folder}`);
  if (project.runtime?.projectPid && isPidRunning(project.runtime.projectPid)) throw new Error(`${project.name} is already running (pid ${project.runtime.projectPid}).`);
  const log = join(DATA_DIR, `${project.id}.log`);
  const child = spawn(project.command, { shell: true, cwd: project.folder, env: envFor(project), detached: !foreground, stdio: foreground ? 'inherit' : ['ignore', openSync(log, 'a'), openSync(log, 'a')] });
  await new Promise((resolveSpawn, rejectSpawn) => { child.once('spawn', resolveSpawn); child.once('error', rejectSpawn); });
  if (!foreground) child.unref();
  let earlyExit;
  await Promise.race([
    new Promise(resolveEarly => child.once('close', code => { earlyExit = code; resolveEarly(); })),
    sleep(150)
  ]);
  child.dockyardEarlyExit = earlyExit;
  if (earlyExit !== undefined && (!foreground || earlyExit !== 0)) throw new Error(`Project command exited during startup with code ${earlyExit}.`);
  return child;
}
function stopProjectProcess(project) {
  const pid = Number(project.runtime?.projectPid);
  if (!pid || !isPidRunning(pid)) { if (project.runtime) delete project.runtime.projectPid; return false; }
  try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
  delete project.runtime.projectPid; return true;
}
async function startManagedProject(state, project, foreground = false) {
  if (!caddyRunning()) startCaddy(state);
  let child;
  try {
    child = await spawnProject(project, foreground);
    project.runtime = { projectPid: child.pid };
    return child;
  } catch (error) {
    if (child?.pid && isPidRunning(child.pid)) try { process.kill(foreground ? child.pid : -child.pid, 'SIGTERM'); } catch {}
    throw error;
  }
}
async function stopManagedProject(project) {
  const hadProject = stopProjectProcess(project);
  project.runtime = {};
  return hadProject;
}

function probeUrl(url, local = false) {
  if (!url) return Promise.resolve(false);
  const parsed = new URL(url);
  return new Promise(resolveProbe => {
    const requester = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = requester({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: '/', method: 'GET', rejectUnauthorized: !local, timeout: 1500 }, response => {
      response.resume(); resolveProbe(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.once('timeout', () => request.destroy()); request.once('error', () => resolveProbe(false)); request.end();
  });
}
async function projectHealth(project) {
  return probeUrl(projectUrl(project), project.https);
}
function clip(value, length) { value = String(value); return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`; }
async function dashboard() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The dashboard requires an interactive terminal.');
  let selected = 0, message = '', refreshing = false, closed = false, finish;
  const done = new Promise(resolveDone => { finish = resolveDone; });
  async function render() {
    if (refreshing || closed) return; refreshing = true;
    const projects = readState().projects; selected = Math.max(0, Math.min(selected, Math.max(0, projects.length - 1)));
    const health = await Promise.all(projects.map(projectHealth));
    readline.cursorTo(process.stdout, 0, 0); readline.clearScreenDown(process.stdout);
    console.log('Dockyard  •  development projects and worktrees');
    console.log('↑/↓ select   Enter start/stop   r refresh   q quit\n');
    console.log('  PROJECT             PROCESS    URL         PORTS          ADDRESS');
    console.log('  ──────────────────  ─────────  ──────────  ─────────────  ─────────────────────────────────────');
    if (!projects.length) console.log('  No projects registered. Use `dockyard project add …`.');
    projects.forEach((project, index) => {
      const processRunning = project.runtime?.projectPid && isPidRunning(project.runtime.projectPid);
      console.log(`${index === selected ? '›' : ' '} ${clip(project.name, 18).padEnd(18)}  ${(processRunning ? '● running' : '○ stopped').padEnd(9)}  ${(health[index] ? '● online' : '○ offline').padEnd(10)}  ${`${project.httpPort}/${project.httpsPort}`.padEnd(13)}  ${clip(projectUrl(project), 44)}`);
    });
    console.log(`\n${message || 'URL health is refreshed every 2 seconds.'}`); refreshing = false;
  }
  async function toggle() {
    try {
      await withLock(async () => {
        const state = readState(); const project = state.projects[selected]; if (!project) return;
        if (project.runtime?.projectPid && isPidRunning(project.runtime.projectPid)) { await stopManagedProject(project); message = `${project.name} stopped.`; }
        else { await startManagedProject(state, project); message = `${project.name} started.`; }
        writeState(state);
      });
    } catch (error) { message = `Error: ${error.message}`; }
    await render();
  }
  process.stdout.write('\x1b[?25l'); readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  const interval = setInterval(render, 2000);
  const onKey = async (_value, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) { close(); return; }
    if (key.name === 'up') selected = Math.max(0, selected - 1);
    else if (key.name === 'down') selected = Math.min(Math.max(0, readState().projects.length - 1), selected + 1);
    else if (key.name === 'return') { await toggle(); return; }
    if (key.name === 'r' || key.name === 'up' || key.name === 'down') await render();
  };
  const close = () => { if (closed) return; closed = true; clearInterval(interval); process.stdin.off('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\x1b[?25h\n'); finish(); };
  process.stdin.on('keypress', onKey); await render(); await done;
}

function printProject(project) {
  console.log(`${project.name}\n  URL:          ${projectUrl(project)}\n  Folder:       ${project.folder}\n  Command:      ${project.command}\n  Compose name: ${project.composeProjectName || project.id}\n  HTTP_PORT:    ${project.httpPort}\n  HTTPS_PORT:   ${project.httpsPort}\n  Status:       ${project.runtime?.projectPid && isPidRunning(project.runtime.projectPid) ? `running (pid ${project.runtime.projectPid})` : 'stopped'}`);
}
function usage() { console.log(`dockyard — stable hostnames for development projects and worktrees

Usage:
  dockyard ui
  dockyard caddy start|stop|status
  dockyard config set domain <suffix>
  dockyard config set https on|off
  dockyard config get domain|https
  dockyard config list
  dockyard start|stop <name>
  dockyard project add <name> --folder <path> --url <host> --command <command>
  dockyard project list|start|stop|show|remove <name>
  dockyard run [--name <instance>] [--project <project>] <command...>`); }

function option(args, key) { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : undefined; }
async function main(args) {
  if (!args.length || ['-h', '--help', 'help'].includes(args[0])) return usage();
  if (args[0] === 'ui' || args[0] === 'dashboard') return dashboard();
  if (args[0] === 'start' || args[0] === 'stop') return main(['project', args[0], ...args.slice(1)]);
  if (args[0] === 'config') {
    const config = readConfig(); const action = args[1];
    if (action === 'list') return console.log(JSON.stringify(config, null, 2));
    const key = args[2];
    if (!['domain', 'https'].includes(key)) throw new Error('Config key must be domain or https.');
    if (action === 'get') return console.log(key === 'https' ? (config.https ? 'on' : 'off') : config.domain);
    if (action === 'set') {
      if (key === 'https') {
        if (!['on', 'off'].includes(args[3])) throw new Error('Use: config set https on|off');
        config.https = args[3] === 'on';
      } else config.domain = safeHost(`x.${args[3]}`).slice(2);
      config.version = 1; writeConfig(config); return console.log(`${key} = ${key === 'https' ? (config.https ? 'on' : 'off') : config.domain}`);
    }
    throw new Error('Use: config set|get|list');
  }
  if (args[0] === 'caddy') {
    const action = args[1]; const state = readState(); writeCaddyfile(state);
    if (action === 'status') return console.log(caddyRunning() ? `running (pid ${readFileSync(PID_FILE, 'utf8').trim()})` : 'stopped');
    if (action === 'start') { if (caddyRunning()) return console.log('Caddy is already running.'); startCaddy(state); return console.log(`Caddy started (pid ${readFileSync(PID_FILE, 'utf8').trim()}).`); }
    if (action === 'stop') { if (!caddyRunning()) return console.log('Caddy is not running.'); process.kill(Number(readFileSync(PID_FILE, 'utf8')), 'SIGTERM'); rmSync(PID_FILE, { force: true }); return console.log('Caddy stopped.'); }
    throw new Error('Use: caddy start, stop, or status');
  }
  if (args[0] === 'project') {
    const action = args[1];
    if (action === 'list') { const projects = readState().projects; if (!projects.length) return console.log('No projects registered.'); projects.forEach(project => console.log(`${project.name.padEnd(18)} ${project.url.padEnd(35)} ${project.runtime?.projectPid && isPidRunning(project.runtime.projectPid) ? 'running' : 'stopped'}`)); return; }
    const name = args[2]; if (!name) throw new Error('Project name is required.');
    if (action === 'add') {
      const folder = option(args, '--folder'), url = option(args, '--url'), command = option(args, '--command');
      if (!folder || !url || !command) throw new Error('Use: project add <name> --folder <path> --url <host> --command <command>');
      return withLock(async () => {
        const state = readState(), id = slug(name), host = safeHost(url);
        if (state.projects.some(project => project.id === id || project.url === host)) throw new Error('A project with that name or URL already exists.');
        const project = { id, name, folder: resolve(folder), url: host, command, https: readConfig().https, composeProjectName: id, ...(await allocatePorts(state)), runtime: {}, createdAt: new Date().toISOString() };
        state.projects.push(project); writeState(state); writeCaddyfile(state); reloadCaddy(); printProject(project);
      });
    }
    return withLock(async () => {
      const state = readState(); const project = state.projects.find(item => item.id === slug(name)); if (!project) throw new Error(`Unknown project: ${name}`);
      if (action === 'show') return printProject(project);
      if (action === 'start') {
        try { await startManagedProject(state, project); writeState(state); console.log(`${project.name} started. ${projectUrl(project)}`); }
        catch (error) { writeState(state); throw error; } return;
      }
      if (action === 'stop') { if (!await stopManagedProject(project)) return console.log(`${project.name} is not running.`); writeState(state); return console.log(`${project.name} stopped.`); }
      if (action === 'remove') { if (project.runtime?.projectPid) throw new Error('Stop the project before removing it.'); state.projects = state.projects.filter(item => item !== project); writeState(state); writeCaddyfile(state); reloadCaddy(); return console.log(`${project.name} removed.`); }
      throw new Error('Use: project add, list, show, start, stop, or remove');
    });
  }
  if (args[0] === 'run') {
    let index = 1, nameOverride, projectOverride;
    while (['--name', '--project'].includes(args[index])) {
      if (!args[index + 1]) throw new Error(`${args[index]} requires a value.`);
      if (args[index] === '--name') nameOverride = args[index + 1]; else projectOverride = args[index + 1];
      index += 2;
    }
    if (args[index] === '--') index++;
    const command = args.slice(index).join(' ');
    if (!command) throw new Error('Use: run [--name <instance>] [--project <project>] <command...>');
    const config = readConfig(); let project, child;
    await withLock(async () => {
      const state = readState(), folder = resolve('.'), identity = worktreeIdentity(folder, nameOverride, projectOverride);
      let instance = identity.instance;
      let url = worktreeHost(identity, instance, config.domain);
      const collision = state.projects.find(item => item.url === url && resolve(item.folder) !== folder);
      if (collision) { instance = boundedSlug(`${instance}-${identity.commit}`,'worktree'); url = `${instance}.${identity.project}.${config.domain}`; }
      if (state.projects.some(item => item.url === url)) throw new Error(`This worktree is already running at ${projectUrl(state.projects.find(item => item.url === url))}.`);
      const id = `worktree-${identity.project}-${instance}`;
      project = { id, name: `${identity.project}/${instance}`, folder, url, command, https: config.https, composeProjectName: boundedSlug(`${identity.project}-${instance}`, 'dockyard'), worktree: identity, ...(await allocatePorts(state)), anonymous: true, runtime: {} };
      state.projects.push(project); writeState(state); writeCaddyfile(state);
      try { child = await startManagedProject(state, project, true); writeState(state); }
      catch (error) { state.projects = state.projects.filter(item => item.id !== project.id); writeState(state); writeCaddyfile(state); reloadCaddy(); throw error; }
    });
    printProject(project); console.log('\nRunning command (Ctrl-C stops it and removes all temporary routes):');
    let signal;
    const relay = name => { signal = name; if (child?.pid && isPidRunning(child.pid)) try { process.kill(child.pid, name); } catch {} };
    const onInt = () => relay('SIGINT'), onTerm = () => relay('SIGTERM'); process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
    try { if (child.dockyardEarlyExit === undefined) await new Promise(resolveChild => child.once('close', resolveChild)); }
    finally {
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
      await withLock(async () => { const state = readState(), current = state.projects.find(item => item.id === project.id) || project; await stopManagedProject(current); state.projects = state.projects.filter(item => item.id !== project.id); writeState(state); writeCaddyfile(state); reloadCaddy(); });
    }
    if (signal) process.exitCode = 128 + (signal === 'SIGINT' ? 2 : 15); return;
  }
  throw new Error(`Unknown command: ${args[0]}`);
}

main(process.argv.slice(2)).catch(error => fail(error.message));
