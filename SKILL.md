---
name: dockyard
description: Run and manage local development projects, Docker Compose stacks, and parallel Git worktrees through Dockyard's stable private hostnames and Caddy proxy. Use when an agent needs to start, stop, inspect, register, expose, or troubleshoot a project with Dockyard, work with HTTP_PORT or HTTPS_PORT, assign branch-based URLs, or make a development service reachable over Tailscale.
---

# Work with Dockyard

Use Dockyard to give development processes stable hostnames without choosing host ports manually.

## Inspect before changing state

Confirm that Dockyard is installed and read the current global settings:

```sh
dockyard --help
dockyard config list
dockyard caddy status
dockyard project list
```

Do not change the domain suffix or HTTPS setting unless the task requires a global configuration change. These settings affect every new route.

## Run a Git worktree

Run the command from the worktree root:

```sh
dockyard run docker compose up
```

Dockyard detects the repository and branch. It assigns `HTTP_PORT`, `HTTPS_PORT`, `COMPOSE_PROJECT_NAME`, `LOCAL_URL`, and `TAILSCALE_URL` to the child process.

Expect these hostname forms:

```text
main branch          <project>.<domain>
other branch         <branch>.<project>.<domain>
detached HEAD        detached-<commit>.<project>.<domain>
```

Use overrides only when detection is wrong or the user requests a specific name:

```sh
dockyard run --name preview --project exampleProject docker compose up
```

Keep `dockyard run` in the foreground. It removes the temporary route when the child exits. When using an execution tool, preserve the running session instead of terminating it after startup.

## Prepare Docker Compose

Publish the service through Dockyard's assigned loopback port:

```yaml
services:
  app:
    ports:
      - "127.0.0.1:${HTTP_PORT}:3000"
```

Make the service inside the container listen on `0.0.0.0`, not container loopback. Do not hardcode a host port when multiple worktrees can run together. Let Dockyard supply `COMPOSE_PROJECT_NAME` so Compose resources remain isolated.

## Register a persistent project

Use a registered project when the user wants background lifecycle commands or an exact hostname:

```sh
dockyard project add exampleProject \
  --folder /projects/exampleProject \
  --url exampleproject.test \
  --command 'docker compose up'

dockyard project start exampleProject
dockyard project show exampleProject
dockyard project stop exampleProject
```

Stop a registered project before removing it:

```sh
dockyard project remove exampleProject
```

## Verify a project

Avoid `dockyard ui` in non-interactive automation because it requires a terminal. Use these checks instead:

```sh
dockyard caddy status
dockyard project list
dockyard project show exampleProject
curl -I http://exampleproject.test
```

Read the URL printed by Dockyard rather than reconstructing it when reporting the result.

## Handle remote access

Dockyard uses the development computer's existing Tailscale connection. It does not create Tailscale nodes.

Before changing DNS, identify:

- the configured suffix from `dockyard config get domain`
- the development computer's Tailscale IP
- whether the remote client uses Tailscale split DNS or an explicit hosts entry

Worktree hostnames need wildcard DNS for convenient remote use. Fixed projects can use individual hosts-file entries. Do not modify tailnet DNS, firewall rules, trust stores, or hosts files unless the user authorized that system change.

For HTTP, Tailscale encrypts traffic between tailnet devices. If Dockyard uses HTTPS, the remote client must trust Caddy's internal root CA.

## Troubleshoot in order

1. Confirm the project process is running.
2. Confirm Caddy is running.
3. Resolve the hostname on the client and check that it returns the development computer's Tailscale IP.
4. Test port 80 or 443 from the client.
5. Check the generated project log under Dockyard's state directory.
6. Check tailnet policy and the host firewall if local access works but remote access fails.

Do not start a second copy to work around a failed route. Inspect state and logs first. Do not invoke privileged commands unless the user explicitly authorizes them.
