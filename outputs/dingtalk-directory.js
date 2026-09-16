const fs = require('fs');
const path = require('path');

function readLocalConfig(baseDir) {
  try {
    const file = path.join(baseDir, 'dingtalk_config.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  } catch (_) {
    return {};
  }
}

function createDingTalkDirectory(options = {}) {
  const local = readLocalConfig(options.baseDir || __dirname);
  const appKey = process.env.DINGTALK_APP_KEY || local.appKey || '';
  const appSecret = process.env.DINGTALK_APP_SECRET || local.appSecret || '';
  const fetchImpl = options.fetch || global.fetch;
  let tokenCache = null;

  function status() {
    return { ready: Boolean(appKey && appSecret), appCredentialsConfigured: Boolean(appKey && appSecret) };
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

  async function request(pathname, body) {
    const token = await getAccessToken();
    const response = await fetchImpl('https://oapi.dingtalk.com' + pathname + '?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok || Number(data.errcode || 0) !== 0) {
      throw new Error(data.errmsg || data.message || ('钉钉通讯录接口失败（HTTP ' + response.status + '）'));
    }
    return data.result || {};
  }

  async function listDepartments() {
    const root = { dept_id: 1, parent_id: 0, name: '公司' };
    const departments = [root];
    const pending = [root];
    const seen = new Set([1]);
    while (pending.length) {
      const parent = pending.shift();
      const children = await request('/topapi/v2/department/listsub', { dept_id: Number(parent.dept_id) });
      for (const department of Array.isArray(children) ? children : []) {
        const deptId = Number(department.dept_id);
        if (!deptId || seen.has(deptId)) continue;
        seen.add(deptId);
        const normalized = { ...department, dept_id: deptId, parent_id: Number(department.parent_id || parent.dept_id) };
        departments.push(normalized);
        pending.push(normalized);
      }
    }
    return departments;
  }

  async function listDepartmentUsers(deptId) {
    const users = [];
    let cursor = 0;
    do {
      const result = await request('/topapi/v2/user/list', {
        dept_id: Number(deptId), cursor, size: 100, contain_access_limit: true
      });
      users.push(...(Array.isArray(result.list) ? result.list : []));
      if (!result.has_more) break;
      cursor = Number(result.next_cursor || 0);
    } while (cursor >= 0);
    return users;
  }

  function splitDisplayName(displayName) {
    const parts = String(displayName || '').trim().split(/\s*[-—－]\s*/).filter(Boolean);
    if (parts.length >= 2) return { nick: parts[0], realName: parts.slice(1).join('-') };
    const name = parts[0] || String(displayName || '').trim();
    return { nick: name, realName: name };
  }

  function canonicalDepartmentName(deptIds, departmentById, fallback) {
    const canonical = new Set(['总裁办', '人事行政部', '财务部', '品牌营销部', '采购仓储部', '产品设计', '信息技术部', '客户运营部']);
    // Keep accepting the previous DingTalk department name during the rename
    // window, but never write it back into the performance-system roster.
    const aliases = { '客户运营': '客户运营部', '营销中心': '品牌营销部' };
    for (const deptId of Array.isArray(deptIds) ? deptIds : []) {
      let current = departmentById.get(Number(deptId));
      const visited = new Set();
      while (current && !visited.has(Number(current.dept_id))) {
        visited.add(Number(current.dept_id));
        const rawName = String(current.name || '').trim();
        const name = aliases[rawName] || rawName;
        if (canonical.has(name)) return name;
        current = departmentById.get(Number(current.parent_id));
      }
    }
    if (fallback) return aliases[String(fallback).trim()] || fallback;
    const direct = departmentById.get(Number((Array.isArray(deptIds) && deptIds[0]) || 0));
    const directName = String(direct && direct.name || '').trim();
    return aliases[directName] || directName;
  }

  async function syncRoster(existingRoster = []) {
    const departments = await listDepartments();
    const departmentById = new Map(departments.map(item => [Number(item.dept_id), item]));
    const usersById = new Map();
    for (const department of departments) {
      const users = await listDepartmentUsers(department.dept_id);
      for (const user of users) {
        const userId = String(user.userid || '').trim();
        if (!userId) continue;
        const previous = usersById.get(userId) || {};
        usersById.set(userId, { ...previous, ...user });
      }
    }
    const existingByUserId = new Map((Array.isArray(existingRoster) ? existingRoster : [])
      .filter(item => item && item.userId).map(item => [String(item.userId), item]));
    const syncedAt = new Date().toISOString();
    return [...usersById.values()].filter(user => user.active !== false).map(user => {
      const userId = String(user.userid);
      const names = splitDisplayName(user.name);
      const old = existingByUserId.get(userId) || {};
      const department = canonicalDepartmentName(user.dept_id_list, departmentById, old.department || '');
      return {
        ...old,
        nick: names.nick || old.nick || user.name,
        realName: names.realName || old.realName || user.name,
        userId,
        unionId: String(user.unionid || old.unionId || ''),
        department,
        title: String(user.title || old.title || ''),
        active: user.active !== false,
        syncedAt
      };
    }).sort((left, right) => String(left.department).localeCompare(String(right.department), 'zh-CN') ||
      String(left.nick).localeCompare(String(right.nick), 'zh-CN'));
  }

  return { status, syncRoster };
}

module.exports = { createDingTalkDirectory };
