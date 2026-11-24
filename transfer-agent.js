'use strict';
// Agent side of the service transfer engine.
//
// Only the hub drives these endpoints, through the authenticated tunnel; the
// hub refuses to proxy /api/transfer/* for dashboard users. The agent still
// enforces its own policy: each direction can be disabled with
// AGENT_TRANSFER_EXPORT=false / AGENT_TRANSFER_IMPORT=false, every name is
// validated, and every filesystem path is derived locally — nothing path-like
// is taken from the request.
//
// SOURCE:       inspect → export (lock, stop, verify stopped, pack) → chunk* → finish | restore
// DESTINATION:  check → receive/init → receive/chunk* → receive/verify → install → start → finish | rollback
//
// Safety properties
//  • A per-service lock (created with O_EXCL) is held from export/receive until
//    finish/restore/rollback. While it is held the dashboard cannot start,
//    edit or delete the service (server.js consults isLocked()).
//  • The source service is stopped — and verified stopped — before its data is
//    packed. It is only ever restarted by restore and never deleted here.
//  • The bundle is verified end to end (sha256 per chunk and overall) and every
//    extracted file is verified against the manifest before anything is
//    installed.
//  • Every install step is journalled before the next one runs; rollback
//    undoes exactly the journalled steps, so pre-existing data is never
//    touched. Rollback, restore and finish are idempotent.
//  • Env file contents never appear in responses, job status or logs.

const fsSync = require('fs');
const fs = fsSync.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const tar = require('tar');

const PROTOCOL_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHUNK = 4 * 1024 * 1024;
const FILE_BASENAME_RE = /^[A-Za-z0-9_.][A-Za-z0-9._-]{0,127}$/;
const HEALTH_TIMEOUT_MS = parseInt(process.env.AGENT_TRANSFER_HEALTH_TIMEOUT_MS, 10) || 120_000;
const HEALTH_POLL_MS = parseInt(process.env.AGENT_TRANSFER_HEALTH_POLL_MS, 10) || 2_000;
const HEALTH_STABLE_POLLS = 3;

class TransferError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new TransferError(status, message); };

const sha256Buf = b => crypto.createHash('sha256').update(b).digest('hex');
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    fsSync.createReadStream(file)
      .on('data', d => { h.update(d); size += d.length; })
      .on('error', reject)
      .on('end', () => resolve({ sha256: h.digest('hex'), size }));
  });
}

async function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

const exists = p => { try { fsSync.lstatSync(p); return true; } catch { return false; } };
const isDir = p => { try { return fsSync.statSync(p).isDirectory(); } catch { return false; } };
const toPosix = p => p.split(path.sep).join('/');

// Walk a directory tree (never following symlinks).
async function walkTree(root, { hash = true } = {}) {
  const out = { files: [], symlinks: [], dirs: [], totalBytes: 0 };
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = toPosix(path.relative(root, full));
      const st = await fs.lstat(full);
      if (st.isSymbolicLink()) {
        out.symlinks.push({ path: rel, target: await fs.readlink(full) });
      } else if (st.isDirectory()) {
        out.dirs.push({ path: rel, mode: st.mode & 0o7777 });
        await walk(full);
      } else if (st.isFile()) {
        const entry = { path: rel, size: st.size, mode: st.mode & 0o7777 };
        if (hash) entry.sha256 = (await sha256File(full)).sha256;
        out.files.push(entry);
        out.totalBytes += st.size;
      }
    }
  }
  await walk(root);
  out.files.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function parseVolume(v) {
  if (typeof v === 'string') {
    const parts = v.split(':');
    if (parts.length === 1) return { type: 'anonymous', target: parts[0] };
    const [source, target, mode] = parts;
    return { type: /^[./~]/.test(source) ? 'bind' : 'volume', source, target, mode: mode || null };
  }
  if (v && typeof v === 'object') {
    return { type: v.type === 'bind' ? 'bind' : v.type === 'tmpfs' ? 'tmpfs' : 'volume', source: v.source, target: v.target, long: true };
  }
  return null;
}

function expandRange(s) {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(String(s));
  if (!m) return [];
  const a = +m[1], b = m[2] ? +m[2] : a;
  if (b < a || b - a > 1000) return [a];
  const r = [];
  for (let i = a; i <= b; i++) r.push(i);
  return r;
}

// Host-published ports of a compose service: [{ port, protocol }]
function hostPorts(ports) {
  const out = [];
  for (const p of Array.isArray(ports) ? ports : []) {
    if (typeof p === 'string' || typeof p === 'number') {
      let s = String(p);
      let protocol = 'tcp';
      const slash = s.indexOf('/');
      if (slash >= 0) { protocol = s.slice(slash + 1) || 'tcp'; s = s.slice(0, slash); }
      const parts = s.split(':');
      if (parts.length < 2) continue; // container-only port → ephemeral host port
      const hostPart = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
      for (const port of expandRange(hostPart)) out.push({ port, protocol });
    } else if (p && typeof p === 'object' && p.published != null) {
      for (const port of expandRange(p.published)) out.push({ port, protocol: p.protocol || 'tcp' });
    }
  }
  return out;
}

function envKeys(env) {
  if (Array.isArray(env)) return env.map(e => String(e).split('=')[0]).filter(Boolean).slice(0, 200);
  if (env && typeof env === 'object') return Object.keys(env).slice(0, 200);
  return [];
}

function networkNames(nets) {
  if (Array.isArray(nets)) return nets.map(String);
  if (nets && typeof nets === 'object') return Object.keys(nets);
  return [];
}

// Other compose services a service cannot run without.
function serviceDependencies(def) {
  if (!def || typeof def !== 'object') return [];
  const out = new Set();
  const dep = def.depends_on;
  if (Array.isArray(dep)) dep.forEach(d => out.add(String(d)));
  else if (dep && typeof dep === 'object') Object.keys(dep).forEach(d => out.add(d));
  for (const l of Array.isArray(def.links) ? def.links : []) out.add(String(l).split(':')[0]);
  for (const v of Array.isArray(def.volumes_from) ? def.volumes_from : []) {
    const s = String(v);
    if (!s.startsWith('container:')) out.add(s.split(':')[0]);
  }
  if (typeof def.network_mode === 'string' && def.network_mode.startsWith('service:')) out.add(def.network_mode.slice(8));
  return [...out].filter(Boolean);
}

// Extend the service group with everything it depends on (transitively), so
// e.g. "chat-backend → chat-db" moves together. A dependency that services
// OUTSIDE the group also need cannot be moved without breaking them, and a
// dependency missing from the compose file is already broken: both are
// reported as blockers instead of producing an invalid destination project.
function withDependencies(group, services) {
  const included = new Set(group);
  const blockers = [];
  const queue = [...group];
  while (queue.length) {
    const svc = queue.shift();
    for (const d of serviceDependencies(services[svc])) {
      if (included.has(d)) continue;
      if (!Object.prototype.hasOwnProperty.call(services, d)) {
        blockers.push(`"${svc}" depends on "${d}", which is not defined in the compose file.`);
        continue;
      }
      included.add(d);
      queue.push(d);
    }
  }
  for (const d of included) {
    if (group.includes(d)) continue;
    const others = Object.keys(services).filter(s => !included.has(s) && serviceDependencies(services[s]).includes(d));
    if (others.length) {
      blockers.push(`"${d}" is needed by this service but is also used by ${others.map(o => `"${o}"`).join(', ')}; moving it would break them.`);
    }
  }
  return { related: [...included], blockers };
}

// Ports with a listening socket on this host (Linux /proc; empty elsewhere).
function listeningPorts() {
  const set = new Set();
  const read = (file, proto, state) => {
    let text;
    try { text = fsSync.readFileSync(file, 'utf-8'); } catch { return; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== state) continue;
      const port = parseInt(cols[1].split(':').pop(), 16);
      if (port) set.add(`${port}/${proto}`);
    }
  };
  read('/proc/net/tcp', 'tcp', '0A');
  read('/proc/net/tcp6', 'tcp', '0A');
  read('/proc/net/udp', 'udp', '07');
  read('/proc/net/udp6', 'udp', '07');
  return set;
}

function linuxArchToDocker(a) {
  return ({ x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386', ppc64: 'ppc64le', s390x: 's390x' })[a] || a;
}

function register(app, ctx) {
  const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, 'data');
  const ROOT = path.join(DATA_DIR, 'transfers');
  const LOCK_DIR = path.join(ROOT, 'locks');
  fsSync.mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
  try { fsSync.chmodSync(ROOT, 0o700); } catch {}

  const allowExport = () => process.env.AGENT_TRANSFER_EXPORT !== 'false';
  const allowImport = () => process.env.AGENT_TRANSFER_IMPORT !== 'false';
  const D = ctx.DOCKER;
  const q = ctx.shQuote;

  // ─── Locks ─────────────────────────────────────────────────────────────────
  const locks = new Map(); // service -> lock record
  for (const f of fsSync.readdirSync(LOCK_DIR)) {
    if (!f.endsWith('.lock')) continue;
    try { const l = JSON.parse(fsSync.readFileSync(path.join(LOCK_DIR, f), 'utf-8')); if (l && l.service) locks.set(l.service, l); } catch {}
  }
  const lockFile = service => path.join(LOCK_DIR, `${service}.lock`);

  function acquireLock(service, transferId, role, relatedServices) {
    const existing = locks.get(service);
    if (existing) {
      if (existing.transferId === transferId && existing.role === role) return existing;
      fail(409, `"${service}" is already part of another transfer on this server.`);
    }
    for (const l of locks.values()) {
      if ((l.relatedServices || []).some(s => relatedServices.includes(s))) fail(409, `A related service of "${service}" is already part of another transfer.`);
    }
    const rec = { service, transferId, role, relatedServices, at: new Date().toISOString() };
    try {
      fsSync.writeFileSync(lockFile(service), JSON.stringify(rec), { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err.code === 'EEXIST') fail(409, `"${service}" is already part of another transfer on this server.`);
      throw err;
    }
    locks.set(service, rec);
    return rec;
  }

  function releaseLock(service, transferId) {
    const l = locks.get(service);
    if (!l || l.transferId !== transferId) return;
    try { fsSync.unlinkSync(lockFile(service)); } catch {}
    locks.delete(service);
  }

  function isLocked(name) {
    for (const l of locks.values()) if (l.service === name || (l.relatedServices || []).includes(name)) return true;
    return false;
  }

  // ─── Jobs ──────────────────────────────────────────────────────────────────
  const jobs = new Map();
  const jobDir = id => path.join(ROOT, id);
  const jobFile = id => path.join(jobDir(id), 'job.json');
  const journalFile = id => path.join(jobDir(id), 'journal.json');

  function validId(id) { if (!UUID_RE.test(String(id || ''))) fail(400, 'Invalid transfer id.'); return String(id).toLowerCase(); }
  function validService(name) { if (!ctx.isSafeName(name)) fail(400, 'Invalid service name.'); return name; }

  async function saveJob(job) {
    job.updatedAt = new Date().toISOString();
    await fs.mkdir(jobDir(job.id), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(jobFile(job.id), job);
  }

  function loadJob(id) {
    if (jobs.has(id)) return jobs.get(id);
    try {
      const job = JSON.parse(fsSync.readFileSync(jobFile(id), 'utf-8'));
      // A job left "running" by a previous agent process can never finish.
      if (job.status === 'running' && job.pid !== process.pid) { job.status = 'interrupted'; job.error = 'The agent restarted while this step was running.'; }
      jobs.set(id, job);
      return job;
    } catch { return null; }
  }

  function requireJob(id, role) {
    const job = loadJob(id);
    if (!job || job.role !== role) fail(404, 'Unknown transfer on this server.');
    return job;
  }

  async function loadJournal(id) {
    try { return JSON.parse(await fs.readFile(journalFile(id), 'utf-8')); } catch { return null; }
  }

  function publicJob(job) {
    if (!job) return null;
    const { id, role, service, stage, status, error, warnings, bundle, stopped, wasRunning, verified, received, health, caddyReloaded, updatedAt } = job;
    return { id, role, service, stage, status, error: error || null, warnings: warnings || [], bundle: bundle || null, stopped: stopped || [], wasRunning: !!wasRunning, verified: !!verified, received: received ?? null, health: health || null, caddyReloaded: !!caddyReloaded, updatedAt };
  }

  // Run a job step in the background; failures are recorded on the job.
  function runInBackground(job, fn) {
    job.status = 'running';
    job.pid = process.pid;
    job.error = null;
    jobs.set(job.id, job);
    saveJob(job).then(() => fn(job)).then(
      () => { job.status = 'done'; return saveJob(job); },
      err => {
        job.status = 'failed';
        job.error = err instanceof TransferError || (err && err.expose) ? err.message : `${job.stage} failed: ${err && err.message ? err.message.slice(0, 300) : 'unknown error'}`;
        console.error(`[agent][transfer ${job.id.slice(0, 8)}] ${job.stage} failed: ${err && err.message}`);
        return saveJob(job);
      }
    ).catch(err => console.error('[agent][transfer] could not persist job state:', err.message));
  }

  // Run a docker command with optional stdin/stdout files (for docker cp).
  function dockerStream(args, { stdinFile, stdoutFile, timeoutMs = 30 * 60_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(`${D} ${args}`, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('docker command timed out')); }, timeoutMs);
      child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d; });
      if (stdoutFile) child.stdout.pipe(fsSync.createWriteStream(stdoutFile, { mode: 0o600 }));
      else child.stdout.resume();
      if (stdinFile) fsSync.createReadStream(stdinFile).pipe(child.stdin);
      else child.stdin.end();
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`docker exited with code ${code}: ${stderr.trim().split('\n').slice(-1)[0] || ''}`));
      });
    });
  }

  async function dockerLines(args, timeout = 30_000) {
    const { stdout } = await ctx.execCmd(`${D} ${args}`, timeout);
    return String(stdout).split('\n').map(s => s.trim()).filter(Boolean);
  }

  async function runningCaddy() {
    const doc = await ctx.readComposeDoc();
    const volumes = doc.services?.caddy?.volumes;
    if (!Array.isArray(volumes)) fail(409, 'The destination main Compose file has no Caddy service with a Caddyfile mount.');
    const mount = volumes.map(v => {
      if (typeof v === 'string') return /^(.+):\/etc\/caddy\/Caddyfile(?::[^:]*)?$/.exec(v)?.[1];
      return v?.target === '/etc/caddy/Caddyfile' ? v.source : null;
    }).find(Boolean);
    if (!mount || !/^(?:\.|\/)/.test(mount)) fail(409, 'Caddy must mount the selected host Caddyfile at /etc/caddy/Caddyfile.');
    const selected = await fs.realpath(ctx.CADDYFILE).catch(() => path.resolve(ctx.CADDYFILE));
    const mounted = await fs.realpath(path.resolve(path.dirname(ctx.MAIN_COMPOSE), mount))
      .catch(() => path.resolve(path.dirname(ctx.MAIN_COMPOSE), mount));
    if (selected !== mounted) fail(409, 'The selected Caddyfile is not the one mounted by the destination Caddy service.');
    const caddy = ctx.findContainerForService(await ctx.listDockerContainers(), 'caddy');
    if (!caddy || ctx.getContainerStatus(caddy) !== 'running') fail(409, 'Caddy is not running in the destination main Compose project.');
    return caddy.ID;
  }

  async function reloadCaddy() {
    const id = await runningCaddy();
    try {
      await ctx.execCmd(`${D} exec ${q(id)} caddy reload --config /etc/caddy/Caddyfile`, 15_000);
    } catch {
      fail(502, 'Caddy rejected the updated configuration on the destination. Check the Caddyfile and Caddy logs.');
    }
  }

  // ─── Inspection (source) ───────────────────────────────────────────────────
  async function collectSource(service) {
    const doc = await ctx.readComposeDoc();
    const services = doc.services && typeof doc.services === 'object' ? doc.services : {};
    const deps = withDependencies(await ctx.getRelatedServiceNames(service, services), services);
    const related = deps.related;
    const serviceDir = path.join(ctx.SERVICES_DIR, service);
    const dirExists = isDir(serviceDir);
    if (!related.length && !dirExists) fail(404, `Service "${service}" was not found on this server.`);

    const containers = await ctx.listDockerContainers();
    const project = ctx.composeProject;
    let existingVolumes = new Set();
    try { existingVolumes = new Set(await dockerLines('volume ls --format "{{.Name}}"')); } catch {}

    const composeServices = {};
    const volumes = new Map();
    const externalBinds = [];
    const envPaths = new Set();
    const networks = new Set();
    const blockers = [...deps.blockers];

    for (const svc of related) {
      const def = services[svc] && typeof services[svc] === 'object' ? services[svc] : {};
      const container = ctx.findContainerForService(containers, svc)
        || (def.container_name ? ctx.findContainerForService(containers, def.container_name) : null);
      for (const raw of Array.isArray(def.volumes) ? def.volumes : []) {
        const v = parseVolume(raw);
        if (!v) continue;
        if (v.type === 'volume' && v.source) {
          const top = (doc.volumes && doc.volumes[v.source]) || {};
          const actualName = top.name || (project ? `${project}_${v.source}` : v.source);
          if (!volumes.has(v.source)) {
            volumes.set(v.source, {
              name: v.source, external: Boolean(top.external), explicitName: top.name || null,
              actualName, service: svc, target: v.target, containerId: container?.ID || null,
              existsOnSource: existingVolumes.has(actualName),
            });
          }
        } else if (v.type === 'bind') {
          const abs = ctx.resolveServerPath(v.source);
          if (!ctx.pathInside(serviceDir, abs)) externalBinds.push({ service: svc, source: v.source });
        }
      }
      for (const f of [].concat(def.env_file || [])) {
        const p = typeof f === 'string' ? f : f?.path;
        if (p) envPaths.add(path.resolve(ctx.resolveServerPath(p)));
      }
      networkNames(def.networks).forEach(n => networks.add(n));
      const build = typeof def.build === 'string' ? def.build : def.build?.context;
      const externalBuild = build ? !ctx.pathInside(serviceDir, ctx.resolveServerPath(build)) : false;
      if (externalBuild) blockers.push(`Service "${svc}" is built from ${build}, which is outside services/${service}; it cannot be transferred safely.`);
      composeServices[svc] = {
        image: typeof def.image === 'string' ? def.image : null,
        build: Boolean(build),
        ports: hostPorts(def.ports),
        restart: typeof def.restart === 'string' ? def.restart : null,
        containerName: typeof def.container_name === 'string' ? def.container_name : null,
        environmentKeys: envKeys(def.environment),
        networks: networkNames(def.networks),
        state: container ? ctx.getContainerStatus(container) : 'not deployed',
        containerId: container?.ID || null,
      };
    }

    // Conventional env file for directory-only services.
    for (const candidate of [`.${service}-env`, `${service}.env`, `.${service}`]) {
      const p = path.join(ctx.ENVS_DIR, candidate);
      if (exists(p)) { envPaths.add(path.resolve(p)); break; }
    }
    const envFiles = [];
    const seenBase = new Set();
    for (const p of envPaths) {
      if (!exists(p)) continue;
      const basename = path.basename(p);
      if (!FILE_BASENAME_RE.test(basename)) { blockers.push(`Env file ${basename} has an unsupported name.`); continue; }
      if (seenBase.has(basename)) { blockers.push(`Two env files are both named ${basename}; rename one before transferring.`); continue; }
      seenBase.add(basename);
      const st = fsSync.statSync(p);
      envFiles.push({ basename, sourcePath: p, size: st.size, mode: st.mode & 0o777 });
    }

    for (const v of volumes.values()) {
      if (!v.external && v.existsOnSource && !v.containerId) {
        blockers.push(`Volume "${v.name}" holds data but no container for "${v.service}" exists to export it from. Deploy the service once, then retry.`);
      }
    }

    const topLevelNetworks = {};
    for (const n of networks) if (doc.networks && doc.networks[n] !== undefined) topLevelNetworks[n] = doc.networks[n] ?? {};
    const externalNetworks = Object.entries(topLevelNetworks).filter(([, d]) => d && d.external).map(([n, d]) => (d && d.name) || n);

    return { doc, services, related, serviceDir, dirExists, containers, composeServices, volumes, externalBinds, envFiles, topLevelNetworks, externalNetworks, blockers };
  }

  async function imageInfo(image) {
    try {
      const [line] = await dockerLines(`image inspect --format "{{.Architecture}}|{{.Os}}|{{len .RepoDigests}}" ${q(image)}`, 15_000);
      const [arch, os, digests] = String(line || '').split('|');
      return { arch: arch || null, os: os || null, inRegistry: Number(digests) > 0 };
    } catch { return { arch: null, os: null, inRegistry: null }; }
  }

  async function volumeSize(actualName) {
    try {
      const [mp] = await dockerLines(`volume inspect --format "{{.Mountpoint}}" ${q(actualName)}`, 15_000);
      if (mp && isDir(mp)) return (await walkTree(mp, { hash: false })).totalBytes;
    } catch {}
    return null;
  }

  function cronReferences(serviceDir) {
    const files = [];
    const consider = f => {
      try {
        const text = fsSync.readFileSync(f, 'utf-8');
        const n = text.split('\n').filter(l => !l.trim().startsWith('#') && l.includes(serviceDir)).length;
        if (n) files.push({ file: f, entries: n });
      } catch {}
    };
    consider('/etc/crontab');
    for (const dir of ['/etc/cron.d', '/var/spool/cron/crontabs', '/var/spool/cron']) {
      try { for (const f of fsSync.readdirSync(dir)) consider(path.join(dir, f)); } catch {}
    }
    return files;
  }

  async function hostFacts() {
    const docker = await ctx.getDockerStatus();
    let composeVersion = null;
    try { [composeVersion] = await dockerLines('compose version --short', 10_000); } catch {}
    let osRelease = null;
    try { osRelease = (fsSync.readFileSync('/etc/os-release', 'utf-8').match(/^PRETTY_NAME="?([^"\n]*)"?/m) || [])[1] || null; } catch {}
    let freeBytes = null;
    try {
      const target = isDir(ctx.SERVICES_DIR) ? ctx.SERVICES_DIR : path.dirname(ctx.SERVICES_DIR);
      const s = await fs.statfs(target);
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {}
    return {
      platform: process.platform, arch: linuxArchToDocker(process.arch), osRelease,
      dockerRunning: docker.running, dockerInstalled: docker.installed, composeVersion,
      freeBytes, composeFile: ctx.MAIN_COMPOSE, composeExists: exists(ctx.MAIN_COMPOSE),
      servicesDir: ctx.SERVICES_DIR,
    };
  }

  async function inspect(service) {
    const s = await collectSource(service);
    const dirStats = s.dirExists ? await walkTree(s.serviceDir, { hash: false }) : { totalBytes: 0, files: [] };
    const volumes = [];
    for (const v of s.volumes.values()) {
      volumes.push({ name: v.name, external: v.external, explicitName: v.explicitName, service: v.service, existsOnSource: v.existsOnSource, sizeBytes: v.external || !v.existsOnSource ? 0 : await volumeSize(v.actualName) });
    }
    const images = [];
    for (const [svc, info] of Object.entries(s.composeServices)) {
      if (info.image && !info.build) images.push({ service: svc, image: info.image, ...(await imageInfo(info.image)) });
    }
    const caddy = await ctx.getCaddyBlocksForService(service).catch(() => ({ matches: [] }));
    const envBytes = s.envFiles.reduce((a, e) => a + e.size, 0);
    const volBytes = volumes.reduce((a, v) => a + (v.sizeBytes || 0), 0);
    return {
      protocol: PROTOCOL_VERSION,
      service,
      relatedServices: s.related,
      composeServices: Object.fromEntries(Object.entries(s.composeServices).map(([k, v]) => { const { containerId, ...rest } = v; return [k, rest]; })),
      running: Object.values(s.composeServices).some(c => c.state === 'running' || c.state === 'restarting'),
      serviceDir: { exists: s.dirExists, sizeBytes: dirStats.totalBytes, fileCount: dirStats.files.length },
      envFiles: s.envFiles.map(e => ({ basename: e.basename, sizeBytes: e.size })),
      volumes,
      externalBinds: s.externalBinds,
      externalNetworks: s.externalNetworks,
      caddyHosts: (caddy.matches || []).map(b => b.title),
      cron: cronReferences(s.serviceDir),
      images,
      blockers: s.blockers,
      estimatedBytes: dirStats.totalBytes + envBytes + volBytes,
      volumeSizeUnknown: volumes.some(v => v.sizeBytes == null),
      host: await hostFacts(),
    };
  }

  // ─── Destination checks ────────────────────────────────────────────────────
  function validateSummary(m) {
    if (!m || typeof m !== 'object') fail(400, 'Missing transfer summary.');
    validService(m.service);
    if (!Array.isArray(m.relatedServices) || m.relatedServices.length > 50 || !m.relatedServices.every(ctx.isSafeName)) fail(400, 'Invalid related services.');
    if (!m.composeServices || typeof m.composeServices !== 'object') fail(400, 'Invalid compose summary.');
  }

  async function checkDestination(m) {
    validateSummary(m);
    const blockers = [];
    const warnings = [];
    const host = await hostFacts();
    const doc = await ctx.readComposeDoc().catch(() => ({}));
    const destServices = doc.services && typeof doc.services === 'object' ? doc.services : {};
    const project = ctx.composeProject;

    if (!allowImport()) blockers.push('This server does not accept incoming transfers (AGENT_TRANSFER_IMPORT=false).');
    if (!host.dockerRunning) blockers.push(host.dockerInstalled ? 'Docker is installed on the destination but its daemon is not running.' : 'Docker is not installed on the destination.');
    if (m.host && m.host.platform && m.host.platform !== host.platform) blockers.push(`Operating system mismatch: source is ${m.host.platform}, destination is ${host.platform}.`);
    if (!host.composeExists) warnings.push(`The destination has no compose file yet; one will be created at ${host.composeFile}.`);

    for (const svc of m.relatedServices) {
      if (Object.prototype.hasOwnProperty.call(destServices, svc)) blockers.push(`A compose service named "${svc}" already exists on the destination.`);
    }
    if (exists(path.join(ctx.SERVICES_DIR, m.service))) blockers.push(`The directory services/${m.service} already exists on the destination.`);
    for (const e of Array.isArray(m.envFiles) ? m.envFiles : []) {
      if (!FILE_BASENAME_RE.test(String(e.basename || ''))) { blockers.push('Invalid env file name in transfer.'); continue; }
      if (exists(path.join(ctx.ENVS_DIR, e.basename))) blockers.push(`The env file ${e.basename} already exists on the destination.`);
    }

    let containers = [];
    try { containers = await ctx.listDockerContainers(); } catch {}
    const containerNames = new Set(containers.flatMap(c => String(c.Names || '').split(',').map(n => n.trim().toLowerCase())));
    for (const [svc, info] of Object.entries(m.composeServices)) {
      if (info && info.containerName && containerNames.has(String(info.containerName).toLowerCase())) {
        blockers.push(`A container named "${info.containerName}" (used by ${svc}) already exists on the destination.`);
      }
    }

    let destVolumes = new Set();
    try { destVolumes = new Set(await dockerLines('volume ls --format "{{.Name}}"')); } catch {}
    for (const v of Array.isArray(m.volumes) ? m.volumes : []) {
      if (!ctx.isSafeName(String(v.name || ''))) { blockers.push('Invalid volume name in transfer.'); continue; }
      const actual = v.explicitName || (project ? `${project}_${v.name}` : v.name);
      if (v.external) { if (!destVolumes.has(actual)) blockers.push(`External volume "${actual}" must already exist on the destination.`); }
      else if (destVolumes.has(actual)) blockers.push(`A Docker volume named "${actual}" already exists on the destination; restoring into it could mix data.`);
    }

    let destNetworks = new Set();
    try { destNetworks = new Set(await dockerLines('network ls --format "{{.Name}}"')); } catch {}
    for (const n of Array.isArray(m.externalNetworks) ? m.externalNetworks : []) {
      if (!destNetworks.has(n)) blockers.push(`External network "${n}" does not exist on the destination.`);
    }

    // Host port conflicts: other compose services' published ports and
    // anything already listening.
    const used = listeningPorts();
    for (const def of Object.values(destServices)) for (const p of hostPorts(def && def.ports)) used.add(`${p.port}/${p.protocol}`);
    for (const [svc, info] of Object.entries(m.composeServices)) {
      for (const p of Array.isArray(info && info.ports) ? info.ports : []) {
        if (used.has(`${p.port}/${p.protocol}`)) blockers.push(`Port ${p.port}/${p.protocol} (published by ${svc}) is already in use on the destination.`);
      }
    }

    const caddyContent = await ctx.readTextIfExists(ctx.CADDYFILE, '').catch(() => '');
    let caddyNeedsReload = false;
    for (const h of Array.isArray(m.caddyHosts) ? m.caddyHosts : []) {
      if (h && caddyContent.includes(String(h))) warnings.push(`The destination Caddyfile already has a site for ${h}; that block will not be added.`);
      else if (h) caddyNeedsReload = true;
    }
    if (caddyNeedsReload) {
      try { await runningCaddy(); } catch (err) { blockers.push(err.message); }
    }

    for (const b of Array.isArray(m.externalBinds) ? m.externalBinds : []) {
      warnings.push(`${b.service} mounts ${b.source}, which is outside the service folder and will NOT be transferred.`);
    }
    if (Array.isArray(m.cron) && m.cron.length) {
      warnings.push(`Scheduled tasks on the source reference this service (${m.cron.map(c => c.file).join(', ')}). They are not copied automatically, to avoid running jobs twice — recreate them on the destination if needed.`);
    }
    for (const [svc, info] of Object.entries(m.composeServices)) {
      if (info && info.restart === 'always') warnings.push(`${svc} uses "restart: always": if Docker on the source restarts, the stopped original would start again. Consider removing the original after the transfer.`);
    }
    for (const img of Array.isArray(m.images) ? m.images : []) {
      if (img.arch && img.arch !== host.arch) warnings.push(`Image ${img.image} is ${img.arch} on the source but the destination is ${host.arch}; the destination will need a compatible variant.`);
      if (img.inRegistry === false) warnings.push(`Image ${img.image} exists only locally on the source; the destination must be able to pull or build it.`);
    }

    const need = Number(m.estimatedBytes || 0) * 2 + 256 * 1024 * 1024;
    if (host.freeBytes != null && host.freeBytes < need) {
      blockers.push(`Not enough free disk space on the destination (${Math.round(host.freeBytes / 1048576)} MB free, about ${Math.round(need / 1048576)} MB needed).`);
    }
    if (m.volumeSizeUnknown) warnings.push('The size of some Docker volumes could not be measured; make sure the destination has room for them.');

    return { blockers, warnings, destination: host };
  }

  // ─── Export (source) ───────────────────────────────────────────────────────
  function rewriteDef(def, { serviceDir, envTokenFor }) {
    const out = JSON.parse(JSON.stringify(def || {}));
    const token = abs => {
      const rel = toPosix(path.relative(serviceDir, abs));
      return rel ? `{{SERVICE_DIR}}/${rel}` : '{{SERVICE_DIR}}';
    };
    const inside = p => ctx.pathInside(serviceDir, ctx.resolveServerPath(p));
    if (typeof out.build === 'string' && inside(out.build)) out.build = token(ctx.resolveServerPath(out.build));
    else if (out.build && typeof out.build === 'object' && out.build.context && inside(out.build.context)) out.build.context = token(ctx.resolveServerPath(out.build.context));
    if (Array.isArray(out.volumes)) {
      out.volumes = out.volumes.map(raw => {
        const v = parseVolume(raw);
        if (!v || v.type !== 'bind' || !v.source || !inside(v.source)) return raw;
        if (typeof raw === 'string') return [token(ctx.resolveServerPath(v.source)), v.target, v.mode].filter(Boolean).join(':');
        return { ...raw, source: token(ctx.resolveServerPath(v.source)) };
      });
    }
    if (out.env_file) {
      const mapOne = f => {
        const p = typeof f === 'string' ? f : f?.path;
        const t = p ? envTokenFor(path.resolve(ctx.resolveServerPath(p))) : null;
        if (!t) return f;
        return typeof f === 'string' ? t : { ...f, path: t };
      };
      out.env_file = Array.isArray(out.env_file) ? out.env_file.map(mapOne) : mapOne(out.env_file);
    }
    return out;
  }

  async function stopAndVerify(job, svcs) {
    if (!svcs.length) return;
    job.stage = 'stopping';
    await saveJob(job);
    await ctx.execCmd(`${D} compose -f ${q(ctx.MAIN_COMPOSE)} stop ${svcs.map(q).join(' ')}`, 300_000);
    job.stopped = svcs;
    await saveJob(job);
    const containers = await ctx.listDockerContainers();
    for (const svc of svcs) {
      const c = ctx.findContainerForService(containers, svc);
      const st = c ? ctx.getContainerStatus(c) : 'not deployed';
      if (st === 'running' || st === 'restarting') fail(500, `"${svc}" is still ${st} after stopping; refusing to export live data.`);
    }
  }

  async function startServices(svcs) {
    if (!svcs || !svcs.length) return;
    try {
      await ctx.execCmd(`${D} compose -f ${q(ctx.MAIN_COMPOSE)} start ${svcs.map(q).join(' ')}`, 300_000);
    } catch {
      await ctx.execCmd(`${D} compose -f ${q(ctx.MAIN_COMPOSE)} up -d --no-build ${svcs.map(q).join(' ')}`, 600_000);
    }
  }

  async function doExport(job) {
    const s = await collectSource(job.service);
    if (s.blockers.length) fail(409, s.blockers[0]);
    job.wasRunning = Object.values(s.composeServices).some(c => c.state === 'running' || c.state === 'restarting');
    const running = Object.entries(s.composeServices).filter(([, c]) => c.state === 'running' || c.state === 'restarting').map(([n]) => n);
    await stopAndVerify(job, running);

    job.stage = 'packing';
    await saveJob(job);
    const dir = jobDir(job.id);
    const build = path.join(dir, 'build');
    await fs.rm(build, { recursive: true, force: true });
    await fs.mkdir(path.join(build, 'env'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(build, 'volumes'), { recursive: true, mode: 0o700 });

    // Service directory (inner archive keeps ownership + modes).
    let tree = { files: [], symlinks: [], dirs: [], totalBytes: 0 };
    if (s.dirExists) {
      tree = await walkTree(s.serviceDir, { hash: true });
      await tar.c({ gzip: true, cwd: ctx.SERVICES_DIR, file: path.join(build, 'service.tgz'), portable: false, follow: false }, [job.service]);
    }

    // Env files (contents only inside the bundle; never in responses).
    const envMeta = [];
    const envToken = new Map();
    for (const [i, e] of s.envFiles.entries()) {
      const buf = await fs.readFile(e.sourcePath);
      await fs.writeFile(path.join(build, 'env', String(i)), buf, { mode: 0o600 });
      envMeta.push({ index: i, basename: e.basename, mode: e.mode, size: buf.length, sha256: sha256Buf(buf) });
      envToken.set(e.sourcePath, `{{ENV_FILE:${e.basename}}}`);
    }

    // Persistent data in named volumes, copied from the (stopped) container.
    const volMeta = [];
    for (const v of s.volumes.values()) {
      if (v.external || !v.existsOnSource || !v.containerId) continue;
      const file = path.join(build, 'volumes', `${v.name}.tar`);
      const target = String(v.target || '').replace(/\/+$/, '');
      await dockerStream(`cp ${q(`${v.containerId}:${target}/.`)} -`, { stdoutFile: file });
      const h = await sha256File(file);
      volMeta.push({ name: v.name, explicitName: v.explicitName, service: v.service, target: v.target, archive: `volumes/${v.name}.tar`, sha256: h.sha256, size: h.size });
    }

    const composeDefs = {};
    for (const svc of s.related) composeDefs[svc] = rewriteDef(s.services[svc], { serviceDir: s.serviceDir, envTokenFor: p => envToken.get(p) || null });
    const topVolumes = {};
    for (const v of s.volumes.values()) if (s.doc.volumes && s.doc.volumes[v.name] !== undefined) topVolumes[v.name] = s.doc.volumes[v.name] ?? {};
    const caddy = await ctx.getCaddyBlocksForService(job.service).catch(() => ({ matches: [] }));

    const manifest = {
      protocol: PROTOCOL_VERSION,
      transferId: job.id,
      service: job.service,
      createdAt: new Date().toISOString(),
      relatedServices: s.related,
      compose: { services: composeDefs, volumes: topVolumes, networks: s.topLevelNetworks },
      caddyBlocks: (caddy.matches || []).map(b => b.content.trim()),
      envFiles: envMeta,
      serviceDir: s.dirExists ? { files: tree.files, symlinks: tree.symlinks, dirs: tree.dirs } : null,
      volumes: volMeta,
      source: { platform: process.platform, arch: linuxArchToDocker(process.arch) },
    };
    await fs.writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });

    const entries = ['manifest.json', 'env', 'volumes'];
    if (s.dirExists) entries.push('service.tgz');
    const bundle = path.join(dir, 'bundle.tar');
    await tar.c({ cwd: build, file: bundle, portable: true }, entries);
    await fs.chmod(bundle, 0o600).catch(() => {});
    job.bundle = await sha256File(bundle);
    await fs.rm(build, { recursive: true, force: true });
    job.stage = 'exported';
  }

  // ─── Install (destination) ─────────────────────────────────────────────────
  function validateManifest(man, job) {
    if (!man || man.protocol !== PROTOCOL_VERSION) fail(400, 'Unsupported transfer bundle version.');
    if (man.service !== job.service || String(man.transferId).toLowerCase() !== job.id) fail(400, 'Bundle does not belong to this transfer.');
    if (!Array.isArray(man.relatedServices) || !man.relatedServices.every(ctx.isSafeName)) fail(400, 'Bundle lists invalid service names.');
    const defs = man.compose && man.compose.services;
    if (!defs || typeof defs !== 'object') fail(400, 'Bundle has no compose definitions.');
    for (const [k, v] of Object.entries(defs)) {
      if (!man.relatedServices.includes(k) || !v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'Bundle compose definitions are invalid.');
    }
    for (const e of man.envFiles || []) {
      if (!FILE_BASENAME_RE.test(String(e.basename)) || e.basename === '.' || e.basename === '..' || !Number.isInteger(e.index)) fail(400, 'Bundle env file entry is invalid.');
    }
    for (const v of man.volumes || []) {
      if (!ctx.isSafeName(String(v.name)) || v.archive !== `volumes/${v.name}.tar` || !man.relatedServices.includes(v.service)) fail(400, 'Bundle volume entry is invalid.');
    }
  }

  // Verify the extracted service folder against the manifest: every file with
  // its size + sha256, every symlink target, and nothing extra.
  async function verifyTree(root, expected) {
    const got = await walkTree(root, { hash: true });
    const want = new Map((expected.files || []).map(f => [f.path, f]));
    if (got.files.length !== want.size) fail(500, `Integrity check failed: expected ${want.size} files, found ${got.files.length}.`);
    for (const f of got.files) {
      const w = want.get(f.path);
      if (!w || w.size !== f.size || w.sha256 !== f.sha256) fail(500, `Integrity check failed for ${f.path}.`);
    }
    const wantLinks = new Map((expected.symlinks || []).map(l => [l.path, l.target]));
    if (got.symlinks.length !== wantLinks.size || got.symlinks.some(l => wantLinks.get(l.path) !== l.target)) fail(500, 'Integrity check failed for symbolic links.');
  }

  async function saveJournal(id, journal) { await writeJsonAtomic(journalFile(id), journal); }

  async function reloadTransferredCaddy(job, journal) {
    if (!(journal.caddyBlocks || []).length) return;
    job.stage = 'reloading-caddy';
    await saveJob(job);
    journal.caddyReloadAttempted = true;
    await saveJournal(job.id, journal);
    await reloadCaddy();
    job.caddyReloaded = true;
  }

  function substitute(def, { serviceDirRel, envRel }) {
    const sub = s => typeof s !== 'string' ? s
      : s.replace(/\{\{SERVICE_DIR\}\}/g, serviceDirRel).replace(/\{\{ENV_FILE:([A-Za-z0-9._-]+)\}\}/g, (_, b) => envRel(b));
    const out = JSON.parse(JSON.stringify(def));
    if (typeof out.build === 'string') out.build = sub(out.build);
    else if (out.build && typeof out.build === 'object') out.build.context = sub(out.build.context);
    if (Array.isArray(out.volumes)) out.volumes = out.volumes.map(v => typeof v === 'string' ? sub(v) : (v && typeof v === 'object' ? { ...v, source: sub(v.source) } : v));
    if (out.env_file) {
      const one = f => typeof f === 'string' ? sub(f) : (f && typeof f === 'object' ? { ...f, path: sub(f.path) } : f);
      out.env_file = Array.isArray(out.env_file) ? out.env_file.map(one) : one(out.env_file);
    }
    return out;
  }

  async function topLevelKeys(key) {
    const doc = await ctx.readComposeDoc().catch(() => ({}));
    return new Set(Object.keys((doc && doc[key] && typeof doc[key] === 'object') ? doc[key] : {}));
  }

  async function doInstall(job) {
    const dir = jobDir(job.id);
    const extract = path.join(dir, 'extract');
    job.stage = 'extracting';
    await saveJob(job);
    await fs.rm(extract, { recursive: true, force: true });
    await fs.mkdir(extract, { recursive: true, mode: 0o700 });
    const allowedTop = /^(manifest\.json|service\.tgz|env|env\/\d+|volumes|volumes\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.tar)\/?$/;
    await tar.x({
      file: path.join(dir, 'bundle.tar'), cwd: extract, strict: true, preservePaths: false,
      filter: (p, entry) => allowedTop.test(p) && (entry.type === 'File' || entry.type === 'Directory'),
    });
    const man = JSON.parse(await fs.readFile(path.join(extract, 'manifest.json'), 'utf-8'));
    validateManifest(man, job);

    job.stage = 'verifying-files';
    await saveJob(job);
    for (const e of man.envFiles || []) {
      const h = await sha256File(path.join(extract, 'env', String(e.index)));
      if (h.sha256 !== e.sha256) fail(500, `Integrity check failed for env file ${e.basename}.`);
    }
    for (const v of man.volumes || []) {
      const h = await sha256File(path.join(extract, v.archive));
      if (h.sha256 !== v.sha256) fail(500, `Integrity check failed for volume ${v.name}.`);
    }
    const stagedRoot = path.join(extract, 'service-root');
    if (man.serviceDir) {
      await fs.mkdir(stagedRoot, { recursive: true, mode: 0o700 });
      await tar.x({ file: path.join(extract, 'service.tgz'), cwd: stagedRoot, strict: true, preservePaths: false, umask: 0,
        filter: p => p === job.service || p.startsWith(`${job.service}/`) });
      await verifyTree(path.join(stagedRoot, job.service), man.serviceDir);
    }

    // Re-check for conflicts right before touching anything.
    job.stage = 'checking';
    await saveJob(job);
    const summary = {
      service: man.service, relatedServices: man.relatedServices,
      composeServices: Object.fromEntries(Object.entries(man.compose.services).map(([k, d]) => [k, { containerName: d.container_name || null, ports: hostPorts(d.ports) }])),
      envFiles: (man.envFiles || []).map(e => ({ basename: e.basename })),
      volumes: (man.volumes || []).map(v => ({ name: v.name, explicitName: v.explicitName, external: false })),
      externalNetworks: Object.entries(man.compose.networks || {}).filter(([, d]) => d && d.external).map(([n, d]) => (d && d.name) || n),
      host: { platform: man.source && man.source.platform },
    };
    const check = await checkDestination(summary);
    if (check.blockers.length) fail(409, check.blockers[0]);

    job.stage = 'installing';
    await saveJob(job);
    const journal = (await loadJournal(job.id)) || { serviceDir: null, envFiles: [], composeServices: [], topVolumes: [], topNetworks: [], caddyBlocks: [], containers: [], volumes: [] };
    await saveJournal(job.id, journal);
    job.warnings = check.warnings;

    // a) service folder
    const destServiceDir = path.join(ctx.SERVICES_DIR, job.service);
    if (man.serviceDir) {
      if (exists(destServiceDir)) fail(409, `services/${job.service} appeared on the destination during the transfer.`);
      await fs.mkdir(ctx.SERVICES_DIR, { recursive: true });
      try {
        await fs.rename(path.join(stagedRoot, job.service), destServiceDir);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        // Different filesystem: extract again straight into place (keeps owners).
        await tar.x({ file: path.join(extract, 'service.tgz'), cwd: ctx.SERVICES_DIR, strict: true, preservePaths: false, umask: 0,
          filter: p => p === job.service || p.startsWith(`${job.service}/`) });
      }
      const st = fsSync.statSync(destServiceDir);
      journal.serviceDir = { path: destServiceDir, dev: st.dev, ino: st.ino };
      await saveJournal(job.id, journal);
    }

    // b) env files (exclusive create: never overwrite)
    await fs.mkdir(ctx.ENVS_DIR, { recursive: true, mode: 0o700 });
    for (const e of man.envFiles || []) {
      const dest = path.join(ctx.ENVS_DIR, e.basename);
      const buf = await fs.readFile(path.join(extract, 'env', String(e.index)));
      await fs.writeFile(dest, buf, { flag: 'wx', mode: (e.mode & 0o777) || 0o600 });
      journal.envFiles.push({ path: dest, sha256: e.sha256 });
      await saveJournal(job.id, journal);
    }

    // c) compose entries
    const composeDir = path.dirname(ctx.MAIN_COMPOSE);
    const rel = p => { const r = toPosix(path.relative(composeDir, p)); return r.startsWith('.') ? r : `./${r}`; };
    const defs = {};
    for (const [svc, d] of Object.entries(man.compose.services)) {
      defs[svc] = substitute(d, { serviceDirRel: rel(destServiceDir), envRel: b => rel(path.join(ctx.ENVS_DIR, b)) });
    }
    // Every dependency must resolve here, or compose rejects the whole
    // project (which would also break every other service on this server).
    const destDoc = await ctx.readComposeDoc().catch(() => ({}));
    const destServices = destDoc && destDoc.services && typeof destDoc.services === 'object' ? destDoc.services : {};
    for (const [svc, d] of Object.entries(defs)) {
      const missing = serviceDependencies(d).filter(dep => !defs[dep] && !Object.prototype.hasOwnProperty.call(destServices, dep));
      if (missing.length) fail(409, `"${svc}" depends on ${missing.map(m => `"${m}"`).join(', ')}, which is not part of this transfer or this server.`);
    }
    const beforeVols = await topLevelKeys('volumes');
    const beforeNets = await topLevelKeys('networks');
    try { await fs.copyFile(ctx.MAIN_COMPOSE, path.join(dir, 'compose.before.yml')); } catch {}
    journal.composeServices = Object.keys(defs);
    await saveJournal(job.id, journal);
    await ctx.appendComposeServices(defs, { volumes: man.compose.volumes || {}, networks: man.compose.networks || {} });
    journal.topVolumes = [...await topLevelKeys('volumes')].filter(k => !beforeVols.has(k));
    journal.topNetworks = [...await topLevelKeys('networks')].filter(k => !beforeNets.has(k));
    await saveJournal(job.id, journal);

    // d) Caddy blocks (skipped when the destination already serves the host)
    const caddyNow = await ctx.readTextIfExists(ctx.CADDYFILE, '');
    for (const block of man.caddyBlocks || []) {
      const firstLine = String(block).split('\n')[0].trim();
      if (!firstLine || caddyNow.includes(firstLine)) continue;
      await ctx.appendCaddyBlock(block);
      journal.caddyBlocks.push(String(block).trim());
      await saveJournal(job.id, journal);
    }

    // e) named volumes: create the containers (which creates the volumes),
    //    then restore the data into them while nothing is running.
    if ((man.volumes || []).length) {
      const before = new Set(await dockerLines('volume ls --format "{{.Name}}"').catch(() => []));
      const svcs = [...new Set(man.volumes.map(v => v.service))];
      journal.containers = [...new Set([...journal.containers, ...svcs])];
      await saveJournal(job.id, journal);
      await ctx.execCmd(`${D} compose -f ${q(ctx.MAIN_COMPOSE)} create --build ${svcs.map(q).join(' ')}`, 30 * 60_000);
      const after = await dockerLines('volume ls --format "{{.Name}}"').catch(() => []);
      journal.volumes = after.filter(n => !before.has(n));
      await saveJournal(job.id, journal);
      const containers = await ctx.listDockerContainers();
      for (const v of man.volumes) {
        const c = ctx.findContainerForService(containers, v.service);
        if (!c) fail(500, `Could not create a container for ${v.service} to restore volume ${v.name}.`);
        await dockerStream(`cp -a - ${q(`${c.ID}:${v.target}`)}`, { stdinFile: path.join(extract, v.archive) });
      }
    }

    await fs.rm(extract, { recursive: true, force: true });
    if (job.startDestination === false) await reloadTransferredCaddy(job, journal);
    job.stage = 'installed';
  }

  async function doStart(job) {
    job.stage = 'starting';
    await saveJob(job);
    const journal = (await loadJournal(job.id)) || {};
    const svcs = journal.composeServices || [];
    if (!svcs.length) fail(409, 'Nothing was installed for this transfer.');
    journal.containers = [...new Set([...(journal.containers || []), ...svcs])];
    await saveJournal(job.id, journal);
    await ctx.execCmd(`${D} compose -f ${q(ctx.MAIN_COMPOSE)} up -d --build ${svcs.map(q).join(' ')}`, 30 * 60_000);

    // Health gate: every service must be running (and healthy when it has a
    // healthcheck) for several consecutive polls.
    job.stage = 'health-check';
    await saveJob(job);
    const doc = await ctx.readComposeDoc();
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let stable = 0;
    let last = {};
    while (Date.now() < deadline) {
      const containers = await ctx.listDockerContainers();
      let ok = true;
      last = {};
      for (const svc of svcs) {
        const c = ctx.findContainerForService(containers, svc);
        const state = c ? ctx.getContainerStatus(c) : 'missing';
        const status = String(c && c.Status || '');
        const restart = (doc.services && doc.services[svc] && doc.services[svc].restart) || 'no';
        const exitedCleanly = state === 'stopped' && /Exited \(0\)/.test(status) && (restart === 'no' || restart === 'on-failure');
        const healthy = /\(unhealthy\)|health: starting/.test(status) ? false : true;
        last[svc] = /\(unhealthy\)/.test(status) ? 'unhealthy' : state;
        if (!((state === 'running' && healthy) || exitedCleanly)) ok = false;
      }
      job.health = last;
      stable = ok ? stable + 1 : 0;
      if (stable >= HEALTH_STABLE_POLLS) {
        await reloadTransferredCaddy(job, journal);
        job.stage = 'started';
        return;
      }
      await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
    }
    fail(500, `The service did not become healthy on the destination (${Object.entries(last).map(([s, st]) => `${s}: ${st}`).join(', ')}).`);
  }

  // Undo exactly what the journal says this transfer created. Idempotent.
  // Containers of `services` that belong to THIS server's main compose project
  // (by config-file label, or by project label when the file path recorded by
  // compose differs, e.g. via a symlink). Works even after the compose entry
  // was removed, unlike `docker compose rm`.
  async function containersOfMainProject(services) {
    await ctx.readComposeDoc().catch(() => {}); // make sure the project name is known
    const project = ctx.composeProject;
    const found = [];
    for (const svc of services) {
      const { stdout } = await ctx.execCmd(`${D} ps -aq --filter ${q(`label=com.docker.compose.service=${svc}`)}`);
      for (const id of stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        const inspected = JSON.parse((await ctx.execCmd(`${D} inspect ${q(id)}`)).stdout)[0];
        const labels = inspected?.Config?.Labels || {};
        const files = String(labels['com.docker.compose.project.config_files'] || '').split(',').map(s => s.trim());
        const sameProject = project && String(labels['com.docker.compose.project'] || '').toLowerCase() === project;
        if (files.includes(ctx.MAIN_COMPOSE) || sameProject) found.push({ id, svc, inspected });
      }
    }
    return found;
  }

  async function removeTransferredContainers(service, services) {
    const lock = locks.get(service);
    for (const { id, inspected } of await containersOfMainProject(services)) {
      // Older journals only recorded service names. The destination lock and
      // Compose labels establish that this container belongs to this attempt.
      if (!lock || !Date.parse(lock.at) || !Date.parse(inspected.Created)
          || Date.parse(inspected.Created) < Date.parse(lock.at) - 60_000) {
        fail(409, `Cannot verify that container ${id.slice(0, 12)} belongs to this transfer.`);
      }
      await ctx.execCmd(`${D} rm -f ${q(id)}`, 300_000);
    }
    // Never report success while a transferred container is still present: it
    // could keep running next to the original that was restarted on the source.
    const left = await containersOfMainProject(services);
    if (left.length) fail(500, `Container ${left[0].id.slice(0, 12)} for "${left[0].svc}" is still present on this server.`);
  }

  async function rollbackDestination(id, service) {
    const journal = await loadJournal(id);
    const steps = [];
    const errors = [];
    const attempt = async (label, fn) => { try { await fn(); steps.push(label); } catch (e) { errors.push(`${label}: ${e.message}`); } };
    if (journal) {
      const added = journal.composeServices || [];
      const toRemove = (journal.containers || []).filter(s => added.includes(s));
      if (toRemove.length) {
        await attempt(`removed containers ${toRemove.join(', ')}`, () => removeTransferredContainers(service, toRemove));
        // Keep the journal and Compose entries intact when a container remains.
        if (errors.length) return { ok: false, steps, errors };
      }
      // Idempotent: a volume an earlier attempt already removed is done, not a
      // failure (otherwise a retried rollback could never complete).
      for (const v of journal.volumes || []) await attempt(`removed volume ${v}`, async () => {
        try { await ctx.execCmd(`${D} volume rm ${q(v)}`, 60_000); }
        catch (err) { if (!/no such volume/i.test(`${err.message} ${err.stderr || ''}`)) throw err; }
      });
      if ((journal.caddyBlocks || []).length) {
        let removed = false;
        await attempt('removed Caddy blocks', async () => {
          let content = await ctx.readTextIfExists(ctx.CADDYFILE, '');
          for (const b of journal.caddyBlocks) {
            const i = content.indexOf(b);
            if (i >= 0) content = (content.slice(0, i).trimEnd() + '\n\n' + content.slice(i + b.length).trimStart()).trimEnd() + '\n';
          }
          await fs.writeFile(ctx.CADDYFILE, content, 'utf-8');
          removed = true;
        });
        if (removed && journal.caddyReloadAttempted) await attempt('reloaded Caddy after rollback', reloadCaddy);
      }
      for (const svc of added) await attempt(`removed compose service ${svc}`, () => ctx.removeMainComposeService(svc));
      for (const key of ['volumes', 'networks']) {
        for (const name of journal[key === 'volumes' ? 'topVolumes' : 'topNetworks'] || []) {
          await attempt(`removed top-level ${key} entry ${name}`, () => removeTopLevelEntry(key, name));
        }
      }
      for (const e of journal.envFiles || []) await attempt(`removed ${path.basename(e.path)}`, () => fs.unlink(e.path).catch(err => { if (err.code !== 'ENOENT') throw err; }));
      if (journal.serviceDir) {
        await attempt(`removed services/${service}`, async () => {
          let st = null;
          try { st = fsSync.statSync(journal.serviceDir.path); } catch {}
          // Only delete the very directory this transfer created.
          if (st && st.ino === journal.serviceDir.ino && st.dev === journal.serviceDir.dev) await fs.rm(journal.serviceDir.path, { recursive: true, force: true });
        });
      }
    }
    if (!errors.length) {
      await fs.rm(jobDir(id), { recursive: true, force: true });
      releaseLock(service, id);
      jobs.delete(id);
    }
    return { ok: errors.length === 0, steps, errors };
  }

  async function removeTopLevelEntry(key, name) {
    const content = await ctx.readTextIfExists(ctx.MAIN_COMPOSE, '');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex(l => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
    if (start < 0) return;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (/^[A-Za-z0-9_-]+:/.test(lines[i])) { end = i; break; }
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const s = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^  ${esc}:`).test(l));
    if (s < 0) return;
    let e = end;
    for (let i = s + 1; i < end; i++) if (/^  \S/.test(lines[i])) { e = i; break; }
    lines.splice(s, e - s);
    // Drop the section header if it is now empty.
    const remaining = lines.slice(start + 1).findIndex(l => /^\S/.test(l));
    const sectionBody = lines.slice(start + 1, remaining < 0 ? lines.length : start + 1 + remaining);
    if (!sectionBody.some(l => l.trim())) lines.splice(start, 1);
    await fs.writeFile(ctx.MAIN_COMPOSE, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf-8');
  }

  // ─── Routes ────────────────────────────────────────────────────────────────
  const route = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    const status = err instanceof TransferError ? err.status : 500;
    if (!(err instanceof TransferError)) console.error('[agent][transfer] request failed:', err.message);
    res.status(status).json({ success: false, error: err instanceof TransferError ? err.message : `Transfer step failed: ${String(err.message || '').slice(0, 300)}` });
  });
  const needExport = () => { if (!allowExport()) fail(403, 'This server does not permit sending services (AGENT_TRANSFER_EXPORT=false).'); };
  const needImport = () => { if (!allowImport()) fail(403, 'This server does not accept incoming transfers (AGENT_TRANSFER_IMPORT=false).'); };

  app.get('/api/transfer/capabilities', (req, res) => {
    res.json({ success: true, protocol: PROTOCOL_VERSION, transferExport: allowExport(), transferImport: allowImport() });
  });

  app.post('/api/transfer/inspect', route(async (req, res) => {
    needExport();
    res.json({ success: true, summary: await inspect(validService(req.body && req.body.service)) });
  }));

  app.post('/api/transfer/check-destination', route(async (req, res) => {
    needImport();
    res.json({ success: true, ...(await checkDestination(req.body && req.body.summary)) });
  }));

  app.get('/api/transfer/:id/status', route(async (req, res) => {
    const job = loadJob(validId(req.params.id));
    if (!job) fail(404, 'Unknown transfer on this server.');
    res.json({ success: true, job: publicJob(job) });
  }));

  // SOURCE
  app.post('/api/transfer/:id/export', route(async (req, res) => {
    needExport();
    const id = validId(req.params.id);
    const service = validService(req.body && req.body.service);
    const existing = loadJob(id);
    if (existing) {
      if (existing.role !== 'source' || existing.service !== service) fail(409, 'Transfer id already used for something else.');
      if (existing.status === 'running' || (existing.status === 'done' && existing.stage === 'exported')) return res.json({ success: true, job: publicJob(existing) });
    }
    const doc = await ctx.readComposeDoc();
    const allServices = doc.services && typeof doc.services === 'object' ? doc.services : {};
    const { related } = withDependencies(await ctx.getRelatedServiceNames(service, allServices), allServices);
    acquireLock(service, id, 'source', related.length ? related : [service]);
    const job = existing || { id, role: 'source', service, stage: 'queued', stopped: [], wasRunning: false };
    runInBackground(job, async j => {
      try {
        await doExport(j);
      } catch (err) {
        // Nothing has left this server yet, so restoring is always correct.
        try { await startServices(j.stopped); j.stopped = []; } catch (e) { console.error('[agent][transfer] could not restart after failed export:', e.message); }
        await fs.rm(path.join(jobDir(j.id), 'build'), { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    });
    res.json({ success: true, job: publicJob(job) });
  }));

  app.get('/api/transfer/:id/chunk', route(async (req, res) => {
    const id = validId(req.params.id);
    const job = requireJob(id, 'source');
    if (job.stage !== 'exported' || !job.bundle) fail(409, 'The bundle is not ready.');
    const offset = Number(req.query.offset);
    const length = Math.min(Number(req.query.length) || 1024 * 1024, MAX_CHUNK);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > job.bundle.size) fail(400, 'Invalid offset.');
    const fh = await fs.open(path.join(jobDir(id), 'bundle.tar'), 'r');
    try {
      const buf = Buffer.alloc(Math.min(length, job.bundle.size - offset));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      const data = buf.subarray(0, bytesRead);
      res.json({ success: true, offset, length: data.length, sha256: sha256Buf(data), data: data.toString('base64'), eof: offset + data.length >= job.bundle.size });
    } finally { await fh.close(); }
  }));

  app.post('/api/transfer/:id/source/restore', route(async (req, res) => {
    const id = validId(req.params.id);
    const job = loadJob(id);
    if (job && job.role !== 'source') fail(409, 'Not a source transfer.');
    if (job && job.stopped && job.stopped.length) { await startServices(job.stopped); job.stopped = []; }
    const service = job ? job.service : validService(req.body && req.body.service);
    await fs.rm(jobDir(id), { recursive: true, force: true });
    releaseLock(service, id);
    jobs.delete(id);
    res.json({ success: true, restored: true });
  }));

  app.post('/api/transfer/:id/source/finish', route(async (req, res) => {
    const id = validId(req.params.id);
    const job = loadJob(id);
    const service = job ? job.service : validService(req.body && req.body.service);
    // The original stays stopped (preserved, not deleted).
    await fs.rm(jobDir(id), { recursive: true, force: true });
    releaseLock(service, id);
    jobs.delete(id);
    res.json({ success: true });
  }));

  // DESTINATION
  app.post('/api/transfer/:id/receive/init', route(async (req, res) => {
    needImport();
    const id = validId(req.params.id);
    const { service, size, sha256, relatedServices } = req.body || {};
    validService(service);
    if (!Number.isSafeInteger(size) || size <= 0 || !/^[0-9a-f]{64}$/.test(String(sha256))) fail(400, 'Invalid bundle description.');
    const related = Array.isArray(relatedServices) && relatedServices.every(ctx.isSafeName) ? relatedServices : [service];
    let job = loadJob(id);
    if (job && (job.role !== 'destination' || job.service !== service || job.expected.sha256 !== sha256)) fail(409, 'Transfer id already used for something else.');
    acquireLock(service, id, 'destination', related);
    if (!job) {
      job = { id, role: 'destination', service, stage: 'receiving', status: 'done', expected: { size, sha256 }, verified: false, pid: process.pid };
      jobs.set(id, job);
      await saveJob(job);
    }
    const file = path.join(jobDir(id), 'bundle.tar');
    if (!exists(file)) await fs.writeFile(file, Buffer.alloc(0), { mode: 0o600 });
    job.received = fsSync.statSync(file).size;
    res.json({ success: true, received: job.received });
  }));

  app.post('/api/transfer/:id/receive/chunk', route(async (req, res) => {
    const id = validId(req.params.id);
    const job = requireJob(id, 'destination');
    if (job.stage !== 'receiving') fail(409, 'This transfer is not receiving data.');
    const { offset, data, sha256 } = req.body || {};
    const file = path.join(jobDir(id), 'bundle.tar');
    const current = fsSync.statSync(file).size;
    if (offset !== current) return res.status(409).json({ success: false, error: 'Offset mismatch.', received: current });
    if (typeof data !== 'string') fail(400, 'Missing chunk data.');
    const buf = Buffer.from(data, 'base64');
    if (!buf.length || buf.length > MAX_CHUNK) fail(400, 'Invalid chunk size.');
    if (sha256Buf(buf) !== sha256) fail(400, 'Chunk checksum mismatch.');
    if (current + buf.length > job.expected.size) fail(400, 'Chunk exceeds the announced bundle size.');
    const fh = await fs.open(file, 'r+');
    try { await fh.write(buf, 0, buf.length, current); } finally { await fh.close(); }
    job.received = current + buf.length;
    res.json({ success: true, received: job.received });
  }));

  app.post('/api/transfer/:id/receive/verify', route(async (req, res) => {
    const id = validId(req.params.id);
    const job = requireJob(id, 'destination');
    const h = await sha256File(path.join(jobDir(id), 'bundle.tar'));
    job.verified = h.size === job.expected.size && h.sha256 === job.expected.sha256;
    if (job.verified) job.stage = 'received';
    await saveJob(job);
    res.json({ success: true, ok: job.verified, size: h.size, sha256: h.sha256 });
  }));

  app.post('/api/transfer/:id/install', route(async (req, res) => {
    needImport();
    const id = validId(req.params.id);
    const job = requireJob(id, 'destination');
    if (job.status === 'running') return res.json({ success: true, job: publicJob(job) });
    if (job.stage === 'installed') return res.json({ success: true, job: publicJob(job) });
    if (!job.verified) fail(409, 'The bundle has not been verified.');
    if (!['received', 'extracting', 'verifying-files', 'checking', 'installing'].includes(job.stage)) fail(409, `Cannot install from stage ${job.stage}.`);
    if (await loadJournal(id)) fail(409, 'A previous install attempt left changes behind; roll back first.');
    job.startDestination = req.body?.startDestination !== false;
    runInBackground(job, doInstall);
    res.json({ success: true, job: publicJob(job) });
  }));

  app.post('/api/transfer/:id/start', route(async (req, res) => {
    needImport();
    const id = validId(req.params.id);
    const job = requireJob(id, 'destination');
    if (job.status === 'running') return res.json({ success: true, job: publicJob(job) });
    if (job.stage === 'started') return res.json({ success: true, job: publicJob(job) });
    if (!['installed', 'starting', 'health-check', 'reloading-caddy'].includes(job.stage)) fail(409, `Cannot start from stage ${job.stage}.`);
    runInBackground(job, doStart);
    res.json({ success: true, job: publicJob(job) });
  }));

  app.post('/api/transfer/:id/rollback', route(async (req, res) => {
    const id = validId(req.params.id);
    const job = loadJob(id);
    if (job && job.role !== 'destination') fail(409, 'Not a destination transfer.');
    if (job && job.status === 'running') fail(409, 'A step is still running; wait for it to finish.');
    const service = job ? job.service : validService(req.body && req.body.service);
    res.json({ success: true, ...(await rollbackDestination(id, service)) });
  }));

  app.post('/api/transfer/:id/finish', route(async (req, res) => {
    const id = validId(req.params.id);
    const job = loadJob(id);
    if (job && job.role !== 'destination') fail(409, 'Not a destination transfer.');
    const service = job ? job.service : validService(req.body && req.body.service);
    await fs.rm(jobDir(id), { recursive: true, force: true });
    releaseLock(service, id);
    jobs.delete(id);
    res.json({ success: true });
  }));

  return { isLocked, anyLocked: () => locks.size > 0, capabilities: () => ({ transferExport: allowExport(), transferImport: allowImport(), transferVersion: PROTOCOL_VERSION }) };
}

module.exports = { register, hostPorts, parseVolume, PROTOCOL_VERSION };
