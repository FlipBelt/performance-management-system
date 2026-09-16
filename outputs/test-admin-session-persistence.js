const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(__dirname, 'eval-server.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-admin-session-'));
const port = 18193;

function startServer(linkSecret, adminUsername = 'admin') {
  return spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_USERNAME: adminUsername,
      ADMIN_PASSWORD: 'test-pass',
      LINK_SIGNING_SECRET: linkSecret,
      DINGTALK_CORP_ID: 'ding-test-corp'
    },
    stdio: 'ignore',
    windowsHide: true
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server health check timed out');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

(async () => {
  let server;
  try {
    fs.writeFileSync(path.join(dataDir, 'assessment_roster.json'), JSON.stringify([
      { id: 'E003', name: '玖杉', realName: '周荣', dept: '人事行政部', position: '人事行政专员', active: true }
    ]));
    fs.writeFileSync(path.join(dataDir, 'selfeval_data.json'), JSON.stringify({
      'E069|2026年7月': { empId: 'E069', month: '2026年7月', name: '玖杉', realName: '周荣', dept: '人事行政部', position: '人事行政专员', selfScore: 92, scores: [] }
    }));
    server = startServer('a'.repeat(64));
    await waitForHealth();
    const login = await fetch(`http://127.0.0.1:${port}/admin-login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'test-pass', next: '/' })
    });
    const setCookie = login.headers.get('set-cookie') || '';
    assert.equal(login.status, 303);
    assert.match(setCookie, /Max-Age=31536000/);
    assert.match(setCookie, /Expires=/);
    assert.match(setCookie, /Priority=High/);
    const cookie = setCookie.split(';')[0];
    const departmentLogin = await fetch(`http://127.0.0.1:${port}/admin-login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: '惜君', password: 'test-pass', next: '/' })
    });
    assert.equal(departmentLogin.status, 303);
    const departmentCookie = (departmentLogin.headers.get('set-cookie') || '').split(';')[0];

    const beforeRestart = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual',
      headers: { Accept: 'text/html', Cookie: cookie }
    });
    assert.equal(beforeRestart.status, 200);
    const dashboardHtml = await beforeRestart.text();
    const mainScriptStartIndex = dashboardHtml.indexOf('<script>');
    const syncModalSourceIndex = dashboardHtml.indexOf('function renderSyncModal()');
    const mainScriptClosingIndex = dashboardHtml.indexOf('</script>', mainScriptStartIndex);
    const versionWatcherIndex = dashboardHtml.indexOf("fetch('/ui-version'");
    const dingTalkBootstrapIndex = dashboardHtml.indexOf('<script src="https://g.alicdn.com/dingding/dingtalk-jsapi/');
    const bodyOpenBeforeMain = (dashboardHtml.slice(0, mainScriptStartIndex).match(/<body\b/gi) || []).length;
    const bodyCloseInsideMain = (dashboardHtml.slice(mainScriptStartIndex, mainScriptClosingIndex).match(/<\/body>/gi) || []).length;
    const bodyCloseAfterMain = (dashboardHtml.slice(mainScriptClosingIndex).match(/<\/body>/gi) || []).length;
    assert.ok(mainScriptStartIndex > 0, 'main dashboard script should exist');
    assert.ok(syncModalSourceIndex > 0, 'sync modal source should remain in the main dashboard script');
    assert.ok(mainScriptClosingIndex > syncModalSourceIndex, 'main script must close after the sync modal function');
    assert.ok(versionWatcherIndex > mainScriptClosingIndex, 'version watcher must be injected after the main dashboard script');
    assert.ok(dingTalkBootstrapIndex > mainScriptClosingIndex, 'DingTalk bootstrap must be injected after the main script');
    assert.equal(bodyOpenBeforeMain, 1, 'dashboard body must open before the main script');
    assert.equal(bodyCloseInsideMain, 0, 'main script must not contain an embedded closing body tag');
    assert.equal(bodyCloseAfterMain, 1, 'dashboard body must close once after the main script');
    assert.ok(dashboardHtml.includes('const SERVER_EMPLOYEE_IDENTITIES = {"E003"'), 'dashboard should receive canonical employee identities from the server');
    assert.ok(!dashboardHtml.includes('"E069":{"name":"玖杉","realName":"周荣"'), 'historic duplicate employee IDs must be migrated away instead of remaining reusable');
    assert.ok(dashboardHtml.includes('"E003":{"name":"玖杉","realName":"周荣"'), 'historic records should resolve to the canonical employee ID');

    await stopServer(server);
    server = startServer('b'.repeat(64));
    await waitForHealth();
    const afterRestart = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual',
      headers: { Accept: 'text/html', Cookie: cookie }
    });
    assert.equal(afterRestart.status, 200);
    assert.ok(fs.existsSync(path.join(dataDir, 'admin_session_secret')));

    await stopServer(server);
    server = startServer('c'.repeat(64), 'rotated-admin');
    await waitForHealth();
    const oldAdministratorSession = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual', headers: { Accept: 'text/html', Cookie: cookie }
    });
    assert.equal(oldAdministratorSession.status, 302, 'changing the administrator account must revoke its old cookie');
    const preservedDepartmentSession = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual', headers: { Accept: 'text/html', Cookie: departmentCookie }
    });
    assert.equal(preservedDepartmentSession.status, 200, 'administrator account rotation must preserve department owner sessions');
    console.log('ADMIN_SESSION_PERSISTENCE_OK');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
