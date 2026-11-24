#!/usr/bin/env node
// Fake `docker` CLI for agent tests. Implements just the subset of commands
// the agent uses, against a JSON state file + directory-backed volumes in
// $FAKE_DOCKER_STATE. A test run therefore never touches a real Docker daemon.
//
// Failure injection: a compose service with label `fake.start=fail` keeps
// "restarting" after start (unhealthy); `fake.create=fail` makes create fail.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const tar = require('tar');

const STATE_DIR = process.env.FAKE_DOCKER_STATE;
if (!STATE_DIR) { console.error('FAKE_DOCKER_STATE not set'); process.exit(97); }
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK = path.join(STATE_DIR, '.lock');
const VOL_ROOT = path.join(STATE_DIR, 'volumes');
fs.mkdirSync(VOL_ROOT, { recursive: true });

function withLock(fn) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch {
      if (Date.now() > deadline) { try { fs.rmdirSync(LOCK); } catch {} continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(LOCK); } catch {} }
}
const load = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return { containers: [], volumes: {}, networks: ['bridge', 'host', 'none'] }; } };
const save = s => { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s, null, 1)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); };
const log = line => fs.appendFileSync(path.join(STATE_DIR, 'calls.log'), line + '\n');

const args = process.argv.slice(2);
log(args.join(' '));
const out = s => process.stdout.write(s);
const die = (msg, code = 1) => { process.stderr.write(msg + '\n'); process.exit(code); };

function labelsOf(def) {
  const l = def && def.labels;
  if (Array.isArray(l)) return Object.fromEntries(l.map(x => String(x).split('=')));
  return l && typeof l === 'object' ? l : {};
}
function projectOf(file, doc) {
  return String((doc && doc.name) || path.basename(path.dirname(file))).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}
function psRow(c) {
  const labels = `com.docker.compose.project=${c.project},com.docker.compose.service=${c.service}`;
  return { ID: c.ID, Names: c.Names, State: c.State, Status: c.Status, Labels: labels, Image: c.Image, CreatedAt: c.CreatedAt };
}
function statusFor(state) {
  return { running: 'Up 2 seconds', exited: 'Exited (0) 1 second ago', created: 'Created', restarting: 'Restarting (1) 1 second ago' }[state] || state;
}
function setState(c, st) { c.State = st; c.Status = statusFor(st); }

function compose(argv) {
  if (argv[0] === 'version') return out('2.29.0-fake\n');
  let file = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-f') { file = argv[++i]; continue; }
    rest.push(argv[i]);
  }
  const sub = rest.shift();
  const flags = rest.filter(a => a.startsWith('-'));
  const names = rest.filter(a => !a.startsWith('-'));
  const doc = YAML.parse(fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '') || {};
  const services = doc.services || {};
  const project = projectOf(file, doc);
  const targets = names.length ? names : Object.keys(services);
  return withLock(() => {
    const s = load();
    const find = svc => s.containers.find(c => c.project === project && c.service === svc);
    const ensure = svc => {
      const def = services[svc];
      if (!def) die(`no such service: ${svc}`);
      if (sub === 'create' && labelsOf(def)['fake.create'] === 'fail') die(`fake create failure for ${svc}`);
      let c = find(svc);
      if (!c) {
        const mounts = [];
        for (const v of def.volumes || []) {
          const str = typeof v === 'string' ? v : `${v.source}:${v.target}`;
          const [src, target] = str.split(':');
          if (!src || /^[./~]/.test(src) || /^[A-Za-z]:/.test(src)) continue; // bind mount
          const top = (doc.volumes || {})[src] || {};
          const name = top.name || `${project}_${src}`;
          if (!s.volumes[name]) { s.volumes[name] = path.join(VOL_ROOT, name); fs.mkdirSync(s.volumes[name], { recursive: true }); }
          s.volumeLabels ||= {};
          s.volumeLabels[name] ||= { 'com.docker.compose.project': project, 'com.docker.compose.volume': src };
          mounts.push({ Type: 'volume', Name: name, Destination: target });
        }
        c = { ID: crypto.randomBytes(32).toString('hex'), Names: def.container_name || `${project}-${svc}-1`, project, service: svc,
              Image: def.image || `${project}-${svc}`, CreatedAt: new Date().toISOString(), mounts, labels: labelsOf(def) };
        setState(c, 'created');
        s.containers.push(c);
      }
      return c;
    };
    const failStart = String(process.env.FAKE_DOCKER_FAIL_START || '').split(',').filter(Boolean);
    const startOne = c => setState(c, (c.labels && c.labels['fake.start'] === 'fail') || failStart.includes(c.service) ? 'restarting' : 'running');
    switch (sub) {
      case 'up': for (const svc of targets) startOne(ensure(svc)); break;
      case 'create': for (const svc of targets) ensure(svc); break;
      case 'start': for (const svc of targets) { const c = find(svc); if (!c) die(`no container for ${svc}`); startOne(c); } break;
      case 'restart': for (const svc of targets) { const c = find(svc); if (c) startOne(c); } break;
      case 'stop': for (const svc of targets) { const c = find(svc); if (c) setState(c, 'exited'); } break;
      case 'down': s.containers = s.containers.filter(c => c.project !== project); break;
      case 'rm':
        if (targets.some(svc => (s.failComposeRm || []).includes(svc))) die('fake compose rm failure');
        if (flags.includes('--volumes') || flags.some(flag => /^-[a-z]+$/.test(flag) && flag.includes('v'))) {
          for (const c of s.containers.filter(c => c.project === project && targets.includes(c.service))) {
            for (const mount of c.mounts || []) {
              if (mount.Anonymous && s.volumes[mount.Name]) {
                fs.rmSync(s.volumes[mount.Name], { recursive: true, force: true });
                delete s.volumes[mount.Name];
              }
            }
          }
        }
        s.containers = s.containers.filter(c => !(c.project === project && targets.includes(c.service)));
        break;
      case 'pull': break;
      default: die(`fake compose: unsupported ${sub}`);
    }
    save(s);
    out(`${sub} ok\n`);
  });
}

function cp(argv) {
  const plain = argv.filter(a => a !== '-a');
  const [src, dest] = plain;
  const s = load();
  const resolve = ref => {
    const [id, ...rest] = ref.split(':');
    const p = rest.join(':');
    const c = s.containers.find(x => x.ID === id || x.Names === id);
    if (!c) die(`no such container: ${id}`);
    const target = p.replace(/\/\.$/, '').replace(/\/+$/, '');
    const m = c.mounts.find(x => x.Destination === target);
    if (!m) die(`fake cp: ${target} is not a volume mount`);
    return s.volumes[m.Name];
  };
  if (dest === '-') {
    const dir = resolve(src);
    const entries = fs.readdirSync(dir);
    if (!entries.length) { process.stdout.write(Buffer.alloc(1024)); return; } // empty tar
    tar.c({ cwd: dir, portable: true }, entries).pipe(process.stdout);
  } else if (src === '-') {
    const dir = resolve(dest);
    process.stdin.pipe(tar.x({ cwd: dir }));
  } else die('fake cp: unsupported form');
}

const [cmd, ...rest] = args;
switch (cmd) {
  case '--version': out('Docker version 27.0.0-fake, build test\n'); break;
  case 'info': out('27.0.0-fake\n'); break;
  case 'version': out('{"Client":{"Version":"27.0.0-fake"}}\n'); break;
  case 'compose': compose(rest); break;
  case 'ps': {
    const s = load();
    if (rest.includes('-q')) { out(s.containers.filter(c => c.State === 'running').map(c => c.ID.slice(0, 12)).join('\n') + '\n'); break; }
    for (const c of s.containers) out(JSON.stringify(psRow(c)) + '\n');
    break;
  }
  case 'stats': {
    const s = load();
    const ids = rest.filter(a => !a.startsWith('-') && !a.startsWith('{'));
    const list = s.containers.filter(c => c.State === 'running' && (!ids.length || ids.includes(c.ID)));
    for (const c of list) {
      const n = parseInt(c.ID.slice(0, 2), 16) / 10;
      out(JSON.stringify({ Name: c.Names, ID: c.ID, CPUPerc: `${n.toFixed(2)}%`, MemPerc: '1.50%', MemUsage: '12MiB / 1GiB', NetIO: '1kB / 2kB', BlockIO: '0B / 0B' }) + '\n');
    }
    break;
  }
  case 'cp': cp(rest); break;
  case 'logs': out(`fake log line for ${rest[rest.length - 1]}\n`); break;
  case 'volume': {
    const s = load();
    if (rest[0] === 'ls') { out(Object.keys(s.volumes).join('\n') + (Object.keys(s.volumes).length ? '\n' : '')); break; }
    if (rest[0] === 'rm') { withLock(() => { const st = load(); for (const n of rest.slice(1)) {
      if ((st.failVolumeRm || []).includes(n)) die('fake volume rm failure');
      if (st.containers.some(c => (c.mounts || []).some(m => m.Name === n))) die('volume is in use');
      if (!st.volumes[n]) die('no such volume');
      fs.rmSync(st.volumes[n], { recursive: true, force: true });
      delete st.volumes[n];
      if (st.volumeLabels) delete st.volumeLabels[n];
    } save(st); }); break; }
    if (rest[0] === 'inspect') { const n = rest[rest.length - 1]; if (!s.volumes[n]) die(`no such volume ${n}`);
      if (rest.includes('--format')) out(s.volumes[n] + '\n');
      else out(JSON.stringify([{ Name: n, Mountpoint: s.volumes[n], Labels: (s.volumeLabels || {})[n] || null }]) + '\n');
      break; }
    die('fake volume: unsupported');
    break;
  }
  case 'network': out(load().networks.join('\n') + '\n'); break;
  case 'image': out('amd64|linux|1\n'); break;
  case 'inspect': {
    const s = load();
    const c = s.containers.find(x => x.ID === rest[rest.length - 1]);
    if (!c) die('no such container');
    out(JSON.stringify(c.mounts) + '\n');
    break;
  }
  case 'start': case 'stop': case 'restart': case 'kill': {
    withLock(() => { const s = load(); const c = s.containers.find(x => x.ID === rest[0] || x.Names === rest[0]); if (!c) die('no such container'); setState(c, cmd === 'stop' || cmd === 'kill' ? 'exited' : 'running'); save(s); });
    out(`${rest[0]}\n`);
    break;
  }
  case 'exec': {
    const s = load();
    const c = s.containers.find(x => x.ID === rest[0] || x.Names === rest[0]);
    if (!c || c.State !== 'running') die('fake exec: container is not running');
    if (s.failCaddyReloadOnce && rest.includes('caddy') && rest.includes('reload')) {
      delete s.failCaddyReloadOnce;
      save(s);
      die('fake Caddy reload failure');
    }
    out('ok\n');
    break;
  }
  case 'system': out('Total reclaimed space: 0B\n'); break;
  default: die(`fake docker: unsupported command ${cmd}`);
}
