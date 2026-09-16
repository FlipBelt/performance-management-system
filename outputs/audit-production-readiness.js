#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.DATA_DIR || '/var/lib/performance-system');
const errors = [];
const warnings = [];
const info = [];

function fail(message) { errors.push(message); }
function warn(message) { warnings.push(message); }
function note(message) { info.push(message); }
function readJson(name, fallback) {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) { fail(`缺少数据文件：${name}`); return fallback; }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${name} 不是有效 JSON：${error.message}`); return fallback; }
}
function monthValid(value) { return /^20\d{2}年(?:[1-9]|1[0-2])月$/.test(String(value || '')); }
function assessmentKey(empId, month) { return `${String(empId || '').trim()}|${String(month || '').trim()}`; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function finiteInteger(value) { return Number.isFinite(Number(value)) && Number.isInteger(Number(value)); }

const monthlyRoster = readJson('assessment_roster.json', []);
const currentRoster = readJson('roster.json', []);
const exclusions = new Set(readJson('performance_exclusions.json', []));
const builtInExclusions = new Set(['打印机', '秋天', '影刀2号助手', '影刀助手1号']);
const stores = {
  target: readJson('kpi_targets.json', {}),
  draft: readJson('kpi_target_drafts.json', {}),
  self: readJson('selfeval_data.json', {}),
  manager: readJson('mgrscore_data.json', {}),
  bp: readJson('bpscore_data.json', {}),
  targetArchive: readJson('kpi_confirm_data.json', {}),
  resultArchive: readJson('result_confirm_data.json', {}),
  oa: readJson('oa_approval_data.json', {})
};

if (!Array.isArray(monthlyRoster)) fail('assessment_roster.json 必须是数组');
if (!Array.isArray(currentRoster)) fail('roster.json 必须是数组');

const byId = new Map();
const seen = { id: new Map(), userId: new Map(), name: new Map(), realName: new Map() };
for (const employee of monthlyRoster) {
  if (!employee || typeof employee !== 'object') { fail('月度花名册包含无效员工记录'); continue; }
  const id = String(employee.id || '').trim();
  const userId = String(employee.userId || '').trim();
  const name = String(employee.name || '').trim();
  const realName = String(employee.realName || '').trim();
  const department = String(employee.dept || employee.department || '').trim();
  const retiredLegacy = !userId && Boolean(employee.assessmentInactiveFromMonth);
  if (!id || !name || !realName || !department || (!employee.position && !builtInExclusions.has(name)) || (!userId && !retiredLegacy)) fail(`员工记录字段不完整：${id || name || realName || '未知员工'}`);
  if (!monthValid(employee.assessmentStartMonth) && !retiredLegacy) fail(`${id || name} 的 assessmentStartMonth 无效：${employee.assessmentStartMonth || '空'}`);
  if (employee.assessmentInactiveFromMonth && !monthValid(employee.assessmentInactiveFromMonth)) fail(`${id || name} 的 assessmentInactiveFromMonth 无效`);
  byId.set(id, employee);
  for (const [field, value] of Object.entries({ id, userId, name, realName })) {
    if (!value) continue;
    const previous = seen[field].get(value);
    if (previous && previous !== id) fail(`月度花名册 ${field} 重复：${value}（${previous}、${id}）`);
    seen[field].set(value, id);
  }
}

const activeDirectoryUserIds = new Set(currentRoster.filter(item => item && item.active !== false).map(item => String(item.userId || '')).filter(Boolean));
for (const employee of monthlyRoster) {
  if (employee.active !== false && !activeDirectoryUserIds.has(String(employee.userId || ''))) {
    warn(`月度花名册员工不在当前通讯录：${employee.id} ${employee.name}（可能为当月离职保留）`);
  }
}

function validateRecordIdentity(label, key, record) {
  if (!record || typeof record !== 'object') { fail(`${label} ${key} 不是对象`); return null; }
  const [keyEmpId, keyMonth] = String(key).split('|');
  const empId = String(record.empId || keyEmpId || '').trim();
  const month = String(record.month || keyMonth || '').trim();
  if (!empId || !monthValid(month) || key !== assessmentKey(empId, month)) fail(`${label} 键不规范：${key}`);
  const canonical = byId.get(empId);
  if (!canonical) { fail(`${label} ${key} 引用了不存在员工 ${empId}`); return null; }
  const embedded = record.emp && typeof record.emp === 'object' ? record.emp : record;
  for (const field of ['name', 'realName']) {
    if (embedded[field] && String(embedded[field]).trim() !== String(canonical[field]).trim()) {
      fail(`${label} ${key} 的 ${field} 与花名册不一致：${embedded[field]} != ${canonical[field]}`);
    }
  }
  const embeddedDept = String(embedded.dept || embedded.department || '').trim();
  const canonicalDept = String(canonical.dept || canonical.department || '').trim();
  if (embeddedDept && embeddedDept !== canonicalDept) {
    fail(`${label} ${key} 部门与月度花名册不一致：${embeddedDept} != ${canonicalDept}`);
  }
  return { empId, month, canonical };
}

for (const [storeName, store] of Object.entries(stores)) {
  if (!store || Array.isArray(store) || typeof store !== 'object') { fail(`${storeName} 数据库格式错误`); continue; }
  if (storeName === 'oa') continue;
  for (const [key, record] of Object.entries(store)) validateRecordIdentity(storeName, key, record);
  note(`${storeName}: ${Object.keys(store).length} 条`);
}

function validateScoreStore(label, store, totalField, detailField, detailScoreField) {
  for (const [key, record] of Object.entries(store)) {
    const total = Number(record && record[totalField]);
    if (!finiteInteger(total) || total < 0 || total > 120) fail(`${label} ${key} 总分非法：${record && record[totalField]}`);
    const details = record && record[detailField];
    if (!Array.isArray(details) || !details.length) { fail(`${label} ${key} 缺少评分明细`); continue; }
    const seqs = new Set();
    let sum = 0;
    for (const detail of details) {
      const seq = Number(detail && detail.seq);
      const score = Number(detail && detail[detailScoreField]);
      if (!Number.isInteger(seq) || seq <= 0 || seqs.has(seq)) fail(`${label} ${key} 明细序号无效或重复：${seq}`);
      seqs.add(seq);
      if (!finiteInteger(score) || score < 0) fail(`${label} ${key} 明细分数非法：${score}`);
      sum += score;
    }
    if (finiteInteger(total) && sum !== total) fail(`${label} ${key} 总分 ${total} 与明细合计 ${sum} 不一致`);
  }
}
validateScoreStore('自评', stores.self, 'selfScore', 'scores', 'score');
validateScoreStore('上级评分', stores.manager, 'mgrScore', 'mgrScores', 'score');
validateScoreStore('BP评分', stores.bp, 'bpScore', 'bpScores', 'score');

function validateArchive(label, store, requireSealed) {
  for (const [key, record] of Object.entries(store)) {
    if (!record.doc || !record.integrity || !record.archiveFile) { fail(`${label} ${key} 缺少文档、存证或归档文件`); continue; }
    if (requireSealed && record.sealed !== true) fail(`${label} ${key} 未封存`);
    const archivePath = path.resolve(dataDir, String(record.archiveFile));
    if (!archivePath.startsWith(dataDir + path.sep)) { fail(`${label} ${key} 归档路径越界`); continue; }
    if (!fs.existsSync(archivePath)) { fail(`${label} ${key} 归档文件不存在：${record.archiveFile}`); continue; }
    const documentHash = sha256(String(record.doc));
    if (documentHash !== String(record.integrity.finalDocumentHash || '')) fail(`${label} ${key} JSON 文档哈希不一致`);
    if (sha256(fs.readFileSync(archivePath, 'utf8')) !== documentHash) fail(`${label} ${key} 磁盘归档与 JSON 文档不一致`);
    const sidecar = archivePath + '.integrity.json';
    if (!fs.existsSync(sidecar)) fail(`${label} ${key} 缺少完整性旁证文件`);
    else {
      try {
        const evidence = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
        if (!evidence.integrity || evidence.integrity.finalDocumentHash !== documentHash) fail(`${label} ${key} 旁证哈希不一致`);
      } catch (error) { fail(`${label} ${key} 旁证文件损坏：${error.message}`); }
    }
  }
}
validateArchive('目标归档', stores.targetArchive, false);
validateArchive('结果归档', stores.resultArchive, true);

for (const [key, record] of Object.entries(stores.resultArchive)) {
  const identity = validateRecordIdentity('结果归档', key, record);
  if (!identity) continue;
  if (!stores.bp[assessmentKey(identity.empId, identity.month)]) fail(`结果归档 ${key} 缺少对应 BP 评分`);
  if (record.bpReviewStatus !== 'approved') fail(`结果归档 ${key} 未完成 BP 最终复核`);
}

for (const [key, draft] of Object.entries(stores.draft)) {
  const formal = stores.target[key];
  if (draft.status === 'approved' && !formal) fail(`目标草稿 ${key} 已批准但正式目标缺失`);
  if (draft.status !== 'approved' && formal) warn(`目标草稿 ${key} 状态为 ${draft.status}，但已存在正式目标`);
}

for (const [key, approval] of Object.entries(stores.oa)) {
  if (!approval || typeof approval !== 'object') { fail(`OA审批 ${key} 不是对象`); continue; }
  const employees = Array.isArray(approval.employees) ? approval.employees : [];
  if (!employees.length) fail(`OA审批 ${key} 没有员工明细`);
  for (const employee of employees) {
    const empId = String(employee.empId || employee.id || '').trim();
    const month = String(approval.month || employee.month || '').trim();
    const archived = stores.resultArchive[assessmentKey(empId, month)];
    if (!archived || archived.sealed !== true) fail(`OA审批 ${key} 包含未封存员工：${empId}|${month}`);
  }
}

for (const file of fs.readdirSync(dataDir).filter(name => name.endsWith('.json'))) {
  const stat = fs.statSync(path.join(dataDir, file));
  if ((stat.mode & 0o007) !== 0) fail(`${file} 对其他用户开放了文件权限：${(stat.mode & 0o777).toString(8)}`);
}

note(`月度花名册: ${monthlyRoster.length} 人；当前通讯录: ${currentRoster.length} 人；考核排除: ${exclusions.size} 人`);
console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, info, checkedAt: new Date().toISOString(), dataDir }, null, 2));
process.exitCode = errors.length ? 1 : 0;
