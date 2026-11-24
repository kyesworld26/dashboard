// Agent tunnel client.
//
// The agent never accepts inbound connections from the dashboard. Instead it
// dials OUT to the hub over one WebSocket per linked account and proxies
// traffic to the local API (server.js, bound to 127.0.0.1). This works behind
// NAT / firewalls with no open ports, public domain, or static IP.
//
// Multi-link: a single physical agent can be linked to multiple dashboard
// accounts at once. Each link is its own {serverId, agentSecret} credential
// stored in agent.json (an array), and each gets its own WebSocket. Each link
// is a separate server record on the hub owned by exactly one account, so a
// connection never grants access to any other account.
//
// Security
//  • The hub is authenticated by TLS (wss://). Plain ws:// is refused except
//    to loopback / single-label hosts (the compose network), because whoever
//    impersonates the hub gets root command execution on this host.
//    AGENT_HUB_CA_FILE pins a private CA.
//  • The local API only accepts requests carrying a random per-boot token that
//    this process generates and hands to the child through its environment.
//  • Requests are deduplicated by id; work for a dropped connection is
//    aborted, so nothing queued before a reconnect is replayed afterwards.
//  • Credentials are written atomically with mode 0600 and can be rotated by
//    the hub; `node tunnel.js --revoke-all` revokes them at the hub (used by
//    uninstall-host.sh --purge).
//
// Lifecycle:
//   1. Spawn the local API (server.js) as a child process.
//   2. Load credentials; open an auth-mode WS per credential.
//   3. If pairing.txt has a token (written by `dashboard-link`), open a
//      pair-mode WS. When claimed, the hub sends {kind:'paired'}: append the
//      credential, start its auth-mode WS, close the pair WS.
//   4. {kind:'unlinked'} drops just that credential.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL, URLSearchParams } = require('url');
const WebSocket = require('ws');

const HUB_URL        = process.env.HUB_URL || 'wss://dashboard.kyesworld.com/agent';
const DATA_DIR       = process.env.AGENT_DATA_DIR || path.join(__dirname, 'data');
const LOCAL_PORT     = parseInt(process.env.AGENT_LOCAL_PORT, 10) || 37001;
const RECONNECT_MIN  = 2000;
const RECONNECT_MAX  = 60000;
const PING_INTERVAL  = 30000;
const PAIR_ID        = '__pair__';
const LOCAL_TOKEN    = crypto.randomBytes(32).toString('hex');
const MAX_INFLIGHT   = 64;

const CRED_FILE   = path.join(DATA_DIR, 'agent.json');
const TOKEN_FILE  = path.join(DATA_DIR, 'pairing.txt');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');

// ─── Hub URL policy ──────────────────────────────────────────────────────────
function checkHubUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'HUB_URL is not a valid URL.'; }
  if (u.protocol === 'wss:') return null;
  if (u.protocol !== 'ws:') return 'HUB_URL must use wss:// (or ws:// on a private compose network).';
  const host = u.hostname.toLowerCase();
  const privateHost = host === 'localhost' || /^127\./.test(host) || host === '[::1]' || !host.includes('.');
  if (privateHost || process.env.AGENT_ALLOW_INSECURE_HUB === 'true') return null;
  return `Refusing unencrypted hub connection to ${host}: use wss://. (Set AGENT_ALLOW_INSECURE_HUB=true only on a trusted private network.)`;
}

function wsOptions() {
  const opts = { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024, handshakeTimeout: 15000 };
  if (process.env.AGENT_HUB_CA_FILE) opts.ca = fs.readFileSync(process.env.AGENT_HUB_CA_FILE);
  return opts;
}

// ─── Credentials store ───────────────────────────────────────────────────────
function writePrivate(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadCreds() {
  try {
    const data = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
    if (Array.isArray(data)) return data.filter(c => c && c.serverId && c.agentSecret);
    if (data && data.serverId && data.agentSecret) return [{ serverId: data.serverId, agentSecret: data.agentSecret }];
  } catch {}
  return [];
}
let creds = [];
function saveCreds() {
  if (creds.length === 0) { try { fs.unlinkSync(CRED_FILE); } catch {} return; }
  writePrivate(CRED_FILE, JSON.stringify(creds, null, 2));
}

function readPairingToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf-8').trim() || null; } catch { return null; }
}

// ─── Host inventory (cached: probing docker on every reconnect was costly) ──
let _infoCache = { value: null, ts: 0 };
function capabilities() {
  return {
    transferExport: process.env.AGENT_TRANSFER_EXPORT !== 'false',
    transferImport: process.env.AGENT_TRANSFER_IMPORT !== 'false',
    transferVersion: 1,
    secretRotation: true,
  };
}

function agentInfo() {
  if (_infoCache.value && Date.now() - _infoCache.ts < 60_000) return { ..._infoCache.value, capabilities: capabilities() };
  const os = require('os');
  const { execSync } = require('child_process');
  const safe = (fn, dflt = null) => { try { return fn(); } catch { return dflt; } };
  const docker = process.env.AGENT_DOCKER_BIN || 'docker';
  const exec = (cmd, timeout = 2000) => safe(() => execSync(cmd, { timeout, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), null);

  const dockerVersion  = exec(`${docker} --version`);
  const dockerInfo     = dockerVersion ? exec(`${docker} info --format "{{.ServerVersion}}"`) : null;
  const composeVersion = dockerVersion ? (exec(`${docker} compose version --short`) || exec('docker-compose --version')) : null;
  const composeFile    = process.env.MAIN_COMPOSE
    || (() => {
      const roots = process.env.SERVER_ROOT ? [process.env.SERVER_ROOT]
        : ['/root', '/srv', ...safe(() => fs.readdirSync('/home').map(d => path.join('/home', d)), []),
           ...safe(() => fs.readdirSync('/opt').map(d => path.join('/opt', d)), [])];
      for (const root of roots) {
        for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
          const p = path.join(root, f);
          if (safe(() => fs.statSync(p).isFile(), false)) return p;
        }
      }
      return null;
    })();

  const cpus = os.cpus() || [];
  const ifaces = Object.values(os.networkInterfaces() || {}).flat()
    .filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address);

  const value = {
    version: 2,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    uptimeSec: Math.round(os.uptime()),
    cpuModel: cpus[0]?.model || null,
    cpuCount: cpus.length,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    loadAvg: os.loadavg(),
    ipv4: ifaces,
    docker: { installed: !!dockerVersion, running: !!dockerInfo, version: dockerVersion, serverVersion: dockerInfo, composeVersion },
    serverRoot: composeFile ? path.dirname(composeFile) : null,
    composeFile,
    composeExists: !!composeFile,
    agentVersion: safe(() => require('./package.json').version, '0.0.0'),
  };
  _infoCache = { value, ts: Date.now() };
  return { ...value, capabilities: capabilities() };
}

// ─── Status file (read by install/update health checks) ─────────────────────
const status = { pid: process.pid, startedAt: new Date().toISOString(), localApi: 'starting', localApiPid: null, links: {}, pairing: false };
function writeStatus() {
  try { writePrivate(STATUS_FILE, JSON.stringify({ ...status, version: agentInfo().agentVersion, updatedAt: new Date().toISOString() })); } catch {}
}

function printNotLinkedBanner() {
  console.log('\n' + '='.repeat(64));
  console.log('  This server is NOT linked to any dashboard account yet.');
  console.log('  Run:  sudo dashboard-link');
  console.log('  (log in with your dashboard account to generate a token)');
  console.log('='.repeat(64) + '\n');
}

// ─── Local API child process ─────────────────────────────────────────────────
let childRestartDelay = 2000;
let stopping = false;
let child = null;
function startLocalApi() {
  status.localApi = 'starting';
  writeStatus();
  const startedAt = Date.now();
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(LOCAL_PORT), AGENT_BIND_HOST: '127.0.0.1', AGENT_LOCAL_TOKEN: LOCAL_TOKEN },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  status.localApiPid = child.pid;
  child.on('message', m => {
    if (m && m.type === 'ready') { status.localApi = 'up'; writeStatus(); }
  });
  child.on('exit', code => {
    status.localApi = 'crashed';
    status.localApiPid = null;
    writeStatus();
    if (stopping) return;
    // Back off on a crash loop instead of respawning every 2 s forever.
    childRestartDelay = Date.now() - startedAt > 60_000 ? 2000 : Math.min(childRestartDelay * 2, 60_000);
    console.error(`[agent] local API exited (code ${code}); restarting in ${Math.round(childRestartDelay / 1000)}s`);
    setTimeout(startLocalApi, childRestartDelay);
  });
}

// ─── HTTP relay ──────────────────────────────────────────────────────────────
const inflight = new Map(); // `${connId}:${rpcId}` -> local request

function relayHttp(conn, msg, send) {
  const { id, method = 'GET', path: reqPath = '/', query, body } = msg;
  if (typeof id !== 'string' || typeof reqPath !== 'string' || !reqPath.startsWith('/api/')) {
    return send({ kind: 'http-error', id, error: 'invalid request' });
  }
  const key = `${conn.id}:${id}`;
  if (inflight.has(key)) return; // duplicate delivery — never execute twice
  if (inflight.size >= MAX_INFLIGHT) return send({ kind: 'http-error', id, error: 'agent busy' });

  const qs = query && typeof query === 'object' && Object.keys(query).length
    ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))).toString()
    : '';
  const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));

  const req = http.request({
    host: '127.0.0.1',
    port: LOCAL_PORT,
    method: String(method).toUpperCase(),
    path: reqPath + qs,
    headers: {
      'x-agent-local-token': LOCAL_TOKEN,
      ...(payload != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
    },
  }, res => {
    send({ kind: 'http-head', id, status: res.statusCode, headers: { 'content-type': res.headers['content-type'], 'content-disposition': res.headers['content-disposition'] } });
    res.on('data', chunk => send({ kind: 'http-chunk', id, data: chunk.toString('base64') }));
    res.on('end', () => { inflight.delete(key); send({ kind: 'http-end', id }); });
    res.on('error', () => { inflight.delete(key); send({ kind: 'http-error', id, error: 'local response failed' }); });
  });
  inflight.set(key, req);
  req.setTimeout(10 * 60_000, () => req.destroy(new Error('local request timed out')));
  req.on('error', err => { inflight.delete(key); send({ kind: 'http-error', id, error: err.message }); });
  if (payload != null) req.write(payload);
  req.end();
}

function cancelHttp(conn, id) {
  const key = `${conn.id}:${id}`;
  const req = inflight.get(key);
  if (req) { inflight.delete(key); try { req.destroy(); } catch {} }
}

// Abort everything that was started for a connection that has gone away —
// its results can no longer be delivered, and the hub never replays them.
function abortInflightForConn(connId) {
  for (const [key, req] of inflight) {
    if (key.startsWith(`${connId}:`)) { inflight.delete(key); try { req.destroy(); } catch {} }
  }
}

// ─── Terminal relay ──────────────────────────────────────────────────────────
const termChannels = new Map(); // channel -> { local, connId }

function openTerminal(connId, channel, send) {
  if (typeof channel !== 'string' || termChannels.has(channel)) return;
  const local = new WebSocket(`ws://127.0.0.1:${LOCAL_PORT}/ws/terminal`, {
    perMessageDeflate: false,
    headers: { 'x-agent-local-token': LOCAL_TOKEN },
  });
  termChannels.set(channel, { local, connId });
  local.on('message', raw => {
    let frame; try { frame = JSON.parse(raw.toString()); } catch { return; }
    send({ kind: 'term', channel, frame });
  });
  local.on('close', () => {
    if (termChannels.get(channel)?.local === local) termChannels.delete(channel);
    send({ kind: 'term-closed', channel });
  });
  local.on('error', () => { try { local.close(); } catch {} });
}

function terminalFrame(connId, channel, frame) {
  const ch = termChannels.get(channel);
  if (ch && ch.connId === connId && ch.local.readyState === WebSocket.OPEN) ch.local.send(JSON.stringify(frame));
}

function closeTerminal(connId, channel) {
  const ch = termChannels.get(channel);
  if (!ch || ch.connId !== connId) return;
  try { ch.local.close(); } catch {}
  termChannels.delete(channel);
}

function closeChannelsForConn(connId) {
  for (const [ch, ctx] of termChannels) {
    if (ctx.connId === connId) { try { ctx.local.close(); } catch {} termChannels.delete(ch); }
  }
}

// ─── Hub connections (one per credential + optionally one pair-mode) ─────────
const authConns = new Map(); // serverId -> conn
let   pairConn  = null;
let   pairToken = null;

function connLabel(conn) {
  return conn.isPair ? 'pair' : `srv ${conn.cred.serverId.slice(0, 8)}`;
}

function ensureAuthConnections() {
  for (const cred of creds) if (!authConns.has(cred.serverId)) openAuthConnection(cred);
}

function openAuthConnection(cred) {
  const conn = { id: cred.serverId, isPair: false, cred, reconnectDelay: RECONNECT_MIN, stopped: false };
  authConns.set(cred.serverId, conn);
  doConnect(conn);
}

function stopConn(conn) {
  conn.stopped = true;
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  try { conn.ws && conn.ws.close(); } catch {}
}

function openPairConnection(token) {
  if (pairConn) stopConn(pairConn);
  pairConn = { id: PAIR_ID, isPair: true, token, reconnectDelay: RECONNECT_MIN, stopped: false };
  status.pairing = true;
  doConnect(pairConn);
}

function dropCredential(serverId, why) {
  console.error(`[agent] removing credential for ${serverId.slice(0, 8)} (${why})`);
  creds = creds.filter(c => c.serverId !== serverId);
  saveCreds();
  const conn = authConns.get(serverId);
  authConns.delete(serverId);
  delete status.links[serverId.slice(0, 8)];
  writeStatus();
  if (conn) stopConn(conn);
}

function doConnect(conn) {
  console.log(`[agent] connecting to hub (${connLabel(conn)})`);
  const ws = new WebSocket(HUB_URL, wsOptions());
  conn.ws = ws;
  const send = obj => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  let alive = true;

  ws.on('open', () => {
    conn.reconnectDelay = RECONNECT_MIN;
    if (conn.isPair) send({ kind: 'hello', mode: 'pair', token: conn.token, info: agentInfo() });
    else send({ kind: 'hello', mode: 'auth', serverId: conn.cred.serverId, agentSecret: conn.cred.agentSecret, info: agentInfo() });
  });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    try { handleHubMessage(conn, msg, send); } catch (err) { console.error('[agent] message handling failed:', err.message); }
  });

  ws.on('pong', () => { alive = true; });
  ws.on('error', err => {
    console.error(`[agent] ${connLabel(conn)} ws error: ${err.message}`);
    try { ws.close(); } catch {}
  });

  ws.on('close', () => {
    closeChannelsForConn(conn.id);
    abortInflightForConn(conn.id);
    if (conn.pingInterval) { clearInterval(conn.pingInterval); conn.pingInterval = null; }
    if (!conn.isPair) { status.links[conn.id.slice(0, 8)] = 'disconnected'; writeStatus(); }
    if (conn.stopped || conn.ws !== ws) return;
    // Exponential backoff with jitter (bounded), so a hub outage does not turn
    // into a reconnect storm. Running services are unaffected by outages.
    const delay = Math.round(conn.reconnectDelay * (0.75 + Math.random() * 0.5));
    conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, RECONNECT_MAX);
    console.log(`[agent] ${connLabel(conn)} closed; reconnecting in ${Math.round(delay / 1000)}s`);
    conn.reconnectTimer = setTimeout(() => { if (!conn.stopped) doConnect(conn); }, delay);
  });

  // Client-side liveness: a hub that stops answering pings is dropped and
  // re-dialled instead of leaving a half-open socket.
  conn.pingInterval = setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch {} return; }
    alive = false;
    try { ws.ping(); } catch {}
  }, PING_INTERVAL);
}

function handleHubMessage(conn, msg, send) {
  switch (msg.kind) {
    case 'paired': {
      if (!conn.isPair || typeof msg.serverId !== 'string' || typeof msg.agentSecret !== 'string') return;
      const cred = { serverId: msg.serverId, agentSecret: msg.agentSecret };
      if (!creds.some(c => c.serverId === cred.serverId)) { creds.push(cred); saveCreds(); }
      console.log(`[agent] paired! new link as server ${msg.serverId.slice(0, 8)} (now ${creds.length} linked)`);
      if (pairConn === conn) { stopConn(conn); pairConn = null; }
      status.pairing = false;
      pairToken = null;
      try { fs.unlinkSync(TOKEN_FILE); } catch {}
      if (!authConns.has(cred.serverId)) openAuthConnection(cred);
      break;
    }
    case 'pair-pending':
      console.log('[agent] pairing token announced; paste it in the dashboard to finish linking');
      break;
    case 'authed':
      console.log(`[agent] ${connLabel(conn)} authenticated; tunnel ready`);
      if (!conn.isPair) { status.links[conn.id.slice(0, 8)] = 'connected'; writeStatus(); }
      break;
    case 'rotate': {
      // Hub-initiated credential rotation: persist first, then acknowledge.
      if (conn.isPair || typeof msg.agentSecret !== 'string' || msg.agentSecret.length < 32) return;
      try {
        conn.cred.agentSecret = msg.agentSecret;
        const c = creds.find(x => x.serverId === conn.cred.serverId);
        if (c) c.agentSecret = msg.agentSecret;
        saveCreds();
        send({ kind: 'rotate-ack', rotationId: msg.rotationId });
        console.log(`[agent] ${connLabel(conn)} credential rotated`);
      } catch (err) {
        console.error('[agent] could not persist rotated credential:', err.message);
        send({ kind: 'rotate-failed', rotationId: msg.rotationId });
      }
      break;
    }
    case 'unlinked':
      console.log(`[agent] ${connLabel(conn)} unlinked by dashboard`);
      if (conn.cred) dropCredential(conn.cred.serverId, 'unlinked');
      if (creds.length === 0 && !pairConn) printNotLinkedBanner();
      break;
    case 'revoked':
      if (conn.cred) dropCredential(conn.cred.serverId, 'revoked');
      break;
    case 'http':
      if (!conn.isPair) relayHttp(conn, msg, send);
      break;
    case 'http-cancel':
      if (!conn.isPair) cancelHttp(conn, msg.id);
      break;
    case 'term-open':
      if (!conn.isPair) openTerminal(conn.id, msg.channel, send);
      break;
    case 'term':
      if (!conn.isPair) terminalFrame(conn.id, msg.channel, msg.frame);
      break;
    case 'term-close':
      closeTerminal(conn.id, msg.channel);
      break;
    case 'error': {
      console.error(`[agent] ${connLabel(conn)} hub error: ${msg.error}`);
      // Credentials are only discarded on an explicit authentication failure.
      // (Matching any message containing "invalid" used to make a transient
      // hub error permanently unlink the server.)
      const legacyAuthFail = !msg.code && /invalid credentials|unknown server|revoked/i.test(msg.error || '');
      if (conn.cred && (msg.code === 'auth_failed' || legacyAuthFail)) dropCredential(conn.cred.serverId, 'rejected by hub');
      const legacyPairFail = !msg.code && /invalid or expired pairing|already has an active agent/i.test(msg.error || '');
      if (conn.isPair && (msg.code === 'pair_invalid' || msg.code === 'pair_conflict' || legacyPairFail)) {
        try { fs.unlinkSync(TOKEN_FILE); } catch {}
        pairToken = null;
        stopConn(conn);
        if (pairConn === conn) pairConn = null;
        status.pairing = false;
        writeStatus();
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
  if (pairToken && !pairConn) openPairConnection(pairToken);
  if (creds.length === 0 && !pairToken) {
    printNotLinkedBanner();
    setTimeout(start, 5000); // keep polling until a token shows up
  } else {
    console.log(`[agent] ${creds.length} account(s) linked${pairToken ? ', 1 pairing in progress' : ''}`);
  }
}

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

// `node tunnel.js --revoke-all`: tell the hub to revoke every stored
// credential, then delete them locally. Used by uninstall-host.sh --purge so a
// removed agent leaves no still-valid credential behind.
function revokeAll() {
  const list = loadCreds();
  if (!list.length) { console.log('No stored credentials.'); return Promise.resolve(0); }
  return Promise.all(list.map(cred => new Promise(resolve => {
    const ws = new WebSocket(HUB_URL, wsOptions());
    const done = ok => { try { ws.close(); } catch {} resolve(ok); };
    const timer = setTimeout(() => done(false), 20000);
    ws.on('open', () => ws.send(JSON.stringify({ kind: 'hello', mode: 'auth', serverId: cred.serverId, agentSecret: cred.agentSecret, info: agentInfo() })));
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.kind === 'authed') ws.send(JSON.stringify({ kind: 'revoke' }));
      if (msg.kind === 'revoked') { clearTimeout(timer); console.log(`revoked ${cred.serverId.slice(0, 8)}`); done(true); }
      if (msg.kind === 'error') { clearTimeout(timer); console.log(`hub refused ${cred.serverId.slice(0, 8)}: ${msg.error}`); done(msg.code === 'auth_failed'); }
    });
    ws.on('error', err => { clearTimeout(timer); console.log(`could not reach hub for ${cred.serverId.slice(0, 8)}: ${err.message}`); done(false); });
  }))).then(results => {
    const failed = results.filter(r => !r).length;
    if (!failed) { try { fs.unlinkSync(CRED_FILE); } catch {} }
    return failed;
  });
}

// ─── Boot ────────────────────────────────────────────────────────────────────
function main() {
  const urlProblem = checkHubUrl(HUB_URL);
  if (urlProblem) { console.error(`[agent] ${urlProblem}`); process.exit(2); }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    console.error('[agent] NODE_TLS_REJECT_UNAUTHORIZED=0 disables hub certificate checks; refusing to start.');
    process.exit(2);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  if (process.argv.includes('--revoke-all')) {
    revokeAll().then(failed => process.exit(failed ? 1 : 0));
    return;
  }

  startLocalApi();
  watchPairingToken();
  setTimeout(start, 1500); // give the local API a moment to bind
  const shutdown = () => {
    stopping = true;
    for (const conn of authConns.values()) stopConn(conn);
    if (pairConn) stopConn(pairConn);
    if (child) { try { child.kill('SIGTERM'); } catch {} }
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { checkHubUrl };
