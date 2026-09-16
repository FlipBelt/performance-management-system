const assert = require('assert');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-otp-resume-'));
const port = 18213;
const secret = 'mobile-otp-resume-secret';
const empId = 'EMOBILE';
const month = '2026年8月';

function writeJson(filename, value) {
  fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(value, null, 2));
}

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || '';
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function tokenFor(pathname) {
  return crypto.createHmac('sha256', secret).update(pathname).digest('hex');
}

(async () => {
  writeJson('kpi_targets.json', {
    [empId + '|' + month]: {
      emp: { empId, name: '移动员工', realName: '移动姓名', dept: '测试部', position: '测试岗', directMgr: '测试上级' },
      month,
      kpis: [{ seq: 1, indicator: '测试指标', rule: '测试细则', dataSource: '测试来源', weight: 100 }],
    },
  });
  writeJson('userid_cache.json', { 移动员工: 'mobile-user-id' });
  for (const filename of ['kpi_confirm_data.json', 'result_confirm_data.json', 'selfeval_data.json', 'mgrscore_data.json', 'bpscore_data.json']) {
    writeJson(filename, {});
  }

  const child = cp.spawn(process.execPath, [path.join(projectDir, 'outputs', 'eval-server.js')], {
    cwd: projectDir,
    env: {
      ...process.env, NODE_ENV: 'test', SIGNING_OTP_TEST_CODE: '246810', PORT: String(port), DATA_DIR: dataDir,
      LINK_SIGNING_SECRET: secret, PUBLIC_SERVER_URL: `http://127.0.0.1:${port}`,
    },
    stdio: 'ignore',
  });

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await request('/healthz')).status === 200) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const encoded = Buffer.from(empId + '|' + month).toString('base64url');
    const pagePath = '/kpi-confirm-page/' + encoded;
    const pageToken = tokenFor(pagePath);
    const page = await request(pagePath + '?token=' + pageToken);
    assert.strictEqual(page.status, 200);
    assert(page.body.includes("fetch('/sign-otp-status'"));
    assert(page.body.includes('restorePendingOtp();'));
    assert(page.body.includes('autocomplete="one-time-code"'));

    const context = { empId, month, documentType: 'kpi', pagePath, pageToken };
    const sent = await request('/request-sign-otp', { method: 'POST', body: JSON.stringify(context) });
    assert.strictEqual(sent.status, 200);
    const sentData = JSON.parse(sent.body);
    assert(sentData.success && sentData.challengeId);

    const resumed = await request('/sign-otp-status', { method: 'POST', body: JSON.stringify(context) });
    assert.strictEqual(resumed.status, 200);
    const resumedData = JSON.parse(resumed.body);
    assert.strictEqual(resumedData.active, true);
    assert.strictEqual(resumedData.challengeId, sentData.challengeId);
    assert(resumedData.expiresIn > 0);

    const duplicateSend = await request('/request-sign-otp', { method: 'POST', body: JSON.stringify(context) });
    const duplicateData = JSON.parse(duplicateSend.body);
    assert.strictEqual(duplicateSend.status, 200);
    assert.strictEqual(duplicateData.resumed, true);
    assert.strictEqual(duplicateData.challengeId, sentData.challengeId);

    const verified = await request('/verify-sign-otp', {
      method: 'POST', body: JSON.stringify({ challengeId: resumedData.challengeId, code: '246810' }),
    });
    assert.strictEqual(verified.status, 200);
    assert.strictEqual(JSON.parse(verified.body).success, true);

    const afterVerify = await request('/sign-otp-status', { method: 'POST', body: JSON.stringify(context) });
    assert.strictEqual(JSON.parse(afterVerify.body).active, false);

    const resultTemplate = fs.readFileSync(path.join(projectDir, 'outputs', '绩效结果确认书模板.html'), 'utf8');
    assert(resultTemplate.includes("fetch('/sign-otp-status'"));
    assert(resultTemplate.includes('restorePendingOtp();'));
    assert(resultTemplate.includes('autocomplete="one-time-code"'));
    console.log('mobile OTP session resume checks passed');
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
