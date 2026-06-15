// Link this server to a dashboard account, from the terminal. Can be run any
// number of times — each successful link ADDS a new dashboard account to the
// same agent (different accounts will each see this server in their dashboard).
//
//   sudo dashboard-link            # native install (preferred)
//   sudo node /opt/dashboard-agent/link.js
//
// Two ways to authenticate:
//   1) Email + password  — for accounts that have a password.
//   2) Google / browser  — device-code flow: sign into your Google account at
//      google.com/device. Works for Google accounts (no password).
//
// Either way the terminal prints a one-time token bound to your account; you
// paste it into the dashboard (Servers → Link a server) while signed in as the
// same account. Tokens are single-use and expire after 15 minutes.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const HUB_URL  = process.env.HUB_URL || 'wss://dashboard.kyesworld.com/agent';
const HUB_HTTP = HUB_URL.replace(/^ws/, 'http').replace(/\/agent\/?$/, '');
const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, 'data');
const CRED_FILE  = path.join(DATA_DIR, 'agent.json');
const TOKEN_FILE = path.join(DATA_DIR, 'pairing.txt');

function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); /* hide typed chars */ };
    }
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

async function post(pathname, body) {
  const res = await fetch(`${HUB_HTTP}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Password flow ─────────────────────────────────────────────────────────────
async function passwordFlow() {
  const email = await ask('Dashboard email: ');
  const password = await ask('Dashboard password: ', { hidden: true });
  const { res, data } = await post('/api/pair/start', { email, password });
  if (!res.ok) { console.error(`\nLogin failed: ${data.error || res.statusText}`); process.exit(1); }

  fs.writeFileSync(TOKEN_FILE, data.token + '\n', 'utf-8');
  console.log('\n' + '='.repeat(64));
  console.log(`  Token generated for ${data.email} (valid ${data.ttlMinutes} min).`);
  console.log('  In the dashboard (logged in as the SAME account):');
  console.log('  Servers → Link a server → paste:\n');
  console.log('      ' + data.token + '\n');
  console.log('  The agent will finish linking automatically once you submit it.');
  console.log('='.repeat(64));
}

// ── Google flow: sign into your Google account from the terminal ─────────────
async function googleFlow() {
  const os = require('os');
  const { res, data } = await post('/api/pair/google/start', { name: os.hostname() });
  if (!res.ok) { console.error(`\nCould not start Google login: ${data.error || res.statusText}`); process.exit(1); }

  console.log('\n' + '='.repeat(64));
  console.log('  Sign in to Google to link this server:');
  console.log('   1. On any device open:  ' + (data.verificationUrl || 'https://www.google.com/device'));
  console.log('   2. Sign in to your Google account and enter this code:\n');
  console.log('          ' + data.userCode + '\n');
  console.log('  Waiting for you to approve…');
  console.log('='.repeat(64));

  const interval = (data.interval || 5) * 1000;
  for (;;) {
    await sleep(interval);
    const { data: poll } = await post('/api/pair/google/poll', { handle: data.handle });
    if (poll.status === 'approved') {
      fs.writeFileSync(TOKEN_FILE, poll.token + '\n', 'utf-8');
      console.log('\n' + '='.repeat(64));
      console.log(`  Signed in as ${poll.email || 'your Google account'}.`);
      console.log(`  Token generated (valid ${poll.ttlMinutes || 15} min).`);
      console.log('  In the dashboard (logged in as the SAME account):');
      console.log('  Servers → Link a server → paste:\n');
      console.log('      ' + poll.token + '\n');
      console.log('  The agent will finish linking automatically once you submit it.');
      console.log('='.repeat(64));
      return;
    }
    if (poll.status === 'denied')  { console.error('\nAccess denied. Run `npm run link` again.'); process.exit(1); }
    if (poll.status === 'expired') { console.error('\nThe code expired. Run `npm run link` again.'); process.exit(1); }
    process.stdout.write('.');
  }
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Count existing links (best-effort: tolerate legacy single-object format).
  let existing = 0;
  try {
    const data = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
    if (Array.isArray(data)) existing = data.length;
    else if (data && data.serverId) existing = 1;
  } catch {}

  console.log(`Linking this server to ${HUB_HTTP}`);
  if (existing > 0) {
    console.log(`(this agent already has ${existing} dashboard account${existing === 1 ? '' : 's'} linked; this will ADD another)`);
  }
  console.log('');
  console.log('  1) Email + password');
  console.log('  2) Sign in with Google');
  const choice = await ask('Choose [1/2]: ');

  try {
    if (choice === '2') await googleFlow();
    else await passwordFlow();
  } catch (err) {
    console.error(`\nCould not reach the hub at ${HUB_HTTP}: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
