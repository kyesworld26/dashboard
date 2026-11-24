// Release self-check, run by install-host.sh against a staged release BEFORE
// it is activated: every program file must parse and every runtime dependency
// must resolve. A release that fails is never switched in.
//
//   node check.js        exit 0 = ok, 1 = broken
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const FILES = ['tunnel.js', 'server.js', 'link.js', 'transfer-agent.js', 'check.js'];
const OPTIONAL = new Set(['@homebridge/node-pty-prebuilt-multiarch']); // terminal falls back without it

let ok = true;
for (const f of FILES) {
  try {
    execFileSync(process.execPath, ['--check', path.join(__dirname, f)], { stdio: 'pipe' });
  } catch (err) {
    ok = false;
    console.error(`check: ${f} does not parse: ${String(err.stderr || err.message).split('\n')[0]}`);
  }
}

const pkg = require('./package.json');
for (const dep of Object.keys(pkg.dependencies || {})) {
  try {
    require.resolve(dep, { paths: [__dirname] });
  } catch {
    if (OPTIONAL.has(dep)) console.warn(`check: optional dependency ${dep} is unavailable (web terminal will be disabled)`);
    else { ok = false; console.error(`check: dependency ${dep} is not installed`); }
  }
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) { ok = false; console.error(`check: Node.js 22+ required, found ${process.versions.node}`); }

if (ok) console.log(`check: ok (agent ${pkg.version}, node ${process.versions.node})`);
process.exit(ok ? 0 : 1);
