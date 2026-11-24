// Test-only network guard: any outbound TCP connection to a non-loopback host
// throws. Loaded with `--require` in the test runner AND in every agent child
// process, so a test can never reach a real hub, Google, SMTP, a database or
// any other production service — even if some code path fell back to a
// production default.
'use strict';
const net = require('net');

const LOOPBACK = h => !h || h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];
  let host;
  if (opts && typeof opts === 'object') {
    if (opts.path) return original.apply(this, args); // unix socket / named pipe
    host = opts.host || opts.hostname;
  } else if (typeof args[1] === 'string') {
    host = args[1];
  }
  if (!LOOPBACK(host)) {
    const err = new Error(`[test network guard] blocked outbound connection to ${host}`);
    process.emitWarning(err.message);
    throw err;
  }
  return original.apply(this, args);
};

process.env.TEST_NETWORK_GUARD = '1';
