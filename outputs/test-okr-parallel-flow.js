const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { validateObjectives, validateWeeklyObjectives, GRADE_COEFFICIENTS, ELIGIBLE } = require('./okr-module');

assert.deepStrictEqual(Object.keys(ELIGIBLE).sort(), ['俊俊', '廿一'].sort());
assert.deepStrictEqual(ELIGIBLE['俊俊'], {
  empId: 'E031', realName: '廉峻', dept: '兴趣电商', position: '兴趣电商负责人', directMgr: '豪杰', hrbp: '薏米'
});
assert.deepStrictEqual(GRADE_COEFFICIENTS, {
  'S+': 400, S: 300, 'S-': 220, 'A+': 170, A: 130, 'A-': 100,
  'B+': 50, B: 30, 'B-': 0, C: 0, D: 0
});

const validObjectives = [{
  title: '提升品牌销量', weight: 60,
  keyResults: [
    { result: '完成新品战役', weight: 40 },
    { result: '改善投放效率', weight: 20 }
  ]
}, {
  title: '团队标准化', weight: 40,
  keyResults: [{ result: '完成SOP', weight: 40 }]
}];

const validWeeklyObjectives = [
  { week: 1, label: '第一周', objectives: [
    { title: '完成上市方案', weight: 60, keyResults: [{ result: '方案通过评审', weight: 40 }, { result: '排期锁定', weight: 20 }] },
    { title: '准备投放素材', weight: 40, keyResults: [{ result: '交付三套素材', weight: 40 }] }
  ] },
  { week: 2, label: '第二周', objectives: [{ title: '完成上线', weight: 100, keyResults: [{ result: '按期上线', weight: 100 }] }] },
  { week: 3, label: '第三周', objectives: [] },
  { week: 4, label: '第四周', objectives: [] },
  { week: 5, label: '第五周', objectives: [] }
];
const updatedWeeklyObjectives = JSON.parse(JSON.stringify(validWeeklyObjectives));
updatedWeeklyObjectives[0].objectives[0].title = '完成上市方案（周度更新）';
updatedWeeklyObjectives[0].objectives[0].keyResults[0].result = '方案通过周度更新评审';

const normalizedObjectives = validateObjectives(validObjectives);
assert.strictEqual(normalizedObjectives.length, 2);
const normalizedWeekly = validateWeeklyObjectives(validWeeklyObjectives);
assert.strictEqual(normalizedWeekly.length, 5);
assert.strictEqual(normalizedWeekly[0].objectives.length, 2);
assert.strictEqual(normalizedWeekly[0].objectives[0].keyResults.length, 2);
assert.strictEqual(normalizedWeekly[4].label, '第五周');
assert.throws(() => validateObjectives([{ ...validObjectives[0], weight: 50 }]), /KR权重合计必须等于O权重/);
assert.throws(() => validateWeeklyObjectives([{ week: 1, objectives: [{ title: '只有O', weight: 100, keyResults: [] }] }]), /至少填写一条KR/);
assert.throws(() => validateWeeklyObjectives([{ week: 1, objectives: [{ title: '权重不平', weight: 100, keyResults: [{ result: 'KR', weight: 90 }] }] }]), /KR权重合计必须等于O权重/);

const baseDir = __dirname;
const html = fs.readFileSync(path.join(baseDir, 'preview.html'), 'utf8');
assert(!html.includes('<span class="tab-label">OKR管理</span>'));
assert(html.includes("const OKR_EMPLOYEE_NAMES = new Set(['俊俊', '廿一'])"));
assert(html.includes("${e.name}${isOkrEmployee ? ' KPI' : ''}"));
assert(html.includes('${e.name} OKR'));
assert(html.includes("state.selectedKpiMode === 'okr'"));
assert(html.includes("fetch(SYNC_SERVER_URL + '/okr-data')"));
assert(html.includes('月度 O / KR'));
assert(html.includes('周度 O / KR'));
assert(html.includes('OKR等级由直属上级评定、BP复核'));
assert(html.includes('查看OKR目标归档'));
assert(html.includes('查看OKR结果归档'));
assert(html.includes('填写/更新周度O/KR'));
assert(html.includes('record?.operationalWeeklyObjectives'));
assert(html.includes('data-okr-send-self'));
assert(html.includes("fetch(SYNC_SERVER_URL + '/okr-send-self-review',"));
assert(!html.includes('const gradeGuide ='));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-okr-flow-'));
const port = 19038;
const secret = 'okr-test-signing-secret-that-is-long-enough';
const admin = 'Basic ' + Buffer.from('admin:test-password').toString('base64');
// Use only the dedicated test employee and explicitly strip all DingTalk
// credentials so automated tests can never contact real employees or managers.
const empId = 'E031';
const month = '2026年9月';
const child = spawn(process.execPath, [path.join(baseDir, 'eval-server.js')], {
  env: {
    ...process.env,
    PORT: String(port), DATA_DIR: dataDir, LINK_SIGNING_SECRET: secret,
    ADMIN_PASSWORD: 'test-password', NODE_ENV: 'test', SIGNING_OTP_TEST_CODE: '123456',
    PUBLIC_SERVER_URL: 'http://127.0.0.1:' + port,
    DISABLE_EXTERNAL_NOTIFICATIONS: '1',
    DINGTALK_APP_KEY: '', DINGTALK_APP_SECRET: '', DINGTALK_CORP_ID: '', DINGTALK_ROBOT_CODE: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let childOutput = '';
child.stdout.on('data', chunk => { childOutput += chunk; });
child.stderr.on('data', chunk => { childOutput += chunk; });

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname,
      method: options.method || 'GET', headers: options.headers || {}
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
    req.setTimeout(5000, () => req.destroy(new Error('request timed out: ' + pathname + '\n' + childOutput)));
  });
}

function signedPath(pathname) {
  return pathname + '?token=' + crypto.createHmac('sha256', secret).update(pathname).digest('hex');
}
function actionToken(action) {
  return crypto.createHmac('sha256', secret)
    .update('/workflow-action/' + action + '/' + encodeURIComponent(empId) + '/' + encodeURIComponent(month))
    .digest('hex');
}
function encoded() { return Buffer.from(empId + '|' + month, 'utf8').toString('base64url'); }
async function action(actionName, extra = {}) {
  return request('/okr-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empId, month, action: actionName, actionToken: actionToken(actionName), ...extra })
  });
}

(async () => {
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try { if ((await request('/healthz')).status === 200) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (child.exitCode != null) throw new Error('test server exited early (' + child.exitCode + '):\n' + childOutput);

    const adminPage = await request('/okr-admin', { headers: { Authorization: admin, Accept: 'text/html' } });
    assert.strictEqual(adminPage.status, 200);
    assert(adminPage.body.includes('俊俊、廿一每月同时参加KPI与OKR'));
    assert(!adminPage.body.includes('薏米（杨文娟）'), '薏米 must not appear as an OKR participant');
    assert(adminPage.body.includes('评级由直属上级评定、BP复核'));
    assert(!adminPage.body.includes('OKR等级与独立奖金发放系数'));

    const early = await request('/okr-invite', {
      method: 'POST', headers: { Authorization: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month: '2026年8月' })
    });
    assert.strictEqual(early.status, 400);

    const invite = await request('/okr-invite', {
      method: 'POST', headers: { Authorization: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month })
    });
    assert.strictEqual(invite.status, 200, invite.body);
    const invited = JSON.parse(invite.body);
    assert.strictEqual(invited.alreadyInvited, false);
    assert.strictEqual(invited.record.status, 'invited');
    const duplicateInvite = await request('/okr-invite', {
      method: 'POST', headers: { Authorization: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month })
    });
    assert.strictEqual(duplicateInvite.status, 200, duplicateInvite.body);
    const duplicateInviteResult = JSON.parse(duplicateInvite.body);
    assert.strictEqual(duplicateInviteResult.alreadyInvited, true);
    assert.strictEqual(duplicateInviteResult.record.invitedAt, invited.record.invitedAt);
    const prematureWeeklySave = await action('okr-weekly-save', { weeklyObjectives: validWeeklyObjectives });
    assert.strictEqual(prematureWeeklySave.status, 400);

    const fillPath = '/okr-fill/' + encoded();
    const fillPage = await request(signedPath(fillPath));
    assert.strictEqual(fillPage.status, 200);
    const inlineScript = (fillPage.body.match(/<script>([\s\S]*)<\/script>/) || [])[1];
    assert(inlineScript, 'OKR form must include its interactive script');
    new Function(inlineScript);
    assert(fillPage.body.includes('填写每月OKR目标'));
    assert(fillPage.body.includes('从上月复制'));
    assert(!fillPage.body.includes('class="input kr-criteria"'));
    assert(!fillPage.body.includes('class="input kr-source"'));
    assert(!fillPage.body.includes('class="input kr-measures"'));
    assert(fillPage.body.includes('O（月度）'));
    assert(fillPage.body.includes('KR（月度）'));
    assert(fillPage.body.includes('const WEEKS=["第一周","第二周","第三周","第四周","第五周"]'));
    assert(fillPage.body.includes('O（${label}）') && fillPage.body.includes('KR（${label}）'));
    assert(fillPage.body.includes('＋增加O（${label}）'));
    assert(fillPage.body.includes('＋增加KR</button>'));
    assert(!fillPage.body.includes('＋增加KR（${label}）'));
    assert(fillPage.body.includes('class="input week-o-weight"'));
    assert(fillPage.body.includes('class="input week-kr-weight"'));
    assert(fillPage.body.includes('第五周按当月实际情况填写'));
    assert(fillPage.body.includes('>删除KR（月度）</button>'));
    assert(!fillPage.body.includes('>×</button>'));
    assert(!fillPage.body.includes('KPI（月度）'));

    const invalid = await action('okr-target-submit', {
      objectives: [{ title: '无效', weight: 100, keyResults: [{ result: 'KPI', weight: 90 }] }]
    });
    assert.strictEqual(invalid.status, 400);

    let response = await action('okr-target-submit', { objectives: validObjectives, weeklyObjectives: validWeeklyObjectives });
    assert.strictEqual(response.status, 200, response.body);
    let record = JSON.parse((await request('/okr-data', { headers: { Authorization: admin } })).body)[empId + '|' + month];
    assert.strictEqual(record.weeklyObjectives[0].objectives[0].keyResults[1].result, '排期锁定');
    assert.strictEqual(record.weeklyObjectives[1].objectives[0].title, '完成上线');
    const weeklyPath = '/okr-weekly-fill/' + encoded();
    const weeklyPage = await request(signedPath(weeklyPath));
    assert.strictEqual(weeklyPage.status, 200, weeklyPage.body);
    assert(weeklyPage.body.includes('填写/更新OKR周度计划'));
    assert(weeklyPage.body.includes('保存周度O/KR'));
    assert(weeklyPage.body.includes('不改变当前审批节点'));
    assert(weeklyPage.body.includes('月度OKR参考（只读）'));
    assert(weeklyPage.body.includes('提升品牌销量'));
    assert(weeklyPage.body.includes('完成新品战役'));
    assert(weeklyPage.body.includes('用于制定周度计划，不随周度内容修改'));
    const weeklyInlineScript = (weeklyPage.body.match(/<script>([\s\S]*)<\/script>/) || [])[1];
    assert(weeklyInlineScript, 'weekly OKR page must include its interactive script');
    new Function(weeklyInlineScript);
    response = await action('okr-weekly-save', { weeklyObjectives: updatedWeeklyObjectives });
    assert.strictEqual(response.status, 200, response.body);
    assert.strictEqual(JSON.parse(response.body).status, 'target_submitted', 'weekly save must not advance the workflow');
    assert.strictEqual(JSON.parse(response.body).notification, null, 'weekly save must not send a notification');
    record = JSON.parse((await request('/okr-data', { headers: { Authorization: admin } })).body)[empId + '|' + month];
    assert.strictEqual(record.weeklyObjectives[0].objectives[0].title, '完成上市方案', 'approved target weekly data must remain unchanged');
    assert.strictEqual(record.operationalWeeklyObjectives[0].objectives[0].title, '完成上市方案（周度更新）');
    assert.strictEqual(record.weeklyUpdates.length, 1);
    response = await action('okr-target-manager', { objectives: validObjectives, weeklyObjectives: validWeeklyObjectives });
    assert.strictEqual(response.status, 200, response.body);
    response = await action('okr-target-bp', { objectives: validObjectives, weeklyObjectives: validWeeklyObjectives });
    assert.strictEqual(response.status, 200, response.body);
    const confirmPath = '/okr-target-confirm/' + encoded();
    const confirmPage = await request(signedPath(confirmPath));
    assert.strictEqual(confirmPage.status, 200);
    assert(confirmPage.body.includes('月度 O / KR'));
    assert(confirmPage.body.includes('第一周 O / KR'));
    assert(confirmPage.body.includes('填写/更新周度O/KR'));
    assert(!confirmPage.body.includes('完成上市方案（周度更新）'), 'target confirmation must retain the approved target snapshot');
    assert(confirmPage.body.includes('发送验证码到本人钉钉'));
    assert(confirmPage.body.includes('signatureCanvas'));
    assert(confirmPage.body.includes('确认签名并归档'));
    assert(confirmPage.body.includes('verifyOtp=document.getElementById("verifyOtp")'));
    const confirmInlineScript = (confirmPage.body.match(/<script>([\s\S]*)<\/script>/) || [])[1];
    assert(confirmInlineScript, 'OKR confirmation page must include its interactive script');
    new Function(confirmInlineScript);
    const pageToken = crypto.createHmac('sha256', secret).update(confirmPath).digest('hex');
    const otpRequest = await request('/okr-sign-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, pagePath: confirmPath, pageToken })
    });
    assert.strictEqual(otpRequest.status, 200, otpRequest.body);
    const challengeId = JSON.parse(otpRequest.body).challengeId;
    const otpVerify = await request('/okr-sign-verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, code: '123456' })
    });
    assert.strictEqual(otpVerify.status, 200, otpVerify.body);
    const verificationToken = JSON.parse(otpVerify.body).verificationToken;
    const signatureMetrics = {
      manuallyDrawn: true, signatureFormat: 'realName', expectedCharacterCount: 2,
      pointCount: 30, strokeCount: 9, pathLength: 300, crossSlotStrokeCount: 0,
      characters: Array.from('廉峻').map(character => ({ character, inkPixels: 100, widthRatio: 0.4, heightRatio: 0.5 }))
    };
    response = await action('okr-target-confirm', {
      verificationToken, signatureText: '廉峻', signatureFormat: 'realName', signatureStyle: '手写楷体',
      signatureMetrics, signatureData: 'data:image/png;base64,' + Buffer.alloc(600, 1).toString('base64')
    });
    assert.strictEqual(response.status, 200, response.body);
    assert.strictEqual(JSON.parse(response.body).status, 'target_confirmed');
    assert.strictEqual(JSON.parse(response.body).notification, null, 'target confirmation must not automatically send self-review');
    const targetArchiveName = fs.readdirSync(path.join(dataDir, 'archives', 'okr-targets')).find(name => name.endsWith('.html'));
    assert(targetArchiveName);
    const targetArchive = fs.readFileSync(path.join(dataDir, 'archives', 'okr-targets', targetArchiveName), 'utf8');
    assert(targetArchive.includes('员工本人签名确认'));
    assert(targetArchive.includes('钉钉验证码已验证'));
    assert(!targetArchive.includes('完成上市方案（周度更新）'), 'target archive must not be changed by weekly operational updates');
    record = JSON.parse(fs.readFileSync(path.join(dataDir, 'okr_workflows.json'), 'utf8'))[empId + '|' + month];
    assert.strictEqual(record.targetSignature.method, 'dingtalk-otp+handwriting');
    assert.strictEqual(record.status, 'target_confirmed');

    const targetArchiveView = await request('/okr-archive-view?type=target&empId=' + encodeURIComponent(empId) + '&month=' + encodeURIComponent(month), { headers: { Authorization: admin } });
    assert.strictEqual(targetArchiveView.status, 200, targetArchiveView.body);
    assert(targetArchiveView.body.includes('OKR目标确认书'));
    assert(targetArchiveView.body.includes('员工本人签名确认'));

    const prematureSelfReview = await action('okr-self-review', { completions: [], summary: '不应提交', grade: 'A' });
    assert.strictEqual(prematureSelfReview.status, 400);
    const sendSelfReview = await request('/okr-send-self-review', {
      method: 'POST', headers: { Authorization: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month })
    });
    assert.strictEqual(sendSelfReview.status, 200, sendSelfReview.body);
    assert.strictEqual(JSON.parse(sendSelfReview.body).status, 'self_review_invited');

    const selfReviewPath = '/okr-self-review/' + encoded();
    const selfReviewPage = await request(signedPath(selfReviewPath));
    assert.strictEqual(selfReviewPage.status, 200, selfReviewPage.body);
    assert(!selfReviewPage.body.includes('class="input weekly-completion-input"'));
    assert(!selfReviewPage.body.includes('data-week="1"'));
    assert(selfReviewPage.body.includes('周度记录不带入本页'));
    assert(!selfReviewPage.body.includes('完成上市方案（周度更新）'));
    assert(!selfReviewPage.body.includes('本人建议等级'));
    assert(!selfReviewPage.body.includes('<h2>OKR等级</h2>'));
    assert(!selfReviewPage.body.includes('id="grade"'));
    assert(selfReviewPage.body.includes('OKR等级由直属上级评定、BP复核'));

    const completions = [
      { objectiveIndex: 0, krIndex: 0, completion: '已完成新品战役' },
      { objectiveIndex: 0, krIndex: 1, completion: 'ROI达标' },
      { objectiveIndex: 1, krIndex: 0, completion: 'SOP已发布' }
    ];
    response = await action('okr-self-review', { completions, summary: '本月OKR整体完成' });
    assert.strictEqual(response.status, 200, response.body);
    record = JSON.parse(fs.readFileSync(path.join(dataDir, 'okr_workflows.json'), 'utf8'))[empId + '|' + month];
    assert.strictEqual(record.selfGrade, undefined);
    assert.strictEqual(record.weeklyObjectives[0].objectives[0].keyResults[0].completion, undefined);
    assert.strictEqual(record.operationalWeeklyObjectives[0].objectives[0].keyResults[0].completion, undefined);
    const managerGradePage = await request(signedPath('/okr-manager-grade/' + encoded()));
    assert.strictEqual(managerGradePage.status, 200, managerGradePage.body);
    assert(!managerGradePage.body.includes('完成上市方案（周度更新）'));
    assert(!managerGradePage.body.includes('周度 O / KR'));
    assert(managerGradePage.body.indexOf('<h2>OKR等级</h2>') > managerGradePage.body.indexOf('id="comment"'), 'manager grade guide must be below the rating inputs');
    response = await action('okr-manager-grade', { grade: 'A+', comment: '达到预期' });
    assert.strictEqual(response.status, 200, response.body);
    const bpGradePage = await request(signedPath('/okr-bp-grade/' + encoded()));
    assert.strictEqual(bpGradePage.status, 200, bpGradePage.body);
    assert(bpGradePage.body.indexOf('<h2>OKR等级</h2>') > bpGradePage.body.indexOf('id="comment"'), 'BP grade guide must be below the rating inputs');
    response = await action('okr-bp-grade', { grade: 'S-', comment: '核定S-' });
    assert.strictEqual(response.status, 200, response.body);
    record = JSON.parse(fs.readFileSync(path.join(dataDir, 'okr_workflows.json'), 'utf8'))[empId + '|' + month];
    assert.strictEqual(record.bpGrade, 'S-');
    assert.strictEqual(record.finalCoefficient, 220);
    assert.strictEqual(record.score, undefined);

    const resultPath = '/okr-result-confirm/' + encoded();
    const resultPage = await request(signedPath(resultPath));
    assert.strictEqual(resultPage.status, 200);
    assert(resultPage.body.includes('单独用于OKR奖金计算，不与KPI系数组合'));
    assert(resultPage.body.includes('提升品牌销量'));
    assert(!resultPage.body.includes('完成上市方案（周度更新）'));
    assert(!resultPage.body.includes('周度 O / KR'));
    assert(resultPage.body.includes('发送验证码到本人钉钉'));
    assert(resultPage.body.includes('本人手写签名'));
    assert(resultPage.body.includes('确认签名并提交BP复核'));
    const resultPageToken = crypto.createHmac('sha256', secret).update(resultPath).digest('hex');
    const resultOtpRequest = await request('/okr-sign-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, pagePath: resultPath, pageToken: resultPageToken })
    });
    assert.strictEqual(resultOtpRequest.status, 200, resultOtpRequest.body);
    const resultChallengeId = JSON.parse(resultOtpRequest.body).challengeId;
    const resultOtpVerify = await request('/okr-sign-verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: resultChallengeId, code: '123456' })
    });
    assert.strictEqual(resultOtpVerify.status, 200, resultOtpVerify.body);
    const resultVerificationToken = JSON.parse(resultOtpVerify.body).verificationToken;
    response = await action('okr-result-confirm', {
      verificationToken: resultVerificationToken, signatureText: '廉峻', signatureFormat: 'realName', signatureStyle: '手写楷体',
      signatureMetrics, signatureData: 'data:image/png;base64,' + Buffer.alloc(600, 2).toString('base64')
    });
    assert.strictEqual(response.status, 200, response.body);
    assert.strictEqual(JSON.parse(response.body).status, 'result_signed_pending_bp');
    assert(!fs.readdirSync(path.join(dataDir, 'archives', 'okr-results')).some(name => name.endsWith('.html')), 'result must wait for BP review before archive');

    const resultBpPath = '/okr-result-bp/' + encoded();
    const resultBpPage = await request(signedPath(resultBpPath));
    assert.strictEqual(resultBpPage.status, 200, resultBpPage.body);
    assert(resultBpPage.body.includes('BP复核OKR结果并归档'));
    assert(resultBpPage.body.includes('员工手写签名'));
    assert(resultBpPage.body.includes('核对无误并归档'));
    response = await action('okr-result-bp-final');
    assert.strictEqual(response.status, 200, response.body);
    assert.strictEqual(JSON.parse(response.body).status, 'result_confirmed');
    assert(fs.readdirSync(path.join(dataDir, 'archives', 'okr-results')).some(name => name.endsWith('.html')));
    const resultArchiveView = await request('/okr-archive-view?type=result&empId=' + encodeURIComponent(empId) + '&month=' + encodeURIComponent(month), { headers: { Authorization: admin } });
    assert.strictEqual(resultArchiveView.status, 200, resultArchiveView.body);
    assert(resultArchiveView.body.includes('OKR结果确认书'));
    assert(resultArchiveView.body.includes('BP复核归档完成'));
    assert(resultArchiveView.body.includes('员工本人签名确认'));
    assert(!childOutput.includes('[dingtalk] Sending'), 'tests must never contact real DingTalk recipients');
    assert(!childOutput.includes('[dingtalk-otp] Sending'), 'tests must never send a real DingTalk OTP');
    console.log('parallel KPI + OKR monthly/weekly workflow checks passed without external notifications');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
