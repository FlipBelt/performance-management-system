const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const baseDir = __dirname;
const dashboardHtml = fs.readFileSync(path.join(baseDir, 'preview.html'), 'utf8');
assert(dashboardHtml.includes("targetDraft.status === 'rejected' ? `<button"), 'waiting-for-employee state must not duplicate the resend-invitation control in the header');
const targetModeBlock = dashboardHtml.slice(dashboardHtml.indexOf('目标制定方式'), dashboardHtml.indexOf('if (empKpis.length === 0)'));
assert(!targetModeBlock.includes('data-workflow-reminder'), 'target-mode card must not duplicate the reminder control from the bottom action bar');
assert(!targetModeBlock.includes('targetDraftLabels[targetDraft.status]'), 'target-mode card must not duplicate the workflow badge from the header');
assert(dashboardHtml.includes('justify-content:center;gap:8px;flex-wrap:wrap'), 'takeover actions must be centered in the waiting-state content area');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-target-flow-'));
const port = 18987;
const secret = 'test-link-signing-secret-that-is-long-enough';
const empId = 'TEST001';
const month = '2026年8月';
const previousMonth = '2026年7月';
const encoded = Buffer.from(empId + '|' + month, 'utf8').toString('base64url');
const record = {
  empId, month, source: 'employee-self-fill', status: 'invited', invitedAt: new Date().toISOString(),
  emp: { name: '测试员工', realName: '测试姓名', dept: '测试部', position: '测试岗', directMgr: '测试上级', hrbp: '测试BP' },
  kpis: [{ seq: 1, indicator: '交付质量', rule: '按期且无重大错误', dataSource: '项目验收记录', weight: 100, items: [] }]
};
const customerEmpId = 'TESTCS001';
const customerRecord = {
  empId: customerEmpId, month, source: 'employee-self-fill', status: 'invited', invitedAt: new Date().toISOString(),
  emp: { name: '客服员工', realName: '客服姓名', dept: '客户运营部', position: '客服专员', directMgr: '客服上级', hrbp: '测试BP' },
  kpis: []
};
const takeoverEmpId = 'TESTTAKEOVER001';
const takeoverRecord = {
  empId: takeoverEmpId, month, source: 'employee-self-fill', status: 'invited', invitedAt: new Date().toISOString(),
  emp: { name: '切换员工', realName: '切换姓名', dept: '测试部', position: '测试岗', directMgr: '测试上级', hrbp: '测试BP' },
  kpis: []
};
fs.writeFileSync(path.join(dataDir, 'kpi_target_drafts.json'), JSON.stringify({
  [empId + '|' + month]: record,
  [customerEmpId + '|' + month]: customerRecord,
  [takeoverEmpId + '|' + month]: takeoverRecord
}), 'utf8');
const legacyEmpId = 'TEST003';
const legacyTarget = {
  emp: { name: '旧版员工', realName: '旧版姓名', dept: '测试部', position: '测试岗', directMgr: '测试上级', hrbp: '测试BP' },
  month,
  kpis: [{ seq: 1, indicator: '旧版指标', rule: '旧版评分细则', dataSource: '旧版数据源', weight: 100, items: [] }]
};
const previousTarget = {
  emp: record.emp,
  month: previousMonth,
  kpis: [{ seq: 1, indicator: '上月交付目标', rule: '上月评分细则', dataSource: '上月验收记录', weight: 100, items: [] }]
};
fs.writeFileSync(path.join(dataDir, 'kpi_targets.json'), JSON.stringify({
  [legacyEmpId + '|' + month]: legacyTarget,
  [empId + '|' + previousMonth]: previousTarget
}), 'utf8');
fs.writeFileSync(path.join(dataDir, 'assessment_roster.json'), JSON.stringify([{
  id: legacyEmpId, userId: 'legacy-user-id', name: '旧版员工', realName: '旧版姓名',
  department: '测试部', position: '测试岗', active: true, assessmentStartMonth: '2026年6月'
}]), 'utf8');
fs.writeFileSync(path.join(dataDir, 'roster.json'), JSON.stringify([
  { nick: '旧版员工', realName: '旧版姓名', userId: 'legacy-user-id', department: '测试部', title: '测试岗', active: true }
]), 'utf8');

const child = spawn(process.execPath, [path.join(baseDir, 'eval-server.js')], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, LINK_SIGNING_SECRET: secret, ADMIN_PASSWORD: 'test-password', NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe']
});

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: options.headers || {} }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function signedPath(pathname) {
  const token = crypto.createHmac('sha256', secret).update(pathname).digest('hex');
  return pathname + '?token=' + token;
}

function actionToken(action, subjectId = empId, subjectMonth = month) {
  return crypto.createHmac('sha256', secret)
    .update('/workflow-action/' + action + '/' + encodeURIComponent(subjectId) + '/' + encodeURIComponent(subjectMonth))
    .digest('hex');
}

function checkInlineScripts(html, label) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert(scripts.length > 0, label + ' should contain a script');
  scripts.forEach(match => new Function(match[1]));
}

(async () => {
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const health = await request('/healthz');
        if (health.status === 200) break;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const canonicalLegacyId = JSON.parse(fs.readFileSync(path.join(dataDir, 'assessment_roster.json'), 'utf8'))
      .find(employee => employee && employee.realName === legacyTarget.emp.realName).id;
    const employeePath = '/target-draft-page/' + encoded;
    const employeePage = await request(signedPath(employeePath));
    assert.strictEqual(employeePage.status, 200);
    assert(employeePage.body.includes('员工填写绩效目标'));
    assert(employeePage.body.includes('📋 从上月复制'), 'employee target page must expose the previous-month copy action');
    assert(employeePage.body.includes('const PREVIOUS_MONTH="2026年7月"'), 'copy action must resolve the previous assessment month');
    assert(employeePage.body.includes('上月交付目标'), 'copy action must preload the employee\'s own previous-month target snapshot');
    assert(employeePage.body.includes('复制将替换当前尚未提交的填写内容'), 'copy action must protect unsaved current input from accidental replacement');
    assert(employeePage.body.includes('function snapshotRows()'), 'adding/removing target rows must preserve current form values');
    assert(employeePage.body.includes('snapshotRows();INITIAL.push'), 'add target action must snapshot existing rows before rendering');
    assert(employeePage.body.includes('target-form-layout-upgrade'), 'employee target page must include the wider target form layout');
    assert(employeePage.body.includes('minmax(420px,2.2fr)'), 'scoring-rule column must receive the largest share of the row');
    assert(employeePage.body.includes('minmax(86px,.42fr)'), 'weight column must remain compact');
    assert(employeePage.body.includes('.row>div:first-child,.row>div:nth-child(4)'), 'indicator and weight controls must be vertically centered');
    assert(employeePage.body.includes('.row>div:first-child>.label,.row>div:nth-child(4)>.label{position:absolute;top:0;left:0}'), 'all four field labels must share the same top baseline');
    assert(employeePage.body.includes('button.textContent="删除"'), 'delete control must use a clear text label');
    assert(employeePage.body.includes('input.source'), 'employee target page must upgrade data-source inputs to multiline fields');
    assert(employeePage.body.includes('target-form-autosize'), 'employee target page must auto-size rule and data-source textareas');
    assert(employeePage.body.includes('const MIN_WEIGHT=1;'), 'ordinary departments must continue to require positive item weights');
    const takeover = await request('/withdraw-target-invitation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from('admin:test-password').toString('base64')
      },
      body: JSON.stringify({ empId: takeoverEmpId, month })
    });
    assert.strictEqual(takeover.status, 200, takeover.body);
    assert.strictEqual(JSON.parse(takeover.body).status, 'withdrawn');
    const draftsAfterTakeover = JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_target_drafts.json'), 'utf8'));
    assert(!draftsAfterTakeover[takeoverEmpId + '|' + month], 'withdrawn invitation must be removed so backend authoring can resume');
    checkInlineScripts(employeePage.body, 'employee target page');

    const customerEncoded = Buffer.from(customerEmpId + '|' + month, 'utf8').toString('base64url');
    const customerEmployeePath = '/target-draft-page/' + customerEncoded;
    const customerEmployeePage = await request(signedPath(customerEmployeePath));
    assert.strictEqual(customerEmployeePage.status, 200);
    assert(customerEmployeePage.body.includes('const MIN_WEIGHT=0;'), 'customer service target page must allow zero-weight items');
    assert(customerEmployeePage.body.includes('min="${MIN_WEIGHT}"'), 'employee target form must bind the department-specific minimum');

    const standardZeroWeight = await request('/submit-target-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empId, month, actionToken: actionToken('target-draft'),
        kpis: [
          { indicator: '普通部门零权重项', rule: '规则A', dataSource: '来源A', weight: 0 },
          { indicator: '普通部门主指标', rule: '规则B', dataSource: '来源B', weight: 100 }
        ]
      })
    });
    assert.strictEqual(standardZeroWeight.status, 400);
    assert(standardZeroWeight.body.includes('权重必须为1至100的整数'));

    const customerZeroWeight = await request('/submit-target-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empId: customerEmpId, month, actionToken: actionToken('target-draft', customerEmpId),
        kpis: [
          { indicator: '服务观察项', rule: '记录服务表现，不计入得分', dataSource: '客服质检记录', weight: 0 },
          { indicator: '服务质量', rule: '按服务质量评分', dataSource: '客服质量报表', weight: 100 }
        ]
      })
    });
    assert.strictEqual(customerZeroWeight.status, 200, customerZeroWeight.body);
    const customerManagerPath = '/target-manager-page/' + customerEncoded;
    const customerManagerPage = await request(signedPath(customerManagerPath));
    assert.strictEqual(customerManagerPage.status, 200);
    assert(customerManagerPage.body.includes('min="0" max="100"'), 'manager review must preserve zero-weight customer service items');

    const managerPath = '/target-manager-page/' + encoded;
    const managerPage = await request(signedPath(managerPath));
    assert.strictEqual(managerPage.status, 200);
    assert(managerPage.body.includes('直属上级确认员工绩效目标'));
    assert(managerPage.body.includes('textarea rows="4" class="input source autosize"'), 'manager review data source must be multiline');
    assert(managerPage.body.includes('target-form-layout-upgrade'), 'manager review must use the widened layout');
    checkInlineScripts(managerPage.body, 'manager target review page');

    const bpPath = '/target-bp-page/' + encoded;
    const bpPage = await request(signedPath(bpPath));
    assert.strictEqual(bpPage.status, 200);
    assert(bpPage.body.includes('BP确认员工绩效目标'));
    assert(bpPage.body.includes('textarea rows="4" class="input source autosize"'), 'BP review data source must be multiline');
    checkInlineScripts(bpPage.body, 'BP target review page');

    const invalidAction = crypto.createHmac('sha256', secret)
      .update('/workflow-action/target-draft/' + encodeURIComponent(empId) + '/' + encodeURIComponent(month)).digest('hex');
    const invalid = await request('/submit-target-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, actionToken: invalidAction, kpis: [{ indicator: 'A', rule: 'B', dataSource: 'C', weight: 90 }] })
    });
    assert.strictEqual(invalid.status, 400);
    assert(invalid.body.includes('权重合计必须为100%'));

    const submitted = await request('/submit-target-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, actionToken: actionToken('target-draft'), kpis: record.kpis })
    });
    assert.strictEqual(submitted.status, 200);

    const managerEditablePage = await request(signedPath(managerPath));
    assert(managerEditablePage.body.includes('id="addReviewRow"'), 'manager review must allow adding a KPI row');
    assert(managerEditablePage.body.includes('class="btn row-remove"'), 'manager review must allow deleting a KPI row');
    const managerAdjustedKpis = [
      { ...record.kpis[0], rule: '直属上级调整后的评分细则', weight: 60 },
      { indicator: '直属上级新增指标', rule: '新增指标评分细则', dataSource: '新增指标数据源', weight: 40 }
    ];
    const managerAdjustment = await request('/adjust-target-review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, role: 'manager', actionToken: actionToken('target-manager'), kpis: managerAdjustedKpis })
    });
    assert.strictEqual(managerAdjustment.status, 200, managerAdjustment.body);
    assert.strictEqual(JSON.parse(managerAdjustment.body).changed, true);
    const employeeAfterManagerAdjustment = await request(signedPath(employeePath));
    assert(!employeeAfterManagerAdjustment.body.includes('本轮审批调整记录（调整前后对比）'), 'employee page should show only the current adjusted target');
    assert(employeeAfterManagerAdjustment.body.includes('直属上级调整后的评分细则'));
    assert(!employeeAfterManagerAdjustment.body.includes('<th>调整前</th>'), 'employee page must not expose the before/after comparison table');
    assert(employeeAfterManagerAdjustment.body.includes('直属上级新增指标'), 'employee page must show the latest adjusted KPI rows');

    const prematureBpApproval = await request('/review-target-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, actionToken: actionToken('target-bp'), decision: 'approve' })
    });
    assert.strictEqual(prematureBpApproval.status, 400);
    assert(prematureBpApproval.body.includes('尚未完成直属上级确认'));

    const managerApproval = await request('/review-target-manager', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, actionToken: actionToken('target-manager'), decision: 'approve', kpis: managerAdjustedKpis })
    });
    assert.strictEqual(managerApproval.status, 200);
    assert.strictEqual(JSON.parse(managerApproval.body).status, 'manager_approved');

    const bpPageAfterManagerAdjustment = await request(signedPath(bpPath));
    assert(bpPageAfterManagerAdjustment.body.includes('直属上级调整后的评分细则'), 'BP must see the manager adjustment diff');
    assert(bpPageAfterManagerAdjustment.body.includes('本轮审批调整记录（调整前后对比）'), 'BP must see upstream adjustment history');
    assert(bpPageAfterManagerAdjustment.body.includes('id="addReviewRow"'), 'BP review must allow adding a KPI row');
    assert(bpPageAfterManagerAdjustment.body.includes('class="btn row-remove"'), 'BP review must allow deleting a KPI row');

    const bpAdjustedKpis = [{ ...managerAdjustedKpis[0], dataSource: 'BP调整后的数据来源', weight: 100 }];
    const bpAdjustment = await request('/adjust-target-review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, role: 'bp', actionToken: actionToken('target-bp'), kpis: bpAdjustedKpis })
    });
    assert.strictEqual(bpAdjustment.status, 200, bpAdjustment.body);
    const bpAdjustmentResult = JSON.parse(bpAdjustment.body);
    assert.strictEqual(bpAdjustmentResult.changed, true);
    assert(bpAdjustmentResult.changes.some(change => change.field === '删除指标'), 'review history must identify a deleted KPI row');
    const managerAfterBpAdjustment = await request(signedPath(managerPath));
    assert(managerAfterBpAdjustment.body.includes('BP调整后的数据来源'), 'manager must see the BP adjustment diff');

    const approval = await request('/review-target-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, actionToken: actionToken('target-bp'), decision: 'approve', kpis: bpAdjustedKpis })
    });
    assert.strictEqual(approval.status, 200);
    const approvalResult = JSON.parse(approval.body);
    assert.strictEqual(approvalResult.targetSignatureRequired, true);
    assert.strictEqual(approvalResult.manualSelfEvaluationRequiredAfterSignature, true);
    assert(approvalResult.notification, 'BP approval should attempt to notify the employee to sign the target');

    const storedTargets = JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_targets.json'), 'utf8'));
    assert(storedTargets[empId + '|' + month].managerApprovedAt, 'official target must preserve manager approval evidence');
    assert.strictEqual(storedTargets[empId + '|' + month].targetAdjustments.length, 2, 'official target must preserve all reviewer adjustments');

    const confirmationPath = '/kpi-confirm-page/' + encoded;
    const confirmationPage = await request(signedPath(confirmationPath));
    assert.strictEqual(confirmationPage.status, 200);
    assert(confirmationPage.body.includes('KPI目标确认书'));
    assert(confirmationPage.body.includes('<title>KPI目标确认书 - 测试员工 - 2026年8月</title>'), 'embedded signed document title must use the current employee and assessment month');
    assert(confirmationPage.body.includes('<div class="workflow-reminder-grid">'));
    assert(confirmationPage.body.includes('>评分标准<'));
    assert(confirmationPage.body.includes('当月缺勤≥10天'));
    assert(!confirmationPage.body.includes('本轮审批调整记录（调整前后对比）'), 'final confirmation should contain only the approved target');
    assert(confirmationPage.body.includes('BP调整后的数据来源'));

    const otpValidation = await request('/request-sign-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empId, month, documentType: 'kpi', pagePath: confirmationPath,
        pageToken: crypto.createHmac('sha256', secret).update(confirmationPath).digest('hex'),
      }),
    });
    assert.notStrictEqual(otpValidation.status, 403, 'month-scoped KPI confirmation link must pass signature-page validation');
    assert(!otpValidation.body.includes('签署链接无效或已被篡改'));

    const selfEvalPath = '/selfeval-page/' + encoded;
    const selfEvalBeforeSigning = await request(signedPath(selfEvalPath));
    assert.strictEqual(selfEvalBeforeSigning.status, 409);
    assert(selfEvalBeforeSigning.body.includes('尚未完成本人签字归档'));

    const reviewedPage = await request(signedPath(bpPath));
    assert.strictEqual(reviewedPage.status, 200);
    assert(reviewedPage.body.includes('等待员工完成目标签字并归档'));
    assert(!reviewedPage.body.includes('自动发送自评'));

    const directEmpId = 'TEST002';
    const directEncoded = Buffer.from(directEmpId + '|' + month, 'utf8').toString('base64url');
    const directSubmission = await request('/generate-kpi-pages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from('admin:test-password').toString('base64')
      },
      body: JSON.stringify({ pages: [{
        empId: directEmpId, month,
        emp: { name: '后台员工', realName: '后台姓名', dept: '测试部', position: '测试岗', directMgr: '测试上级', hrbp: '测试BP' },
        kpis: record.kpis
      }] })
    });
    assert.strictEqual(directSubmission.status, 200);
    const directResult = JSON.parse(directSubmission.body);
    assert.strictEqual(directResult.nextNode, 'target-manager');
    const drafts = JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_target_drafts.json'), 'utf8'));
    assert.strictEqual(drafts[directEmpId + '|' + month].source, 'admin-entry');
    assert.strictEqual(drafts[directEmpId + '|' + month].status, 'submitted');
    const directManagerPath = '/target-manager-page/' + directEncoded;
    const directManagerPage = await request(signedPath(directManagerPath));
    assert.strictEqual(directManagerPage.status, 200);
    assert(directManagerPage.body.includes('确认并发送BP'));

    const legacyInvitation = await request('/invite-target-draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from('admin:test-password').toString('base64')
      },
      body: JSON.stringify({ empId: canonicalLegacyId, month, emp: legacyTarget.emp, replaceExisting: true })
    });
    // The isolated test intentionally has no valid DingTalk recipient.  The
    // delivery may fail, but conversion must not be rejected merely because a
    // legacy formal target exists.
    assert(!legacyInvitation.body.includes('已有旧版正式目标'), legacyInvitation.body);
    const convertedDrafts = JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_target_drafts.json'), 'utf8'));
    assert.strictEqual(convertedDrafts[canonicalLegacyId + '|' + month].status, 'invited');
    assert.strictEqual(convertedDrafts[canonicalLegacyId + '|' + month].kpis[0].indicator, '旧版指标', 'legacy target rows must be preserved as employee-editable initial values');
    console.log('Target authoring flow checks passed.');
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
