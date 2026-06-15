const express = require('express');
const net = require('net');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fsSync = require('fs');
const fs = fsSync.promises;
const path = require('path');
const YAML = require('yaml');
const archiver = require('archiver');
const { WebSocketServer } = require('ws');
let jwt; try { jwt = require('jsonwebtoken'); } catch { jwt = null; }
let pty;
try { pty = require('@homebridge/node-pty-prebuilt-multiarch'); } catch { pty = null; }

// Load env file — checks several conventional locations
function loadEnvFile(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) return;
    fsSync.readFileSync(filePath, 'utf-8').split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq < 1) return;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (!(k in process.env)) process.env[k] = v;
    });
  } catch {}
}
const app = express();
// Agent mode: the local API is bound to loopback only and reached exclusively
// through the outbound tunnel (tunnel.js). It must never be publicly exposed.
const PORT = process.env.AGENT_LOCAL_PORT || process.env.PORT || 37001;
const BIND_HOST = process.env.AGENT_BIND_HOST || '127.0.0.1';

// SERVER_ROOT is the directory holding the host's main docker-compose.yml
// (alongside optional services/, envs/, Caddyfile). Set it explicitly via the
// systemd unit if the host's compose lives somewhere unusual; otherwise we
// auto-detect on startup so the agent reflects the ACTUAL host layout — never
// a path baked in at the publisher's machine.
function detectServerRoot() {
  if (process.env.SERVER_ROOT) return process.env.SERVER_ROOT;
  const composeNames = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  const hasCompose = (dir) => composeNames.some(n => { try { return fsSync.statSync(path.join(dir, n)).isFile(); } catch { return false; } });
  // 1. Top-level common roots, shallowest wins.
  for (const candidate of ['/root', '/srv']) {
    if (hasCompose(candidate)) return candidate;
  }
  // 2. One level deep under /home and /opt (e.g. /home/alice, /opt/myapp).
  for (const parent of ['/home', '/opt']) {
    try {
      for (const e of fsSync.readdirSync(parent, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = path.join(parent, e.name);
        if (hasCompose(dir)) return dir;
      }
    } catch {}
  }
  // 3. Last-resort default — most Linux servers admin as root.
  return '/root';
}

const SERVER_ROOT = detectServerRoot();
const SERVICES_DIR  = process.env.SERVICES_DIR || path.join(SERVER_ROOT, 'services');
const ENVS_DIR      = process.env.ENVS_DIR || path.join(SERVER_ROOT, 'envs');
const CADDYFILE     = process.env.CADDYFILE || path.join(SERVER_ROOT, 'Caddyfile');
const MAIN_COMPOSE  = process.env.MAIN_COMPOSE || path.join(SERVER_ROOT, 'docker-compose.yml');

// Try all likely locations for an env file; first match per key wins.
[
  path.join(ENVS_DIR, '.dashboard-env'),
  path.join(__dirname, '.dashboard-env'),
  path.join(__dirname, '.env'),
].forEach(loadEnvFile);

// Optional SSH target for terminals/host commands. Native installs use a
// local PTY by default (terminals are real host shells already); SSH is only
// used when TERMINAL_USE_SSH=true AND TERMINAL_SSH_HOST is explicitly set.
const TERMINAL_SSH_HOST = process.env.TERMINAL_SSH_HOST || '';

app.use(cors());
app.use(express.json({ limit: '100mb' }));

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'public')));
}

function execCmd(cmd, timeout = 60000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (error) reject({ error: error.message, stderr, code: error.code });
      else resolve({ stdout, stderr });
    });
  });
}

// Run a command and stream its combined stdout/stderr to the HTTP response as
// plain text chunks (live). Always ends with "[label] exited with code N" so
// the frontend can determine success.
function streamCommand(res, cmd, label, timeout = 120000) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(`$ ${cmd}\n`);

  const child = spawn(cmd, { shell: true });
  let finished = false;
  const finish = (code, note) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (note) res.write(`\n${note}`);
    res.write(`\n[${label}] exited with code ${code}\n`);
    res.end();
  };
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
    finish(124, `[${label}] timed out after ${Math.round(timeout / 1000)}s`);
  }, timeout);

  child.stdout.on('data', d => { if (!finished) res.write(d); });
  child.stderr.on('data', d => { if (!finished) res.write(d); });
  child.on('error', err => finish(1, `[${label}] error: ${err.message}`));
  child.on('close', code => finish(code ?? 0));
  res.on('close', () => { clearTimeout(timer); }); // client gone — let the command finish on its own
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Parse `df -P -k` output into a list of real disks — one row per physical
// device, skipping pseudo-filesystems, container layers, and file bind mounts
// (e.g. .ssh/id_rsa, /etc/hosts) that df reports inside containers.
function parseDfDisks(dfOut) {
  if (!dfOut || !String(dfOut).trim()) return [];
  const bySource = new Set();
  const disks = [];
  for (const line of String(dfOut).split('\n').slice(1)) {
    if (!line.trim()) continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 6) continue;
    const source = p[0];
    const mount  = p.slice(5).join(' ');
    const sizeK  = parseInt(p[1]) || 0;
    // Real block devices (not loop/snap) or network filesystems (nfs/cifs "host:/path")
    const isRealDevice = (/^\/dev\//.test(source) && !/^\/dev\/loop/.test(source)) || source.includes(':');
    if (!isRealDevice || sizeK <= 0 || !mount) continue;
    // Docker-internal paths and file bind mounts are not disks
    if (/^\/(proc|sys|dev|run|snap)(\/|$)/.test(mount)) continue;
    if (/\/\.ssh(\/|$)/.test(mount)) continue;
    if (/^\/etc\//.test(mount) || mount.startsWith('/var/run') || /^\/var\/lib\/docker\//.test(mount)) continue;
    // One row per device — the same disk bind-mounted in several places counts once
    if (bySource.has(source)) continue;
    bySource.add(source);
    disks.push({
      source,
      sizeK,
      usedK:  parseInt(p[2]) || 0,
      availK: parseInt(p[3]) || 0,
      percent: parseInt(p[4]) || 0,
      mount,
    });
  }
  return disks;
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes || parts.length === 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return parts.join(', ');
}

async function getSystemUptime() {
  try {
    const content = await fs.readFile('/proc/uptime', 'utf-8');
    const seconds = parseFloat(content.split(/\s+/)[0]);
    if (Number.isFinite(seconds)) return formatDuration(seconds);
  } catch {}

  try {
    const { stdout } = await execCmd('uptime -p');
    return stdout.trim().replace(/^up\s+/, '');
  } catch {}

  return 'unknown';
}

// Find a usable SSH private key. Skips paths that exist but are not regular
// files (e.g. a directory created from a bad volume mount → EISDIR).
function findSshKey() {
  const homeDir = process.env.HOME || '/root';
  const candidates = [
    process.env.TERMINAL_SSH_KEY_PATH,
    path.join(homeDir, '.ssh', 'id_rsa'),
    path.join(homeDir, '.ssh', 'id_ed25519'),
    path.join(homeDir, '.ssh', 'id_ecdsa'),
    path.join(SERVER_ROOT, '.ssh', 'id_rsa'),
    path.join(SERVER_ROOT, '.ssh', 'id_ed25519'),
    path.join(SERVER_ROOT, '.ssh', 'id_ecdsa'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fsSync.statSync(p).isFile()) return fsSync.readFileSync(p);
    } catch {}
  }
  return null;
}

function probeTcp(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(ok); } };
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => { clearTimeout(timer); finish(true); });
    sock.on('error',   () => { clearTimeout(timer); finish(false); });
  });
}

// Optional SSH escape hatch — used only when the operator explicitly sets
// TERMINAL_USE_SSH=true (e.g. to proxy commands from this agent to a separate
// machine over SSH). The native install runs the agent as root on the host
// already, so the default web terminal is a local PTY and this path is
// dormant for almost everyone.
let _sshHostCache = { host: null, ts: 0 };
async function resolveSshHost() {
  const now = Date.now();
  if (_sshHostCache.host && now - _sshHostCache.ts < 5 * 60 * 1000) return _sshHostCache.host;
  const sshPort = parseInt(process.env.TERMINAL_SSH_PORT) || 22;
  const candidates = [TERMINAL_SSH_HOST].filter(Boolean);
  for (const host of candidates) {
    if (await probeTcp(host, sshPort)) {
      _sshHostCache = { host, ts: now };
      return host;
    }
  }
  throw new Error(
    `TERMINAL_USE_SSH is enabled but no SSH host responded on port ${sshPort}. ` +
    `Set TERMINAL_SSH_HOST in the systemd unit (sudo systemctl edit dashboard-agent) ` +
    `and make sure sshd on the target accepts the configured key.`
  );
}

// Run a command on the real server via SSH (used when backend is in a container)
async function sshExec(command, timeoutMs = 15000) {
  const privateKey = findSshKey();
  if (!privateKey) throw new Error('No usable SSH private key found.');
  const sshHost = await resolveSshHost();
  if (!sshHost) throw new Error('TERMINAL_SSH_HOST not set');

  return new Promise((resolve, reject) => {
    const sshUser    = process.env.TERMINAL_SSH_USER     || 'root';
    const sshPort    = parseInt(process.env.TERMINAL_SSH_PORT) || 22;

    const conn = new (require('ssh2').Client)();
    let out = '';
    const timer = setTimeout(() => { conn.end(); reject(new Error('SSH exec timed out')); }, timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err); }
        stream.on('data', d => { out += d; });
        stream.stderr.on('data', d => { out += d; });
        stream.on('close', () => { clearTimeout(timer); conn.end(); resolve(out); });
      });
    });
    conn.on('error', e => { clearTimeout(timer); reject(e); });
    conn.connect({ host: sshHost, port: sshPort, username: sshUser, privateKey });
  });
}

// Run a host-level command: prefer SSH to the host (full host view, real
// coreutils); fall back to running locally inside the container.
async function hostExec(cmd, timeoutMs = 10000) {
  try {
    const out = await sshExec(cmd, timeoutMs);
    return { stdout: String(out) };
  } catch {
    return execCmd(cmd, timeoutMs);
  }
}

// The dashboard container runs on the server with pid:host, so local ps sees
// host processes. Try local first; fall back to SSH for remote setups.
async function readLinuxProcesses(limit = 150) {
  let stdout;
  try {
    ({ stdout } = await execCmd(`ps aux --sort=-%cpu`, 15000));
  } catch {
    stdout = await sshExec(`ps aux --sort=-%cpu`);
  }
  const lines = (stdout || '').trim().split('\n');
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      type:    'process',
      pid:     parts[1],
      user:    parts[0],
      cpu:     parts[2],
      mem:     formatBytes((parseInt(parts[5]) || 0) * 1024),
      stat:    parts[7],
      command: parts.slice(10).join(' ').slice(0, 120),
    };
  }).filter(p => /^\d+$/.test(p.pid)).slice(0, limit);
}

async function readWindowsProcesses(limit = 100) {
  const ps = `Get-Process | Sort-Object CPU -Descending | Select-Object -First ${limit} Id,ProcessName,CPU,WorkingSet64,StartTime | ConvertTo-Json -Depth 3`;
  const { stdout } = await execCmd(`powershell -NoProfile -Command "${ps}"`, 15000);
  const rows = JSON.parse(stdout || '[]');
  return (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map(p => ({
    type: 'process',
    pid: String(p.Id),
    ppid: '',
    user: '',
    cpu: '0',
    mem: formatBytes(p.WorkingSet64 || 0),
    stat: 'running',
    elapsed: p.StartTime || '',
    command: p.ProcessName,
  }));
}

async function getServerIps() {
  const ips = new Set();
  const addIps = text => {
    String(text || '').split(/\s+/).forEach(token => {
      const ip = token.replace(/\/\d+$/, '');
      if (/^(?!127\.)(?!169\.254\.)\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ips.add(ip);
    });
  };

  try { addIps((await execCmd('hostname -I')).stdout); } catch {}
  try { addIps((await execCmd("ip -o -4 addr show scope global | awk '{print $4}'")).stdout); } catch {}
  try { addIps((await execCmd("ip route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i==\"src\") print $(i+1)}'")).stdout); } catch {}

  return Array.from(ips);
}

function isSafeName(name) {
  return /^[a-zA-Z0-9_.-]+$/.test(name || '');
}

function shQuote(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

async function readTextIfExists(file, fallback = '') {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function readComposeDoc() {
  const content = await readTextIfExists(MAIN_COMPOSE, 'name: homeserver\n\nservices: {}\n');
  return YAML.parse(content) || {};
}

async function getMainComposeServices() {
  try {
    const doc = await readComposeDoc();
    return doc.services && typeof doc.services === 'object' ? doc.services : {};
  } catch {
    return {};
  }
}

function serviceMatchesDirectory(name, serviceDef) {
  const serviceDir = getServiceDirectory(name, serviceDef);
  if (!serviceDir) return null;
  const rel = path.relative(SERVICES_DIR, serviceDir).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split('/')[0];
}

function getComposeServiceForDirectory(dirName, services) {
  if (services[dirName]) return { name: dirName, def: services[dirName] };
  for (const [name, def] of Object.entries(services)) {
    if (serviceMatchesDirectory(name, def) === dirName) return { name, def };
    if (def?.container_name === dirName) return { name, def };
  }
  return null;
}

function getComposeServicesForDirectory(dirName, services) {
  const matches = [];
  for (const [name, def] of Object.entries(services)) {
    if (name === dirName || serviceMatchesDirectory(name, def) === dirName || def?.container_name === dirName) {
      matches.push({ name, def });
    }
  }
  return matches;
}

async function mainComposeHasService(name) {
  const services = await getMainComposeServices();
  return Object.prototype.hasOwnProperty.call(services, name);
}

function resolveServerPath(rawPath) {
  if (!rawPath) return null;
  const cleaned = String(rawPath).trim();
  if (!cleaned) return null;
  if (path.isAbsolute(cleaned)) return cleaned;
  return path.resolve(SERVER_ROOT, cleaned);
}

async function getEnvPathFromCompose(name) {
  const services = await getMainComposeServices();
  const svc = getComposeServiceForDirectory(name, services)?.def || services[name];
  if (!svc?.env_file) return null;
  const envFile = Array.isArray(svc.env_file) ? svc.env_file[0] : svc.env_file;
  return resolveServerPath(envFile);
}

function getTopLevelBlockRange(lines, key) {
  const start = lines.findIndex(line => new RegExp(`^${key}:\\s*(#.*)?$`).test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z0-9_-]+:\s*(#.*)?$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function indentYaml(obj, spaces = 2) {
  const pad = ' '.repeat(spaces);
  return YAML.stringify(obj).trimEnd().split('\n').map(line => pad + line).join('\n');
}

async function appendTopLevelEntries(content, key, entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return content;

  const current = YAML.parse(content) || {};
  const existing = current[key] && typeof current[key] === 'object' ? current[key] : {};
  const missing = {};
  for (const [entryName, entryValue] of Object.entries(entries)) {
    if (!Object.prototype.hasOwnProperty.call(existing, entryName)) {
      missing[entryName] = entryValue ?? {};
    }
  }
  if (Object.keys(missing).length === 0) return content;

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const snippet = indentYaml(missing, 2).split('\n');
  const range = getTopLevelBlockRange(lines, key);

  if (!range) {
    const tail = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(tail, 0, '', `${key}:`, ...snippet);
  } else {
    lines.splice(range.end, 0, ...snippet);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function appendComposeServices(servicesToAdd, sourceDoc = {}) {
  const existing = await getMainComposeServices();
  const duplicate = Object.keys(servicesToAdd).find(name => existing[name]);
  if (duplicate) throw new Error(`Service "${duplicate}" already exists in ${MAIN_COMPOSE}.`);

  await fs.mkdir(path.dirname(MAIN_COMPOSE), { recursive: true });
  let content = await readTextIfExists(MAIN_COMPOSE, 'name: homeserver\n\nservices:\n');
  let lines = content.replace(/\r\n/g, '\n').split('\n');

  if (!getTopLevelBlockRange(lines, 'services')) {
    const tail = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(tail, 0, '', 'services:');
  }

  const range = getTopLevelBlockRange(lines, 'services');
  const snippet = indentYaml(servicesToAdd, 2).split('\n');
  lines.splice(range.end, 0, ...snippet);
  content = lines.join('\n').replace(/\n{3,}/g, '\n\n');

  content = await appendTopLevelEntries(content, 'volumes', sourceDoc.volumes);
  content = await appendTopLevelEntries(content, 'networks', sourceDoc.networks);

  await fs.writeFile(MAIN_COMPOSE, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
}

async function replaceMainComposeService(name, serviceDef) {
  let content = await readTextIfExists(MAIN_COMPOSE);
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const range = getTopLevelBlockRange(lines, 'services');
  if (!range) throw new Error(`No services block found in ${MAIN_COMPOSE}.`);

  const serviceStart = lines.findIndex((line, i) =>
    i > range.start && i < range.end && new RegExp(`^  ${name}:\\s*(#.*)?$`).test(line)
  );
  if (serviceStart === -1) throw new Error(`Service "${name}" was not found in ${MAIN_COMPOSE}.`);

  let serviceEnd = range.end;
  for (let i = serviceStart + 1; i < range.end; i++) {
    if (/^  [A-Za-z0-9_.-]+:\s*(#.*)?$/.test(lines[i])) {
      serviceEnd = i;
      break;
    }
  }

  const snippet = indentYaml({ [name]: serviceDef }, 2).split('\n');
  lines.splice(serviceStart, serviceEnd - serviceStart, ...snippet);
  content = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  await fs.writeFile(MAIN_COMPOSE, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
}

function extractServiceCompose(name, composeContent) {
  const doc = YAML.parse(composeContent || '') || {};
  let services = doc.services && typeof doc.services === 'object' ? doc.services : null;

  if (!services) {
    // If doc looks like { svcName: { ...def... } } without a 'services:' key,
    // treat the single entry's value as the service definition.
    const docEntries = Object.entries(doc);
    if (
      docEntries.length === 1 &&
      docEntries[0][1] && typeof docEntries[0][1] === 'object' && !Array.isArray(docEntries[0][1])
    ) {
      services = { [name]: docEntries[0][1] };
    } else {
      services = { [name]: doc };
    }
  }

  const entries = Object.entries(services);
  if (entries.length === 1 && !services[name]) {
    services = { [name]: entries[0][1] };
  }

  for (const [svcName, svc] of Object.entries(services)) {
    if (!isSafeName(svcName)) throw new Error(`Invalid compose service name "${svcName}".`);
    if (!svc || typeof svc !== 'object' || Array.isArray(svc)) {
      throw new Error(`Compose service "${svcName}" must be an object.`);
    }
  }

  return { sourceDoc: doc, services };
}

async function appendCaddyBlock(block) {
  const trimmed = (block || '').trim();
  if (!trimmed) return false;
  await fs.mkdir(path.dirname(CADDYFILE), { recursive: true });

  const content = await readTextIfExists(CADDYFILE, '');
  const firstLine = trimmed.split('\n')[0].trim();
  if (firstLine && content.includes(firstLine)) {
    throw new Error(`Caddy already appears to contain a block for "${firstLine}".`);
  }

  const next = `${content.trimEnd()}\n\n${trimmed}\n`;
  await fs.writeFile(CADDYFILE, next, 'utf-8');
  return true;
}

async function listDockerContainers() {
  try {
    const { stdout } = await execCmd('docker ps -a --format "{{json .}}"');
    return stdout.trim().split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Probe whether the docker daemon is actually reachable on this host. We use
// `docker ps -q` (cheapest possible call — just enumerate IDs) as the
// liveness check; it succeeds in single-digit ms when the daemon is up and
// fails fast with a useful socket error when it isn't. Cached for 5s so
// repeated /api/services calls don't hammer it.
let _dockerStatusCache = { value: null, ts: 0 };
async function getDockerStatus() {
  const now = Date.now();
  if (_dockerStatusCache.value && now - _dockerStatusCache.ts < 5000) return _dockerStatusCache.value;
  let installed = false, running = false, error = null;
  try {
    await execCmd('docker --version', 5000);
    installed = true;
  } catch { /* docker binary not on PATH */ }
  if (installed) {
    try {
      await execCmd('docker ps -q', 8000);
      running = true;
    } catch (err) {
      const raw = (err.stderr || err.error || '').toString().trim();
      error = raw.split('\n').slice(-1)[0] || 'docker daemon not reachable';
      console.warn('[agent] docker daemon probe failed:', error);
    }
  } else {
    error = "docker is not installed on this host (the agent's start/stop/logs actions need it)";
  }
  const value = { installed, running, error };
  _dockerStatusCache = { value, ts: now };
  return value;
}

function labelsObject(labels) {
  return String(labels || '').split(',').reduce((acc, item) => {
    const eq = item.indexOf('=');
    if (eq > -1) acc[item.slice(0, eq).trim()] = item.slice(eq + 1);
    return acc;
  }, {});
}

function containerNames(c) {
  return String(c?.Names || '').split(',').map(n => n.trim()).filter(Boolean);
}

// Match a docker container to a compose service by, in order of certainty:
//   1. The compose label `com.docker.compose.service=<name>` — set by both
//      docker compose v1 (project_service_idx) and v2 (project-service-idx).
//      Reliable across naming changes; the right thing 99% of the time.
//   2. Exact container_name match (when the compose has `container_name: foo`
//      docker uses that verbatim and no compose label is added on legacy v1).
//   3. Compose-default naming: <project>(-|_)<service>(-|_)<index> — used when
//      labels are stripped somehow (custom labels, externally-recreated, etc).
// We do NOT do a loose substring match anymore: it produced false positives
// like service "db" matching container "couchdb" or "web" matching "webhook",
// which is why the dashboard sometimes showed a service as running/stopped
// based on a completely unrelated container's state.
function findContainerForService(containers, name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  const composePattern = new RegExp(`(^|[-_])${escapeRegExp(lower)}([-_]\\d+)?$`);

  const matches = containers.filter(c => {
    if (labelsObject(c.Labels)['com.docker.compose.service'] === name) return true;
    const names = containerNames(c);
    if (names.some(n => n.toLowerCase() === lower)) return true;
    if (names.some(n => composePattern.test(n.toLowerCase()))) return true;
    return false;
  });

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Multiple candidates (e.g. a stale stopped container + a new running one
  // from compose up -> down -> up): prefer the running one, then any
  // non-exited one, then the most-recently-created.
  return matches.find(c => (c.State || '').toLowerCase() === 'running')
      || matches.find(c => !/exited|dead/.test((c.State || '').toLowerCase()))
      || matches.slice().sort((a, b) => (b.CreatedAt || '').localeCompare(a.CreatedAt || ''))[0];
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getContainerStatus(container) {
  if (!container) return 'not deployed';
  const s = (container.State || container.Status || '').toLowerCase();
  if (s.includes('running'))    return 'running';
  if (s.includes('restart'))    return 'restarting';
  if (s.includes('paused'))     return 'paused';
  if (s.includes('exited') ||
      s.includes('stopped') ||
      s.includes('dead'))        return 'stopped';
  if (s.includes('created'))    return 'created';
  return s || 'unknown';
}

function aggregateContainerStatus(containers) {
  const statuses = containers.map(getContainerStatus);
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('restarting')) return 'restarting';
  if (statuses.includes('paused')) return 'paused';
  if (statuses.includes('stopped')) return 'stopped';
  return 'not deployed';
}

function getServiceDirectory(name, serviceDef) {
  const build = serviceDef?.build;
  if (typeof build === 'string') return resolveServerPath(build);
  if (build?.context) return resolveServerPath(build.context);
  return path.join(SERVICES_DIR, name);
}

async function getServiceConfig(name) {
  if (!isSafeName(name)) throw new Error('Invalid service name.');
  const mainServices = await getMainComposeServices();
  const composeService = getComposeServiceForDirectory(name, mainServices);
  const serviceDef = composeService?.def || null;
  return {
    composeServiceName: composeService?.name || name,
    serviceDef,
    serviceDir: path.join(SERVICES_DIR, name),
    targets: [...new Set([
      name,
      composeService?.name,
      serviceDef?.container_name,
    ].filter(Boolean))],
  };
}

function resolveServiceFilePath(serviceDir, requestedPath = '.') {
  const relative = String(requestedPath || '.').replace(/\\/g, '/');
  const target = path.resolve(serviceDir, relative);
  const base = path.resolve(serviceDir);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path is outside the service directory.');
  }
  return { target, relative: rel || '.' };
}

function isLikelyEditable(filePath, size) {
  if (size > 2 * 1024 * 1024) return false;
  const editableExtensions = new Set([
    '.cjs', '.conf', '.css', '.csv', '.env', '.html', '.ini', '.js', '.json',
    '.jsx', '.log', '.md', '.mjs', '.py', '.sh', '.sql', '.ts', '.tsx', '.txt',
    '.xml', '.yaml', '.yml',
  ]);
  const ext = path.extname(filePath).toLowerCase();
  return editableExtensions.has(ext) || path.basename(filePath).startsWith('.');
}

function parseCaddyBlocks(content) {
  const blocks = [];
  let depth = 0;
  let blockStart = -1;
  let title = '';

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') {
      if (depth === 0) {
        const lineStart = content.lastIndexOf('\n', i) + 1;
        title = content.slice(lineStart, i).trim();
        blockStart = lineStart;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && blockStart >= 0) {
        const end = i + 1;
        blocks.push({
          title,
          start: blockStart,
          end,
          content: content.slice(blockStart, end),
        });
        blockStart = -1;
        title = '';
      }
    }
  }

  return blocks.filter(block => block.title);
}

function getCaddyRootTargets(block) {
  const targets = [];
  for (const line of block.content.split('\n')) {
    const match = line.trim().match(/^root\s+(?:\*\s+)?(\S+)/);
    if (match) targets.push(match[1]);
  }
  return targets;
}

function getCaddyMounts(services) {
  const caddy = services.caddy;
  const volumes = Array.isArray(caddy?.volumes) ? caddy.volumes : [];
  return volumes.map(volume => {
    if (typeof volume === 'string') {
      const [source, target] = volume.split(':');
      return { source, target, sourcePath: resolveServerPath(source), raw: volume };
    }
    if (volume?.source && volume?.target) {
      return { source: volume.source, target: volume.target, sourcePath: resolveServerPath(volume.source), raw: volume };
    }
    return null;
  }).filter(v => v?.source && v?.target);
}

function getCaddyStaticService(name, services, caddyContent) {
  const serviceDir = path.join(SERVICES_DIR, name);
  const mount = getCaddyMounts(services).find(v => {
    if (!v.sourcePath) return false;
    return path.resolve(v.sourcePath) === path.resolve(serviceDir);
  });
  if (!mount) return null;

  const blocks = parseCaddyBlocks(caddyContent);
  const blocksUsingMount = blocks.filter(block => getCaddyRootTargets(block).some(target => target === mount.target));
  if (blocksUsingMount.length === 0) return null;

  return {
    mount,
    blocks: blocksUsingMount,
    hosts: blocksUsingMount.map(block => block.title),
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getCaddyBlocksForService(name) {
  const { targets } = await getServiceConfig(name);
  const services = await getMainComposeServices();
  const content = await readTextIfExists(CADDYFILE, '');
  const blocks = parseCaddyBlocks(content);
  const proxyMatches = blocks.filter(block => targets.some(target => {
    const escaped = escapeRegex(target);
    const re = new RegExp(`\\breverse_proxy\\s+(?:https?:\\/\\/)?${escaped}(?=[:\\s/{]|$)`, 'i');
    return re.test(block.content);
  }));
  const caddyStatic = getCaddyStaticService(name, services, content);
  const rootMatches = caddyStatic?.blocks || [];
  const matches = [...new Map([...proxyMatches, ...rootMatches].map(block => [block.start, block])).values()]
    .sort((a, b) => a.start - b.start);
  return { content, matches, targets };
}

async function saveCaddyBlockForService(name, blockContent) {
  const nextBlock = String(blockContent || '').trim();
  if (!nextBlock) throw new Error('Caddy block cannot be empty.');

  await fs.mkdir(path.dirname(CADDYFILE), { recursive: true });
  const { content, matches } = await getCaddyBlocksForService(name);
  if (matches.length === 0) {
    await appendCaddyBlock(nextBlock);
    return `Added Caddy block for "${name}" to ${CADDYFILE}`;
  }

  const first = matches[0];
  const last = matches[matches.length - 1];
  const nextContent = `${content.slice(0, first.start).trimEnd()}\n\n${nextBlock}\n\n${content.slice(last.end).trimStart()}`;
  await fs.writeFile(CADDYFILE, nextContent.trimEnd() + '\n', 'utf-8');
  return `Updated Caddy block for "${name}" in ${CADDYFILE}`;
}

async function writeUploadedServiceFiles(serviceDir, uploadedFiles = [], { stripCommonTopFolder = true } = {}) {
  if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) return 0;
  const files = uploadedFiles.filter(f => f?.path);

  // Strip common top-level folder when all paths share the same first component
  // (happens with webkitdirectory folder uploads where the folder name is prepended).
  // Must be disabled for File Explorer uploads, where paths are already relative
  // to the service root and may legitimately share a target-directory prefix.
  const allHaveSubpath = files.length > 0 && files.every(f => f.path.includes('/'));
  const firstComponents = files.map(f => f.path.split('/')[0]);
  const allSameTop = allHaveSubpath && firstComponents.every(d => d === firstComponents[0]);
  const stripPrefix = stripCommonTopFolder && allSameTop ? `${firstComponents[0]}/` : '';

  let count = 0;
  for (const file of files) {
    const filePath = stripPrefix ? file.path.slice(stripPrefix.length) : file.path;
    if (!filePath) continue;
    const { target } = resolveServiceFilePath(serviceDir, filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const encoding = file.encoding || 'utf-8';
    const data = encoding === 'base64'
      ? Buffer.from(file.content || '', 'base64')
      : String(file.content || '');
    await fs.writeFile(target, data);
    count++;
  }
  return count;
}

// Recursively find all directories containing a Dockerfile, sorted shallowest first
async function findDockerfileContexts(serviceDir) {
  const results = [];
  async function scan(dir, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.isFile() && e.name === 'Dockerfile')) {
      results.push({ dir, depth, rel: path.relative(serviceDir, dir).replace(/\\/g, '/') || '.' });
    }
    for (const e of entries) {
      if (e.isDirectory()) await scan(path.join(dir, e.name), depth + 1);
    }
  }
  await scan(serviceDir, 0);
  results.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel));
  return results;
}

// Find immediate subdirectories not referenced by any service that contain HTML files
async function findStaticDirs(serviceDir, finalServices) {
  const referencedDirs = new Set();
  for (const svc of Object.values(finalServices)) {
    if (!svc || typeof svc !== 'object') continue;
    let buildPath = typeof svc.build === 'string' ? svc.build : svc.build?.context;
    if (buildPath) {
      const abs = path.resolve(SERVER_ROOT, buildPath);
      let cur = abs;
      while (cur.startsWith(serviceDir) && cur !== serviceDir) {
        referencedDirs.add(cur);
        cur = path.dirname(cur);
      }
    }
    for (const v of (Array.isArray(svc.volumes) ? svc.volumes : [])) {
      if (typeof v !== 'string') continue;
      const src = v.split(':')[0];
      if (src) referencedDirs.add(path.resolve(SERVER_ROOT, src));
    }
  }

  const result = [];
  try {
    const entries = await fs.readdir(serviceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(serviceDir, entry.name);
      if (referencedDirs.has(full)) continue;
      try {
        const contents = await fs.readdir(full);
        if (contents.some(f => f.endsWith('.html'))) {
          result.push({ name: entry.name, dir: full });
        }
      } catch {}
    }
  } catch {}
  return result;
}

// Build a Caddy block from the final services map. The public hostname for
// each generated site is `<service>.<PUBLIC_BASE_DOMAIN>` — set
// PUBLIC_BASE_DOMAIN in the systemd unit (install-host.sh wires it up) to your
// own apex. If unset the service name itself is used as the site address so
// nothing personal leaks into auto-generated configs.
function generateSmartCaddy(name, finalServices) {
  const baseDomain = (process.env.PUBLIC_BASE_DOMAIN || '').trim();
  const site = baseDomain ? `${name}.${baseDomain}:80` : `${name}:80`;
  const entries = Object.entries(finalServices);
  const buildSvcs  = entries.filter(([, s]) => s?.build !== undefined);
  const nginxSvcs  = entries.filter(([, s]) => s?.image === 'nginx:alpine');

  if (nginxSvcs.length > 0 && buildSvcs.length > 0) {
    const [nginxName]   = nginxSvcs[0];
    const [backendName] = buildSvcs[0];
    return `${site} {\n    handle /api/* {\n        reverse_proxy ${backendName}:3000\n    }\n    handle {\n        reverse_proxy ${nginxName}:80\n    }\n}`;
  }
  if (nginxSvcs.length > 0) {
    const [nginxName] = nginxSvcs[0];
    return `${site} {\n    reverse_proxy ${nginxName}:80\n}`;
  }
  if (buildSvcs.length > 0) {
    const [svcName] = buildSvcs[0];
    return `${site} {\n    reverse_proxy ${svcName}:3000\n}`;
  }
  return `${site} {\n    reverse_proxy ${name}:3000\n}`;
}

// After upload: verify build contexts have Dockerfiles, volume sources exist,
// and flag any subdirectories not referenced in the compose at all.
async function auditServiceDirectory(serviceDir, finalServices, serverRoot) {
  const warnings = [];

  // Collect all paths referenced in the services (build contexts + volume sources)
  const referencedDirs = new Set();
  for (const svc of Object.values(finalServices)) {
    if (!svc || typeof svc !== 'object') continue;

    let buildPath = typeof svc.build === 'string' ? svc.build : svc.build?.context;
    if (buildPath) {
      const abs = path.isAbsolute(buildPath)
        ? buildPath
        : path.resolve(serverRoot, buildPath);
      // Check Dockerfile exists
      try {
        await fs.access(path.join(abs, 'Dockerfile'));
      } catch {
        warnings.push(`Build context "${buildPath}" has no Dockerfile.`);
      }
      // Mark every ancestor under serviceDir as referenced
      let cur = abs;
      while (cur.startsWith(serviceDir) && cur !== serviceDir) {
        referencedDirs.add(cur);
        cur = path.dirname(cur);
      }
    }

    for (const v of (Array.isArray(svc.volumes) ? svc.volumes : [])) {
      if (typeof v !== 'string') continue;
      const src = v.split(':')[0];
      if (!src) continue;
      const abs = path.isAbsolute(src) ? src : path.resolve(serverRoot, src);
      try {
        await fs.access(abs);
        referencedDirs.add(abs);
      } catch {
        warnings.push(`Volume source "${src}" does not exist.`);
      }
    }
  }

  // Flag immediate subdirectories that are completely unreferenced
  try {
    const entries = await fs.readdir(serviceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(serviceDir, entry.name);
      if (!referencedDirs.has(full)) {
        warnings.push(`Directory "${entry.name}/" exists but is not referenced by any service.`);
      }
    }
  } catch {}

  return warnings;
}

async function getContainerTarget(name) {
  const containers = await listDockerContainers();
  const container = findContainerForService(containers, name);
  // Prefer the container ID (always unambiguous). If we only have Names, pick
  // the first one — Names can be a comma-separated list and passing the raw
  // value to `docker stats|logs` would error out.
  return container?.ID || containerNames(container)[0] || name;
}

// Env file: try compose env_file, .name-env, name.env, .name (matching the server's convention)
async function findEnvPath(name) {
  const composeEnv = await getEnvPathFromCompose(name);
  const candidates = [
    composeEnv,
    path.join(ENVS_DIR, `.${name}-env`),
    path.join(ENVS_DIR, `${name}.env`),
    path.join(ENVS_DIR, `.${name}`),
  ].filter(Boolean);
  for (const p of candidates) {
    try { await fs.access(p); return p; } catch {}
  }
  // default to the primary convention for writes
  return path.join(ENVS_DIR, `.${name}-env`);
}

// Service compose: own docker-compose.yml if it exists, else main compose
async function getComposeArgs(name) {
  if (!isSafeName(name)) throw new Error('Invalid service name.');
  const mainServices = await getMainComposeServices();
  const composeService = getComposeServiceForDirectory(name, mainServices);
  if (composeService) {
    return { file: MAIN_COMPOSE, service: composeService.name, source: 'main' };
  }
  const caddyStatic = getCaddyStaticService(name, mainServices, await readTextIfExists(CADDYFILE, ''));
  if (caddyStatic && mainServices.caddy) {
    return { file: MAIN_COMPOSE, service: 'caddy', source: 'caddy-static' };
  }
  const ownPath = path.join(SERVICES_DIR, name, 'docker-compose.yml');
  try {
    await fs.access(ownPath);
    return { file: ownPath, service: null, source: 'standalone' }; // standalone
  } catch {
    return { file: MAIN_COMPOSE, service: name, source: 'main' }; // main compose service
  }
}

function buildCmd(action, file, service) {
  const base = `docker compose -f ${shQuote(file)}`;
  const svcs = Array.isArray(service) ? service : (service ? [service] : []);
  const svcStr = svcs.length ? ' ' + svcs.map(shQuote).join(' ') : '';
  switch (action) {
    case 'start':   return `${base} up -d --build${svcStr}`;
    case 'stop':    return svcs.length ? `${base} stop${svcStr}` : `${base} down`;
    case 'restart': return `${base} restart${svcStr}`;
    case 'rebuild': return `${base} up -d --build${svcStr}`;
    case 'pull':    return `${base} pull${svcStr}`;
    default:        return null;
  }
}

async function getRelatedServiceNames(name) {
  const mainServices = await getMainComposeServices();
  const prefix = `${name}-`;
  return Object.keys(mainServices).filter(s => s === name || s.startsWith(prefix));
}

// ─── Auth ────────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET     = process.env.JWT_SECRET || process.env.ADMIN_PASSWORD; // fallback: use password as secret

app.post('/api/auth/token', (req, res) => {
  if (!ADMIN_PASSWORD) return res.json({ success: false, error: 'ADMIN_PASSWORD is not set on the server.' });
  if (!jwt)            return res.json({ success: false, error: 'jsonwebtoken module not installed.' });
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD)
    return res.status(401).json({ success: false, error: 'Incorrect password.' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ success: true, token });
});

function requireAuth(req, res, next) {
  if (!jwt)        return res.status(500).json({ success: false, error: 'Auth module not installed.' });
  if (!JWT_SECRET) return res.status(500).json({ success: false, error: 'JWT_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer '))
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  try {
    req.auth = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token. Re-enter your password.' });
  }
}

// ─── Services ───────────────────────────────────────────────────────────────

// GET /api/services — merges docker-compose services + services directory, tagged with source pills
app.get('/api/services', async (req, res) => {
  try {
    const mainServices   = await getMainComposeServices();
    // Always try to list containers regardless of what the probe says. If the
    // probe misfires (slow daemon, weird timeout) but `docker ps` actually
    // works, we still get correct per-service states. Only when BOTH probe
    // and listing yield nothing do we fall back to the "unknown" UX.
    const [docker, containers] = await Promise.all([
      getDockerStatus(),
      listDockerContainers(),
    ]);
    const dockerActuallyReachable = docker.running || containers.length > 0;
    const caddyContent   = await readTextIfExists(CADDYFILE, '');
    const caddyContainer = findContainerForService(containers, 'caddy');

    const composeNames = new Set(Object.keys(mainServices));
    let   dirNames     = new Set();
    try {
      const entries = await fs.readdir(SERVICES_DIR, { withFileTypes: true });
      dirNames = new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
    } catch {}

    const allNames = [...new Set([...composeNames, ...dirNames])].sort((a, b) => a.localeCompare(b));

    const services = allNames.map(name => {
      const def        = mainServices[name];
      const inCompose  = composeNames.has(name);
      const inDir      = dirNames.has(name);
      const sources    = [...(inCompose ? ['compose'] : []), ...(inDir ? ['directory'] : [])];

      const targets   = [...new Set([name, def?.container_name].filter(Boolean))];
      const matched   = targets.map(t => findContainerForService(containers, t)).filter(Boolean);
      const container = matched[0] || null;
      const caddyStatic = inCompose ? getCaddyStaticService(name, mainServices, caddyContent) : null;

      // Prefer the container-list result whenever we have one — that's the
      // ground truth. Only fall back to "unknown" when we have BOTH no
      // matching container AND no evidence that docker is reachable at all
      // (so the user gets a clear "docker isn't running" rather than a
      // misleading "not deployed").
      let status, uptime = container?.Status || null, statusSource;
      if (matched.length) {
        status = aggregateContainerStatus(matched);
        statusSource = 'container';
      } else if (caddyStatic && caddyContainer) {
        status = getContainerStatus(caddyContainer);
        uptime = caddyContainer?.Status || null;
        statusSource = 'caddy';
      } else if (!dockerActuallyReachable) {
        status = 'unknown';
        statusSource = 'docker-unavailable';
      } else {
        status = 'not deployed';
        statusSource = 'none';
      }

      return {
        name, sources, status,
        hasOwnCompose:   false,
        composeSource:   inCompose ? 'main' : 'none',
        composeFile:     MAIN_COMPOSE,
        composeService:  inCompose ? name : null,
        composeServices: inCompose ? [name] : [],
        containerTarget: def?.container_name || name,
        statusSource,
        caddyHosts:    caddyStatic?.hosts || [],
        serviceDir:    def ? getServiceDirectory(name, def) : path.join(SERVICES_DIR, name),
        containerId:   container?.ID    || null,
        containerName: container?.Names || null,
        image:         container?.Image || null,
        ports:         container?.Ports || null,
        uptime,
        dockerAvailable: dockerActuallyReachable,
        dockerError:     dockerActuallyReachable ? null : docker.error,
      };
    });

    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/docker/status — dedicated endpoint so the dashboard can show a
// top-level "Docker not running" banner without parsing the services list.
app.get('/api/docker/status', async (req, res) => {
  res.json(await getDockerStatus());
});

// GET /api/services/diagnose — debugging endpoint. Returns the raw container
// list AND, for every compose service, exactly which container matched it
// (or didn't) and why. Use when the dashboard shows wrong states:
//   curl -s http://127.0.0.1:37001/api/services/diagnose | jq .
app.get('/api/services/diagnose', async (req, res) => {
  try {
    const mainServices = await getMainComposeServices();
    const [docker, containers] = await Promise.all([
      getDockerStatus(),
      listDockerContainers(),
    ]);
    const services = Object.keys(mainServices).map(name => {
      const def     = mainServices[name];
      const targets = [...new Set([name, def?.container_name].filter(Boolean))];
      const matched = targets.map(t => ({ target: t, container: findContainerForService(containers, t) }));
      return {
        service: name,
        containerName: def?.container_name || null,
        triedTargets:  targets,
        matches:       matched.map(m => ({
          target:         m.target,
          matchedName:    m.container ? containerNames(m.container) : null,
          matchedId:      m.container?.ID || null,
          matchedState:   m.container?.State || null,
          composeService: m.container ? labelsObject(m.container.Labels)['com.docker.compose.service'] : null,
          composeProject: m.container ? labelsObject(m.container.Labels)['com.docker.compose.project'] : null,
        })),
      };
    });
    res.json({
      serverRoot: SERVER_ROOT,
      composeFile: MAIN_COMPOSE,
      docker,
      containerCount: containers.length,
      containers: containers.map(c => ({
        names:   containerNames(c),
        state:   c.State,
        status:  c.Status,
        image:   c.Image,
        service: labelsObject(c.Labels)['com.docker.compose.service'] || null,
        project: labelsObject(c.Labels)['com.docker.compose.project'] || null,
      })),
      services,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// GET /api/services/:name/stats
app.get('/api/services/:name/stats', async (req, res) => {
  const { name } = req.params;
  try {
    if (!isSafeName(name)) throw new Error('Invalid service name.');
    const target = await getContainerTarget(name);
    const { stdout } = await execCmd(`docker stats --no-stream --format "{{json .}}" ${shQuote(target)}`, 10000);
    res.json({ success: true, stats: JSON.parse(stdout.trim().split('\n')[0]) });
  } catch (err) {
    res.json({ success: false, error: err.error || err.message });
  }
});

// GET /api/services/:name/logs
app.get('/api/services/:name/logs', async (req, res) => {
  const { name } = req.params;
  const tail = parseInt(req.query.tail) || 200;
  try {
    if (!isSafeName(name)) throw new Error('Invalid service name.');
    const docker = await getDockerStatus();
    if (!docker.running) {
      throw new Error(docker.installed
        ? "Docker daemon isn't running on this host — no logs to fetch yet."
        : "Docker isn't installed on this host.");
    }
    const target = await getContainerTarget(name);
    const safeTail = Math.min(Math.max(tail, 1), 5000);
    const { stdout, stderr } = await execCmd(`docker logs --tail ${safeTail} --timestamps ${shQuote(target)} 2>&1`, 15000);
    res.json({ success: true, output: stdout || stderr });
  } catch (err) {
    res.json({ success: false, error: err.error || err.message, output: err.stderr || '' });
  }
});

// GET /api/services/:name/env
app.get('/api/services/:name/env', async (req, res) => {
  const { name } = req.params;
  try {
    const envPath = await findEnvPath(name);
    const content = await fs.readFile(envPath, 'utf-8');
    res.json({ success: true, content, path: envPath });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ success: true, content: '', path: path.join(ENVS_DIR, `.${name}-env`) });
    res.json({ success: false, error: err.message });
  }
});

// PUT /api/services/:name/env
app.put('/api/services/:name/env', async (req, res) => {
  const { name } = req.params;
  const { content } = req.body;
  try {
    await fs.mkdir(ENVS_DIR, { recursive: true });
    const envPath = await findEnvPath(name);
    await fs.writeFile(envPath, content, 'utf-8');
    res.json({ success: true, output: `Saved to ${envPath}` });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/services/:name/compose
app.get('/api/services/:name/compose', async (req, res) => {
  const { name } = req.params;
  try {
    if (!isSafeName(name)) throw new Error('Invalid service name.');
    const mainServices = await getMainComposeServices();
    const composeService = getComposeServiceForDirectory(name, mainServices);
    if (composeService) {
      return res.json({
        success: true,
        content: YAML.stringify({ services: { [composeService.name]: composeService.def } }),
        path: MAIN_COMPOSE,
        source: 'main',
        serviceName: composeService.name,
      });
    }
    const caddyStatic = getCaddyStaticService(name, mainServices, await readTextIfExists(CADDYFILE, ''));
    if (caddyStatic && mainServices.caddy) {
      return res.json({
        success: true,
        content: YAML.stringify({ services: { caddy: mainServices.caddy } }),
        path: MAIN_COMPOSE,
        source: 'caddy-static',
        serviceName: 'caddy',
        note: `Folder "${name}" is served by Caddy via ${caddyStatic.mount.raw}.`,
      });
    }

    const ownPath = path.join(SERVICES_DIR, name, 'docker-compose.yml');
    const content = await fs.readFile(ownPath, 'utf-8');
    res.json({ success: true, content, path: ownPath, source: 'standalone' });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ success: true, content: '' });
    res.json({ success: false, error: err.message });
  }
});

// PUT /api/services/:name/compose
app.put('/api/services/:name/compose', async (req, res) => {
  const { name } = req.params;
  const { content } = req.body;
  try {
    if (!isSafeName(name)) throw new Error('Invalid service name.');
    const mainServices = await getMainComposeServices();
    const composeService = getComposeServiceForDirectory(name, mainServices);
    if (composeService) {
      const { services } = extractServiceCompose(name, content);
      const nextName = services[composeService.name] ? composeService.name : Object.keys(services)[0];
      if (!nextName) throw new Error('The compose content must include a service.');
      await replaceMainComposeService(composeService.name, services[nextName]);
      return res.json({ success: true, output: `Updated service "${composeService.name}" in ${MAIN_COMPOSE}` });
    }
    const caddyStatic = getCaddyStaticService(name, mainServices, await readTextIfExists(CADDYFILE, ''));
    if (caddyStatic && mainServices.caddy) {
      const { services } = extractServiceCompose('caddy', content);
      const nextName = services.caddy ? 'caddy' : Object.keys(services)[0];
      if (!nextName) throw new Error('The compose content must include the caddy service.');
      await replaceMainComposeService('caddy', services[nextName]);
      return res.json({ success: true, output: `Updated Caddy service in ${MAIN_COMPOSE}` });
    }

    const ownPath = path.join(SERVICES_DIR, name, 'docker-compose.yml');
    await fs.mkdir(path.dirname(ownPath), { recursive: true });
    await fs.writeFile(ownPath, content, 'utf-8');
    res.json({ success: true, output: `Saved to ${ownPath}` });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/services/:name/caddy
app.get('/api/services/:name/caddy', async (req, res) => {
  const { name } = req.params;
  try {
    const { matches, targets } = await getCaddyBlocksForService(name);
    res.json({
      success: true,
      content: matches.map(block => block.content.trim()).join('\n\n'),
      blocks: matches,
      targets,
      path: CADDYFILE,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// PUT /api/services/:name/caddy
app.put('/api/services/:name/caddy', async (req, res) => {
  const { name } = req.params;
  const { content } = req.body;
  try {
    const output = await saveCaddyBlockForService(name, content);
    res.json({ success: true, output });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/services/:name/files?dir=relative/path
app.get('/api/services/:name/files', async (req, res) => {
  const { name } = req.params;
  try {
    const { serviceDir } = await getServiceConfig(name);
    const { target, relative } = resolveServiceFilePath(serviceDir, req.query.dir || '.');
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw new Error('Requested path is not a directory.');

    const entries = await fs.readdir(target, { withFileTypes: true });
    const files = await Promise.all(entries.map(async entry => {
      const entryPath = path.join(target, entry.name);
      const entryStat = await fs.stat(entryPath);
      const relPath = path.relative(serviceDir, entryPath).replace(/\\/g, '/');
      return {
        name: entry.name,
        path: relPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entryStat.size,
        modified: entryStat.mtime,
        editable: entry.isFile() && isLikelyEditable(entryPath, entryStat.size),
      };
    }));

    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ success: true, root: serviceDir, dir: relative, entries: files });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/services/:name/file?path=relative/file
app.get('/api/services/:name/file', async (req, res) => {
  const { name } = req.params;
  try {
    const { serviceDir } = await getServiceConfig(name);
    const { target, relative } = resolveServiceFilePath(serviceDir, req.query.path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('Requested path is not a file.');
    if (!isLikelyEditable(target, stat.size)) throw new Error('File is too large or not a text file.');

    const content = await fs.readFile(target, 'utf-8');
    res.json({ success: true, content, path: relative, absolutePath: target, size: stat.size, modified: stat.mtime });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// PUT /api/services/:name/file
app.put('/api/services/:name/file', async (req, res) => {
  const { name } = req.params;
  const { path: requestedPath, content } = req.body;
  try {
    const { serviceDir } = await getServiceConfig(name);
    const { target, relative } = resolveServiceFilePath(serviceDir, requestedPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content || '', 'utf-8');
    res.json({ success: true, output: `Saved ${relative}`, path: relative, absolutePath: target });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// DELETE /api/services/:name/file?path=relative/path  (works for files and directories)
app.delete('/api/services/:name/file', async (req, res) => {
  const { name } = req.params;
  try {
    const { serviceDir } = await getServiceConfig(name);
    const { target, relative } = resolveServiceFilePath(serviceDir, req.query.path);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      await fs.rm(target, { recursive: true, force: true });
    } else {
      await fs.unlink(target);
    }
    res.json({ success: true, output: `Deleted ${relative}` });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/services/:name/files/upload
app.post('/api/services/:name/files/upload', async (req, res) => {
  const { name } = req.params;
  const { files } = req.body;
  try {
    const { serviceDir } = await getServiceConfig(name);
    await fs.mkdir(serviceDir, { recursive: true });
    // Paths from the File Explorer are already relative to the service root
    // (including the current directory prefix) — never strip the top folder here.
    const count = await writeUploadedServiceFiles(serviceDir, files, { stripCommonTopFolder: false });
    res.json({ success: true, output: `Uploaded ${count} file${count === 1 ? '' : 's'}.`, count });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/services/:name/download?path=relative/path
app.get('/api/services/:name/download', async (req, res) => {
  const { name } = req.params;
  try {
    const { serviceDir } = await getServiceConfig(name);
    const { target, relative } = resolveServiceFilePath(serviceDir, req.query.path || '.');
    const stat = await fs.stat(target);

    if (stat.isDirectory()) {
      const archive = archiver('zip', { zlib: { level: 9 } });
      res.attachment(`${path.basename(target)}.zip`);
      archive.on('error', err => {
        if (!res.headersSent) res.status(500);
        res.end(err.message);
      });
      archive.pipe(res);
      archive.directory(target, path.basename(target));
      await archive.finalize();
      return;
    }

    res.download(target, path.basename(relative));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/services (create new service)
app.post('/api/services', async (req, res) => {
  const { name, composeContent, envContent, caddyContent, files } = req.body;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.json({ success: false, error: 'Invalid service name. Use only letters, numbers, hyphens, underscores.' });
  }
  try {
    const serviceDir = path.join(SERVICES_DIR, name);
    await fs.mkdir(serviceDir, { recursive: true });
    const uploadedCount = await writeUploadedServiceFiles(serviceDir, files);

    const defaultCompose = `services:
  ${name}:
    build:
      context: ./services/${name}
    container_name: ${name}
    restart: unless-stopped
    env_file:
      - ./envs/.${name}-env
    networks:
      - default
`;
    const { sourceDoc, services } = extractServiceCompose(name, composeContent?.trim() ? composeContent : defaultCompose);

    // Discover Dockerfiles and build the final services map
    let finalServices = services;
    const envFilesToWrite = [{ path: path.join(ENVS_DIR, `.${name}-env`), content: envContent || '' }];

    if (uploadedCount > 0) {
      const dockerfileContexts = await findDockerfileContexts(serviceDir);

      if (dockerfileContexts.length > 1) {
        // Multiple Dockerfiles — generate one service per Dockerfile named {name}-{dirname}
        const templateSvc = Object.values(services)[0] || {};
        finalServices = {};
        for (const ctx of dockerfileContexts) {
          const dirName = path.basename(ctx.dir);
          const svcName = `${name}-${dirName}`;
          const buildContextRel = './' + path.relative(SERVER_ROOT, ctx.dir).replace(/\\/g, '/');
          finalServices[svcName] = {
            build: buildContextRel,
            container_name: svcName,
            restart: templateSvc.restart || 'unless-stopped',
            networks: templateSvc.networks || ['default'],
            env_file: [`./envs/.${name}-env`],
          };
        }
      } else if (dockerfileContexts.length === 1) {
        // Single Dockerfile — patch whichever service has a build directive
        const chosen = dockerfileContexts[0];
        const buildContextRel = './' + path.relative(SERVER_ROOT, chosen.dir).replace(/\\/g, '/');
        for (const svc of Object.values(finalServices)) {
          if (!svc || typeof svc !== 'object') continue;
          if (typeof svc.build === 'string') {
            svc.build = buildContextRel;
          } else if (svc.build && typeof svc.build === 'object') {
            svc.build.context = buildContextRel;
          } else {
            svc.build = buildContextRel;
          }
        }
      }
    }

    // Auto-add nginx for unreferenced directories that contain HTML files
    if (uploadedCount > 0) {
      const staticDirs = await findStaticDirs(serviceDir, finalServices);
      for (const { name: dirName, dir } of staticDirs) {
        const svcName = `${name}-${dirName}`;
        finalServices[svcName] = {
          image: 'nginx:alpine',
          container_name: svcName,
          volumes: [`./${path.relative(SERVER_ROOT, dir).replace(/\\/g, '/')}:/usr/share/nginx/html:ro`],
          restart: 'unless-stopped',
          networks: ['default'],
        };
      }
    }

    // Generate Caddy block from the final service map (overrides user-provided when files were uploaded)
    const effectiveCaddy = uploadedCount > 0
      ? generateSmartCaddy(name, finalServices)
      : (caddyContent?.trim() || generateSmartCaddy(name, finalServices));

    const auditWarnings = uploadedCount > 0
      ? await auditServiceDirectory(serviceDir, finalServices, SERVER_ROOT)
      : [];

    await appendComposeServices(finalServices, sourceDoc);

    await fs.mkdir(ENVS_DIR, { recursive: true });
    for (const envFile of envFilesToWrite) {
      await fs.writeFile(envFile.path, envFile.content, 'utf-8');
    }

    let caddyAdded = false;
    if (effectiveCaddy) {
      caddyAdded = await appendCaddyBlock(effectiveCaddy);
    }

    const baseMsg = `Service "${name}" added to ${MAIN_COMPOSE}${caddyAdded ? ` and ${CADDYFILE}` : ''}. Directory: ${serviceDir}${uploadedCount ? `. Uploaded files: ${uploadedCount}` : ''}`;
    res.json({
      success: true,
      output: auditWarnings.length
        ? `${baseMsg}\n\nWarnings:\n${auditWarnings.map(w => `• ${w}`).join('\n')}`
        : baseMsg,
      warnings: auditWarnings,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Service action helper — streams command output live to the client
async function serviceAction(req, res, action, timeout = 120000) {
  const { name } = req.params;
  try {
    if (!isSafeName(name)) throw new Error('Invalid service name.');

    // Fail fast with a useful message instead of leaking a raw socket error
    // when the host has no docker yet or the daemon is stopped.
    const docker = await getDockerStatus();
    if (!docker.running) {
      throw new Error(
        docker.installed
          ? "Docker is installed but the daemon isn't running. Start it with: sudo systemctl start docker"
          : "Docker is not installed on this server. Install it (e.g. https://get.docker.com) then 'sudo systemctl restart dashboard-agent'."
      );
    }

    const related = await getRelatedServiceNames(name);
    let cmd;
    if (related.length > 1) {
      cmd = buildCmd(action, MAIN_COMPOSE, related);
    } else {
      const { file, service } = await getComposeArgs(name);
      cmd = buildCmd(action, file, service);
    }
    if (!cmd) throw new Error(`Unknown action "${action}".`);
    streamCommand(res, cmd, action, timeout);
  } catch (err) {
    res.json({ success: false, error: err.error || err.message, output: err.stderr || '' });
  }
}

app.delete('/api/services/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  const deleteFiles = req.query.deleteFiles === 'true';
  if (!isSafeName(name)) return res.json({ success: false, error: 'Invalid service name.' });

  const msgs = [];

  // Collect the service and all {name}-* siblings
  const relatedNames = await getRelatedServiceNames(name);

  // 1. Stop + remove containers for all related services
  for (const svcName of relatedNames) {
    try {
      const { file, service } = await getComposeArgs(svcName);
      const cmd = `docker compose -f ${shQuote(file)} rm -sf${service ? ` ${shQuote(service)}` : ''}`;
      const { stdout, stderr } = await execCmd(cmd, 60000);
      msgs.push(`Stopped/removed "${svcName}": ${(stdout + stderr).trim() || 'ok'}`);
    } catch (e) { msgs.push(`Warn (container ${svcName}): ${e.error || e.message}`); }
  }

  // 2. Remove all related services from docker-compose.yml
  for (const svcName of relatedNames) {
    try {
      const mainServices = await getMainComposeServices();
      const composeService = getComposeServiceForDirectory(svcName, mainServices);
      if (composeService) {
        const content = await readTextIfExists(MAIN_COMPOSE);
        const lines = content.replace(/\r\n/g, '\n').split('\n');
        const range = getTopLevelBlockRange(lines, 'services');
        if (range) {
          const svcStart = lines.findIndex((l, i) =>
            i > range.start && i < range.end &&
            new RegExp(`^  ${escapeRegex(composeService.name)}:\\s*(#.*)?$`).test(l)
          );
          if (svcStart !== -1) {
            let svcEnd = range.end;
            for (let i = svcStart + 1; i < range.end; i++) {
              if (/^  [A-Za-z0-9_.-]+:\s*(#.*)?$/.test(lines[i])) { svcEnd = i; break; }
            }
            lines.splice(svcStart, svcEnd - svcStart);
            const next = lines.join('\n').replace(/\n{3,}/g, '\n\n');
            await fs.writeFile(MAIN_COMPOSE, next.endsWith('\n') ? next : `${next}\n`, 'utf-8');
            msgs.push(`Removed "${composeService.name}" from docker-compose.yml`);
          }
        }
      }
    } catch (e) { msgs.push(`Warn (compose ${svcName}): ${e.message}`); }
  }

  // 3. Remove Caddy blocks
  try {
    const { content, matches } = await getCaddyBlocksForService(name);
    if (matches.length > 0) {
      const first = matches[0], last = matches[matches.length - 1];
      const next = (content.slice(0, first.start).trimEnd() + '\n\n' + content.slice(last.end).trimStart()).trimEnd() + '\n';
      await fs.writeFile(CADDYFILE, next, 'utf-8');
      msgs.push(`Removed Caddy block(s) for "${name}"`);
    }
  } catch (e) { msgs.push(`Warn (caddy): ${e.message}`); }

  // 4. Delete env file
  try {
    const envPath = await findEnvPath(name);
    await fs.unlink(envPath);
    msgs.push(`Deleted ${envPath}`);
  } catch (e) { if (e.code !== 'ENOENT') msgs.push(`Warn (env): ${e.message}`); }

  // 5. Optionally delete service directory
  if (deleteFiles) {
    try {
      const serviceDir = path.join(SERVICES_DIR, name);
      await fs.rm(serviceDir, { recursive: true, force: true });
      msgs.push(`Deleted ${serviceDir}`);
    } catch (e) { msgs.push(`Warn (files): ${e.message}`); }
  }

  res.json({ success: true, output: msgs.join('\n') });
});

app.post('/api/services/:name/start',   (req, res) => serviceAction(req, res, 'start'));
app.post('/api/services/:name/stop',    (req, res) => serviceAction(req, res, 'stop'));
app.post('/api/services/:name/restart', (req, res) => serviceAction(req, res, 'restart'));
app.post('/api/services/:name/rebuild', (req, res) => serviceAction(req, res, 'rebuild', 300000));
app.post('/api/services/:name/pull',    (req, res) => serviceAction(req, res, 'pull',    300000));

// ─── Caddy ───────────────────────────────────────────────────────────────────

app.get('/api/caddy', async (req, res) => {
  try {
    const content = await fs.readFile(CADDYFILE, 'utf-8');
    res.json({ success: true, content, path: CADDYFILE });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ success: true, content: '', path: CADDYFILE });
    res.json({ success: false, error: err.message });
  }
});

app.put('/api/caddy', async (req, res) => {
  const { content } = req.body;
  try {
    await fs.writeFile(CADDYFILE, content, 'utf-8');
    res.json({ success: true, output: `Caddyfile saved.` });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/caddy/reload', async (req, res) => {
  try {
    const { stdout, stderr } = await execCmd(
      'docker exec caddy caddy reload --config /etc/caddy/Caddyfile', 15000
    );
    res.json({ success: true, output: stdout + stderr || 'Caddy reloaded.' });
  } catch (err) {
    res.json({ success: false, error: err.error || err.message, output: err.stderr || '' });
  }
});

// ─── Compose config ─────────────────────────────────────────────────────────

app.get('/api/compose', async (req, res) => {
  try {
    const content = await fs.readFile(MAIN_COMPOSE, 'utf-8');
    res.json({ success: true, content, path: MAIN_COMPOSE });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ success: true, content: '', path: MAIN_COMPOSE });
    res.json({ success: false, error: err.message });
  }
});

app.put('/api/compose', async (req, res) => {
  const { content } = req.body;
  try {
    YAML.parse(content || '');
    await fs.writeFile(MAIN_COMPOSE, content || '', 'utf-8');
    res.json({ success: true, output: `docker-compose.yml saved.` });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── System ──────────────────────────────────────────────────────────────────

app.get('/api/system', async (req, res) => {
  const results = await Promise.allSettled([
    execCmd('df -BM /'),
    execCmd('free -b'),
    execCmd('hostname'),
  ]);

  const uptime = await getSystemUptime();

  let disk = { total: '?', used: '?', available: '?', percent: 0 };
  if (results[0].status === 'fulfilled') {
    const parts = results[0].value.stdout.trim().split('\n')[1]?.split(/\s+/) || [];
    disk = {
      total: (parts[1] || '?').replace('M', ' MB'),
      used:  (parts[2] || '?').replace('M', ' MB'),
      available: (parts[3] || '?').replace('M', ' MB'),
      percent: parseInt(parts[4]) || 0,
    };
  }

  let memory = { total: 0, used: 0, available: 0, percent: 0, totalHuman: '?', usedHuman: '?', availableHuman: '?' };
  if (results[1].status === 'fulfilled') {
    const parts = results[1].value.stdout.trim().split('\n')[1]?.split(/\s+/) || [];
    const total = parseInt(parts[1]) || 0;
    const used  = parseInt(parts[2]) || 0;
    const avail = parseInt(parts[6]) || parseInt(parts[3]) || 0;
    memory = { total, used, available: avail,
      percent: total ? Math.round((used / total) * 100) : 0,
      totalHuman: formatBytes(total), usedHuman: formatBytes(used), availableHuman: formatBytes(avail),
    };
  }

  const hostname = results[2].status === 'fulfilled' ? results[2].value.stdout.trim() : 'server';
  res.json({ success: true, uptime, disk, memory, hostname });
});

app.get('/api/system/detailed', async (req, res) => {
 try {
  // Host facts via hostExec (SSH-first); docker commands run locally — the
  // host's docker socket is mounted into the container.
  const results = await Promise.allSettled([
    hostExec('uname -r'),
    hostExec('cat /etc/os-release'),
    hostExec('nproc'),
    hostExec("grep 'cpu ' /proc/stat | awk '{u=$2+$4; t=$2+$3+$4+$5} END {printf \"%.1f\", u*100/t}'"),
    hostExec('free -b'),
    hostExec('df -P -k'),
    hostExec('cat /proc/loadavg'),
    hostExec('hostname -I'),
    hostExec('ps aux --sort=-%cpu | head -11 | tail -n +2'),
    execCmd('docker ps -a --format "{{json .}}"'),
    execCmd('docker images --format "{{json .}}"'),
    hostExec('uptime -p'),
    hostExec('hostname'),
    hostExec("cat /proc/cpuinfo | grep 'model name' | head -1 | cut -d: -f2"),
    hostExec('uname -m'),
    execCmd('docker version --format "{{json .}}"'),
    execCmd('docker compose version --short'),
    execCmd('docker network ls --format "{{json .}}"'),
    execCmd('docker volume ls --format "{{json .}}"'),
  ]);

  function val(i) { return results[i].status === 'fulfilled' ? results[i].value.stdout.trim() : ''; }

  const os = {};
  val(1).split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > -1) os[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"|"$/g, '');
  });

  let memory = {};
  const freeLines = val(4).split('\n');
  if (freeLines.length > 1) {
    const p = freeLines[1].split(/\s+/);
    const total = parseInt(p[1]) || 0, used = parseInt(p[2]) || 0;
    const cache = parseInt(p[5]) || 0, avail = parseInt(p[6]) || 0;
    memory = { total, used, cache, avail,
      percent: total ? Math.round((used / total) * 100) : 0,
      totalHuman: formatBytes(total), usedHuman: formatBytes(used),
      cacheHuman: formatBytes(cache), availHuman: formatBytes(avail),
    };
  }

  const disks = parseDfDisks(val(5)).map(d => ({
    source: d.source,
    size:  formatBytes(d.sizeK * 1024),
    used:  formatBytes(d.usedK * 1024),
    avail: formatBytes(d.availK * 1024),
    percent: d.percent,
    mount: d.mount,
  }));

  const loadParts = val(6).split(' ');
  const loadAvg = { '1m': loadParts[0] || '?', '5m': loadParts[1] || '?', '15m': loadParts[2] || '?' };

  let processes = [];
  try {
    if (process.platform === 'win32') {
      processes = await readWindowsProcesses(20);
    } else {
      processes = await readLinuxProcesses(20);
    }
  } catch {
    processes = val(8).split('\n').filter(l => l.trim()).map(line => {
      const p = line.trim().split(/\s+/);
      return { user: p[0], pid: p[1], cpu: p[2], mem: p[3],
        command: p.slice(10).join(' ').replace(/.*\//, '').slice(0, 35) };
    });
  }

  const containers = val(9).split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const images = val(10).split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const running = containers.filter(c => (c.State || '').toLowerCase() === 'running').length;
  const networks = val(17).split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const volumes = val(18).split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let dockerVersion = {};
  try { dockerVersion = JSON.parse(val(15) || '{}'); } catch {}
  const composeServices = Object.keys(await getMainComposeServices()).sort((a, b) => a.localeCompare(b));
  const uptime = await getSystemUptime();
  // Prefer the host's IPs (hostname -I over SSH); fall back to local detection
  let ips = val(7).split(/\s+/).filter(ip => /^(?!127\.)(?!169\.254\.)\d{1,3}(\.\d{1,3}){3}$/.test(ip));
  if (!ips.length) ips = await getServerIps();

  res.json({
    success: true,
    kernel: val(0), os,
    architecture: val(14),
    cpuCores: parseInt(val(2)) || 0,
    cpuUsage: parseFloat(val(3)) || 0,
    cpuModel: val(13).trim(),
    memory, disks, loadAvg,
    ips,
    processes,
    docker: { totalContainers: containers.length, runningContainers: running,
      stoppedContainers: containers.length - running, totalImages: images.length,
      version: dockerVersion, composeVersion: val(16), networks, volumes },
    compose: { path: MAIN_COMPOSE, services: composeServices },
    paths: { serverRoot: SERVER_ROOT, servicesDir: SERVICES_DIR, envsDir: ENVS_DIR, caddyfile: CADDYFILE },
    uptime,
    hostname: val(12),
  });
 } catch (err) {
  res.json({ success: false, error: err.message });
 }
});

// ─── Live stats sampling (local, no SSH needed) ──────────────────────────────
// The dashboard container runs with pid:host, and /proc/stat & /proc/meminfo
// reflect the host, so sampling locally is accurate.
async function sampleLiveStatsLocal(includeDisks = true) {
  const readStat = async () => {
    const txt = await fs.readFile('/proc/stat', 'utf-8');
    const r = {};
    for (const line of txt.split('\n')) {
      if (line.startsWith('cpu')) {
        const p = line.trim().split(/\s+/);
        r[p[0]] = p.slice(1, 8).map(Number);
      }
    }
    return r;
  };
  const readNet = async () => {
    const n = {};
    try {
      const txt = await fs.readFile('/proc/net/dev', 'utf-8');
      for (const line of txt.split('\n').slice(2)) {
        const p = line.trim().split(/\s+/);
        if (p.length >= 10 && p[0]) n[p[0].replace(/:$/, '')] = [parseInt(p[1]) || 0, parseInt(p[9]) || 0];
      }
    } catch {}
    return n;
  };
  const readMem = async () => {
    const m = {};
    const txt = await fs.readFile('/proc/meminfo', 'utf-8');
    for (const line of txt.split('\n')) {
      const i = line.indexOf(':');
      if (i > -1) m[line.slice(0, i).trim()] = parseInt(line.slice(i + 1)) || 0;
    }
    return m;
  };

  const [s1, n1] = await Promise.all([readStat(), readNet()]);
  await new Promise(r => setTimeout(r, 500));
  const [s2, n2, memRaw] = await Promise.all([readStat(), readNet(), readMem()]);

  const cpu = {};
  for (const k of Object.keys(s1)) {
    const v1 = s1[k], v2 = s2[k] || v1;
    const total = v2.reduce((a, b) => a + b, 0) - v1.reduce((a, b) => a + b, 0);
    const idle  = (v2[3] + v2[4]) - (v1[3] + v1[4]);
    cpu[k] = total > 0 ? +((1 - idle / total) * 100).toFixed(1) : 0;
  }

  const net = {};
  for (const k of Object.keys(n1)) {
    if (n2[k]) net[k] = { rx: Math.max(0, n2[k][0] - n1[k][0]) * 2, tx: Math.max(0, n2[k][1] - n1[k][1]) * 2 };
  }

  const totalKb = memRaw.MemTotal || 0;
  const freeKb  = memRaw.MemFree || 0;
  const bufKb   = memRaw.Buffers || 0;
  const cacheKb = (memRaw.Cached || 0) + (memRaw.SReclaimable || 0) - (memRaw.Shmem || 0);
  const mem = {
    total: totalKb,
    used: Math.max(0, totalKb - freeKb - bufKb - Math.max(0, cacheKb)),
    buffers: bufKb,
    cached: Math.max(0, cacheKb),
    avail: memRaw.MemAvailable || 0,
    free: freeKb,
    swap_total: memRaw.SwapTotal || 0,
    swap_used: (memRaw.SwapTotal || 0) - (memRaw.SwapFree || 0),
  };

  // Disks: the container only sees its own mounts, so ask the HOST over SSH
  // first (shows every real mounted filesystem); fall back to local df.
  // Skipped for background history sampling (no SSH round-trip every tick).
  let dfOut = '';
  if (includeDisks) {
    try { dfOut = await sshExec('df -P -k', 8000); } catch {}
    if (!dfOut.trim()) {
      try { ({ stdout: dfOut } = await execCmd('df -P -k', 10000)); } catch {}
    }
  }

  const disks = parseDfDisks(dfOut).map(d => ({
    source: d.source,
    size:  formatBytes(d.sizeK * 1024),
    used:  formatBytes(d.usedK * 1024),
    avail: formatBytes(d.availK * 1024),
    percent: d.percent,
    mount: d.mount,
  }));

  return { cpu, mem, net, disks };
}

// btop-style live stats: two-sample CPU (accurate %), per-core, memory breakdown, net I/O rates.
// Reads /proc locally first; falls back to SSH (python sampler on the host) only if local reads fail.
app.get('/api/system/live', async (req, res) => {
  let localErr;
  try {
    const data = await sampleLiveStatsLocal();
    return res.json({ success: true, source: 'local', ...data });
  } catch (err) {
    localErr = err;
  }

  const pyScript = `
import json, time

def read_stat():
    r = {}
    with open('/proc/stat') as f:
        for line in f:
            if line.startswith('cpu'):
                p = line.split()
                r[p[0]] = list(map(int, p[1:8]))
    return r

def read_net():
    n = {}
    try:
        with open('/proc/net/dev') as f:
            for line in f.readlines()[2:]:
                p = line.split()
                if len(p) >= 10:
                    n[p[0].rstrip(':')] = [int(p[1]), int(p[9])]
    except: pass
    return n

def read_mem():
    m = {}
    with open('/proc/meminfo') as f:
        for line in f:
            k, v = line.split(':', 1)
            m[k.strip()] = int(v.strip().split()[0])
    return m

s1, n1 = read_stat(), read_net()
time.sleep(0.5)
s2, n2 = read_stat(), read_net()
mem = read_mem()

cpu = {}
for k in s1:
    v1, v2 = s1[k], s2.get(k, s1[k])
    total = sum(v2) - sum(v1)
    idle  = (v2[3]+v2[4]) - (v1[3]+v1[4])
    cpu[k] = round((1 - idle/total)*100, 1) if total > 0 else 0.0

net = {}
for k in n1:
    if k in n2:
        net[k] = {'rx': max(0, n2[k][0]-n1[k][0])*2, 'tx': max(0, n2[k][1]-n1[k][1])*2}

total_kb  = mem.get('MemTotal', 0)
free_kb   = mem.get('MemFree', 0)
buf_kb    = mem.get('Buffers', 0)
cache_kb  = mem.get('Cached', 0) + mem.get('SReclaimable', 0) - mem.get('Shmem', 0)
avail_kb  = mem.get('MemAvailable', 0)
used_kb   = total_kb - free_kb - buf_kb - max(0, cache_kb)

print(json.dumps({
    'cpu': cpu,
    'mem': {'total': total_kb, 'used': max(0,used_kb), 'buffers': buf_kb,
            'cached': max(0,cache_kb), 'avail': avail_kb, 'free': free_kb,
            'swap_total': mem.get('SwapTotal',0), 'swap_used': mem.get('SwapTotal',0)-mem.get('SwapFree',0)},
    'net': net
}))
`.trim();

  try {
    const b64 = Buffer.from(pyScript).toString('base64');
    const output = await sshExec(`python3 -c "import base64,sys; exec(base64.b64decode('${b64}').decode())"`, 6000);
    const data = JSON.parse(output.trim());
    res.json({ success: true, source: 'ssh', ...data });
  } catch (err) {
    res.json({ success: false, error: `Local sampling failed (${localErr?.message}); SSH fallback failed (${err.message}).` });
  }
});

// ── Background stats collection ──────────────────────────────────────────────
// Sampled continuously from server start, independent of any open browser —
// page reloads never restart stat collection. ~300 points @5s ≈ 25 minutes.
const STATS_SAMPLE_MS  = parseInt(process.env.STATS_SAMPLE_MS) || 5000;
const STATS_HISTORY_MAX = 300;
const statsHistory = [];
let _statsSampling = false;

async function collectStatsSample() {
  if (_statsSampling) return;
  _statsSampling = true;
  try {
    const live = await sampleLiveStatsLocal(false); // no disk lookup per tick
    let containers = [];
    try {
      const { stdout } = await execCmd('docker stats --no-stream --format "{{json .}}"', 15000);
      containers = stdout.trim().split('\n').filter(l => l.trim()).map(l => {
        try {
          const s = JSON.parse(l);
          return { name: s.Name, cpu: parseFloat(s.CPUPerc) || 0, memPerc: parseFloat(s.MemPerc) || 0 };
        } catch { return null; }
      }).filter(Boolean);
    } catch {}
    statsHistory.push({ ts: Date.now(), cpu: live.cpu, mem: live.mem, net: live.net, containers });
    if (statsHistory.length > STATS_HISTORY_MAX) statsHistory.shift();
  } catch {}
  finally { _statsSampling = false; }
}
setInterval(collectStatsSample, STATS_SAMPLE_MS);
collectStatsSample();

// GET /api/system/history — seed for the stats page charts
app.get('/api/system/history', (req, res) => {
  res.json({ success: true, intervalMs: STATS_SAMPLE_MS, points: statsHistory });
});

app.get('/api/system/container-stats', async (req, res) => {
  try {
    const { stdout } = await execCmd('docker stats --no-stream --format "{{json .}}"', 20000);
    const stats = stdout.trim().split('\n').filter(l => l.trim()).map(l => {
      try {
        const s = JSON.parse(l);
        return {
          name:     s.Name,
          cpu:      parseFloat(s.CPUPerc)  || 0,
          memPerc:  parseFloat(s.MemPerc)  || 0,
          mem:      s.MemUsage || '',
          netIO:    s.NetIO    || '',
          blockIO:  s.BlockIO  || '',
        };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ success: true, stats });
  } catch (err) {
    res.json({ success: false, error: err.message, stats: [] });
  }
});

app.get('/api/system/processes', async (req, res) => {
  try {
    let processes = [];
    if (process.platform === 'win32') {
      processes = await readWindowsProcesses(150);
    } else {
      processes = await readLinuxProcesses(150);
    }
    res.json({ success: true, processes });
  } catch (err) {
    res.json({ success: false, error: err.error || err.message, output: err.stderr || '' });
  }
});

app.post('/api/system/containers/:id/:action', async (req, res) => {
  const id = String(req.params.id || '');
  const action = String(req.params.action || '');
  const allowed = new Set(['start', 'stop', 'restart', 'kill']);
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) return res.json({ success: false, error: 'Invalid container id.' });
  if (!allowed.has(action)) return res.json({ success: false, error: 'Invalid container action.' });

  try {
    const { stdout, stderr } = await execCmd(`docker ${action} ${shQuote(id)}`, 120000);
    res.json({ success: true, output: stdout + stderr || `${action} sent to ${id}.` });
  } catch (err) {
    res.json({ success: false, error: err.error || err.message, output: err.stderr || '' });
  }
});

app.post('/api/system/console', async (req, res) => {
  const command = String(req.body?.command || '').trim();
  const cwd = req.body?.cwd ? resolveServerPath(req.body.cwd) : SERVER_ROOT;
  if (!command) return res.json({ success: false, error: 'Command is required.' });

  try {
    const resolvedCwd = path.resolve(cwd || SERVER_ROOT);
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      exec(command, {
        cwd: resolvedCwd,
        maxBuffer: 20 * 1024 * 1024,
        timeout: 300000,
        env: process.env,
      }, (error, stdout, stderr) => {
        if (error) reject({ error: error.message, stderr, stdout, code: error.code });
        else resolve({ stdout, stderr });
      });
    });
    res.json({ success: true, output: stdout + stderr, cwd: resolvedCwd });
  } catch (err) {
    res.json({
      success: false,
      error: err.error || err.message,
      output: `${err.stdout || ''}${err.stderr || ''}`,
      cwd,
    });
  }
});

app.post('/api/system/processes/:pid/signal', async (req, res) => {
  const pid = String(req.params.pid || '');
  const signal = String(req.body?.signal || 'TERM').toUpperCase();
  const allowed = new Set(['TERM', 'KILL', 'HUP', 'STOP', 'CONT']);

  if (!/^\d+$/.test(pid)) return res.json({ success: false, error: 'Invalid process id.' });
  if (!allowed.has(signal)) return res.json({ success: false, error: 'Invalid signal.' });

  try {
    let cmd = `kill -${signal} ${pid}`;
    if (process.platform === 'win32') {
      if (!['TERM', 'KILL'].includes(signal)) {
        return res.json({ success: false, error: `${signal} is not supported on Windows.` });
      }
      const force = signal === 'KILL' ? ' -Force' : '';
      cmd = `powershell -NoProfile -Command "Stop-Process -Id ${pid}${force}"`;
    }
    const { stdout, stderr } = await execCmd(cmd, 15000);
    res.json({ success: true, output: stdout + stderr || `Sent ${signal} to PID ${pid}.` });
  } catch (err) {
    res.json({ success: false, error: err.error || err.message, output: err.stderr || '' });
  }
});

app.post('/api/system/prune', (req, res) => {
  streamCommand(res, 'docker system prune -f', 'prune', 120000);
});

app.post('/api/system/compose/:action', (req, res) => {
  const action = req.params.action;
  const commands = {
    up: `docker compose -f ${shQuote(MAIN_COMPOSE)} up -d`,
    stop: `docker compose -f ${shQuote(MAIN_COMPOSE)} stop`,
    down: `docker compose -f ${shQuote(MAIN_COMPOSE)} down`,
  };
  if (!commands[action]) return res.json({ success: false, error: 'Unknown compose action.' });
  streamCommand(res, commands[action], `compose ${action}`, 300000);
});

app.post('/api/system/pull-all', (req, res) => {
  streamCommand(res, `docker compose -f ${shQuote(MAIN_COMPOSE)} pull 2>&1`, 'pull-all', 300000);
});

app.post('/api/system/restart-all', (req, res) => {
  streamCommand(res, `docker compose -f ${shQuote(MAIN_COMPOSE)} restart 2>&1`, 'restart-all', 300000);
});

if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`Agent local API running on ${BIND_HOST}:${PORT}`);
  console.log(`Server root: ${SERVER_ROOT}  (main compose: ${MAIN_COMPOSE})`);
  if (!fsSync.existsSync(MAIN_COMPOSE)) {
    console.log(`  note: no compose file at ${MAIN_COMPOSE} — dashboard will show no services until SERVER_ROOT points at the right directory.`);
    console.log(`  fix: sudo systemctl edit dashboard-agent  → add  Environment=SERVER_ROOT=/path/to/your/compose/dir`);
  }
});

// ─── WebSocket terminal (ssh2 — no system SSH binary needed) ─────────────────
let sshLib;
try { sshLib = require('ssh2'); } catch { sshLib = null; }

const wss = new WebSocketServer({ server, path: '/ws/terminal', perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  const send = data => {
    if (ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ type: 'output', data }));
  };
  const sendExit = () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit' }));
      ws.close();
    }
  };

  // Input/resize are wired up once; the chosen session installs the handlers.
  // The frontend sends its real size as soon as the socket opens — remember it
  // so the shell is created with matching dimensions (fixes overlapping
  // redraws when using arrow-key history on a mis-sized PTY).
  let pendingSize = null;
  let onInput  = null;
  let onResize = null;
  let onClose  = null;

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input' && onInput) onInput(msg.data);
      if (msg.type === 'resize') {
        pendingSize = { rows: parseInt(msg.rows) || 24, cols: parseInt(msg.cols) || 80 };
        if (onResize) onResize(pendingSize);
      }
    } catch {}
  });
  ws.on('close', () => { try { onClose && onClose(); } catch {} });

  // The terminal is a shell ON the agent itself — the machine you're "connected
  // to" in the dashboard. With the native systemd install the agent runs as
  // root on the host, so spawning a local PTY here gives the operator a real
  // host shell that can see every process and manage the host's docker stack
  // directly — no SSH detour needed.
  //
  // Opt-in SSH fallback (TERMINAL_USE_SSH=true) for setups that really do want
  // to reach a separate host — uses TERMINAL_SSH_HOST/USER/PORT/KEY_PATH.
  const useSsh = process.env.TERMINAL_USE_SSH === 'true';

  if (pty && !useSsh) {
    const shell = process.platform === 'win32'
      ? 'powershell.exe'
      : (fsSync.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
    let proc;
    try {
      proc = pty.spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
        name: 'xterm-256color',
        cols: pendingSize?.cols || 80,
        rows: pendingSize?.rows || 24,
        cwd:  fsSync.existsSync(SERVER_ROOT) ? SERVER_ROOT : process.cwd(),
        env:  { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (err) {
      send(`Failed to start local shell: ${err.message}\r\n`);
      ws.close(); return;
    }

    proc.onData(d => send(d));
    proc.onExit(() => sendExit());

    onInput  = data => proc.write(data);
    onResize = ({ rows, cols }) => { try { proc.resize(cols, rows); } catch {} };
    onClose  = () => { try { proc.kill(); } catch {} };
    return;
  }

  // ── Opt-in SSH fallback ───────────────────────────────────────────────────
  const sshHost    = TERMINAL_SSH_HOST;
  const sshUser    = process.env.TERMINAL_SSH_USER || 'root';
  const sshPort    = parseInt(process.env.TERMINAL_SSH_PORT) || 22;
  const privateKey = sshHost && sshLib ? findSshKey() : null;

  if (useSsh && sshHost && sshLib && privateKey) {
    const conn = new sshLib.Client();
    let stream = null;
    let chosenHost = sshHost;

    conn.on('ready', () => {
      conn.shell({
        term: 'xterm-256color',
        rows: pendingSize?.rows || 24,
        cols: pendingSize?.cols || 80,
      }, (err, sh) => {
        if (err) { send(`Shell error: ${err.message}\r\n`); ws.close(); return; }
        stream = sh;
        if (pendingSize) { try { sh.setWindow(pendingSize.rows, pendingSize.cols, 0, 0); } catch {} }
        sh.on('data',        d => send(d.toString()));
        sh.stderr.on('data', d => send(d.toString()));
        sh.on('close', () => { sendExit(); conn.end(); });
      });
    });

    conn.on('error', err => {
      send(`SSH connection error (${sshUser}@${chosenHost}:${sshPort}): ${err.message}\r\n`);
      ws.close();
    });

    onInput  = data => { if (stream) stream.write(data); };
    onResize = ({ rows, cols }) => { if (stream) { try { stream.setWindow(rows, cols, 0, 0); } catch {} } };
    onClose  = () => { try { stream && stream.end(); conn.end(); } catch {} };

    resolveSshHost().then(host => {
      chosenHost = host;
      conn.connect({ host, port: sshPort, username: sshUser, privateKey, readyTimeout: 15000 });
    }).catch(err => {
      send(`SSH error: ${err.message}\r\n`);
      ws.close();
    });
    return;
  }

  // ── Nothing available — explain why ─────────────────────────────────────────
  if (!pty) {
    send('Local terminal unavailable: @homebridge/node-pty-prebuilt-multiarch is not installed in the agent.\r\n' +
         'Rebuild the agent image, or set TERMINAL_USE_SSH=true + TERMINAL_SSH_HOST to fall back to SSH.\r\n');
  } else if (useSsh && !sshLib) {
    send('TERMINAL_USE_SSH is set but the ssh2 module is not installed.\r\n');
  } else if (useSsh && !sshHost) {
    send('TERMINAL_USE_SSH is set but TERMINAL_SSH_HOST is empty.\r\n');
  } else if (useSsh && !privateKey) {
    send(`Cannot read an SSH private key for ${sshUser}@${sshHost} (checked TERMINAL_SSH_KEY_PATH, $HOME/.ssh/, and ${SERVER_ROOT}/.ssh/ for id_rsa / id_ed25519 / id_ecdsa).\r\n`);
  } else {
    send('No terminal backend available.\r\n');
  }
  ws.close();
});
