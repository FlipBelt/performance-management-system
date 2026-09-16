const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const crypto = require('crypto');

const projectDir = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-reminders-'));
const port = 18192;
const secret = 'workflow-reminder-test-secret';

function writeJson(filename, value) {
  fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(value, null, 2));
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(payload);
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function signedUrl(pathname) {
  const token = crypto.createHmac('sha256', secret).update(pathname).digest('hex');
  return `http://127.0.0.1:${port}${pathname}?token=${token}`;
}

function pageChecks(page) {
  const visibleMarkup = page.body.split('<script>')[0];
  const scripts = [...page.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  for (const script of scripts) new Function(script[1]);
  return {
    status: page.status === 200,
    oneVisibleGuide: (visibleMarkup.match(/<div class="workflow-reminder-grid">/g) || []).length === 1,
    guideTitle: visibleMarkup.includes('>评分标准<') && !visibleMarkup.includes('评分标准速查'),
    sixGrades: ['grade-a', 'grade-b-plus', 'grade-b', 'grade-b-minus', 'grade-c', 'grade-d']
      .every((className) => visibleMarkup.includes(`grade-chip ${className}`)),
    attendanceNote: visibleMarkup.includes('当月缺勤') && visibleMarkup.includes('当月缺勤≥10天'),
    responsiveGrid: page.body.includes('@media(max-width:820px)'),
    validScripts: scripts.length > 0,
  };
}

async function main() {
  const employee = {
    empId: 'ETEST', name: '测试员', realName: '测试姓名', month: '2026年7月',
    dept: '测试部', position: '测试岗', directMgr: '测试上级', hrbp: '测试BP',
  };
  const scores = [{
    seq: 1, indicator: '测试指标', rule: '评分细则', dataSource: '上级评分',
    max: 100, score: 95, completion: '已完成',
  }];

  writeJson('kpi_targets.json', {
    'ETEST|2026年7月': {
      emp: { name: employee.name, realName: employee.realName, dept: employee.dept, position: employee.position, directMgr: employee.directMgr },
      kpis: [{ seq: 1, indicator: '测试指标', rule: '评分细则', dataSource: '上级评分', weight: 100 }],
      month: employee.month,
    },
  });
  writeJson('selfeval_data.json', { ETEST: { ...employee, selfScore: 95, scores } });
  writeJson('mgrscore_data.json', {
    ETEST: { ...employee, selfScore: 95, mgrScore: 96, mgrScores: [{ seq: 1, score: 96 }] },
  });
  writeJson('bpscore_data.json', {
    ETEST: { ...employee, selfScore: 95, mgrScore: 96, bpScore: 97, bpScores: [{ seq: 1, score: 97 }] },
  });
  const archivedResultDoc = '<!DOCTYPE html><html><head><style>table{width:100%}</style></head><body>' +
    '<table><thead><tr><th>#</th><th>考核指标、评分细则及数据来源</th><th>权重</th><th>实际完成情况</th><th>员工自评</th><th>上级评分</th><th>BP核准</th></tr></thead>' +
    '<tbody><tr><td>1</td><td><div style="font-weight:600">历史指标</div><div><strong>评分细则：</strong>历史细则</div><div><strong>数据来源：</strong>历史来源</div></td><td class="weight">100%</td><td>完成</td><td>95</td><td>96</td><td>97</td></tr></tbody>' +
    '<tfoot><tr><td colspan="2">合计</td><td>100%</td><td></td><td>95</td><td>96</td><td>97</td></tr></tfoot></table>' +
    '<div class="rating-guide-title">评分标准速查</div></body></html>';
  writeJson('result_confirm_data.json', {
    EARCHIVE: { empId: 'EARCHIVE', name: '历史员工', month: '2026年7月', doc: archivedResultDoc },
  });
  writeJson('kpi_confirm_data.json', {
    'ETEST|2026年7月': { empId: 'ETEST', name: employee.name, realName: employee.realName, month: employee.month, doc: '<html>signed target</html>' },
  });
  for (const filename of [
    'workflow_resets.json',
    'pending_notifications.json', 'roster.json', 'employee_overrides.json',
  ]) writeJson(filename, filename.includes('notifications') || filename === 'roster.json' ? [] : {});

  const child = cp.spawn(process.execPath, [path.join(projectDir, 'outputs', 'eval-server.js')], {
    cwd: projectDir,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir,
      LINK_SIGNING_SECRET: secret, PUBLIC_SERVER_URL: `http://127.0.0.1:${port}`,
    },
    stdio: 'ignore',
  });

  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        if ((await get(`http://127.0.0.1:${port}/healthz`)).status === 200) break;
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const selfPayload = Buffer.from('ETEST|2026年7月').toString('base64url');
    const paths = {
      selfEvaluation: `/selfeval-page/${selfPayload}`,
      managerScoring: '/mgr-page/ETEST',
      bpApproval: '/bp-page/ETEST',
      finalSignature: '/result-page/ETEST',
      monthScopedFinalSignature: '/result-page/ETEST/' + encodeURIComponent(employee.month),
    };
    const results = {};
    for (const [name, pathname] of Object.entries(paths)) {
      results[name] = pageChecks(await get(signedUrl(pathname)));
    }
    const resultPage = await get(signedUrl(paths.finalSignature));
    results.finalSignature.separateKpiColumns = ['>考核指标<', '>评分细则<', '>数据来源<']
      .every((label) => resultPage.body.includes(label)) &&
      !resultPage.body.includes('考核指标、评分细则及数据来源');
    const monthScopedOtpPath = paths.monthScopedFinalSignature;
    const monthScopedOtp = await post(`http://127.0.0.1:${port}/request-sign-otp`, {
      empId: employee.empId,
      month: employee.month,
      documentType: 'result',
      pagePath: monthScopedOtpPath,
      pageToken: crypto.createHmac('sha256', secret).update(monthScopedOtpPath).digest('hex'),
    });
    results.monthScopedResultIdentity = {
      pageRendered: results.monthScopedFinalSignature.status,
      employeeMatched: monthScopedOtp.status !== 403 && !monthScopedOtp.body.includes('签署链接与员工身份不匹配'),
      monthMatched: !monthScopedOtp.body.includes('签署链接与考核月份不匹配'),
    };
    const archivedPage = await get(signedUrl('/result-page/EARCHIVE'));
    results.archivedResultPreview = {
      status: archivedPage.status === 200,
      separateKpiColumns: ['>考核指标<', '>评分细则<', '>数据来源<']
        .every((label) => archivedPage.body.includes(label)),
      splitValues: ['历史指标', '历史细则', '历史来源'].every((value) => archivedPage.body.includes(value)),
      fixedTotalColumns: archivedPage.body.includes('colspan="4"'),
      renamedGuide: archivedPage.body.includes('>评分标准<') && !archivedPage.body.includes('评分标准速查'),
    };
    const targetResponse = await get(`http://127.0.0.1:${port}/kpi-targets`, {
      Authorization: `Basic ${Buffer.from('admin:').toString('base64')}`,
    });
    const targetPayload = targetResponse.status === 200 ? JSON.parse(targetResponse.body) : {};
    results.kpiTargetEndpoint = {
      status: targetResponse.status === 200,
      targetRetained: Array.isArray(targetPayload['ETEST|2026年7月'] && targetPayload['ETEST|2026年7月'].kpis),
      targetCount: (targetPayload['ETEST|2026年7月'] && targetPayload['ETEST|2026年7月'].kpis || []).length === 1,
    };
    console.log(JSON.stringify(results));
    const passed = Object.values(results).every((checks) => Object.values(checks).every(Boolean));
    if (!passed) process.exitCode = 1;
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
