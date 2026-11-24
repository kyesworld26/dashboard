// Agent local API: authentication, input validation, server/service
// isolation and resource use. Runs server.js against a temporary server root
// and the fake Docker CLI; loopback networking only.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const YAML = require('yaml');
const { checkHubUrl } = require('../tunnel');

const AGENT = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-docker.js');
const GUARD = path.join(__dirname, 'helpers', 'no-network.js').replace(/\\/g, '/');
const TOKEN = crypto.randomBytes(16).toString('hex');

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function env(root, port, extra = {}) {
  const e = {
    PORT: String(port), AGENT_BIND_HOST: '127.0.0.1', SERVER_ROOT: path.join(root, 'server'), AGENT_DATA_DIR: path.join(root, 'data'),
    AGENT_DOCKER_BIN: `"${process.execPath}" "${FAKE}"`, FAKE_DOCKER_STATE: path.join(root, 'docker'),
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), NODE_OPTIONS: `--require "${GUARD}"`,
    STATS_SAMPLE_MS: '3600000', PATH: process.env.PATH, ...extra,
  };
  for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) e[k] = process.env[k];
  return e;
}

function startApi(root, port, extra) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(AGENT, 'server.js')], { env: env(root, port, extra), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('message', m => { if (m && m.type === 'ready') resolve(p); });
    p.on('exit', code => reject(Object.assign(new Error(`exited ${code}: ${out}`), { code, out })));
  });
}

let root, port, api, apiNoExport, portNoExport;

function req(method, p, { token = TOKEN, headers = {}, body, port: prt = port } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h['x-agent-local-token'] = token;
    const data = body !== undefined ? JSON.stringify(body) : null;
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: prt, method, path: p, headers: h }, res => {
      let t = ''; res.on('data', d => { t += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const writeState = state => fs.writeFileSync(path.join(root, 'docker', 'state.json'), JSON.stringify(state));
const calls = () => { try { return fs.readFileSync(path.join(root, 'docker', 'calls.log'), 'utf-8').split('\n').filter(Boolean); } catch { return []; } };
const compose = () => YAML.parse(fs.readFileSync(path.join(root, 'server', 'docker-compose.yml'), 'utf-8'));
const ctr = (id, name, project, service, state = 'running') => ({ ID: id, Names: name, project, service, State: state, Status: state === 'running' ? 'Up 1 minute' : 'Exited (0)', Image: 'img', mounts: [] });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-api-'));
  for (const d of ['server/services/web/public', 'server/services/db', 'server/services/cafe', 'server/envs', 'data', 'docker', 'home']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside-secret.txt'), 'TOP-SECRET-OUTSIDE');
  fs.writeFileSync(path.join(root, 'server', 'services', 'web', 'index.html'), 'hi');
  fs.writeFileSync(path.join(root, 'server', 'envs', '.shared-env'), 'A=1');
  fs.writeFileSync(path.join(root, 'server', 'docker-compose.yml'), YAML.stringify({
    name: 'proj-test',
    services: {
      web: { build: './services/web', env_file: ['./envs/.shared-env'],
        volumes: ['webdata:/data', 'shared:/shared', 'external:/external',
          { type: 'volume', source: 'custom', target: '/custom' }, 'exclusive:/exclusive'] },
      'web-static': { image: 'nginx:alpine', volumes: ['./services/web/public:/usr/share/nginx/html:ro'] },
      'web-proxy': { image: 'traefik' },
      webdb: { image: 'postgres', env_file: ['./envs/.shared-env'], volumes: ['shared:/shared', 'alias:/alias'] },
      db: { image: 'postgres' },
      cafe: { image: 'cafe' },
    },
    volumes: { webdata: {}, shared: {}, external: { external: true },
      custom: { name: 'my-web-data' }, alias: { name: 'my-web-data' }, exclusive: { name: 'my-exclusive-data' } },
  }));
  port = await freePort();
  api = await startApi(root, port, { AGENT_LOCAL_TOKEN: TOKEN });
});

after(() => {
  for (const p of [api, apiNoExport]) if (p) try { p.kill(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('refuses to start without a local token', async () => {
  const p2 = await freePort();
  await assert.rejects(startApi(root, p2, {}), e => e.code === 1 && /AGENT_LOCAL_TOKEN/.test(e.out));
});

test('every request needs the per-boot token, a loopback Host and no browser Origin', async () => {
  assert.equal((await req('GET', '/api/services', { token: null })).status, 401);
  assert.equal((await req('GET', '/api/services', { token: 'wrong' })).status, 401);
  assert.equal((await req('GET', '/api/services', { headers: { host: 'evil.example:80' } })).status, 421, 'DNS rebinding');
  assert.equal((await req('GET', '/api/services', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req('POST', '/api/system/prune', { token: null })).status, 401, 'no unauthenticated side effects');
  assert.ok(!calls().some(c => c.startsWith('system prune')));
  assert.equal((await req('GET', '/api/services')).status, 200);
});

test('the root terminal WebSocket requires the token too', async () => {
  const attempt = headers => new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
  assert.equal(await attempt({}), 401);
  assert.equal(await attempt({ 'x-agent-local-token': TOKEN, origin: 'https://evil.example' }), 403);
  assert.equal(await attempt({ 'x-agent-local-token': TOKEN }), 'open');
});

test('service names are validated on every route (no traversal)', async () => {
  for (const bad of ['..', '.', '..%2F..%2Foutside-secret.txt', '%2E%2E', '.hidden', '-rf', 'a%00b']) {
    for (const p of [`/api/services/${bad}/env`, `/api/services/${bad}/stats`, `/api/services/${bad}/files`]) {
      const r = await req('GET', p);
      assert.ok([400, 404].includes(r.status), `${p} → ${r.status}`);
      assert.ok(!r.text.includes('TOP-SECRET-OUTSIDE'));
    }
  }
  const put = await req('PUT', '/api/services/..%2F..%2Fpwned/env', { body: { content: 'x' } });
  assert.equal(put.status, 400);
  assert.ok(!fs.existsSync(path.join(root, 'pwned-env')) && !fs.existsSync(path.join(root, '.pwned-env')));
});

test('file API: no escape via .. or symlinks, and the service root cannot be deleted', async () => {
  const up = await req('GET', '/api/services/web/file?path=' + encodeURIComponent('../../../outside-secret.txt'));
  assert.equal(up.json.success, false);
  let linked = false;
  try { fs.symlinkSync(root, path.join(root, 'server', 'services', 'web', 'escape'), 'junction'); linked = true; } catch {}
  if (linked) {
    const r = await req('GET', '/api/services/web/file?path=' + encodeURIComponent('escape/outside-secret.txt'));
    assert.equal(r.json.success, false);
    assert.ok(!r.text.includes('TOP-SECRET-OUTSIDE'), 'symlink escape blocked');
    const w = await req('PUT', '/api/services/web/file', { body: { path: 'escape/owned.txt', content: 'x' } });
    assert.equal(w.json.success, false);
    assert.ok(!fs.existsSync(path.join(root, 'owned.txt')));
    fs.rmSync(path.join(root, 'server', 'services', 'web', 'escape'), { recursive: false, force: true });
  }
  const del = await req('DELETE', '/api/services/web/file?path=.');
  assert.equal(del.json.success, false);
  assert.ok(fs.existsSync(path.join(root, 'server', 'services', 'web', 'index.html')));
});

test("another compose project's container is never attributed to this service", async () => {
  writeState({ containers: [
    ctr('a'.repeat(64), 'otherproj-db-1', 'otherproj', 'db', 'running'),   // same service name, other project
    ctr('cafe' + 'b'.repeat(60), 'unrelated', 'zzz', 'unrelated', 'running'), // id prefix "cafe"
    ctr('c'.repeat(64), 'proj-test-web-1', 'proj-test', 'web', 'running'),
  ], volumes: {}, networks: ['bridge'] });
  const list = (await req('GET', '/api/services')).json;
  assert.equal(list.find(s => s.name === 'db').status, 'not deployed', 'not "running" from otherproj');
  assert.equal(list.find(s => s.name === 'web').status, 'running');
  const dbStats = (await req('GET', '/api/services/db/stats')).json;
  assert.equal(dbStats.success, false); assert.equal(dbStats.code, 'not_deployed');
  const cafe = (await req('GET', '/api/services/cafe/stats')).json;
  assert.equal(cafe.code, 'not_deployed', 'no docker id-prefix fallback');
  const web = (await req('GET', '/api/services/web/stats')).json;
  assert.equal(web.success, true);
  assert.equal(web.service, 'web');
  assert.equal(web.containerId, 'c'.repeat(64));
});

test('concurrent stats requests share one docker invocation', async () => {
  const before = calls().filter(c => c.startsWith('stats')).length;
  await Promise.all(Array.from({ length: 6 }, () => req('GET', '/api/system/container-stats')));
  const after = calls().filter(c => c.startsWith('stats')).length;
  assert.equal(after - before, 1);
});

test('deleting a service removes only its own compose services and keeps shared env files', async () => {
  const volumeNames = ['proj-test_webdata', 'proj-test_shared', 'external', 'my-web-data', 'my-exclusive-data', 'anonymous-test-volume'];
  const volumes = Object.fromEntries(volumeNames.map(n => [n, path.join(root, 'docker', 'volumes', n)]));
  for (const dir of Object.values(volumes)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'synthetic.txt'), 'test only');
  }
  const volumeLabels = Object.fromEntries([
    ['proj-test_webdata', 'webdata'], ['proj-test_shared', 'shared'],
    ['my-web-data', 'custom'], ['my-exclusive-data', 'exclusive'],
  ].map(([n, source]) => [n, { 'com.docker.compose.project': 'proj-test', 'com.docker.compose.volume': source }]));
  writeState({ containers: [
    { ...ctr('w'.repeat(64), 'proj-test-web-1', 'proj-test', 'web'),
      mounts: [...['proj-test_webdata', 'proj-test_shared', 'external', 'my-web-data', 'my-exclusive-data'].map(Name => ({ Type: 'volume', Name })),
        { Type: 'volume', Name: 'anonymous-test-volume', Anonymous: true }] },
    ctr('s'.repeat(64), 'proj-test-web-static-1', 'proj-test', 'web-static'),
    { ...ctr('d'.repeat(64), 'proj-test-webdb-1', 'proj-test', 'webdb'),
      mounts: [{ Type: 'volume', Name: 'proj-test_shared' }, { Type: 'volume', Name: 'my-web-data' }] },
  ], volumes, volumeLabels, networks: ['bridge'] });
  const r = await req('DELETE', '/api/services/web');
  assert.equal(r.status, 200, r.text);
  const services = Object.keys(compose().services).sort();
  assert.deepEqual(services, ['cafe', 'db', 'web-proxy', 'webdb'], 'web + web-static removed; web-proxy and webdb kept');
  assert.ok(fs.existsSync(path.join(root, 'server', 'envs', '.shared-env')), 'env still used by webdb is kept');
  assert.match(r.json.output, /Kept .*\.shared-env/);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'docker', 'state.json'), 'utf-8'));
  assert.equal(state.volumes['proj-test_webdata'], undefined, 'owned named volume removed');
  assert.equal(state.volumes['my-exclusive-data'], undefined, 'owned custom-name volume removed');
  assert.equal(state.volumes['anonymous-test-volume'], undefined, 'anonymous volume removed with container');
  assert.ok(state.volumes['proj-test_shared'], 'volume used by another service kept');
  assert.ok(state.volumes['my-web-data'], 'same volume referenced under a different key is kept');
  assert.ok(state.volumes.external, 'external volume kept');
  assert.deepEqual(Object.keys(compose().volumes).sort(), ['alias', 'custom', 'external', 'shared']);
  assert.ok(!fs.existsSync(volumes['proj-test_webdata']));
  assert.match(r.json.output, /Deleted data volume "proj-test_webdata"/);
});

test('a volume deletion failure leaves the service definition and its files in place', async () => {
  const doc = compose();
  doc.services.db.volumes = ['dbdata:/data'];
  doc.volumes.dbdata = {};
  fs.writeFileSync(path.join(root, 'server', 'docker-compose.yml'), YAML.stringify(doc));
  const dir = path.join(root, 'docker', 'volumes', 'proj-test_dbdata');
  fs.mkdirSync(dir, { recursive: true });
  writeState({ containers: [{ ...ctr('e'.repeat(64), 'proj-test-db-1', 'proj-test', 'db'),
    mounts: [{ Type: 'volume', Name: 'proj-test_dbdata' }] }],
    volumes: { 'proj-test_dbdata': dir },
    volumeLabels: { 'proj-test_dbdata': { 'com.docker.compose.project': 'proj-test', 'com.docker.compose.volume': 'dbdata' } },
    failVolumeRm: ['proj-test_dbdata'], networks: ['bridge'] });
  const r = await req('DELETE', '/api/services/db?deleteFiles=true');
  assert.equal(r.status, 500, r.text);
  assert.ok(compose().services.db, 'Compose definition retained');
  assert.ok(fs.existsSync(path.join(root, 'server', 'services', 'db')), 'service files retained');
  assert.ok(fs.existsSync(dir), 'volume retained');
  assert.match(r.json.error, /fake volume rm failure/);
});

test('deletion refuses a volume whose ownership cannot be verified', async () => {
  const dir = path.join(root, 'docker', 'volumes', 'proj-test_dbdata');
  writeState({ containers: [ctr('f'.repeat(64), 'proj-test-db-1', 'proj-test', 'db')],
    volumes: { 'proj-test_dbdata': dir }, networks: ['bridge'] });
  const r = await req('DELETE', '/api/services/db');
  assert.equal(r.status, 500, r.text);
  assert.match(r.json.error, /ownership could not be verified/);
  assert.ok(compose().services.db);
  assert.ok(fs.existsSync(dir));
  assert.ok(!calls().slice(-2).some(c => c.includes('compose') && c.includes(' rm ')), 'container removal not attempted');
});

test('transfers can be disabled per direction on the server itself', async () => {
  portNoExport = await freePort();
  apiNoExport = await startApi(root, portNoExport, { AGENT_LOCAL_TOKEN: TOKEN, AGENT_TRANSFER_EXPORT: 'false', AGENT_TRANSFER_IMPORT: 'false' });
  const inspect = await req('POST', '/api/transfer/inspect', { body: { service: 'db' }, port: portNoExport });
  assert.equal(inspect.status, 403);
  const init = await req('POST', `/api/transfer/${crypto.randomUUID()}/receive/init`, { body: { service: 'x', size: 10, sha256: 'a'.repeat(64) }, port: portNoExport });
  assert.equal(init.status, 403);
  assert.equal((await req('POST', '/api/transfer/inspect', { body: { service: '../etc' } })).status, 400);
});

test('transfer preflight checks the running Caddy and its mounted Caddyfile', async () => {
  const summary = {
    service: 'incoming-site', relatedServices: ['incoming-site'],
    composeServices: { 'incoming-site': {} }, envFiles: [], volumes: [], externalNetworks: [],
    caddyHosts: ['incoming.example.test:80'],
  };
  const check = () => req('POST', '/api/transfer/check-destination', { body: { summary } });
  let result = await check();
  assert.ok(result.json.blockers.some(b => /Caddy service/.test(b)));

  const doc = compose();
  doc.services.caddy = { image: 'caddy:latest', volumes: ['./other-Caddyfile:/etc/caddy/Caddyfile:ro'] };
  fs.writeFileSync(path.join(root, 'server', 'docker-compose.yml'), YAML.stringify(doc));
  writeState({ containers: [ctr('c'.repeat(64), 'proj-test-caddy-1', 'proj-test', 'caddy')], volumes: {}, networks: ['bridge'] });
  result = await check();
  assert.ok(result.json.blockers.some(b => /selected Caddyfile/.test(b)));

  doc.services.caddy.volumes = ['./Caddyfile:/etc/caddy/Caddyfile:ro'];
  fs.writeFileSync(path.join(root, 'server', 'docker-compose.yml'), YAML.stringify(doc));
  result = await check();
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.json.blockers, []);
  assert.ok(!result.json.warnings.some(w => /reload Caddy/i.test(w)));
});

test('hub URL policy: TLS required except loopback / private compose names', () => {
  assert.equal(checkHubUrl('wss://dashboard.example.com/agent'), null);
  assert.equal(checkHubUrl('ws://hub:3002/agent'), null);
  assert.equal(checkHubUrl('ws://127.0.0.1:3002/agent'), null);
  assert.match(checkHubUrl('ws://dashboard.example.com/agent'), /Refusing unencrypted/);
  assert.match(checkHubUrl('https://dashboard.example.com/agent'), /wss/);
  assert.match(checkHubUrl('not a url'), /valid URL/);
});
