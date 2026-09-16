const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDingTalkOaClient } = require('./dingtalk-oa');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-oa-'));
const archivePath = path.join(tempDir, 'result.html');
fs.writeFileSync(archivePath, '<html>signed result</html>', 'utf8');
const calls = [];

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
  };
}

async function mockFetch(url, options = {}) {
  calls.push({ url, options });
  if (url.includes('/oauth2/accessToken')) return response(200, { accessToken: 'token', expireIn: 7200 });
  if (url.includes('/workflow/forms/schemas/')) return response(200, { result: { schemaContent: {
    items: [
      { id: 'dept', componentType: 'DepartmentField', props: { label: '申请部门', required: true } },
      { id: 'person', componentType: 'InnerContactField', props: { label: '申请人', required: true } },
      { id: 'content', componentType: 'TextField', props: { label: '申请内容', required: true } },
      { id: 'detail', componentType: 'TextareaField', props: { label: '审批详情', required: true } },
      { id: 'attachment', componentType: 'DDAttachment', props: { label: '附件' } },
    ]
  } } });
  if (url.includes('/workflow/processes/forecast')) return response(200, { result: { isForecastSuccess: true, workflowActivityRules: [] } });
  if (url.includes('/topapi/v2/user/get')) return response(200, { errcode: 0, errmsg: 'ok', result: { unionid: 'union-1' } });
  if (url.includes('/workflow/processInstances/spaces/infos/query')) return response(200, { result: { spaceId: 12345 } });
  if (url.includes('/files/uploadInfos/query')) return response(200, {
    uploadKey: 'upload-1',
    headerSignatureInfo: { resourceUrls: ['https://oss.example/upload'], headers: { Authorization: 'signed' } }
  });
  if (url === 'https://oss.example/upload') return response(200, '');
  if (url.includes('/files/commit')) return response(200, { dentry: { id: 'file-1', spaceId: '12345' } });
  if (url.endsWith('/v1.0/workflow/processInstances')) {
    const body = JSON.parse(options.body);
    const attachment = body.formComponentValues.find(item => item.name === '附件');
    assert(attachment, 'OA request must include the attachment field');
    assert.deepStrictEqual(JSON.parse(attachment.value), [{
      spaceId: '12345', fileId: 'file-1', fileName: 'result.html', fileSize: 26, fileType: 'html'
    }]);
    return response(200, { instanceId: 'instance-1' });
  }
  throw new Error('Unexpected request: ' + url);
}

(async () => {
  process.env.DINGTALK_OA_ENABLED = 'true';
  process.env.DINGTALK_OA_PROCESS_CODE = 'PROC-TEST';
  process.env.DINGTALK_OA_ORIGINATOR_USER_ID = 'user-1';
  process.env.DINGTALK_OA_AGENT_ID = '123';
  delete process.env.DINGTALK_OA_ORIGINATOR_UNION_ID;
  const client = createDingTalkOaClient({ baseDir: __dirname, fetch: mockFetch });
  const result = await client.createDepartmentApproval({
    month: '2026年7月', department: '人事行政部', employeeCount: 1,
    totalScore: 100, averageScore: 100, details: '1. 测试：100分', requestId: 'request-1',
    archiveFiles: [{ path: archivePath, fileName: 'result.html', size: 26 }]
  });
  assert.strictEqual(result.instanceId, 'instance-1');
  assert.strictEqual(result.attachments.length, 1);
  const forecastIndex = calls.findIndex(call => call.url.includes('/workflow/processes/forecast'));
  const uploadIndex = calls.findIndex(call => call.url.includes('/files/uploadInfos/query'));
  const createIndex = calls.findIndex(call => call.url.endsWith('/v1.0/workflow/processInstances'));
  assert(forecastIndex >= 0 && forecastIndex < uploadIndex && uploadIndex < createIndex);
  console.log(JSON.stringify({ passed: true, attachments: result.attachments, callCount: calls.length }));
})().finally(() => fs.rmSync(tempDir, { recursive: true, force: true }));
