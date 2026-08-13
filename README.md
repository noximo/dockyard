# Dockyard

Dockyard gives Docker projects and Git worktrees stable private hostnames. It assigns free ports, starts each project with the right environment, and keeps one Caddy reverse proxy in front of everything.

```text
main branch                 http://exampleproject.rb
feature/login branch        http://feature-login.exampleproject.rb
detached worktree           http://detached-a1b2c3d4.exampleproject.rb
```

The same URLs work on another computer when both machines use Tailscale and private DNS points the suffix at the development computer.

## Requirements

- Linux development computer
- Node.js 20 or newer
- Caddy on `PATH`
- Git for automatic worktree names
- Tailscale on the development computer and remote clients

Dockyard itself does not call `sudo`. Caddy needs permission to bind port 80, and port 443 when HTTPS is enabled. Run Caddy as a system service or grant its binary the required bind capability.

## Install

Clone the repository and link the CLI:

```sh
git clone https://github.com/noximo/dockyard.git
cd dockyard
npm link
```

Check the installation:

```sh
dockyard --help
dockyard config list
```

AI agents can use the repository as an [Agent Skill](https://agentskills.io/home). Install or link the repository in the agent's skills directory and invoke the `dockyard` skill. See [`SKILL.md`](SKILL.md) for the agent workflow.

## Choose a private suffix

Dockyard defaults to `dev.test`. Set a shorter suffix if you control DNS for it:

```sh
dockyard config set domain rb
```

`.test` is permanently reserved for testing. Short private suffixes such as `.rb` are convenient but are not reserved, so they could conflict with a future public top-level domain.

Dockyard uses HTTP by default. Tailscale encrypts traffic between tailnet devices. Enable Caddy's internal HTTPS only when the browser or application requires a secure context:

```sh
dockyard config set https on
```

Clients must trust Caddy's local root CA when HTTPS is enabled.

## Run a worktree

Run a development command from any Git worktree:

```sh
cd /projects/exampleProject-feature-login
dockyard run docker compose up
```

Dockyard reads the repository and branch names from Git. For a repository named `exampleProject`, the command above receives:

```text
HTTP_PORT=<assigned port>
HTTPS_PORT=<different assigned port>
COMPOSE_PROJECT_NAME=exampleproject-feature-login
LOCAL_URL=http://feature-login.exampleproject.rb
TAILSCALE_URL=http://feature-login.exampleproject.rb
```

The `main` branch omits the branch label and uses `http://exampleproject.rb`. Detached worktrees use the short commit SHA. Long or unusual branch names are converted into valid DNS labels.

Override the detected names when needed:

```sh
dockyard run --name checkout-v2 --project exampleProject docker compose up
```

An explicit `--name main` keeps `main` as a subdomain. Dockyard removes the temporary route and state when the command exits or receives Ctrl-C or SIGTERM.

## Docker Compose

Publish the application through the assigned loopback port:

```yaml
services:
  app:
    ports:
      - "127.0.0.1:${HTTP_PORT}:3000"
```

The application inside the container must listen on `0.0.0.0:3000` in this example. `COMPOSE_PROJECT_NAME` keeps simultaneous worktrees from sharing Compose containers, networks, and named volumes.

`HTTPS_PORT` is available for projects that need a second host port. Caddy normally terminates HTTP or HTTPS itself and forwards traffic to `HTTP_PORT`.

## Registered projects

Projects without worktrees can use any exact private hostname:

```sh
dockyard project add exampleProject \
  --folder /projects/exampleProject \
  --url exampleproject.pb \
  --command 'docker compose up'

dockyard start exampleProject
dockyard stop exampleProject
```

Inspect or remove a registration:

```sh
dockyard project list
dockyard project show exampleProject
dockyard project remove exampleProject
```

## Remote DNS over Tailscale

The remote computer must resolve every Dockyard hostname to the development computer's Tailscale IP. Hosts files work for individual names but not wildcards, so worktree URLs are easier with a small DNS server.

### Recommended setup for all clients

Run `dnsmasq` on a Linux machine in the tailnet. It can be the same machine that runs Dockyard. Replace `100.64.0.10` with that machine's Tailscale IP:

```ini
# /etc/dnsmasq.d/dockyard.conf
interface=tailscale0
bind-dynamic
listen-address=100.64.0.10
address=/.rb/100.64.0.10
```

Restart `dnsmasq`, then allow tailnet clients to reach TCP and UDP port 53 on that machine.

In the Tailscale admin console:

1. Open the DNS page.
2. Add `100.64.0.10` as a restricted nameserver.
3. Restrict it to the `rb` domain.
4. Make sure each client accepts Tailscale DNS settings.

The restricted nameserver only receives queries ending in `.rb`. Other DNS queries continue to use the client's normal resolver.

### Windows client

Tailscale applies the restricted nameserver through Windows DNS policy. Verify it in PowerShell:

```powershell
Resolve-DnsName feature-login.exampleproject.rb
Test-NetConnection feature-login.exampleproject.rb -Port 80
```

Use `Resolve-DnsName`, not `nslookup`, when testing Tailscale split DNS. `nslookup` bypasses the Windows DNS policy used for split DNS.

For one fixed project, you can skip wildcard DNS and edit the hosts file as Administrator:

```text
C:\Windows\System32\drivers\etc\hosts

100.64.0.10 exampleproject.pb
```

Flush the Windows DNS cache after changing the file:

```powershell
Clear-DnsClientCache
```

### Linux client

Make sure Tailscale accepts DNS settings:

```sh
tailscale set --accept-dns=true
```

Test resolution through the operating system resolver:

```sh
getent hosts feature-login.exampleproject.rb
curl -I http://feature-login.exampleproject.rb
```

For one fixed project, add an explicit entry to `/etc/hosts`:

```text
100.64.0.10 exampleproject.pb
```

Do not edit `/etc/resolv.conf` directly. NetworkManager, systemd-resolved, or Tailscale may regenerate it.

## Caddy

Manage the shared proxy with:

```sh
dockyard caddy start
dockyard caddy status
dockyard caddy stop
```

Dockyard generates the Caddyfile from active and registered projects. Do not edit the generated file. Applications should bind their assigned ports to `127.0.0.1`; Caddy is the only tailnet-facing HTTP endpoint.

Set a different application port range when necessary:

```sh
export DOCKYARD_PORT_MIN=20000
export DOCKYARD_PORT_MAX=45000
```

## Dashboard

Run the terminal dashboard:

```sh
dockyard ui
```

- Up and Down select a project.
- Enter starts or stops it.
- `r` refreshes immediately.
- `q` exits.

The dashboard probes project URLs every two seconds.

## Command reference

```text
dockyard ui
dockyard caddy start|stop|status
dockyard config set domain <suffix>
dockyard config set https on|off
dockyard config get domain|https
dockyard config list
dockyard start|stop <name>
dockyard project add <name> --folder <path> --url <host> --command <command>
dockyard project list|start|stop|show|remove <name>
dockyard run [--name <instance>] [--project <project>] <command...>
```

## State and logs

Dockyard stores its files in `$DOCKYARD_HOME`, `$XDG_STATE_HOME/dockyard`, or `~/.local/state/dockyard`:

```text
config.json
projects.json
Caddyfile
caddy.pid
caddy.log
<project-id>.log
```

## Troubleshooting

If a remote URL does not open:

1. Resolve the hostname on the remote computer and confirm it returns the development computer's Tailscale IP.
2. Run `tailscale status` on both computers.
3. Run `dockyard caddy status` and `dockyard ui` on the development computer.
4. Check that the tailnet policy and host firewall allow port 80 or 443.

If Caddy cannot bind its port, configure it as a system service or grant the binary permission to bind privileged ports.

For HTTPS trust errors, install Caddy's internal root CA on the client or return to HTTP:

```sh
dockyard config set https off
```

## License

MIT
