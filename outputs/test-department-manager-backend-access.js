'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-dept-manager-access-'));
const port = 19043;
const month = '2026年9月';
const empId = 'T001';
const key = empId + '|' + month;
const password = 'shared-system-password';
const signingSecret = 'department-manager-access-secret-0123456789';

fs.writeFileSync(path.join(dataDir, 'assessment_roster.json'), JSON.stringify([{
  id: empId, name: '测试员工', realName: '测试姓名', dept: '信息技术部', position: '开发工程师',
  directMgr: '惜君', hrbp: '薏米', active: true, userId: 'test-user'
}], null, 2));
fs.writeFileSync(path.join(dataDir, 'employee_overrides.json'), '{}');
fs.writeFileSync(path.join(dataDir, 'kpi_target_drafts.json'), JSON.stringify({
  [key]: {
    empId, month, source: 'employee-self-fill', status: 'submitted',
    emp: { name: '测试员工', realName: '测试姓名', dept: '信息技术部', position: '开发工程师', directMgr: '惜君', hrbp: '薏米' },
    kpis: [{ seq: 1, indicator: '系统稳定性', rule: '按计划完成', dataSource: '系统记录', weight: 100 }]
  }
}, null, 2));
fs.writeFileSync(path.join(dataDir, 'selfeval_data.json'), JSON.stringify({
  [key]: {
    empId, month, name: '测试员工', realName: '测试姓名', dept: '信息技术部', position: '开发工程师',
    directMgr: '惜君', hrbp: '薏米', selfScore: 90,
    scores: [{ seq: 1, indicator: '系统稳定性', rule: '按计划完成', dataSource: '系统记录', max: 100, score: 90, completion: '已完成' }]
  }
}, null, 2));
fs.writeFileSync(path.join(dataDir, 'mgrscore_data.json'), JSON.stringify({
  [key]: {
    empId, month, name: '测试员工', realName: '测试姓名', dept: '信息技术部', position: '开发工程师',
    directMgr: '惜君', hrbp: '薏米', selfScore: 90, mgrScore: 92,
    mgrScores: [{ seq: 1, indicator: '系统稳定性', max: 100, selfScore: 90, score: 92, remark: '' }]
  }
}, null, 2));

const child = spawn(process.execPath, [path.join(__dirname, 'eval-server.js')], {
  env: {
    ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password,
    LINK_SIGNING_SECRET: signingSecret, PUBLIC_SERVER_URL: `http://127.0.0.1:${port}`,
    NODE_ENV: 'test', DISABLE_EXTERNAL_NOTIFICATIONS: '1', DINGTALK_APP_KEY: '', DINGTALK_APP_SECRET: '', DINGTALK_ROBOT_CODE: ''
  },
  stdio: 'ignore', windowsHide: true
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('test server did not start');
}

async function login(username) {
  const response = await fetch(`http://127.0.0.1:${port}/admin-login`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, next: '/' })
  });
  assert.equal(response.status, 303);
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, /Max-Age=31536000/);
  return (setCookie.match(/perf_admin_session=[^;]+/) || [''])[0];
}

async function get(pathname, cookie) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    redirect: 'manual', headers: { Accept: 'text/html', ...(cookie ? { Cookie: cookie } : {}) }
  });
}

(async () => {
  try {
    await waitForHealth();
    const loginPage = await get('/login');
    const loginHtml = await loginPage.text();
    assert(loginHtml.includes('部门负责人填写本人花名'));
    assert(loginHtml.includes('后续进入系统和查看归档无需重复输入'));
    assert(!loginHtml.includes('/dingtalk-admin-login'), 'first login must not be bypassed by automatic DingTalk SSO');
    const bypassAttempt = await fetch(`http://127.0.0.1:${port}/dingtalk-admin-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'test-code' })
    });
    assert.equal(bypassAttempt.status, 403, 'DingTalk SSO must not bypass the first password login');

    const leaderCookie = await login('惜君');
    const dashboard = await get('/', leaderCookie);
    assert.equal(dashboard.status, 200);
    const dashboardHtml = await dashboard.text();
    assert(dashboardHtml.includes('"name":"惜君"'));
    assert(dashboardHtml.includes('"canManageManagerStage":true'));
    assert(dashboardHtml.includes('"canManageTargetBpStage":false'));
    assert(dashboardHtml.includes('"canManageResultBpStage":false'));

    const archive = await get('/archive-view?type=kpi&empId=' + empId + '&month=' + encodeURIComponent(month), leaderCookie);
    assert.equal(archive.status, 404, 'archive request must use the existing login cookie instead of prompting again');
    assert.equal(archive.headers.get('www-authenticate'), null);

    assert.equal((await get('/admin-target-manager-page/' + empId + '/' + encodeURIComponent(month), leaderCookie)).status, 200);
    assert.equal((await get('/admin-manager-page/' + empId + '/' + encodeURIComponent(month), leaderCookie)).status, 200);
    assert.equal((await get('/admin-target-bp-page/' + empId + '/' + encodeURIComponent(month), leaderCookie)).status, 403);
    assert.equal((await get('/admin-bp-page/' + empId + '/' + encodeURIComponent(month), leaderCookie)).status, 403);

    const deniedAuthoring = await fetch(`http://127.0.0.1:${port}/generate-kpi-pages`, {
      method: 'POST', headers: { Cookie: leaderCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ pages: [] })
    });
    assert.equal(deniedAuthoring.status, 403, 'department leaders must remain limited to the manager workflow node');

    const adminCookie = await login('admin');
    for (const route of ['/admin-target-manager-page/', '/admin-target-bp-page/', '/admin-manager-page/', '/admin-bp-page/']) {
      assert.equal((await get(route + empId + '/' + encodeURIComponent(month), adminCookie)).status, 200, 'system administrator route failed: ' + route);
    }

    const publicPath = '/target-manager-page/' + Buffer.from(key, 'utf8').toString('base64url');
    const token = crypto.createHmac('sha256', signingSecret).update(publicPath).digest('hex');
    assert.equal((await get(publicPath + '?token=' + token)).status, 200, 'signed manager link must remain usable outside the backend session');
    console.log('department manager login and four-node backend access checks passed without external notifications');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
