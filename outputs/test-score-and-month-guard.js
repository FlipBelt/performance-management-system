const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-month-guard-'));
const port = 18194;
const secret = 'score-month-test-secret';

function request(method, route, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : '';
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function actionToken(action, empId, month) {
  const actionPath = '/workflow-action/' + action + '/' + encodeURIComponent(empId) + '/' + encodeURIComponent(month);
  return crypto.createHmac('sha256', secret).update(actionPath).digest('hex');
}

async function main() {
  const months = ['2026年7月', '2026年8月'];
  const targets = {};
  for (const month of months) {
    targets['ETEST|' + month] = {
      emp: { name: '测试员', realName: '测试姓名', dept: '测试部', position: '测试岗', directMgr: '不存在上级', hrbp: '不存在BP' },
      kpis: [{ seq: 1, indicator: '测试指标', rule: '测试规则', dataSource: '系统数据', weight: 100 }],
      month,
    };
  }
  fs.writeFileSync(path.join(dataDir, 'kpi_targets.json'), JSON.stringify(targets, null, 2));
  fs.writeFileSync(path.join(dataDir, 'kpi_confirm_data.json'), JSON.stringify(Object.fromEntries(months.map(month => [
    'ETEST|' + month,
    { empId: 'ETEST', month, name: '测试员', realName: '测试姓名', doc: '<html>signed target</html>' },
  ])), null, 2));
  for (const file of ['mgrscore_data.json', 'bpscore_data.json', 'selfeval_data.json', 'result_confirm_data.json', 'workflow_resets.json']) {
    fs.writeFileSync(path.join(dataDir, file), '{}');
  }

  const child = cp.spawn(process.execPath, [path.join(projectDir, 'outputs', 'eval-server.js')], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, LINK_SIGNING_SECRET: secret, PUBLIC_SERVER_URL: `http://127.0.0.1:${port}` },
    stdio: 'ignore',
  });

  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { if ((await request('GET', '/healthz')).status === 200) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const makePayload = (month, score, token = actionToken('self', 'ETEST', month)) => ({
      empId: 'ETEST', name: '测试员', realName: '测试姓名', month, selfScore: score,
      details: [{ seq: 1, selfScore: score, completion: '已完成' }], sigData: 'data:image/png;base64,test', actionToken: token,
    });

    const oversized = await request('POST', '/submit', makePayload(months[0], 120.1));
    const missingToken = await request('POST', '/submit', makePayload(months[0], 100, ''));
    const july = await request('POST', '/submit', makePayload(months[0], 120));
    const august = await request('POST', '/submit', makePayload(months[1], 100));
    const julyRecord = await request('GET', '/data/ETEST/' + encodeURIComponent(months[0]));
    const augustRecord = await request('GET', '/data/ETEST/' + encodeURIComponent(months[1]));
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'selfeval_data.json'), 'utf8'));

    const checks = {
      oversizedRejected: oversized.status === 400,
      unsignedActionRejected: missingToken.status === 403,
      boundaryAccepted: july.status === 200,
      secondMonthAccepted: august.status === 200,
      compoundKeys: Boolean(stored['ETEST|' + months[0]] && stored['ETEST|' + months[1]] && !stored.ETEST),
      julyIsolated: JSON.parse(julyRecord.body).month === months[0] && JSON.parse(julyRecord.body).selfScore === 120,
      augustIsolated: JSON.parse(augustRecord.body).month === months[1] && JSON.parse(augustRecord.body).selfScore === 100,
    };
    console.log(JSON.stringify(checks));
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
