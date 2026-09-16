const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const port = 19091;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-login-test-'));
const server = spawn(process.execPath, [path.join(__dirname, 'eval-server.js')], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: tempDir,
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'test-password',
    LINK_SIGNING_SECRET: '0123456789abcdef0123456789abcdef',
    PUBLIC_SERVER_URL: 'https://jxgl.flipbeltchina.com'
  },
  stdio: 'ignore'
});

async function waitUntilReady() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('test server did not start');
}

(async () => {
  try {
    await waitUntilReady();
    const unauthorized = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual', headers: { Accept: 'text/html' }
    });
    const loginPage = await fetch(`http://127.0.0.1:${port}/login`);
    const loginHtml = await loginPage.text();
    const login = await fetch(`http://127.0.0.1:${port}/admin-login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'test-password', next: '/' })
    });
    const setCookie = login.headers.get('set-cookie') || '';
    const cookie = (setCookie.match(/perf_admin_session=[^;]+/) || [''])[0];
    const authorized = await fetch(`http://127.0.0.1:${port}/`, { headers: { Cookie: cookie } });
    const result = {
      redirectStatus: unauthorized.status,
      redirectLocation: unauthorized.headers.get('location'),
      noBasicAuthChallenge: !unauthorized.headers.get('www-authenticate'),
      loginPageStatus: loginPage.status,
      loginFormPresent: loginHtml.includes('/admin-login'),
      loginStatus: login.status,
      secureCookie: /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie),
      persistentCookie: /Max-Age=31536000/i.test(setCookie),
      cookieAuthStatus: authorized.status
    };
    const passed = result.redirectStatus === 302 && result.noBasicAuthChallenge && result.loginPageStatus === 200 &&
      result.loginFormPresent && result.loginStatus === 303 && result.secureCookie && result.persistentCookie && result.cookieAuthStatus === 200;
    console.log(JSON.stringify({ passed, ...result }));
    if (!passed) process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
    if (path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()))) fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
