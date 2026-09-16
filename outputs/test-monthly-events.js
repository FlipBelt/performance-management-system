const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const port = 19108;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-monthly-events-'));
fs.writeFileSync(path.join(tempDir, 'assessment_roster.json'), JSON.stringify([
  { id: 'E901', name: '测试花名', realName: '测试姓名', department: '信息技术部', position: '测试岗位', active: true },
  { id: 'E902', name: '财务测试', realName: '财务测试姓名', department: '财务部', position: '财务岗位', active: true }
], null, 2));

const server = spawn(process.execPath, [path.join(__dirname, 'eval-server.js')], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    PORT: String(port), DATA_DIR: tempDir,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password',
    LINK_SIGNING_SECRET: 'monthly-events-test-signing-secret',
    PUBLIC_SERVER_URL: 'http://127.0.0.1:' + port,
    DISABLE_EXTERNAL_NOTIFICATIONS: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
const base = `http://127.0.0.1:${port}`;
const adminAuthorization = 'Basic ' + Buffer.from('admin:test-password').toString('base64');

async function waitUntilReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('test server did not start\n' + output);
}

async function login(name) {
  const response = await fetch(base + '/admin-login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: name, password: 'test-password', next: '/' })
  });
  assert.strictEqual(response.status, 303);
  return ((response.headers.get('set-cookie') || '').match(/perf_admin_session=[^;]+/) || [''])[0];
}

async function adminPost(body) {
  return fetch(base + '/monthly-events', {
    method: 'POST', headers: { Authorization: adminAuthorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

(async () => {
  try {
    await waitUntilReady();
    const dashboardResponse = await fetch(base + '/', { headers: { Authorization: adminAuthorization } });
    const dashboard = await dashboardResponse.text();
    assert.strictEqual(dashboardResponse.status, 200);
    assert(dashboard.includes('每月事件'));
    assert(dashboard.includes('部门'));
    assert(dashboard.includes('花名（姓名）'));
    assert(dashboard.includes('事件概述'));
    assert(dashboard.includes('具体说明'));
    assert(dashboard.includes('data-monthly-event-images'));
    assert(dashboard.includes('data-preview-monthly-event-image'));
    assert(dashboard.includes('renderMonthlyEventImagePreview'));
    assert(!dashboard.includes('<a href="${escapeHtml(image.dataUrl)}"'), 'data URL images must use the in-page preview instead of blocked new-tab navigation');
    assert(dashboard.includes('canManageMonthlyEvents":true'));
    const renderKpiSource = dashboard.match(/function renderKPI\(\) \{([\s\S]*?)\n    function render/);
    const renderEvalSource = dashboard.match(/function renderEvalContent\(\) \{([\s\S]*?)\n    function renderEvalScoring/);
    assert(renderKpiSource && !renderKpiSource[1].includes('renderMonthlyEventsPanel()'), '每月事件不应再显示在KPI目标页');
    assert(renderEvalSource && renderEvalSource[1].includes('renderMonthlyEventsPanel()'), '每月事件应显示在绩效评估页');
    assert(dashboard.includes("event.month === state.evalMonth"), '每月事件应跟随绩效评估月份筛选');
    assert(dashboard.includes("state.evalDeptFilter === '全部' || event.department === state.evalDeptFilter"), '每月事件应跟随绩效评估部门筛选');

    let response = await adminPost({
      action: 'upsert', month: '2026年9月', empId: 'E901', date: '2026-09-11',
      summary: '完成关键系统切换', details: '切换过程正常，未影响现有绩效流程。',
      images: [{ name: 'evidence.png', dataUrl: 'data:image/png;base64,' + Buffer.from('test-image').toString('base64') }]
    });
    assert.strictEqual(response.status, 200, 'monthly event creation failed');
    let result = await response.json();
    assert.strictEqual(result.events.length, 1);
    const event = result.event;
    assert.strictEqual(event.department, '信息技术部');
    assert.strictEqual(event.name, '测试花名');
    assert.strictEqual(event.realName, '测试姓名');
    assert.strictEqual(event.images.length, 1);

    response = await adminPost({
      action: 'upsert', month: '2026年9月', empId: 'E902', date: '2026-09-12',
      summary: '财务部门事件', details: '仅财务部门负责人可查看。', images: []
    });
    assert.strictEqual(response.status, 200, 'second-department monthly event creation failed');
    const financeEvent = (await response.json()).event;

    const persisted = JSON.parse(fs.readFileSync(path.join(tempDir, 'monthly_events.json'), 'utf8'));
    assert.strictEqual(persisted[event.id].summary, '完成关键系统切换');

    const listResponse = await fetch(base + '/monthly-events?month=' + encodeURIComponent('2026年9月'), { headers: { Authorization: adminAuthorization } });
    const list = await listResponse.json();
    assert.strictEqual(list.canEdit, true);
    assert.strictEqual(list.events.length, 2);
    assert.strictEqual(list.events[0].images[0].name, 'evidence.png');

    response = await adminPost({ ...event, action: 'upsert', summary: '完成关键系统切换（已更新）' });
    result = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(result));
    assert.strictEqual(result.event.summary, '完成关键系统切换（已更新）');

    const invalidDate = await adminPost({ ...event, id: '', action: 'upsert', date: '2026-10-01' });
    assert.strictEqual(invalidDate.status, 400);

    const globalAdminCookie = await login('桑葚');
    const forbidden = await fetch(base + '/monthly-events', {
      method: 'POST', headers: { Cookie: globalAdminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id: event.id })
    });
    assert.strictEqual(forbidden.status, 403);
    const globalAdminList = await fetch(base + '/monthly-events?month=' + encodeURIComponent('2026年9月'), { headers: { Cookie: globalAdminCookie } });
    const globalAdminData = await globalAdminList.json();
    assert.strictEqual(globalAdminData.canEdit, false);
    assert.strictEqual(globalAdminData.events.length, 2);

    const itManagerCookie = await login('惜君');
    const itManagerList = await fetch(base + '/monthly-events?month=' + encodeURIComponent('2026年9月'), { headers: { Cookie: itManagerCookie } });
    const itManagerData = await itManagerList.json();
    assert.strictEqual(itManagerData.canEdit, false);
    assert.deepStrictEqual(itManagerData.events.map(item => item.department), ['信息技术部'], '信息技术部负责人不得看到其他部门事件');
    assert(!JSON.stringify(itManagerData).includes('财务部门事件'), 'other-department event contents must not leave the server');

    const financeManagerCookie = await login('安妮');
    const financeManagerList = await fetch(base + '/monthly-events?month=' + encodeURIComponent('2026年9月'), { headers: { Cookie: financeManagerCookie } });
    const financeManagerData = await financeManagerList.json();
    assert.strictEqual(financeManagerData.canEdit, false);
    assert.deepStrictEqual(financeManagerData.events.map(item => item.department), ['财务部'], '财务部负责人不得看到其他部门事件');
    assert(!JSON.stringify(financeManagerData).includes('完成关键系统切换'), 'other-department event contents must not leave the server');

    response = await adminPost({ action: 'delete', id: event.id });
    result = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(result));
    assert.strictEqual(result.events.length, 1);
    response = await adminPost({ action: 'delete', id: financeEvent.id });
    result = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(result));
    assert.strictEqual(result.events.length, 0);
    console.log('monthly events admin-only CRUD, department isolation, month isolation, roster identity, and image preview checks passed');
  } finally {
    server.kill('SIGTERM');
    if (path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()))) fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
