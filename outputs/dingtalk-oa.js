const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readLocalConfig(baseDir) {
  try {
    const file = path.join(baseDir, 'dingtalk_config.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  } catch (_) {
    return {};
  }
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return !/^(0|false|off|no)$/i.test(String(value));
}

function createDingTalkOaClient(options) {
  const local = readLocalConfig(options.baseDir || __dirname);
  const oa = local.oaApproval || {};
  const appKey = process.env.DINGTALK_APP_KEY || local.appKey || '';
  const appSecret = process.env.DINGTALK_APP_SECRET || local.appSecret || '';
  const enabled = envBoolean('DINGTALK_OA_ENABLED', oa.enabled === true);
  const processName = process.env.DINGTALK_OA_PROCESS_NAME || oa.processName || '绩效奖金审批';
  const configuredProcessCode = process.env.DINGTALK_OA_PROCESS_CODE || oa.processCode || '';
  let environmentProcessRoutes = {};
  try {
    const encoded = String(process.env.DINGTALK_OA_PROCESS_ROUTES_B64 || '').trim();
    if (encoded) environmentProcessRoutes = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (_) {
    environmentProcessRoutes = {};
  }
  const processRoutes = environmentProcessRoutes && typeof environmentProcessRoutes === 'object' && Object.keys(environmentProcessRoutes).length
    ? environmentProcessRoutes
    : (oa.processRoutes && typeof oa.processRoutes === 'object' ? oa.processRoutes : {});
  const originatorUserId = process.env.DINGTALK_OA_ORIGINATOR_USER_ID || oa.originatorUserId || '';
  const configuredOriginatorUnionId = process.env.DINGTALK_OA_ORIGINATOR_UNION_ID || oa.originatorUnionId || '';
  const originatorDeptId = Number(process.env.DINGTALK_OA_ORIGINATOR_DEPT_ID || oa.originatorDeptId || -1);
  const microappAgentId = Number(process.env.DINGTALK_OA_AGENT_ID || oa.agentId || 0);
  const fetchImpl = options.fetch || global.fetch;
  let tokenCache = null;
  const processCodeCache = new Map();
  const schemaCache = new Map();
  let originatorUnionIdCache = configuredOriginatorUnionId || '';
  let approvalSpaceIdCache = '';

  function status() {
    return {
      enabled,
      ready: Boolean(enabled && appKey && appSecret && originatorUserId && microappAgentId),
      processName,
      processCodeConfigured: Boolean(configuredProcessCode),
      processRouteCount: Object.keys(processRoutes).length,
      originatorConfigured: Boolean(originatorUserId),
      agentIdConfigured: Boolean(microappAgentId)
    };
  }

  async function getAccessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;
    if (!appKey || !appSecret) throw new Error('钉钉应用凭证未配置');
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

  async function request(pathname, requestOptions) {
    const token = await getAccessToken();
    const response = await fetchImpl('https://api.dingtalk.com' + pathname, {
      ...requestOptions,
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
        ...((requestOptions && requestOptions.headers) || {})
      }
    });
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok || data.code) {
      const error = new Error(data.message || data.code || ('钉钉OA接口请求失败（HTTP ' + response.status + '）'));
      error.code = data.code || '';
      error.httpStatus = response.status;
      error.requiredScopes = data.accessdenieddetail && data.accessdenieddetail.requiredScopes || [];
      throw error;
    }
    return data;
  }

  function processRouteForSnapshot(snapshot) {
    const routeKey = String(snapshot && (snapshot.approvalGroupKey || snapshot.department) || '').trim();
    const configured = processRoutes[routeKey] || processRoutes[String(snapshot && snapshot.department || '').trim()] || {};
    return {
      key: routeKey,
      processName: String(configured.processName || processName),
      processCode: String(configured.processCode || configuredProcessCode)
    };
  }

  async function getProcessCode(route) {
    route = route || { processName, processCode: configuredProcessCode };
    if (route.processCode) return route.processCode;
    if (processCodeCache.has(route.processName)) return processCodeCache.get(route.processName);
    const candidates = [route.processName, /流程$/.test(route.processName) ? route.processName.replace(/流程$/, '') : route.processName + '流程'];
    let lastError = null;
    for (const candidate of [...new Set(candidates.filter(Boolean))]) {
      try {
        const data = await request('/v1.0/workflow/processCentres/schemaNames/processCodes?name=' + encodeURIComponent(candidate), { method: 'GET' });
        const code = data && data.result && data.result.processCode || '';
        if (code) {
          processCodeCache.set(route.processName, code);
          return code;
        }
      } catch (error) {
        if (error.requiredScopes && error.requiredScopes.length) throw error;
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    throw new Error('未找到钉钉OA模板：' + route.processName);
  }

  async function getSchema(processCode) {
    if (schemaCache.has(processCode)) return schemaCache.get(processCode);
    const data = await request('/v1.0/workflow/forms/schemas/processCodes?processCode=' + encodeURIComponent(processCode), { method: 'GET' });
    let schema = data && data.result && data.result.schemaContent || {};
    if (typeof schema === 'string') {
      try { schema = JSON.parse(schema); } catch (_) { schema = {}; }
    }
    schemaCache.set(processCode, schema);
    return schema;
  }

  async function getOriginatorUnionId() {
    if (originatorUnionIdCache) return originatorUnionIdCache;
    const token = await getAccessToken();
    const response = await fetchImpl('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userid: originatorUserId })
    });
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok || Number(data.errcode || 0) !== 0) {
      const error = new Error(data.errmsg || '查询钉钉OA发起人通讯录信息失败');
      error.code = String(data.errcode || '');
      const scopeMatch = String(data.errmsg || '').match(/requiredScopes=\[([^\]]+)\]/);
      error.requiredScopes = scopeMatch ? scopeMatch[1].split(',').map(item => item.trim()).filter(Boolean) : [];
      throw error;
    }
    originatorUnionIdCache = String(data.result && data.result.unionid || '').trim();
    if (!originatorUnionIdCache) throw new Error('未能取得钉钉OA发起人的 unionId');
    return originatorUnionIdCache;
  }

  async function getApprovalSpaceId() {
    if (approvalSpaceIdCache) return approvalSpaceIdCache;
    const data = await request('/v1.0/workflow/processInstances/spaces/infos/query', {
      method: 'POST',
      body: JSON.stringify({ userId: originatorUserId, agentId: microappAgentId })
    });
    approvalSpaceIdCache = String(data && data.result && data.result.spaceId || '').trim();
    if (!approvalSpaceIdCache) throw new Error('未能取得钉钉审批附件专属钉盘空间');
    return approvalSpaceIdCache;
  }

  async function uploadApprovalAttachment(file) {
    const filePath = path.resolve(String(file && file.path || ''));
    if (!filePath || !fs.existsSync(filePath)) throw new Error('绩效结果确认文件不存在：' + filePath);
    const content = fs.readFileSync(filePath);
    const fileName = String(file.fileName || path.basename(filePath));
    const fileType = path.extname(fileName).replace(/^\./, '').toLowerCase() || 'html';
    const unionId = await getOriginatorUnionId();
    const spaceId = await getApprovalSpaceId();
    const uploadInfo = await request('/v1.0/storage/spaces/' + encodeURIComponent(spaceId) + '/files/uploadInfos/query?unionId=' + encodeURIComponent(unionId), {
      method: 'POST',
      body: JSON.stringify({
        protocol: 'HEADER_SIGNATURE',
        multipart: false,
        option: {
          storageDriver: 'DINGTALK',
          preCheckParam: {
            md5: crypto.createHash('md5').update(content).digest('hex'),
            size: content.length,
            parentId: '0',
            name: fileName
          },
          preferRegion: 'ZHANGJIAKOU',
          preferIntranet: false
        }
      })
    });
    const signatureInfo = uploadInfo.headerSignatureInfo || {};
    const resourceUrl = Array.isArray(signatureInfo.resourceUrls) && signatureInfo.resourceUrls[0];
    if (!uploadInfo.uploadKey || !resourceUrl) throw new Error('钉钉未返回文件上传地址');
    const uploadResponse = await fetchImpl(resourceUrl, {
      method: 'PUT',
      headers: signatureInfo.headers || {},
      body: content
    });
    if (!uploadResponse.ok) {
      const body = await uploadResponse.text().catch(() => '');
      throw new Error('绩效结果确认文件上传失败（HTTP ' + uploadResponse.status + '）' + (body ? '：' + body.slice(0, 200) : ''));
    }
    const committed = await request('/v1.0/storage/spaces/' + encodeURIComponent(spaceId) + '/files/commit?unionId=' + encodeURIComponent(unionId), {
      method: 'POST',
      body: JSON.stringify({
        uploadKey: uploadInfo.uploadKey,
        name: fileName,
        parentId: '0',
        option: { size: content.length, conflictStrategy: 'OVERWRITE', appProperties: [] }
      })
    });
    const dentry = committed.dentry || {};
    const fileId = String(dentry.id || dentry.fileId || dentry.uuid || '').trim();
    if (!fileId) throw new Error('钉钉未返回已提交附件的 fileId');
    return { spaceId: String(dentry.spaceId || spaceId), fileId, fileName, fileSize: content.length, fileType };
  }

  async function uploadSnapshotAttachments(snapshot) {
    const files = Array.isArray(snapshot.archiveFiles) ? snapshot.archiveFiles : [];
    if (!files.length || files.length !== Number(snapshot.employeeCount)) {
      throw new Error('部门员工绩效结果签字确认文件不完整，禁止发起OA审批');
    }
    if (Array.isArray(snapshot.uploadedAttachments) && snapshot.uploadedAttachments.length === files.length) {
      return snapshot.uploadedAttachments;
    }
    const attachments = [];
    for (const file of files) attachments.push(await uploadApprovalAttachment(file));
    snapshot.uploadedAttachments = attachments;
    return attachments;
  }

  function flattenSchemaItems(items, output) {
    output = output || [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      const props = item.props || {};
      const label = String(item.label || item.name || props.label || props.title || '').trim();
      if (label) output.push({
        label,
        id: String(item.id || props.id || ''),
        componentType: String(item.componentType || item.componentName || ''),
        required: props.required === true,
        props
      });
      flattenSchemaItems(item.children, output);
      flattenSchemaItems(props.children, output);
      flattenSchemaItems(props.items, output);
    }
    return output;
  }

  function valueForField(field, snapshot, attachments) {
    const normalized = String(field.label || '').replace(/\s+/g, '');
    if (field.componentType === 'DDAttachment' || /附件|绩效结果确认文件/.test(normalized)) {
      if (!Array.isArray(attachments) || !attachments.length) return null;
      return { value: JSON.stringify(attachments) };
    }
    if (field.componentType === 'DepartmentField') {
      return { value: snapshot.department, extValue: JSON.stringify([{ name: snapshot.department }]) };
    }
    if (field.componentType === 'InnerContactField' && /申请人|发起人|经办人/.test(normalized)) {
      return { value: JSON.stringify([originatorUserId]) };
    }
    if (/月份|绩效周期|考核周期/.test(normalized)) return { value: snapshot.month };
    if (/部门/.test(normalized)) return { value: snapshot.department };
    if (/人数|人员数/.test(normalized)) return { value: String(snapshot.employeeCount) };
    if (/平均分|部门均分/.test(normalized)) return { value: String(snapshot.averageScore) };
    if (/总分|合计分/.test(normalized)) return { value: String(snapshot.totalScore) };
    if (/审批详情|明细|名单|绩效结果|评分结果|备注|说明/.test(normalized)) return { value: snapshot.details };
    if (/申请内容|审批内容|申请事由|审批事由|主题|标题/.test(normalized)) {
      return { value: snapshot.month + snapshot.department + '绩效奖金审批（' + snapshot.employeeCount + '人）' };
    }
    return null;
  }

  function buildFormComponentValues(schema, snapshot, attachments) {
    const fields = flattenSchemaItems(schema && schema.items);
    const values = [];
    const seen = new Set();
    for (const field of fields) {
      if (seen.has(field.label)) continue;
      const mapped = valueForField(field, snapshot, attachments);
      if (!mapped || mapped.value == null || mapped.value === '') continue;
      seen.add(field.label);
      values.push({
        name: field.label,
        value: String(mapped.value),
        ...(mapped.extValue ? { extValue: mapped.extValue } : {}),
        ...(field.id ? { id: field.id } : {}),
        ...(field.componentType ? { componentType: field.componentType } : {})
      });
    }
    if (!values.length) {
      throw new Error('“' + processName + '”模板未找到可自动填写的字段，请检查表单字段名称');
    }
    return values;
  }

  async function createDepartmentApproval(snapshot) {
    if (!enabled) return { skipped: true, reason: 'OA approval is disabled' };
    if (!originatorUserId || !microappAgentId) throw new Error('钉钉OA发起人或应用 AgentId 未配置');
    const route = processRouteForSnapshot(snapshot);
    const processCode = await getProcessCode(route);
    const schema = await getSchema(processCode);
    const fields = flattenSchemaItems(schema && schema.items);
    if (!fields.some(field => field.componentType === 'DDAttachment' || /附件/.test(field.label))) {
      throw new Error('“' + processName + '”模板没有附件控件，禁止仅以文字形式发起审批');
    }
    const forecastValues = buildFormComponentValues(schema, snapshot, []);
    const forecast = await request('/v1.0/workflow/processes/forecast', {
      method: 'POST',
      body: JSON.stringify({
        RequestId: snapshot.requestId + '-forecast',
        processCode,
        deptId: Number.isFinite(originatorDeptId) ? originatorDeptId : -1,
        userId: originatorUserId,
        formComponentValues: forecastValues
      })
    });
    if (!forecast.result || forecast.result.isForecastSuccess !== true) throw new Error('钉钉OA流程预检失败');
    const requiredSelections = (forecast.result.workflowActivityRules || []).filter(rule =>
      rule && rule.isTargetSelect && rule.workflowActor && rule.workflowActor.required === true);
    if (requiredSelections.length) {
      throw new Error('钉钉OA模板包含必选的自选审批/抄送节点，请先在模板中配置固定人员：' + requiredSelections.map(rule => rule.activityName).join('、'));
    }
    const attachments = await uploadSnapshotAttachments(snapshot);
    const formComponentValues = buildFormComponentValues(schema, snapshot, attachments);
    const body = {
      originatorUserId,
      processCode,
      deptId: Number.isFinite(originatorDeptId) ? originatorDeptId : -1,
      microappAgentId,
      formComponentValues,
      RequestId: snapshot.requestId
    };
    const data = await request('/v1.0/workflow/processInstances', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (!data.instanceId) throw new Error('钉钉OA未返回审批实例ID');
    return {
      instanceId: data.instanceId,
      processCode,
      processName: route.processName,
      processRouteKey: route.key,
      formFieldNames: formComponentValues.map(item => item.name),
      attachments
    };
  }

  return { status, getProcessCode, getSchema, buildFormComponentValues, createDepartmentApproval };
}

module.exports = { createDingTalkOaClient };
