// Runs the installer scenario suite (test/installer/run.sh) under node:test.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const bash = spawnSync('bash', ['--version'], { stdio: 'ignore' });

test('install / upgrade / rollback / uninstall scenarios (sandboxed)', { skip: bash.status !== 0 && 'bash not available', timeout: 900_000 }, () => {
  const r = spawnSync('bash', [path.join(__dirname, 'installer', 'run.sh')], { encoding: 'utf-8', timeout: 900_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const summary = (out.match(/# pass \d+ fail \d+/) || ['(no summary)'])[0];
  assert.equal(r.status, 0, `${summary}\n${out.split('\n').filter(l => /^(not ok|    \|)/.test(l)).join('\n')}`);
  assert.match(summary, /fail 0/);
});
