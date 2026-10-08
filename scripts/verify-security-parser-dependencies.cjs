'use strict';
// Resolve from each actual consumer, not from the repository's direct dependency.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const rootRequire = createRequire(path.join(root, 'package.json'));
const apiRequire = createRequire(path.join(root, 'packages/api-nova-api/package.json'));
const records = [];
function consumer(name) { return createRequire(apiRequire.resolve(name + '/package.json')); }
function check(requireFrom, dependency, expected, source) {
  const file = requireFrom.resolve(dependency + '/package.json');
  const actual = requireFrom(file).version;
  assert.equal(actual, expected, `${source} must resolve ${dependency}@${expected}; got ${actual} from ${file}`);
  records.push({ source, dependency, version: actual, path: path.relative(root, file) });
  return createRequire(file);
}
const platform = consumer('@nestjs/platform-express');
check(platform, 'multer', '2.4.0', 'Nest FileInterceptor');
const express = check(platform, 'express', '4.22.3', 'Nest ExpressAdapter');
const directExpress = check(apiRequire, 'express', '4.22.3', 'API explicit body parsers');
for (const [source, req] of [['Nest ExpressAdapter', platform], ['Nest Express', express], ['API Express', directExpress]]) {
  const bodyParser = check(req, 'body-parser', '1.20.8', source);
  check(bodyParser, 'qs', '6.16.0', source + ' body-parser');
}
check(express, 'qs', '6.16.0', 'Nest Express');
check(consumer('@nestjs/swagger'), 'js-yaml', '4.3.2', 'Swagger');
check(consumer('@nestjs/swagger'), 'lodash', '4.18.1', 'Swagger');
check(consumer('@nestjs/config'), 'lodash', '4.18.1', 'Config');
for (const name of ['@nestjs/common', '@nestjs/core']) {
  assert.equal(platform.resolve(name), apiRequire.resolve(name), `${name} must share its runtime instance`);
  assert.equal(rootRequire.resolve(name), apiRequire.resolve(name), `${name} root/API instances must agree`);
}
const apiExpress = apiRequire('express');
for (const parser of ['json', 'urlencoded']) {
  assert.throws(() => apiExpress[parser]({ limit: 'not-a-size', extended: true }), /limit.*invalid/, parser + ' must reject invalid limits');
}
console.log(JSON.stringify({ passed: true, root, checks: records.length, invalidLimitChecks: 2, records }, null, 2));
