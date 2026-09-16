const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const baseDir = __dirname;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-manager-authority-'));
const port = 19041;
const secret = 'manager-authority-test-secret-that-is-long-enough';
const admin = 'Basic ' + Buffer.from('admin:test-password').toString('base64');
const empId = 'E049';
const itEmpId = 'E050';
const month = '2026年9月';
const key = empId + '|' + month;
const itKey = itEmpId + '|' + month;

fs.writeFileSync(path.join(dataDir, 'assessment_roster.json'), JSON.stringify([
  { id: empId, name: '廿一', realName: '孙伟强', dept: '产品设计', position: '服装设计师', active: true, userId: '462814292223125268', assessmentStartMonth: '2026年6月' },
  { id: itEmpId, name: '星河', realName: '李子文', dept: '信息技术部', position: '数据分析', active: true, userId: '226268411826165253', assessmentStartMonth: '2026年6月' }
], null, 2));
fs.writeFileSync(path.join(dataDir, 'roster.json'), JSON.stringify([
  { nick: '廿一', realName: '孙伟强', department: '产品设计', title: '服装设计师', userId: '462814292223125268', active: true },
  { nick: '星河', realName: '李子文', department: '信息技术部', title: '数据分析', userId: '226268411826165253', active: true }
], null, 2));
fs.writeFileSync(path.join(dataDir, 'employee_overrides.json'), JSON.stringify({
  '廿一': { department: '产品设计', directMgr: 'Ben' }
}, null, 2));
fs.writeFileSync(path.join(dataDir, 'kpi_target_drafts.json'), JSON.stringify({
  [key]: {
    empId, month, source: 'employee-self-fill', status: 'submitted',
    emp: { name: '廿一', realName: '孙伟强', dept: '产品设计', position: '服装设计师', directMgr: '球球', hrbp: '薏米' },
    kpis: [{ seq: 1, indicator: '服装设计目标', rule: '按计划完成', dataSource: '项目记录', weight: 100 }]
  },
  [itKey]: {
    empId: itEmpId, month, source: 'employee-self-fill', status: 'manager_approved',
    emp: { name: '星河', realName: '李子文', dept: '信息技术部', position: '数据分析', directMgr: '惜君', hrbp: '薏米' },
    kpis: [{ seq: 1, indicator: '数据分析目标', rule: '按计划完成', dataSource: '系统数据', weight: 100 }]
  }
}, null, 2));

const child = spawn(process.execPath, [path.join(baseDir, 'eval-server.js')], {
  env: {
    ...process.env, PORT: String(port), DATA_DIR: dataDir, LINK_SIGNING_SECRET: secret,
    ADMIN_PASSWORD: 'test-password', NODE_ENV: 'test', DISABLE_EXTERNAL_NOTIFICATIONS: '1',
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
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function signedPath(pathname) {
  return pathname + '?token=' + crypto.createHmac('sha256', secret).update(pathname).digest('hex');
}

(async () => {
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try { if ((await request('/healthz')).status === 200) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (child.exitCode != null) throw new Error('test server exited early: ' + childOutput);

    let drafts = JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_target_drafts.json'), 'utf8'));
    assert.strictEqual(drafts[key].emp.directMgr, 'Ben', 'startup must repair stale manager snapshots');
    assert.strictEqual(drafts[itKey].emp.hrbp, '路得', 'startup must repair Information Technology HRBP snapshots');
    assert(fs.existsSync(path.join(dataDir, 'kpi_target_drafts.json.pre-workflow-employee-repair.bak')));

    const reviewPath = '/target-manager-page/' + Buffer.from(key, 'utf8').toString('base64url');
    const reviewPage = await request(signedPath(reviewPath));
    assert.strictEqual(reviewPage.status, 200, reviewPage.body);
    assert(reviewPage.body.includes('当前处理人：直属上级 <strong>Ben</strong>'));
    assert(!reviewPage.body.includes('当前处理人：直属上级 <strong>球球</strong>'));

    const reminder = await request('/workflow-reminder', {
      method: 'POST', headers: { Authorization: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId, month, action: 'reminder' })
    });
    assert.strictEqual(reminder.status, 200, reminder.body);
    assert.strictEqual(JSON.parse(reminder.body).recipientName, 'Ben');

    const itBpReviewPath = '/target-bp-page/' + Buffer.from(itKey, 'utf8').toString('base64url');
    const itBpReviewPage = await request(signedPath(itBpReviewPath));
    assert.strictEqual(itBpReviewPage.status, 200, itBpReviewPage.body);
    assert(itBpReviewPage.body.includes('当前处理人：BP <strong>路得</strong>'));
    const itReminder = await request('/workflow-reminder', {
      method: 'POST', headers: { Authorization: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId: itEmpId, month, action: 'reminder' })
    });
    assert.strictEqual(itReminder.status, 200, itReminder.body);
    assert.strictEqual(JSON.parse(itReminder.body).recipientName, '路得');

    const nextMonth = '2026年10月';
    const generated = await request('/generate-kpi-pages', {
      method: 'POST', headers: { Authorization: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages: [
        {
          empId, month: nextMonth,
          emp: { name: '廿一', realName: '孙伟强', dept: '产品设计', position: '服装设计师', directMgr: '球球', hrbp: '薏米' },
          kpis: [{ indicator: '新月份设计目标', rule: '按计划完成', dataSource: '项目记录', weight: 100 }]
        },
        {
          empId: itEmpId, month: nextMonth,
          emp: { name: '星河', realName: '李子文', dept: '信息技术部', position: '数据分析', directMgr: '惜君', hrbp: '薏米' },
          kpis: [{ indicator: '新月份数据目标', rule: '按计划完成', dataSource: '系统数据', weight: 100 }]
        }
      ] })
    });
    assert.strictEqual(generated.status, 200, generated.body);
    drafts = JSON.parse(fs.readFileSync(path.join(dataDir, 'kpi_target_drafts.json'), 'utf8'));
    assert.strictEqual(drafts[empId + '|' + nextMonth].emp.directMgr, 'Ben', 'new workflow must ignore a stale client manager value');
    assert.strictEqual(drafts[itEmpId + '|' + nextMonth].emp.hrbp, '路得', 'new IT workflow must ignore a stale client HRBP value');
    assert(!childOutput.includes('[dingtalk] Sending'), 'test must never send a real notification');
    console.log('authoritative manager routing checks passed without external notifications');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
