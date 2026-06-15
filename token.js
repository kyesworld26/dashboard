// Print the current pairing token from the terminal.
//   docker compose exec agent npm run token
// If the server is already linked, says so instead.
const fs = require('fs');
const path = require('path');

const DATA_DIR   = process.env.AGENT_DATA_DIR || path.join(__dirname, 'data');
const CRED_FILE  = path.join(DATA_DIR, 'agent.json');
const TOKEN_FILE = path.join(DATA_DIR, 'pairing.txt');

if (fs.existsSync(CRED_FILE)) {
  let id = '';
  try { id = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8')).serverId; } catch {}
  console.log(`This server is already linked${id ? ` (server ${id})` : ''}.`);
  console.log('To re-pair: stop the agent, delete the data/ directory, and start it again.');
  process.exit(0);
}

try {
  const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
  console.log('\nPaste this one-time token into the dashboard (Servers → Link a server):\n');
  console.log('    ' + token + '\n');
} catch {
  console.log('No pairing token yet — start the agent (it generates one on boot) and try again.');
  process.exit(1);
}
