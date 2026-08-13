import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(process.cwd(), 'bin/dockyard.js');
function fakeCaddyBin() {
  const bin = mkdtempSync(join(tmpdir(), 'dockyard-bin-'));
  writeFileSync(join(bin, 'caddy'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'caddy'), 0o755);
  return bin;
}
function run(home, args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, PATH: `${options.bin || fakeCaddyBin()}:${process.env.PATH}`, DOCKYARD_HOME: home },
    encoding: 'utf8'
  });
}
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'exampleproject-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'README.md'), 'test\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial');
  git(root, 'branch', '-M', 'main');
  return root;
}

test('registered projects use shared HTTP Caddy routes and compose names', () => {
  const home = mkdtempSync(join(tmpdir(), 'dockyard-'));
  const result = run(home, ['project', 'add', 'exampleProject', '--folder', '.', '--url', 'main.exampleproject.dev.test', '--command', 'just dev']);
  assert.equal(result.status, 0, result.stderr);
  const project = JSON.parse(readFileSync(join(home, 'projects.json'))).projects[0];
  assert.equal(project.composeProjectName, 'exampleproject');
  assert.match(readFileSync(join(home, 'Caddyfile'), 'utf8'), new RegExp(`http://main\\.exampleproject\\.dev\\.test \\{[\\s\\S]*127\\.0\\.0\\.1:${project.httpPort}`));
});

test('run derives branch.project.domain and injects Docker-safe environment', () => {
  const home = mkdtempSync(join(tmpdir(), 'dockyard-'));
  const root = repository();
  git(root, 'checkout', '-qb', 'feature/new-checkout');
  const result = run(home, ['run', 'node', '-e', '"console.log(JSON.stringify({url:process.env.LOCAL_URL,remote:process.env.TAILSCALE_URL,compose:process.env.COMPOSE_PROJECT_NAME,http:process.env.HTTP_PORT,https:process.env.HTTPS_PORT}))"'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const env = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{')));
  const projectName = root.split('/').at(-1).toLowerCase();
  assert.equal(env.url, `http://feature-new-checkout.${projectName}.dev.test`);
  assert.equal(env.remote, env.url);
  assert.equal(env.compose, `${projectName}-feature-new-checkout`);
  assert.notEqual(env.http, env.https);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'projects.json'))).projects, []);
});

test('main branch uses the project root hostname', () => {
  const home = mkdtempSync(join(tmpdir(), 'dockyard-'));
  const root = repository();
  const result = run(home, ['run', 'node', '-e', '"console.log(process.env.LOCAL_URL)"'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const projectName = root.split('/').at(-1).toLowerCase();
  assert.match(result.stdout, new RegExp(`http://${projectName}\\.dev\\.test`));
  assert.doesNotMatch(result.stdout, new RegExp(`main\\.${projectName}\\.dev\\.test`));
});

test('run supports explicit instance and project names', () => {
  const home = mkdtempSync(join(tmpdir(), 'dockyard-'));
  const result = run(home, ['run', '--name', 'Checkout V2', '--project', 'exampleProject', 'node', '-e', '"console.log(process.env.LOCAL_URL)"']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /http:\/\/checkout-v2\.exampleproject\.dev\.test/);
});

test('detached worktrees use a stable commit-based instance name', () => {
  const home = mkdtempSync(join(tmpdir(), 'dockyard-'));
  const root = repository();
  git(root, 'checkout', '--detach', '-q');
  const sha = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const result = run(home, ['run', 'node', '-e', '"console.log(process.env.LOCAL_URL)"'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`detached-${sha}`));
});

test('domain and HTTPS settings affect generated worktree routes', () => {
  const home = mkdtempSync(join(tmpdir(), 'dockyard-'));
  assert.equal(run(home, ['config', 'set', 'domain', 'dockyard.test']).status, 0);
  assert.equal(run(home, ['config', 'set', 'https', 'on']).status, 0);
  const result = run(home, ['run', '--name', 'main', '--project', 'exampleProject', 'node', '-e', '"console.log(process.env.LOCAL_URL)"']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/main\.exampleproject\.dockyard\.test/);
});

test('short private suffixes and exact project hosts are accepted', () => {
  const home = mkdtempSync(join(tmpdir(), 'dockyard-'));
  assert.equal(run(home, ['config', 'set', 'domain', 'rb']).status, 0);
  let result = run(home, ['run', '--name', 'feature', '--project', 'exampleProject', 'node', '-e', '"console.log(process.env.LOCAL_URL)"']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /http:\/\/feature\.exampleproject\.rb/);
  result = run(home, ['project', 'add', 'exampleProject', '--folder', '.', '--url', 'exampleproject.pb', '--command', 'true']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(home, 'Caddyfile'), 'utf8'), /http:\/\/exampleproject\.pb/);
});

test('dashboard refuses non-interactive output cleanly', () => {
  const home = mkdtempSync(join(tmpdir(), 'dockyard-'));
  const result = run(home, ['ui']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal/);
});
