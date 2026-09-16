const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-target-adjustment-'));
const port = 19109;
const secret = 'target-adjustment-test-signing-secret';
const month = '2026年9月';
const empId = 'ADJ001';
const unsignedEmpId = 'ADJ002';
const employee = {
  id: empId, userId: 'adjustment-employee-user', name: '调整测试', realName: '调整测试姓名',
  department: '信息技术部', position: '测试岗位', directMgr: '惜君', hrbp: '路得', active: true,
  assessmentStartMonth: '2026年9月'
};
const unsignedEmployee = {
  ...employee, id: unsignedEmpId, userId: 'unsigned-employee-user', name: '未归档测试', realName: '未归档测试姓名'
};
const baselineKpis = [
  { seq: 1, indicator: '原目标A', rule: '原评分标准A', dataSource: '原数据来源A', weight: 60, items: [] },
  { seq: 2, indicator: '原目标B', rule: '原评分标准B', dataSource: '原数据来源B', weight: 40, items: [] }
];
const unsignedKpis = [{ seq: 1, indicator: '未归档目标', rule: '评分标准', dataSource: '数据来源', weight: 100, items: [] }];

fs.writeFileSync(path.join(dataDir, 'assessment_roster.json'), JSON.stringify([employee, unsignedEmployee], null, 2));
fs.writeFileSync(path.join(dataDir, 'roster.json'), JSON.stringify([
  { nick: employee.name, realName: employee.realName, userId: employee.userId, department: employee.department, title: employee.position, active: true },
  { nick: unsignedEmployee.name, realName: unsignedEmployee.realName, userId: unsignedEmployee.userId, department: unsignedEmployee.department, title: unsignedEmployee.position, active: true }
], null, 2));
fs.writeFileSync(path.join(dataDir, 'kpi_targets.json'), JSON.stringify({
  [empId + '|' + month]: { emp: { ...employee, dept: employee.department }, month, kpis: baselineKpis },
  [unsignedEmpId + '|' + month]: { emp: { ...unsignedEmployee, dept: unsignedEmployee.department }, month, kpis: unsignedKpis }
}, null, 2));
fs.writeFileSync(path.join(dataDir, 'kpi_confirm_data.json'), JSON.stringify({
  [empId + '|' + month]: {
    empId, month, name: employee.name, realName: employee.realName,
    doc: '<!doctype html><html><body>原归档目标确认书</body></html>',
    signatureValidated: true, signedAt: '2026-09-01T00:00:00.000Z', archivedAt: '2026-09-01T00:00:00.000Z'
  }
}, null, 2));

const server = spawn(process.execPath, [path.join(__dirname, 'eval-server.js')], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    PORT: String(port), DATA_DIR: dataDir,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password',
    LINK_SIGNING_SECRET: secret, PUBLIC_SERVER_URL: 'http://127.0.0.1:' + port,
    DISABLE_EXTERNAL_NOTIFICATIONS: '1', NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
const base = 'http://127.0.0.1:' + port;
const basicAdmin = 'Basic ' + Buffer.from('admin:test-password').toString('base64');

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
  assert.strictEqual(response.status, 303, 'login failed for ' + name);
  return ((response.headers.get('set-cookie') || '').match(/perf_admin_session=[^;]+/) || [''])[0];
}

function signedPath(pathname) {
  return pathname + '?token=' + crypto.createHmac('sha256', secret).update(pathname).digest('hex');
}

function actionToken(action, subjectId = empId) {
  return crypto.createHmac('sha256', secret)
    .update('/workflow-action/' + action + '/' + encodeURIComponent(subjectId) + '/' + encodeURIComponent(month))
    .digest('hex');
}

async function requestAdjustment(cookie, subjectId = empId) {
  return fetch(base + '/request-target-adjustment', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ empId: subjectId, month })
  });
}

(async () => {
  try {
    await waitUntilReady();

    const technicalAdminResponse = await fetch(base + '/', { headers: { Authorization: basicAdmin } });
    const technicalAdminDashboard = await technicalAdminResponse.text();
    assert.strictEqual(technicalAdminResponse.status, 200);
    assert(technicalAdminDashboard.includes('canInitiateTargetAdjustment":false'), 'technical system administrator must not receive initiation permission');
    assert(technicalAdminDashboard.includes('目标调整申请'), 'KPI detail must expose the target-adjustment control');
    assert(technicalAdminDashboard.includes('color:#dc2626'), 'target-adjustment control must use red text');
    assert(!technicalAdminDashboard.includes('function renderTargetAdjustmentDiffs'), 'KPI detail must show only the current adjusted target');
    const technicalAdminAttempt = await fetch(base + '/request-target-adjustment', {
      method: 'POST', headers: { Authorization: basicAdmin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month })
    });
    assert.strictEqual(technicalAdminAttempt.status, 403, 'technical system administrator is not one of the four initiators');

    const cookies = {};
    for (const adminName of ['桑葚', '薏米', '路得', 'Ben']) {
      cookies[adminName] = await login(adminName);
      const dashboardResponse = await fetch(base + '/', { headers: { Cookie: cookies[adminName] } });
      const dashboard = await dashboardResponse.text();
      assert(dashboard.includes('canInitiateTargetAdjustment":true'), adminName + ' must receive initiation permission');
    }

    const unsignedAttempt = await requestAdjustment(cookies['桑葚'], unsignedEmpId);
    assert.strictEqual(unsignedAttempt.status, 409);
    assert((await unsignedAttempt.text()).includes('尚未完成签字归档'), 'unarchived target must be rejected');

    const signedBefore = JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_confirm_data.json'), 'utf8'))[empId + '|' + month];
    assert(signedBefore.archiveFile, 'startup must materialize the original signed archive');
    const previousArchivePath = path.join(dataDir, signedBefore.archiveFile);
    assert(fs.existsSync(previousArchivePath), 'original archive file must exist');

    const started = await requestAdjustment(cookies['桑葚']);
    const startedBody = await started.json();
    assert.strictEqual(started.status, 200, JSON.stringify(startedBody));
    assert.strictEqual(startedBody.record.status, 'invited');
    assert.strictEqual(startedBody.record.isTargetAdjustment, true);
    assert.deepStrictEqual(startedBody.record.kpis.map(item => item.indicator), ['原目标A', '原目标B'], 'employee must start from the archived target');
    assert(JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_confirm_data.json'), 'utf8'))[empId + '|' + month], 'old signed target must remain active before BP approval');

    const encoded = Buffer.from(empId + '|' + month, 'utf8').toString('base64url');
    const employeePath = '/target-draft-page/' + encoded;
    const employeePage = await fetch(base + signedPath(employeePath));
    const employeeHtml = await employeePage.text();
    assert.strictEqual(employeePage.status, 200);
    assert(employeeHtml.includes('员工调整绩效目标'));
    assert(employeeHtml.includes('原目标A'));
    assert(!employeeHtml.includes('📋 从上月复制'), 'adjustment must not replace the archived baseline with last month');

    const adjustedKpis = [
      { seq: 1, indicator: '调整后目标A', rule: '调整后评分标准A', dataSource: '调整后数据来源A', weight: 70, items: [] },
      { seq: 2, indicator: '调整后新增目标C', rule: '调整后评分标准C', dataSource: '调整后数据来源C', weight: 30, items: [] }
    ];
    const submitted = await fetch(base + '/submit-target-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, actionToken: actionToken('target-draft'), kpis: adjustedKpis })
    });
    assert.strictEqual(submitted.status, 200, await submitted.text());
    let draft = JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_target_drafts.json'), 'utf8'))[empId + '|' + month];
    assert.strictEqual(draft.status, 'submitted');
    assert.strictEqual(draft.targetAdjustments.at(-1).role, 'employee');
    assert(draft.targetAdjustments.at(-1).changes.length > 0, 'employee changes must be recorded');

    const managerPath = '/target-manager-page/' + encoded;
    const managerPage = await fetch(base + signedPath(managerPath));
    const managerHtml = await managerPage.text();
    assert(managerHtml.includes('本轮审批调整记录（调整前后对比）'));
    assert(managerHtml.includes('调整后目标A'));

    const managerAdjustedKpis = [
      { ...adjustedKpis[0], rule: '直属上级补充后的评分标准', weight: 65 },
      { ...adjustedKpis[1], weight: 35 }
    ];
    const managerApproval = await fetch(base + '/review-target-manager', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, actionToken: actionToken('target-manager'), decision: 'approve', kpis: managerAdjustedKpis })
    });
    assert.strictEqual(managerApproval.status, 200, await managerApproval.text());
    assert(JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_confirm_data.json'), 'utf8'))[empId + '|' + month], 'old archive must remain active after manager approval');

    const bpPath = '/target-bp-page/' + encoded;
    const bpPage = await fetch(base + signedPath(bpPath));
    const bpHtml = await bpPage.text();
    assert(bpHtml.includes('本轮审批调整记录（调整前后对比）'));
    assert(bpHtml.includes('直属上级补充后的评分标准'), 'BP must see the manager adjustment made at the preceding approval stage');

    const bpApproval = await fetch(base + '/review-target-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, actionToken: actionToken('target-bp'), decision: 'approve', kpis: managerAdjustedKpis })
    });
    assert.strictEqual(bpApproval.status, 200, await bpApproval.text());
    const storedSigned = JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_confirm_data.json'), 'utf8'));
    assert(!storedSigned[empId + '|' + month], 'old active archive must be retired only after BP approval');
    assert(fs.existsSync(previousArchivePath), 'superseded archive file must remain preserved on disk');
    const formalTarget = JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_targets.json'), 'utf8'))[empId + '|' + month];
    assert.strictEqual(formalTarget.isTargetAdjustment, true);
    assert.strictEqual(formalTarget.kpis[0].indicator, '调整后目标A');
    assert.strictEqual(formalTarget.kpis[0].rule, '直属上级补充后的评分标准');
    assert.strictEqual(formalTarget.previousTargetArchives[0].archiveFile, signedBefore.archiveFile);
    assert(formalTarget.targetAdjustments.some(item => item.role === 'employee'), 'formal target must retain employee change history');

    const confirmationPath = '/kpi-confirm-page/' + encoded;
    const confirmationPage = await fetch(base + signedPath(confirmationPath));
    const confirmationHtml = await confirmationPage.text();
    assert.strictEqual(confirmationPage.status, 200);
    assert(confirmationHtml.includes('调整后目标A'));
    assert(!confirmationHtml.includes('本轮审批调整记录（调整前后对比）'), 'final confirmation must show only the approved target');

    console.log('archived KPI target adjustment permission, review, diff, preservation, and re-archive checks passed');
  } finally {
    server.kill('SIGTERM');
    if (path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()))) fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
