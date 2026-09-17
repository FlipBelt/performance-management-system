const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const port = 19109;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-operation-logs-'));
fs.writeFileSync(path.join(tempDir, 'assessment_roster.json'), JSON.stringify([
  { id: 'E901', name: '测试花名', realName: '测试姓名', department: '信息技术部', position: '测试岗位', active: true, directMgr: '惜君', hrbp: '路得' }
], null, 2));

const server = spawn(process.execPath, [path.join(__dirname, 'eval-server.js')], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    PORT: String(port), DATA_DIR: tempDir,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password',
    LINK_SIGNING_SECRET: 'operation-log-test-signing-secret',
    PUBLIC_SERVER_URL: 'http://127.0.0.1:' + port,
    DISABLE_EXTERNAL_NOTIFICATIONS: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
const base = `http://127.0.0.1:${port}`;
const genericAuthorization = 'Basic ' + Buffer.from('admin:test-password').toString('base64');

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
  assert.strictEqual(response.status, 303, name + ' login failed');
  return ((response.headers.get('set-cookie') || '').match(/perf_admin_session=[^;]+/) || [''])[0];
}

(async () => {
  try {
    await waitUntilReady();
    const sangshenCookie = await login('桑葚');
    const benCookie = await login('Ben');
    const managerCookie = await login('惜君');

    let response = await fetch(base + '/', { headers: { Cookie: sangshenCookie } });
    let dashboard = await response.text();
    assert.strictEqual(response.status, 200);
    assert(dashboard.includes('canViewOperationLogs":true'), 'four administrators must receive operation-log navigation permission');
    assert(dashboard.includes('label: "操作日志"'), 'operation-log navigation source must be present');

    response = await fetch(base + '/', { headers: { Cookie: managerCookie } });
    dashboard = await response.text();
    assert(dashboard.includes('canViewOperationLogs":false'), 'department managers must not receive operation-log permission');

    response = await fetch(base + '/operation-logs', { headers: { Authorization: genericAuthorization } });
    assert.strictEqual(response.status, 403, 'shared system administrator must not read four-person audit logs');
    response = await fetch(base + '/operation-logs', { headers: { Cookie: managerCookie } });
    assert.strictEqual(response.status, 403, 'department managers must not read operation logs');
    response = await fetch(base + '/operation-logs', { headers: { Cookie: benCookie } });
    assert.strictEqual(response.status, 200, 'all four named administrators must be able to read operation logs');

    response = await fetch(base + '/monthly-events', {
      method: 'POST',
      headers: { Authorization: genericAuthorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'upsert', month: '2026年9月', empId: 'E901', date: '2026-09-16',
        summary: '操作日志测试事件', details: '验证新增和删除均留下摘要。',
        images: [{ name: 'proof.png', dataUrl: 'data:image/png;base64,' + Buffer.from('sensitive-image-content').toString('base64') }]
      })
    });
    assert.strictEqual(response.status, 200);
    const created = (await response.json()).event;
    response = await fetch(base + '/monthly-events', {
      method: 'POST',
      headers: { Authorization: genericAuthorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id: created.id })
    });
    assert.strictEqual(response.status, 200);

    response = await fetch(base + '/operation-logs?limit=100', { headers: { Cookie: sangshenCookie } });
    assert.strictEqual(response.status, 200);
    const result = await response.json();
    assert.strictEqual(result.appendOnly, true);
    const createLog = result.logs.find(log => log.action === '新增每月事件');
    const deleteLog = result.logs.find(log => log.action === '删除每月事件');
    assert(createLog && deleteLog, 'monthly event create and delete must both be audited');
    assert.strictEqual(deleteLog.actorName, '系统管理员');
    assert.strictEqual(deleteLog.details.before.summary, '操作日志测试事件');
    assert.strictEqual(deleteLog.details.before.images[0].name, 'proof.png');
    assert(/^[a-f0-9]{64}$/.test(deleteLog.details.before.images[0].sha256));
    assert.strictEqual(deleteLog.integrityValid, true);

    const auditText = fs.readFileSync(path.join(tempDir, 'operation_audit.jsonl'), 'utf8');
    assert(!auditText.includes('test-password'), 'passwords must never enter operation logs');
    assert(!auditText.includes('sensitive-image-content'), 'image payloads must never enter operation logs');
    assert(auditText.trim().split(/\r?\n/).length >= 5, 'operation logs must be append-only JSONL entries');
    console.log('operation audit append-only logging, four-admin visibility, sensitive-field redaction, and monthly-event snapshots passed');
  } finally {
    server.kill('SIGTERM');
    if (path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()))) fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
