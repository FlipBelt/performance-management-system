const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compound-score-flow-'));
const port = 18197;
const secret = 'compound-score-flow-secret';
const empId = 'ETEST';
const month = '2026年7月';

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

function post(pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function signedPath(pathname) {
  return pathname + '?token=' + crypto.createHmac('sha256', secret).update(pathname).digest('hex');
}

function writeJson(filename, value) {
  fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(value, null, 2));
}

function validInlineScripts(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  scripts.forEach(script => new Function(script[1]));
  return scripts.length > 0;
}

async function main() {
  const employee = {
    empId, name: '测试员工', realName: '测试姓名', dept: '测试部', position: '测试岗',
    directMgr: '测试上级', hrbp: '测试BP', month,
  };
  const scores = [
    { seq: 1, parentSeq: 1, itemIndex: 1, grouped: true, parentIndicator: '组合指标', indicator: '考核项一', rule: '规则一', dataSource: '数据一', max: 40, score: 38, completion: '已完成' },
    { seq: 2, parentSeq: 1, itemIndex: 2, grouped: true, parentIndicator: '组合指标', indicator: '考核项二', rule: '规则二', dataSource: '数据二', max: 60, score: 57, completion: '已完成' },
  ];
  const managerScores = scores.map((score, index) => ({ ...score, selfScore: score.score, score: [39, 58][index], remark: ['上级备注一', '上级备注二'][index] }));
  const bpScores = scores.map((score, index) => ({ ...score, selfScore: score.score, mgrScore: managerScores[index].score, score: [40, 60][index], remark: ['BP备注一', 'BP备注二'][index] }));
  writeJson('kpi_targets.json', {
    [empId + '|' + month]: { emp: employee, month, kpis: [{ seq: 1, indicator: '组合指标', weight: 100, items: [
      { indicator: '考核项一', rule: '规则一', dataSource: '数据一', weight: 40 },
      { indicator: '考核项二', rule: '规则二', dataSource: '数据二', weight: 60 },
    ] }] },
  });
  writeJson('selfeval_data.json', { [empId + '|' + month]: { ...employee, selfScore: 95, scores } });
  writeJson('mgrscore_data.json', { [empId + '|' + month]: { ...employee, selfScore: 95, mgrScore: 97, mgrScores: managerScores } });
  writeJson('bpscore_data.json', { [empId + '|' + month]: { ...employee, selfScore: 95, mgrScore: 97, bpScore: 100, bpScores } });
  for (const filename of ['kpi_confirm_data.json', 'result_confirm_data.json', 'workflow_resets.json', 'oa_approval_data.json']) writeJson(filename, {});
  writeJson('pending_notifications.json', []);
  writeJson('roster.json', []);
  writeJson('employee_overrides.json', {});

  const child = cp.spawn(process.execPath, [path.join(projectDir, 'outputs', 'eval-server.js')], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, LINK_SIGNING_SECRET: secret, PUBLIC_SERVER_URL: `http://127.0.0.1:${port}` },
    stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await get('/healthz')).status === 200) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    const managerPath = '/mgr-page/' + empId + '/' + encodeURIComponent(month);
    const bpPath = '/bp-page/' + empId + '/' + encodeURIComponent(month);
    const resultPath = '/result-page/' + empId + '/' + encodeURIComponent(month);
    const managerPage = await get(signedPath(managerPath));
    const bpPage = await get(signedPath(bpPath));
    const resultPage = await get(signedPath(resultPath));
    const actionToken = stage => crypto.createHmac('sha256', secret)
      .update('/workflow-action/' + stage + '/' + empId + '/' + encodeURIComponent(month)).digest('hex');
    const managerSubmission = await post('/submit-mgr', {
      ...employee, mgrScore: 120,
      mgrScores: [{ seq: 1, score: 70, remark: '复测上级备注一' }, { seq: 2, score: 50, remark: '复测上级备注二' }],
      actionToken: actionToken('manager'),
    });
    const bpSubmission = await post('/submit-bp', {
      ...employee, bpScore: 120,
      bpScores: [{ seq: 1, score: 65, remark: '复测BP备注一' }, { seq: 2, score: 55, remark: '复测BP备注二' }],
      actionToken: actionToken('bp'),
    });
    const managerPageAfterSubmit = await get(signedPath(managerPath));
    const bpPageAfterSubmit = await get(signedPath(bpPath));
    const storedManagers = JSON.parse(fs.readFileSync(path.join(dataDir, 'mgrscore_data.json'), 'utf8'));
    const storedBp = JSON.parse(fs.readFileSync(path.join(dataDir, 'bpscore_data.json'), 'utf8'));
    const checks = {
      managerStatus: managerPage.status === 200,
      managerTwoInputs: (managerPage.body.match(/class="score-input"/g) || []).length === 2,
      managerNoPerItemMaximum: !/class="score-input"[^>]*\smax=/.test(managerPage.body),
      managerLabels: managerPage.body.includes('组合指标 · 考核项一') && managerPage.body.includes('组合指标 · 考核项二'),
      managerSummaryHasTwoNamedScores: managerPage.body.includes('<th>员工自评分</th><th>上级评分与备注</th>'),
      managerProvisionalGradeVisible: managerPage.body.includes('mgrProvisionalGrade') && managerPage.body.includes('（待核定）') && managerPage.body.includes('最终分数和等级以BP核准结果为准'),
      managerRemarkInputs: (managerPage.body.match(/id="mgrRemark\d+"/g) || []).length === 2,
      managerSummaryDropsAmbiguousThirdValue: !managerPage.body.includes('自评 / 上级') && !managerPage.body.includes("</span> / ' + s.max"),
      managerScripts: validInlineScripts(managerPage.body),
      bpStatus: bpPage.status === 200,
      bpTwoInputs: (bpPage.body.match(/class="bp-input"/g) || []).length === 2,
      bpNoPerItemMaximum: !/class="bp-input"[^>]*\smax=/.test(bpPage.body),
      bpLabels: bpPage.body.includes('组合指标 · 考核项一') && bpPage.body.includes('组合指标 · 考核项二'),
      bpRemarkInputs: (bpPage.body.match(/id="bpRemark\d+"/g) || []).length === 2,
      bpScripts: validInlineScripts(bpPage.body),
      resultStatus: resultPage.status === 200,
      resultHasBothItems: resultPage.body.includes('组合指标 · 考核项一') && resultPage.body.includes('组合指标 · 考核项二'),
      resultShowsItemRemarks: resultPage.body.includes('上级备注一') && resultPage.body.includes('BP备注二'),
      resultUsesBpFinalScoreAndGrade: resultPage.body.includes('var FINAL_SCORE = 100;') && resultPage.body.includes('var GRADE = "B";'),
      resultScripts: validInlineScripts(resultPage.body),
      managerOverWeightItemAccepted: managerSubmission.status === 200,
      bpOverWeightItemAccepted: bpSubmission.status === 200,
      managerReloadShowsSubmittedState: managerPageAfterSubmit.status === 200 &&
        !managerPageAfterSubmit.body.includes('const EXISTING_SUBMISSION = null;') &&
        managerPageAfterSubmit.body.includes('本次评分已成功保存，无需重复提交'),
      managerRemarksPersisted: storedManagers[empId + '|' + month].mgrScores[0].remark === '复测上级备注一',
      managerProvisionalGradePersisted: storedManagers[empId + '|' + month].provisionalGrade === 'A-',
      bpRemarksPersisted: storedBp[empId + '|' + month].bpScores[1].remark === '复测BP备注二',
      bpReloadShowsSubmittedState: bpPageAfterSubmit.status === 200 && !bpPageAfterSubmit.body.includes('var EXISTING_SUBMISSION = null;'),
    };
    console.log(JSON.stringify(checks));
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
