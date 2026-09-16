'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const server = fs.readFileSync(path.join(root, 'eval-server.js'), 'utf8');
const preview = fs.readFileSync(path.join(root, 'preview.html'), 'utf8');
const manager = fs.readFileSync(path.join(root, '上级评分_桑葚.html'), 'utf8');
const bp = fs.readFileSync(path.join(root, 'BP核准_桑葚.html'), 'utf8');

assert.match(server, /!Number\.isInteger\(value\)/, 'server must reject decimal item and total scores');
assert.match(server, /step="1" inputmode="numeric" placeholder="请输入整数分"/, 'generated scoring pages must request integers');
assert.doesNotMatch(server, /step="0\.1"/, 'generated scoring pages must not allow decimal steps');
assert.match(preview, /!Number\.isInteger\(s\)/, 'admin scoring must reject decimal items');
assert.match(preview, /step="1" inputmode="numeric" data-score=/, 'admin scoring inputs must use integer steps');
assert.match(manager, /Number\.isInteger\(num\)/, 'manager page must reject decimal input');
assert.match(bp, /Number\.isInteger\(num\)/, 'BP page must reject decimal input');

console.log('Integer score validation checks passed.');
