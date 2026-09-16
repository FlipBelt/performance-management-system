'use strict';

const assert = require('assert');
const path = require('path');

const routes = {
  '天猫': { processCode: 'PROC-TM' },
  '京东': { processCode: 'PROC-JD' },
  '兴趣电商': { processCode: 'PROC-EC' }
};
process.env.DINGTALK_OA_ENABLED = 'true';
process.env.DINGTALK_APP_KEY = 'test-key';
process.env.DINGTALK_APP_SECRET = 'test-secret';
process.env.DINGTALK_OA_AGENT_ID = '123';
process.env.DINGTALK_OA_ORIGINATOR_USER_ID = 'originator';
process.env.DINGTALK_OA_PROCESS_ROUTES_B64 = Buffer.from(JSON.stringify(routes), 'utf8').toString('base64');

const { createDingTalkOaClient } = require('./dingtalk-oa');
const client = createDingTalkOaClient({ baseDir: path.join(__dirname, 'missing-config-directory') });
assert.strictEqual(client.status().ready, true);
assert.strictEqual(client.status().processRouteCount, 3);

Promise.all([
  client.getProcessCode({ processName: '默认', processCode: routes['天猫'].processCode }),
  client.getProcessCode({ processName: '默认', processCode: routes['京东'].processCode })
]).then(values => {
  assert.deepStrictEqual(values, ['PROC-TM', 'PROC-JD']);
  console.log('DingTalk OA environment route configuration passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
