const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const month = '2026年7月';
const empId = 'REMINDER_TEST';

function request(port, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/workflow-reminder', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        Authorization: `Basic ${Buffer.from('admin:').toString('base64')}`,
      },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
}

function writeJson(directory, filename, value) {
  fs.writeFileSync(path.join(directory, filename), JSON.stringify(value, null, 2));
}

async function runCase(index, expectedNode, stores, expectedCode = '') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `workflow-reminder-${expectedNode}-`));
  const port = 18210 + index;
  const employee = {
    name: '不存在的测试员工', realName: '测试姓名', dept: '测试部', position: '测试岗',
    directMgr: '不存在的测试上级', hrbp: '不存在的测试BP',
  };
  writeJson(dataDir, 'kpi_targets.json', {
    [`${empId}|${month}`]: {
      emp: employee, month,
      kpis: [{ seq: 1, indicator: '测试指标', rule: '测试规则', dataSource: '系统', weight: 100 }],
    },
  });
  const files = {
    'kpi_confirm_data.json': stores.kpi || {},
    'selfeval_data.json': stores.self || {},
    'mgrscore_data.json': stores.manager || {},
    'bpscore_data.json': stores.bp || {},
    'result_confirm_data.json': stores.result || {},
    'workflow_resets.json': {}, 'pending_notifications.json': [], 'roster.json': [],
    'employee_overrides.json': {}, 'oa_approval_data.json': {},
  };
  Object.entries(files).forEach(([filename, value]) => writeJson(dataDir, filename, value));
  const child = cp.spawn(process.execPath, [path.join(projectDir, 'outputs', 'eval-server.js')], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, LINK_SIGNING_SECRET: 'reminder-test-secret', PUBLIC_SERVER_URL: `http://127.0.0.1:${port}` },
    stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await get(port, '/healthz')) === 200) break; } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const response = await request(port, { empId, month });
    const data = JSON.parse(response.body);
    return response.status === 409 && data.node === expectedNode && (!expectedCode || data.code === expectedCode);
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const record = { empId, month, name: '不存在的测试员工', realName: '测试姓名' };
  const signedTarget = { [`${empId}|${month}`]: { ...record, doc: '<html>target</html>' } };
  const self = { [`${empId}|${month}`]: { ...record, selfScore: 90 } };
  const manager = { [`${empId}|${month}`]: { ...record, mgrScore: 91 } };
  const bp = { [`${empId}|${month}`]: { ...record, bpScore: 92 } };
  const result = { [`${empId}|${month}`]: { ...record, doc: '<html>result</html>' } };
  const pendingBpArchive = { [`${empId}|${month}`]: { ...record, doc: '<html>employee signed result</html>', signedAt: new Date().toISOString(), bpReviewStatus: 'pending', sealed: false } };
  const checks = {
    target: await runCase(0, 'target', {}),
    self: await runCase(1, 'self', { kpi: signedTarget }),
    manager: await runCase(2, 'manager', { kpi: signedTarget, self }),
    bp: await runCase(3, 'bp', { kpi: signedTarget, self, manager }),
    result: await runCase(4, 'result', { kpi: signedTarget, self, manager, bp }),
    pendingBpArchive: await runCase(5, 'result-bp-final', { kpi: signedTarget, self, manager, bp, result: pendingBpArchive }, 'BP_RESULT_REVIEW_REMINDER_DISABLED'),
    complete: await runCase(6, 'complete', { kpi: signedTarget, self, manager, bp, result }),
  };
  const dashboard = fs.readFileSync(path.join(projectDir, 'outputs', 'preview.html'), 'utf8');
  const serverSource = fs.readFileSync(path.join(projectDir, 'outputs', 'eval-server.js'), 'utf8');
  const reminderRouteSource = serverSource.slice(serverSource.indexOf("req.url === '/workflow-reminder'"), serverSource.indexOf('// Send bot message directly'));
  checks.targetButton = dashboard.includes('催办目标确认');
  checks.selfButton = dashboard.includes('发送自评');
  checks.selfReminderButton = dashboard.includes('催办自评');
  checks.manualSelfEntryRemoved = !dashboard.includes('录入自评') && !dashboard.includes('data-input-self-score');
  checks.backendScoringShortcutRemoved = !dashboard.includes('去评分') && !dashboard.includes('data-eval-emp');
  checks.managerButton = dashboard.includes('催办上级');
  checks.bpButton = dashboard.includes('催办BP');
  checks.resultButton = dashboard.includes('催办结果签字');
  checks.bpArchiveReminderRemoved = !dashboard.includes('催办BP归档');
  checks.bpArchiveReviewButton = dashboard.includes('BP结果核对');
  checks.batchSkipsBpArchive = dashboard.includes("evaluation.status !== '待BP归档'");
  checks.stageCardsClickable = dashboard.includes('data-eval-stage-detail=');
  checks.pendingTargetStage = dashboard.includes('const STAGES = ["待目标确认", "待自评"') &&
    dashboard.includes("status: '待目标确认'") && dashboard.includes('targetStageLabel: candidate.stageLabel');
  checks.sixStageLayout = dashboard.includes('<div class="grid-6">${STAGES.map(stage =>') &&
    dashboard.includes('.grid-6 { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));');
  checks.pendingTargetNotDuplicated = dashboard.includes('return [...pendingTargets, ...records]') &&
    dashboard.includes('if (isKpiSubmissionLocked(employee.id, month)) return []');
  checks.batchIncludesTargetConfirmation = dashboard.includes('let candidates = filteredEvaluationsForStageDetail().filter(evaluation =>');
  checks.stagePeopleModal = dashboard.includes('function renderEvalStageDetailModal()') && dashboard.includes('当前负责人 / 下一步');
  checks.stageModalCanRemind = dashboard.includes('催办当前节点') && dashboard.includes('data-workflow-action="remind-self-evaluation"');
  const stageModalSource = dashboard.slice(
    dashboard.indexOf('function renderEvalStageDetailModal()'),
    dashboard.indexOf('function renderEvalContent()')
  );
  checks.stageModalReminderOnly = stageModalSource.includes('催办当前节点') &&
    stageModalSource.includes('催办自评') &&
    !stageModalSource.includes('data-workflow-action="send-self-evaluation"') &&
    !stageModalSource.includes('/admin-target-manager-page/') &&
    !stageModalSource.includes('/admin-target-bp-page/') &&
    !stageModalSource.includes('/admin-manager-page/') &&
    !stageModalSource.includes('/admin-bp-page/');
  checks.actionScopedToReminderRoute = reminderRouteSource.includes("const requestedAction = String(data.action || '').trim();") && reminderRouteSource.includes("requestedAction === 'remind-self-evaluation'");
  checks.monthScopedWorkflowReset = dashboard.includes("const resetMonth = typeof reset === 'object'") &&
    dashboard.includes("item.month === resetMonth") && dashboard.includes("const appliedKey = assessmentKey(empId, resetMonth || '*')");
  checks.signedTargetEvaluationBackfill = dashboard.includes('function ensureEvaluationsForSignedTargets()') &&
    dashboard.includes("status: '待自评'") && dashboard.includes('changed = ensureEvaluationsForSignedTargets() || changed;');
  console.log(JSON.stringify(checks));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
