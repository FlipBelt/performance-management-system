const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const crypto = require('crypto');

const projectDir = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfeval-layout-'));
const port = 18191;

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
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

async function main() {
  fs.writeFileSync(path.join(dataDir, 'kpi_targets.json'), JSON.stringify({
    'ETEST|2026年7月': {
      emp: {
        name: '测试员', realName: '测试姓名', dept: '测试部',
        position: '测试岗', directMgr: '测试上级',
      },
      kpis: [{
        seq: 1,
        indicator: '绩效指标',
        target: '评分细则内容应横向完整展示',
        dataSource: '目标值：100%完成 数据来源：OA审批数据+直属上级评分',
        weight: 100,
        items: [
          { indicator: '分项一', rule: '分项一评分细则', dataSource: 'OA审批数据', weight: 40 },
          { indicator: '分项二', rule: '分项二评分细则', dataSource: '直属上级评分', weight: 60 },
        ],
      }],
      month: '2026年7月',
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'kpi_confirm_data.json'), JSON.stringify({
    'ETEST|2026年7月': { empId: 'ETEST', month: '2026年7月', name: '测试员', realName: '测试姓名', doc: '<html>signed target</html>' },
  }, null, 2));

  for (const filename of [
    'mgrscore_data.json', 'bpscore_data.json', 'selfeval_data.json',
    'result_confirm_data.json', 'workflow_resets.json',
  ]) {
    fs.writeFileSync(path.join(dataDir, filename), '{}');
  }

  const child = cp.spawn(process.execPath, [path.join(projectDir, 'outputs', 'eval-server.js')], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      LINK_SIGNING_SECRET: 'test-secret',
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: 'ignore',
  });

  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const health = await get(`http://127.0.0.1:${port}/healthz`);
        if (health.status === 200) break;
      } catch (_) {
        // Service is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = Buffer.from('ETEST|2026年7月').toString('base64url');
    const pathname = `/selfeval-page/${payload}`;
    const token = crypto.createHmac('sha256', 'test-secret').update(pathname).digest('hex');
    const page = await get(`http://127.0.0.1:${port}${pathname}?token=${token}`);
    const scripts = [...page.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    for (const script of scripts) new Function(script[1]);

    const actionPath = '/workflow-action/self/ETEST/' + encodeURIComponent('2026年7月');
    const actionToken = crypto.createHmac('sha256', 'test-secret').update(actionPath).digest('hex');
    const submission = await post('/submit', {
      empId: 'ETEST', name: '测试员', realName: '测试姓名', month: '2026年7月', selfScore: 100,
      details: [
        { seq: 1, parentSeq: 1, selfScore: 70, completion: '分项一实际完成情况' },
        { seq: 2, parentSeq: 1, selfScore: 50, completion: '分项二实际完成情况' },
      ],
      sigData: 'data:image/png;base64,test', actionToken,
    });
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'selfeval_data.json'), 'utf8'))['ETEST|2026年7月'];

    const checks = {
      status: page.status === 200,
      widePage: page.body.includes('width:min(1320px,100%)'),
      wideTable: page.body.includes('min-width:1160px'),
      splitCompletionInputs: (page.body.match(/textarea class="note-input"/g) || []).length === 2,
      completionLabels: page.body.includes('分项一实际完成情况') === false && page.body.includes('请填写本考核项的实际完成情况'),
      columns: ['考核指标', '评分细则', '数据来源', '权重', '完成情况', '自评分']
        .every((label) => page.body.includes(label)),
      cleanSource: page.body.includes('OA审批数据') && page.body.includes('上级评分'),
      removedCompoundSource: !page.body.includes('目标值：100%完成 数据来源'),
      validScripts: scripts.length > 0,
      splitScoreInputs: (page.body.match(/class="score-input"/g) || []).length === 2,
      noPerItemMaximum: !page.body.includes('class="score-input" data-seq="1" data-parent-seq="1" data-weight="40" min="0" max='),
      totalLimitHint: page.body.includes('整表总分上限120分'),
      parentAutoTotal: page.body.includes('data-parent-total="1"'),
      provisionalGradeVisible: page.body.includes('selfProvisionalGrade') && page.body.includes('（待核定）') && page.body.includes('最终分数和等级以BP核准结果为准'),
      submissionAccepted: submission.status === 200,
      splitScoresPersisted: stored && stored.scores.length === 2 && stored.scores[0].score === 70 && stored.scores[1].score === 50,
      splitCompletionPersisted: stored && stored.scores[0].completion === '分项一实际完成情况' && stored.scores[1].completion === '分项二实际完成情况',
      childMetadataPersisted: stored && stored.scores.every(score => score.grouped === true && score.parentIndicator === '绩效指标'),
      provisionalGradePersisted: stored && stored.provisionalGrade === 'A-',
    };
    console.log(JSON.stringify(checks));
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
