# dashboard-agent

The agent that runs on each server you want to manage from the dashboard at
`dashboard.kyesworld.com`. It dials **outbound** to the hub over a single
WebSocket and proxies management requests + the web terminal back to the host.
No inbound ports, no public domain, no static IP required.

- One agent can be linked to **multiple dashboard accounts** at once — re-run
  `dashboard-link` to add another account; unlinking from one dashboard
  doesn't affect the others.
- The web terminal is a **real root shell on the host** (not in a container).
- Runs as a `systemd` service; auto-restarts; survives reboots.

## Install (one-liner)

On the server you want to manage, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/kyesworld26/dashboard/main/install-host.sh | sudo bash
```

What that does:

1. Installs Node.js 20+ (apt or dnf) if it's not already there.
2. Clones this repo into a temp dir and copies the agent files to
   `/opt/dashboard-agent/`.
3. Runs `npm install --omit=dev`.
4. Creates `/var/lib/dashboard-agent/` for credentials.
5. Writes and starts `/etc/systemd/system/dashboard-agent.service`.
6. Adds `dashboard-link` to your `PATH`.

Override the hub URL or paths if needed:

```bash
curl -fsSL https://raw.githubusercontent.com/kyesworld26/dashboard/main/install-host.sh \
  | sudo HUB_URL=wss://my.hub/agent SERVER_ROOT=/opt/myapp bash
```

## Link to a dashboard account

```bash
dashboard-link
```

Pick a method when prompted:

- **Email + password** — log in with your dashboard credentials; the terminal
  prints a one‑time token; paste it in **dashboard → Servers → Link a
  server**.
- **Sign in with Google** — open `google.com/device`, sign in with your Google
  account, enter the printed code; the terminal then prints a token; paste it
  in the dashboard.

Either way the dashboard account on **both ends must match**; the broker
rejects mismatches.

Re-run `dashboard-link` any time to add another dashboard account (multi-link).

## Daily operation

```bash
sudo systemctl status dashboard-agent      # state
sudo journalctl -u dashboard-agent -f      # logs
sudo systemctl restart dashboard-agent     # restart after editing the unit
```

## Where things live

| Path | Purpose |
| --- | --- |
| `/opt/dashboard-agent/` | Agent code (`tunnel.js`, `server.js`, `link.js`, ...) |
| `/var/lib/dashboard-agent/agent.json` | Array of `{serverId, agentSecret}` — one per linked account |
| `/var/lib/dashboard-agent/pairing.txt` | One-time pairing token written by `link.js` (auto-deleted after pair) |
| `/etc/systemd/system/dashboard-agent.service` | systemd unit |
| `/usr/local/bin/dashboard-link` | Wrapper that runs `link.js` with the right env |

## Uninstall

```bash
sudo bash /opt/dashboard-agent/uninstall-host.sh           # keep creds
sudo bash /opt/dashboard-agent/uninstall-host.sh --purge   # also wipe creds
```

Or download it standalone:

```bash
curl -fsSL https://raw.githubusercontent.com/kyesworld26/dashboard/main/uninstall-host.sh | sudo bash
```

## How it works

```
┌──────────────────────────┐         outbound WS         ┌────────────────────────┐
│  your server (host)      │ ──────────────────────────▶ │  dashboard hub         │
│  ─────────────────────   │   wss://dashboard…/agent    │  (multi-tenant)        │
│  systemd: dashboard-     │ ◀────────────────────────── │                        │
│  agent → node tunnel.js  │   RPC + terminal frames     │  React SPA + API +     │
│    └─ spawns server.js   │                             │  WS broker             │
│       (local API on      │                             │                        │
│        127.0.0.1:37001)  │                             └─────────────┬──────────┘
│                          │                                           │
│  shell for web terminal: │                                           ▼
│  /bin/bash -l (PID 1     │                              ┌───────────────────────┐
│  is systemd, full root)  │                              │  your browser         │
└──────────────────────────┘                              └───────────────────────┘
```

- Every link is a separate `{serverId, agentSecret}`. The agent opens one
  WebSocket per link; unlinking one account closes one socket; the others
  keep running independently.
- The pairing token printed by `dashboard-link` is single-use, expires in 15
  minutes, and only links to the dashboard account that authenticated in the
  terminal.
- For the (optional) Google flow you also need `GOOGLE_DEVICE_CLIENT_ID/SECRET`
  set on the **hub** (not the agent) — a Google "TVs and Limited Input
  devices" OAuth client.
