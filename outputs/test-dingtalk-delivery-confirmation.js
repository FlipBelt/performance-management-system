const assert = require('assert');
const { createDingTalkSender } = require('./dingtalk-sender');

process.env.DINGTALK_APP_KEY = 'test-app-key';
process.env.DINGTALK_APP_SECRET = 'test-app-secret';
process.env.DINGTALK_AGENT_ID = '123456';
delete process.env.DINGTALK_ROBOT_CODE;

function response(data) {
  return { ok: true, json: async () => data };
}

async function runCase(sendResult, progress) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/oauth2/accessToken')) return response({ accessToken: 'token', expireIn: 7200 });
    if (String(url).includes('/asyncsend_v2')) return response({ errcode: 0, task_id: 987 });
    if (String(url).includes('/getsendprogress')) return response({ errcode: 0, result: progress || { status: 2, progress_in_percent: 100 } });
    if (String(url).includes('/getsendresult')) return response({ errcode: 0, result: { send_result: sendResult } });
    throw new Error('Unexpected URL: ' + url);
  };
  const sender = createDingTalkSender({ baseDir: __dirname, fetch, deliveryPollAttempts: 1, deliveryPollIntervalMs: 0 });
  return { delivery: await sender.sendText('U1', '测试', '消息'), calls };
}

async function runRobotPreferredCase() {
  process.env.DINGTALK_ROBOT_CODE = 'test-app-key';
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body || '' });
    if (String(url).includes('/oauth2/accessToken')) return response({ accessToken: 'token', expireIn: 7200 });
    if (String(url).includes('/v1.0/robot/oToMessages/batchSend')) return response({ processQueryKey: 'robot-receipt-1' });
    throw new Error('Unexpected URL: ' + url);
  };
  const sender = createDingTalkSender({ baseDir: __dirname, fetch });
  const delivery = await sender.sendText('U1', '机器人测试', '消息');
  return { delivery, status: sender.status(), calls };
}

(async () => {
  const confirmed = await runCase({ unread_user_id_list: ['U1'] });
  assert.strictEqual(confirmed.delivery.sent, true);
  assert.strictEqual(confirmed.delivery.confirmed, true);
  assert.strictEqual(confirmed.delivery.deliveryState, 'unread');
  assert(confirmed.calls.some((url) => url.includes('/getsendresult')));

  const laggingProgress = await runCase({ unread_user_id_list: ['U1'] }, { status: 1, progress_in_percent: 20 });
  assert.strictEqual(laggingProgress.delivery.sent, true);
  assert.strictEqual(laggingProgress.delivery.deliveryState, 'unread');

  const rejected = await runCase({ forbidden_user_id_list: ['U1'], forbidden_list: [{ userid: 'U1', code: '143106', count: 1 }] });
  assert.strictEqual(rejected.delivery.sent, false);
  assert.strictEqual(rejected.delivery.permanent, true);
  assert.match(rejected.delivery.error, /重复消息/);

  const robot = await runRobotPreferredCase();
  assert.strictEqual(robot.delivery.sent, true);
  assert.strictEqual(robot.delivery.channel, 'robot-openapi');
  assert.strictEqual(robot.status.channel, 'robot-openapi');
  assert(robot.calls.some((call) => call.url.includes('/v1.0/robot/oToMessages/batchSend')));
  assert(!robot.calls.some((call) => call.url.includes('/asyncsend_v2')));
  const robotRequest = JSON.parse(robot.calls.find((call) => call.url.includes('/batchSend')).body);
  assert.strictEqual(robotRequest.robotCode, 'test-app-key');
  assert.deepStrictEqual(robotRequest.userIds, ['U1']);

  console.log('dingtalk delivery confirmation tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
