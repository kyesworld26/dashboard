// Agent tunnel client.
//
// The agent never accepts inbound connections from the dashboard. Instead it
// dials OUT to the hub over one WebSocket per linked account and proxies
// traffic to the local API (server.js, bound to 127.0.0.1). This works behind
// NAT / firewalls with no open ports, public domain, or static IP.
//
// Multi-link: a single physical agent can be linked to multiple dashboard
// accounts at once. Each link is its own {serverId, agentSecret} credential
// stored in /data/agent.json (an array), and each gets its own WebSocket. A
// fresh `npm run link` always opens a NEW pair-mode connection — it doesn't
// replace existing links. Unlinking a single server from the dashboard only
// drops that one credential; the other accounts stay live.
//
// Lifecycle:
//   1. Spawn the local API (server.js) as a child process.
//   2. Load credentials from /data/agent.json (array, or legacy single-object
//      shape for back-compat). For each credential, open an auth-mode WS.
//   3. If /data/pairing.txt has a token (written by `npm run link`), open an
//      additional pair-mode WS that announces it to the hub. When the user
//      claims it in the dashboard, the hub sends {kind:'paired',...}: we
//      append the new credential, start its auth-mode WS, and tear down the
//      pair-mode WS.
//   4. {kind:'unlinked'} on an auth-mode WS removes just that credential.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URLSearchParams } = require('url');
const WebSocket = require('ws');

const HUB_URL        = process.env.HUB_URL || 'wss://dashboard.kyesworld.com/agent';
const DATA_DIR       = process.env.AGENT_DATA_DIR || path.join(__dirname, 'data');
const LOCAL_PORT     = parseInt(process.env.AGENT_LOCAL_PORT) || 37001;
const RECONNECT_MIN  = 2000;
const RECONNECT_MAX  = 30000;
const PING_INTERVAL  = 30000;
const PAIR_ID        = '__pair__';

const CRED_FILE  = path.join(DATA_DIR, 'agent.json');
const TOKEN_FILE = path.join(DATA_DIR, 'pairing.txt');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Credentials store ───────────────────────────────────────────────────────
// agent.json is an array: [{ serverId, agentSecret }, ...]. For back-compat we
// also accept the legacy single-object shape and migrate it on first save.
function loadCreds() {
  try {
    const data = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
    if (Array.isArray(data)) return data.filter(c => c && c.serverId && c.agentSecret);
    if (data && data.serverId && data.agentSecret) return [{ serverId: data.serverId, agentSecret: data.agentSecret }];
  } catch {}
  return [];
}
function saveCreds() {
  if (creds.length === 0) { try { fs.unlinkSync(CRED_FILE); } catch {}; return; }
  fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), 'utf-8');
  try { fs.chmodSync(CRED_FILE, 0o600); } catch {}
}

let creds = loadCreds();

function readPairingToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf-8').trim() || null; } catch { return null; }
}

// Sent in every hello message (pair + auth) so the hub / dashboard has a fresh
// inventory of this host the moment it (re)connects — never stale because the
// dashboard refetches whenever the agent comes back online. Best-effort: any
// individual probe that throws is reported as null rather than failing hello.
function agentInfo() {
  const os = require('os');
  const { execSync } = require('child_process');
  const safe = (fn, dflt = null) => { try { return fn(); } catch { return dflt; } };
  const exec = (cmd, timeout = 2000) => safe(() => execSync(cmd, { timeout, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), null);

  const dockerVersion  = exec('docker --version');
  const dockerInfo     = exec('docker info --format "{{.ServerVersion}}"');
  const composeVersion = exec('docker compose version --short') || exec('docker-compose --version');
  const composeFile    = process.env.MAIN_COMPOSE
    || (() => {
      for (const root of ['/root', '/srv', ...safe(() => fs.readdirSync('/home').map(d => path.join('/home', d)), []),
                          ...safe(() => fs.readdirSync('/opt').map(d => path.join('/opt', d)), [])]) {
        for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
          const p = path.join(root, f);
          if (safe(() => fs.statSync(p).isFile(), false)) return p;
        }
      }
      return null;
    })();

  const totalMem = os.totalmem();
  const cpus = os.cpus() || [];
  const ifaces = Object.values(os.networkInterfaces() || {}).flat()
    .filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address);

  return {
    version: 2,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    uptimeSec: Math.round(os.uptime()),
    cpuModel: cpus[0]?.model || null,
    cpuCount: cpus.length,
    totalMemBytes: totalMem,
    freeMemBytes: os.freemem(),
    loadAvg: os.loadavg(),
    ipv4: ifaces,
    docker: {
      installed: !!dockerVersion,
      running: !!dockerInfo,
      version: dockerVersion,
      serverVersion: dockerInfo,
      composeVersion,
    },
    serverRoot: composeFile ? path.dirname(composeFile) : null,
    composeFile,
    composeExists: !!composeFile,
    agentVersion: safe(() => require('./package.json').version, '0.0.0'),
  };
}

function printNotLinkedBanner() {
  console.log('\n' + '='.repeat(64));
  console.log('  This server is NOT linked to any dashboard account yet.');
  console.log('  Run:  sudo dashboard-link');
  console.log('  (log in with your dashboard account to generate a token)');
  console.log('='.repeat(64) + '\n');
}

// ─── Local API child process ─────────────────────────────────────────────────
function startLocalApi() {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(LOCAL_PORT), AGENT_BIND_HOST: '127.0.0.1' },
    stdio: 'inherit',
  });
  child.on('exit', code => {
    console.error(`[agent] local API exited (code ${code}); restarting in 2s`);
    setTimeout(startLocalApi, 2000);
  });
  return child;
}

// Make a request to the local API and stream the response back over `send`.
function relayHttp(msg, send) {
  const { id, method = 'GET', path: reqPath = '/', query, body } = msg;
  const qs = query && Object.keys(query).length
    ? '?' + new URLSearchParams(query).toString()
    : '';
  const payload = body == null ? null
    : (typeof body === 'string' ? body : JSON.stringify(body));

  const req = http.request({
    host: '127.0.0.1',
    port: LOCAL_PORT,
    method,
    path: reqPath + qs,
    headers: {
      ...(payload != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
    },
  }, res => {
    send({ kind: 'http-head', id, status: res.statusCode, headers: res.headers });
    res.on('data', chunk => send({ kind: 'http-chunk', id, data: chunk.toString('base64') }));
    res.on('end', () => send({ kind: 'http-end', id }));
  });
  req.on('error', err => send({ kind: 'http-error', id, error: err.message }));
  if (payload != null) req.write(payload);
  req.end();
}

// ─── Terminal relay ──────────────────────────────────────────────────────────
// Each browser terminal session is a `channel` allocated by the hub. We open a
// local WS to the agent's own /ws/terminal and pipe frames both ways. We tag
// each channel with the connection that opened it so we can tear them down
// when a particular hub connection drops without affecting other links.
const termChannels = new Map(); // channel -> { local, connId }

function openTerminal(connId, channel, send) {
  const local = new WebSocket(`ws://127.0.0.1:${LOCAL_PORT}/ws/terminal`, { perMessageDeflate: false });
  termChannels.set(channel, { local, connId });
  local.on('message', raw => {
    let frame; try { frame = JSON.parse(raw.toString()); } catch { return; }
    send({ kind: 'term', channel, frame });
  });
  local.on('close', () => {
    termChannels.delete(channel);
    send({ kind: 'term-closed', channel });
  });
  local.on('error', () => { try { local.close(); } catch {} });
}

function terminalFrame(channel, frame) {
  const local = termChannels.get(channel)?.local;
  if (local && local.readyState === WebSocket.OPEN) local.send(JSON.stringify(frame));
}

function closeTerminal(channel) {
  const local = termChannels.get(channel)?.local;
  if (local) { try { local.close(); } catch {} }
  termChannels.delete(channel);
}

function closeChannelsForConn(connId) {
  for (const [ch, ctx] of termChannels) {
    if (ctx.connId === connId) {
      try { ctx.local.close(); } catch {}
      termChannels.delete(ch);
    }
  }
}

// ─── Hub connections (one per credential + optionally one pair-mode) ─────────
// conn shape: { id, isPair, cred?, token?, ws, reconnectDelay, pingInterval,
//               reconnectTimer, stopped }
const authConns = new Map(); // serverId -> conn
let   pairConn  = null;       // single pair-mode conn (one token in flight)
let   pairToken = null;

function connLabel(conn) {
  return conn.isPair ? 'pair' : `srv ${conn.cred.serverId.slice(0, 8)}`;
}

function ensureAuthConnections() {
  for (const cred of creds) {
    if (!authConns.has(cred.serverId)) openAuthConnection(cred);
  }
}

function openAuthConnection(cred) {
  const conn = {
    id: cred.serverId,
    isPair: false,
    cred,
    reconnectDelay: RECONNECT_MIN,
    stopped: false,
  };
  authConns.set(cred.serverId, conn);
  doConnect(conn);
}

function openPairConnection(token) {
  // Only one pair-mode connection at a time — a new token supersedes any prior.
  if (pairConn) {
    pairConn.stopped = true;
    if (pairConn.reconnectTimer) clearTimeout(pairConn.reconnectTimer);
    try { pairConn.ws && pairConn.ws.close(); } catch {}
  }
  pairConn = {
    id: PAIR_ID,
    isPair: true,
    token,
    reconnectDelay: RECONNECT_MIN,
    stopped: false,
  };
  doConnect(pairConn);
}

function doConnect(conn) {
  console.log(`[agent] connecting to hub (${connLabel(conn)})`);
  // perMessageDeflate disabled to match the hub (see broker.js comment).
  const ws = new WebSocket(HUB_URL, { perMessageDeflate: false });
  conn.ws = ws;
  const send = obj => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

  ws.on('open', () => {
    conn.reconnectDelay = RECONNECT_MIN;
    if (conn.isPair) {
      send({ kind: 'hello', mode: 'pair', token: conn.token, info: agentInfo() });
    } else {
      send({ kind: 'hello', mode: 'auth', serverId: conn.cred.serverId, agentSecret: conn.cred.agentSecret, info: agentInfo() });
    }
  });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleHubMessage(conn, msg, send);
  });

  ws.on('error', err => {
    console.error(`[agent] ${connLabel(conn)} ws error: ${err.message}`);
    try { ws.close(); } catch {}
  });

  ws.on('close', () => {
    closeChannelsForConn(conn.id);
    if (conn.pingInterval) { clearInterval(conn.pingInterval); conn.pingInterval = null; }
    if (conn.stopped) return;
    const delay = conn.reconnectDelay;
    conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, RECONNECT_MAX);
    console.log(`[agent] ${connLabel(conn)} closed; reconnecting in ${Math.round(delay / 1000)}s`);
    conn.reconnectTimer = setTimeout(() => {
      if (conn.stopped) return;
      doConnect(conn);
    }, delay);
  });

  conn.pingInterval = setInterval(() => { try { ws.ping(); } catch {} }, PING_INTERVAL);
}

function handleHubMessage(conn, msg, send) {
  switch (msg.kind) {
    case 'paired': {
      // Pair-mode WS just received durable credentials for a new link. Append
      // to creds (do NOT replace existing) and start its auth connection.
      const cred = { serverId: msg.serverId, agentSecret: msg.agentSecret };
      if (!creds.some(c => c.serverId === cred.serverId)) {
        creds.push(cred);
        saveCreds();
      }
      console.log(`[agent] paired! new link as server ${msg.serverId} (now ${creds.length} linked)`);
      // Tear down the pair connection — it's done its job.
      if (pairConn === conn) {
        pairConn.stopped = true;
        try { pairConn.ws.close(); } catch {}
        pairConn = null;
      }
      pairToken = null;
      try { fs.unlinkSync(TOKEN_FILE); } catch {}
      // Start serving the new link.
      if (!authConns.has(cred.serverId)) openAuthConnection(cred);
      break;
    }
    case 'authed':
      console.log(`[agent] ${connLabel(conn)} authenticated; tunnel ready`);
      break;
    case 'unlinked': {
      const serverId = conn.cred && conn.cred.serverId;
      console.log(`[agent] ${connLabel(conn)} unlinked by dashboard${msg.reason ? ' (' + msg.reason + ')' : ''}; dropping credentials`);
      if (serverId) {
        creds = creds.filter(c => c.serverId !== serverId);
        saveCreds();
        authConns.delete(serverId);
      }
      conn.stopped = true;
      try { conn.ws.close(); } catch {}
      if (creds.length === 0 && !pairConn) printNotLinkedBanner();
      break;
    }
    case 'http':
      relayHttp(msg, send);
      break;
    case 'term-open':
      openTerminal(conn.id, msg.channel, send);
      break;
    case 'term':
      terminalFrame(msg.channel, msg.frame);
      break;
    case 'term-close':
      closeTerminal(msg.channel);
      break;
    case 'error': {
      console.error(`[agent] ${connLabel(conn)} hub error: ${msg.error}`);
      // Auth conn rejected: drop just that one credential, leave others alone.
      if (conn.cred && /invalid|unknown server|revoked/i.test(msg.error || '')) {
        console.error(`[agent] removing stale credential for ${conn.cred.serverId}`);
        creds = creds.filter(c => c.serverId !== conn.cred.serverId);
        saveCreds();
        authConns.delete(conn.cred.serverId);
        conn.stopped = true;
        try { conn.ws.close(); } catch {}
      }
      // Pair token rejected: discard it so the operator must re-run link.
      if (conn.isPair && /invalid or expired pairing|already has an active agent/i.test(msg.error || '')) {
        try { fs.unlinkSync(TOKEN_FILE); } catch {}
        pairToken = null;
        conn.stopped = true;
        try { conn.ws.close(); } catch {}
        if (pairConn === conn) pairConn = null;
      }
      break;
    }
  }
}

// ─── Boot orchestration ──────────────────────────────────────────────────────
function start() {
  creds = loadCreds();
  ensureAuthConnections();
  pairToken = readPairingToken();
  if (pairToken) openPairConnection(pairToken);
  if (creds.length === 0 && !pairToken) {
    printNotLinkedBanner();
    setTimeout(start, 5000); // keep polling until a token shows up
  } else {
    console.log(`[agent] ${creds.length} account(s) linked${pairToken ? ', 1 pairing in progress' : ''}`);
  }
}

// Watch the pairing token file: re-running `npm run link` writes a fresh token
// that we should immediately announce to the hub. This works whether or not
// other auth-mode connections are already running.
function watchPairingToken() {
  try {
    fs.watch(DATA_DIR, (_event, filename) => {
      if (filename !== 'pairing.txt') return;
      const fresh = readPairingToken();
      if (!fresh || fresh === pairToken) return;
      console.log('[agent] new pairing token detected');
      pairToken = fresh;
      openPairConnection(fresh);
    });
  } catch (err) {
    console.warn('[agent] could not watch pairing token file:', err.message);
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────
startLocalApi();
watchPairingToken();
setTimeout(start, 1500); // give the local API a moment to bind
