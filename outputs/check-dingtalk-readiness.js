#!/usr/bin/env node
'use strict';

async function main() {
  const appKey = process.env.DINGTALK_APP_KEY || '';
  const appSecret = process.env.DINGTALK_APP_SECRET || '';
  const processCode = process.env.DINGTALK_OA_PROCESS_CODE || '';
  const originatorUserId = process.env.DINGTALK_OA_ORIGINATOR_USER_ID || '';
  const result = {
    credentialsConfigured: Boolean(appKey && appSecret),
    workflowConfigured: Boolean(processCode),
    originatorConfigured: Boolean(originatorUserId),
    token: false,
    workflowSchema: false,
    originator: false
  };
  if (!result.credentialsConfigured) throw new Error('钉钉应用凭证未配置');

  const tokenResponse = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, appSecret })
  });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenData.accessToken) throw new Error(`获取钉钉令牌失败：${tokenData.code || tokenResponse.status}`);
  result.token = true;
  const headers = { 'x-acs-dingtalk-access-token': tokenData.accessToken };

  if (processCode) {
    const schemaResponse = await fetch(`https://api.dingtalk.com/v1.0/workflow/forms/schemas/processCodes?processCode=${encodeURIComponent(processCode)}`, { headers });
    const schemaData = await schemaResponse.json();
    if (!schemaResponse.ok || schemaData.code) throw new Error(`读取绩效审批模板失败：${schemaData.code || schemaResponse.status}`);
    result.workflowSchema = Boolean(schemaData.result);
  }

  if (originatorUserId) {
    const userResponse = await fetch(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(tokenData.accessToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid: originatorUserId })
    });
    const userData = await userResponse.json();
    if (!userResponse.ok || Number(userData.errcode || 0) !== 0) throw new Error(`读取OA发起人失败：${userData.errcode || userResponse.status}`);
    result.originator = Boolean(userData.result && userData.result.userid);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, message: error.message }));
  process.exitCode = 1;
});
