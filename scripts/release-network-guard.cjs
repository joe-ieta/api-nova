'use strict';
// Test-only preload: block non-loopback outbound TCP/DNS/UDP in every Node child.
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');

const allowed = host => {
  if (host == null) {
    return true;
  }

  const normalized = String(host).trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return [
    '0',
    '0.0.0.0',
    '::',
    '::1',
    '[::1]',
    'localhost',
    '127.0.0.1'
  ].includes(normalized);
};

function blocked() {
  const error = new Error('Non-loopback networking is blocked during release smoke');
  error.code = 'API_NOVA_OFFLINE_BLOCKED';
  return error;
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = values[0];
  if (typeof options === 'object' && options !== null) {
    if (options.path || !allowed(options.host)) throw blocked();
  } else if (typeof options === 'string' && !/^\d+$/.test(options)) {
    throw blocked();
  } else if (typeof values[1] === 'string' && !allowed(values[1])) {
    throw blocked();
  }
  return connect.apply(this, args);
};

const patchDnsLookup = (fn, pickHost) => (...args) => {
  const host = pickHost(...args);
  if (!allowed(host)) throw blocked();
  return fn.apply(dns, args);
};

dns.lookup = patchDnsLookup(dns.lookup, args => args[0]);

for (const name of ['resolve', 'resolve4', 'resolve6', 'reverse', 'lookupService']) {
  if (typeof dns[name] === 'function') {
    const original = dns[name];
    dns[name] = patchDnsLookup(original, args => args[0]);
  }
}

for (const name of ['lookup', 'reverse']) {
  if (typeof dns.promises[name] === 'function') {
    const original = dns.promises[name];
    dns.promises[name] = async function (...args) {
      if (!allowed(args[0])) throw blocked();
      return original.apply(this, args);
    };
  }
}

const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  if (args.length >= 5 && typeof args[4] === 'string' && !allowed(args[4])) {
    throw blocked();
  }
  if (args.length >= 4 && typeof args[3] === 'string' && !allowed(args[3])) {
    throw blocked();
  }
  if (args.length >= 3 && typeof args[2] === 'string' && !allowed(args[2])) {
    throw blocked();
  }
  return send.apply(this, args);
};
