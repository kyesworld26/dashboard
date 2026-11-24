// Helper for the fake systemctl: start a detached node service and record its
// real PID (on Windows, MSYS "$!" PIDs differ from the PID node reports), or
// kill one (including its children).
'use strict';
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'start') {
  const [pidFile, logFile, cwd, script] = rest;
  const out = fs.openSync(logFile, 'a');
  // cwd is the sandbox root, not the install dir: on Windows a process's cwd
  // cannot be renamed, which would break the installer's release swap.
  const child = spawn(process.execPath, [script], { cwd, env: process.env, detached: true, stdio: ['ignore', out, out] });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
} else if (mode === 'kill') {
  const pid = Number(rest[0]);
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} } }
  const deadline = Date.now() + 10000;
  for (;;) {
    try { process.kill(pid, 0); } catch { break; }
    if (Date.now() > deadline) { try { process.kill(pid, 'SIGKILL'); } catch {} break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}
