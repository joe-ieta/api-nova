// Regression for GHSA-jqcg-44mw-7w3h using real loopback Express HTTP requests.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

async function verify(name, trust, expectedForwarded) {
  const app = express();
  if (trust !== undefined) app.set('trust proxy', trust);
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      headers: { 'x-forwarded-for': '203.0.113.25' }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ip, expectedForwarded ? '203.0.113.25' : '127.0.0.1', name);
    return { name, passed: true };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
(async () => {
  const checks = [];
  checks.push(await verify('default does not trust forwarded identity', undefined, false));
  checks.push(await verify('IPv4-mapped IPv6 short prefix does not trust arbitrary IPv4 peers', '::ffff:10.0.0.0/8', false));
  checks.push(await verify('explicit trusted loopback still accepts forwarded identity', '127.0.0.0/8', true));
  console.log(JSON.stringify({ marker: 'PROXY_TRUST_VERIFY_OK', version: require('proxy-addr/package.json').version, checks }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
