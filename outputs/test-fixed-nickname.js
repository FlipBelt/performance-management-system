'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, 'eval-server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'preview.html'), 'utf8');
assert(server.includes("'姚耀相': '大象'"), '服务端未配置姚耀相的固定花名');
assert(server.includes('canonicalEmployeeNickname(directoryEmployee)'), '通讯录同步未使用固定花名');
assert(server.includes('canonicalEmployeeNickname(employee)'), '钉钉通知账号解析未兼容固定花名');
assert(server.includes("'大象': '大货理单'"), '服务端未保留大象的岗位映射');
assert(html.includes('"大象": "大货理单"'), '前端未保留大象的岗位映射');
assert(/const updates = \{[\s\S]{0,300}name: rosterEmployee\.nick \|\| existing\.name/.test(html), '前端未用服务器花名覆盖浏览器旧缓存');
assert(/position: FIXED_POSITION_BY_NAME\[rosterEmployee\.nick \|\| existing\.name\]/.test(html), '岗位映射未跟随服务器最新花名');
console.log('fixed nickname checks passed');
