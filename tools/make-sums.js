// Regenerate SHA256SUMS for the files install-host.sh installs. Run before
// every commit that changes an agent file:
//
//   node tools/make-sums.js          write SHA256SUMS
//   node tools/make-sums.js --check  exit 1 if SHA256SUMS is out of date
//
// Hashes are taken over the content Git stores (LF line endings, per
// .gitattributes), so sums made on a Windows checkout match a Linux clone.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  'check.js', 'install-host.sh', 'link.js', 'package-lock.json', 'package.json',
  'server.js', 'transfer-agent.js', 'tunnel.js', 'uninstall-host.sh', 'update-host.sh',
];

function normalized(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf-8').replace(/\r\n/g, '\n');
}

function render() {
  return FILES.map(f => `${crypto.createHash('sha256').update(normalized(f)).digest('hex')}  ${f}`).join('\n') + '\n';
}

const out = path.join(ROOT, 'SHA256SUMS');
const next = render();
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf-8').replace(/\r\n/g, '\n') : '';
  if (cur !== next) { console.error('SHA256SUMS is out of date — run: node tools/make-sums.js'); process.exit(1); }
  console.log('SHA256SUMS is up to date.');
} else {
  fs.writeFileSync(out, next);
  const installer = next.split('\n').find(l => l.endsWith('  install-host.sh')).split(' ')[0];
  console.log(`Wrote SHA256SUMS (${FILES.length} files).`);
  console.log(`install-host.sh sha256 (publish with the commit id in release notes): ${installer}`);
}
