const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const port = 19144;
const baseDir = __dirname;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-realtime-test-'));
const serverSource = fs.readFileSync(path.join(baseDir, 'eval-server.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(baseDir, 'preview.html'), 'utf8');
const server = spawn(process.execPath, [path.join(baseDir, 'eval-server.js')], {
  cwd: path.resolve(baseDir, '..'),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: tempDir,
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'test-password',
    LINK_SIGNING_SECRET: '0123456789abcdef0123456789abcdef',
    NODE_ENV: 'test',
    DISABLE_EXTERNAL_NOTIFICATIONS: '1',
    DINGTALK_APP_KEY: '',
    DINGTALK_APP_SECRET: '',
    DINGTALK_ROBOT_CODE: ''
  },
  stdio: 'ignore'
});

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitUntilReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch (_) {}
    await delay(100);
  }
  throw new Error('test server did not start');
}

function openEventStream() {
  return new Promise((resolve, reject) => {
    const authorization = 'Basic ' + Buffer.from('admin:test-password').toString('base64');
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/workflow-events', method: 'GET',
      headers: { Accept: 'text/event-stream', Authorization: authorization }
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('timed out waiting for workflow event stream'));
    }, 5000);
    req.on('response', res => {
      let text = '';
      let ready = false;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (!ready && text.includes('event: ready')) {
          ready = true;
          resolve({
            req,
            res,
            waitForChange() {
              return new Promise((resolveChange, rejectChange) => {
                const changeTimer = setTimeout(() => rejectChange(new Error('timed out waiting for workflow change')), 5000);
                function inspect() {
                  if (text.includes('event: workflow-change') && text.includes('workflow_resets.json')) {
                    clearTimeout(changeTimer);
                    res.off('data', inspect);
                    resolveChange(text);
                  }
                }
                res.on('data', inspect);
                inspect();
              });
            },
            close() { clearTimeout(timer); req.destroy(); res.destroy(); }
          });
        }
      });
      res.on('error', error => { if (!ready) reject(error); });
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end();
  });
}

(async () => {
  let stream;
  try {
    await waitUntilReady();
    const unauthorized = await fetch(`http://127.0.0.1:${port}/workflow-events`, { redirect: 'manual' });
    stream = await openEventStream();
    const changePromise = stream.waitForChange();
    const watchedFile = path.join(tempDir, 'workflow_resets.json');
    const temporary = watchedFile + '.test-tmp';
    fs.writeFileSync(temporary, JSON.stringify({ realtimeTest: Date.now() }), 'utf8');
    fs.renameSync(temporary, watchedFile);
    const eventText = await changePromise;

    const checks = {
      unauthenticatedIsRejected: unauthorized.status === 302 || unauthorized.status === 401,
      authenticatedSseWorks: eventText.includes('event: workflow-change'),
      changedFileIsPublished: eventText.includes('workflow_resets.json'),
      noWorkflowPayloadLeak: !eventText.includes('realtimeTest'),
      serverUsesAuthenticatedRoute: serverSource.includes("pathname === '/workflow-events'") && serverSource.includes("'text/event-stream; charset=utf-8'"),
      serverKeepsProxyStreamUnbuffered: serverSource.includes("'X-Accel-Buffering': 'no'"),
      dashboardUsesEventSource: dashboardSource.includes("new EventSource(SYNC_SERVER_URL + '/workflow-events')"),
      dashboardRetainsPollingFallback: /setInterval\(\(\) => \{ syncFromServer\(\); \}, 5000\)/.test(dashboardSource),
      dashboardRetainsFocusFallback: dashboardSource.includes("window.addEventListener('focus', () => syncFromServer())")
    };
    const passed = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ passed, ...checks }));
    if (!passed) process.exitCode = 1;
  } finally {
    if (stream) stream.close();
    server.kill('SIGTERM');
    await delay(100);
    if (path.resolve(tempDir).startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
