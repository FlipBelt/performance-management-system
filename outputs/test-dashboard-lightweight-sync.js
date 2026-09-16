const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const baseDir = __dirname;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-light-sync-'));
const port = 19145;
const admin = 'Basic ' + Buffer.from('admin:test-password').toString('base64');
const largeDocument = '<!doctype html><html><body>' + 'signed-content-'.repeat(80000) + '</body></html>';
fs.writeFileSync(path.join(dataDir, 'kpi_confirm_data.json'), JSON.stringify({
  'E031|2026年9月': {
    empId: 'E031', name: '俊俊', realName: '廉峻', dept: '兴趣电商', position: '兴趣电商负责人',
    month: '2026年9月', doc: largeDocument, signatureValidated: true,
    signedAt: '2026-09-04T08:00:00.000Z', archivedAt: '2026-09-04T08:00:00.000Z'
  }
}), 'utf8');

const child = spawn(process.execPath, [path.join(baseDir, 'eval-server.js')], {
  cwd: path.resolve(baseDir, '..'),
  env: {
    ...process.env,
    PORT: String(port), DATA_DIR: dataDir, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password',
    LINK_SIGNING_SECRET: '0123456789abcdef0123456789abcdef', NODE_ENV: 'test',
    DISABLE_EXTERNAL_NOTIFICATIONS: '1', DINGTALK_APP_KEY: '', DINGTALK_APP_SECRET: '', DINGTALK_ROBOT_CODE: ''
  },
  stdio: 'ignore'
});

function request(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await request('/healthz')).status === 200) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const full = await request('/kpi-data', { Authorization: admin });
    const summary = await request('/kpi-data?summary=1', { Authorization: admin });
    assert.strictEqual(full.status, 200);
    assert.strictEqual(summary.status, 200);
    const summaryRecord = JSON.parse(summary.body)['E031|2026年9月'];
    assert(summaryRecord);
    assert.strictEqual(summaryRecord.doc, true);
    assert(summaryRecord.archiveFile);
    assert(full.body.length > 1000000);
    assert(summary.body.length < 10000);
    assert(!summary.body.includes('signed-content-signed-content'));

    const dashboard = fs.readFileSync(path.join(baseDir, 'preview.html'), 'utf8');
    assert(dashboard.includes("fetch(SYNC_SERVER_URL + '/kpi-data?summary=1')"));
    assert(dashboard.includes("fetch(SYNC_SERVER_URL + '/result-data?summary=1')"));
    assert(dashboard.includes("changedFiles.length === 1 && changedFiles[0] === 'okr_workflows.json'"));
    assert(dashboard.includes('OKR流程已经启动，本次未重复发送邀请。'));
    assert(dashboard.includes('OKR邀请已由服务器受理，流程状态已恢复，本次不会重复发送。'));
    console.log('lightweight dashboard sync and OKR invitation recovery checks passed');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()))) fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
