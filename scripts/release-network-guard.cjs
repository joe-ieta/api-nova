'use strict';
// Test-only preload: block non-loopback outbound TCP/DNS in every Node child.
const net = require('node:net');
const dns = require('node:dns');
const allowed = host => host == null || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
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
const lookup = dns.lookup;
dns.lookup = function (hostname, ...args) {
  if (!allowed(hostname)) throw blocked();
  return lookup.call(this, hostname, ...args);
};
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = async function (hostname, ...args) {
  if (!allowed(hostname)) throw blocked();
  return promiseLookup.call(this, hostname, ...args);
};
