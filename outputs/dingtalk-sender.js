const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function loadLocalConfig(baseDir) {
  const file = path.join(baseDir, 'dingtalk_config.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error('[dingtalk] Failed to load local config:', error.message);
  }
  return {};
}

function createDingTalkSender(options) {
  options = options || {};
  const local = loadLocalConfig(options.baseDir);
  const appKey = process.env.DINGTALK_APP_KEY || local.appKey || '';
  const appSecret = process.env.DINGTALK_APP_SECRET || local.appSecret || '';
  const appId = process.env.DINGTALK_APP_ID || local.appId || '';
  const corpId = process.env.DINGTALK_CORP_ID || local.corpId || '';
  const agentId = Number(process.env.DINGTALK_AGENT_ID || local.agentId || 0);
  // Deployment supplies the enterprise application Client ID/AppKey as
  // robotCode when the config does not contain a separate override.
  const robotCode = process.env.DINGTALK_ROBOT_CODE || local.robotCode || options.robotCode || '';
  const dwsRunner = path.join(options.baseDir, 'dws-runner.ps1');
  const fetchImpl = options.fetch || global.fetch;
  const deliveryPollAttempts = Number.isFinite(options.deliveryPollAttempts) ? options.deliveryPollAttempts : 20;
  const deliveryPollIntervalMs = Number.isFinite(options.deliveryPollIntervalMs) ? options.deliveryPollIntervalMs : 250;
  let tokenCache = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function recipientIds(value) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (value === undefined || value === null || value === '') return [];
    return String(value).split(',').map((item) => item.trim()).filter(Boolean);
  }

  async function callLegacyApi(accessToken, apiPath, body) {
    const response = await fetchImpl('https://oapi.dingtalk.com' + apiPath + '?access_token=' + encodeURIComponent(accessToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok || Number(data.errcode || 0) !== 0) {
      throw new Error(data.errmsg || data.message || '钉钉投递结果查询失败');
    }
    return data.result || data;
  }

  function deliveryFailure(sendResult, userId) {
    const target = String(userId);
    const forbiddenDetails = Array.isArray(sendResult && sendResult.forbidden_list) ? sendResult.forbidden_list : [];
    const targetForbidden = forbiddenDetails.find((item) => String(item && (item.userid || item.userId) || '') === target);
    if (targetForbidden) {
      const code = String(targetForbidden.code || '');
      if (code === '143106' || code === '143206') return '相同内容当天已发送过，钉钉已拦截重复消息';
      if (code === '143105' || code === '143205') return '该应用向此员工的当日通知量已达钉钉上限';
      if (code === '143103' || code === '143104' || code === '143203' || code === '143204') return '钉钉消息发送频率超过限制，请稍后重试';
      return '钉钉流控禁止本次通知' + (code ? '（代码：' + code + '）' : '');
    }
    const groups = [
      [['invalid_user_id', 'invalid_userid', 'invalid_user_id_list'], '员工 UserId 无效或已失效'],
      [['forbidden_user_id', 'forbidden_userid', 'forbidden_user_id_list'], '钉钉禁止向该员工发送本次工作通知'],
      [['failed_user_id', 'failed_userid', 'failed_user_id_list'], '钉钉最终投递失败']
    ];
    for (const [keys, description] of groups) {
      for (const key of keys) {
        if (recipientIds(sendResult && sendResult[key]).includes(target)) return description;
      }
    }
    return '';
  }

  async function confirmWorkNotification(accessToken, taskId, userId) {
    if (!taskId) {
      return { sent: false, accepted: false, queued: false, indeterminate: true, channel: 'work-notification', error: '钉钉未返回发送任务编号，无法确认是否送达' };
    }

    let complete = false;
    for (let attempt = 0; attempt < deliveryPollAttempts; attempt += 1) {
      if (attempt > 0) await sleep(deliveryPollIntervalMs);
      const progress = await callLegacyApi(accessToken, '/topapi/message/corpconversation/getsendprogress', { agent_id: agentId, task_id: taskId });
      const progressState = progress.progress || progress;
      const status = Number(progressState.status);
      const percent = Number(progressState.progress_in_percent || 0);
      if (status === 2 || percent >= 100) {
        complete = true;
        break;
      }
    }

    // The progress endpoint can lag behind the recipient result endpoint. Query
    // the actual recipient lists even while progress still reports "sending".
    const result = await callLegacyApi(accessToken, '/topapi/message/corpconversation/getsendresult', { agent_id: agentId, task_id: taskId });
    const sendResult = result.send_result || result;
    const failure = deliveryFailure(sendResult, userId);
    if (failure) {
      return {
        sent: false,
        accepted: true,
        queued: false,
        permanent: true,
        channel: 'work-notification',
        receipt: taskId,
        error: failure + '（UserId: ' + String(userId) + '）'
      };
    }

    const target = String(userId);
    const readIds = recipientIds(sendResult.read_user_id || sendResult.read_userid || sendResult.read_user_id_list);
    const unreadIds = recipientIds(sendResult.unread_user_id || sendResult.unread_userid || sendResult.unread_user_id_list);
    const recipientConfirmed = readIds.includes(target) || unreadIds.includes(target);
    if (!complete && !recipientConfirmed) {
      return {
        sent: false,
        accepted: true,
        queued: false,
        indeterminate: true,
        channel: 'work-notification',
        receipt: taskId,
        error: '钉钉已受理发送任务，但暂未确认收件人，请稍后使用催办功能重试（任务编号：' + String(taskId) + '）'
      };
    }
    return {
      sent: true,
      accepted: true,
      queued: false,
      confirmed: true,
      deliveryState: readIds.includes(target) ? 'read' : (unreadIds.includes(target) ? 'unread' : 'completed'),
      channel: 'work-notification',
      receipt: taskId
    };
  }

  function runDws(args, timeout = 30000) {
    return execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', dwsRunner, ...args
    ], { encoding: 'utf8', timeout });
  }

  function hasDws() {
    try {
      if (process.platform === 'win32') {
        const binary = path.join(process.env.USERPROFILE || '', '.qoderworkcn', 'bin', 'dws.cmd');
        if (!fs.existsSync(dwsRunner) || !fs.existsSync(binary)) return false;
        const auth = JSON.parse(runDws(['auth', 'status', '--format', 'json'], 5000));
        return Boolean(auth.authenticated);
      }
      execFileSync('which', ['dws'], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  function status() {
    const workNotificationReady = Boolean(appKey && appSecret && agentId);
    const robotReady = Boolean(appKey && appSecret && robotCode);
    const openApiReady = workNotificationReady || robotReady;
    const dwsReady = !openApiReady && hasDws();
    return {
      ready: openApiReady || dwsReady,
      channel: robotReady ? 'robot-openapi' : (workNotificationReady ? 'work-notification' : (dwsReady ? 'dws' : 'none')),
      appIdConfigured: Boolean(appId),
      corpIdConfigured: Boolean(corpId),
      agentIdConfigured: Boolean(agentId),
      robotCodeConfigured: Boolean(robotCode),
      appCredentialsConfigured: Boolean(appKey && appSecret)
    };
  }

  function cleanError(error) {
    const raw = String(error && (error.stderr || error.stdout || error.message) || error || '');
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
      try {
        const parsed = JSON.parse(raw.slice(jsonStart));
        const detail = parsed.error || parsed;
        if (detail.code === 'not_authenticated') return '钉钉发送通道尚未登录，请先完成 DWS 登录态迁移。';
        if (detail.message || detail.errorMsg) return detail.message || detail.errorMsg;
      } catch (_) {}
    }
    if (/not_authenticated|auth login/i.test(raw)) return '钉钉发送通道尚未登录，请先完成 DWS 登录态迁移。';
    if (/fetch failed|network|connect|ECONN|socket|timeout/i.test(raw)) return '服务器无法连接钉钉 OpenAPI，请检查服务器公网网络。';
    return raw && raw.length < 300 ? raw : '钉钉发送失败，请检查发送通道状态。';
  }

  async function getAccessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;
    if (!appKey || !appSecret) throw new Error('未配置 DINGTALK_APP_KEY / DINGTALK_APP_SECRET');
    const response = await fetchImpl('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey, appSecret })
    });
    const data = await response.json();
    if (!response.ok || !data.accessToken) throw new Error(data.message || data.code || '获取钉钉 accessToken 失败');
    tokenCache = { value: data.accessToken, expiresAt: Date.now() + Number(data.expireIn || 7200) * 1000 };
    return tokenCache.value;
  }

  async function sendOpenApi(userId, msgKey, msgParam) {
    if (!robotCode) throw new Error('未配置 DINGTALK_ROBOT_CODE');
    const accessToken = await getAccessToken();
    const response = await fetchImpl('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
      body: JSON.stringify({ robotCode, userIds: [String(userId)], msgKey, msgParam: JSON.stringify(msgParam) })
    });
    const data = await response.json();
    if (!response.ok || data.code) throw new Error(data.message || data.code || '钉钉机器人发送失败');
    return { sent: true, accepted: true, confirmed: true, channel: 'robot-openapi', receipt: data.processQueryKey || null };
  }

  async function sendWorkNotification(userId, msg) {
    if (!agentId) throw new Error('未配置钉钉自建应用 AgentId');
    const accessToken = await getAccessToken();
    const response = await fetchImpl('https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=' + encodeURIComponent(accessToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        userid_list: String(userId),
        to_all_user: false,
        msg
      })
    });
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok || Number(data.errcode || 0) !== 0) {
      throw new Error(data.errmsg || data.message || '钉钉工作通知发送失败');
    }
    try {
      return await confirmWorkNotification(accessToken, data.task_id || null, userId);
    } catch (error) {
      return {
        sent: false,
        accepted: true,
        queued: false,
        indeterminate: true,
        channel: 'work-notification',
        receipt: data.task_id || null,
        error: '钉钉已受理发送任务，但最终投递结果查询失败：' + cleanError(error)
      };
    }
  }

  function sendDws(userId, title, text, filePath) {
    const args = filePath
      ? ['chat', 'message', 'send', '--user', String(userId), '--title', title, '--text', text, '--msg-type', 'file', '--file-path', filePath, '--yes', '--format', 'json']
      : ['chat', 'message', 'send-by-bot', '--robot-code', robotCode, '--users', String(userId), '--title', title, '--text', text, '--yes', '--format', 'json'];
    const output = process.platform === 'win32'
      ? runDws(args)
      : execFileSync('dws', args, { encoding: 'utf8', timeout: 30000 });
    const data = JSON.parse(output);
    if (!data.success) throw new Error(data.errorMsg || data.message || 'DWS 发送失败');
    return { sent: true, channel: 'dws', receipt: data };
  }

  async function uploadFile(filePath) {
    const accessToken = await getAccessToken();
    const form = new FormData();
    form.append('media', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    const response = await fetchImpl('https://oapi.dingtalk.com/media/upload?access_token=' + encodeURIComponent(accessToken) + '&type=file', { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok || data.errcode || !data.media_id) throw new Error(data.errmsg || '钉钉文件上传失败');
    return data.media_id;
  }

  async function sendText(userId, title, text) {
    try {
      if (appKey && appSecret && robotCode) return await sendOpenApi(userId, 'sampleText', { content: title + '\n' + text });
      if (appKey && appSecret && agentId) {
        return await sendWorkNotification(userId, { msgtype: 'text', text: { content: title + '\n' + text } });
      }
      if (hasDws()) return sendDws(userId, title, text);
      throw new Error('未配置可用的钉钉发送通道');
    } catch (error) {
      return { sent: false, channel: 'none', error: cleanError(error) };
    }
  }

  async function sendFile(userId, title, text, filePath) {
    try {
      if (!fs.existsSync(filePath)) throw new Error('待发送文件不存在: ' + filePath);
      if (appKey && appSecret && robotCode) {
        const mediaId = await uploadFile(filePath);
        const ext = path.extname(filePath).replace(/^\./, '') || 'html';
        const delivery = await sendOpenApi(userId, 'sampleFile', { mediaId, fileName: path.basename(filePath), fileType: ext });
        await sendOpenApi(userId, 'sampleText', { content: title + '\n' + text });
        return delivery;
      }
      if (appKey && appSecret && agentId) {
        const mediaId = await uploadFile(filePath);
        const delivery = await sendWorkNotification(userId, { msgtype: 'file', file: { media_id: mediaId } });
        await sendWorkNotification(userId, { msgtype: 'text', text: { content: title + '\n' + text } });
        return delivery;
      }
      if (hasDws()) return sendDws(userId, title, text, filePath);
      throw new Error('未配置可用的钉钉文件发送通道');
    } catch (error) {
      return { sent: false, channel: 'none', error: cleanError(error) };
    }
  }

  return { status, sendText, sendFile };
}

module.exports = { createDingTalkSender };
