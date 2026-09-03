# Running Pictaria as a service

Docker users normally get process supervision from `restart: unless-stopped`
in the compose file. That policy restarts an established container after its
process exits; it cannot repair a host port binding that Docker could not
create. If you run bare Node, put the server under your OS's service manager
so it starts on boot, restarts after crashes, and survives you closing the
terminal.

These service definitions keep the version you selected running. Deploy a
production update with the release-pinned procedure in
[UPGRADING.md](UPGRADING.md), not by pulling the moving `main` branch. After
you switch to the intended release and restart, the supervisor relaunches it.
A run that's in flight when the process stops is recorded as *interrupted* in
the run history; its queue item stays queued and resumes on the next run.

## Docker with a VPN-owned host address

The stock compose file publishes `4080:4080` on the host without depending on
one particular interface. A customized mapping that binds directly to an
address owned by Tailscale, WireGuard, or another VPN has a boot-order edge
case. For example, where `TAILSCALE_IP` stands for the host's actual VPN
address:

```yaml
ports:
  - "TAILSCALE_IP:4080:4080"
```

After a reboot, Docker can start before the VPN has assigned that address.
Docker then cannot create the published listener; the container may fail to
start, `docker compose ps` may show it stopped, or its network endpoint may be
missing. Pictaria never starts in this situation, so this is a host networking
problem rather than a Pictaria application failure. `restart: unless-stopped`
does not by itself retry creation of the missing port or network endpoint.

**Preferred approach:** publish Pictaria on loopback and let Tailscale Serve or
another reverse proxy own the VPN-facing listener:

```yaml
ports:
  - "127.0.0.1:4080:4080"
```

For Tailscale Serve, configure the persistent proxy after Pictaria is running:

```sh
sudo tailscale serve --bg http://127.0.0.1:4080
```

This removes the VPN address from Docker's startup path. Tailscale Serve
resumes a background (`--bg`) proxy after reboot. Because it serves Pictaria
over HTTPS, follow the reverse-proxy guidance in
[Exposing beyond your LAN](../README.md#exposing-beyond-your-lan), including
`SESSION_COOKIE_SECURE=true` and preserving the browser-facing `Host` header.

**Direct-binding alternative:** make host startup orchestration wait until the
specific VPN address exists, then run `docker compose up -d --wait`. For
example, a separate systemd oneshot unit can order itself after Docker and
Tailscale and include a wait like this (replace both example paths and
`TAILSCALE_IP`):

```ini
[Unit]
Description=Start Pictaria after its Tailscale address exists
Requires=docker.service tailscaled.service
Wants=network-online.target
After=docker.service tailscaled.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/path/to/pictaria-server
TimeoutStartSec=2min
ExecStartPre=/bin/sh -c 'until ip -4 addr show dev tailscale0 | grep -Fq "TAILSCALE_IP/"; do sleep 1; done'
ExecStart=/usr/bin/docker compose up -d --wait
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
```

Use the equivalent dependency and address-wait mechanism for another VPN or
service manager. Merely ordering the unit after the VPN daemon is insufficient
if that daemon has not yet assigned the address.

If the address is now present but the earlier attempt left the container or
network endpoint unusable, first confirm that `/data` is stored on a persistent
named volume or bind mount. The stock compose file uses the `pictaria-data`
named volume; a custom deployment must provide equivalent persistence. Only
after confirming that storage should you recreate the container:

```sh
docker compose up -d --wait --force-recreate
```

Do not add `-v` to a cleanup command: that would remove the named data volume.

## macOS (launchd)

Save as `~/Library/LaunchAgents/com.example.pictaria-server.plist`, fixing
the three paths for your machine (`which node` tells you the first one):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.pictaria-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>--env-file-if-exists=.env</string>
    <string>src/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/pictaria-server</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/pictaria-server.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/pictaria-server.log</string>
</dict>
</plist>
```

Load it (also happens automatically at every login):

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.pictaria-server.plist
```

Notes:

- A LaunchAgent starts at **login**, not at power-on — right for Pictaria,
  which usually wants your user session (mounted network volumes for
  `BACKUP_DIR`, LM Studio, etc.). Log in once after a reboot.
- `KeepAlive` relaunches the server if it crashes — and after you `kill`
  it, which is the whole deploy procedure.
- If you back up to a network share, add the share to **System Settings →
  General → Login Items** so it remounts before backups fire. An unmounted
  share makes backups fail visibly (Settings → Backups) and retry hourly —
  they never silently write elsewhere. (The guard: a custom `BACKUP_DIR`
  is adopted once with `bin/backup.mjs --adopt` while mounted, and every
  later run requires the marker file that adoption stamps into it — see
  [BACKUP.md](../docs/BACKUP.md).)
- If enrichment uses LM Studio, enable **App Settings → Developer →
  Enable Local LLM Service** in LM Studio: its server then starts at login
  as a service of its own, whether or not the LM Studio app is open. (The
  app being open is *not* the same as its server running.)

## Linux (systemd)

Save as `/etc/systemd/system/pictaria-server.service`:

```ini
[Unit]
Description=Pictaria Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=you
WorkingDirectory=/path/to/pictaria-server
ExecStart=/usr/bin/node --env-file-if-exists=.env src/server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pictaria-server
journalctl -u pictaria-server -f   # logs
```

## Host model servers from Docker

If Pictaria runs in Docker and LM Studio, llama.cpp, or another model server
runs on the Docker host, a loopback base URL (`http://127.0.0.1:…`) won't work —
inside the container, `127.0.0.1` is the container itself. Set the base
URL under Settings → AI Providers (or its environment variable) to
`http://host.docker.internal:<port>` with the service's API prefix, for
example LM Studio at `http://host.docker.internal:1234/v1` or llama.cpp at
`http://host.docker.internal:8080/v1`. On Linux, also give the container that
hostname:

```yaml
# docker-compose.yml, under the pictaria service
extra_hosts:
  - "host.docker.internal:host-gateway"
```

The model server must listen beyond its own loopback interface. In LM Studio,
enable **Serve on local network**; for other servers, follow their bind/host
setting and expose the port only to networks you trust.

## Monitoring

`GET /api/health` is deliberately outside the password gate — point any
uptime monitor (Uptime Kuma, Healthchecks, …) at
`http://your-host:4080/api/health`. It answers in milliseconds; its Immich
probe is cached for 60 s with a 4 s timeout, so a 10 s monitor timeout is
always safe. A monitor running outside your network should reach the
server over Tailscale (the MagicDNS name works in the monitor URL) rather
than through an opened port. Suggested monitors:

1. **Pictaria up** — plain HTTP 200 on `/api/health`.
2. **Immich up** — monitor Immich directly (`/api/server/ping` on your
   Immich host) so alerts tell you which layer broke.
3. **Backups healthy** (optional) — keyword monitor on
   `/api/backup/status` with an `X-App-Password` header, matching
   `"lastError":null`. Goes red when snapshots start failing — the failure
   mode that otherwise goes unnoticed for weeks.
