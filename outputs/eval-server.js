/**
 * 绩效自评 + 上级评分 通知服务 v3
 * 
 * 架构：
 * - 本服务器接收自评/上级评分数据，生成个性化评分页面
 * - 通知任务写入队列文件 pending_notifications.json
 * - 由外部 send-notifications.js（在Bash工具中运行）执行实际dws发送
 * 
 * 启动: node eval-server.js
 */

const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const ROBOT_CODE = process.env.DINGTALK_ROBOT_CODE || '';
const fs = require('fs');
const path = require('path');
const dingTalkSenderModule = { exports: {} };
const dingTalkSenderSource = fs.readFileSync(path.join(__dirname, 'dingtalk-sender.js'), 'utf8');
new Function('module', 'exports', 'require', '__dirname', dingTalkSenderSource)(dingTalkSenderModule, dingTalkSenderModule.exports, require, __dirname);
const { createDingTalkSender } = dingTalkSenderModule.exports;
const { createDingTalkOaClient } = require(path.join(__dirname, 'dingtalk-oa.js'));
const { createDingTalkDirectory } = require(path.join(__dirname, 'dingtalk-directory.js'));
const { createOkrModule } = require(path.join(__dirname, 'okr-module.js'));

const PORT = process.env.PORT || 18080;
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
let dingTalkLocalConfig = {};
try {
  const configPath = path.join(__dirname, 'dingtalk_config.json');
  if (fs.existsSync(configPath)) dingTalkLocalConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error('[config] Failed to load dingtalk_config.json:', error.message);
}
const PUBLIC_SERVER_URL = (process.env.PUBLIC_SERVER_URL || process.env.RENDER_EXTERNAL_URL || dingTalkLocalConfig.publicBaseUrl || ('http://192.168.2.193:' + PORT)).replace(/\/$/, '');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const LINK_SIGNING_SECRET = process.env.LINK_SIGNING_SECRET || '';
const DINGTALK_APP_KEY = process.env.DINGTALK_APP_KEY || dingTalkLocalConfig.appKey || '';
const DINGTALK_APP_SECRET = process.env.DINGTALK_APP_SECRET || dingTalkLocalConfig.appSecret || '';
const DINGTALK_CORP_ID = process.env.DINGTALK_CORP_ID || dingTalkLocalConfig.corpId || '';
const EXTERNAL_NOTIFICATIONS_DISABLED = process.env.DISABLE_EXTERNAL_NOTIFICATIONS === '1';
const MAX_TOTAL_SCORE = 120;
if (process.env.NODE_ENV === 'production' && (!ADMIN_PASSWORD || !LINK_SIGNING_SECRET)) {
  throw new Error('ADMIN_PASSWORD and LINK_SIGNING_SECRET are required in production');
}
const dingTalkSender = createDingTalkSender({ baseDir: __dirname, robotCode: ROBOT_CODE });
const PAGES_DIR = __dirname;
const DASHBOARD_BUILD_ID = (() => {
  try {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(path.join(PAGES_DIR, 'preview.html')));
    hash.update(fs.readFileSync(__filename));
    return hash.digest('hex').slice(0, 16);
  } catch (_) {
    return String(Date.now());
  }
})();
const GENERATED_DIR = path.join(DATA_DIR, 'generated-pages');
const TEMP_DIR = path.join(DATA_DIR, '.temp-pages');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archives');
const KPI_ARCHIVE_DIR = path.join(ARCHIVE_DIR, 'kpi-targets');
const RESULT_ARCHIVE_DIR = path.join(ARCHIVE_DIR, 'performance-results');
const ADMIN_SESSION_SECRET_FILE = path.join(DATA_DIR, 'admin_session_secret');
if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(KPI_ARCHIVE_DIR)) fs.mkdirSync(KPI_ARCHIVE_DIR, { recursive: true });
if (!fs.existsSync(RESULT_ARCHIVE_DIR)) fs.mkdirSync(RESULT_ARCHIVE_DIR, { recursive: true });

function loadAdminSessionSecret() {
  try {
    if (fs.existsSync(ADMIN_SESSION_SECRET_FILE)) {
      const persisted = fs.readFileSync(ADMIN_SESSION_SECRET_FILE, 'utf8').trim();
      if (persisted.length >= 32) return persisted;
      throw new Error('persisted admin session secret is invalid');
    }
    // Seed with the former signing key so cookies issued before this upgrade
    // remain valid. Future deployments no longer rotate administrator sessions.
    fs.writeFileSync(ADMIN_SESSION_SECRET_FILE, LINK_SIGNING_SECRET, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return LINK_SIGNING_SECRET;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') throw error;
    return LINK_SIGNING_SECRET || crypto.randomBytes(32).toString('hex');
  }
}

const ADMIN_SESSION_SECRET = loadAdminSessionSecret();

function safeArchivePart(value, fallback) {
  const cleaned = String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_');
  return cleaned || fallback;
}

function archiveSignedDocument(type, data, integrity, auditEntry) {
  if (!data || typeof data.doc !== 'string' || !data.doc.trim()) return '';
  const archiveDirectory = type === 'result' ? RESULT_ARCHIVE_DIR : KPI_ARCHIVE_DIR;
  const label = type === 'result' ? '绩效结果签字确认' : '绩效目标签字确认';
  const version = safeArchivePart(data.serverSignedAt || new Date().toISOString(), '未知时间').replace(/[-:.TZ]/g, '');
  const hashPart = integrity && integrity.finalDocumentHash ? integrity.finalDocumentHash.slice(0, 12) : crypto.randomBytes(6).toString('hex');
  const fileName = [
    safeArchivePart(data.month, '未知月份'),
    safeArchivePart(data.empId, '未知员工'),
    safeArchivePart(data.name || data.realName, '未知姓名'),
    label,
    version,
    hashPart
  ].join('_') + '.html';
  const archivePath = path.join(archiveDirectory, fileName);
  fs.writeFileSync(archivePath, data.doc, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
  fs.writeFileSync(archivePath + '.integrity.json', JSON.stringify({ integrity, audit: auditEntry }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o640 });
  return path.relative(DATA_DIR, archivePath).replace(/\\/g, '/');
}

function dataFile(name, emptyValue) {
  const target = path.join(DATA_DIR, name);
  if (!fs.existsSync(target)) {
    const seed = path.join(__dirname, name);
    if (DATA_DIR !== __dirname && fs.existsSync(seed)) fs.copyFileSync(seed, target);
    else fs.writeFileSync(target, JSON.stringify(emptyValue, null, 2), 'utf8');
  }
  return target;
}

const DATA_FILE = dataFile('selfeval_data.json', {});
const MGR_DATA_FILE = dataFile('mgrscore_data.json', {});
const BP_DATA_FILE = dataFile('bpscore_data.json', {});
const KPI_DATA_FILE = dataFile('kpi_confirm_data.json', {});
const RESULT_DATA_FILE = dataFile('result_confirm_data.json', {});
const QUEUE_FILE = dataFile('pending_notifications.json', []);
const ROSTER_FILE = dataFile('roster.json', []);
const KPI_TARGETS_FILE = dataFile('kpi_targets.json', {});
const KPI_TARGET_DRAFTS_FILE = dataFile('kpi_target_drafts.json', {});
const WORKFLOW_RESETS_FILE = dataFile('workflow_resets.json', {});
const OA_APPROVAL_FILE = dataFile('oa_approval_data.json', {});
const PERFORMANCE_EXCLUSIONS_FILE = dataFile('performance_exclusions.json', []);
const ASSESSMENT_ROSTER_FILE = dataFile('assessment_roster.json', []);
const ADMIN_DINGTALK_BINDING_FILE = dataFile('admin_dingtalk_binding.json', {});
const MONTHLY_EVENTS_FILE = dataFile('monthly_events.json', {});
const OPERATION_AUDIT_FILE = path.join(DATA_DIR, 'operation_audit.jsonl');
if (!fs.existsSync(OPERATION_AUDIT_FILE)) fs.writeFileSync(OPERATION_AUDIT_FILE, '', { encoding: 'utf8', mode: 0o640 });
try { fs.chmodSync(OPERATION_AUDIT_FILE, 0o640); } catch (_) {}
const DEFAULT_EMPLOYEE_OVERRIDES = {
  '口蘑': { department: '采购仓储部', directMgr: '球球' },
  '卢卡': { department: '采购仓储部', directMgr: '球球' },
  '廿一': { department: '产品设计', directMgr: 'Ben' },
  '俊俊': { department: '兴趣电商', directMgr: '豪杰' }
};
const EMPLOYEE_OVERRIDES_FILE = dataFile('employee_overrides.json', DEFAULT_EMPLOYEE_OVERRIDES);
let adminDingTalkBinding = {};
try {
  adminDingTalkBinding = JSON.parse(fs.readFileSync(ADMIN_DINGTALK_BINDING_FILE, 'utf8')) || {};
} catch (error) {
  if (process.env.NODE_ENV === 'production') throw new Error('Failed to load admin DingTalk binding: ' + error.message);
}

function saveAdminDingTalkBinding(identity, req) {
  const next = {
    userId: String(identity.userId || ''),
    unionId: String(identity.unionId || ''),
    boundAt: new Date().toISOString(),
    boundIp: requestIp(req)
  };
  const temporary = ADMIN_DINGTALK_BINDING_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o640 });
  fs.renameSync(temporary, ADMIN_DINGTALK_BINDING_FILE);
  adminDingTalkBinding = next;
  return next;
}
// Non-employee DingTalk accounts must never enter an assessment denominator.
// Keep them in the directory cache, but exclude them from KPI/score/OA views.
const PERFORMANCE_ROSTER_EXCLUSIONS = new Set(['打印机', '秋天', '影刀2号助手', '影刀助手1号']);
const FIXED_NICKNAME_BY_REAL_NAME = Object.freeze({
  '姚耀相': '大象'
});
function canonicalEmployeeNickname(employee) {
  employee = employee || {};
  const realName = String(employee.realName || '').trim();
  return FIXED_NICKNAME_BY_REAL_NAME[realName] || String(employee.nick || employee.name || '').trim();
}
const FIXED_POSITION_BY_NAME = Object.freeze({
  '薏米': 'HRBP', '小青': '出纳', '小敏': '财务助理', '晴天': '财务助理', '安妮': '总账会计',
  '红豆': '客服组长', '饭团': 'AI训练师', '大寸': '客服专员', '小熊': '客服专员',
  '沐沐': '客服专员', '银铃': '客服专员', '核桃': '客服专员', '小久': '客服专员',
  '阿信': '客服专员', '杏仁': '客服专员',
  '大林': '中控', '小曹': '中控', '肚子': '拍剪', '多乐': '京东店长',
  '归雾': '京东运营', '栗子': '主播', '俊俊': '兴趣电商负责人', '芒果': '编导',
  '楠轶': '活动策划', '小熊猫': '营销策划', '团子': '营销策划', '甜粄': '短视频组长',
  '飞鱼': '仓管', '小邹': '仓管', '立秋': '仓管', '佳禾': '大货理单', '姚耀相': '大货理单', '大象': '大货理单',
  '口蘑': '大货理单助理', '卢卡': '大货理单助理', '球球': '供应链负责人',
  '勺子': '采购实习生', '糖糖': '成衣开发', '虾饺': '采购助理', '夏天': '面辅料开发'
});
const MARKETING_SUBDEPARTMENT_BY_NAME = Object.freeze({
  '达古': '天猫', '图图': '天猫', '三七': '天猫',
  '多乐': '京东', '归雾': '京东', '雯雯': '京东',
  '俊俊': '兴趣电商', '六六': '兴趣电商', '大林': '兴趣电商', '小曹': '兴趣电商',
  '栗子': '兴趣电商', '一添': '兴趣电商', '云锦': '兴趣电商'
});
const BRAND_MARKETING_DEPARTMENT = '品牌营销部';
const LEGACY_MARKETING_DEPARTMENT = '营销中心';
function canonicalOrganizationDepartment(department) {
  const normalized = String(department || '').trim();
  return normalized === LEGACY_MARKETING_DEPARTMENT ? BRAND_MARKETING_DEPARTMENT : normalized;
}
const MARKETING_APPROVAL_LEADER_BY_GROUP = Object.freeze({
  '天猫': '达古', '京东': '多乐', '兴趣电商': '俊俊'
});
const OA_COMBINED_DEPARTMENT_GROUPS = Object.freeze([
  Object.freeze({
    key: '总裁办、人事行政部、财务部',
    department: '总裁办、人事行政部、财务部',
    memberDepartments: Object.freeze(['总裁办', '人事行政部', '财务部'])
  }),
  Object.freeze({
    key: '采购仓储部、产品设计',
    department: '采购仓储部、产品设计',
    memberDepartments: Object.freeze(['采购仓储部', '产品设计'])
  })
]);

// Dashboard authorization is based on the DingTalk user behind the session.
// Department labels here are the normalized display departments used by the
// monthly assessment roster (marketing sub-groups are intentionally separate).
const GLOBAL_ADMIN_NAMES = new Set(['桑葚', '薏米', '路得', 'Ben']);
const BP_SCORER_NAMES = new Set(['桑葚', '薏米', '路得']);
const DEPARTMENT_ACCESS_BY_NAME = Object.freeze({
  '球球': Object.freeze(['客户运营部', '采购仓储部', '产品设计']),
  '豪杰': Object.freeze([BRAND_MARKETING_DEPARTMENT, '天猫', '京东', '兴趣电商']),
  '达古': Object.freeze(['天猫']),
  '多乐': Object.freeze(['京东']),
  '俊俊': Object.freeze(['兴趣电商']),
  '红豆': Object.freeze(['客户运营部']),
  '惜君': Object.freeze(['信息技术部']),
  '廿一': Object.freeze(['产品设计']),
  '安妮': Object.freeze(['财务部'])
});
// Version 3 makes every authorized user complete the new password-first login
// once. The signed cookie is then renewed for one year on each visit.
const ADMIN_SESSION_VERSION = 3;

function accessProfileForName(name) {
  name = String(name || '').trim();
  if (GLOBAL_ADMIN_NAMES.has(name) || name === '系统管理员') {
    return {
      authorized: true,
      name,
      role: name === '系统管理员' ? '系统管理员' : '全局管理员',
      global: true,
      departments: [],
      canManageOrganization: true
    };
  }
  const departments = DEPARTMENT_ACCESS_BY_NAME[name];
  if (!departments) return { authorized: false, name, role: '', global: false, departments: [], canManageOrganization: false };
  return {
    authorized: true,
    name,
    role: departments.length > 1 ? '跨部门负责人' : '部门负责人',
    global: false,
    departments: [...departments],
    canManageOrganization: false
  };
}

function canScoreAsBp(profile) {
  return Boolean(profile && profile.authorized && BP_SCORER_NAMES.has(String(profile.name || '').trim()));
}

function canInitiateTargetAdjustment(profile) {
  return Boolean(profile && profile.authorized && GLOBAL_ADMIN_NAMES.has(String(profile.name || '').trim()));
}

function canViewOperationLogs(profile) {
  return Boolean(profile && profile.authorized && GLOBAL_ADMIN_NAMES.has(String(profile.name || '').trim()));
}

function canPerformBpResultInBackend(profile) {
  return Boolean(profile && profile.authorized &&
    (String(profile.name || '').trim() === '系统管理员' || canScoreAsBp(profile)));
}

function canAccessDepartment(profile, department) {
  if (!profile || !profile.authorized) return false;
  if (profile.global) return true;
  return profile.departments.includes(canonicalOrganizationDepartment(department));
}

function canAccessApprovalGroup(profile, groupKey) {
  if (!profile || !profile.authorized) return false;
  if (profile.global) return true;
  groupKey = String(groupKey || '').trim();
  if (profile.departments.includes(groupKey)) return true;
  const combined = OA_COMBINED_DEPARTMENT_GROUPS.find(group => group.key === groupKey || group.department === groupKey);
  return Boolean(combined && combined.memberDepartments.some(department => profile.departments.includes(department)));
}

function organizationDepartmentFor(name, rawDepartment) {
  return MARKETING_SUBDEPARTMENT_BY_NAME[String(name || '').trim()] || canonicalOrganizationDepartment(rawDepartment);
}

const HRBP_BY_DEPARTMENT = Object.freeze({
  '信息技术部': '路得'
});

function organizationHrbpFor(name, department, fallback) {
  const normalizedDepartment = organizationDepartmentFor(name, department);
  return HRBP_BY_DEPARTMENT[normalizedDepartment] || String(fallback || '薏米').trim() || '薏米';
}

function approvalRouteForEmployee(employee) {
  employee = employee || {};
  const name = String(employee.name || employee.nick || '').trim();
  const override = employeeOverrides[name] || {};
  const directMgr = String(override.directMgr || employee.directMgr || '').trim();
  const rawDepartment = String(override.department || employee.dept || employee.department || '').trim();
  const displayDepartment = organizationDepartmentFor(name, rawDepartment);

  for (const [group, leader] of Object.entries(MARKETING_APPROVAL_LEADER_BY_GROUP)) {
    if (name === leader || directMgr === leader || MARKETING_SUBDEPARTMENT_BY_NAME[name] === group) {
      return { key: group, department: group, memberDepartments: [group], displayDepartment };
    }
  }
  const explicitCombined = OA_COMBINED_DEPARTMENT_GROUPS.find(group =>
    group.key === rawDepartment || group.department === rawDepartment || group.memberDepartments.includes(displayDepartment)
  );
  if (explicitCombined) return {
    key: explicitCombined.key,
    department: explicitCombined.department,
    memberDepartments: [...explicitCombined.memberDepartments],
    displayDepartment
  };
  return {
    key: displayDepartment,
    department: displayDepartment,
    memberDepartments: displayDepartment ? [displayDepartment] : [],
    displayDepartment
  };
}
const SIGNATURE_AUDIT_FILE = path.join(DATA_DIR, 'signature_audit.jsonl');
if (!fs.existsSync(SIGNATURE_AUDIT_FILE)) fs.writeFileSync(SIGNATURE_AUDIT_FILE, '', { encoding: 'utf8', mode: 0o640 });
try { fs.chmodSync(SIGNATURE_AUDIT_FILE, 0o640); } catch (_) {}
const signingChallenges = new Map();
const signingVerifications = new Map();
const workflowReminderSentAt = new Map();
let lastSignatureAuditHash = '';
try {
  const lines = fs.readFileSync(SIGNATURE_AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length) lastSignatureAuditHash = JSON.parse(lines[lines.length - 1]).eventHash || '';
} catch (_) {}

let employeeOverrides = {};
try {
  if (fs.existsSync(EMPLOYEE_OVERRIDES_FILE)) {
    const storedOverrides = JSON.parse(fs.readFileSync(EMPLOYEE_OVERRIDES_FILE, 'utf8')) || {};
    employeeOverrides = Object.fromEntries(
      [...new Set([...Object.keys(DEFAULT_EMPLOYEE_OVERRIDES), ...Object.keys(storedOverrides)])]
        .map(name => [name, { ...(DEFAULT_EMPLOYEE_OVERRIDES[name] || {}), ...(storedOverrides[name] || {}) }])
    );
  }
} catch (_) {}

// Load KPI targets (indicators, weights, target values per employee per month)
let kpiTargets = {};
try { if (fs.existsSync(KPI_TARGETS_FILE)) kpiTargets = JSON.parse(fs.readFileSync(KPI_TARGETS_FILE, 'utf8')); } catch(e) {}

// 员工花名册
const EMPLOYEE_ROSTER = {
  "Ben":     { userId: "043928135366667",       openDingTalkId: "DApiPRE3KFfHqDUV7QOlkNDiSDRm8ePD8F5" },
  "十叶":    { userId: "17748641644197045",      openDingTalkId: "Du9PAUBINVQ78mUSMD8S8FGZ8sOSUZOpn" },
  "玖杉":    { userId: "17788447756826329",      openDingTalkId: "DiPFSliiOGXx3KiPo4IJyPEaoiSDRm8ePD8F5" },
  "桑葚":    { userId: "203419016525817132",     openDingTalkId: "Du9PAUBINVQ7Hzo2nl4P7xvDRm8ePD8F5" },
  "薏米":    { userId: "02082405631917182337",   openDingTalkId: "Du9PAUBINVQ6FO2skVaxbUbJh7nE1TAQJ" },
  "路得":    { userId: "17489488882575567",      openDingTalkId: "DeSUszW8KTZ9OuWBYYriSmKiSDRm8ePD8F5" },
  "豪杰":    { userId: "17580967906287006",      openDingTalkId: "DU5Jc7QUNjR2NtXWZtPtdceF6cN67rMiPW" },
  "达古":    { userId: "17625242006094393",      openDingTalkId: "DsaEMJ4f9u7xOuWBYYriSmKiSDRm8ePD8F5" },
  "归雾":    { userId: "11271239161132577",      openDingTalkId: "DVISIRo4iSh4yiPo4IJyPEaoiSDRm8ePD8F5" },
  "秋天":    { userId: "47434534481043964",      openDingTalkId: "Du9PAUBINVQ55CeGzehSiSGxodTEhCpmgR" },
  "图图":    { userId: "17491070276637156",      openDingTalkId: "Du9PAUBINVQ5WR7iSEJbq7Db62mMdJF7Ih" },
  "三七":    { userId: "17773668140055453",      openDingTalkId: "Du9PAUBINVQ6iSTX25Uv5ZUiSMA2Vsdrnob" },
  "惜君":    { userId: "083454240221563766",     openDingTalkId: "DeRpaHWHBii4DZOPTPp9kH1PDRm8ePD8F5" },
  "星河":    { userId: "226268411826165253",     openDingTalkId: "Du9PAUBINVQ49p8OyIECrbJz1EsgRbCto" },
  "芙芙":    { userId: "17745750386038685",      openDingTalkId: "Du9PAUBINVQ4KzMzjfMkroVmauj2kvXLI" },
};

let evalData = {};
let mgrData = {};
let bpData = {};
let kpiData = {};
let resultData = {};
let workflowResets = {};
let oaApprovalData = {};
let performanceExclusions = new Set();
let assessmentRoster = [];
let kpiTargetDrafts = {};
let monthlyEvents = {};
function loadPersistentJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error('[startup] Failed to load ' + label + ' from ' + filePath + ':', error.message);
    throw error;
  }
}
evalData = loadPersistentJson(DATA_FILE, 'self-evaluation data');
mgrData = loadPersistentJson(MGR_DATA_FILE, 'manager score data');
bpData = loadPersistentJson(BP_DATA_FILE, 'BP score data');
kpiData = loadPersistentJson(KPI_DATA_FILE, 'KPI confirmation data');
resultData = loadPersistentJson(RESULT_DATA_FILE, 'result confirmation data');
workflowResets = loadPersistentJson(WORKFLOW_RESETS_FILE, 'workflow reset data');
oaApprovalData = loadPersistentJson(OA_APPROVAL_FILE, 'OA approval data');
performanceExclusions = new Set(loadPersistentJson(PERFORMANCE_EXCLUSIONS_FILE, 'performance exclusions').map(value => String(value || '').trim()).filter(Boolean));
assessmentRoster = loadPersistentJson(ASSESSMENT_ROSTER_FILE, 'assessment roster');
kpiTargetDrafts = loadPersistentJson(KPI_TARGET_DRAFTS_FILE, 'employee KPI target drafts');
monthlyEvents = loadPersistentJson(MONTHLY_EVENTS_FILE, 'monthly events');
if (!monthlyEvents || Array.isArray(monthlyEvents) || typeof monthlyEvents !== 'object') monthlyEvents = {};
const dingTalkOa = createDingTalkOaClient({ baseDir: __dirname });
const dingTalkDirectory = createDingTalkDirectory({ baseDir: __dirname });
const oaApprovalInFlight = new Map();

function assessmentKey(empId, month) {
  return String(empId || '').trim() + '|' + String(month || '').trim();
}

function recordMatches(record, empId, month) {
  if (!record) return false;
  return String(record.empId || '').trim() === String(empId || '').trim() &&
    (!month || String(record.month || '').trim() === String(month || '').trim());
}

function getAssessmentRecord(store, empId, month) {
  const exact = store[assessmentKey(empId, month)];
  if (exact) return exact;
  const legacy = store[String(empId || '')];
  if (legacy && (!month || !legacy.month || String(legacy.month).trim() === String(month).trim())) return legacy;
  return Object.values(store).filter(record => recordMatches(record, empId, month))
    .sort((left, right) => String(right.submittedAt || right.archivedAt || right.signedAt || '').localeCompare(String(left.submittedAt || left.archivedAt || left.signedAt || '')))[0] || null;
}

function setAssessmentRecord(store, data) {
  store[assessmentKey(data.empId, data.month)] = data;
  delete store[String(data.empId || '')];
  return data;
}

function deleteAssessmentRecord(store, empId, month) {
  for (const [key, record] of Object.entries(store)) {
    if (recordMatches(record, empId, month) || key === assessmentKey(empId, month) || (key === String(empId || '') && (!month || !record || !record.month || String(record.month) === String(month)))) delete store[key];
  }
}

function migrateAssessmentStore(store, filePath) {
  let changed = false;
  const migrated = {};
  for (const [key, record] of Object.entries(store || {})) {
    if (!record || typeof record !== 'object') { migrated[key] = record; continue; }
    const empId = String(record.empId || key.split('|')[0] || '').trim();
    const month = String(record.month || key.split('|')[1] || '').trim();
    if (!empId || !month) { migrated[key] = record; continue; }
    const nextKey = assessmentKey(empId, month);
    migrated[nextKey] = { ...record, empId, month };
    if (nextKey !== key) changed = true;
  }
  if (changed) {
    const backupPath = filePath + '.pre-compound-key.bak';
    if (!fs.existsSync(backupPath) && fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(filePath, JSON.stringify(migrated, null, 2), { encoding: 'utf8', mode: 0o640 });
  }
  return migrated;
}

evalData = migrateAssessmentStore(evalData, DATA_FILE);
mgrData = migrateAssessmentStore(mgrData, MGR_DATA_FILE);
bpData = migrateAssessmentStore(bpData, BP_DATA_FILE);
kpiData = migrateAssessmentStore(kpiData, KPI_DATA_FILE);
resultData = migrateAssessmentStore(resultData, RESULT_DATA_FILE);

function uniqueRosterIdentityMaps() {
  const byName = new Map();
  const byRealName = new Map();
  const byUserId = new Map();
  const duplicateNames = new Set();
  const duplicateRealNames = new Set();
  for (const employee of Array.isArray(assessmentRoster) ? assessmentRoster : []) {
    if (!employee || employee.active === false || !employee.id) continue;
    const id = String(employee.id).trim();
    const name = String(employee.name || '').trim();
    const realName = String(employee.realName || '').trim();
    const userId = String(employee.userId || '').trim();
    if (name) {
      if (byName.has(name) && byName.get(name) !== id) duplicateNames.add(name);
      else byName.set(name, id);
    }
    if (realName) {
      if (byRealName.has(realName) && byRealName.get(realName) !== id) duplicateRealNames.add(realName);
      else byRealName.set(realName, id);
    }
    if (userId) byUserId.set(userId, id);
  }
  duplicateNames.forEach(name => byName.delete(name));
  duplicateRealNames.forEach(name => byRealName.delete(name));
  return { byName, byRealName, byUserId };
}

function canonicalAssessmentIdFor(subject) {
  if (!subject || typeof subject !== 'object') return '';
  subject = subject.emp && typeof subject.emp === 'object' ? subject.emp : subject;
  const maps = uniqueRosterIdentityMaps();
  const userId = String(subject.userId || '').trim();
  const realName = String(subject.realName || '').trim();
  const name = String(subject.name || subject.nick || '').trim();
  return (userId && maps.byUserId.get(userId)) ||
    (realName && maps.byRealName.get(realName)) ||
    (name && maps.byName.get(name)) || '';
}

function assertCanonicalAssessmentSubject(empId, subject, context) {
  const canonicalId = canonicalAssessmentIdFor(subject);
  if (canonicalId && canonicalId !== String(empId || '').trim()) {
    const person = subject && (subject.emp || subject) || {};
    throw new Error((context || '绩效记录') + '员工身份校验失败：' +
      String(person.name || person.nick || person.realName || empId) +
      '应使用固定员工ID ' + canonicalId + '，当前请求已拒绝以防止串档');
  }
  return canonicalId || String(empId || '').trim();
}

function repairAssessmentStoreIdentities(store, filePath, label) {
  let changed = false;
  const entries = Object.entries(store || {});
  for (const [key, record] of entries) {
    if (!record || typeof record !== 'object') continue;
    const oldEmpId = String(record.empId || key.split('|')[0] || '').trim();
    const month = String(record.month || key.split('|')[1] || '').trim();
    const canonicalId = canonicalAssessmentIdFor(record);
    if (!oldEmpId || !month || !canonicalId || canonicalId === oldEmpId) continue;
    const canonicalKey = assessmentKey(canonicalId, month);
    if (store[canonicalKey] && store[canonicalKey] !== record) {
      console.error('[identity-repair] Refused conflicting migration for ' + label + ': ' + key + ' -> ' + canonicalKey);
      continue;
    }
    delete store[key];
    record.identityMigration = {
      ...(record.identityMigration || {}),
      originalEmpId: String(record.identityMigration && record.identityMigration.originalEmpId || oldEmpId),
      canonicalEmpId: canonicalId,
      migratedAt: new Date().toISOString(),
      reason: 'matched immutable assessment roster identity'
    };
    record.empId = canonicalId;
    if (record.emp && typeof record.emp === 'object') record.emp.id = canonicalId;
    store[canonicalKey] = record;
    changed = true;
    console.warn('[identity-repair] Migrated ' + label + ': ' + key + ' -> ' + canonicalKey);
  }
  if (changed) {
    const backupPath = filePath + '.pre-identity-repair.bak';
    if (!fs.existsSync(backupPath) && fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o640 });
  }
  return changed;
}

function repairWorkflowEmployeeSnapshots(store, filePath, label) {
  let changed = false;
  for (const [key, record] of Object.entries(store || {})) {
    if (!record || typeof record !== 'object' || !record.emp) continue;
    const empId = String(record.empId || key.split('|')[0] || '').trim();
    const next = authoritativeWorkflowEmployee(empId, record.emp);
    if (JSON.stringify(next) === JSON.stringify(record.emp)) continue;
    record.emp = next;
    changed = true;
    console.warn('[workflow-employee-repair] Updated ' + label + ' employee snapshot: ' + key + ' -> manager ' + (next.directMgr || '--'));
  }
  if (changed) {
    const backupPath = filePath + '.pre-workflow-employee-repair.bak';
    if (!fs.existsSync(backupPath) && fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
    const temporary = filePath + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o640 });
    fs.renameSync(temporary, filePath);
  }
  return changed;
}

function stableDingTalkAssessmentId(userId, employee) {
  const seed = String(userId || '') || [employee && employee.nick, employee && employee.realName].join('|');
  return 'D' + sha256(seed).slice(0, 12).toUpperCase();
}

function assessmentMonthOrder(month) {
  const match = String(month || '').match(/(\d{4})年(\d{1,2})月/);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

function assessmentMonthFromDate(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  return safeDate.getFullYear() + '年' + (safeDate.getMonth() + 1) + '月';
}

function nextAssessmentMonth(month) {
  const order = assessmentMonthOrder(month);
  if (order === null) return '';
  const next = order + 1;
  return Math.floor(next / 12) + '年' + (next % 12 + 1) + '月';
}

function previousAssessmentMonth(month) {
  const order = assessmentMonthOrder(month);
  if (order === null) return '';
  const previous = order - 1;
  return Math.floor(previous / 12) + '年' + (previous % 12 + 1) + '月';
}

function assessmentRosterIncludesMonth(employee, month) {
  const target = assessmentMonthOrder(month);
  if (target === null) return true;
  const start = assessmentMonthOrder(employee && employee.assessmentStartMonth);
  const inactive = assessmentMonthOrder(employee && employee.assessmentInactiveFromMonth);
  return (start === null || target >= start) && (inactive === null || target < inactive);
}

function ensureCanonicalAssessmentRoster(roster, options = {}) {
  if (!Array.isArray(roster)) return false;
  let changed = false;
  const requestedMonth = assessmentMonthOrder(options.assessmentMonth) === null ? '' : String(options.assessmentMonth);
  const maps = uniqueRosterIdentityMaps();
  const usedIds = new Set((Array.isArray(assessmentRoster) ? assessmentRoster : []).map(employee => String(employee && employee.id || '')).filter(Boolean));
  for (const directoryEmployee of roster) {
    if (!directoryEmployee || PERFORMANCE_ROSTER_EXCLUSIONS.has(directoryEmployee.nick)) continue;
    const userId = String(directoryEmployee.userId || '').trim();
    const name = canonicalEmployeeNickname(directoryEmployee);
    const realName = String(directoryEmployee.realName || '').trim();
    let id = (userId && maps.byUserId.get(userId)) ||
      (realName && maps.byRealName.get(realName)) ||
      (name && maps.byName.get(name)) || '';
    let existing = id ? assessmentRoster.find(employee => employee && String(employee.id) === id) : null;
    if (!existing) {
      if (options.addMissing === false) continue;
      id = stableDingTalkAssessmentId(userId, directoryEmployee);
      let suffix = 1;
      while (usedIds.has(id)) id = stableDingTalkAssessmentId(userId + ':' + suffix++, directoryEmployee);
      existing = {
        id,
        name,
        realName,
        userId,
        dept: organizationDepartmentFor(name, directoryEmployee.department),
        position: String(directoryEmployee.title || ''),
        active: true,
        assessmentStartMonth: requestedMonth || assessmentMonthFromDate(directoryEmployee.syncedAt),
        createdFrom: 'dingtalk-directory'
      };
      assessmentRoster.push(existing);
      usedIds.add(id);
      changed = true;
    } else {
      // Normalize the business roster onto one department field. Historic
      // DingTalk-created records used `department`, while original records use
      // `dept`; keeping a canonical field prevents identity snapshots from
      // diverging between administrators.
      if (!existing.dept && existing.department) {
        existing.dept = existing.department;
        changed = true;
      }
      for (const [field, value] of Object.entries({ userId, name, realName })) {
        if (value && String(existing[field] || '') !== value) { existing[field] = value; changed = true; }
      }
      const organizationalDepartment = organizationDepartmentFor(name, directoryEmployee.department || existing.department || existing.dept);
      if (organizationalDepartment && String(existing.dept || existing.department || '') !== organizationalDepartment) {
        existing.dept = organizationalDepartment;
        if (Object.prototype.hasOwnProperty.call(existing, 'department')) existing.department = organizationalDepartment;
        changed = true;
      }
      if (!existing.assessmentStartMonth) {
        existing.assessmentStartMonth = existing.createdFrom === 'dingtalk-directory'
          ? (requestedMonth || assessmentMonthFromDate(directoryEmployee.syncedAt))
          : '2026年6月';
        changed = true;
      }
      if (requestedMonth && existing.assessmentInactiveFromMonth && assessmentMonthOrder(existing.assessmentInactiveFromMonth) >= assessmentMonthOrder(requestedMonth)) {
        delete existing.assessmentInactiveFromMonth;
        changed = true;
      }
    }
    if (userId) maps.byUserId.set(userId, id);
    if (name) maps.byName.set(name, id);
    if (realName) maps.byRealName.set(realName, id);
  }
  // A directory refresh is the only event allowed to change monthly
  // participation. Missing users remain in the selected (departure) month
  // and stop participating from the following month. Earlier snapshots stay
  // intact and the recorded boundary never slides on later refreshes.
  if (requestedMonth && options.updateMembership) {
    const currentUserIds = new Set(roster.map(employee => String(employee && employee.userId || '').trim()).filter(Boolean));
    const currentNames = new Set(roster.map(employee => String(employee && employee.nick || '').trim()).filter(Boolean));
    const currentRealNames = new Set(roster.map(employee => String(employee && employee.realName || '').trim()).filter(Boolean));
    for (const employee of assessmentRoster) {
      const userId = String(employee && employee.userId || '').trim();
      const name = String(employee && employee.name || '').trim();
      const realName = String(employee && employee.realName || '').trim();
      if (PERFORMANCE_ROSTER_EXCLUSIONS.has(name)) continue;
      // Legacy roster rows may predate DingTalk userId persistence. Resolve
      // those rows by both names so a departed employee does not remain in all
      // future monthly denominators forever.
      const stillPresent = userId ? currentUserIds.has(userId) :
        ((name && currentNames.has(name)) || (realName && currentRealNames.has(realName)));
      if (!stillPresent && !employee.assessmentInactiveFromMonth) {
        // A departure remains in the assessment roster for the departure
        // month. The employee leaves the denominator from the following month.
        employee.assessmentInactiveFromMonth = nextAssessmentMonth(requestedMonth);
        changed = true;
      }
    }
  }
  if (changed) {
    const temporary = ASSESSMENT_ROSTER_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(assessmentRoster, null, 2), { encoding: 'utf8', mode: 0o640 });
    fs.renameSync(temporary, ASSESSMENT_ROSTER_FILE);
  }
  return changed;
}

// Historic browser releases allocated E-numbers locally. Repair any record
// whose embedded employee identity points at another canonical roster ID.
try {
  const cachedDirectoryRoster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
  ensureCanonicalAssessmentRoster(cachedDirectoryRoster, { addMissing: false });
} catch (error) {
  console.warn('[identity-roster] Could not initialize cached roster identities:', error.message);
}
repairAssessmentStoreIdentities(kpiTargets, KPI_TARGETS_FILE, 'KPI targets');
repairAssessmentStoreIdentities(kpiTargetDrafts, KPI_TARGET_DRAFTS_FILE, 'KPI target drafts');
repairAssessmentStoreIdentities(evalData, DATA_FILE, 'self evaluation');
repairAssessmentStoreIdentities(mgrData, MGR_DATA_FILE, 'manager score');
repairAssessmentStoreIdentities(bpData, BP_DATA_FILE, 'BP score');
repairAssessmentStoreIdentities(kpiData, KPI_DATA_FILE, 'KPI confirmation');
repairAssessmentStoreIdentities(resultData, RESULT_DATA_FILE, 'result confirmation');
// Workflow routing must use the administrator-maintained organization mapping,
// not a stale manager name embedded by an older browser or target draft.
repairWorkflowEmployeeSnapshots(kpiTargets, KPI_TARGETS_FILE, 'KPI targets');
repairWorkflowEmployeeSnapshots(kpiTargetDrafts, KPI_TARGET_DRAFTS_FILE, 'KPI target drafts');

function validateScore(score, baseScore, label) {
  const value = Number(score);
  const base = Number(baseScore);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || !Number.isFinite(base) || base <= 0) {
    throw new Error(label + ' must be a non-negative integer');
  }
  return value;
}

function validateTotalScore(total, label) {
  const value = Number(total);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > MAX_TOTAL_SCORE) throw new Error(label + ' must be an integer between 0 and ' + MAX_TOTAL_SCORE);
  return value;
}

function normalizeScoreRemark(value) {
  return String(value == null ? '' : value).trim().slice(0, 500);
}

// Materialize existing signed HTML stored in JSON into standalone archive files.
let migratedKpiArchives = false;
Object.values(kpiData).forEach(data => {
  if (!data || !data.doc) return;
  if (data.archiveFile && fs.existsSync(path.join(DATA_DIR, data.archiveFile))) return;
  const archiveFile = archiveSignedDocument('kpi', data);
  if (archiveFile && data.archiveFile !== archiveFile) { data.archiveFile = archiveFile; migratedKpiArchives = true; }
});
if (migratedKpiArchives) fs.writeFileSync(KPI_DATA_FILE, JSON.stringify(kpiData, null, 2), 'utf8');
let migratedResultArchives = false;
Object.values(resultData).forEach(data => {
  if (!data || !data.doc) return;
  if (data.bpReviewStatus === 'pending') return;
  if (data.archiveFile && fs.existsSync(path.join(DATA_DIR, data.archiveFile))) return;
  const archiveFile = archiveSignedDocument('result', data);
  if (archiveFile && data.archiveFile !== archiveFile) { data.archiveFile = archiveFile; migratedResultArchives = true; }
});
Object.values(resultData).forEach(data => {
  if (!data || !data.doc) return;
  if (data.bpReviewStatus === 'pending') return;
  if (!data.sealed) { data.sealed = true; migratedResultArchives = true; }
  if (!data.sealedAt) { data.sealedAt = data.archivedAt || data.serverSignedAt || data.signedAt || new Date().toISOString(); migratedResultArchives = true; }
});
if (migratedResultArchives) fs.writeFileSync(RESULT_DATA_FILE, JSON.stringify(resultData, null, 2), 'utf8');

function sameWorkflowMonth(record, month) {
  if (!record) return false;
  const recordMonth = String(record.month || '').trim();
  const requestedMonth = String(month || '').trim();
  return !recordMonth || !requestedMonth || recordMonth === requestedMonth;
}

function isSignedRecord(record, month) {
  return Boolean(record && record.doc && sameWorkflowMonth(record, month) &&
    (record.signatureValidated || record.archiveFile || record.archivedAt || record.signedAt));
}

function validBpCompletionRecord(empId, month) {
  const record = getAssessmentRecord(bpData, empId, month);
  if (!record || !sameWorkflowMonth(record, month)) return null;
  const total = Number(record.bpScore);
  const details = Array.isArray(record.bpScores) ? record.bpScores : [];
  if (!Number.isFinite(total) || total < 0 || total > MAX_TOTAL_SCORE || details.length === 0) return null;
  const detailsValid = details.every(detail => {
    const score = Number(detail && detail.score);
    const base = Number(detail && detail.max);
    return Number.isFinite(score) && Number.isFinite(base) && base > 0 && score >= 0;
  });
  return detailsValid ? record : null;
}

function sealedWorkflowRecord(empId, month) {
  if (!validBpCompletionRecord(empId, month)) return null;
  const record = getAssessmentRecord(resultData, empId, month);
  return isSignedRecord(record, month) && record.sealed === true && Boolean(record.archiveFile) ? record : null;
}

function signedDocumentRecord(documentType, empId, month) {
  const store = documentType === 'result' ? resultData : kpiData;
  const record = getAssessmentRecord(store, empId, month);
  if (documentType === 'result' && !validBpCompletionRecord(empId, month)) return null;
  return isSignedRecord(record, month) ? record : null;
}

function rejectSealedWorkflow(res, empId, month) {
  const record = sealedWorkflowRecord(empId, month);
  if (!record) return false;
  res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    error: '该员工当月绩效已完成签字并封存，禁止重复提交',
    code: 'WORKFLOW_SEALED', sealed: true,
    sealedAt: record.sealedAt || record.archivedAt || record.serverSignedAt || record.signedAt || ''
  }));
  return true;
}

function rejectSignedDocument(res, documentType, empId, month) {
  const record = signedDocumentRecord(documentType, empId, month);
  if (!record) return false;
  res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    error: documentType === 'result'
      ? (record.bpReviewStatus === 'pending'
        ? '绩效结果已由员工签署，正在等待BP复核归档，不能重复提交'
        : '绩效结果确认书已签署并封存，不能重复提交')
      : '绩效目标确认书已签署并归档，不能重复提交',
    code: record.bpReviewStatus === 'pending' ? 'RESULT_PENDING_BP_REVIEW' : 'DOCUMENT_SEALED', sealed: record.sealed === true,
    sealedAt: record.sealedAt || record.archivedAt || record.serverSignedAt || record.signedAt || ''
  }));
  return true;
}

function sealedNoticeHtml(record) {
  const name = escapeHtml(record && (record.name || record.realName) || '该员工');
  const month = escapeHtml(record && record.month || '');
  const sealedAt = escapeHtml(record && (record.sealedAt || record.archivedAt || record.serverSignedAt || record.signedAt) || '');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
    '<title>绩效流程已封存</title><style>*{box-sizing:border-box}body{margin:0;padding:32px 18px;background:#f1f5f9;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.box{max-width:760px;margin:10vh auto;background:#fff;border:1px solid #bbf7d0;border-radius:16px;padding:38px;text-align:center;box-shadow:0 12px 36px rgba(15,23,42,.08)}.icon{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;margin:0 auto 18px;background:#dcfce7;color:#15803d;font-size:34px}.title{font-size:22px;font-weight:700}.desc{margin-top:12px;color:#475569;line-height:1.8}.meta{margin-top:22px;padding:14px;background:#f8fafc;border-radius:10px;color:#64748b;font-size:13px}</style></head><body><main class="box"><div class="icon">✓</div><div class="title">绩效流程已完成并封存</div><div class="desc">' + month + name + '的评分和员工签字已完成，当前链接仅保留查看提示，不能重复评分或提交。</div><div class="meta">封存时间：' + sealedAt + '<br>如确需重新签署，须由管理员执行“打回重签”并留存审计记录。</div></main></body></html>';
}

function splitArchivedResultColumnsForPreview(html) {
  let output = String(html || '').replace(/评分标准速查/g, '评分标准');
  if (!/考核指标、评分细则及数据来源/.test(output)) return output;
  output = output.replace(/<th([^>]*)>考核指标、评分细则及数据来源<\/th>/,
    '<th$1 style="width:170px">考核指标</th><th>评分细则</th><th style="width:160px">数据来源</th>');
  output = output.replace(/(<tbody[^>]*>)([\s\S]*?)(<\/tbody>)/, function(_, open, rows, close) {
    const splitRows = rows.replace(/(<tr[^>]*>\s*<td[^>]*>[\s\S]*?<\/td>)\s*<td[^>]*>([\s\S]*?)<\/td>\s*(<td class="weight(?:-cell)?"[^>]*>)/g,
      function(__, sequenceCell, combined, weightCell) {
        const mainMatch = combined.match(/^\s*<div[^>]*>([\s\S]*?)<\/div>/);
        const childMatches = [...combined.matchAll(/<strong>(\d+\.\s*[\s\S]*?)<\/strong><br>/g)].map(match => match[1]);
        const rules = [...combined.matchAll(/<strong>评分细则[：:]<\/strong>([\s\S]*?)(?=<\/(?:div|span)>)/g)].map(match => match[1]);
        const sources = [...combined.matchAll(/<strong>数据来源[：:]<\/strong>([\s\S]*?)(?=<\/(?:div|span)>)/g)].map(match => match[1]);
        const indicator = '<div class="indicator-main">' + (mainMatch ? mainMatch[1] : combined) + '</div>' +
          (childMatches.length ? '<div class="subcell-list">' + childMatches.map(value => '<div class="subcell-item"><strong>' + value + '</strong></div>').join('') + '</div>' : '');
        const rule = rules.length ? '<div class="subcell-list">' + rules.map((value, index) => '<div class="subcell-item"><strong>' + (index + 1) + '.</strong> ' + value + '</div>').join('') + '</div>' : '--';
        const source = sources.length ? '<div class="subcell-list">' + sources.map((value, index) => '<div class="subcell-item source-value"><strong>' + (index + 1) + '.</strong> ' + value + '</div>').join('') + '</div>' : '--';
        return sequenceCell + '<td>' + indicator + '</td><td>' + rule + '</td><td>' + source + '</td>' + weightCell;
      });
    return open + splitRows + close;
  });
  return output.replace(/<td colspan="2">合计<\/td>/g, '<td colspan="4">合计</td>');
}

function archivedDocumentPreviewHtml(doc, documentType, record) {
  let source = String(doc || '');
  const archiveName = record && (record.name || record.realName) || '';
  const archiveMonth = record && record.month || '';
  if (archiveMonth) {
    const title = documentType === 'result'
      ? '绩效结果确认书 - ' + archiveName + ' - ' + archiveMonth
      : 'KPI目标确认书 - ' + archiveName + ' - ' + archiveMonth;
    source = source.replace(/<title>[^<]*<\/title>/i, '<title>' + escapeHtml(title) + '</title>');
  }
  const accent = documentType === 'result' ? '#16a34a' : '#2563eb';
  if (documentType === 'kpi') {
    source = source.replace(/&quot;/g, '');
    source = source.replace(/目标值\s*[:：][^<]*?数据来源\s*[:：]\s*/g, '');
    source = source.replace(/(<th[^>]*>)\s*目标值\s*(<\/th>)/, '$1评分细则$2');
    source = source.replace(/<div>\s*--\s*<\/div>/g, '');
    source = source.replace(/<div[^>]*>\s*目标：\s*--\s*<\/div>/g, '');
    source = injectWorkflowReminder(source, '<p style="font-size:13px;color:#666;margin-bottom:8px">');
  }
  if (documentType === 'result') source = splitArchivedResultColumnsForPreview(source);
  const kpiColumns = documentType === 'kpi'
    ? 'thead th:nth-child(2),tbody td:nth-child(2){width:180px!important}thead th:nth-child(3),tbody td:nth-child(3){width:auto!important}thead th:nth-child(4),tbody td:nth-child(4){width:180px!important}tbody td:nth-child(4)>div{white-space:normal!important;word-break:break-word!important;line-height:1.55!important;text-align:left!important}thead th:nth-child(5),tbody td:nth-child(5){width:76px!important;text-align:center!important}'
    : 'thead th:nth-child(2),tbody td:nth-child(2){width:170px!important}thead th:nth-child(3),tbody td:nth-child(3){width:auto!important}thead th:nth-child(4),tbody td:nth-child(4){width:160px!important}thead th:nth-child(5),tbody td:nth-child(5){width:72px!important;text-align:center!important}thead th:nth-child(6),tbody td:nth-child(6){width:180px!important}thead th:nth-child(n+7),tbody td:nth-child(n+7){width:82px!important;text-align:center!important}.indicator-main{font-weight:700;color:#0f172a}.subcell-list{display:grid;gap:6px;margin-top:6px}.subcell-item{padding:6px 7px;background:#f8fafc;border-left:3px solid #93c5fd;border-radius:5px;white-space:pre-line}.source-value{color:#334155}';
  const previewWidth = documentType === 'result' ? '1360px' : '1120px';
  const tableWidth = documentType === 'result' ? '1240px' : '960px';
  const style = '<style id="server-archive-wide-preview">html{background:#eef2f7}body{max-width:' + previewWidth + '!important;width:auto!important;padding:16px!important;margin:0 auto!important;background:#fff}table{width:100%!important;min-width:' + tableWidth + '!important;table-layout:fixed!important}th,td{vertical-align:top!important;line-height:1.65!important;overflow-wrap:anywhere!important}thead th:first-child,tbody td:first-child{width:52px!important;text-align:center!important}thead th:last-child,tbody td:last-child{width:76px!important;text-align:center!important}' + kpiColumns + '.server-sealed-banner{max-width:' + previewWidth + ';margin:0 auto 14px;padding:10px 14px;border:1px solid ' + accent + ';border-radius:9px;background:#f8fafc;color:' + accent + ';font:600 13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}@media(max-width:760px){body{padding:10px!important;overflow-x:auto}table{min-width:900px!important}}</style>';
  const banner = '<div class="server-sealed-banner">已签署归档 · 当前文档已封存，仅供查看，不可重复提交</div>';
  let preview = source.includes('</head>') ? source.replace('</head>', style + '</head>') : style + source;
  return preview.includes('<body>') ? preview.replace('<body>', '<body>' + banner) : banner + preview;
}

function pendingResultPreviewHtml(doc) {
  const source = splitArchivedResultColumnsForPreview(String(doc || ''));
  const style = '<style>html{background:#eef2f7}body{max-width:1360px!important;width:auto!important;padding:16px!important;margin:0 auto!important;background:#fff}.server-pending-banner{margin:0 auto 14px;padding:11px 14px;border:1px solid #f59e0b;border-radius:9px;background:#fffbeb;color:#92400e;font:600 13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}table{width:100%!important;min-width:1240px!important;table-layout:fixed!important}@media(max-width:760px){body{overflow-x:auto}}</style>';
  const banner = '<div class="server-pending-banner">员工已签字确认 · 正在等待BP复核，复核完成后方可正式封存归档</div>';
  let preview = source.includes('</head>') ? source.replace('</head>', style + '</head>') : style + source;
  return preview.includes('<body>') ? preview.replace('<body>', '<body>' + banner) : banner + preview;
}

// userId cache (persisted to disk)
const USERID_CACHE_FILE = dataFile('userid_cache.json', {});
let userIdCache = {};
try { if (fs.existsSync(USERID_CACHE_FILE)) userIdCache = JSON.parse(fs.readFileSync(USERID_CACHE_FILE, 'utf8')); } catch(e) {}

function findUserId(name) {
  if (!name) return null;
  // Check cache first
  if (userIdCache[name]) return userIdCache[name];
  // Prefer the authoritative DingTalk roster synchronized by the server. New
  // employees are not present in the legacy static map and DWS name search is
  // not guaranteed to be available on a headless production host.
  try {
    const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
    const normalizedName = String(name).trim();
    const syncedEmployee = (Array.isArray(roster) ? roster : []).find(employee => employee && employee.active !== false &&
      [employee.nick, employee.realName, employee.name, canonicalEmployeeNickname(employee)].some(value => String(value || '').trim() === normalizedName));
    const syncedUserId = String(syncedEmployee && syncedEmployee.userId || '').trim();
    if (syncedUserId) {
      userIdCache[name] = syncedUserId;
      fs.writeFileSync(USERID_CACHE_FILE, JSON.stringify(userIdCache, null, 2), { encoding: 'utf8', mode: 0o640 });
      console.log('[user-cache] Resolved from synchronized roster: ' + name + ' -> ' + syncedUserId);
      return syncedUserId;
    }
  } catch (error) {
    console.warn('[user-cache] Failed to read synchronized roster:', error.message);
  }
  // Check roster
  const entry = EMPLOYEE_ROSTER[name];
  if (entry && entry.userId && entry.userId !== "search_needed") {
    userIdCache[name] = entry.userId;
    fs.writeFileSync(USERID_CACHE_FILE, JSON.stringify(userIdCache, null, 2), 'utf8');
    return entry.userId;
  }
  // DWS lookup
  try {
    const result = execSync('dws contact user search --query "' + name + '" --format json', { encoding: 'utf8', timeout: 10000 });
    const users = JSON.parse(result);
    if (users && users.length > 0 && users[0].userId) {
      userIdCache[name] = users[0].userId;
      fs.writeFileSync(USERID_CACHE_FILE, JSON.stringify(userIdCache, null, 2), 'utf8');
      console.log('[user-cache] Cached: ' + name + ' -> ' + users[0].userId);
      return users[0].userId;
    }
  } catch(e) {
    console.error('[user-cache] DWS lookup failed for: ' + name, e.message);
  }
  return null;
}

// Queue file for messages to be sent via Bash tool (DWS needs host authorization)
const PENDING_SENDS_FILE = dataFile('pending_sends.json', []);

function appendPendingSend(item) {
  let queue = [];
  try { if (fs.existsSync(PENDING_SENDS_FILE)) queue = JSON.parse(fs.readFileSync(PENDING_SENDS_FILE, 'utf8')); } catch (_) {}
  queue.push({ ...item, createdAt: new Date().toISOString() });
  fs.writeFileSync(PENDING_SENDS_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

function normalizeDingTalkPlainText(value) {
  return String(value || '')
    .replace(/^\s*#{1,6}\s*\u7ee9\u6548\u81ea\u8bc4\s*\r?\n+/i, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/[ \t]+\r?\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function shortMonthLabel(value) {
  return String(value || '').trim().replace(/^20(\d{2}年\d{1,2}月)$/, '$1');
}

function periodEmployeeLabel(data) {
  const realName = data && data.realName ? '\uff08' + data.realName + '\uff09' : '';
  return shortMonthLabel(data && data.month) + String((data && data.name) || '') + realName;
}

async function enqueueBotMessage(userId, title, text) {
  if (EXTERNAL_NOTIFICATIONS_DISABLED) {
    console.log('[dingtalk-disabled] Suppressed test notification for userId=' + userId + ' title=' + title);
    return { sent: false, queued: false, disabled: true, channel: 'disabled' };
  }
  text = normalizeDingTalkPlainText(text);
  text = signPublicLinksInText(text);
  // DingTalk permits only one identical work notification per employee per day.
  // A visible dispatch timestamp keeps legitimate resubmissions/reminders unique.
  const now = new Date();
  const dispatchTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  text += '\n\n发送时间：' + dispatchTime;
  console.log('[dingtalk] Sending text to userId=' + userId + ' title=' + title);
  const delivery = await dingTalkSender.sendText(userId, title, text);
  if (delivery.sent) {
    console.log('[dingtalk] Delivery confirmed via ' + delivery.channel + ': userId=' + userId + ' state=' + (delivery.deliveryState || 'confirmed'));
    return delivery;
  }
  // An accepted asynchronous DingTalk task may later be rejected for an invalid
  // recipient or permission. Never retry/duplicate a task whose final state is
  // known, or one that DingTalk accepted but whose result is still uncertain.
  if (delivery.permanent || delivery.indeterminate || delivery.accepted) {
    console.error('[dingtalk] Delivery not confirmed; not queued:', delivery.error);
    return Object.assign({ sent: false, queued: false }, delivery);
  }
  appendPendingSend({ type: 'message', userId, title, text, lastError: delivery.error });
  console.error('[dingtalk] Not sent; retained in pending_sends.json:', delivery.error);
  return { sent: false, queued: true, channel: delivery.channel, error: delivery.error };
}

// One-time passwords must never enter the normal retry queue: a delayed OTP may
// arrive after it has expired and can mislead the signer. Only a confirmed,
// immediate DingTalk delivery is considered successful.
async function sendSigningOtpNow(userId, title, text) {
  if (process.env.NODE_ENV === 'test' && /^\d{6}$/.test(String(process.env.SIGNING_OTP_TEST_CODE || ''))) {
    return { sent: true, queued: false, confirmed: true, channel: 'test-otp' };
  }
  if (EXTERNAL_NOTIFICATIONS_DISABLED) {
    return { sent: false, queued: false, disabled: true, channel: 'disabled', error: 'External notifications are disabled' };
  }
  text = normalizeDingTalkPlainText(text);
  console.log('[dingtalk-otp] Sending directly to userId=' + userId + ' title=' + title);
  let delivery;
  try {
    delivery = await dingTalkSender.sendText(userId, title, text);
  } catch (error) {
    delivery = { sent: false, queued: false, channel: '', error: error && error.message ? error.message : String(error) };
  }
  if (delivery.sent) {
    console.log('[dingtalk-otp] Sent via ' + delivery.channel + ': userId=' + userId);
    return delivery;
  }
  console.error('[dingtalk-otp] Direct delivery failed; OTP was not queued:', delivery.error);
  return { sent: false, queued: false, channel: delivery.channel || '', error: delivery.error || 'DingTalk delivery failed' };
}

function signPath(pathname) {
  if (!LINK_SIGNING_SECRET) return '';
  return crypto.createHmac('sha256', LINK_SIGNING_SECRET).update(pathname).digest('hex');
}

function publicLink(pathname) {
  const token = signPath(pathname);
  return PUBLIC_SERVER_URL + pathname + (token ? '?token=' + token : '');
}

function isValidPublicToken(req, pathname) {
  if (!LINK_SIGNING_SECRET) return true;
  let received = '';
  try { received = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch (_) {}
  const expected = signPath(pathname);
  if (!received || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function workflowActionToken(action, empId, month) {
  return signPath('/workflow-action/' + action + '/' + encodeURIComponent(String(empId || '')) + '/' + encodeURIComponent(String(month || '')));
}

function isValidWorkflowAction(data, action) {
  if (!LINK_SIGNING_SECRET) return true;
  const expected = workflowActionToken(action, data.empId, data.month);
  const received = String(data.actionToken || '');
  return Boolean(received && received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected)));
}

function signPublicLinksInText(text) {
  if (!LINK_SIGNING_SECRET || !text) return text;
  const escapedBase = PUBLIC_SERVER_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Consume any existing token(s) before signing. This keeps notification
  // generation idempotent and repairs accidentally duplicated `?token=` values.
  const routePattern = new RegExp(escapedBase + '(\\/(?:kpi-page(?:-b64)?|kpi-confirm-page|selfeval-page|mgr-page|bp-page|result-page|result-bp-review-page|target-draft-page|target-manager-page|target-bp-page)\\/[^\\s?]+)(?:\\?token=[a-f0-9]{64})*', 'g');
  return String(text).replace(routePattern, (_, pathname) => publicLink(pathname));
}

async function enqueueBotBatch(messages) {
  const results = [];
  for (const msg of messages) {
    const userId = msg.userId || findUserId(msg.name);
    if (!userId) {
      results.push({ name: msg.name, success: false, error: 'User not found' });
      continue;
    }
    const delivery = await enqueueBotMessage(userId, msg.title, msg.text);
    results.push({ name: msg.name, userId, ...delivery });
  }
  const sentCount = results.filter(r => r.sent).length;
  const queuedCount = results.filter(r => r.queued).length;
  console.log('[batch] Done: ' + sentCount + ' confirmed sent, ' + queuedCount + ' retained unsent');
  return results;
}

function workflowReminderCss() {
  return '.workflow-reminder-grid{display:grid;grid-template-columns:minmax(320px,.9fr) minmax(0,1.35fr);gap:14px;margin:20px 0;align-items:stretch}' +
    '.rating-guide,.attendance-note{margin:0;padding:15px 17px;border-radius:11px;font-size:12px;line-height:1.7}' +
    '.rating-guide{background:#f8fafc;border:1px solid #dbe3ee;color:#334155}' +
    '.rating-guide-title,.attendance-note-title{font-size:14px;font-weight:700;margin-bottom:8px;color:#0f172a}' +
    '.rating-guide-list{display:grid;gap:0}' +
    '.rating-guide-row{display:grid;grid-template-columns:42px minmax(68px,1fr) auto;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #e8edf3}' +
    '.rating-guide-row:last-child{border-bottom:0}' +
    '.grade-chip{display:inline-flex;justify-content:center;align-items:center;min-width:34px;padding:1px 8px;border-radius:999px;font-weight:700;border:1px solid}' +
    '.grade-a{color:#059669;background:#ecfdf5;border-color:#6ee7b7}.grade-b-plus{color:#2563eb;background:#eff6ff;border-color:#bfdbfe}' +
    '.grade-b{color:#7c3aed;background:#f5f3ff;border-color:#ddd6fe}.grade-b-minus{color:#d97706;background:#fffbeb;border-color:#fde68a}' +
    '.grade-c{color:#ea580c;background:#fff7ed;border-color:#fed7aa}.grade-d{color:#dc2626;background:#fef2f2;border-color:#fecaca}' +
    '.rating-threshold{color:#64748b;text-align:right;white-space:nowrap}' +
    '.attendance-note{background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12}' +
    '.attendance-note-title{color:#9a3412}' +
    '@media(max-width:820px){.workflow-reminder-grid{grid-template-columns:1fr}.rating-guide-row{grid-template-columns:42px 1fr auto}}';
}

function ratingGuideHtml() {
  const rows = [
    ['A-', '优秀', 'X＞110 · 系数1.2', 'grade-a'],
    ['B+', '优良', '100＜X≤110 · 系数1.1', 'grade-b-plus'],
    ['B', '良好', '90＜X≤100 · 系数1.0', 'grade-b'],
    ['B-', '合格', '80＜X≤90 · 系数0.9', 'grade-b-minus'],
    ['C', '需改进', '70＜X≤80 · 系数0.7', 'grade-c'],
    ['D', '不合格', 'X≤70 · 系数0', 'grade-d']
  ];
  return '<section class="rating-guide" aria-label="评分标准"><div class="rating-guide-title">评分标准</div>' +
    '<div class="rating-guide-list">' + rows.map(row =>
      '<div class="rating-guide-row"><div><span class="grade-chip ' + row[3] + '">' + row[0] + '</span></div>' +
      '<div>' + row[1] + '</div><div class="rating-threshold">' + row[2] + '</div></div>'
    ).join('') + '</div></section>';
}

function attendanceReminderHtml() {
  return '<section class="attendance-note" aria-label="绩效核算备注"><div class="attendance-note-title">备注</div>' +
    '当月缺勤（当月实际出勤天数＜当月应出勤天数，含各类请假及入离职）：<br>' +
    '（1）入离职人员：当月绩效奖金按实际出勤天数及绩效评分进行核算。<br>' +
    '（2）5天＜当月缺勤＜10天：绩效奖金按实际出勤天数及绩效评分进行核算。<br>' +
    '（3）当月缺勤≥10天：不核发当月绩效奖金。</section>';
}

function workflowReminderHtml() {
  return '<div class="workflow-reminder-grid">' + ratingGuideHtml() + attendanceReminderHtml() + '</div>';
}

function injectWorkflowReminder(html, marker) {
  let output = String(html || '');
  const styleEnd = output.indexOf('</style>');
  const initialStyle = styleEnd >= 0 ? output.slice(0, styleEnd) : '';
  if (!initialStyle.includes('.workflow-reminder-grid{')) output = output.replace('</style>', workflowReminderCss() + '</style>');
  output = output.replace(/<div class="attendance-note">[\s\S]*?<\/div>\s*/g, '');
  const markerIndex = output.indexOf(marker);
  const pageMarkupBeforeMarker = markerIndex >= 0 ? output.slice(0, markerIndex) : output;
  if (!pageMarkupBeforeMarker.includes('<div class="workflow-reminder-grid">')) output = output.replace(marker, workflowReminderHtml() + '\n' + marker);
  return output;
}

// 将自评数据写入评分页面HTML，生成个性化版本
function personalizeScoringPage(empName, evalDataObj) {
  let templatePath = path.join(PAGES_DIR, '\u4e0a\u7ea7\u8bc4\u5206_' + empName + '.html');
  if (!fs.existsSync(templatePath)) templatePath = path.join(PAGES_DIR, '\u4e0a\u7ea7\u8bc4\u5206_\u6851\u845a.html');
  if (!fs.existsSync(templatePath)) {
    console.error('[personalize] Template not found: ' + templatePath);
    return null;
  }
  let html = fs.readFileSync(templatePath, 'utf8');
  html = injectWorkflowReminder(html, '    <!-- Submit -->');
  const scores = evalDataObj.scores || [];
  const savedManagerRecord = getAssessmentRecord(mgrData, evalDataObj.empId, evalDataObj.month);
  const existingSubmission = savedManagerRecord ? {
    mgrScore: Number(savedManagerRecord.mgrScore) || 0,
    mgrScores: Array.isArray(savedManagerRecord.mgrScores) ? savedManagerRecord.mgrScores : [],
    submittedAt: savedManagerRecord.submittedAt || ''
  } : null;

  const kpisStr = JSON.stringify(scores.map(s => ({
    seq: s.seq, indicator: s.indicator, parentIndicator: s.parentIndicator || '', parentSeq: s.parentSeq,
    itemIndex: s.itemIndex, grouped: s.grouped === true, target: '', dataSource: s.dataSource || '', rule: s.rule || '',
    items: kpiChildItems(s), max: s.max, selfScore: s.score, completion: s.completion || ""
  })));
  html = html.replace(/const KPIS = \[[\s\S]*?\];/, 'const KPIS = ' + kpisStr + ';');
  html = html.replace(/const SELF_TOTAL = [\d.]+;/, 'const SELF_TOTAL = ' + evalDataObj.selfScore + ';');
  html = html.replace(/const SERVER_URL\s*=\s*"[^"]*";/, 'const SERVER_URL = "' + PUBLIC_SERVER_URL + '";');
  html = html.replace(/const ACTION_TOKEN\s*=\s*"[^"]*";/, 'const ACTION_TOKEN = ' + JSON.stringify(workflowActionToken('manager', evalDataObj.empId, evalDataObj.month)) + ';');
  html = html.replace(/const EXISTING_SUBMISSION\s*=\s*[^;]+;/, 'const EXISTING_SUBMISSION = ' + JSON.stringify(existingSubmission) + ';');

  const empStr = JSON.stringify({
    empId: evalDataObj.empId, name: evalDataObj.name, realName: evalDataObj.realName,
    dept: evalDataObj.dept, position: evalDataObj.position,
    directMgr: evalDataObj.directMgr, hrbp: evalDataObj.hrbp, month: evalDataObj.month
  });
  html = html.replace(/const EMP = \{[^}]+\};/, 'const EMP = ' + empStr + ';');
  html = html.replace(/(<div class="header">[\s\S]*?<p>)[^<]*(<\/p>)/, '$1\u676d\u5dde\u98de\u9014\u884c\u8fdc \u00b7 ' + escapeHtml(evalDataObj.month) + '$2');
  html = html.replace(/<div class="name">[^<]*<\/div>/, '<div class="name">' + escapeHtml(evalDataObj.name) + '\uff08' + escapeHtml(evalDataObj.realName) + '\uff09</div>');
  html = html.replace(/<div class="dept">[^<]*<\/div>/, '<div class="dept">' + escapeHtml(evalDataObj.dept) + ' \u00b7 ' + escapeHtml(evalDataObj.position) + '</div>');
  html = html.replace(/(<div style="font-weight:500">)[^<]*(<\/div>)/, '$1' + escapeHtml(evalDataObj.directMgr) + '\uff08\u76f4\u5c5e\u4e0a\u7ea7\uff09$2');

  const kpiCards = scores.map((score, index) => {
    const seq = Number(score.seq) || index + 1;
    return '<!-- KPI ' + seq + ' -->\n' +
      '<div class="kpi-item" id="kpi' + seq + '">' +
      '<div class="kpi-head"><div class="kpi-num">' + seq + '</div><div class="kpi-title">' + escapeHtml(scoringUnitTitle(score)) + '</div><div class="kpi-weight">' + escapeHtml(score.max) + '%</div></div>' +
      '<div class="kpi-layout"><div class="kpi-detail">' +
      (kpiChildItems(score).length ? renderKpiSubItemsHtml(score) : '<div class="kpi-rules"><strong>评分细则：</strong>' + escapeHtml(score.rule || '--') + '</div><div class="kpi-target"><strong>数据来源：</strong>' + escapeHtml(kpiDataSource(score) || '--') + '</div>') +
      '</div><div class="kpi-score-panel"><div class="kpi-completion-display" id="comp' + seq + '"><div class="comp-label">\u5b9e\u9645\u5b8c\u6210\u60c5\u51b5</div><span class="comp-text">' + escapeHtml(score.completion || '--') + '</span></div>' +
      '<div class="score-row"><label>\u5458\u5de5\u81ea\u8bc4\uff1a</label><span class="self-score-display" id="self' + seq + '">' + escapeHtml(score.score) + '</span>' +
      '<label>\u4e0a\u7ea7\u8bc4\u5206\uff1a</label><input type="number" class="score-input" id="mgr' + seq + '" min="0" step="1" inputmode="numeric" placeholder="请输入整数分" title="只允许整数；单项不设上限，整表总分不得超过120分" oninput="updateTotal()">' +
      '<span class="score-max">\u5355\u9879\u4e0d\u8bbe\u4e0a\u9650 \u00b7 \u603b\u5206\u2264120</span></div>' +
      '<div class="remark-field"><label for="mgrRemark' + seq + '">\u4e0a\u7ea7\u5907\u6ce8\uff08\u9009\u586b\uff09</label><textarea class="remark-input" id="mgrRemark' + seq + '" maxlength="500" rows="2" placeholder="可填写本项评分依据、问题或改进建议"></textarea><span class="remark-limit">最多500字</span></div>' +
      '</div></div></div>';
  }).join('\n');
  html = html.replace(/<!-- KPI 1 -->[\s\S]*?(?=\s*<!-- Total Scores -->)/, kpiCards + '\n');
  html = html.replace(/i <= 5/g, 'i <= KPIS.length');

  html = html.replace(
    /(<div class="self-total-bar">[\s\S]*?<div class="value"[^>]*>)[\d.]+ \u5206/g,
    '$1' + evalDataObj.selfScore + ' \u5206'
  );

  const outputPath = path.join(TEMP_DIR, '\u4e0a\u7ea7\u8bc4\u5206_' + empName + '.html');
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log('[personalize] Generated for ' + empName + ' selfScore=' + evalDataObj.selfScore);
  return outputPath;
}

// 写入通知队列
function enqueueNotification(task) {
  let queue = [];
  try { if (fs.existsSync(QUEUE_FILE)) queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch(e) {}
  task.createdAt = new Date().toISOString();
  queue.push(task);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
  console.log('[queue] Enqueued: ' + task.type + ' -> userId=' + task.userId);
}

async function deliverNotification(task) {
  const delivery = task.type === 'file'
    ? await dingTalkSender.sendFile(task.userId, task.title, task.text, task.filePath)
    : await dingTalkSender.sendText(task.userId, task.title, task.text);
  if (delivery.sent) {
    console.log('[notify] Sent ' + task.type + ' via ' + delivery.channel + ' -> userId=' + task.userId);
    return delivery;
  }
  enqueueNotification({ ...task, lastError: delivery.error });
  return { sent: false, queued: true, channel: delivery.channel, error: delivery.error };
}

async function prepareSelfEvalNotifications(data) {
  const mgrName = data.directMgr || '';
  const mgrUserId = findUserId(mgrName);
  if (!mgrUserId) {
    const error = 'Manager not found: ' + mgrName;
    console.error('[notify] ' + error);
    return { sent: false, queued: false, error };
  }

  const pagePath = personalizeScoringPage(data.name, data);
  if (!pagePath) {
    return { sent: false, queued: false, recipient: mgrName, userId: mgrUserId, error: 'Manager scoring page could not be generated' };
  }

  const managerPagePath = '/mgr-page/' + encodeURIComponent(data.empId) + '/' + encodeURIComponent(data.month);
  const employeeLabel = periodEmployeeLabel(data);
  const msgText = employeeLabel + '\u7684\u81ea\u8bc4\u5df2\u5b8c\u6210\uff08' + data.selfScore + '\u5206\uff09\u3002\n\n' +
    '\u4e0a\u7ea7\u8bc4\u5206\u9875\u9762\uff1a' + publicLink(managerPagePath) + '\n\n' +
    '\u8bf7\u6253\u5f00\u9875\u9762\u5b8c\u6210\u4e0a\u7ea7\u8bc4\u5206\u3002';
  const deliveries = [await deliverNotification({
    type: 'message', viaBot: true, userId: mgrUserId,
    title: '\u4e0a\u7ea7\u8bc4\u5206 - ' + employeeLabel,
    text: msgText
  })];
  return {
    recipient: mgrName,
    userId: mgrUserId,
    sent: deliveries.length > 0 && deliveries.every(item => item.sent),
    queued: deliveries.some(item => item.queued),
    deliveries
  };
}


// Generate personalized BP review page with self + mgr scores
function personalizeBpPage(empName, selfData, mgrDataObj) {
  var templatePath = path.join(PAGES_DIR, 'BP\u6838\u51c6_' + empName + '.html');
  if (!fs.existsSync(templatePath)) templatePath = path.join(PAGES_DIR, 'BP\u6838\u51c6_\u6851\u845a.html');
  if (!fs.existsSync(templatePath)) {
    console.error('[personalize-bp] Template not found: ' + templatePath);
    return null;
  }
  var html = fs.readFileSync(templatePath, 'utf8');
  html = injectWorkflowReminder(html, '    <!-- Submit -->');
  var selfScores = (selfData && selfData.scores) || [];
  var mgrScores = (mgrDataObj && mgrDataObj.mgrScores) || [];
  const savedBpRecord = getAssessmentRecord(bpData, selfData.empId, selfData.month);
  const existingSubmission = savedBpRecord ? {
    bpScore: Number(savedBpRecord.bpScore) || 0,
    bpScores: Array.isArray(savedBpRecord.bpScores) ? savedBpRecord.bpScores : [],
    grade: savedBpRecord.grade || '',
    comment: savedBpRecord.comment || '',
    submittedAt: savedBpRecord.submittedAt || ''
  } : null;

  // Build KPIS array with both self and mgr scores
  var kpis = selfScores.map(function(s) {
    var mgr = mgrScores.find(function(m) { return Number(m.seq) === Number(s.seq); });
    return { seq: s.seq, indicator: s.indicator, parentIndicator: s.parentIndicator || '', parentSeq: s.parentSeq,
      itemIndex: s.itemIndex, grouped: s.grouped === true, target: '', dataSource: s.dataSource || '', rule: s.rule || '',
      items: kpiChildItems(s), max: s.max, selfScore: s.score, mgrScore: mgr ? mgr.score : s.score,
      mgrRemark: mgr ? normalizeScoreRemark(mgr.remark) : '', completion: s.completion || "" };
  });
  var kpisStr = JSON.stringify(kpis);
  html = html.replace(/var KPIS = \[[\s\S]*?\];/, 'var KPIS = ' + kpisStr + ';');
  html = html.replace(/var SERVER_URL\s*=\s*"[^"]*";/, 'var SERVER_URL = "' + PUBLIC_SERVER_URL + '";');
  html = html.replace(/var ACTION_TOKEN\s*=\s*"[^"]*";/, 'var ACTION_TOKEN = ' + JSON.stringify(workflowActionToken('bp', selfData.empId, selfData.month)) + ';');
  html = html.replace(/var EXISTING_SUBMISSION\s*=\s*[^;]+;/, 'var EXISTING_SUBMISSION = ' + JSON.stringify(existingSubmission) + ';');

  var selfTotal = (selfData && selfData.selfScore) || 0;
  var mgrTotal = (mgrDataObj && mgrDataObj.mgrScore) || 0;
  html = html.replace(/var SELF_TOTAL = [\d.]+;/, 'var SELF_TOTAL = ' + selfTotal + ';');
  html = html.replace(/var MGR_TOTAL = [\d.]+;/, 'var MGR_TOTAL = ' + mgrTotal + ';');

  const authoritativeEmp = authoritativeWorkflowEmployee(selfData.empId, selfData);
  const empObj = {
    empId: selfData.empId, name: selfData.name, realName: selfData.realName,
    dept: selfData.dept, position: selfData.position, directMgr: selfData.directMgr,
    hrbp: authoritativeEmp.hrbp, month: selfData.month
  };
  html = html.replace(/var EMP = \{[^}]+\};/, 'var EMP = ' + JSON.stringify(empObj) + ';');
  html = html.replace(/(<div class="header">[\s\S]*?<p>)[^<]*(<\/p>)/, '$1\u676d\u5dde\u98de\u9014\u884c\u8fdc \u00b7 ' + escapeHtml(empObj.month) + '$2');
  html = html.replace(/<div class="name">[^<]*<\/div>/, '<div class="name">' + escapeHtml(empObj.name) + '\uff08' + escapeHtml(empObj.realName) + '\uff09</div>');
  html = html.replace(/<div class="dept">[^<]*<\/div>/, '<div class="dept">' + escapeHtml(empObj.dept) + ' \u00b7 ' + escapeHtml(empObj.position) + '</div>');
  html = html.replace(/(<div style="font-weight:500">)[^<]*(<\/div>)/, '$1' + escapeHtml(empObj.hrbp) + '\uff08HRBP\uff09$2');

  const kpiCards = kpis.map(function(kpi, index) {
    const seq = Number(kpi.seq) || index + 1;
    return '<!-- KPI ' + seq + ' -->\n' +
      '<div class="kpi-item" id="kpi' + seq + '">' +
      '<div class="kpi-head"><div class="kpi-num">' + seq + '</div><div class="kpi-title">' + escapeHtml(scoringUnitTitle(kpi)) + '</div><div class="kpi-weight">' + escapeHtml(kpi.max) + '%</div></div>' +
      '<div class="kpi-layout"><div class="kpi-detail">' +
      (kpiChildItems(kpi).length ? renderKpiSubItemsHtml(kpi) : '<div class="kpi-rules"><strong>评分细则：</strong>' + escapeHtml(kpi.rule || '--') + '</div><div class="kpi-target"><strong>数据来源：</strong>' + escapeHtml(kpiDataSource(kpi) || '--') + '</div>') +
      '</div><div class="kpi-score-panel"><div class="kpi-completion-display" id="comp' + seq + '"><div class="comp-label">\u5b9e\u9645\u5b8c\u6210\u60c5\u51b5</div><span class="comp-text">' + escapeHtml(kpi.completion || '--') + '</span></div>' +
      '<div class="ref-scores"><span class="score-label">\u81ea\u8bc4\uff1a</span><span class="self-score" id="self' + seq + '">' + escapeHtml(kpi.selfScore) + '</span>' +
      '<span class="score-label" style="margin-left:8px">\u4e0a\u7ea7\uff1a</span><span class="mgr-score" id="mgr' + seq + '">' + escapeHtml(kpi.mgrScore) + '</span></div>' +
      (kpi.mgrRemark ? '<div class="upstream-remark"><strong>\u4e0a\u7ea7\u5907\u6ce8\uff1a</strong>' + escapeHtml(kpi.mgrRemark) + '</div>' : '') +
      '<div class="score-row"><span class="score-label">BP\u6838\u51c6\uff1a</span><input type="number" class="bp-input" id="bp' + seq + '" min="0" step="1" inputmode="numeric" placeholder="请输入整数分" title="只允许整数；单项不设上限，整表总分不得超过120分" oninput="updateTotal()">' +
      '<span class="score-max">\u5355\u9879\u4e0d\u8bbe\u4e0a\u9650 \u00b7 \u603b\u5206\u2264120</span></div>' +
      '<div class="remark-field"><label for="bpRemark' + seq + '">BP\u5907\u6ce8\uff08\u9009\u586b\uff09</label><textarea class="remark-input" id="bpRemark' + seq + '" maxlength="500" rows="2" placeholder="可填写本项核准说明、调整依据或建议"></textarea><span class="remark-limit">最多500字</span></div>' +
      '</div></div></div>';
  }).join('\n');
  html = html.replace(/<!-- KPI 1 -->[\s\S]*?(?=\s*<!-- Total Scores -->)/, kpiCards + '\n');

  // Replace total displays
  html = html.replace(/(id="selfTotalScore">)[\d.]+ \u5206/, '$1' + selfTotal + ' \u5206');
  html = html.replace(/(id="mgrTotalScore">)[\d.]+ \u5206/, '$1' + mgrTotal + ' \u5206');

  var outputPath = path.join(TEMP_DIR, 'BP\u6838\u51c6_' + empName + '.html');
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log('[personalize-bp] Generated for ' + empName + ' self=' + selfTotal + ' mgr=' + mgrTotal);
  return outputPath;
}

async function prepareMgrScoreNotifications(data) {
  const selfData = getAssessmentRecord(evalData, data.empId, data.month) || {};
  const hrbpName = authoritativeWorkflowEmployee(data.empId, { ...selfData, ...data }).hrbp;
  data.hrbp = hrbpName;
  const hrbpUserId = findUserId(hrbpName);
  if (!hrbpUserId) {
    const error = 'HRBP not found: ' + hrbpName;
    console.error('[notify-bp] ' + error);
    return { sent: false, queued: false, recipient: hrbpName, error };
  }

  var bpPagePath = personalizeBpPage(data.name, selfData, data);
  if (!bpPagePath) {
    return { sent: false, queued: false, recipient: hrbpName, userId: hrbpUserId, error: 'BP review page could not be generated' };
  }
  const employeeLabel = periodEmployeeLabel({ ...selfData, ...data });
  const bpPageRoute = '/bp-page/' + encodeURIComponent(data.empId) + '/' + encodeURIComponent(data.month);
  const msgText = employeeLabel + '\u7684\u4e0a\u7ea7\u8bc4\u5206\u5df2\u5b8c\u6210\uff08\u81ea\u8bc4' + data.selfScore + '\u5206 / \u4e0a\u7ea7' + data.mgrScore + '\u5206\uff09\u3002\n\n' +
    'BP\u6838\u51c6\u9875\u9762\uff1a' + publicLink(bpPageRoute) + '\n\n' +
    '\u8bf7\u6253\u5f00\u9875\u9762\u5b8c\u6210\u6838\u51c6\u3002';
  const deliveries = [await deliverNotification({
    type: 'message', viaBot: true, userId: hrbpUserId,
    title: 'BP\u6838\u51c6 - ' + employeeLabel,
    text: msgText
  })];
  return { recipient: hrbpName, userId: hrbpUserId, sent: deliveries.length > 0 && deliveries.every(item => item.sent), queued: deliveries.some(item => item.queued), deliveries };
}

// Generate personalized result confirmation page
function getGradeInfo(score) {
  if (score > 110) return { grade: 'A-', cls: 'grade-a', coeff: 1.2 };
  if (score > 100) return { grade: 'B+', cls: 'grade-b-plus', coeff: 1.1 };
  if (score > 90) return { grade: 'B', cls: 'grade-b', coeff: 1.0 };
  if (score > 80) return { grade: 'B-', cls: 'grade-b-minus', coeff: 0.9 };
  if (score > 70) return { grade: 'C', cls: 'grade-c', coeff: 0.7 };
  return { grade: 'D', cls: 'grade-d', coeff: 0 };
}

function saveOaApprovalData() {
  fs.writeFileSync(OA_APPROVAL_FILE, JSON.stringify(oaApprovalData, null, 2), { encoding: 'utf8', mode: 0o640 });
}

function savePerformanceExclusions() {
  const temporary = PERFORMANCE_EXCLUSIONS_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(Array.from(performanceExclusions).sort(), null, 2), { encoding: 'utf8', mode: 0o640 });
  fs.renameSync(temporary, PERFORMANCE_EXCLUSIONS_FILE);
}

function oaApprovalKey(month, department) {
  return String(month || '').trim() + '|' + String(department || '').trim();
}

function assessmentDepartmentRoster(month, department) {
  const requestedRoute = approvalRouteForEmployee({ department });
  const requestedGroup = requestedRoute.key;
  const participants = [];
  const seenIds = new Set();
  const seenNames = new Set();
  const addParticipant = participant => {
    if (!participant) return;
    const name = String(participant.name || participant.nick || '').trim();
    const empId = String(participant.id || participant.empId || '').trim();
    const override = employeeOverrides[name] || {};
    const participantDepartment = organizationDepartmentFor(name, override.department || participant.dept || participant.department || '');
    const route = approvalRouteForEmployee({ ...participant, name, department: participantDepartment, directMgr: override.directMgr || participant.directMgr });
    if (!name || route.key !== requestedGroup || participant.active === false ||
        !assessmentRosterIncludesMonth(participant, month) ||
        performanceExclusions.has(empId) || PERFORMANCE_ROSTER_EXCLUSIONS.has(name) ||
        (empId && seenIds.has(empId)) || seenNames.has(name)) return;
    participants.push({
      empId,
      name,
      realName: String(participant.realName || '').trim(),
      department: participantDepartment,
      approvalGroup: route.key,
      position: String(participant.position || participant.title || '').trim()
    });
    if (empId) seenIds.add(empId);
    seenNames.add(name);
  };

  if (Array.isArray(assessmentRoster)) assessmentRoster.forEach(addParticipant);

  // KPI targets also register explicitly-added new employees.  The persisted
  // assessment roster remains the denominator for employees who have not yet
  // created targets, so a partially configured department cannot be mistaken
  // for a completed one.
  Object.entries(kpiTargets).forEach(([targetKey, target]) => {
    if (String(target && target.month || '').trim() !== String(month || '').trim()) return;
    const emp = target && target.emp || {};
    addParticipant({ ...emp, empId: targetKey.split('|')[0], id: targetKey.split('|')[0] });
  });
  return participants;
}

function departmentCompletionSnapshot(empId, requestedMonth, requestedDepartment) {
  const source = getAssessmentRecord(bpData, empId, requestedMonth) || getAssessmentRecord(evalData, empId, requestedMonth) || {};
  const month = String(requestedMonth || source.month || '').trim();
  const sourceTarget = kpiTargets[assessmentKey(empId, month)] || {};
  const sourceEmployee = {
    ...(sourceTarget.emp || {}),
    ...source,
    id: empId,
    department: requestedDepartment || source.dept || source.department || sourceTarget.emp && sourceTarget.emp.dept || ''
  };
  const approvalRoute = approvalRouteForEmployee(sourceEmployee);
  const department = approvalRoute.department;
  const approvalGroupKey = approvalRoute.key;
  if (!month || !department || !approvalGroupKey) return { complete: false, reason: '缺少考核月份或审批分组' };
  const targetEntries = Object.entries(kpiTargets).filter(([targetKey, target]) => {
    const emp = target && target.emp || {};
    const targetEmpId = targetKey.split('|')[0];
    return String(target && target.month || '').trim() === month &&
      !performanceExclusions.has(targetEmpId) &&
      !PERFORMANCE_ROSTER_EXCLUSIONS.has(String(emp.name || '').trim()) &&
      Array.isArray(target.kpis) && target.kpis.length > 0;
  });
  const targetsById = new Map();
  const targetsByName = new Map();
  targetEntries.forEach(([targetKey, target]) => {
    const targetEmpId = targetKey.split('|')[0];
    targetsById.set(targetEmpId, [targetKey, target]);
    const targetName = String(target && target.emp && target.emp.name || '').trim();
    if (targetName) targetsByName.set(targetName, [targetKey, target]);
  });
  const departmentRoster = assessmentDepartmentRoster(month, approvalGroupKey);
  if (!departmentRoster.length) return { complete: false, reason: '该部门当月没有参评人员' };
  const employees = departmentRoster.map(participant => {
    const targetEntry = targetsById.get(participant.empId) || targetsByName.get(participant.name);
    const targetKey = targetEntry && targetEntry[0] || '';
    const target = targetEntry && targetEntry[1] || null;
    const targetEmpId = targetKey ? targetKey.split('|')[0] : participant.empId;
    const targetCreated = Boolean(target && Array.isArray(target.kpis) && target.kpis.length > 0);
    const score = validBpCompletionRecord(targetEmpId, month);
    const result = getAssessmentRecord(resultData, targetEmpId, month);
    const scoreValid = targetCreated && Boolean(score);
    const integrity = result ? verifySignedRecord('result', result) : { valid: false };
    const archiveFile = String(result && result.archiveFile || '');
    const archivePath = archiveFile ? path.resolve(DATA_DIR, archiveFile) : '';
    const archiveInsideDataDir = Boolean(archivePath && (archivePath === DATA_DIR || archivePath.startsWith(DATA_DIR + path.sep)));
    const signatureValid = Boolean(result && String(result.month || '').trim() === month &&
      result.signatureValidated === true && result.sealed === true && archiveInsideDataDir &&
      fs.existsSync(archivePath) && integrity.valid);
    const valid = targetCreated && scoreValid && signatureValid;
    const scoreValue = scoreValid ? Number(score.bpScore) : null;
    const grade = scoreValid ? getGradeInfo(scoreValue) : null;
    return {
      empId: targetEmpId,
      name: String(target && target.emp && target.emp.name || participant.name || score && score.name || ''),
      realName: String(target && target.emp && target.emp.realName || participant.realName || score && score.realName || ''),
      department: participant.department,
      targetCreated,
      score: scoreValue,
      grade: grade && grade.grade || '',
      coefficient: grade && grade.coeff,
      scoreCompleted: scoreValid,
      resultSigned: signatureValid,
      archiveFile,
      archivePath: signatureValid ? archivePath : '',
      archiveName: signatureValid ? path.basename(archivePath) : '',
      archiveSize: signatureValid ? fs.statSync(archivePath).size : 0,
      completed: valid
    };
  });
  const incomplete = employees.filter(employee => !employee.completed);
  if (incomplete.length) {
    return {
      complete: false,
      month,
      department,
      approvalGroupKey,
      memberDepartments: approvalRoute.memberDepartments,
      employeeCount: employees.length,
      pending: incomplete.map(employee => ({
        empId: employee.empId,
        name: employee.name,
        waitingFor: !employee.targetCreated ? '绩效目标' : (employee.scoreCompleted
          ? ((getAssessmentRecord(resultData, employee.empId, month) || {}).bpReviewStatus === 'pending' ? 'BP复核归档' : '员工结果签字')
          : 'BP核准')
      }))
    };
  }
  const totalScore = Math.round(employees.reduce((sum, employee) => sum + employee.score, 0) * 10) / 10;
  const averageScore = Math.round(totalScore / employees.length * 10) / 10;
  const details = employees.map((employee, index) => {
    const displayName = employee.realName ? employee.name + '（' + employee.realName + '）' : employee.name;
    return (index + 1) + '. ' + displayName + '【' + employee.department + '】：' + employee.score + '分，等级' + employee.grade + '，系数' + employee.coefficient;
  }).join('\n');
  const archiveFiles = employees.map(employee => ({
    empId: employee.empId,
    name: employee.name,
    realName: employee.realName,
    path: employee.archivePath,
    fileName: employee.archiveName,
    size: employee.archiveSize
  }));
  const requestId = crypto.createHash('sha256').update(month + '|' + approvalGroupKey + '|' + employees.map(employee =>
    employee.empId + ':' + employee.score + ':' + employee.archiveFile).join('|')).digest('hex').slice(0, 32);
  return {
    complete: true,
    month,
    department,
    approvalGroupKey,
    memberDepartments: approvalRoute.memberDepartments,
    employees,
    archiveFiles,
    employeeCount: employees.length,
    totalScore,
    averageScore,
    details,
    requestId
  };
}

function safeOaError(error) {
  const message = String(error && error.message || error || '钉钉OA提交失败').replace(/[\r\n]+/g, ' ').slice(0, 500);
  return { message, code: String(error && error.code || ''), requiredScopes: error && error.requiredScopes || [] };
}

async function submitDepartmentOaSnapshot(snapshot, forceRetry) {
  const key = oaApprovalKey(snapshot.month, snapshot.approvalGroupKey || snapshot.department);
  const existing = oaApprovalData[key];
  if (!forceRetry && existing && (existing.status === 'submitted' || existing.status === 'submitting')) return existing;
  if (oaApprovalInFlight.has(key)) return oaApprovalInFlight.get(key);
  const task = (async () => {
    const now = new Date().toISOString();
    const record = {
      ...(existing || {}),
      key,
      month: snapshot.month,
      department: snapshot.department,
      approvalGroupKey: snapshot.approvalGroupKey || snapshot.department,
      status: 'submitting',
      employeeCount: snapshot.employeeCount,
      totalScore: snapshot.totalScore,
      averageScore: snapshot.averageScore,
      employees: snapshot.employees,
      snapshot,
      attempts: Number(existing && existing.attempts || 0) + 1,
      createdAt: existing && existing.createdAt || now,
      lastAttemptAt: now,
      updatedAt: now,
      lastError: null
    };
    oaApprovalData[key] = record;
    saveOaApprovalData();
    try {
      const result = await dingTalkOa.createDepartmentApproval(snapshot);
      if (result.skipped) {
        record.status = 'disabled';
        record.lastError = { message: result.reason };
      } else {
        record.status = 'submitted';
        record.instanceId = result.instanceId;
        record.processCode = result.processCode;
        record.processName = result.processName || '';
        record.processRouteKey = result.processRouteKey || record.approvalGroupKey;
        record.formFieldNames = result.formFieldNames;
        record.attachments = result.attachments || [];
        record.submittedAt = new Date().toISOString();
        delete record.nextRetryAt;
        console.log('[dingtalk-oa] Submitted: ' + key + ' instanceId=' + result.instanceId);
      }
    } catch (error) {
      const safeError = safeOaError(error);
      record.status = safeError.requiredScopes.length || /permission|权限|AccessDenied/i.test(safeError.message) ? 'blocked' : 'failed';
      record.lastError = safeError;
      record.nextRetryAt = new Date(Date.now() + (record.status === 'blocked' ? 5 : 2) * 60 * 1000).toISOString();
      console.error('[dingtalk-oa] ' + record.status + ': ' + key + ' - ' + safeError.message);
    }
    record.updatedAt = new Date().toISOString();
    saveOaApprovalData();
    return record;
  })();
  oaApprovalInFlight.set(key, task);
  try { return await task; } finally { oaApprovalInFlight.delete(key); }
}

async function maybeSubmitDepartmentOa(empId, month, department) {
  const status = dingTalkOa.status();
  if (!status.enabled) return { status: 'disabled' };
  const snapshot = departmentCompletionSnapshot(empId, month, department);
  if (!snapshot.complete) return { status: 'waiting', ...snapshot };
  return submitDepartmentOaSnapshot(snapshot, false);
}

async function retryPendingOaApprovals() {
  if (!dingTalkOa.status().enabled) return;
  const now = Date.now();
  for (const record of Object.values(oaApprovalData)) {
    if (!record || !record.snapshot || !['pending', 'blocked', 'failed'].includes(record.status)) continue;
    if (record.nextRetryAt && Date.parse(record.nextRetryAt) > now) continue;
    const firstEmployee = Array.isArray(record.employees) && record.employees[0] || {};
    const currentSnapshot = departmentCompletionSnapshot(firstEmployee.empId, record.month, record.approvalGroupKey || record.department);
    if (!currentSnapshot.complete) {
      record.status = 'waiting';
      record.snapshot = currentSnapshot;
      record.updatedAt = new Date().toISOString();
      saveOaApprovalData();
      continue;
    }
    await submitDepartmentOaSnapshot(currentSnapshot, true);
  }
}

async function reconcileCompletedDepartmentOaApprovals() {
  if (!dingTalkOa.status().enabled) return [];
  const candidates = new Map();
  for (const [targetKey, target] of Object.entries(kpiTargets)) {
    const empId = targetKey.split('|')[0];
    const emp = target && target.emp || {};
    const month = String(target && target.month || '').trim();
    const department = String(emp.dept || '').trim();
    const route = approvalRouteForEmployee(emp);
    if (!month || !department || !route.key || performanceExclusions.has(empId) ||
        PERFORMANCE_ROSTER_EXCLUSIONS.has(String(emp.name || '').trim()) ||
        !Array.isArray(target.kpis) || !target.kpis.length) continue;
    candidates.set(oaApprovalKey(month, route.key), { empId, month, department: route.key });
  }
  const results = [];
  for (const candidate of candidates.values()) {
    const snapshot = departmentCompletionSnapshot(candidate.empId, candidate.month, candidate.department);
    if (!snapshot.complete) continue;
    results.push(await submitDepartmentOaSnapshot(snapshot, false));
  }
  return results;
}

function personalizeResultPage(empId, month) {
  var selfInfo = getAssessmentRecord(evalData, empId, month);
  var workflowMonth = month || selfInfo && selfInfo.month;
  var mgrInfo = getAssessmentRecord(mgrData, empId, workflowMonth);
  var bpInfo = getAssessmentRecord(bpData, empId, workflowMonth);
  if (!selfInfo || !mgrInfo || !bpInfo || !Number.isFinite(Number(bpInfo.bpScore))) return null;

  var empName = selfInfo.name || '';
  var templatePath = path.join(PAGES_DIR, '\u7ee9\u6548\u7ed3\u679c\u786e\u8ba4\u4e66\u6a21\u677f.html');
  if (!fs.existsSync(templatePath)) {
    console.error('[personalize-result] Template not found: ' + templatePath);
    return null;
  }
  var html = fs.readFileSync(templatePath, 'utf8');
  html = injectWorkflowReminder(html, '    <div class="sig-section">');

  // Build KPI scores array
  var selfScores = selfInfo.scores || [];
  var mgrScores = (mgrInfo && mgrInfo.mgrScores) || [];
  var bpScores = (bpInfo && bpInfo.bpScores) || [];
  if (!selfScores.length || mgrScores.length !== selfScores.length || bpScores.length !== selfScores.length) return null;
  if (selfScores.some(function(s) {
    return !mgrScores.some(function(m) { return Number(m.seq) === Number(s.seq); }) ||
      !bpScores.some(function(b) { return Number(b.seq) === Number(s.seq) && Number.isFinite(Number(b.score)); });
  })) return null;
  var kpis = selfScores.map(function(s) {
    var mgr = mgrScores.find(function(m) { return Number(m.seq) === Number(s.seq); });
    var bp = bpScores.find(function(b) { return Number(b.seq) === Number(s.seq); });
    return {
      seq: s.seq, indicator: scoringUnitTitle(s), parentIndicator: s.parentIndicator || '', parentSeq: s.parentSeq,
      itemIndex: s.itemIndex, grouped: s.grouped === true, target: '', dataSource: s.dataSource || '', rule: s.rule || '', max: s.max, items: kpiChildItems(s),
      completion: s.completion || "",
      selfScore: s.score,
       mgrScore: Number(mgr.score),
       mgrRemark: normalizeScoreRemark(mgr.remark),
       bpScore: Number(bp.score),
       bpRemark: normalizeScoreRemark(bp.remark)
    };
  });

  var selfTotal = Number(selfInfo.selfScore) || 0;
  var mgrTotal = Number(mgrInfo.mgrScore) || 0;
  var bpTotal = Number(bpInfo.bpScore);
  var finalScore = bpTotal;
  var gradeInfo = getGradeInfo(finalScore);
  if (bpInfo.grade && bpInfo.grade !== gradeInfo.grade) {
    console.warn('[personalize-result] Corrected inconsistent stored BP grade for ' + empId + '|' + workflowMonth + ': ' + bpInfo.grade + ' -> ' + gradeInfo.grade);
  }

  // Replace data variables in the template
  html = html.replace(/var KPIS = \[[\s\S]*?\];/, 'var KPIS = ' + JSON.stringify(kpis) + ';');
  html = html.replace(/var SELF_TOTAL = \d+;/, 'var SELF_TOTAL = ' + selfTotal + ';');
  html = html.replace(/var MGR_TOTAL = \d+;/, 'var MGR_TOTAL = ' + mgrTotal + ';');
  html = html.replace(/var BP_TOTAL = \d+;/, 'var BP_TOTAL = ' + bpTotal + ';');
  html = html.replace(/var FINAL_SCORE = \d+;/, 'var FINAL_SCORE = ' + finalScore + ';');
  html = html.replace(/var GRADE = "";/, 'var GRADE = "' + gradeInfo.grade + '";');
  html = html.replace(/var GRADE_CLASS = "";/, 'var GRADE_CLASS = "' + gradeInfo.cls + '";');
  html = html.replace(/var COEFF = \d+;/, 'var COEFF = ' + gradeInfo.coeff + ';');

  var empObj = {
    empId: empId,
    name: selfInfo.name || '',
    realName: selfInfo.realName || '',
    dept: selfInfo.dept || '',
    position: selfInfo.position || '',
    directMgr: selfInfo.directMgr || '',
    month: selfInfo.month || '2026\u5e747\u6708'
  };
  html = html.replace(/var EMP = \{[^}]+\};/, 'var EMP = ' + JSON.stringify(empObj) + ';');
  html = html.replace(/fetch\(['"]\/submit-result['"]/, 'fetch(' + JSON.stringify(PUBLIC_SERVER_URL + '/submit-result'));

  // Replace display placeholders
  html = html.replace(/EMP_NAME\uff08EMP_REALNAME\uff09/g, empObj.name + '\uff08' + empObj.realName + '\uff09');
  html = html.replace(/EMP_DEPT \u00b7 EMP_POSITION/g, empObj.dept + ' \u00b7 ' + empObj.position);
  html = html.replace(/EMP_MANAGER/g, empObj.directMgr);
  html = html.replace(/EMP_NAME/g, empObj.name);

  var outputPath = path.join(TEMP_DIR, '\u7ee9\u6548\u7ed3\u679c\u786e\u8ba4\u4e66_' + empName + '.html');
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log('[personalize-result] Generated for ' + empName + ' final=' + finalScore + ' grade=' + gradeInfo.grade);
  return { path: outputPath, name: empName, score: finalScore, grade: gradeInfo.grade };
}

async function prepareResultNotifications(empId, month) {
  var selfInfo = getAssessmentRecord(evalData, empId, month);
  if (!selfInfo) return false;

  var empName = selfInfo.name || '';
  var empUserId = findUserId(empName);
  if (!empUserId) { console.error('[notify-result] Employee not found: ' + empName); return false; }

  var result = personalizeResultPage(empId, selfInfo.month);
  if (!result) return false;

  const deliveries = [];
  const resultLink = publicLink('/result-page/' + encodeURIComponent(empId) + '/' + encodeURIComponent(selfInfo.month));
  const employeeLabel = periodEmployeeLabel(selfInfo);
  var msgText = employeeLabel + '\u7684\u7ee9\u6548\u7ed3\u679c\u5df2\u5b8c\u6210BP\u6838\u51c6\uff08' + result.score + '\u5206/' + result.grade + '\uff09\u3002\n\n' +
    '\u7ed3\u679c\u7b7e\u5b57\u786e\u8ba4\u9875\uff1a' + resultLink + '\n\n' +
    '\u8bf7\u6253\u5f00\u9875\u9762\u7b7e\u5b57\u786e\u8ba4\u3002';
  deliveries.push(await deliverNotification({
    type: 'message', viaBot: true, userId: empUserId,
    title: '\u7ee9\u6548\u7ed3\u679c\u786e\u8ba4 - ' + employeeLabel,
    text: msgText
  }));

  return { recipient: empName, userId: empUserId, sent: deliveries.length > 0 && deliveries.every(item => item.sent), queued: deliveries.some(item => item.queued), deliveries };
}

function workflowReminderContext(empId, month) {
  const key = assessmentKey(empId, month);
  const draft = kpiTargetDrafts[key];
  const target = kpiTargets[key] || draft;
  if (!target || !target.emp) throw new Error('未找到该员工当月已提交的绩效目标');
  const emp = authoritativeWorkflowEmployee(empId, target.emp);
  const targetSigned = getAssessmentRecord(kpiData, empId, month);
  const selfRecord = getAssessmentRecord(evalData, empId, month);
  const managerRecord = getAssessmentRecord(mgrData, empId, month);
  const bpRecord = getAssessmentRecord(bpData, empId, month);
  const resultSigned = getAssessmentRecord(resultData, empId, month);
  const targetAdjustmentInProgress = Boolean(draft && draft.isTargetAdjustment && !draft.targetSignedAt);
  let node = 'target';
  let status = '待目标确认';
  let recipientName = String(emp.name || '');
  let recipientRole = '员工';
  let actionLabel = '完成绩效目标签字确认';
  let pagePath = '/kpi-confirm-page/' + Buffer.from(String(empId) + '|' + String(month), 'utf8').toString('base64url');
  if (draft && draft.status !== 'approved') {
    if (draft.status === 'invited' || (draft.status === 'rejected' && draft.source !== 'admin-entry')) {
      status = draft.status === 'rejected' ? '待员工修改目标' : (draft.isTargetAdjustment ? '待员工调整目标' : '待员工填写目标');
      actionLabel = draft.status === 'rejected' ? '修改并重新提交绩效目标' : (draft.isTargetAdjustment ? '调整并提交绩效目标' : '填写并提交绩效目标');
      pagePath = targetDraftRoute(empId, month, false);
    } else if (draft.status === 'submitted') {
      node = 'target-manager';
      status = '待直属上级确认目标';
      recipientName = String(emp.directMgr || '');
      recipientRole = '直属上级';
      actionLabel = '确认员工绩效目标';
      pagePath = targetManagerReviewRoute(empId, month);
    } else if (draft.status === 'manager_approved') {
      node = 'target-bp';
      status = '待BP确认目标';
      recipientName = String(emp.hrbp || '薏米');
      recipientRole = 'HRBP';
      actionLabel = '确认员工绩效目标';
      pagePath = targetDraftRoute(empId, month, true);
    } else if (draft.status === 'rejected' && draft.source === 'admin-entry') {
      throw new Error('后台填写的目标已被退回，请修改后重新提交确认');
    }
  }
  if (targetAdjustmentInProgress && draft.status === 'approved') {
    status = '待员工签署调整后目标';
    actionLabel = '核对调整内容并重新签署目标确认书';
  }
  if (targetSigned && targetSigned.doc && !targetAdjustmentInProgress) {
    node = 'self';
    status = '待自评';
    actionLabel = '完成绩效自评';
    pagePath = '/selfeval-page/' + Buffer.from(String(empId) + '|' + String(month), 'utf8').toString('base64url');
  }
  if (selfRecord) {
    node = 'manager';
    status = '待上级评分';
    recipientName = String(emp.directMgr || selfRecord.directMgr || '');
    recipientRole = '直属上级';
    actionLabel = '完成上级评分';
    pagePath = '/mgr-page/' + encodeURIComponent(empId) + '/' + encodeURIComponent(month);
  }
  if (managerRecord) {
    node = 'bp';
    status = '待BP核准';
    recipientName = String(emp.hrbp || selfRecord && selfRecord.hrbp || '薏米');
    recipientRole = 'HRBP';
    actionLabel = '完成BP核准';
    pagePath = '/bp-page/' + encodeURIComponent(empId) + '/' + encodeURIComponent(month);
  }
  if (bpRecord) {
    node = 'result';
    status = '待结果确认';
    recipientName = String(emp.name || '');
    recipientRole = '员工';
    actionLabel = '完成绩效结果签字确认';
    pagePath = '/result-page/' + encodeURIComponent(empId) + '/' + encodeURIComponent(month);
  }
  if (resultSigned && resultSigned.doc) {
    if (resultSigned.sealed === true && resultSigned.archiveFile) {
      return { complete: true, node: 'complete', status: '已归档', emp, empId, month };
    }
    node = 'result-bp-final';
    status = '待BP复核归档';
    recipientName = String(emp.hrbp || '薏米');
    recipientRole = 'HRBP';
    actionLabel = '核对员工绩效结果并归档';
    pagePath = resultBpReviewRoute(empId, month);
  }
  return { complete: false, node, status, recipientName, recipientRole, actionLabel, pagePath, emp, empId, month };
}

function readBody(req) {
  if (Object.prototype.hasOwnProperty.call(req, '_cachedBody')) return Promise.resolve(req._cachedBody);
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      req._cachedBody = body;
      resolve(body);
    });
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"'`]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
  })[character]);
}

function kpiChildItems(kpi) {
  return Array.isArray(kpi && kpi.items) ? kpi.items.filter(Boolean) : [];
}

function scoringUnitsForKpis(kpis) {
  const units = [];
  (Array.isArray(kpis) ? kpis : []).forEach((kpi, parentIndex) => {
    const parentSeq = Number(kpi && kpi.seq) || parentIndex + 1;
    const parentIndicator = String(kpi && kpi.indicator || '').trim();
    const items = kpiChildItems(kpi);
    const sources = items.length ? items : [kpi];
    sources.forEach((source, itemIndex) => {
      units.push({
        seq: units.length + 1,
        parentSeq,
        itemIndex: items.length ? itemIndex + 1 : null,
        grouped: items.length > 0,
        parentIndicator,
        indicator: String(source && source.indicator || parentIndicator || ('KPI ' + parentSeq)).trim(),
        target: '',
        dataSource: kpiDataSource(source),
        rule: String(source && source.rule || '').trim(),
        max: Number(source && (source.weight != null ? source.weight : source.max)) || 0,
      });
    });
  });
  return units;
}

function scoringUnitTitle(unit) {
  if (!unit || !unit.grouped || !unit.parentIndicator || unit.parentIndicator === unit.indicator) return String(unit && unit.indicator || '');
  return unit.parentIndicator + ' · ' + unit.indicator;
}

function isManagerScoreSource(value) {
  return /^(?:直属)?上级(?:打分|评分)$/.test(String(value || '').trim());
}

function cleanKpiDataSource(value) {
  let text = String(value || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  text = text.replace(/^目标值\s*[:：][\s\S]*?数据来源\s*[:：]\s*/i, '').trim();
  return isManagerScoreSource(text) ? '上级评分' : text;
}

function kpiDataSource(kpi) {
  const explicit = String((kpi && (kpi.dataSource || kpi.source)) || '').trim();
  if (explicit) return cleanKpiDataSource(explicit);
  return isManagerScoreSource(kpi && kpi.target) ? '上级评分' : '';
}

function kpiTargetValue(kpi) {
  const target = String((kpi && kpi.target) || '').trim();
  return isManagerScoreSource(target) ? '' : target;
}

function renderKpiIndicatorHtml(kpi) {
  const items = kpiChildItems(kpi);
  return '<strong>' + escapeHtml(kpi && kpi.indicator) + '</strong>' +
    (items.length ? '<div style="margin-top:4px;color:#2563eb;font-size:11px">组合指标 · ' + items.length + '个考核项</div>' : '');
}

function renderKpiTargetHtml(kpi) {
  const items = kpiChildItems(kpi);
  if (!items.length) {
    return '<div style="color:#475569;white-space:pre-line">' + escapeHtml(kpi && kpi.rule || '--') + '</div>';
  }
  return '<div style="display:grid;gap:7px">' + items.map((item, index) =>
    '<div style="padding:7px 9px;border-left:3px solid #93c5fd;background:#f8fafc;border-radius:5px">' +
    '<div style="font-weight:600">' + (index + 1) + '. ' + escapeHtml(item.indicator || ('考核项' + (index + 1))) +
    ' <span style="color:#2563eb;font-weight:500">' + escapeHtml(item.weight) + '%</span></div>' +
    '<div style="margin-top:3px;color:#64748b;font-size:11px;white-space:pre-line">' + escapeHtml(item.rule || '--') + '</div>' +
    '</div>').join('') + '</div>';
}

function renderKpiSourceHtml(kpi) {
  const items = kpiChildItems(kpi);
  if (!items.length) return '<div style="white-space:normal;word-break:break-word;line-height:1.55">' + escapeHtml(kpiDataSource(kpi) || '--') + '</div>';
  const sources = items.map(item => kpiDataSource(item) || '--');
  const uniqueSources = [...new Set(sources)];
  if (uniqueSources.length === 1) {
    return '<div style="display:flex;align-items:center;justify-content:center;min-height:52px;padding:8px 6px;' +
      'background:#f8fafc;border-radius:6px;white-space:normal;word-break:break-word;line-height:1.5;font-weight:500">' +
      escapeHtml(uniqueSources[0]) + '</div>';
  }
  return '<div style="display:grid;gap:7px;min-width:86px">' + sources.map((source, index) =>
    '<div style="padding:7px 8px;background:#f8fafc;border-radius:5px;min-height:34px;line-height:1.4;' +
    'white-space:normal;word-break:break-word"><span style="color:#94a3b8;margin-right:3px">' + (index + 1) + '.</span>' +
    escapeHtml(source) + '</div>').join('') + '</div>';
}

function renderKpiSubItemsHtml(kpi) {
  const items = kpiChildItems(kpi);
  if (!items.length) return '';
  return '<div style="margin:10px 0;padding-left:10px;border-left:3px solid #93c5fd;display:grid;gap:7px">' + items.map((item, index) =>
    '<div style="padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px">' +
    '<div style="font-size:13px;font-weight:600;color:#1e293b">考核项 ' + (index + 1) + '：' + escapeHtml(item.indicator || '') +
    ' <span style="color:#2563eb">' + escapeHtml(item.weight) + '%</span></div>' +
    '<div style="font-size:12px;color:#64748b;margin-top:3px;white-space:pre-line"><strong>评分细则：</strong>' + escapeHtml(item.rule || '--') + '</div>' +
    '<div style="font-size:12px;color:#475569;margin-top:3px"><strong>数据来源：</strong>' + escapeHtml(kpiDataSource(item) || '--') + '</div>' +
    '</div>').join('') + '</div>';
}

function normalizeKpiDefinition(kpi, index) {
  const source = kpi || {};
  const items = kpiChildItems(source).slice(0, 50).map(item => ({
    indicator: String(item.indicator || '').trim(),
    target: '',
    dataSource: kpiDataSource(item),
    rule: String(item.rule || '').trim(),
    weight: Number(item.weight) || 0
  }));
  const weight = items.length ? items.reduce((sum, item) => sum + item.weight, 0) : (Number(source.weight) || 0);
  return {
    seq: Number(source.seq) || index + 1,
    indicator: String(source.indicator || '').trim(),
    target: '',
    dataSource: kpiDataSource(source),
    rule: String(source.rule || '').trim(),
    weight,
    items
  };
}

function saveKpiTargetDrafts() {
  const temporary = KPI_TARGET_DRAFTS_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(kpiTargetDrafts, null, 2), { encoding: 'utf8', mode: 0o640 });
  fs.renameSync(temporary, KPI_TARGET_DRAFTS_FILE);
}

function employeeAllowsZeroWeightKpi(employee) {
  const department = String(employee && (employee.dept || employee.department) || '').trim();
  const employeeName = String(employee && (employee.name || employee.nick) || '').trim();
  // Use the canonical position override as well as the submitted snapshot. This
  // keeps the rule correct for 大林/小曹 even when DingTalk still reports their
  // historical title as “电商运营”.
  const position = FIXED_POSITION_BY_NAME[employeeName] || String(employee && (employee.position || employee.jobTitle) || '').trim();
  return department === '客户运营部' || department === '客服部' || /主播|中控/.test(position);
}

function validateEmployeeTargetKpis(rawKpis, employee) {
  if (!Array.isArray(rawKpis) || rawKpis.length < 1 || rawKpis.length > 30) throw new Error('请填写1至30项考核指标');
  const minimumWeight = employeeAllowsZeroWeightKpi(employee) ? 0 : 1;
  const kpis = rawKpis.map((item, index) => {
    const indicator = String(item && item.indicator || '').trim();
    const rule = String(item && item.rule || '').trim();
    const dataSource = cleanKpiDataSource(item && (item.dataSource || item.source));
    const weight = Number(item && item.weight);
    if (!indicator) throw new Error('第' + (index + 1) + '项考核指标不能为空');
    if (!rule) throw new Error('第' + (index + 1) + '项评分细则不能为空');
    if (!dataSource) throw new Error('第' + (index + 1) + '项数据来源不能为空');
    if (!Number.isInteger(weight) || weight < minimumWeight || weight > 100) {
      throw new Error('第' + (index + 1) + '项权重必须为' + minimumWeight + '至100的整数');
    }
    return normalizeKpiDefinition({ seq: index + 1, indicator, rule, dataSource, weight }, index);
  });
  const totalWeight = kpis.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  if (totalWeight !== 100) throw new Error('权重合计必须为100%，当前为' + totalWeight + '%');
  return kpis;
}

function targetDraftRoute(empId, month, bpReview) {
  const encoded = Buffer.from(String(empId) + '|' + String(month), 'utf8').toString('base64url');
  return (bpReview ? '/target-bp-page/' : '/target-draft-page/') + encoded;
}

function targetManagerReviewRoute(empId, month) {
  const encoded = Buffer.from(String(empId) + '|' + String(month), 'utf8').toString('base64url');
  return '/target-manager-page/' + encoded;
}

function targetKpiSnapshot(kpis) {
  return (Array.isArray(kpis) ? kpis : []).map((kpi, index) => ({
    seq: index + 1,
    indicator: String(kpi && kpi.indicator || '').trim(),
    rule: String(kpi && kpi.rule || '').trim(),
    dataSource: String(kpiDataSource(kpi) || '').trim(),
    weight: Number(kpi && kpi.weight || 0)
  }));
}

function targetKpiChanges(beforeKpis, afterKpis) {
  const before = targetKpiSnapshot(beforeKpis);
  const after = targetKpiSnapshot(afterKpis);
  const fields = [
    ['indicator', '考核指标'], ['rule', '评分细则'],
    ['dataSource', '数据来源'], ['weight', '权重']
  ];
  const changes = [];
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const oldRow = before[index];
    const newRow = after[index];
    if (!oldRow && newRow) {
      changes.push({ seq: index + 1, field: '新增指标', before: '—', after: newRow.indicator });
      continue;
    }
    if (oldRow && !newRow) {
      changes.push({ seq: index + 1, field: '删除指标', before: oldRow.indicator, after: '—' });
      continue;
    }
    for (const [field, label] of fields) {
      const oldValue = field === 'weight' ? oldRow[field] + '%' : oldRow[field];
      const newValue = field === 'weight' ? newRow[field] + '%' : newRow[field];
      if (oldValue !== newValue) changes.push({ seq: index + 1, field: label, before: oldValue, after: newValue });
    }
  }
  return changes;
}

function appendTargetAdjustment(record, role, actorName, beforeKpis, afterKpis) {
  const before = targetKpiSnapshot(beforeKpis);
  const after = targetKpiSnapshot(afterKpis);
  const changes = targetKpiChanges(before, after);
  if (!changes.length) return { changed: false, changes: [] };
  const adjustment = {
    id: crypto.randomUUID(),
    role,
    actorName: String(actorName || ''),
    adjustmentCycle: Number(record.adjustmentCycle || 0),
    adjustedAt: new Date().toISOString(),
    beforeKpis: before,
    afterKpis: after,
    changes
  };
  record.targetAdjustments = Array.isArray(record.targetAdjustments) ? record.targetAdjustments : [];
  record.targetAdjustments.push(adjustment);
  return { changed: true, changes, adjustment };
}

function applyTargetReviewerAdjustment(record, role, kpis) {
  const after = validateEmployeeTargetKpis(kpis, record.emp);
  const actorName = role === 'manager'
    ? String(record.emp && record.emp.directMgr || '直属上级')
    : String(record.emp && record.emp.hrbp || 'BP');
  const result = appendTargetAdjustment(record, role, actorName, record.kpis, after);
  if (result.changed) record.kpis = after;
  return result;
}

function renderTargetAdjustmentHistory(adjustments, options = {}) {
  const allowedRoles = Array.isArray(options.roles) && options.roles.length ? new Set(options.roles) : null;
  const requestedCycle = options.cycle == null ? null : Number(options.cycle || 0);
  const history = (Array.isArray(adjustments) ? adjustments : []).filter(entry =>
    (!allowedRoles || allowedRoles.has(entry.role)) &&
    (requestedCycle == null || Number(entry.adjustmentCycle || 0) === requestedCycle));
  if (!history.length) return '';
  const title = options.title || '目标调整记录（调整前后对比）';
  const help = options.help || '以下内容由系统自动留痕，仅在本轮目标审批过程中供相关处理人核对。';
  const entries = history.map((entry, entryIndex) => {
    const roleLabel = entry.role === 'employee' ? '员工' : entry.role === 'manager' ? '直属上级' : 'BP/HR';
    const rows = (entry.changes || []).map(change => '<tr><td>' + escapeHtml(change.seq) + '</td><td>' + escapeHtml(change.field) + '</td><td>' + escapeHtml(change.before) + '</td><td>' + escapeHtml(change.after) + '</td></tr>').join('');
    return '<section class="target-change-entry"><div class="target-change-meta"><strong>第' + (entryIndex + 1) + '次调整 · ' + roleLabel + ' ' + escapeHtml(entry.actorName || '') + '</strong><span>' + escapeHtml(entry.adjustedAt || '') + '</span></div><div class="target-change-scroll"><table><thead><tr><th>指标序号</th><th>调整字段</th><th>调整前</th><th>调整后</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
  }).join('');
  return '<section class="target-change-history"><style>.target-change-history{margin:20px 0;padding:18px;border:1px solid #f5d38a;border-radius:12px;background:#fffbeb;color:#422006}.target-change-title{font-size:17px;font-weight:750;margin-bottom:6px}.target-change-help{font-size:13px;color:#78613b;margin-bottom:14px}.target-change-entry+.target-change-entry{margin-top:14px}.target-change-meta{display:flex;justify-content:space-between;gap:12px;margin-bottom:8px;font-size:13px}.target-change-meta span{color:#8a7350}.target-change-scroll{overflow:auto;border:1px solid #f3dfb5;border-radius:8px;background:#fff}.target-change-history table{width:100%;border-collapse:collapse;min-width:680px}.target-change-history th,.target-change-history td{padding:9px 10px;text-align:left;border-bottom:1px solid #f5ead2;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}.target-change-history th{background:#fff7dd;color:#725218;font-size:12px}.target-change-history td:nth-child(3){color:#991b1b}.target-change-history td:nth-child(4){color:#047857}@media(max-width:680px){.target-change-meta{display:block}.target-change-meta span{display:block;margin-top:4px}}</style><div class="target-change-title">' + escapeHtml(title) + '</div><div class="target-change-help">' + escapeHtml(help) + '</div>' + entries + '</section>';
}

function renderTargetReviewRows(kpis, editable, employee) {
  const minimumWeight = employeeAllowsZeroWeightKpi(employee) ? 0 : 1;
  return (Array.isArray(kpis) ? kpis : []).map((kpi, index) => '<tr class="review-row"><td class="row-number">' + (index + 1) + '</td><td><input class="input indicator" value="' + escapeHtml(kpi.indicator) + '" ' + (editable ? '' : 'disabled') + '></td><td><textarea rows="4" class="input rule autosize" ' + (editable ? '' : 'disabled') + '>' + escapeHtml(kpi.rule) + '</textarea></td><td><textarea rows="4" class="input source autosize" ' + (editable ? '' : 'disabled') + '>' + escapeHtml(kpiDataSource(kpi)) + '</textarea></td><td><input type="number" min="' + minimumWeight + '" max="100" step="1" inputmode="numeric" class="input weight" value="' + escapeHtml(kpi.weight) + '" ' + (editable ? '' : 'disabled') + '></td>' + (editable ? '<td><button type="button" class="btn row-remove" title="删除本行">删除</button></td>' : '') + '</tr>').join('');
}

function targetReviewerPageHtml(record, role) {
  const isManager = role === 'manager';
  const actionable = record.status === (isManager ? 'submitted' : 'manager_approved');
  const roleLabel = isManager ? '直属上级' : 'BP';
  const actorName = isManager ? (record.emp.directMgr || '--') : (record.emp.hrbp || '薏米');
  const nextLabel = isManager ? '确认并发送BP' : '确认目标无误';
  const endpoint = isManager ? '/review-target-manager' : '/review-target-draft';
  const actionType = isManager ? 'target-manager' : 'target-bp';
  const statusLabel = record.status === 'submitted' ? '等待直属上级确认' : record.status === 'manager_approved' ? '等待BP确认' : record.status === 'approved' ? 'BP已确认，等待员工完成目标签字并归档' : record.status;
  const minimumWeight = employeeAllowsZeroWeightKpi(record.emp) ? 0 : 1;
  const currentTotal = (Array.isArray(record.kpis) ? record.kpis : []).reduce((sum, item) => sum + Number(item && item.weight || 0), 0);
  const meta = JSON.stringify({ empId: record.empId, month: record.month, role, minimumWeight }).replace(/</g, '\\u003c');
  const token = JSON.stringify(workflowActionToken(actionType, record.empId, record.month));
  const serverUrl = JSON.stringify(PUBLIC_SERVER_URL);
  const history = renderTargetAdjustmentHistory(record.targetAdjustments, {
    title: '本轮审批调整记录（调整前后对比）',
    cycle: Number(record.adjustmentCycle || 0),
    roles: isManager ? ['employee', 'manager'] : ['employee', 'manager', 'bp'],
    help: isManager
      ? '以下为员工在本次申请中提交的调整；直属上级如继续修改，保存后也会在此留痕。'
      : '以下为员工及直属上级在本轮流程中已产生的调整；请BP核对后再确认。'
  });
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + roleLabel + '确认员工绩效目标</title><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#f1f5f9;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{max-width:1180px;margin:auto;background:#fff;border-radius:16px;padding:26px;box-shadow:0 10px 30px rgba(15,23,42,.08)}h1{margin:0 0 6px}.sub{color:#64748b;margin-bottom:18px}.reviewer{margin:0 0 18px;padding:12px 14px;border-radius:9px;background:' + (isManager ? '#eff6ff;color:#1d4ed8' : '#ecfdf5;color:#047857') + '}.edit-hint{margin-bottom:14px;padding:11px 13px;border-radius:9px;background:#fff7ed;color:#9a3412;font-size:13px}.wrap{overflow:auto;border:1px solid #dbe4df;border-radius:10px}table{border-collapse:collapse;width:100%;min-width:940px}th{background:' + (isManager ? '#eff6ff;color:#1e40af' : '#ecfdf5;color:#065f46') + ';text-align:left;padding:12px}td{padding:10px;border-top:1px solid #e5e7eb;vertical-align:top}.input{width:100%;padding:9px;border:1px solid #cbd5e1;border-radius:7px;font:inherit;background:#fff}.input:focus{outline:2px solid #99f6e4;border-color:#0f766e}.input:disabled{border-color:transparent;background:transparent;color:#334155;opacity:1}.rule{min-height:76px;resize:vertical}.weight{min-width:76px}.row-tools{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px}.row-help{font-size:13px;color:#64748b}.row-add{color:#047857;border-color:#86efac;background:#f0fdf4}.row-remove{padding:8px 12px;color:#b91c1c;border-color:#fecaca;background:#fff7f7;white-space:nowrap}.actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:20px}.btn{padding:10px 18px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:650}.approve{background:#155e55;color:#fff;border-color:#155e55}.save{color:#1d4ed8;border-color:#93c5fd;background:#eff6ff}.reject{color:#b91c1c;border-color:#fecaca}.notice{padding:14px;border-radius:9px;background:#ecfdf5;color:#047857;margin-top:18px}@media(max-width:680px){body{padding:10px}.page{padding:18px}.actions .btn{flex:1}.row-tools{align-items:stretch;flex-direction:column}.row-add{width:100%}}</style></head><body><main class="page"><h1>' + roleLabel + '确认员工绩效目标</h1><div class="sub">' + escapeHtml(record.month) + ' · ' + escapeHtml(record.emp.name) + '（' + escapeHtml(record.emp.realName) + '）· ' + escapeHtml(record.emp.dept) + '</div><div class="reviewer">当前处理人：' + roleLabel + ' <strong>' + escapeHtml(actorName) + '</strong>。' + (isManager ? '确认后将发送BP继续确认。' : '确认后将通知员工完成目标签字归档。') + '</div>' + (actionable ? '<div class="edit-hint">可以直接修改、增加或删除下表内容。修改会记录调整前后差异，供本轮后续审批节点核对。</div>' : '') + '<div class="wrap"><table><thead><tr><th>#</th><th>考核指标</th><th>评分细则</th><th>数据来源</th><th>权重(%)</th>' + (actionable ? '<th>操作</th>' : '') + '</tr></thead><tbody id="reviewRows">' + renderTargetReviewRows(record.kpis, actionable, record.emp) + '</tbody><tfoot><tr><td colspan="4"><strong>合计</strong></td><td><strong id="reviewTotal">' + currentTotal + '%</strong></td>' + (actionable ? '<td></td>' : '') + '</tr></tfoot></table></div>' + (actionable ? '<div class="row-tools"><span class="row-help">支持1至30项；增删后请调整各项权重，合计必须为100%。</span><button type="button" class="btn row-add" id="addReviewRow">＋ 新增一行</button></div>' : '') + history + (actionable ? '<div class="actions"><button class="btn reject" id="reject">退回员工修改</button><button class="btn save" id="save">保存调整</button><button class="btn approve" id="approve">' + nextLabel + '</button></div>' : '<div class="notice">该目标已处理，当前状态：' + escapeHtml(statusLabel) + '。历史调整记录仍可查看。</div>') + '</main><script>const META=' + meta + ';const TOKEN=' + token + ';const SERVER=' + serverUrl + ';const reviewRows=document.getElementById("reviewRows");function readRows(){return [...document.querySelectorAll(".review-row")].map((r,i)=>({seq:i+1,indicator:r.querySelector(".indicator").value.trim(),rule:r.querySelector(".rule").value.trim(),dataSource:r.querySelector(".source").value.trim(),weight:Number(r.querySelector(".weight").value)}))}function updateRows(){[...document.querySelectorAll(".review-row")].forEach((row,index)=>{const number=row.querySelector(".row-number");if(number)number.textContent=String(index+1)});const total=readRows().reduce((sum,item)=>sum+(Number.isFinite(item.weight)?item.weight:0),0);const totalNode=document.getElementById("reviewTotal");if(totalNode){totalNode.textContent=total+"%";totalNode.style.color=total===100?"#047857":"#b91c1c"}}function blankRow(){const row=document.createElement("tr");row.className="review-row";row.innerHTML=`<td class="row-number"></td><td><input class="input indicator" value=""></td><td><textarea rows="4" class="input rule autosize"></textarea></td><td><textarea rows="4" class="input source autosize"></textarea></td><td><input type="number" min="${META.minimumWeight}" max="100" step="1" inputmode="numeric" class="input weight" value=""></td><td><button type="button" class="btn row-remove" title="删除本行">删除</button></td>`;return row}if(reviewRows){reviewRows.addEventListener("click",event=>{const button=event.target.closest(".row-remove");if(!button)return;const rows=[...reviewRows.querySelectorAll(".review-row")];if(rows.length<=1){alert("至少保留一项考核指标");return}button.closest(".review-row").remove();updateRows()});reviewRows.addEventListener("input",updateRows)}const addRow=document.getElementById("addReviewRow");if(addRow)addRow.onclick=()=>{if(reviewRows.querySelectorAll(".review-row").length>=30){alert("最多填写30项考核指标");return}reviewRows.appendChild(blankRow());updateRows();const indicator=reviewRows.lastElementChild.querySelector(".indicator");if(indicator)indicator.focus()};updateRows();function lock(v){document.querySelectorAll("button").forEach(b=>b.disabled=v)}async function save(){lock(true);try{const r=await fetch(SERVER+"/adjust-target-review",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...META,kpis:readRows(),actionToken:TOKEN})});const x=await r.json();if(!r.ok||!x.success)throw new Error(x.error||"保存失败");alert(x.changed?"调整已保存，差异记录已生成。":"内容没有变化，无需保存。");location.reload()}catch(e){alert(e.message);lock(false)}}async function review(decision,reason){lock(true);try{const payload={...META,decision,reason:reason||"",actionToken:TOKEN};if(decision==="approve")payload.kpis=readRows();const r=await fetch(SERVER+' + JSON.stringify(endpoint) + ',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const x=await r.json();if(!r.ok||!x.success)throw new Error(x.error||"处理失败");const delivered=x.notification&&(x.notification.sent||x.notification.queued);const message=decision==="approve"?(delivered?"确认成功，已通知下一节点。":"确认成功，但下一节点通知未送达，请管理员催办。"):(x.notification?"已退回并通知员工修改。":"已退回修改。");document.querySelector(".actions").outerHTML=`<div class="notice"><strong>${decision==="approve"?"确认成功":"已退回修改"}</strong><br>${message}</div>`}catch(e){alert(e.message);lock(false)}}const s=document.getElementById("save"),a=document.getElementById("approve"),r=document.getElementById("reject");if(s)s.onclick=save;if(a)a.onclick=()=>{if(confirm(' + JSON.stringify(isManager ? '确认当前目标内容并发送BP继续确认？' : '确认当前目标内容无误并通知员工签字？') + '))review("approve","")};if(r)r.onclick=()=>{const reason=prompt("请输入退回原因：");if(reason&&reason.trim())review("reject",reason.trim())};</script></body></html>';
}

function resultBpReviewRoute(empId, month) {
  const encoded = Buffer.from(String(empId) + '|' + String(month), 'utf8').toString('base64url');
  return '/result-bp-review-page/' + encoded;
}

function resultBpReviewPageHtml(record, targetInfo) {
  const emp = targetInfo && targetInfo.emp || {};
  const reviewer = String(emp.hrbp || '薏米');
  const actionable = record && record.bpReviewStatus === 'pending' && record.sealed !== true;
  const actionToken = workflowActionToken('result-bp-final', record.empId, record.month);
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BP复核绩效结果</title><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#f1f5f9;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{max-width:920px;margin:auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 12px 36px rgba(15,23,42,.09)}h1{margin:0 0 8px}.sub{color:#64748b}.info{margin:22px 0;padding:18px;border:1px solid #dbeafe;border-radius:12px;background:#eff6ff;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.item span{display:block;color:#64748b;font-size:12px;margin-bottom:5px}.notice{padding:14px 16px;border-radius:10px;background:#fff7ed;color:#9a3412;line-height:1.7}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.btn{border:1px solid #cbd5e1;border-radius:9px;padding:11px 18px;background:#fff;font-weight:700;cursor:pointer}.primary{background:#155e55;border-color:#155e55;color:#fff}.ok{margin-top:18px;padding:16px;border-radius:10px;background:#ecfdf5;color:#047857}@media(max-width:680px){body{padding:12px}.info{grid-template-columns:1fr}}</style></head><body><main class="page"><h1>BP复核绩效结果并归档</h1><div class="sub">员工已完成绩效结果签字，须由BP核对无误后方可正式封存归档。</div><section class="info"><div class="item"><span>员工</span><strong>' + escapeHtml(emp.name || record.name) + '（' + escapeHtml(emp.realName || record.realName) + '）</strong></div><div class="item"><span>考核月份</span><strong>' + escapeHtml(record.month) + '</strong></div><div class="item"><span>最终得分</span><strong>' + escapeHtml(record.finalScore) + ' 分</strong></div><div class="item"><span>BP复核人</span><strong>' + escapeHtml(reviewer) + '</strong></div><div class="item"><span>员工签署时间</span><strong>' + escapeHtml(record.employeeSignedAt || record.serverSignedAt || '') + '</strong></div><div class="item"><span>当前状态</span><strong>' + (actionable ? '待BP复核归档' : '已复核归档') + '</strong></div></section><div class="notice">请核对绩效得分、等级、员工签名及确认文件内容。点击归档后文件将写入防篡改存档，并触发部门绩效奖金审批条件检查。</div>' + (actionable ? '<div class="actions"><a class="btn" target="_blank" href="' + escapeHtml(publicLink('/result-page/' + encodeURIComponent(record.empId) + '/' + encodeURIComponent(record.month))) + '">查看员工签署文件</a><button class="btn primary" id="approve">核对无误并归档</button></div><div id="status"></div><script>document.getElementById("approve").onclick=async function(){const b=this,s=document.getElementById("status");b.disabled=true;b.textContent="归档中…";try{const r=await fetch("/review-result-bp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({empId:' + JSON.stringify(record.empId) + ',month:' + JSON.stringify(record.month) + ',reviewer:' + JSON.stringify(reviewer) + ',actionToken:' + JSON.stringify(actionToken) + '})});const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error||"归档失败");s.className="ok";s.innerHTML="<strong>复核完成，绩效结果已正式归档。</strong><br>归档时间："+(d.archivedAt||"");b.textContent="已归档"}catch(e){alert(e.message);b.disabled=false;b.textContent="核对无误并归档"}}</script>' : '<div class="ok"><strong>该绩效结果已经BP复核并正式归档。</strong><br>归档时间：' + escapeHtml(record.archivedAt || '') + '</div>') + '</main></body></html>';
}

function targetDraftPageHtml(record) {
  const editable = record.status === 'invited' || record.status === 'rejected';
  const minimumWeight = employeeAllowsZeroWeightKpi(record.emp) ? 0 : 1;
  const existing = editable && Array.isArray(record.kpis) && record.kpis.length ? record.kpis : [{ indicator: '', rule: '', dataSource: '', weight: '' }];
  const previousMonth = previousAssessmentMonth(record.month);
  const previousRecord = previousMonth
    ? (kpiTargets[assessmentKey(record.empId, previousMonth)] || kpiTargetDrafts[assessmentKey(record.empId, previousMonth)])
    : null;
  const previousKpis = previousRecord && Array.isArray(previousRecord.kpis)
    ? previousRecord.kpis.flatMap((kpi, index) => {
        const children = kpiChildItems(kpi);
        if (children.length) return children.map((item, childIndex) => normalizeKpiDefinition(item, childIndex));
        return [normalizeKpiDefinition(kpi, index)];
      })
    : [];
  const meta = { empId: record.empId, month: record.month, emp: record.emp };
  const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const adjustmentMode = record.isTargetAdjustment === true;
  const pageTitle = adjustmentMode ? '员工调整绩效目标' : '员工填写绩效目标';
  const pageHelp = adjustmentMode ? '请在已归档目标基础上完成本次调整，系统将自动记录调整前后差异' : '请本人填写考核指标、评分细则、数据来源和权重';
  const copyPreviousButton = adjustmentMode ? '' : '<button class="btn" id="copyPrevious">📋 从上月复制</button>　';
  const submitLabel = adjustmentMode ? '提交目标调整给直属上级' : '提交给直属上级确认';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + pageTitle + '</title><style>' +
    '*{box-sizing:border-box}body{margin:0;background:#f1f5f9;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{max-width:1080px;margin:28px auto;padding:0 16px}.hero{padding:24px 28px;border-radius:16px 16px 0 0;background:#155e55;color:#fff}.hero h1{margin:0 0 6px;font-size:23px}.card{background:#fff;padding:24px 28px;border-radius:0 0 16px 16px;box-shadow:0 12px 32px rgba(15,23,42,.08)}.info{display:flex;justify-content:space-between;gap:16px;padding:14px 16px;background:#f8fafc;border-radius:10px;margin-bottom:18px}.row{display:grid;grid-template-columns:1.1fr 2fr 1.1fr 110px 42px;gap:10px;padding:14px 0;border-bottom:1px solid #e2e8f0;align-items:start}.label{font-size:12px;color:#64748b;margin-bottom:5px}.input{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}.input:focus{outline:2px solid #99f6e4;border-color:#0f766e}.rule{min-height:82px;resize:vertical}.btn{border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:10px 14px;cursor:pointer}.primary{background:#155e55;color:#fff;border-color:#155e55;font-weight:700}.danger{color:#b91c1c}.actions{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:20px}.status{margin:0 0 18px;padding:12px 14px;border-radius:9px;background:#fff7ed;color:#9a3412}.ok{background:#ecfdf5;color:#047857}@media(max-width:760px){.row{grid-template-columns:1fr}.hero,.card{padding:20px}.info{display:block}.info div+div{margin-top:6px}.actions{align-items:stretch;flex-direction:column}}</style></head><body><main class="page"><header class="hero"><h1>' + escapeHtml(record.month) + (adjustmentMode ? '绩效目标调整' : '绩效目标填报') + '</h1><div>' + pageHelp + '</div></header><section class="card"><div class="info"><div><strong>' + escapeHtml(record.emp.name) + '（' + escapeHtml(record.emp.realName) + '）</strong><br><span>' + escapeHtml(record.emp.dept) + ' · ' + escapeHtml(record.emp.position) + '</span></div><div>直属上级：<strong>' + escapeHtml(record.emp.directMgr || '--') + '</strong>　·　BP：<strong>' + escapeHtml(record.emp.hrbp || '薏米') + '</strong></div></div>' +
    (record.status === 'rejected' ? '<div class="status">' + escapeHtml(record.rejectedBy === 'manager' ? '直属上级' : 'BP') + '已退回：' + escapeHtml(record.reviewReason || '请修改后重新提交') + '</div>' : '') +
    (!editable ? '<div class="status ok">' + escapeHtml(record.status === 'submitted' ? '目标已提交，正在等待直属上级确认，无需重复提交。' : record.status === 'manager_approved' ? '直属上级已确认，正在等待BP确认。' : '目标已确认，正在等待员工签字归档。') + '</div>' : '<div id="rows"></div><div class="actions"><div>' + copyPreviousButton + '<button class="btn" id="add">＋ 增加指标</button></div><div><strong>权重合计：<span id="total">0</span>%</strong>　<button class="btn primary" id="submit">' + submitLabel + '</button></div></div>') +
    '</section></main><script>const META=' + safeJson(meta) + ';const INITIAL=' + safeJson(existing) + ';const PREVIOUS_MONTH=' + safeJson(previousMonth) + ';const PREVIOUS=' + safeJson(previousKpis) + ';const MIN_WEIGHT=' + minimumWeight + ';const ACTION_TOKEN=' + safeJson(workflowActionToken('target-draft', record.empId, record.month)) + ';const SERVER_URL=' + safeJson(PUBLIC_SERVER_URL) + ';const rows=document.getElementById("rows");function esc(v){return String(v==null?"":v).replace(/[&<>"\']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","\'":"&#39;"}[c]))}function readRows(){return [...document.querySelectorAll(".row")].map((r,i)=>({seq:i+1,indicator:r.querySelector(".indicator").value,rule:r.querySelector(".rule").value,dataSource:r.querySelector(".source").value,weight:r.querySelector(".weight").value}))}function snapshotRows(){const current=readRows();if(current.length)INITIAL.splice(0,INITIAL.length,...current)}function render(){if(!rows)return;rows.innerHTML=INITIAL.map((x,i)=>`<div class="row"><div><div class="label">考核指标</div><input class="input indicator" value="${esc(x.indicator)}"></div><div><div class="label">评分细则</div><textarea class="input rule">${esc(x.rule)}</textarea></div><div><div class="label">数据来源</div><input class="input source" value="${esc(x.dataSource||x.source)}"></div><div><div class="label">权重(%)</div><input type="number" min="${MIN_WEIGHT}" max="100" step="1" inputmode="numeric" class="input weight" value="${esc(x.weight)}"></div><button type="button" class="btn danger remove" data-index="${i}" title="删除">×</button></div>`).join("");document.querySelectorAll(".remove").forEach(b=>b.onclick=()=>{snapshotRows();if(INITIAL.length===1)return alert("至少保留一项指标");INITIAL.splice(Number(b.dataset.index),1);render()});document.querySelectorAll(".weight").forEach(x=>x.oninput=update);update()}function update(){document.getElementById("total").textContent=[...document.querySelectorAll(".weight")].reduce((s,x)=>s+(Number(x.value)||0),0)}if(document.getElementById("copyPrevious"))document.getElementById("copyPrevious").onclick=()=>{if(!PREVIOUS.length)return alert(PREVIOUS_MONTH+"暂无可复制的绩效目标");const current=readRows();const hasContent=current.some(item=>item.indicator.trim()||item.rule.trim()||item.dataSource.trim()||Number(item.weight));if(hasContent&&!confirm("复制将替换当前尚未提交的填写内容，是否继续？"))return;INITIAL.splice(0,INITIAL.length,...PREVIOUS.map((item,index)=>({seq:index+1,indicator:item.indicator||"",rule:item.rule||"",dataSource:item.dataSource||item.source||"",weight:item.weight||""})));render();alert("已复制"+PREVIOUS_MONTH+"绩效目标，请修改确认后再提交")} ;if(document.getElementById("add"))document.getElementById("add").onclick=()=>{snapshotRows();INITIAL.push({indicator:"",rule:"",dataSource:"",weight:""});render()};if(document.getElementById("submit"))document.getElementById("submit").onclick=async()=>{const kpis=readRows().map((item,i)=>({seq:i+1,indicator:item.indicator.trim(),rule:item.rule.trim(),dataSource:item.dataSource.trim(),weight:Number(item.weight)}));const btn=document.getElementById("submit");btn.disabled=true;btn.textContent="提交中…";try{const response=await fetch(SERVER_URL+"/submit-target-draft",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({empId:META.empId,month:META.month,kpis,actionToken:ACTION_TOKEN})});const result=await response.json();if(!response.ok)throw new Error(result.error||"提交失败");const detail=result.warning?"目标已保存，但直属上级通知未送达："+esc(result.warning):"已通知"+esc(result.managerName||"直属上级")+"进行目标确认。直属上级确认后将发送BP确认，BP确认通过后再通知你完成目标签字归档。";document.querySelector(".card").innerHTML=`<div class="status ok"><strong>提交成功</strong><br>${detail}</div>`}catch(error){alert(error.message);btn.disabled=false;btn.textContent="提交给直属上级确认"}};render();</script></body></html>';
}

function enhanceTargetFormHtml(html, mode) {
  const employeeMode = mode === 'employee';
  const css = '<style id="target-form-layout-upgrade">' +
    '.page{max-width:1380px!important}.rule,.source{min-height:132px!important;line-height:1.65!important;overflow:hidden!important;resize:vertical!important;white-space:pre-wrap!important;overflow-wrap:anywhere}' +
    (employeeMode
      ? '.row{grid-template-columns:minmax(180px,.9fr) minmax(420px,2.2fr) minmax(280px,1.45fr) minmax(86px,.42fr) 76px!important;gap:12px!important}.row>div{min-width:0}.row>div:first-child,.row>div:nth-child(4){position:relative;display:flex;flex-direction:column;justify-content:center;align-self:stretch;padding-top:21px}.row>div:first-child>.label,.row>div:nth-child(4)>.label{position:absolute;top:0;left:0}.row .rule,.row .source{height:auto}.row .indicator,.row .weight{width:100%}.row .weight{text-align:center;font-weight:700}.row .remove{width:76px;align-self:center;white-space:nowrap;color:#b91c1c;border-color:#fecaca;background:#fff7f7}'
      : 'table{min-width:1120px!important;table-layout:fixed}th:nth-child(1){width:48px}th:nth-child(2){width:18%}th:nth-child(3){width:39%}th:nth-child(4){width:27%}th:nth-child(5){width:100px}') +
    '@media(max-width:900px){.page{padding-left:10px!important;padding-right:10px!important}' + (employeeMode ? '.row{grid-template-columns:1fr!important}.rule,.source{min-height:116px!important}' : '') + '}' +
    '</style>';
  const script = '<script id="target-form-autosize">(()=>{const fit=e=>{if(!e||e.tagName!=="TEXTAREA")return;e.style.height="auto";e.style.height=Math.max(116,e.scrollHeight+2)+"px"};const upgrade=()=>{' +
    (employeeMode ? 'document.querySelectorAll("input.source").forEach(input=>{const area=document.createElement("textarea");area.className=input.className+" autosize";area.rows=4;area.value=input.value;area.placeholder=input.placeholder||"请输入数据来源";input.replaceWith(area)});document.querySelectorAll(".remove").forEach(button=>{button.textContent="删除";button.title="删除本项考核指标"});' : '') +
    'document.querySelectorAll("textarea.rule,textarea.source,textarea.autosize").forEach(area=>{fit(area);if(!area.dataset.autosizeBound){area.dataset.autosizeBound="1";area.addEventListener("input",()=>fit(area))}})};upgrade();const rows=document.getElementById("rows")||document.getElementById("reviewRows");if(rows)new MutationObserver(()=>requestAnimationFrame(upgrade)).observe(rows,{childList:true,subtree:true});window.addEventListener("resize",upgrade)})();</script>';
  return String(html || '').replace('</head>', css + '</head>').replace('</body>', script + '</body>');
}

function targetDraftPageHtmlWithHistory(record) {
  let html = targetDraftPageHtml(record);
  let currentTargets = '';
  if (record.status !== 'invited' && record.status !== 'rejected') {
    const rows = (record.kpis || []).map((kpi, index) => '<tr><td>' + (index + 1) + '</td><td><strong>' + escapeHtml(kpi.indicator) + '</strong></td><td style="white-space:pre-line">' + escapeHtml(kpi.rule) + '</td><td>' + escapeHtml(kpiDataSource(kpi)) + '</td><td><strong>' + escapeHtml(kpi.weight) + '%</strong></td></tr>').join('');
    currentTargets = '<section style="margin-top:18px"><h2 style="font-size:18px;margin:0 0 12px">当前目标内容</h2><div style="overflow:auto;border:1px solid #dbe4df;border-radius:10px"><table style="border-collapse:collapse;width:100%;min-width:820px"><thead><tr style="background:#eff6ff;color:#1e40af;text-align:left"><th style="padding:12px">#</th><th style="padding:12px">考核指标</th><th style="padding:12px">评分细则</th><th style="padding:12px">数据来源</th><th style="padding:12px">权重</th></tr></thead><tbody>' + rows.replace(/<td>/g, '<td style="padding:12px;border-top:1px solid #e5e7eb;vertical-align:top">') + '</tbody></table></div></section>';
  }
  if (!currentTargets) return enhanceTargetFormHtml(html, 'employee');
  return enhanceTargetFormHtml(html.replace('</section></main>', currentTargets + '</section></main>'), 'employee');
}

function targetManagerReviewPageHtml(record) {
  const rows = (record.kpis || []).map((kpi, index) => '<tr><td>' + (index + 1) + '</td><td><strong>' + escapeHtml(kpi.indicator) + '</strong></td><td style="white-space:pre-line">' + escapeHtml(kpi.rule) + '</td><td>' + escapeHtml(kpiDataSource(kpi)) + '</td><td><strong>' + escapeHtml(kpi.weight) + '%</strong></td></tr>').join('');
  const actionable = record.status === 'submitted';
  const statusLabel = record.status === 'manager_approved' ? '直属上级已确认，等待BP确认' : record.status === 'approved' ? 'BP已确认，等待员工签字归档' : record.status;
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>直属上级确认员工绩效目标</title><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#f1f5f9;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{max-width:1100px;margin:auto;background:#fff;border-radius:16px;padding:26px;box-shadow:0 10px 30px rgba(15,23,42,.08)}h1{margin:0 0 6px}.sub{color:#64748b;margin-bottom:20px}.reviewer{margin:0 0 18px;padding:12px 14px;border-radius:9px;background:#eff6ff;color:#1d4ed8}.wrap{overflow:auto;border:1px solid #dbe4df;border-radius:10px}table{border-collapse:collapse;width:100%;min-width:820px}th{background:#eff6ff;color:#1e40af;text-align:left;padding:12px}td{padding:13px 12px;border-top:1px solid #e5e7eb;vertical-align:top}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.btn{padding:10px 18px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:650}.approve{background:#155e55;color:#fff;border-color:#155e55}.reject{color:#b91c1c;border-color:#fecaca}.notice{padding:14px;border-radius:9px;background:#ecfdf5;color:#047857;margin-top:18px}</style></head><body><main class="page"><h1>直属上级确认员工绩效目标</h1><div class="sub">' + escapeHtml(record.month) + ' · ' + escapeHtml(record.emp.name) + '（' + escapeHtml(record.emp.realName) + '）· ' + escapeHtml(record.emp.dept) + '</div><div class="reviewer">当前确认人：直属上级 <strong>' + escapeHtml(record.emp.directMgr || '--') + '</strong>。确认通过后，系统将自动发送给BP <strong>' + escapeHtml(record.emp.hrbp || '薏米') + '</strong> 继续确认。</div><div class="wrap"><table><thead><tr><th>#</th><th>考核指标</th><th>评分细则</th><th>数据来源</th><th>权重</th></tr></thead><tbody>' + rows + '</tbody><tfoot><tr><td colspan="4"><strong>合计</strong></td><td><strong>100%</strong></td></tr></tfoot></table></div>' +
    (actionable ? '<div class="actions"><button class="btn reject" id="reject">退回修改</button><button class="btn approve" id="approve">确认并发送BP</button></div>' : '<div class="notice">该目标已处理，当前状态：' + escapeHtml(statusLabel) + '</div>') +
    '</main><script>const META=' + JSON.stringify({ empId: record.empId, month: record.month }).replace(/</g, '\\u003c') + ';const TOKEN=' + JSON.stringify(workflowActionToken('target-manager', record.empId, record.month)) + ';const SERVER=' + JSON.stringify(PUBLIC_SERVER_URL) + ';async function review(decision,reason){const buttons=document.querySelectorAll("button");buttons.forEach(b=>b.disabled=true);try{const r=await fetch(SERVER+"/review-target-manager",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...META,decision,reason:reason||"",actionToken:TOKEN})});const x=await r.json();if(!r.ok)throw new Error(x.error||"处理失败");const delivered=x.notification&&(x.notification.sent||x.notification.queued);const message=decision==="approve"?(delivered?"直属上级确认成功，已发送BP继续确认。":"目标已确认，但BP通知未送达，请管理员在系统内催办。"+(x.warning?"（"+x.warning+"）":"")):(x.notification?"已退回并通知相关人员修改。":"已退回后台修改。");document.querySelector(".actions").outerHTML=`<div class="notice"><strong>${decision==="approve"?"直属上级确认成功":"已退回修改"}</strong><br>${message}</div>`}catch(e){alert(e.message);buttons.forEach(b=>b.disabled=false)}}const a=document.getElementById("approve"),r=document.getElementById("reject");if(a)a.onclick=()=>{if(confirm("确认该员工绩效目标无误并发送BP继续确认？"))review("approve","")};if(r)r.onclick=()=>{const reason=prompt("请输入退回原因：");if(reason&&reason.trim())review("reject",reason.trim())};</script></body></html>';
}

function targetBpReviewPageHtml(record) {
  const rows = (record.kpis || []).map((kpi, index) => '<tr><td>' + (index + 1) + '</td><td><strong>' + escapeHtml(kpi.indicator) + '</strong></td><td style="white-space:pre-line">' + escapeHtml(kpi.rule) + '</td><td>' + escapeHtml(kpiDataSource(kpi)) + '</td><td><strong>' + escapeHtml(kpi.weight) + '%</strong></td></tr>').join('');
  const actionable = record.status === 'manager_approved';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BP确认员工绩效目标</title><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#f1f5f9;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{max-width:1100px;margin:auto;background:#fff;border-radius:16px;padding:26px;box-shadow:0 10px 30px rgba(15,23,42,.08)}h1{margin:0 0 6px}.sub{color:#64748b;margin-bottom:20px}.wrap{overflow:auto;border:1px solid #dbe4df;border-radius:10px}table{border-collapse:collapse;width:100%;min-width:820px}th{background:#ecfdf5;color:#065f46;text-align:left;padding:12px}td{padding:13px 12px;border-top:1px solid #e5e7eb;vertical-align:top}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.btn{padding:10px 18px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:650}.approve{background:#059669;color:#fff;border-color:#059669}.reject{color:#b91c1c;border-color:#fecaca}.notice{padding:14px;border-radius:9px;background:#ecfdf5;color:#047857;margin-top:18px}</style></head><body><main class="page"><h1>BP确认员工绩效目标</h1><div class="sub">' + escapeHtml(record.month) + ' · ' + escapeHtml(record.emp.name) + '（' + escapeHtml(record.emp.realName) + '）· ' + escapeHtml(record.emp.dept) + '</div><div class="wrap"><table><thead><tr><th>#</th><th>考核指标</th><th>评分细则</th><th>数据来源</th><th>权重</th></tr></thead><tbody>' + rows + '</tbody><tfoot><tr><td colspan="4"><strong>合计</strong></td><td><strong>100%</strong></td></tr></tfoot></table></div>' +
    (actionable ? '<div class="actions"><button class="btn reject" id="reject">退回修改</button><button class="btn approve" id="approve">确认目标无误</button></div>' : '<div class="notice">该目标已处理，当前状态：' + escapeHtml(record.status === 'submitted' ? '等待直属上级确认' : record.status === 'approved' ? 'BP已确认，等待员工完成目标签字并归档' : record.status) + '</div>') +
    '</main><script>const META=' + JSON.stringify({ empId: record.empId, month: record.month }).replace(/</g, '\\u003c') + ';const TOKEN=' + JSON.stringify(workflowActionToken('target-bp', record.empId, record.month)) + ';const SERVER=' + JSON.stringify(PUBLIC_SERVER_URL) + ';async function review(decision,reason){const buttons=document.querySelectorAll("button");buttons.forEach(b=>b.disabled=true);try{const r=await fetch(SERVER+"/review-target-draft",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...META,decision,reason:reason||"",actionToken:TOKEN})});const x=await r.json();if(!r.ok)throw new Error(x.error||"处理失败");const delivered=x.notification&&(x.notification.sent||x.notification.queued);const message=decision==="approve"?(delivered?"目标已确认，员工已收到目标签字确认通知；签字后将自动归档。":"目标已确认，但员工签字通知未送达，请管理员在系统内催办。"+(x.warning?"（"+x.warning+"）":"")):"员工已收到修改通知。";document.querySelector(".actions").outerHTML=`<div class="notice"><strong>${decision==="approve"?"BP确认成功":"已退回员工修改"}</strong><br>${message}</div>`}catch(e){alert(e.message);buttons.forEach(b=>b.disabled=false)}}const a=document.getElementById("approve"),r=document.getElementById("reject");if(a)a.onclick=()=>{if(confirm("确认该员工绩效目标无误？确认后系统将通知员工完成目标签字确认并归档。"))review("approve","")};if(r)r.onclick=()=>{const reason=prompt("请输入退回原因：");if(reason&&reason.trim())review("reject",reason.trim())};</script></body></html>';
}

function normalizeSignatureText(value) {
  return String(value || '').replace(/[\s()（）·+＋,，.。_\-—/\\]/g, '');
}

function validateStandardSignature(data, expectedEmployee) {
  const employee = expectedEmployee || {};
  const realName = normalizeSignatureText(employee.realName || data.realName);
  const nickName = normalizeSignatureText(employee.name || data.name);
  const signatureText = normalizeSignatureText(data.signatureText);
  if (!realName || !signatureText) return '请输入完整签名文字';
  if (signatureText !== realName || data.signatureFormat !== 'realName') return '签名只允许使用员工真实姓名，花名或组合签名不能提交';
  if (data.signatureStyle !== '手写楷体') return '必须由员工本人手写签名，不允许电子生成签名';
  const metrics = data.signatureMetrics;
  const characters = Array.from(signatureText);
  if (!metrics || metrics.manuallyDrawn !== true || metrics.signatureFormat !== data.signatureFormat) return '未检测到有效的本人手写笔迹';
  if (Number(metrics.expectedCharacterCount) !== characters.length || !Array.isArray(metrics.characters) || metrics.characters.length !== characters.length) {
    return '手写签名存在缺字，不能提交';
  }
  const minimumStrokes = Math.max(characters.length * 2, 3);
  if (Number(metrics.crossSlotStrokeCount) !== 0) {
    return '检测到跨字连写，请在每个分字框内用楷体逐字书写';
  }
  if (Number(metrics.pointCount) < characters.length * 3 || Number(metrics.pathLength) < characters.length * 35 || Number(metrics.strokeCount) < minimumStrokes) {
    return '手写笔迹过少或不够清晰';
  }
  for (let index = 0; index < metrics.characters.length; index++) {
    const characterMetric = metrics.characters[index] || {};
    if (characterMetric.character !== characters[index] || Number(characterMetric.inkPixels) < 35 ||
        Number(characterMetric.widthRatio) < 0.08 || Number(characterMetric.heightRatio) < 0.10) {
      return '第' + (index + 1) + '个字笔迹不足或不清晰';
    }
  }
  if (typeof data.sigData !== 'string' || !data.sigData.startsWith('data:image/png;base64,') || data.sigData.length < 500) {
    return '签名图片不清晰或数据不完整';
  }
  return '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
}

function hmacSha256(value) {
  return crypto.createHmac('sha256', LINK_SIGNING_SECRET || 'development-only-signing-secret')
    .update(String(value == null ? '' : value), 'utf8').digest('hex');
}

function safeTextEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers['x-real-ip'] || '').trim() ||
    String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '') || 'unknown';
}

const OPERATION_ACTIONS = Object.freeze({
  '/admin-login': ['账号安全', '登录系统'],
  '/dingtalk-admin-login': ['账号安全', '钉钉登录尝试'],
  '/monthly-events': ['每月事件', '维护每月事件'],
  '/request-target-adjustment': ['KPI目标', '发起目标调整'],
  '/invite-target-draft': ['KPI目标', '邀请员工填写目标'],
  '/withdraw-target-invitation': ['KPI目标', '撤回目标邀请'],
  '/submit-target-draft': ['KPI目标', '员工提交目标'],
  '/adjust-target-review': ['KPI目标', '审批人调整目标'],
  '/review-target-manager': ['KPI目标', '直属上级审核目标'],
  '/review-target-draft': ['KPI目标', 'BP审核目标'],
  '/generate-kpi-pages': ['KPI目标', '批量发起目标流程'],
  '/submit': ['绩效结果', '员工提交自评'],
  '/submit-mgr': ['绩效结果', '直属上级提交评分'],
  '/submit-bp': ['绩效结果', 'BP提交核准评分'],
  '/submit-kpi': ['签字归档', '员工签署KPI目标'],
  '/submit-result': ['签字归档', '员工签署绩效结果'],
  '/review-result-bp': ['签字归档', 'BP复核绩效结果'],
  '/reject-signature': ['签字归档', '退回签字文件'],
  '/request-sign-otp': ['身份验证', '发送签字验证码'],
  '/verify-sign-otp': ['身份验证', '验证签字验证码'],
  '/sign-otp-status': ['身份验证', '查询签字验证状态'],
  '/workflow-resets': ['流程管理', '调整流程状态'],
  '/workflow-reminder': ['流程通知', '催办当前流程'],
  '/oa-approval-retry': ['流程通知', '重试OA审批'],
  '/send-bot-msg': ['流程通知', '发送钉钉通知'],
  '/send-bot-batch': ['流程通知', '批量发送钉钉通知'],
  '/employee-overrides': ['组织管理', '调整员工组织关系'],
  '/performance-exclusions': ['组织管理', '调整绩效参与范围'],
  '/admin-dingtalk-bind': ['账号安全', '绑定管理员钉钉'],
  '/okr-invite': ['OKR', '邀请员工填写OKR'],
  '/okr-remind': ['OKR', '催办OKR流程'],
  '/okr-send-self-review': ['OKR', '发送OKR结果填写'],
  '/okr-sign-otp': ['身份验证', '发送OKR签字验证码'],
  '/okr-sign-verify': ['身份验证', '验证OKR签字验证码'],
  '/okr-action': ['OKR', '办理OKR流程']
});

function operationAuditTailHash() {
  try {
    const lines = fs.readFileSync(OPERATION_AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    if (!lines.length) return '';
    return String(JSON.parse(lines[lines.length - 1]).eventHash || '');
  } catch (_) { return ''; }
}

let lastOperationAuditHash = operationAuditTailHash();

function shouldAuditOperation(method, pathname) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase()) || pathname === '/admin-logout';
}

function parseOperationPayload(req) {
  const body = String(req._cachedBody || '');
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    try { return Object.fromEntries(new URLSearchParams(body)); } catch (_) { return {}; }
  }
}

function operationEmployeeIdentity(empId) {
  empId = String(empId || '').trim();
  if (!empId) return null;
  return dashboardEmployeeIdentities()[empId] || null;
}

function safeOperationDetails(payload) {
  const details = {};
  const safeKeys = ['action', 'empId', 'month', 'role', 'status', 'type', 'department', 'name', 'id'];
  for (const key of safeKeys) {
    const value = payload && payload[key];
    if (['string', 'number', 'boolean'].includes(typeof value) && String(value).length <= 300) details[key] = value;
  }
  for (const key of ['pages', 'messages', 'excludedEmpIds', 'kpis', 'objectives', 'weeklyObjectives', 'completions']) {
    if (Array.isArray(payload && payload[key])) details[key + 'Count'] = payload[key].length;
  }
  return details;
}

function operationActor(req, pathname, payload) {
  const sessionProfile = req.accessProfile || readAdminSession(req);
  if (sessionProfile && sessionProfile.authorized) return { name: sessionProfile.name, role: sessionProfile.role };
  if (pathname === '/admin-login') return { name: String(payload.username || '未知账号'), role: '登录账号' };
  const empId = String(payload.empId || payload.employeeId || '').trim();
  const identity = operationEmployeeIdentity(empId) || {};
  const employeePaths = new Set(['/submit-target-draft', '/submit', '/submit-kpi', '/submit-result', '/request-sign-otp', '/sign-otp-status', '/okr-sign-otp']);
  const managerPaths = new Set(['/review-target-manager', '/submit-mgr']);
  const bpPaths = new Set(['/review-target-draft', '/submit-bp', '/review-result-bp']);
  if (employeePaths.has(pathname)) return { name: String(identity.name || payload.name || '未识别员工'), role: '员工' };
  if (managerPaths.has(pathname)) return { name: String(identity.directMgr || '未识别直属上级'), role: '直属上级' };
  if (bpPaths.has(pathname)) return { name: String(identity.hrbp || '未识别BP'), role: 'BP' };
  if (pathname === '/adjust-target-review') {
    const manager = String(payload.role || '') === 'manager';
    return { name: String(manager ? identity.directMgr : identity.hrbp || '未识别审批人'), role: manager ? '直属上级' : 'BP' };
  }
  if (pathname === '/okr-action') {
    const action = String(payload.action || '');
    if (action.includes('manager')) return { name: String(identity.directMgr || '未识别直属上级'), role: '直属上级' };
    if (action.includes('bp')) return { name: String(identity.hrbp || '未识别BP'), role: 'BP' };
    return { name: String(identity.name || '未识别员工'), role: '员工' };
  }
  return { name: '未识别用户', role: '未知' };
}

function operationTarget(payload) {
  const empId = String(payload.empId || payload.employeeId || '').trim();
  const identity = operationEmployeeIdentity(empId);
  if (identity) return [identity.name, identity.realName, payload.month].filter(Boolean).join(' · ');
  return [payload.department, payload.name, payload.month, payload.id].filter(value => typeof value === 'string' && value.trim()).join(' · ');
}

function appendOperationAudit(req, res, pathname) {
  try {
    const payload = parseOperationPayload(req);
    const context = req._operationAuditContext || {};
    const descriptor = OPERATION_ACTIONS[pathname] || ['系统操作', String(req.method || '') + ' ' + pathname];
    const actor = context.actor || operationActor(req, pathname, payload);
    const core = {
      auditId: crypto.randomUUID(),
      serverTime: new Date().toISOString(),
      actorName: String(actor.name || '未识别用户').slice(0, 120),
      actorRole: String(actor.role || '未知').slice(0, 120),
      category: String(context.category || descriptor[0]).slice(0, 120),
      action: String(context.action || descriptor[1]).slice(0, 200),
      target: String(context.target || operationTarget(payload) || '--').slice(0, 500),
      method: String(req.method || ''),
      path: pathname,
      statusCode: Number(res.statusCode) || 0,
      success: Number(res.statusCode) >= 200 && Number(res.statusCode) < 400,
      ipAddress: requestIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
      details: context.details || safeOperationDetails(payload),
      previousHash: lastOperationAuditHash
    };
    const eventHash = sha256(JSON.stringify(core));
    const record = { ...core, eventHash, serverSeal: hmacSha256(eventHash) };
    fs.appendFileSync(OPERATION_AUDIT_FILE, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o640 });
    lastOperationAuditHash = eventHash;
  } catch (error) {
    console.error('[operation-audit] Failed to append operation log:', error.message);
  }
}

function readOperationAuditEntries(limit) {
  limit = Math.max(1, Math.min(Number(limit) || 300, 1000));
  const lines = fs.readFileSync(OPERATION_AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).reverse().map(line => {
    try {
      const record = JSON.parse(line);
      const expectedSeal = hmacSha256(String(record.eventHash || ''));
      return { ...record, integrityValid: safeTextEqual(record.serverSeal, expectedSeal) };
    } catch (_) { return null; }
  }).filter(Boolean);
}

function monthlyEventAuditSnapshot(event) {
  if (!event) return null;
  return {
    id: event.id, month: event.month, department: event.department, empId: event.empId,
    name: event.name, realName: event.realName, date: event.date,
    summary: event.summary, details: event.details,
    images: (Array.isArray(event.images) ? event.images : []).map(image => ({ name: image.name || '', sha256: sha256(image.dataUrl || '') }))
  };
}

function appendSignatureAudit(req, event, details) {
  const input = details || {};
  const core = {
    auditId: crypto.randomUUID(),
    event,
    serverTime: new Date().toISOString(),
    documentType: input.documentType || '',
    empId: input.empId || '',
    name: input.name || '',
    realName: input.realName || '',
    month: input.month || '',
    ipAddress: requestIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 1000),
    previousHash: lastSignatureAuditHash,
    details: input.details || {}
  };
  const eventHash = sha256(JSON.stringify(core));
  const record = { ...core, eventHash, serverSeal: hmacSha256(eventHash) };
  fs.appendFileSync(SIGNATURE_AUDIT_FILE, JSON.stringify(record) + '\n', 'utf8');
  lastSignatureAuditHash = eventHash;
  return record;
}

function verifySignatureAuditChain() {
  const lines = fs.readFileSync(SIGNATURE_AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  let previousHash = '';
  const entries = [];
  let valid = true;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const { eventHash, serverSeal, ...core } = record;
      const calculatedHash = sha256(JSON.stringify(core));
      const entryValid = core.previousHash === previousHash && safeTextEqual(eventHash, calculatedHash) &&
        safeTextEqual(serverSeal, hmacSha256(eventHash));
      entries.push({ ...record, chainValid: entryValid });
      if (!entryValid) valid = false;
      previousHash = eventHash || '';
    } catch (error) {
      valid = false;
      entries.push({ parseError: error.message, chainValid: false });
    }
  }
  return { valid, entries };
}

function cleanupSigningSessions() {
  const now = Date.now();
  for (const [key, value] of signingChallenges) if (!value || value.expiresAt <= now) signingChallenges.delete(key);
  for (const [key, value] of signingVerifications) if (!value || value.expiresAt <= now || value.used) signingVerifications.delete(key);
}

function activeSigningChallenge(empId, month, documentType) {
  cleanupSigningSessions();
  return Array.from(signingChallenges.values())
    .filter(item => item && item.empId === String(empId || '') && item.month === String(month || '') &&
      item.documentType === (documentType === 'result' ? 'result' : 'kpi') && item.expiresAt > Date.now())
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null;
}

function validateSigningPage(data, expectedEmployee) {
  const pagePath = String(data.pagePath || '');
  const pageToken = String(data.pageToken || '');
  const documentType = data.documentType === 'result' ? 'result' : 'kpi';
  const validPrefix = documentType === 'result'
    ? pagePath.startsWith('/result-page/')
    : (pagePath.startsWith('/kpi-page/') || pagePath.startsWith('/kpi-page-b64/') || pagePath.startsWith('/kpi-confirm-page/'));
  if (!validPrefix || !pageToken || !safeTextEqual(pageToken, signPath(pagePath))) return '签署链接无效或已被篡改，请从钉钉通知重新打开';
  if (documentType === 'result') {
    // Result links may include the assessment month as a second path segment:
    // /result-page/:empId/:month.  The previous implementation decoded the
    // complete suffix as the employee id, so every month-scoped link failed
    // identity validation even though its HMAC token was valid.
    const resultPathParts = pagePath.slice('/result-page/'.length).split('/');
    let pathEmpId = '';
    let pathMonth = '';
    try {
      pathEmpId = decodeURIComponent(resultPathParts[0] || '');
      pathMonth = decodeURIComponent(resultPathParts[1] || '');
    } catch (_) {
      return '签署链接与员工身份不匹配';
    }
    if (pathEmpId !== String(data.empId || '')) return '签署链接与员工身份不匹配';
    if (pathMonth && pathMonth !== String(data.month || '')) return '签署链接与考核月份不匹配';
  } else {
    if (pagePath.startsWith('/kpi-confirm-page/')) {
      let pathEmpId = '';
      let pathMonth = '';
      try {
        const decoded = Buffer.from(pagePath.slice('/kpi-confirm-page/'.length), 'base64').toString('utf8');
        [pathEmpId, pathMonth] = decoded.split('|');
      } catch (_) {
        return '签署链接与员工身份不匹配';
      }
      if (pathEmpId !== String(data.empId || '')) return '签署链接与员工身份不匹配';
      if (pathMonth !== String(data.month || '')) return '签署链接与考核月份不匹配';
      return '';
    }
    let pathName = '';
    if (pagePath.startsWith('/kpi-page-b64/')) {
      try { pathName = Buffer.from(pagePath.slice('/kpi-page-b64/'.length), 'base64').toString('utf8'); } catch (_) {}
    } else {
      try { pathName = decodeURIComponent(pagePath.slice('/kpi-page/'.length)); } catch (_) {}
    }
    if (!expectedEmployee || pathName !== String(expectedEmployee.name || '')) return '签署链接与员工身份不匹配';
  }
  return '';
}

function getSigningVerification(data, documentType) {
  cleanupSigningSessions();
  const token = String(data.verificationToken || '');
  const verification = signingVerifications.get(token);
  if (!token || !verification || verification.used || verification.expiresAt <= Date.now()) return { error: '身份验证已失效，请重新获取钉钉验证码' };
  if (verification.documentType !== documentType || verification.empId !== String(data.empId || '') ||
      verification.month !== String(data.month || '')) return { error: '身份验证与本次签署信息不匹配' };
  return { token, verification };
}

function signatureSealPayload(documentType, data, integrity) {
  return JSON.stringify({
    version: 1,
    documentType,
    // Identity repairs preserve the originally sealed employee ID in the HMAC
    // payload while the business record moves to its canonical roster ID.
    empId: String(data.identityMigration && data.identityMigration.originalEmpId || data.empId || ''),
    month: String(data.month || ''),
    realName: String(data.realName || ''),
    serverSignedAt: String(integrity.serverSignedAt || ''),
    originalDocumentHash: String(integrity.originalDocumentHash || ''),
    signatureImageHash: String(integrity.signatureImageHash || ''),
    verificationMethod: String(integrity.verificationMethod || '')
  });
}

function appendIntegrityStamp(html, data, integrity) {
  const block = '<section style="margin:24px auto 0;padding:14px 16px;max-width:760px;border:1px solid #cbd5e1;border-radius:10px;background:#f8fafc;color:#334155;font:12px/1.7 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">' +
    '<strong style="display:block;color:#0f172a">系统存证信息（防篡改校验）</strong>' +
    '签署人：' + escapeHtml(data.realName) + '<br>身份验证：本人钉钉一次性验证码<br>' +
    '服务器时间戳：' + escapeHtml(integrity.serverSignedAt) + '<br>签署IP：' + escapeHtml(data.signerContext.ipAddress) + '<br>' +
    '签署原文SHA-256：<span style="word-break:break-all">' + escapeHtml(integrity.originalDocumentHash) + '</span><br>' +
    '签名图像SHA-256：<span style="word-break:break-all">' + escapeHtml(integrity.signatureImageHash) + '</span><br>' +
    '服务端HMAC签章：<span style="word-break:break-all">' + escapeHtml(integrity.serverSeal) + '</span></section>';
  return String(html || '').includes('</body>') ? String(html).replace('</body>', block + '</body>') : String(html || '') + block;
}

function protectSignedDocument(documentType, data, verification, req, options = {}) {
  const serverSignedAt = new Date().toISOString();
  data.serverSignedAt = serverSignedAt;
  data.signedAt = serverSignedAt;
  data.identityVerification = {
    method: 'dingtalk-otp',
    verifiedAt: verification.verifiedAt,
    challengeId: verification.challengeId
  };
  data.signerContext = {
    ipAddress: requestIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 1000)
  };
  const integrity = {
    version: 1,
    algorithm: 'SHA-256 + HMAC-SHA256',
    originalDocumentHash: sha256(data.doc),
    signatureImageHash: sha256(data.sigData),
    finalDocumentHash: '',
    serverSeal: '',
    serverSignedAt,
    verificationMethod: 'dingtalk-otp'
  };
  integrity.serverSeal = hmacSha256(signatureSealPayload(documentType, data, integrity));
  data.doc = appendIntegrityStamp(data.doc, data, integrity);
  integrity.finalDocumentHash = sha256(data.doc);
  data.integrity = integrity;
  const audit = appendSignatureAudit(req, 'SIGNATURE_ACCEPTED', {
    documentType, empId: data.empId, name: data.name, realName: data.realName, month: data.month,
    details: {
      verificationMethod: integrity.verificationMethod,
      verifiedAt: verification.verifiedAt,
      originalDocumentHash: integrity.originalDocumentHash,
      finalDocumentHash: integrity.finalDocumentHash,
      signatureImageHash: integrity.signatureImageHash,
      serverSeal: integrity.serverSeal,
      signatureMetrics: data.signatureMetrics
    }
  });
  data.auditEventHash = audit.eventHash;
  if (options.archive !== false) {
    data.archiveFile = archiveSignedDocument(documentType, data, integrity, audit);
    data.archivedAt = serverSignedAt;
  } else {
    data.archiveFile = '';
    data.archivedAt = '';
    data.employeeSignedAt = serverSignedAt;
  }
  return { integrity, audit };
}

function verifyPendingSignedRecord(documentType, data) {
  if (!data || !data.doc || !data.integrity) return { valid: false, error: '没有可复核的员工签署文件' };
  const integrity = data.integrity;
  const checks = {
    documentHash: safeTextEqual(sha256(data.doc), integrity.finalDocumentHash),
    signatureImageHash: safeTextEqual(sha256(data.sigData), integrity.signatureImageHash),
    serverSeal: safeTextEqual(hmacSha256(signatureSealPayload(documentType, data, integrity)), integrity.serverSeal)
  };
  return { valid: Object.values(checks).every(Boolean), checks, error: Object.values(checks).every(Boolean) ? '' : '员工签署文件完整性校验失败' };
}

function appendBpArchiveStamp(html, record, reviewer, reviewedAt) {
  const block = '<section style="margin:18px auto 0;padding:14px 16px;max-width:760px;border:1px solid #86efac;border-radius:10px;background:#f0fdf4;color:#166534;font:12px/1.7 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">' +
    '<strong style="display:block;color:#14532d">BP复核归档信息</strong>复核结论：绩效结果核对无误<br>复核人：' + escapeHtml(reviewer) + '<br>复核时间：' + escapeHtml(reviewedAt) + '</section>';
  return String(html || '').includes('</body>') ? String(html).replace('</body>', block + '</body>') : String(html || '') + block;
}

function verifySignedRecord(documentType, data) {
  if (!data || !data.integrity) return { valid: false, error: '没有可验证的存证信息' };
  const integrity = data.integrity;
  const checks = {
    documentHash: safeTextEqual(sha256(data.doc), integrity.finalDocumentHash),
    signatureImageHash: safeTextEqual(sha256(data.sigData), integrity.signatureImageHash),
    serverSeal: safeTextEqual(hmacSha256(signatureSealPayload(documentType, data, integrity)), integrity.serverSeal),
    archiveHash: false
  };
  try {
    const archivePath = path.join(DATA_DIR, String(data.archiveFile || ''));
    checks.archiveHash = Boolean(data.archiveFile) && fs.existsSync(archivePath) &&
      safeTextEqual(sha256(fs.readFileSync(archivePath, 'utf8')), integrity.finalDocumentHash);
  } catch (_) {}
  return { valid: Object.values(checks).every(Boolean), checks, integrity, archiveFile: data.archiveFile || '' };
}

function generateStoredKpiConfirmationPage(page) {
  const templatePath = path.join(PAGES_DIR, 'KPI\u76ee\u6807\u786e\u8ba4_\u6851\u845a.html');
  const template = fs.readFileSync(templatePath, 'utf8');
  const emp = page.emp;
  const kpis = page.kpis || [];
  const month = page.month || '2026\u5e747\u6708';
  const monthShort = month.replace(/20/, '');
  const kpiRows = kpis.map(k => '<tr><td>' + escapeHtml(k.seq) + '</td><td>' + renderKpiIndicatorHtml(k) + '</td><td>' + renderKpiTargetHtml(k) + '</td><td>' + renderKpiSourceHtml(k) + '</td><td style="color:#1a73e8;font-weight:600">' + escapeHtml(k.weight) + '%</td></tr>').join('\n');
  const employeeLabel = escapeHtml(emp.name) + '\uff08' + escapeHtml(emp.realName) + '\uff09';
  const departmentLabel = escapeHtml(emp.dept) + ' \u00b7 ' + escapeHtml(emp.position);
  let html = template;
  html = html.replace(/<title>KPI\u76ee\u6807\u786e\u8ba4[^<]*<\/title>/, '<title>KPI\u76ee\u6807\u786e\u8ba4 - ' + escapeHtml(emp.name) + '</title>');
  html = html.replace(/<title>KPI\u76ee\u6807\u786e\u8ba4\u4e66 - [^<]*<\/title>/g, '<title>KPI\u76ee\u6807\u786e\u8ba4\u4e66 - ' + escapeHtml(emp.name) + ' - ' + escapeHtml(month) + '</title>');
  html = html.replace(/<div class="name">[^<]+<\/div>/, '<div class="name">' + employeeLabel + '</div>');
  html = html.replace(/<div class="dept">[^<]+<\/div>/, '<div class="dept">' + departmentLabel + '</div>');
  html = html.replace(/(<div style="font-weight:500">)[^<]+(<\/div>)/, '$1' + escapeHtml(emp.directMgr) + '$2');
  html = html.replace(/<strong>[^<]*\uff08[^<]*\uff09<\/strong>/g, '<strong>' + employeeLabel + '</strong>');
  html = html.replace(/(<span style="color:#666;font-size:13px">)[^<]+(<\/span>)/g, '$1' + departmentLabel + '$2');
  html = html.replace(/(<span style="font-size:12px;color:#999">\u76f4\u5c5e\u4e0a\u7ea7<\/span><br><strong>)[^<]+(<\/strong>)/g, '$1' + escapeHtml(emp.directMgr) + '$2');
  html = html.replace(/(<\/thead>)[\s\S]*?(<tfoot>)/g, '$1\n<tbody>\n' + kpiRows + '\n</tbody>\n$2');
  html = html.replace(/\u5df2\u9605\u8bfb\u5e76\u77e5\u6089\u4ee5\u4e0a\d+\u5e74\d+\u6708/, '\u5df2\u9605\u8bfb\u5e76\u77e5\u6089\u4ee5\u4e0a' + monthShort);
  html = html.replace(/(<h1>)\d+\u5e74\d+\u6708(KPI\u76ee\u6807\u786e\u8ba4\u4e66<\/h1>)/g, '$1' + monthShort + '$2');
  html = html.replace(/(\u676d\u5dde\u98de\u9014\u884c\u8fdc \u00b7 )\d+\u5e74\d+\u6708/g, '$1' + month);
  html = html.replace(/const EMP_META = \{[^}]+\};/, 'const EMP_META = ' + JSON.stringify({
    empId: page.empId || '', name: emp.name, realName: emp.realName,
    dept: emp.dept, position: emp.position, month
  }) + ';');
  html = html.replace(/fetch\(['"]\/submit-kpi['"]/, 'fetch(' + JSON.stringify(PUBLIC_SERVER_URL + '/submit-kpi'));
  const outputPath = path.join(GENERATED_DIR, 'KPI\u76ee\u6807\u786e\u8ba4_' + emp.name + '.html');
  fs.writeFileSync(outputPath, html, 'utf8');
  return outputPath;
}

function refreshStoredKpiPage(name) {
  const matches = Object.entries(kpiTargets).filter(([, target]) => target && target.emp && target.emp.name === name);
  if (!matches.length) return '';
  const [key, target] = matches[matches.length - 1];
  return generateStoredKpiConfirmationPage({
    empId: key.split('|')[0], emp: target.emp, kpis: target.kpis, month: target.month,
    targetAdjustments: target.targetAdjustments
  });
}

const ADMIN_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const ADMIN_LOGIN_FAILURES = new Map();
let adminDingTalkTokenCache = { value: '', expiresAt: 0 };

async function getAdminDingTalkAccessToken() {
  if (adminDingTalkTokenCache.value && adminDingTalkTokenCache.expiresAt > Date.now() + 60 * 1000) {
    return adminDingTalkTokenCache.value;
  }
  if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET) throw new Error('DingTalk application credentials are unavailable');
  const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: DINGTALK_APP_KEY, appSecret: DINGTALK_APP_SECRET })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.accessToken) throw new Error(data.message || data.code || 'Failed to obtain DingTalk access token');
  adminDingTalkTokenCache = {
    value: data.accessToken,
    expiresAt: Date.now() + Number(data.expireIn || 7200) * 1000
  };
  return adminDingTalkTokenCache.value;
}

async function exchangeAdminDingTalkAuthCode(code) {
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) throw new Error('Missing DingTalk auth code');
  const accessToken = await getAdminDingTalkAccessToken();
  const response = await fetch('https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=' + encodeURIComponent(accessToken), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: normalizedCode })
  });
  const data = await response.json().catch(() => ({}));
  const result = data.result || {};
  if (!response.ok || Number(data.errcode || 0) !== 0 || !result.userid) {
    throw new Error(data.errmsg || data.message || data.code || 'Failed to verify DingTalk login identity');
  }
  return { userId: String(result.userid), unionId: String(result.unionid || '') };
}

function timingSafeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function employeeNameForUserId(userId) {
  userId = String(userId || '').trim();
  if (!userId) return '';
  const rosterMatch = Array.isArray(assessmentRoster)
    ? assessmentRoster.find(employee => employee && String(employee.userId || '').trim() === userId)
    : null;
  if (rosterMatch && rosterMatch.name) return String(rosterMatch.name).trim();
  const builtIn = Object.entries(EMPLOYEE_ROSTER || {}).find(([, identity]) => String(identity && identity.userId || '').trim() === userId);
  return builtIn ? builtIn[0] : '';
}

function createAdminSession(profile) {
  profile = profile && profile.authorized ? profile : accessProfileForName('系统管理员');
  const payload = Buffer.from(JSON.stringify({
    version: ADMIN_SESSION_VERSION,
    username: ADMIN_USERNAME,
    name: profile.name,
    role: profile.role,
    global: Boolean(profile.global),
    departments: Array.isArray(profile.departments) ? profile.departments : [],
    canManageOrganization: Boolean(profile.canManageOrganization),
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function adminSessionCookie(token, maxAgeMs) {
  const lifetime = Number.isFinite(maxAgeMs) ? Math.max(0, maxAgeMs) : ADMIN_SESSION_TTL_MS;
  const expires = new Date(Date.now() + lifetime).toUTCString();
  return 'perf_admin_session=' + encodeURIComponent(token || '') + '; Path=/; Max-Age=' + Math.floor(lifetime / 1000) +
    '; Expires=' + expires + '; HttpOnly; Secure; SameSite=Lax; Priority=High';
}

function readCookie(req, name) {
  const cookieHeader = String(req.headers.cookie || '');
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return '';
}

function readAdminSession(req) {
  const token = readCookie(req, 'perf_admin_session');
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expectedSignature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  if (!timingSafeTextEqual(suppliedSignature, expectedSignature)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (session.version !== ADMIN_SESSION_VERSION || Number(session.expiresAt) <= Date.now()) return null;
    // Changing the administrator login must revoke the old administrator
    // cookie without forcing every department owner to sign in again.
    if (session.name === '系统管理员' && session.username !== ADMIN_USERNAME) return null;
    const configured = accessProfileForName(session.name);
    if (!configured.authorized) return null;
    return configured;
  } catch (_) {
    return null;
  }
}

function hasValidAdminSession(req) {
  return Boolean(readAdminSession(req));
}

function safeNextPath(value) {
  const next = String(value || '/');
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function renderAdminLogin(errorMessage, nextPath) {
  const error = errorMessage ? '<div class="error" role="alert">' + escapeHtml(errorMessage) + '</div>' : '';
  // Password-first login is deliberate: DingTalk must not bypass the first
  // credential check. Persistent sessions provide automatic later visits.
  const dingTalkBootstrap = false && DINGTALK_CORP_ID ? `<script src="https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.12/dingtalk.open.js"></script><script>
  (() => {
    if (!/DingTalk/i.test(navigator.userAgent)) return;
    const corpId = ${JSON.stringify(DINGTALK_CORP_ID)};
    const nextPath = ${JSON.stringify(safeNextPath(nextPath))};
    const status = document.querySelector('.sub');
    const codeInput = document.getElementById('dingTalkAuthCode');
    const requestCode = () => {
      if (!window.dd || !dd.runtime || !dd.runtime.permission || !dd.runtime.permission.requestAuthCode) {
        status.textContent = '钉钉免密组件未就绪，可使用账号密码登录';
        return;
      }
      status.textContent = '正在验证钉钉登录状态…';
      dd.runtime.permission.requestAuthCode({
        corpId,
        onSuccess: async result => {
          const code = result && result.code ? String(result.code) : '';
          codeInput.value = code;
          if (!code) { status.textContent = '未取得钉钉身份，请使用账号密码登录'; return; }
          try {
            const response = await fetch('/dingtalk-admin-login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code, next: nextPath })
            });
            const data = await response.json().catch(() => ({}));
            if (response.ok && data.success) {
              status.textContent = '钉钉身份验证成功，正在进入系统…';
              location.replace(data.next || nextPath);
              return;
            }
            status.textContent = data.bindingRequired
              ? '请再输入一次账号密码完成钉钉账号绑定，以后将自动登录'
              : '钉钉免密验证未通过，可使用账号密码登录';
          } catch (_) {
            status.textContent = '钉钉免密验证暂不可用，可使用账号密码登录';
          }
        },
        onFail: () => { status.textContent = '未取得钉钉身份，可使用账号密码登录'; }
      });
    };
    if (window.dd && typeof dd.ready === 'function') dd.ready(requestCode); else requestCode();
  })();
  </script>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>绩效管理系统登录</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f5ef;color:#17201d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:20px}.panel{width:min(430px,100%);background:#fff;border:1px solid #dfe5dc;border-radius:20px;padding:34px;box-shadow:0 20px 55px rgba(31,61,51,.12)}.mark{width:44px;height:44px;border-radius:13px;background:#155f54;color:#fff;display:grid;place-items:center;font-size:22px;margin-bottom:22px}h1{margin:0 0 8px;font-size:25px}.sub{color:#748079;font-size:14px;margin-bottom:26px}.field{margin:16px 0}label{display:block;font-size:13px;font-weight:650;margin-bottom:7px}input{width:100%;height:46px;border:1px solid #ced7d1;border-radius:10px;padding:0 13px;font-size:16px;outline:none}input:focus{border-color:#155f54;box-shadow:0 0 0 3px rgba(21,95,84,.12)}button{width:100%;height:46px;border:0;border-radius:10px;background:#155f54;color:#fff;font-size:15px;font-weight:700;margin-top:8px}.error{background:#fff1f0;border:1px solid #ffccc7;color:#b42318;padding:10px 12px;border-radius:9px;font-size:13px;margin-bottom:14px}.safe{margin-top:18px;color:#89938d;font-size:12px;text-align:center}</style></head><body><main class="panel"><div class="mark">🏆</div><h1>绩效管理系统</h1><div class="sub">管理员填写管理员账号；部门负责人填写本人花名</div>${error}<form method="post" action="/admin-login"><input type="hidden" name="next" value="${escapeHtml(safeNextPath(nextPath))}"><div class="field"><label for="username">账号</label><input id="username" name="username" autocomplete="username" required autofocus></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><button type="submit">安全登录</button></form><div class="safe">首次登录后将保持登录状态，后续进入系统和查看归档无需重复输入</div></main>${dingTalkBootstrap}</body></html>`;
}

function injectDingTalkAdminBinding(html) {
  if (!DINGTALK_CORP_ID || !String(html || '').includes('</body>')) return html;
  const script = `<script src="https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.12/dingtalk.open.js"></script><script>
  (() => {
    if (!/DingTalk/i.test(navigator.userAgent)) return;
    const requestCode = () => {
      if (!window.dd || !dd.runtime || !dd.runtime.permission || !dd.runtime.permission.requestAuthCode) return;
      dd.runtime.permission.requestAuthCode({
        corpId: ${JSON.stringify(DINGTALK_CORP_ID)},
        onSuccess: result => {
          const code = result && result.code ? String(result.code) : '';
          if (!code) return;
          fetch('/admin-dingtalk-bind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
          }).catch(() => {});
        },
        onFail: () => {}
      });
    };
    if (window.dd && typeof dd.ready === 'function') dd.ready(requestCode); else requestCode();
  })();
  </script>`;
  const source = String(html);
  // The dashboard contains signed-document HTML templates with their own
  // literal </body> text inside the main JavaScript block. Injecting at the
  // first match terminates that script early and renders the remaining source
  // code in the page. Only the final document closing tag is safe.
  const closingBodyIndex = source.toLowerCase().lastIndexOf('</body>');
  if (closingBodyIndex < 0) return source;
  return source.slice(0, closingBodyIndex) + script + source.slice(closingBodyIndex);
}

function injectBeforeFinalBody(html, markup) {
  const source = String(html || '');
  const closingBodyIndex = source.toLowerCase().lastIndexOf('</body>');
  if (closingBodyIndex < 0) return source + String(markup || '');
  return source.slice(0, closingBodyIndex) + String(markup || '') + source.slice(closingBodyIndex);
}

function assertDashboardShellIntegrity(html) {
  const source = String(html || '');
  const mainScriptStart = source.indexOf('<script>');
  const syncModalStart = source.indexOf('function renderSyncModal()');
  const mainScriptClose = source.indexOf('</script>', mainScriptStart);
  const versionWatcherStart = source.indexOf("fetch('/ui-version'");
  if (mainScriptStart < 0 || syncModalStart < 0 || mainScriptClose < syncModalStart) {
    throw new Error('dashboard integrity failed: main application script is truncated');
  }
  const bodyOpenBeforeMain = (source.slice(0, mainScriptStart).match(/<body\b/gi) || []).length;
  const bodyCloseInsideMain = (source.slice(mainScriptStart, mainScriptClose).match(/<\/body>/gi) || []).length;
  const bodyCloseAfterMain = (source.slice(mainScriptClose).match(/<\/body>/gi) || []).length;
  if (bodyOpenBeforeMain !== 1 || bodyCloseInsideMain !== 0 || bodyCloseAfterMain !== 1) {
    throw new Error(`dashboard integrity failed: invalid body boundary ${bodyOpenBeforeMain}/${bodyCloseInsideMain}/${bodyCloseAfterMain}`);
  }
  if (versionWatcherStart < mainScriptClose) {
    throw new Error('dashboard integrity failed: runtime watcher was injected inside the application script');
  }
  return source;
}

function dashboardEmployeeIdentities() {
  const identities = {};
  const add = (empId, source) => {
    empId = String(empId || '').trim();
    source = source && source.emp ? source.emp : source;
    if (!empId || !source) return;
    const previous = identities[empId] || {};
    const next = { ...previous };
    const fields = {
      name: source.name || source.nick,
      realName: source.realName,
      dept: source.dept || source.department,
      position: source.position || source.title,
      directMgr: source.directMgr,
      hrbp: source.hrbp
    };
    for (const [field, value] of Object.entries(fields)) {
      const normalized = String(value || '').trim();
      if (normalized) next[field] = normalized;
    }
    next.hrbp = organizationHrbpFor(next.name, next.dept, next.hrbp);
    identities[empId] = next;
  };
  if (Array.isArray(assessmentRoster)) assessmentRoster.forEach(employee => add(employee && employee.id, employee));
  for (const collection of [evalData, mgrData, bpData, kpiData, kpiTargets, kpiTargetDrafts]) {
    for (const [key, record] of Object.entries(collection || {})) {
      add(record && record.empId || String(key).split('|')[0], record);
    }
  }
  return identities;
}

function normalizedIdentityDepartment(identity) {
  identity = identity || {};
  const name = String(identity.name || identity.nick || '').trim();
  const override = employeeOverrides[name] || {};
  return organizationDepartmentFor(name, override.department || identity.dept || identity.department || '');
}

function canManageMonthlyEvents(profile) {
  return Boolean(profile && profile.authorized && String(profile.name || '').trim() === '系统管理员');
}

function monthlyEventsForProfile(profile, month) {
  return Object.values(monthlyEvents || {})
    .filter(event => event && (!month || String(event.month || '') === String(month)) && canAccessDepartment(profile, event.department))
    .sort((left, right) => String(left.date || '').localeCompare(String(right.date || '')) || String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

function normalizeMonthlyEventInput(data) {
  const month = String(data.month || '').trim();
  const monthMatch = month.match(/^(\d{4})年(\d{1,2})月$/);
  if (!monthMatch || Number(monthMatch[1]) * 12 + Number(monthMatch[2]) - 1 < 2026 * 12 + 8) throw new Error('事件月份无效');
  const date = String(data.date || '').trim();
  const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const expectedPrefix = monthMatch[1] + '-' + String(Number(monthMatch[2])).padStart(2, '0') + '-';
  if (!dateMatch || !date.startsWith(expectedPrefix)) throw new Error('事件日期必须属于所选月份');
  const parsedDate = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.getUTCFullYear() !== Number(dateMatch[1]) || parsedDate.getUTCMonth() + 1 !== Number(dateMatch[2]) || parsedDate.getUTCDate() !== Number(dateMatch[3])) throw new Error('事件日期无效');
  const empId = String(data.empId || '').trim();
  const identity = dashboardEmployeeIdentities()[empId];
  if (!identity) throw new Error('请选择有效员工');
  const department = normalizedIdentityDepartment(identity);
  if (!department) throw new Error('员工部门信息缺失');
  const summary = String(data.summary || '').trim();
  const details = String(data.details || '').trim();
  if (!summary || summary.length > 200) throw new Error('事件概述须填写且不超过200字');
  if (!details || details.length > 5000) throw new Error('具体说明须填写且不超过5000字');
  const sourceImages = Array.isArray(data.images) ? data.images : [];
  if (sourceImages.length > 5) throw new Error('每条事件最多上传5张图片');
  let totalImageBytes = 0;
  const images = sourceImages.map((image, index) => {
    const dataUrl = String(image && image.dataUrl || '').trim();
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl)) throw new Error('第' + (index + 1) + '张图片格式无效');
    const estimatedBytes = Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4);
    if (estimatedBytes > 2 * 1024 * 1024) throw new Error('单张图片不能超过2MB');
    totalImageBytes += estimatedBytes;
    return { name: String(image && image.name || '事件图片' + (index + 1)).slice(0, 120), dataUrl };
  });
  if (totalImageBytes > 8 * 1024 * 1024) throw new Error('每条事件图片合计不能超过8MB');
  return {
    month, empId, department,
    name: String(identity.name || identity.nick || '').trim(),
    realName: String(identity.realName || '').trim(),
    date, summary, details, images
  };
}

function saveMonthlyEvents() {
  const temporary = MONTHLY_EVENTS_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(monthlyEvents, null, 2), { encoding: 'utf8', mode: 0o640 });
  fs.renameSync(temporary, MONTHLY_EVENTS_FILE);
}

function employeeIdentityForEmpId(empId, record) {
  empId = String(empId || '').trim();
  const source = record && record.emp ? record.emp : record;
  const identities = dashboardEmployeeIdentities();
  const canonical = identities[empId];
  // Persisted canonical identity always wins over request-provided metadata;
  // otherwise a caller could spoof an authorized department in the payload.
  return canonical ? { ...(source || {}), ...canonical, id: empId } : { ...(source || {}), id: empId };
}

function authoritativeWorkflowEmployee(empId, employee) {
  employee = employee && employee.emp ? employee.emp : (employee || {});
  const identity = employeeIdentityForEmpId(empId, employee);
  const name = String(identity.name || identity.nick || employee.name || employee.nick || '').trim();
  const override = employeeOverrides[name] || {};
  const department = organizationDepartmentFor(name, override.department || identity.dept || identity.department || employee.dept || employee.department || '');
  return {
    ...employee,
    ...identity,
    name,
    realName: String(identity.realName || employee.realName || '').trim(),
    dept: department,
    position: String(identity.position || identity.title || employee.position || employee.title || '').trim(),
    directMgr: String(override.directMgr || identity.directMgr || employee.directMgr || '').trim(),
    hrbp: organizationHrbpFor(name, department, override.hrbp || identity.hrbp || employee.hrbp)
  };
}

function canAccessEmployee(profile, empId, record) {
  if (!profile || !profile.authorized) return false;
  if (profile.global) return true;
  return canAccessDepartment(profile, normalizedIdentityDepartment(employeeIdentityForEmpId(empId, record)));
}

function filterAssessmentMapForProfile(collection, profile) {
  if (profile && profile.global) return collection || {};
  return Object.fromEntries(Object.entries(collection || {}).filter(([key, record]) => {
    const empId = String(record && record.empId || String(key).split('|')[0] || '').trim();
    return canAccessEmployee(profile, empId, record);
  }));
}

// Dashboard lists need archive existence and workflow metadata, not the full
// signed HTML or handwriting image. Keep the original endpoints compatible,
// while allowing the dashboard to request a small projection for fast sync.
function signedAssessmentSummary(record) {
  if (!record || typeof record !== 'object') return record;
  return {
    empId: record.empId,
    name: record.name,
    realName: record.realName,
    dept: record.dept,
    position: record.position,
    month: record.month,
    signedAt: record.signedAt,
    serverSignedAt: record.serverSignedAt,
    archivedAt: record.archivedAt,
    archiveFile: record.archiveFile,
    signatureValidated: record.signatureValidated,
    sealed: record.sealed,
    sealedAt: record.sealedAt,
    bpReviewStatus: record.bpReviewStatus,
    bpReviewer: record.bpReviewer,
    bpReviewedBy: record.bpReviewedBy,
    bpReviewedAt: record.bpReviewedAt,
    employeeSignedAt: record.employeeSignedAt,
    integrity: record.integrity,
    identityVerification: record.identityVerification,
    auditEventHash: record.auditEventHash,
    signerContext: record.signerContext,
    doc: Boolean(record.doc)
  };
}

function summarizeAssessmentMap(collection) {
  return Object.fromEntries(Object.entries(collection || {}).map(([key, record]) => [key, signedAssessmentSummary(record)]));
}

function requireEmployeeAccess(req, res, empId, record) {
  const profile = req.accessProfile || readAdminSession(req);
  if (canAccessEmployee(profile, empId, record)) return true;
  console.warn('[access-denied]', profile && profile.name || 'unknown', empId, req.method, req.url);
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: '无权访问该员工所属部门的数据' }));
  return false;
}

function requireGlobalAccess(req, res) {
  const profile = req.accessProfile || readAdminSession(req);
  if (profile && profile.global) return true;
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: '仅全局管理员可执行此操作' }));
  return false;
}

function dashboardAccessContext(profile) {
  profile = profile && profile.authorized ? profile : accessProfileForName('系统管理员');
  return {
    name: profile.name,
    role: profile.role,
    global: Boolean(profile.global),
    departments: profile.global ? [] : [...profile.departments],
    canManageOrganization: Boolean(profile.canManageOrganization),
    canAuthorTargets: Boolean(profile.global),
    canInitiateTargetAdjustment: canInitiateTargetAdjustment(profile),
    canManageMonthlyEvents: canManageMonthlyEvents(profile),
    canViewOperationLogs: canViewOperationLogs(profile),
    canManageManagerStage: Boolean(profile.authorized),
    canManageTargetBpStage: Boolean(profile.global),
    canManageResultBpStage: canPerformBpResultInBackend(profile)
  };
}

function buildDashboardHtml(profile) {
  profile = profile && profile.authorized ? profile : accessProfileForName('系统管理员');
  let html = fs.readFileSync(path.join(PAGES_DIR, 'preview.html'), 'utf8');
  html = html.replace(/const SYNC_SERVER_URL\s*=\s*[^;]+;/, 'const SYNC_SERVER_URL = window.location.origin;');
  html = html.replace(/const PUBLIC_NOTIFICATION_URL\s*=\s*[^;]+;/, 'const PUBLIC_NOTIFICATION_URL = window.location.origin;');
  const allIdentities = dashboardEmployeeIdentities();
  const permittedIdentities = Object.fromEntries(Object.entries(allIdentities).filter(([empId, identity]) => canAccessEmployee(profile, empId, identity)));
  const identitiesJson = JSON.stringify(permittedIdentities).replace(/</g, '\\u003c');
  html = html.replace('const SERVER_EMPLOYEE_IDENTITIES = {};', 'const SERVER_EMPLOYEE_IDENTITIES = ' + identitiesJson + ';');
  const employeeSeed = Object.entries(permittedIdentities).map(([id, identity]) => {
    const name = String(identity.name || '').trim();
    const override = employeeOverrides[name] || {};
    return {
      id,
      name,
      realName: String(identity.realName || '').trim(),
      dept: normalizedIdentityDepartment(identity),
      position: String(identity.position || '').trim(),
      directMgr: String(override.directMgr || identity.directMgr || '').trim(),
      indirectMgr: '',
      hrbp: organizationHrbpFor(name, normalizedIdentityDepartment(identity), identity.hrbp),
      status: '在职'
    };
  }).filter(employee => employee.name && employee.dept);
  html = html.replace(/const EMPLOYEES = \[[\s\S]*?\n    \];\n\n    const KPIS = \[/,
    'const EMPLOYEES = ' + JSON.stringify(employeeSeed).replace(/</g, '\\u003c') + ';\n\n    const KPIS = [');
  html = html.replace('const ACCESS_CONTEXT = { name: "系统管理员", role: "全局管理员", global: true, departments: [], canManageOrganization: true, canAuthorTargets: true, canInitiateTargetAdjustment: false, canManageMonthlyEvents: true, canViewOperationLogs: false, canManageManagerStage: true, canManageTargetBpStage: true, canManageResultBpStage: true };',
    'const ACCESS_CONTEXT = ' + JSON.stringify(dashboardAccessContext(profile)).replace(/</g, '\\u003c') + ';');
  const versionWatcher = `<script>(()=>{const current=${JSON.stringify(DASHBOARD_BUILD_ID)};let reloading=false;async function check(){if(reloading)return;try{const r=await fetch('/ui-version',{cache:'no-store'});const d=await r.json();if(d.version&&d.version!==current){reloading=true;location.reload();}}catch(_){}}setInterval(check,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});window.addEventListener('focus',check);})();</script>`;
  html = injectBeforeFinalBody(html, versionWatcher);
  html = injectDingTalkAdminBinding(html);
  return assertDashboardShellIntegrity(html);
}

function requireAdmin(req, res, pathname) {
  if (!ADMIN_PASSWORD) {
    req.accessProfile = accessProfileForName('系统管理员');
    return true;
  }
  const header = req.headers.authorization || '';
  let credentials = '';
  if (header.startsWith('Basic ')) {
    try { credentials = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch (_) {}
  }
  const sessionProfile = readAdminSession(req);
  const basicAuthenticated = timingSafeTextEqual(credentials, ADMIN_USERNAME + ':' + ADMIN_PASSWORD);
  if (basicAuthenticated || sessionProfile) {
    const profile = sessionProfile || accessProfileForName('系统管理员');
    req.accessProfile = profile;
    // Sliding renewal plus Expires improves persistence in older DingTalk WebViews.
    res.setHeader('Set-Cookie', adminSessionCookie(createAdminSession(profile)));
    return true;
  }
  const acceptsHtml = req.method === 'GET' && /text\/html/i.test(String(req.headers.accept || ''));
  if (acceptsHtml) {
    res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(safeNextPath(req.url || pathname || '/')), 'Cache-Control': 'no-store' });
    res.end();
    return false;
  }
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: '管理员登录已失效', loginUrl: '/login' }));
  return false;
}

function isAdminRoute(method, pathname) {
  if (method === 'GET') {
    return pathname === '/' || pathname === '/preview.html' || pathname === '/data' ||
      pathname.startsWith('/data/') || pathname === '/mgr-data' || pathname === '/bp-data' ||
      pathname === '/kpi-data' || pathname === '/kpi-targets' || pathname === '/target-drafts' || pathname === '/result-data' || pathname === '/queue' ||
      pathname === '/ping' || pathname === '/delivery-status' || pathname === '/pending-count' || pathname === '/workflow-events' ||
      pathname === '/signature-audit' || pathname === '/verify-signature-integrity' ||
      pathname === '/operation-logs' ||
      pathname === '/workflow-resets' || pathname === '/oa-approval-status' || pathname === '/monthly-events' ||
      pathname === '/employee-roster' || pathname === '/employee-overrides' || pathname === '/performance-exclusions' ||
      pathname === '/archive-view' || pathname.startsWith('/lookup-user/') ||
      pathname.startsWith('/admin-target-manager-page/') || pathname.startsWith('/admin-target-bp-page/') ||
      pathname.startsWith('/admin-manager-page/') || pathname.startsWith('/admin-bp-page/') ||
      pathname === '/okr-admin' || pathname === '/okr-data' || pathname === '/okr-archive-view' || pathname.startsWith('/okr-admin-open/');
  }
  return method === 'POST' && (pathname === '/generate-kpi-pages' || pathname === '/invite-target-draft' || pathname === '/request-target-adjustment' || pathname === '/withdraw-target-invitation' || pathname === '/workflow-reminder' || pathname === '/send-bot-msg' ||
    pathname === '/send-bot-batch' || pathname === '/employee-overrides' || pathname === '/performance-exclusions' ||
      pathname === '/workflow-resets' || pathname === '/oa-approval-retry' || pathname === '/monthly-events' ||
    pathname === '/reject-signature' || pathname === '/admin-dingtalk-bind' ||
    pathname === '/okr-invite' || pathname === '/okr-remind' || pathname === '/okr-send-self-review');
}

const okrModule = createOkrModule({
  dataDir: DATA_DIR,
  publicServerUrl: PUBLIC_SERVER_URL,
  workflowActionToken,
  isValidWorkflowAction,
  publicLink,
  signPath,
  isValidPublicToken,
  sendSigningOtpNow,
  enqueueBotMessage,
  findUserId,
  readBody,
  canAccessEmployee
});

const WORKFLOW_EVENT_FILES = new Set([
  path.basename(KPI_TARGET_DRAFTS_FILE), path.basename(KPI_TARGETS_FILE), path.basename(KPI_DATA_FILE),
  path.basename(DATA_FILE), path.basename(MGR_DATA_FILE), path.basename(BP_DATA_FILE), path.basename(RESULT_DATA_FILE),
  path.basename(WORKFLOW_RESETS_FILE), path.basename(PERFORMANCE_EXCLUSIONS_FILE), path.basename(ROSTER_FILE),
  path.basename(MONTHLY_EVENTS_FILE), 'okr_workflows.json'
]);
const workflowEventClients = new Set();
let workflowEventRevision = Date.now();
let workflowEventWatcher = null;
let workflowEventDebounceTimer = null;
let pendingWorkflowEventFiles = new Set();

function publishWorkflowChange(fileNames) {
  workflowEventRevision += 1;
  const payload = JSON.stringify({
    revision: workflowEventRevision,
    files: [...new Set(Array.isArray(fileNames) ? fileNames : [fileNames])].filter(Boolean),
    changedAt: new Date().toISOString()
  });
  for (const client of [...workflowEventClients]) {
    try { client.write('event: workflow-change\ndata: ' + payload + '\n\n'); }
    catch (_) { workflowEventClients.delete(client); }
  }
}

function startWorkflowEventWatcher() {
  if (workflowEventWatcher) return;
  try {
    workflowEventWatcher = fs.watch(DATA_DIR, { persistent: false }, (_eventType, fileName) => {
      const normalized = String(fileName || '');
      if (!WORKFLOW_EVENT_FILES.has(normalized)) return;
      pendingWorkflowEventFiles.add(normalized);
      if (workflowEventDebounceTimer) clearTimeout(workflowEventDebounceTimer);
      workflowEventDebounceTimer = setTimeout(() => {
        const changedFiles = [...pendingWorkflowEventFiles];
        pendingWorkflowEventFiles = new Set();
        workflowEventDebounceTimer = null;
        publishWorkflowChange(changedFiles);
      }, 40);
      workflowEventDebounceTimer.unref();
    });
  } catch (error) {
    console.warn('[workflow-events] File watcher unavailable; dashboard polling remains active:', error.message);
  }
}

const server = http.createServer(async (req, res) => {
  const requestPath = (req.url || '/').split('?')[0];
  console.log('[req]', req.method, requestPath);
  if (shouldAuditOperation(req.method, requestPath)) {
    res.once('finish', () => appendOperationAudit(req, res, requestPath));
  }
  const requestOrigin = String(req.headers.origin || '');
  let configuredOrigin = '';
  try { configuredOrigin = new URL(PUBLIC_SERVER_URL).origin; } catch (_) {}
  if (requestOrigin === 'null' || requestOrigin === configuredOrigin) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  const pathname = requestPath;
  if (req.method === 'GET' && pathname === '/login') {
    const next = safeNextPath(new URL(req.url, 'http://localhost').searchParams.get('next') || '/');
    if (hasValidAdminSession(req)) {
      const profile = readAdminSession(req);
      res.writeHead(302, { Location: next, 'Set-Cookie': adminSessionCookie(createAdminSession(profile)) });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderAdminLogin('', next));
    return;
  }
  if (req.method === 'POST' && pathname === '/dingtalk-admin-login') {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ success: false, error: '首次进入系统必须使用账号密码登录' }));
    return;
  }
  if (req.method === 'POST' && pathname === '/admin-login') {
    const remoteAddress = requestIp(req);
    const failure = ADMIN_LOGIN_FAILURES.get(remoteAddress) || { count: 0, blockedUntil: 0 };
    const form = new URLSearchParams(await readBody(req));
    const next = safeNextPath(form.get('next') || '/');
    if (failure.blockedUntil > Date.now()) {
      res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderAdminLogin('登录尝试过多，请稍后再试', next));
      return;
    }
    const requestedUsername = String(form.get('username') || '').trim();
    const loginProfile = timingSafeTextEqual(requestedUsername, ADMIN_USERNAME)
      ? accessProfileForName('系统管理员')
      : accessProfileForName(requestedUsername);
    const usernameOk = Boolean(loginProfile.authorized);
    const passwordOk = timingSafeTextEqual(form.get('password'), ADMIN_PASSWORD);
    if (usernameOk && passwordOk) {
      req.accessProfile = loginProfile;
      ADMIN_LOGIN_FAILURES.delete(remoteAddress);
      const dingTalkAuthCode = String(form.get('dingTalkAuthCode') || '').trim();
      if (dingTalkAuthCode && !adminDingTalkBinding.userId) {
        try {
          const identity = await exchangeAdminDingTalkAuthCode(dingTalkAuthCode);
          saveAdminDingTalkBinding(identity, req);
          console.log('[admin-sso] Administrator DingTalk identity bound successfully');
        } catch (error) {
          console.error('[admin-sso] Initial DingTalk binding failed:', error.message);
        }
      }
      res.writeHead(303, {
        Location: next,
        'Set-Cookie': adminSessionCookie(createAdminSession(loginProfile)),
        'Cache-Control': 'no-store'
      });
      res.end();
      return;
    }
    failure.count += 1;
    if (failure.count >= 5) failure.blockedUntil = Date.now() + 5 * 60 * 1000;
    ADMIN_LOGIN_FAILURES.set(remoteAddress, failure);
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderAdminLogin('账号或密码错误', next));
    return;
  }
  if (req.method === 'GET' && pathname === '/admin-logout') {
    res.writeHead(303, {
      Location: '/login',
      'Set-Cookie': adminSessionCookie('', 0),
      'Cache-Control': 'no-store'
    });
    res.end();
    return;
  }
  if (isAdminRoute(req.method, pathname) && !requireAdmin(req, res, pathname)) return;

  if (req.method === 'GET' && pathname === '/operation-logs') {
    if (!canViewOperationLogs(req.accessProfile)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '仅桑葚、薏米、路得、Ben四名管理员可以查看操作日志' }));
      return;
    }
    const limit = new URL(req.url, 'http://localhost').searchParams.get('limit');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(JSON.stringify({ logs: readOperationAuditEntries(limit), appendOnly: true }));
    return;
  }

  if (req.method === 'GET' && pathname === '/workflow-events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('event: ready\ndata: ' + JSON.stringify({ revision: workflowEventRevision }) + '\n\n');
    workflowEventClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); workflowEventClients.delete(res); }
    }, 25000);
    heartbeat.unref();
    req.on('close', () => { clearInterval(heartbeat); workflowEventClients.delete(res); });
    return;
  }

  if (await okrModule.handle(req, res, pathname)) return;

  if (req.method === 'GET' && pathname === '/monthly-events') {
    const month = String(new URL(req.url, 'http://localhost').searchParams.get('month') || '').trim();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(JSON.stringify({ events: monthlyEventsForProfile(req.accessProfile, month), canEdit: canManageMonthlyEvents(req.accessProfile) }));
    return;
  }

  if (req.method === 'POST' && pathname === '/monthly-events') {
    if (!canManageMonthlyEvents(req.accessProfile)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '仅系统管理员可以填写或修改每月事件' }));
      return;
    }
    try {
      const data = JSON.parse(await readBody(req));
      if (String(data.action || '') === 'delete') {
        const id = String(data.id || '').trim();
        if (!id || !monthlyEvents[id]) throw new Error('未找到要删除的每月事件');
        const deleting = monthlyEvents[id];
        const month = String(deleting.month || '');
        req._operationAuditContext = {
          category: '每月事件', action: '删除每月事件',
          target: [deleting.name, deleting.realName, deleting.month, deleting.summary].filter(Boolean).join(' · '),
          details: { before: monthlyEventAuditSnapshot(deleting) }
        };
        delete monthlyEvents[id];
        saveMonthlyEvents();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: true, events: monthlyEventsForProfile(req.accessProfile, month) }));
        return;
      }
      const normalized = normalizeMonthlyEventInput(data);
      const requestedId = String(data.id || '').trim();
      const existing = requestedId ? monthlyEvents[requestedId] : null;
      if (requestedId && !existing) throw new Error('未找到要修改的每月事件');
      const now = new Date().toISOString();
      const id = requestedId || crypto.randomUUID();
      monthlyEvents[id] = {
        ...(existing || {}), ...normalized, id,
        createdAt: existing && existing.createdAt || now,
        createdBy: existing && existing.createdBy || req.accessProfile.name,
        updatedAt: now,
        updatedBy: req.accessProfile.name
      };
      req._operationAuditContext = {
        category: '每月事件', action: existing ? '修改每月事件' : '新增每月事件',
        target: [normalized.name, normalized.realName, normalized.month, normalized.summary].filter(Boolean).join(' · '),
        details: { before: monthlyEventAuditSnapshot(existing), after: monthlyEventAuditSnapshot(monthlyEvents[id]) }
      };
      saveMonthlyEvents();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: true, event: monthlyEvents[id], events: monthlyEventsForProfile(req.accessProfile, normalized.month) }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // Authenticated department owners may perform the manager node for employees
  // in their own departments. Global administrators may perform every backend
  // node; BP result scoring additionally remains available to the BP whitelist.
  if (req.method === 'GET' && pathname.startsWith('/admin-target-manager-page/')) {
    const parts = pathname.split('/').filter(Boolean);
    const empId = decodeURIComponent(parts[1] || '');
    const month = decodeURIComponent(parts[2] || '');
    const record = kpiTargetDrafts[assessmentKey(empId, month)];
    if (!record || !Array.isArray(record.kpis) || !record.kpis.length) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('未找到可供直属上级确认的绩效目标');
      return;
    }
    if (!requireEmployeeAccess(req, res, empId, record.emp)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(enhanceTargetFormHtml(targetReviewerPageHtml(record, 'manager'), 'reviewer'));
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/admin-target-bp-page/')) {
    if (!req.accessProfile || !req.accessProfile.global) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('仅全局管理员可在后台执行BP目标确认');
      return;
    }
    const parts = pathname.split('/').filter(Boolean);
    const empId = decodeURIComponent(parts[1] || '');
    const month = decodeURIComponent(parts[2] || '');
    const record = kpiTargetDrafts[assessmentKey(empId, month)];
    if (!record || !Array.isArray(record.kpis) || !record.kpis.length) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('未找到可供BP确认的绩效目标');
      return;
    }
    if (!requireEmployeeAccess(req, res, empId, record.emp)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(enhanceTargetFormHtml(targetReviewerPageHtml(record, 'bp'), 'reviewer'));
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/admin-manager-page/')) {
    const parts = pathname.split('/').filter(Boolean);
    const empId = decodeURIComponent(parts[1] || '');
    const month = decodeURIComponent(parts[2] || '');
    const selfInfo = getAssessmentRecord(evalData, empId, month);
    if (!selfInfo) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('员工自评尚未完成，暂不能进行上级评分');
      return;
    }
    if (!requireEmployeeAccess(req, res, empId, selfInfo)) return;
    const sealedRecord = sealedWorkflowRecord(empId, selfInfo.month);
    if (sealedRecord) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(sealedNoticeHtml(sealedRecord));
      return;
    }
    const pagePath = personalizeScoringPage(selfInfo.name, selfInfo);
    if (!pagePath || !fs.existsSync(pagePath)) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('上级评分页生成失败');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(fs.readFileSync(pagePath, 'utf8'));
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/admin-bp-page/')) {
    if (!canPerformBpResultInBackend(req.accessProfile)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('仅系统管理员及桑葚、薏米、路得可在后台执行BP结果评分');
      return;
    }
    const parts = pathname.split('/').filter(Boolean);
    const empId = decodeURIComponent(parts[1] || '');
    const month = decodeURIComponent(parts[2] || '');
    const selfInfo = getAssessmentRecord(evalData, empId, month);
    const managerInfo = getAssessmentRecord(mgrData, empId, selfInfo && selfInfo.month || month);
    if (!selfInfo || !managerInfo) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('员工自评或上级评分尚未完成，暂不能进行BP核准');
      return;
    }
    if (!requireEmployeeAccess(req, res, empId, selfInfo)) return;
    const sealedRecord = sealedWorkflowRecord(empId, selfInfo.month);
    if (sealedRecord) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(sealedNoticeHtml(sealedRecord));
      return;
    }
    const pagePath = personalizeBpPage(selfInfo.name, selfInfo, managerInfo);
    if (!pagePath || !fs.existsSync(pagePath)) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('BP核准页生成失败');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(fs.readFileSync(pagePath, 'utf8'));
    return;
  }

  if (req.method === 'POST' && pathname === '/admin-dingtalk-bind') {
    try {
      const body = JSON.parse(await readBody(req));
      const identity = await exchangeAdminDingTalkAuthCode(body.code);
      const employeeName = employeeNameForUserId(identity.userId);
      const profile = accessProfileForName(employeeName);
      if (!profile.authorized) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: false, error: '当前钉钉账号未配置绩效系统管理权限' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: true, authorized: true, profile }));
    } catch (error) {
      console.error('[admin-sso] Background DingTalk binding failed:', error.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: false, error: '钉钉身份绑定失败' }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/target-drafts') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(filterAssessmentMapForProfile(kpiTargetDrafts, req.accessProfile)));
    return;
  }

  if (req.method === 'POST' && pathname === '/request-target-adjustment') {
    if (!canInitiateTargetAdjustment(req.accessProfile)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '仅桑葚、薏米、路得、Ben四名管理员可发起目标调整申请' }));
      return;
    }
    try {
      const data = JSON.parse(await readBody(req));
      const empId = String(data.empId || '').trim();
      const month = String(data.month || '').trim();
      if (!empId || !month) throw new Error('缺少员工或考核月份');
      const key = assessmentKey(empId, month);
      const formalTarget = kpiTargets[key];
      if (!formalTarget || !formalTarget.emp || !Array.isArray(formalTarget.kpis) || !formalTarget.kpis.length) throw new Error('未找到该员工已确认的绩效目标');
      if (!requireEmployeeAccess(req, res, empId, formalTarget.emp)) return;
      const signedTarget = signedDocumentRecord('kpi', empId, month);
      if (!signedTarget || !signedTarget.doc || !signedTarget.archiveFile) throw new Error('绩效目标尚未完成签字归档，不能发起调整');
      if ([evalData, mgrData, bpData, resultData].some(store => getAssessmentRecord(store, empId, month))) {
        throw new Error('该员工当月绩效评分流程已启动，为避免评分依据不一致，不能再调整目标');
      }
      const previousDraft = kpiTargetDrafts[key];
      if (previousDraft && previousDraft.isTargetAdjustment && !previousDraft.targetSignedAt) throw new Error('该员工已有进行中的目标调整申请');
      const emp = authoritativeWorkflowEmployee(empId, formalTarget.emp);
      if (!emp.directMgr) throw new Error('员工“' + emp.name + '”尚未设置直属上级，不能发起调整');
      const userId = findUserId(emp.name);
      if (!userId) throw new Error('未找到员工“' + emp.name + '”的钉钉账号');
      const now = new Date().toISOString();
      const priorArchive = {
        archiveFile: String(signedTarget.archiveFile || ''),
        archivedAt: String(signedTarget.archivedAt || signedTarget.serverSignedAt || signedTarget.signedAt || ''),
        documentHash: String(signedTarget.integrity && signedTarget.integrity.finalDocumentHash || ''),
        supersededByAdjustmentAt: now,
        supersededBy: req.accessProfile.name
      };
      const record = {
        empId, month, emp,
        kpis: JSON.parse(JSON.stringify(formalTarget.kpis)),
        source: 'target-adjustment', status: 'invited', invitedAt: now,
        isTargetAdjustment: true,
        adjustmentCycle: Number(previousDraft && previousDraft.adjustmentCycle || formalTarget.adjustmentCycle || 0) + 1,
        adjustmentRequestedAt: now,
        adjustmentRequestedBy: req.accessProfile.name,
        adjustmentBaselineKpis: targetKpiSnapshot(formalTarget.kpis),
        targetAdjustments: JSON.parse(JSON.stringify(formalTarget.targetAdjustments || previousDraft && previousDraft.targetAdjustments || [])),
        previousTargetArchives: [...(Array.isArray(formalTarget.previousTargetArchives) ? formalTarget.previousTargetArchives : []), priorArchive],
        targetSignedAt: '', targetArchiveFile: '', targetArchiveHash: '',
        reviewReason: '', rejectedBy: ''
      };
      kpiTargetDrafts[key] = record;
      saveKpiTargetDrafts();
      appendSignatureAudit(req, 'TARGET_ADJUSTMENT_REQUESTED', {
        documentType: 'kpi', empId, name: emp.name, realName: emp.realName, month,
        details: { requestedBy: req.accessProfile.name, adjustmentCycle: record.adjustmentCycle, previousArchiveFile: priorArchive.archiveFile, previousDocumentHash: priorArchive.documentHash }
      });
      const route = targetDraftRoute(empId, month, false);
      const notification = await enqueueBotMessage(userId, '绩效目标调整申请 - ' + periodEmployeeLabel({ ...emp, month }),
        emp.name + '（' + emp.realName + '），你好！\n\n管理员' + req.accessProfile.name + '已发起' + month + '绩效目标调整申请。请本人在原目标基础上调整并提交；提交后将依次由直属上级、BP审核，通过后需重新签字归档。\n\n目标调整页面：' + publicLink(route));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: true, status: record.status, record, notification, warning: notification.sent || notification.queued ? '' : notification.error || '钉钉通知未送达，可在系统内催办' }));
    } catch (error) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/invite-target-draft') {
    if (!requireGlobalAccess(req, res)) return;
    try {
      const data = JSON.parse(await readBody(req));
      const empId = String(data.empId || '').trim();
      const month = String(data.month || '').trim();
      const emp = data.emp && typeof data.emp === 'object' ? data.emp : null;
      if (!empId || !month || !emp || !String(emp.name || '').trim()) throw new Error('缺少员工或考核月份');
      if (!requireEmployeeAccess(req, res, empId, emp)) return;
      assertCanonicalAssessmentSubject(empId, emp, '邀请员工填写目标');
      if (sealedWorkflowRecord(empId, month) || signedDocumentRecord('kpi', empId, month)) throw new Error('该员工当月目标已经签署归档，不能再次邀请填写');
      const key = assessmentKey(empId, month);
      const existingFormalTarget = kpiTargets[key];
      const replaceExisting = data.replaceExisting === true;
      if (existingFormalTarget && !replaceExisting) {
        throw new Error('该员工当月已有旧版正式目标，请使用“邀请员工重新填写目标”转入新版确认流程');
      }
      const previous = kpiTargetDrafts[key];
      if (previous && previous.status === 'submitted') throw new Error('员工已提交目标，正在等待直属上级确认');
      if (previous && previous.status === 'manager_approved') throw new Error('直属上级已确认目标，正在等待BP确认');
      if (previous && previous.status === 'approved') throw new Error('BP已确认该员工目标，不能重复邀请');
      const authoritativeEmp = authoritativeWorkflowEmployee(empId, emp);
      if (!authoritativeEmp.directMgr) throw new Error('员工“' + authoritativeEmp.name + '”尚未设置直属上级，不能邀请填写目标');
      const record = {
        empId, month,
        emp: authoritativeEmp,
        // Legacy releases wrote targets directly to kpi_targets.json before
        // manager/BP/employee confirmation existed.  Preserve those rows as
        // editable initial values when an administrator explicitly converts
        // the record to the current employee-fill workflow.
        kpis: previous && Array.isArray(previous.kpis)
          ? previous.kpis
          : (replaceExisting && existingFormalTarget && Array.isArray(existingFormalTarget.kpis)
            ? JSON.parse(JSON.stringify(existingFormalTarget.kpis))
            : []),
        source: 'employee-self-fill', status: 'invited', invitedAt: new Date().toISOString(), reviewReason: '', rejectedBy: ''
      };
      kpiTargetDrafts[key] = record;
      saveKpiTargetDrafts();
      const userId = findUserId(record.emp.name);
      if (!userId) throw new Error('未找到员工“' + record.emp.name + '”的钉钉账号');
      const route = targetDraftRoute(empId, month, false);
      const notification = await enqueueBotMessage(userId, month + (replaceExisting ? '绩效目标修改邀请' : '绩效目标填写邀请'),
        record.emp.name + '（' + record.emp.realName + '），你好！\n\n请本人' + (replaceExisting ? '核对并修改' : '填写') + month + '绩效目标。提交后将先发送直属上级确认，再发送BP确认；两级确认通过后，你还需要完成目标签字确认并归档。\n\n目标填写页面：' + publicLink(route));
      if (!notification.sent && !notification.queued) throw new Error(notification.error || '钉钉通知发送失败');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: true, status: record.status, recipientName: record.emp.name, convertedLegacyTarget: Boolean(existingFormalTarget), notification }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/withdraw-target-invitation') {
    if (!requireGlobalAccess(req, res)) return;
    try {
      const data = JSON.parse(await readBody(req));
      const empId = String(data.empId || '').trim();
      const month = String(data.month || '').trim();
      if (!empId || !month) throw new Error('缺少员工或考核月份');
      const key = assessmentKey(empId, month);
      const record = kpiTargetDrafts[key];
      if (!record) throw new Error('员工填写邀请不存在或已经撤回');
      if (!requireEmployeeAccess(req, res, empId, record.emp)) return;
      if (record.status !== 'invited') throw new Error('员工目标已进入确认流程，不能切换为后台制定');
      if (Array.isArray(record.kpis) && record.kpis.length) throw new Error('邀请中已经包含目标内容，为避免覆盖数据不能直接切换');
      delete kpiTargetDrafts[key];
      saveKpiTargetDrafts();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: true, empId, month, status: 'withdrawn' }));
    } catch (error) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/target-draft-page/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    let decoded = '';
    try { decoded = Buffer.from(pathname.slice('/target-draft-page/'.length), 'base64').toString('utf8'); } catch (_) {}
    const [empId, month] = decoded.split('|');
    const record = kpiTargetDrafts[assessmentKey(empId, month)];
    if (!record) { res.writeHead(404); res.end('Target invitation not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(targetDraftPageHtmlWithHistory(record));
    return;
  }

  if (req.method === 'POST' && pathname === '/submit-target-draft') {
    try {
      const data = JSON.parse(await readBody(req));
      if (!isValidWorkflowAction(data, 'target-draft')) { res.writeHead(403); res.end('{"error":"Invalid workflow action token"}'); return; }
      const key = assessmentKey(data.empId, data.month);
      const record = kpiTargetDrafts[key];
      if (!record) throw new Error('目标填写邀请不存在或已经失效');
      if (record.status !== 'invited' && record.status !== 'rejected') throw new Error('目标已经提交，不能重复提交');
      record.emp = authoritativeWorkflowEmployee(record.empId, record.emp);
      const submittedKpis = validateEmployeeTargetKpis(data.kpis, record.emp);
      if (record.isTargetAdjustment) {
        const adjustment = appendTargetAdjustment(record, 'employee', record.emp.name, record.kpis, submittedKpis);
        if (!adjustment.changed) throw new Error('目标内容未发生变化，请完成调整后再提交');
      }
      record.kpis = submittedKpis;
      record.status = 'submitted';
      record.submittedAt = new Date().toISOString();
      record.reviewReason = '';
      record.rejectedBy = '';
      saveKpiTargetDrafts();
      const managerName = String(record.emp.directMgr || '').trim();
      const managerUserId = findUserId(managerName);
      const targetProcessLabel = record.isTargetAdjustment ? '绩效目标调整' : '绩效目标';
      const notification = managerUserId
        ? await enqueueBotMessage(managerUserId, '直属上级审核员工' + targetProcessLabel + ' - ' + periodEmployeeLabel({ ...record.emp, month: record.month }),
          record.emp.name + '（' + record.emp.realName + '）已提交' + record.month + targetProcessLabel + '。\n\n请核对指标、评分细则、数据来源、权重及调整前后差异；审核通过后系统将发送BP继续审核。\n\n直属上级审核页面：' + publicLink(targetManagerReviewRoute(record.empId, record.month)))
        : { sent: false, queued: false, error: '未找到直属上级“' + managerName + '”的钉钉账号，请联系管理员催办' };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: true, status: record.status, managerName, notification, warning: notification.sent || notification.queued ? '' : notification.error }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/target-manager-page/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    let decoded = '';
    try { decoded = Buffer.from(pathname.slice('/target-manager-page/'.length), 'base64').toString('utf8'); } catch (_) {}
    const [empId, month] = decoded.split('|');
    const record = kpiTargetDrafts[assessmentKey(empId, month)];
    if (!record || !Array.isArray(record.kpis) || !record.kpis.length) { res.writeHead(404); res.end('Submitted target draft not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(enhanceTargetFormHtml(targetReviewerPageHtml(record, 'manager'), 'reviewer'));
    return;
  }

  if (req.method === 'POST' && pathname === '/adjust-target-review') {
    try {
      const data = JSON.parse(await readBody(req));
      const role = String(data.role || '').trim();
      if (role !== 'manager' && role !== 'bp') throw new Error('无效的目标调整角色');
      const actionType = role === 'manager' ? 'target-manager' : 'target-bp';
      if (!isValidWorkflowAction(data, actionType)) { res.writeHead(403); res.end('{"error":"Invalid workflow action token"}'); return; }
      const key = assessmentKey(data.empId, data.month);
      const record = kpiTargetDrafts[key];
      const requiredStatus = role === 'manager' ? 'submitted' : 'manager_approved';
      if (!record || record.status !== requiredStatus) throw new Error('当前目标不在该角色可调整的处理节点');
      const sessionProfile = readAdminSession(req);
      if (sessionProfile && sessionProfile.authorized) {
        if (role === 'manager' && !canAccessEmployee(sessionProfile, record.empId, record.emp)) {
          res.writeHead(403); res.end('{"error":"无权调整其他部门的上级确认目标"}'); return;
        }
        if (role === 'bp' && !sessionProfile.global) {
          res.writeHead(403); res.end('{"error":"部门负责人只能处理上级确认环节"}'); return;
        }
      }
      const result = applyTargetReviewerAdjustment(record, role, data.kpis);
      if (result.changed) saveKpiTargetDrafts();

      const actorLabel = role === 'manager' ? '直属上级' : 'BP';
      const employeeUserId = findUserId(record.emp.name);
      const counterpartName = role === 'manager' ? String(record.emp.hrbp || '薏米') : String(record.emp.directMgr || '');
      const counterpartUserId = findUserId(counterpartName);
      const employeePath = targetDraftRoute(record.empId, record.month, false);
      const counterpartPath = role === 'manager' ? targetDraftRoute(record.empId, record.month, true) : targetManagerReviewRoute(record.empId, record.month);
      const noticeText = actorLabel + '已调整' + record.month + record.emp.name + '（' + record.emp.realName + '）的绩效目标，系统已保存调整前后差异。\n\n查看当前内容与调整记录：';
      const notifications = [];
      if (result.changed && employeeUserId) notifications.push(await enqueueBotMessage(employeeUserId, '绩效目标已由' + actorLabel + '调整 - ' + periodEmployeeLabel({ ...record.emp, month: record.month }), noticeText + publicLink(employeePath)));
      if (result.changed && counterpartUserId) notifications.push(await enqueueBotMessage(counterpartUserId, '绩效目标调整记录 - ' + periodEmployeeLabel({ ...record.emp, month: record.month }), noticeText + publicLink(counterpartPath)));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: true, changed: result.changed, changes: result.changes, adjustment: result.adjustment || null, notifications }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/review-target-manager') {
    try {
      const data = JSON.parse(await readBody(req));
      if (!isValidWorkflowAction(data, 'target-manager')) { res.writeHead(403); res.end('{"error":"Invalid workflow action token"}'); return; }
      const key = assessmentKey(data.empId, data.month);
      const record = kpiTargetDrafts[key];
      if (!record || record.status !== 'submitted') throw new Error('该目标不在待直属上级确认状态，不能重复处理');
      const sessionProfile = readAdminSession(req);
      if (sessionProfile && sessionProfile.authorized && !canAccessEmployee(sessionProfile, record.empId, record.emp)) {
        res.writeHead(403); res.end('{"error":"无权确认其他部门员工的绩效目标"}'); return;
      }
      const decision = String(data.decision || '');
      if (decision === 'reject') {
        const reason = String(data.reason || '').trim();
        if (!reason) throw new Error('退回时必须填写原因');
        record.status = 'rejected'; record.rejectedBy = 'manager'; record.reviewReason = reason; record.managerReviewedAt = new Date().toISOString();
        saveKpiTargetDrafts();
        let notification = null;
        if (record.source !== 'admin-entry') {
          const userId = findUserId(record.emp.name);
          notification = userId ? await enqueueBotMessage(userId, record.month + '绩效目标已被直属上级退回',
            '直属上级已退回你的' + record.month + '绩效目标。\n\n退回原因：' + reason + '\n\n请修改后重新提交：' + publicLink(targetDraftRoute(record.empId, record.month, false))) : { sent: false, error: 'employee not found' };
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: true, status: record.status, notification }));
        return;
      }
      if (decision !== 'approve') throw new Error('无效的直属上级处理结果');
      if (Array.isArray(data.kpis)) applyTargetReviewerAdjustment(record, 'manager', data.kpis);
      record.kpis = validateEmployeeTargetKpis(record.kpis, record.emp);
      record.status = 'manager_approved'; record.managerApprovedAt = new Date().toISOString();
      record.managerApprovedBy = sessionProfile && sessionProfile.authorized ? sessionProfile.name : (record.emp.directMgr || '');
      record.reviewReason = ''; record.rejectedBy = '';
      saveKpiTargetDrafts();
      const bpName = String(record.emp.hrbp || '薏米');
      const bpUserId = findUserId(bpName);
      const targetProcessLabel = record.isTargetAdjustment ? '绩效目标调整' : '绩效目标';
      const notification = bpUserId
        ? await enqueueBotMessage(bpUserId, 'BP审核员工' + targetProcessLabel + ' - ' + periodEmployeeLabel({ ...record.emp, month: record.month }),
          record.emp.name + '（' + record.emp.realName + '）的' + record.month + targetProcessLabel + '已由直属上级审核。\n\n请继续核对指标、评分细则、数据来源、权重及调整前后差异；BP通过后系统将通知员工本人重新签字归档。\n\nBP审核页面：' + publicLink(targetDraftRoute(record.empId, record.month, true)))
        : { sent: false, queued: false, error: '未找到BP“' + bpName + '”的钉钉账号，请联系管理员催办' };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: true, status: record.status, bpName, notification, warning: notification.sent || notification.queued ? '' : notification.error }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/target-bp-page/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    let decoded = '';
    try { decoded = Buffer.from(pathname.slice('/target-bp-page/'.length), 'base64').toString('utf8'); } catch (_) {}
    const [empId, month] = decoded.split('|');
    const record = kpiTargetDrafts[assessmentKey(empId, month)];
    if (!record || !Array.isArray(record.kpis) || !record.kpis.length) { res.writeHead(404); res.end('Submitted target draft not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(enhanceTargetFormHtml(targetReviewerPageHtml(record, 'bp'), 'reviewer'));
    return;
  }

  if (req.method === 'POST' && pathname === '/review-target-draft') {
    try {
      const data = JSON.parse(await readBody(req));
      if (!isValidWorkflowAction(data, 'target-bp')) { res.writeHead(403); res.end('{"error":"Invalid workflow action token"}'); return; }
      const key = assessmentKey(data.empId, data.month);
      const record = kpiTargetDrafts[key];
      if (!record || record.status !== 'manager_approved') throw new Error('该目标尚未完成直属上级确认，或已经处理，不能执行BP确认');
      const sessionProfile = readAdminSession(req);
      if (sessionProfile && sessionProfile.authorized && !sessionProfile.global) {
        res.writeHead(403); res.end('{"error":"部门负责人只能处理上级确认环节"}'); return;
      }
      const decision = String(data.decision || '');
      if (decision === 'reject') {
        const reason = String(data.reason || '').trim();
        if (!reason) throw new Error('退回时必须填写原因');
        record.status = 'rejected'; record.rejectedBy = 'bp'; record.reviewReason = reason; record.reviewedAt = new Date().toISOString();
        saveKpiTargetDrafts();
        let notification = null;
        if (record.source !== 'admin-entry') {
          const userId = findUserId(record.emp.name);
          notification = userId ? await enqueueBotMessage(userId, record.month + '绩效目标已被BP退回',
            'BP已退回你的' + record.month + '绩效目标。\n\n退回原因：' + reason + '\n\n请修改后重新提交；重新提交后仍需直属上级再次确认：' + publicLink(targetDraftRoute(record.empId, record.month, false))) : { sent: false, error: 'employee not found' };
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: true, status: record.status, notification }));
        return;
      }
      if (decision !== 'approve') throw new Error('无效的BP处理结果');
      if (Array.isArray(data.kpis)) applyTargetReviewerAdjustment(record, 'bp', data.kpis);
      record.kpis = validateEmployeeTargetKpis(record.kpis, record.emp);
      record.status = 'approved'; record.reviewedAt = new Date().toISOString(); record.approvedAt = record.reviewedAt;
      kpiTargets[key] = { emp: record.emp, kpis: record.kpis, month: record.month, source: record.source || 'employee-self-fill', managerApprovedAt: record.managerApprovedAt || '', managerApprovedBy: record.managerApprovedBy || record.emp.directMgr || '', approvedAt: record.approvedAt, approvedBy: record.emp.hrbp || '薏米', isTargetAdjustment: record.isTargetAdjustment === true, adjustmentCycle: Number(record.adjustmentCycle || 0), adjustmentRequestedAt: record.adjustmentRequestedAt || '', adjustmentRequestedBy: record.adjustmentRequestedBy || '', previousTargetArchives: Array.isArray(record.previousTargetArchives) ? record.previousTargetArchives : [], targetAdjustments: Array.isArray(record.targetAdjustments) ? record.targetAdjustments : [] };
      fs.writeFileSync(KPI_TARGETS_FILE, JSON.stringify(kpiTargets, null, 2), { encoding: 'utf8', mode: 0o640 });
      if (record.isTargetAdjustment) {
        const supersededTarget = signedDocumentRecord('kpi', record.empId, record.month);
        if (supersededTarget) {
          appendSignatureAudit(req, 'TARGET_ARCHIVE_SUPERSEDED', {
            documentType: 'kpi', empId: record.empId, name: record.emp.name, realName: record.emp.realName, month: record.month,
            details: { adjustmentCycle: record.adjustmentCycle, previousArchiveFile: supersededTarget.archiveFile || '', previousDocumentHash: supersededTarget.integrity && supersededTarget.integrity.finalDocumentHash || '' }
          });
          deleteAssessmentRecord(kpiData, record.empId, record.month);
          fs.writeFileSync(KPI_DATA_FILE, JSON.stringify(kpiData, null, 2), { encoding: 'utf8', mode: 0o640 });
        }
      }
      saveKpiTargetDrafts();
      let generationWarning = '';
      try {
        generateStoredKpiConfirmationPage({ empId: record.empId, emp: record.emp, kpis: record.kpis, month: record.month, targetAdjustments: record.targetAdjustments });
      } catch (error) {
        generationWarning = '目标确认页面生成失败：' + error.message;
      }
      const employeeUserId = findUserId(record.emp.name);
      const targetConfirmationPath = '/kpi-confirm-page/' + Buffer.from(String(record.empId) + '|' + String(record.month), 'utf8').toString('base64url');
      const notification = employeeUserId
        ? await enqueueBotMessage(employeeUserId, '绩效目标签字确认 - ' + periodEmployeeLabel({ ...record.emp, month: record.month }),
          record.emp.name + '（' + record.emp.realName + '），你好！\n\nBP已确认你的' + record.month + (record.isTargetAdjustment ? '绩效目标调整。请核对调整前后差异及调整后目标' : '绩效目标') + '，并完成本人手写签名；签署成功后目标确认书将自动归档。\n\n目标签字确认页面：' + publicLink(targetConfirmationPath))
        : { sent: false, queued: false, error: '未找到员工“' + record.emp.name + '”的钉钉账号，请管理员催办目标签字' };
      record.targetConfirmationNotification = {
        sent: Boolean(notification.sent), queued: Boolean(notification.queued), channel: notification.channel || '',
        error: notification.error || ''
      };
      if (notification.sent || notification.queued) record.targetConfirmationSentAt = new Date().toISOString();
      saveKpiTargetDrafts();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        success: true,
        status: record.status,
        targetSignatureRequired: true,
        manualSelfEvaluationRequiredAfterSignature: true,
        notification,
        warning: [generationWarning, notification.sent || notification.queued ? '' : notification.error].filter(Boolean).join('；')
      }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/archive-view') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const documentType = query.get('type') === 'result' ? 'result' : 'kpi';
    const empId = String(query.get('empId') || '').trim();
    const month = String(query.get('month') || '').trim();
    if (!requireEmployeeAccess(req, res, empId)) return;
    const record = signedDocumentRecord(documentType, empId, month);
    if (!record || !record.doc) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>归档未找到</title><body style="font-family:sans-serif;padding:40px">未找到对应的有效归档文件。</body></html>');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'inline; filename="performance-archive.html"',
      'Cache-Control': 'private, no-store'
    });
    res.end(archivedDocumentPreviewHtml(record.doc, documentType, record));
    return;
  }

  if (req.method === 'POST' && req.url === '/submit') {
    try {
      const data = JSON.parse(await readBody(req));
      if (!isValidWorkflowAction(data, 'self')) { res.writeHead(403); res.end('{"error":"Invalid workflow action token"}'); return; }
      if (rejectSealedWorkflow(res, data.empId, data.month)) return;
      if (!data.empId || data.selfScore == null) { res.writeHead(400); res.end('{"error":"Missing empId or selfScore"}'); return; }
      if (!Array.isArray(data.details) || data.details.length === 0) { res.writeHead(400); res.end('{"error":"Missing self-evaluation details"}'); return; }
      const targetInfo = kpiTargets[data.empId + '|' + data.month];
      if (!targetInfo || !Array.isArray(targetInfo.kpis) || targetInfo.kpis.length === 0) { res.writeHead(400); res.end('{"error":"KPI targets not found"}'); return; }
      assertCanonicalAssessmentSubject(data.empId, targetInfo.emp, '员工自评');
      const signedTarget = getAssessmentRecord(kpiData, data.empId, data.month);
      if (!signedTarget || !signedTarget.doc) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('{"error":"绩效目标尚未完成本人签字归档，不能提交自评"}');
        return;
      }
      const scoringUnits = scoringUnitsForKpis(targetInfo.kpis);
      const targetBySeq = new Map(scoringUnits.map(item => [Number(item.seq), item]));
      const submittedSeqs = new Set();
      let authoritativeTotal = 0;
      for (const detail of data.details) {
        if (!String(detail.completion || '').trim()) { res.writeHead(400); res.end('{"error":"Please complete the completion notes before scoring"}'); return; }
        const seq = Number(detail.seq);
        const target = targetBySeq.get(seq);
        if (!target || submittedSeqs.has(seq)) { res.writeHead(400); res.end('{"error":"Invalid or duplicate KPI item"}'); return; }
        submittedSeqs.add(seq);
        const baseScore = Number(target.max);
        const score = validateScore(detail.selfScore, baseScore, 'Self score for KPI ' + seq);
        authoritativeTotal += score;
      }
      if (submittedSeqs.size !== targetBySeq.size) { res.writeHead(400); res.end('{"error":"Please score every KPI item"}'); return; }
      data.selfScore = validateTotalScore(authoritativeTotal, 'Self-evaluation total');
      data.provisionalGrade = getGradeInfo(data.selfScore).grade;
      data.submittedAt = new Date().toISOString();
      if (targetInfo && targetInfo.emp) {
        const authoritativeEmp = authoritativeWorkflowEmployee(data.empId, targetInfo.emp);
        data.name = data.name || targetInfo.emp.name;
        data.realName = data.realName || targetInfo.emp.realName;
        data.dept = data.dept || targetInfo.emp.dept;
        data.position = data.position || targetInfo.emp.position;
        data.directMgr = data.directMgr || targetInfo.emp.directMgr;
        data.hrbp = authoritativeEmp.hrbp;
        data.scores = data.details.map(detail => {
          const target = targetBySeq.get(Number(detail.seq)) || {};
          return {
            seq: Number(detail.seq),
            indicator: target.indicator || ('KPI ' + detail.seq),
            parentIndicator: target.parentIndicator || target.indicator || ('KPI ' + detail.seq),
            parentSeq: target.parentSeq,
            itemIndex: target.itemIndex,
            grouped: target.grouped === true,
            target: '',
            dataSource: kpiDataSource(target),
            rule: target.rule || '',
            items: [],
            max: Number(target.max) || 0,
            score: Number(detail.selfScore) || 0,
            completion: String(detail.completion || '').trim()
          };
        });
      }
      // A new self-evaluation invalidates every downstream score and result.
      // Keep immutable signed archive files on disk, but remove active records
      // so the workflow must proceed through manager and BP approval again.
      deleteAssessmentRecord(mgrData, data.empId, data.month);
      deleteAssessmentRecord(bpData, data.empId, data.month);
      deleteAssessmentRecord(resultData, data.empId, data.month);
      fs.writeFileSync(MGR_DATA_FILE, JSON.stringify(mgrData, null, 2), 'utf8');
      fs.writeFileSync(BP_DATA_FILE, JSON.stringify(bpData, null, 2), 'utf8');
      fs.writeFileSync(RESULT_DATA_FILE, JSON.stringify(resultData, null, 2), 'utf8');
      setAssessmentRecord(evalData, data);
      fs.writeFileSync(DATA_FILE, JSON.stringify(evalData, null, 2), 'utf8');
      console.log('[' + new Date().toLocaleString() + '] Self-eval: ' + data.name + '(' + data.realName + ') = ' + data.selfScore + 'pts');
      const notification = await prepareSelfEvalNotifications(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, notification }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'POST' && req.url === '/submit-mgr') {
    try {
      const data = JSON.parse(await readBody(req));
      if (!isValidWorkflowAction(data, 'manager')) { res.writeHead(403); res.end('{"error":"Invalid workflow action token"}'); return; }
      if (rejectSealedWorkflow(res, data.empId, data.month)) return;
      if (!data.empId || data.mgrScore == null) { res.writeHead(400); res.end('{"error":"Missing empId or mgrScore"}'); return; }
      const selfInfo = getAssessmentRecord(evalData, data.empId, data.month) || {};
      assertCanonicalAssessmentSubject(data.empId, selfInfo, '直属上级评分');
      const sessionProfile = readAdminSession(req);
      if (sessionProfile && sessionProfile.authorized && !canAccessEmployee(sessionProfile, data.empId, selfInfo)) {
        res.writeHead(403); res.end('{"error":"无权为其他部门员工提交上级评分"}'); return;
      }
      if (!sameWorkflowMonth(selfInfo, data.month)) { res.writeHead(409); res.end('{"error":"Assessment month does not match self-evaluation"}'); return; }
      if (!Array.isArray(selfInfo.scores) || selfInfo.scores.length === 0) { res.writeHead(400); res.end('{"error":"Self-evaluation data not found"}'); return; }
      if (!Array.isArray(data.mgrScores) || data.mgrScores.length !== selfInfo.scores.length) { res.writeHead(400); res.end('{"error":"Please score every KPI item"}'); return; }
      const submittedBySeq = new Map(data.mgrScores.map(item => [Number(item.seq), item]));
      if (submittedBySeq.size !== selfInfo.scores.length) { res.writeHead(400); res.end('{"error":"Invalid or duplicate KPI item"}'); return; }
      let authoritativeTotal = 0;
      data.mgrScores = selfInfo.scores.map((selfScore, index) => {
        const seq = Number(selfScore.seq || index + 1);
        const submitted = submittedBySeq.get(seq);
        const score = validateScore(submitted && submitted.score, selfScore.max, 'Manager score for KPI ' + seq);
        authoritativeTotal += score;
        return {
          seq,
          indicator: selfScore.indicator,
          parentIndicator: selfScore.parentIndicator || '',
          parentSeq: selfScore.parentSeq,
          itemIndex: selfScore.itemIndex,
          grouped: selfScore.grouped === true,
          score,
          max: Number(selfScore.max) || 0,
          selfScore: Number(selfScore.score) || 0,
          remark: normalizeScoreRemark(submitted && submitted.remark)
        };
      });
      data.month = selfInfo.month;
      data.mgrScore = validateTotalScore(authoritativeTotal, 'Manager score total');
      data.provisionalGrade = getGradeInfo(data.mgrScore).grade;
      data.selfScore = Number(selfInfo.selfScore) || 0;
      data.name = data.name || selfInfo.name;
      data.realName = data.realName || selfInfo.realName;
      data.dept = data.dept || selfInfo.dept;
      data.position = data.position || selfInfo.position;
      data.directMgr = data.directMgr || selfInfo.directMgr;
      data.hrbp = authoritativeWorkflowEmployee(data.empId, selfInfo).hrbp;
      data.submittedBy = sessionProfile && sessionProfile.authorized ? sessionProfile.name : (selfInfo.directMgr || '');
      setAssessmentRecord(mgrData, data);
      fs.writeFileSync(MGR_DATA_FILE, JSON.stringify(mgrData, null, 2), 'utf8');
      console.log('[' + new Date().toLocaleString() + '] Mgr-score: ' + data.name + ' = ' + data.mgrScore + 'pts (self=' + data.selfScore + ')');
      const notification = await prepareMgrScoreNotifications(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, notification }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }


  if (req.method === 'POST' && req.url === '/submit-bp') {
    try {
      const data = JSON.parse(await readBody(req));
      if (!isValidWorkflowAction(data, 'bp')) { res.writeHead(403); res.end('{"error":"Invalid workflow action token"}'); return; }
      const sessionProfile = readAdminSession(req);
      if (sessionProfile && sessionProfile.authorized && !canPerformBpResultInBackend(sessionProfile)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '仅系统管理员及桑葚、薏米、路得可提交BP结果评分' }));
        return;
      }
      if (rejectSealedWorkflow(res, data.empId, data.month)) return;
      if (!data.empId || data.bpScore == null) { res.writeHead(400); res.end('{"error":"Missing empId or bpScore"}'); return; }
      const selfInfo = getAssessmentRecord(evalData, data.empId, data.month) || {};
      const mgrInfo = getAssessmentRecord(mgrData, data.empId, data.month) || {};
      assertCanonicalAssessmentSubject(data.empId, selfInfo, 'BP评分');
      if (!sameWorkflowMonth(selfInfo, data.month) || !sameWorkflowMonth(mgrInfo, data.month)) { res.writeHead(409); res.end('{"error":"Assessment month does not match upstream scoring data"}'); return; }
      if (!Array.isArray(selfInfo.scores) || selfInfo.scores.length === 0 || !Array.isArray(mgrInfo.mgrScores)) { res.writeHead(400); res.end('{"error":"Upstream scoring data not found"}'); return; }
      if (!Array.isArray(data.bpScores) || data.bpScores.length !== selfInfo.scores.length) { res.writeHead(400); res.end('{"error":"Please score every KPI item"}'); return; }
      const submittedBySeq = new Map(data.bpScores.map(item => [Number(item.seq), item]));
      if (submittedBySeq.size !== selfInfo.scores.length) { res.writeHead(400); res.end('{"error":"Invalid or duplicate KPI item"}'); return; }
      let authoritativeTotal = 0;
      data.bpScores = selfInfo.scores.map((selfScore, index) => {
        const seq = Number(selfScore.seq || index + 1);
        const managerScore = mgrInfo.mgrScores.find(item => Number(item.seq) === seq) || {};
        const submitted = submittedBySeq.get(seq);
        const score = validateScore(submitted && submitted.score, selfScore.max, 'BP score for KPI ' + seq);
        authoritativeTotal += score;
        return {
          seq,
          indicator: selfScore.indicator,
          parentIndicator: selfScore.parentIndicator || '',
          parentSeq: selfScore.parentSeq,
          itemIndex: selfScore.itemIndex,
          grouped: selfScore.grouped === true,
          score,
          max: Number(selfScore.max) || 0,
          selfScore: Number(selfScore.score) || 0,
          mgrScore: Number(managerScore.score) || 0,
          mgrRemark: normalizeScoreRemark(managerScore.remark),
          remark: normalizeScoreRemark(submitted && submitted.remark)
        };
      });
      data.month = selfInfo.month;
      data.bpScore = validateTotalScore(authoritativeTotal, 'BP score total');
      data.selfScore = Number(selfInfo.selfScore) || 0;
      data.mgrScore = Number(mgrInfo.mgrScore) || 0;
      data.grade = getGradeInfo(Number(data.bpScore) || 0).grade;
      setAssessmentRecord(bpData, data);
      fs.writeFileSync(BP_DATA_FILE, JSON.stringify(bpData, null, 2), 'utf8');
      console.log('[' + new Date().toLocaleString() + '] BP-score: ' + data.name + ' = ' + data.bpScore + 'pts (grade=' + data.grade + ')');
      // Generate result confirmation and notify employee
      const resultNotification = await prepareResultNotifications(data.empId, data.month);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, resultNotification, oaApproval: { status: 'waiting-for-result-signatures' } }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'POST' && pathname === '/sign-otp-status') {
    try {
      const data = JSON.parse(await readBody(req));
      const documentType = data.documentType === 'result' ? 'result' : 'kpi';
      const empId = String(data.empId || '');
      const month = String(data.month || '');
      const targetInfo = kpiTargets[assessmentKey(empId, month)];
      if (!empId || !month || !targetInfo || !targetInfo.emp) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, active: false, error: '未找到该员工当月绩效数据' }));
        return;
      }
      const pageError = validateSigningPage(data, targetInfo.emp);
      if (pageError) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, active: false, error: pageError }));
        return;
      }
      const challenge = activeSigningChallenge(empId, month, documentType);
      const now = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(challenge ? {
        success: true, active: true, challengeId: challenge.challengeId,
        expiresIn: Math.max(1, Math.ceil((challenge.expiresAt - now) / 1000)),
        resendAfter: Math.max(0, Math.ceil((challenge.createdAt + 60000 - now) / 1000))
      } : { success: true, active: false }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, active: false, error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/request-sign-otp') {
    try {
      cleanupSigningSessions();
      const data = JSON.parse(await readBody(req));
      const documentType = data.documentType === 'result' ? 'result' : 'kpi';
      const empId = String(data.empId || '');
      const month = String(data.month || '');
      if (rejectSealedWorkflow(res, empId, month)) return;
      if (rejectSignedDocument(res, documentType, empId, month)) return;
      const targetInfo = kpiTargets[empId + '|' + month];
      if (!empId || !month || !targetInfo || !targetInfo.emp) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '未找到该员工当月绩效数据' }));
        return;
      }
      if (documentType === 'result' && !getAssessmentRecord(bpData, empId, month)) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '绩效结果尚未完成BP核准' }));
        return;
      }
      const pageError = validateSigningPage(data, targetInfo.emp);
      if (pageError) {
        appendSignatureAudit(req, 'OTP_REQUEST_REJECTED', {
          documentType, empId, name: targetInfo.emp.name, realName: targetInfo.emp.realName, month,
          details: { reason: pageError }
        });
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: pageError }));
        return;
      }
      const recent = activeSigningChallenge(empId, month, documentType);
      if (recent) {
        const now = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          success: true, resumed: true, challengeId: recent.challengeId,
          expiresIn: Math.max(1, Math.ceil((recent.expiresAt - now) / 1000)),
          resendAfter: Math.max(0, Math.ceil((recent.createdAt + 60000 - now) / 1000)),
          delivery: { sent: true, resumed: true }
        }));
        return;
      }
      const userId = findUserId(targetInfo.emp.name);
      if (!userId) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '未找到该员工本人的钉钉账号，不能签署' }));
        return;
      }
      const testCode = process.env.NODE_ENV === 'test' && /^\d{6}$/.test(String(process.env.SIGNING_OTP_TEST_CODE || ''))
        ? String(process.env.SIGNING_OTP_TEST_CODE) : '';
      const code = testCode || String(crypto.randomInt(100000, 1000000));
      const challengeId = crypto.randomUUID();
      const challenge = {
        challengeId, documentType, empId, month,
        name: targetInfo.emp.name, realName: targetInfo.emp.realName,
        codeHash: hmacSha256(challengeId + '|' + code), attempts: 0,
        createdAt: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000
      };
      const typeLabel = documentType === 'result' ? '绩效结果确认' : '绩效目标确认';
      const delivery = await sendSigningOtpNow(userId, '签署身份验证码 - ' + month + targetInfo.emp.name,
        targetInfo.emp.realName + '，你正在进行' + month + typeLabel + '。\n\n本人验证码：' + code +
        '\n\n验证码5分钟内有效，请勿转发或告知他人。如非本人操作，请忽略并联系HRBP。');
      if (!delivery.sent) {
        appendSignatureAudit(req, 'OTP_DELIVERY_FAILED', {
          documentType, empId, name: targetInfo.emp.name, realName: targetInfo.emp.realName, month,
          details: { channel: delivery.channel || '', reason: String(delivery.error || 'DingTalk delivery failed').slice(0, 300) }
        });
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '钉钉验证码发送失败，请稍后重试或联系管理员' }));
        return;
      }
      signingChallenges.set(challengeId, challenge);
      const audit = appendSignatureAudit(req, 'OTP_REQUESTED', {
        documentType, empId, name: targetInfo.emp.name, realName: targetInfo.emp.realName, month,
        details: { challengeId, expiresAt: new Date(challenge.expiresAt).toISOString(), delivery: { sent: Boolean(delivery.sent), queued: Boolean(delivery.queued), channel: delivery.channel || '' } }
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, challengeId, expiresIn: 300, delivery: { sent: Boolean(delivery.sent), queued: Boolean(delivery.queued) }, auditId: audit.auditId }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/verify-sign-otp') {
    try {
      cleanupSigningSessions();
      const data = JSON.parse(await readBody(req));
      const challengeId = String(data.challengeId || '');
      const code = String(data.code || '').trim();
      const challenge = signingChallenges.get(challengeId);
      if (!challenge || challenge.expiresAt <= Date.now()) {
        res.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '验证码已失效，请重新获取' }));
        return;
      }
      challenge.attempts += 1;
      if (challenge.attempts > 5 || !/^\d{6}$/.test(code) || !safeTextEqual(challenge.codeHash, hmacSha256(challengeId + '|' + code))) {
        const locked = challenge.attempts >= 5;
        if (locked) signingChallenges.delete(challengeId);
        appendSignatureAudit(req, 'OTP_VERIFICATION_FAILED', {
          documentType: challenge.documentType, empId: challenge.empId, name: challenge.name,
          realName: challenge.realName, month: challenge.month,
          details: { challengeId, attempt: challenge.attempts, locked }
        });
        res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: locked ? '验证码错误次数过多，请重新获取' : '验证码错误' }));
        return;
      }
      signingChallenges.delete(challengeId);
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const verifiedAt = new Date().toISOString();
      signingVerifications.set(verificationToken, {
        challengeId, documentType: challenge.documentType, empId: challenge.empId, month: challenge.month,
        name: challenge.name, realName: challenge.realName, verifiedAt,
        expiresAt: Date.now() + 10 * 60 * 1000, used: false
      });
      const audit = appendSignatureAudit(req, 'OTP_VERIFIED', {
        documentType: challenge.documentType, empId: challenge.empId, name: challenge.name,
        realName: challenge.realName, month: challenge.month,
        details: { challengeId, verifiedAt, validForSeconds: 600 }
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, verificationToken, verifiedAt, expiresIn: 600, auditId: audit.auditId }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/submit-kpi') {
    try {
      const data = JSON.parse(await readBody(req));
      if (rejectSealedWorkflow(res, data.empId, data.month)) return;
      if (rejectSignedDocument(res, 'kpi', data.empId, data.month)) return;
      if (!data.empId || !data.doc) { res.writeHead(400); res.end('{"error":"Missing empId or doc"}'); return; }
      const targetInfo = kpiTargets[data.empId + '|' + data.month];
      if (!targetInfo || !targetInfo.emp) { res.writeHead(404); res.end('{"error":"KPI target data not found"}'); return; }
      assertCanonicalAssessmentSubject(data.empId, targetInfo.emp, '绩效目标签字');
      data.name = targetInfo.emp.name;
      data.realName = targetInfo.emp.realName;
      const verificationResult = getSigningVerification(data, 'kpi');
      if (verificationResult.error) {
        appendSignatureAudit(req, 'SIGNATURE_REJECTED', {
          documentType: 'kpi', empId: data.empId, name: data.name, realName: data.realName, month: data.month,
          details: { reason: verificationResult.error }
        });
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: verificationResult.error }));
        return;
      }
      const signatureError = validateStandardSignature(data, targetInfo && targetInfo.emp);
      if (signatureError) {
        appendSignatureAudit(req, 'SIGNATURE_REJECTED', {
          documentType: 'kpi', empId: data.empId, name: data.name, realName: data.realName, month: data.month,
          details: { reason: signatureError }
        });
        res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: signatureError }));
        return;
      }
      data.signatureValidated = true;
      protectSignedDocument('kpi', data, verificationResult.verification, req);
      setAssessmentRecord(kpiData, data);
      fs.writeFileSync(KPI_DATA_FILE, JSON.stringify(kpiData, null, 2), 'utf8');
      const targetDraft = kpiTargetDrafts[assessmentKey(data.empId, data.month)];
      if (targetDraft) {
        targetDraft.targetSignedAt = data.archivedAt;
        targetDraft.targetArchiveFile = data.archiveFile;
        targetDraft.targetArchiveHash = data.integrity && data.integrity.finalDocumentHash || '';
        if (targetDraft.isTargetAdjustment) targetDraft.adjustmentCompletedAt = data.archivedAt;
        saveKpiTargetDrafts();
      }
      if (targetInfo) {
        targetInfo.targetSignedAt = data.archivedAt;
        targetInfo.targetArchiveFile = data.archiveFile;
        targetInfo.targetArchiveHash = data.integrity && data.integrity.finalDocumentHash || '';
        if (targetInfo.isTargetAdjustment) targetInfo.adjustmentCompletedAt = data.archivedAt;
        fs.writeFileSync(KPI_TARGETS_FILE, JSON.stringify(kpiTargets, null, 2), { encoding: 'utf8', mode: 0o640 });
      }
      verificationResult.verification.used = true;
      signingVerifications.delete(verificationResult.token);
      console.log('[' + new Date().toLocaleString() + '] KPI confirm: ' + data.name + ' signed at ' + data.signedAt);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, archiveFile: data.archiveFile, archivedAt: data.archivedAt,
        integrity: data.integrity, auditEventHash: data.auditEventHash }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'POST' && req.url === '/submit-result') {
    try {
      const data = JSON.parse(await readBody(req));
      if (rejectSealedWorkflow(res, data.empId, data.month)) return;
      if (rejectSignedDocument(res, 'result', data.empId, data.month)) return;
      if (!data.empId || !data.doc) { res.writeHead(400); res.end('{"error":"Missing empId or doc"}'); return; }
      const targetInfo = kpiTargets[data.empId + '|' + data.month];
      if (!targetInfo || !targetInfo.emp || !validBpCompletionRecord(data.empId, data.month)) { res.writeHead(409); res.end('{"error":"Valid BP approval is required before result confirmation"}'); return; }
      assertCanonicalAssessmentSubject(data.empId, targetInfo.emp, '绩效结果签字');
      data.name = targetInfo.emp.name;
      data.realName = targetInfo.emp.realName;
      const verificationResult = getSigningVerification(data, 'result');
      if (verificationResult.error) {
        appendSignatureAudit(req, 'SIGNATURE_REJECTED', {
          documentType: 'result', empId: data.empId, name: data.name, realName: data.realName, month: data.month,
          details: { reason: verificationResult.error }
        });
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: verificationResult.error }));
        return;
      }
      const signatureError = validateStandardSignature(data, targetInfo && targetInfo.emp);
      if (signatureError) {
        appendSignatureAudit(req, 'SIGNATURE_REJECTED', {
          documentType: 'result', empId: data.empId, name: data.name, realName: data.realName, month: data.month,
          details: { reason: signatureError }
        });
        res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: signatureError }));
        return;
      }
      data.signatureValidated = true;
      protectSignedDocument('result', data, verificationResult.verification, req, { archive: false });
      data.sealed = false;
      data.bpReviewStatus = 'pending';
      data.bpReviewRequestedAt = data.serverSignedAt;
      setAssessmentRecord(resultData, data);
      fs.writeFileSync(RESULT_DATA_FILE, JSON.stringify(resultData, null, 2), 'utf8');
      verificationResult.verification.used = true;
      signingVerifications.delete(verificationResult.token);
      console.log('[' + new Date().toLocaleString() + '] Result confirm: ' + data.name + ' signed at ' + data.signedAt);
      const bpName = String(targetInfo.emp.hrbp || '薏米');
      const bpUserId = findUserId(bpName);
      let notification = { sent: false, queued: false, error: '' };
      if (bpUserId) {
        const employeeLabel = periodEmployeeLabel({ ...targetInfo.emp, month: data.month });
        notification = await deliverNotification({
          type: 'message', viaBot: true, userId: bpUserId,
          title: '绩效结果复核归档 - ' + employeeLabel,
          text: employeeLabel + '已完成绩效结果签字确认。\n\nBP复核页面：' + publicLink(resultBpReviewRoute(data.empId, data.month)) + '\n\n请核对绩效结果，确认无误后完成正式归档。'
        });
      } else notification.error = '未找到BP钉钉账号：' + bpName;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, pendingBpReview: true, employeeSignedAt: data.employeeSignedAt, bpReviewer: bpName, notification }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'POST' && pathname === '/review-result-bp') {
    try {
      const data = JSON.parse(await readBody(req));
      if (!isValidWorkflowAction(data, 'result-bp-final')) throw new Error('BP复核链接无效或已失效');
      const empId = String(data.empId || '').trim();
      const month = String(data.month || '').trim();
      const record = getAssessmentRecord(resultData, empId, month);
      if (!record || !record.doc) throw new Error('未找到员工签署的绩效结果');
      if (record.sealed === true && record.archiveFile) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, alreadyArchived: true, archiveFile: record.archiveFile, archivedAt: record.archivedAt }));
        return;
      }
      if (record.bpReviewStatus !== 'pending') throw new Error('当前绩效结果不处于待BP复核状态');
      const verification = verifyPendingSignedRecord('result', record);
      if (!verification.valid) throw new Error(verification.error);
      const targetInfo = kpiTargets[assessmentKey(empId, month)];
      if (!targetInfo || !targetInfo.emp || !validBpCompletionRecord(empId, month)) throw new Error('BP评分数据不完整，不能归档');
      const reviewer = String(data.reviewer || targetInfo.emp.hrbp || '薏米').trim();
      const reviewedAt = new Date().toISOString();
      record.doc = appendBpArchiveStamp(record.doc, record, reviewer, reviewedAt);
      record.integrity.finalDocumentHash = sha256(record.doc);
      record.bpReviewStatus = 'approved';
      record.bpReviewedBy = reviewer;
      record.bpReviewedAt = reviewedAt;
      record.sealed = true;
      record.sealedAt = reviewedAt;
      const audit = appendSignatureAudit(req, 'RESULT_BP_ARCHIVED', {
        documentType: 'result', empId, name: record.name, realName: record.realName, month,
        details: { reviewer, employeeSignedAt: record.employeeSignedAt, finalDocumentHash: record.integrity.finalDocumentHash }
      });
      record.auditEventHash = audit.eventHash;
      record.archiveFile = archiveSignedDocument('result', record, record.integrity, audit);
      record.archivedAt = reviewedAt;
      setAssessmentRecord(resultData, record);
      fs.writeFileSync(RESULT_DATA_FILE, JSON.stringify(resultData, null, 2), 'utf8');
      const oaApproval = await maybeSubmitDepartmentOa(empId, month, targetInfo.emp.dept);
      const employeeUserId = findUserId(targetInfo.emp.name);
      if (employeeUserId) await deliverNotification({
        type: 'message', viaBot: true, userId: employeeUserId,
        title: '绩效结果已复核归档 - ' + periodEmployeeLabel({ ...targetInfo.emp, month }),
        text: periodEmployeeLabel({ ...targetInfo.emp, month }) + '的绩效结果已由BP核对无误并正式归档。'
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, archiveFile: record.archiveFile, archivedAt: record.archivedAt, oaApproval }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/reject-signature') {
    try {
      const data = JSON.parse(await readBody(req));
      const empId = String(data.empId || '').trim();
      const month = String(data.month || '').trim();
      const documentType = data.type === 'result' ? 'result' : 'kpi';
      const reason = String(data.reason || '').trim();
      if (!empId || !reason) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '员工和打回原因不能为空' }));
        return;
      }
      if (!requireEmployeeAccess(req, res, empId)) return;
      const store = documentType === 'result' ? resultData : kpiData;
      const record = getAssessmentRecord(store, empId, month);
      if (!record || !record.doc) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '未找到可打回的已签署记录' }));
        return;
      }

      const preservedArchiveFile = String(record.archiveFile || '');
      const previousDocumentHash = String(record.integrity && record.integrity.finalDocumentHash || '');
      appendSignatureAudit(req, 'SIGNATURE_REJECTED_BY_ADMIN', {
        documentType, empId, name: record.name, realName: record.realName, month: record.month,
        details: { reason, preservedArchiveFile, previousDocumentHash }
      });
      deleteAssessmentRecord(store, empId, record.month || month);
      const targetFile = documentType === 'result' ? RESULT_DATA_FILE : KPI_DATA_FILE;
      fs.writeFileSync(targetFile, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o640 });

      const pagePath = documentType === 'result'
        ? '/result-page/' + encodeURIComponent(empId) + '/' + encodeURIComponent(record.month || month)
        : '/kpi-confirm-page/' + Buffer.from(String(empId) + '|' + String(record.month || month), 'utf8').toString('base64url');
      const label = documentType === 'result' ? '绩效结果确认' : '绩效目标确认';
      const employeeLabel = periodEmployeeLabel(record);
      let delivery = { sent: false, queued: false, error: '未找到员工钉钉账号' };
      const userId = findUserId(record.name);
      if (userId) {
        delivery = await enqueueBotMessage(userId, '签名打回重签 - ' + employeeLabel,
          employeeLabel + '的' + label + '签名未通过审核。\n\n' +
          '打回原因：' + reason + '\n\n' +
          '重新签署页面：' + publicLink(pagePath) + '\n\n' +
          '请本人重新完成钉钉验证码验证，并在分字框内用楷体逐字手写真实姓名。');
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true, empId, documentType, reason, preservedArchiveFile,
        reSignUrl: publicLink(pagePath), delivery
      }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(filterAssessmentMapForProfile(evalData, req.accessProfile)));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/data/')) {
    const parts = pathname.split('/').filter(Boolean);
    const empId = decodeURIComponent(parts[1] || '');
    const month = parts[2] ? decodeURIComponent(parts[2]) : '';
    if (!requireEmployeeAccess(req, res, empId)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAssessmentRecord(evalData, empId, month) || null));
    return;
  }
  if (req.method === 'GET' && req.url === '/mgr-data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(filterAssessmentMapForProfile(mgrData, req.accessProfile)));
    return;
  }
  if (req.method === 'GET' && req.url === '/bp-data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(filterAssessmentMapForProfile(bpData, req.accessProfile)));
    return;
  }
  if (req.method === 'GET' && pathname === '/kpi-data') {
    const summary = new URL(req.url, 'http://localhost').searchParams.get('summary') === '1';
    const permittedKpiData = filterAssessmentMapForProfile(kpiData, req.accessProfile);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary ? summarizeAssessmentMap(permittedKpiData) : permittedKpiData));
    return;
  }
  if (req.method === 'GET' && req.url === '/kpi-targets') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(filterAssessmentMapForProfile(kpiTargets, req.accessProfile)));
    return;
  }
  if (req.method === 'GET' && pathname === '/result-data') {
    const summary = new URL(req.url, 'http://localhost').searchParams.get('summary') === '1';
    const permittedResultData = filterAssessmentMapForProfile(resultData, req.accessProfile);
    const currentResultData = Object.fromEntries(Object.entries(permittedResultData).filter(([key, record]) => {
      const empId = String(record && record.empId || key.split('|')[0] || '').trim();
      const month = String(record && record.month || key.split('|')[1] || '').trim();
      return Boolean(empId && month && validBpCompletionRecord(empId, month) && isSignedRecord(record, month));
    }).map(([key, record]) => {
      const empId = String(record && record.empId || key.split('|')[0] || '').trim();
      const month = String(record && record.month || key.split('|')[1] || '').trim();
      return [key, {
        ...record,
        bpReviewLink: canPerformBpResultInBackend(req.accessProfile) && record && record.bpReviewStatus === 'pending' && record.sealed !== true
          ? publicLink(resultBpReviewRoute(empId, month))
          : ''
      }];
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary ? summarizeAssessmentMap(currentResultData) : currentResultData));
    return;
  }
  if (req.method === 'GET' && pathname === '/workflow-resets') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ resets: filterAssessmentMapForProfile(workflowResets, req.accessProfile) }));
    return;
  }
  if (req.method === 'POST' && pathname === '/workflow-resets') {
    if (!requireGlobalAccess(req, res)) return;
    try {
      const data = JSON.parse(await readBody(req));
      const empId = String(data.empId || '').trim();
      if (!empId) { res.writeHead(400); res.end('{"error":"Missing empId"}'); return; }
      if (data.clear === true) delete workflowResets[empId];
      else workflowResets[empId] = { resetAt: new Date().toISOString(), reason: String(data.reason || '管理员重置测试流程') };
      fs.writeFileSync(WORKFLOW_RESETS_FILE, JSON.stringify(workflowResets, null, 2), { encoding: 'utf8', mode: 0o640 });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, empId, reset: workflowResets[empId] || null }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (req.method === 'GET' && pathname === '/oa-approval-status') {
    const approvals = Object.fromEntries(Object.entries(oaApprovalData).filter(([key, record]) => {
      const groupKey = String(record && (record.approvalGroupKey || record.department) || key.split('|').slice(1).join('|')).trim();
      return canAccessApprovalGroup(req.accessProfile, groupKey);
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ channel: dingTalkOa.status(), approvals }));
    return;
  }
  if (req.method === 'POST' && pathname === '/oa-approval-retry') {
    try {
      const data = JSON.parse(await readBody(req));
      const key = oaApprovalKey(data.month, data.department);
      const record = oaApprovalData[key];
      if (!record || !record.snapshot) { res.writeHead(404); res.end('{"error":"OA approval record not found"}'); return; }
      if (!canAccessApprovalGroup(req.accessProfile, record.approvalGroupKey || record.department || data.department)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"无权操作该审批组"}');
        return;
      }
      if (record.status === 'submitted') { res.writeHead(409); res.end('{"error":"OA approval already submitted"}'); return; }
      const result = await submitDepartmentOaSnapshot(record.snapshot, true);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: result.status === 'submitted', approval: result }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (req.method === 'GET' && pathname === '/signature-audit') {
    const verification = verifySignatureAuditChain();
    let empId = '';
    try { empId = new URL(req.url, 'http://localhost').searchParams.get('empId') || ''; } catch (_) {}
    if (!empId && !requireGlobalAccess(req, res)) return;
    if (empId && !requireEmployeeAccess(req, res, empId)) return;
    const entries = empId ? verification.entries.filter(entry => entry.empId === empId) : verification.entries;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ chainValid: verification.valid, count: entries.length, entries: entries.slice(-1000) }));
    return;
  }
  if (req.method === 'GET' && pathname === '/verify-signature-integrity') {
    let type = 'kpi';
    let empId = '';
    let month = '';
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      type = params.get('type') === 'result' ? 'result' : 'kpi';
      empId = params.get('empId') || '';
      month = params.get('month') || '';
    } catch (_) {}
    if (!requireEmployeeAccess(req, res, empId)) return;
    const record = getAssessmentRecord(type === 'result' ? resultData : kpiData, empId, month);
    if (!record) { res.writeHead(404); res.end('{"error":"Signed record not found"}'); return; }
    const result = verifySignedRecord(type, record);
    const audit = verifySignatureAuditChain();
    res.writeHead(result.valid && audit.valid ? 200 : 409, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...result, auditChainValid: audit.valid, auditEventHash: record.auditEventHash || '' }));
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/mgr-page/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    const parts = pathname.split('/').filter(Boolean);
    const empId = decodeURIComponent(parts[1] || '');
    const month = parts[2] ? decodeURIComponent(parts[2]) : '';
    const selfInfo = getAssessmentRecord(evalData, empId, month);
    const sealedRecord = sealedWorkflowRecord(empId, selfInfo && selfInfo.month);
    if (sealedRecord) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(sealedNoticeHtml(sealedRecord));
      return;
    }
    if (!selfInfo) {
      res.writeHead(404); res.end('Manager scoring data not found for: ' + empId);
      return;
    }
    const pagePath = personalizeScoringPage(selfInfo.name, selfInfo);
    if (!pagePath || !fs.existsSync(pagePath)) {
      res.writeHead(500); res.end('Manager scoring page could not be generated');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(pagePath, 'utf8'));
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/bp-page/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    const parts = pathname.split('/').filter(Boolean);
    const empId = decodeURIComponent(parts[1] || '');
    const month = parts[2] ? decodeURIComponent(parts[2]) : '';
    const selfInfo = getAssessmentRecord(evalData, empId, month);
    const managerInfo = getAssessmentRecord(mgrData, empId, selfInfo && selfInfo.month || month);
    const sealedRecord = sealedWorkflowRecord(empId, selfInfo && selfInfo.month);
    if (sealedRecord) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(sealedNoticeHtml(sealedRecord));
      return;
    }
    if (!selfInfo || !managerInfo) {
      res.writeHead(404); res.end('BP review data not found for: ' + empId);
      return;
    }
    const pagePath = personalizeBpPage(selfInfo.name, selfInfo, managerInfo);
    if (!pagePath || !fs.existsSync(pagePath)) {
      res.writeHead(500); res.end('BP review page could not be generated');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(pagePath, 'utf8'));
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/result-page/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    const parts = pathname.split('/').filter(Boolean);
    const empId = decodeURIComponent(parts[1] || '');
    const month = parts[2] ? decodeURIComponent(parts[2]) : '';
    const resultSubject = getAssessmentRecord(evalData, empId, month) || getAssessmentRecord(bpData, empId, month) || getAssessmentRecord(resultData, empId, month) || {};
    appendSignatureAudit(req, 'SIGNING_PAGE_OPENED', {
      documentType: 'result', empId, name: resultSubject.name, realName: resultSubject.realName,
      month: resultSubject.month, details: { pathname }
    });
    const info = getAssessmentRecord(resultData, empId, resultSubject.month || month);
    if (info && info.doc) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(info.sealed === true && info.archiveFile ? archivedDocumentPreviewHtml(info.doc, 'result', info) : pendingResultPreviewHtml(info.doc));
    } else {
      // Generate on-the-fly if BP score exists
      var result = personalizeResultPage(empId, resultSubject.month || month);
      if (result) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
        res.end(fs.readFileSync(result.path, 'utf8'));
      } else {
        res.writeHead(404); res.end('No result confirmation found for: ' + empId);
      }
    }
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/result-bp-review-page/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    try {
      const decoded = Buffer.from(pathname.slice('/result-bp-review-page/'.length), 'base64url').toString('utf8');
      const [empId, month] = decoded.split('|');
      const record = getAssessmentRecord(resultData, empId, month);
      const targetInfo = kpiTargets[assessmentKey(empId, month)];
      if (!record || !record.doc || !targetInfo) { res.writeHead(404); res.end('Result awaiting BP review was not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(resultBpReviewPageHtml(record, targetInfo));
    } catch (error) { res.writeHead(400); res.end('Invalid BP review link'); }
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/kpi-page/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    const name = decodeURIComponent(pathname.split('/kpi-page/')[1]);
    const targetEntry = Object.entries(kpiTargets).filter(([, item]) => item && item.emp && item.emp.name === name).pop();
    const targetEmpId = targetEntry ? targetEntry[0].split('|')[0] : '';
    const signedTarget = targetEntry ? signedDocumentRecord('kpi', targetEmpId, targetEntry[1].month) : null;
    if (targetEntry) appendSignatureAudit(req, 'SIGNING_PAGE_OPENED', {
      documentType: 'kpi', empId: targetEmpId, name: targetEntry[1].emp.name,
      realName: targetEntry[1].emp.realName, month: targetEntry[1].month, details: { pathname }
    });
    if (signedTarget) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(archivedDocumentPreviewHtml(signedTarget.doc, 'kpi', signedTarget));
      return;
    }
    console.log('[kpi-page] Request for:', name);
    let generatedPath = path.join(GENERATED_DIR, 'KPI\u76ee\u6807\u786e\u8ba4_' + name + '.html');
    try { generatedPath = refreshStoredKpiPage(name) || generatedPath; } catch (error) { console.warn('[kpi-page] Refresh failed:', error.message); }
    const pagePath = fs.existsSync(generatedPath) ? generatedPath : path.join(PAGES_DIR, 'KPI\u76ee\u6807\u786e\u8ba4_' + name + '.html');
    console.log('[kpi-page] Looking for:', pagePath);
    if (fs.existsSync(pagePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(fs.readFileSync(pagePath, 'utf8'));
    } else {
      res.writeHead(404); res.end('KPI page not found: ' + name + ' (path: ' + pagePath + ')');
    }
    return;
  }
  // Base64-encoded name route: avoids DingTalk URL truncation of Chinese chars
  if (req.method === 'GET' && pathname.startsWith('/kpi-page-b64/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    const b64 = pathname.split('/kpi-page-b64/')[1];
    let name;
    try { name = Buffer.from(b64, 'base64').toString('utf8'); } catch(e) { name = ''; }
    const targetEntry = Object.entries(kpiTargets).filter(([, item]) => item && item.emp && item.emp.name === name).pop();
    const targetEmpId = targetEntry ? targetEntry[0].split('|')[0] : '';
    const signedTarget = targetEntry ? signedDocumentRecord('kpi', targetEmpId, targetEntry[1].month) : null;
    if (targetEntry) appendSignatureAudit(req, 'SIGNING_PAGE_OPENED', {
      documentType: 'kpi', empId: targetEmpId, name: targetEntry[1].emp.name,
      realName: targetEntry[1].emp.realName, month: targetEntry[1].month, details: { pathname }
    });
    if (signedTarget) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(archivedDocumentPreviewHtml(signedTarget.doc, 'kpi', signedTarget));
      return;
    }
    console.log('[kpi-page-b64] Decoded name:', name, 'from b64:', b64);
    let generatedPath = path.join(GENERATED_DIR, 'KPI\u76ee\u6807\u786e\u8ba4_' + name + '.html');
    try { generatedPath = refreshStoredKpiPage(name) || generatedPath; } catch (error) { console.warn('[kpi-page-b64] Refresh failed:', error.message); }
    const pagePath = fs.existsSync(generatedPath) ? generatedPath : path.join(PAGES_DIR, 'KPI\u76ee\u6807\u786e\u8ba4_' + name + '.html');
    if (fs.existsSync(pagePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(fs.readFileSync(pagePath, 'utf8'));
    } else {
      res.writeHead(404); res.end('KPI page not found: ' + name + ' (path: ' + pagePath + ')');
    }
    return;
  }
  // Month-scoped KPI confirmation route used by the employee self-fill flow.
  // The previous name-only route could open another month when several periods existed.
  if (req.method === 'GET' && pathname.startsWith('/kpi-confirm-page/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    const b64 = pathname.split('/kpi-confirm-page/')[1];
    let decoded = '';
    try { decoded = Buffer.from(b64, 'base64').toString('utf8'); } catch (_) {}
    const [empId, month] = decoded.split('|');
    const targetEntry = kpiTargets[assessmentKey(empId, month)];
    if (!targetEntry || !targetEntry.emp || !Array.isArray(targetEntry.kpis) || !targetEntry.kpis.length) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('未找到该员工对应月份的绩效目标。');
      return;
    }
    appendSignatureAudit(req, 'SIGNING_PAGE_OPENED', {
      documentType: 'kpi', empId, name: targetEntry.emp.name,
      realName: targetEntry.emp.realName, month, details: { pathname }
    });
    const signedTarget = signedDocumentRecord('kpi', empId, month);
    if (signedTarget) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(archivedDocumentPreviewHtml(signedTarget.doc, 'kpi', signedTarget));
      return;
    }
    try {
      const pagePath = generateStoredKpiConfirmationPage({ empId, emp: targetEntry.emp, kpis: targetEntry.kpis, month, targetAdjustments: targetEntry.targetAdjustments });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(fs.readFileSync(pagePath, 'utf8'));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('目标签字确认页面生成失败：' + escapeHtml(error.message));
    }
    return;
  }
  // Self-evaluation page route - generates dynamic form from stored KPI targets
  if (req.method === 'GET' && pathname.startsWith('/selfeval-page/')) {
    if (!isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return; }
    const b64 = pathname.split('/selfeval-page/')[1];
    let decoded = '';
    try { decoded = Buffer.from(b64, 'base64').toString('utf8'); } catch(e) { decoded = ''; }
    const [empId, month] = decoded.split('|');
    const sealedRecord = sealedWorkflowRecord(empId, month);
    if (sealedRecord) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(sealedNoticeHtml(sealedRecord));
      return;
    }
    const key = empId + '|' + month;
    const targetData = kpiTargets[key];
    if (!targetData) {
      res.writeHead(404); res.end('自评页面未找到，请确认已提交KPI目标。 (key: ' + key + ')');
      return;
    }
    const signedTarget = getAssessmentRecord(kpiData, empId, month);
    if (!signedTarget || !signedTarget.doc) {
      res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>暂不能自评</title><body style="font-family:sans-serif;padding:40px">绩效目标尚未完成本人签字归档，暂不能进行自评。</body></html>');
      return;
    }
    const emp = targetData.emp;
    const kpis = targetData.kpis;
    const monthShort = month.replace(/20/, '');
    const scoringUnits = scoringUnitsForKpis(kpis);
    const unitsByParent = new Map();
    scoringUnits.forEach(unit => {
      if (!unitsByParent.has(unit.parentSeq)) unitsByParent.set(unit.parentSeq, []);
      unitsByParent.get(unit.parentSeq).push(unit);
    });
    const kpiRows = kpis.map((k, i) => {
      const parentSeq = Number(k.seq) || i + 1;
      const units = unitsByParent.get(parentSeq) || [];
      const scoreInputs = units.map((unit, unitIndex) => {
        const label = unit.grouped ? '<div class="score-item-label">' + (unitIndex + 1) + '. ' + escapeHtml(unit.indicator) + ' <span>' + escapeHtml(unit.max) + '%</span></div>' : '';
        return '<div class="score-item">' + label + '<input type="number" class="score-input" data-seq="' + unit.seq + '" data-parent-seq="' + parentSeq + '" data-weight="' + escapeHtml(unit.max) + '" min="0" step="1" inputmode="numeric" placeholder="请输入整数分" title="只允许整数；单项不设上限，整表总分不得超过120分" disabled><div class="score-hint">仅限整数 · 单项不设上限</div></div>';
      }).join('');
      const completionInputs = units.map((unit, unitIndex) => {
        const label = unit.grouped ? '<div class="completion-item-label">' + (unitIndex + 1) + '. ' + escapeHtml(unit.indicator) + ' <span>' + escapeHtml(unit.max) + '%</span></div>' : '';
        return '<div class="completion-item">' + label + '<textarea class="note-input" data-seq="' + unit.seq + '" data-parent-seq="' + parentSeq + '" rows="3" placeholder="请填写本考核项的实际完成情况"></textarea></div>';
      }).join('');
      const groupTotal = units.length > 1 ? '<div class="score-group-total">本指标合计：<strong data-parent-total="' + parentSeq + '">0</strong><br><span>整表总分上限120分</span></div>' : '';
      return '<tr><td class="seq-cell">' + (i+1) + '</td><td class="indicator-cell">' + renderKpiIndicatorHtml(k) + '</td><td class="rule-cell">' + renderKpiTargetHtml(k) + '</td><td class="source-cell">' + renderKpiSourceHtml(k) + '</td><td class="weight-cell">' + escapeHtml(k.weight) + '%</td><td class="completion-cell"><div class="completion-items">' + completionInputs + '</div></td><td class="score-cell"><div class="score-items">' + scoreInputs + '</div>' + groupTotal + '</td></tr>';
    }).join('\n');
    const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
      '<title>' + monthShort + '绩效自评 - ' + emp.name + '</title>' +
      '<style>' +
      '*{box-sizing:border-box}' +
      'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px;margin:0;color:#1a1a1a;background:#f1f5f9}' +
      '.page{width:min(1320px,100%);margin:0 auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 8px 28px rgba(15,23,42,.08)}' +
      'h1{font-size:18px;text-align:center;margin-bottom:4px}' +
      '.sub{text-align:center;font-size:13px;color:#666;margin-bottom:20px}' +
      '.info{display:flex;justify-content:space-between;padding:12px 16px;background:#f8f9fa;border-radius:8px;margin-bottom:16px;font-size:14px}' +
      '.table-wrap{width:100%;overflow-x:auto;border:1px solid #dbeafe;border-radius:12px;margin-bottom:18px}' +
      'table{width:100%;min-width:1160px;table-layout:fixed;border-collapse:collapse;font-size:13px}' +
      'th{background:#eff6ff;color:#1d4ed8;font-weight:700;padding:12px 10px;text-align:left;border-bottom:2px solid #bfdbfe;white-space:nowrap}' +
      'td{padding:13px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;line-height:1.6;overflow-wrap:anywhere}' +
      'tbody tr:nth-child(even){background:#fafcff}tbody tr:hover{background:#f8fbff}' +
      '.seq-cell,.weight-cell,.score-cell{text-align:center}.seq-cell{color:#64748b}.weight-cell{color:#2563eb;font-weight:700;white-space:nowrap}' +
      '.indicator-cell{font-size:14px}.rule-cell{color:#475569}.source-cell{color:#334155}.source-cell div{white-space:normal!important;word-break:break-word!important}' +
      '.score-input{width:76px;padding:9px 7px;border:1px solid #94a3b8;border-radius:7px;text-align:center;font-size:14px;background:#fff}' +
      '.score-items,.completion-items{display:grid;gap:8px}.score-item,.completion-item{padding:7px 5px;border-radius:7px;background:#f8fafc}.score-item+.score-item,.completion-item+.completion-item{border-top:1px solid #dbeafe}' +
      '.score-item-label{margin-bottom:5px;color:#334155;font-size:11px;font-weight:650;line-height:1.35;text-align:left}.score-item-label span{color:#2563eb;white-space:nowrap}' +
      '.completion-item-label{margin-bottom:6px;color:#334155;font-size:11px;font-weight:650;line-height:1.35}.completion-item-label span{color:#2563eb;white-space:nowrap}' +
      '.score-group-total{margin-top:8px;padding-top:7px;border-top:1px solid #bfdbfe;color:#475569;font-size:11px;white-space:nowrap}.score-group-total strong{color:#1d4ed8;font-size:13px}.score-group-total span{color:#94a3b8}' +
      '.note-input{width:100%;min-height:78px;padding:9px 10px;border:1px solid #cbd5e1;border-radius:7px;font-family:inherit;font-size:13px;line-height:1.55;resize:vertical;background:#fff}' +
      '.score-input:focus,.note-input:focus{border-color:#2563eb;outline:none;box-shadow:0 0 0 3px rgba(37,99,235,.12)}' +
      '.score-input:disabled{background:#f1f5f9;color:#94a3b8;cursor:not-allowed}' +
      '.score-hint{margin-top:5px;color:#94a3b8;font-size:11px;white-space:nowrap}' +
      '.total-row{background:#f8f9fa;font-weight:600}' +
      '.total-row td{border-top:2px solid #bfdbfe;border-bottom:0}' +
      '#totalScore{color:#1a73e8;font-size:18px;font-weight:700}.provisional-grade{display:block;margin-top:3px;color:#2563eb;font-size:11px;font-weight:700;white-space:nowrap}' +
      '.sig-area{margin-top:20px;padding:16px;border-top:2px solid #e5e7eb;text-align:center}' +
      'canvas{border:2px dashed #ccc;border-radius:8px;background:#fafbfc;display:block;margin:10px auto;touch-action:none}' +
      '.btn{padding:10px 24px;border:none;border-radius:6px;font-size:14px;cursor:pointer;margin:4px}' +
      '.btn-primary{background:#1a73e8;color:#fff}.btn-primary:hover{background:#1557b0}' +
      '.btn-secondary{background:#f1f3f4;color:#333}.btn-secondary:hover{background:#e0e2e4}' +
      '.btn:disabled{opacity:0.5;cursor:not-allowed}' +
      '.footer{text-align:center;margin-top:24px;font-size:11px;color:#bbb;border-top:1px solid #f0f0f0;padding-top:12px}' +
      '.success-msg{text-align:center;padding:40px 20px;color:#059669}' +
      '.success-msg h2{margin-bottom:8px}' +
      workflowReminderCss() +
      '@media(max-width:760px){body{padding:0}.page{border-radius:0;padding:18px 12px;box-shadow:none}.info{align-items:flex-start;gap:12px}.table-wrap{border-radius:8px}table{min-width:1080px}}' +
      '</style></head><body><main class="page">' +
      '<h1>' + monthShort + '绩效自评</h1>' +
      '<div class="sub">杭州飞途行远 · ' + month + '</div>' +
      '<div class="info"><div><strong>' + emp.name + '（' + emp.realName + '）</strong><br><span style="color:#666;font-size:13px">' + emp.dept + ' · ' + emp.position + '</span></div>' +
      '<div style="text-align:right"><span style="font-size:12px;color:#999">直属上级</span><br><strong>' + emp.directMgr + '</strong></div></div>' +
      '<div id="formArea">' +
      '<div class="table-wrap"><table><thead><tr><th style="width:46px;text-align:center">#</th><th style="width:170px">考核指标</th><th>评分细则</th><th style="width:180px">数据来源</th><th style="width:70px;text-align:center">权重</th><th style="width:250px">实际完成情况</th><th style="width:150px;text-align:center">自评分（分项）</th></tr></thead>' +
      '<tbody>' + kpiRows + '</tbody>' +
      '<tfoot><tr class="total-row"><td colspan="3">自评总分</td><td></td><td style="text-align:center;color:#1a73e8">100%</td><td></td><td style="text-align:center"><span id="totalScore">0</span><span class="provisional-grade" id="selfProvisionalGrade">等级：D（待核定）</span></td></tr></tfoot></table></div>' +
      workflowReminderHtml() +
      '<div class="sig-area"><p style="font-weight:600;margin-bottom:8px">请在下方签名确认</p>' +
      '<canvas id="sigCanvas" width="400" height="120"></canvas>' +
      '<div><button class="btn btn-secondary" id="clearSig">清除重签</button></div></div>' +
      '<div style="text-align:center;margin-top:20px">' +
      '<button class="btn btn-primary" id="submitBtn" disabled>提交自评</button></div>' +
      '</div>' +
      '<div id="successArea" class="success-msg" style="display:none"><h2>✅ 自评已提交</h2><p>感谢你的认真评估，上级将据此进行评分。</p></div>' +
      '<div class="footer">杭州飞途行远 · 绩效管理系统 · 本页面由系统生成</div>' +
      '<script>' +
      'const SERVER_URL=' + JSON.stringify(PUBLIC_SERVER_URL) + ';' +
      'const EMP_ID=' + JSON.stringify(empId) + ',EMP_NAME=' + JSON.stringify(emp.name) + ',EMP_REAL=' + JSON.stringify(emp.realName) + ',MONTH=' + JSON.stringify(month) + ',ACTION_TOKEN=' + JSON.stringify(workflowActionToken('self', empId, month)) + ';' +
      'const canvas=document.getElementById("sigCanvas"),ctx=canvas.getContext("2d");' +
      'let drawing=false,hasSig=false;' +
      'function getPos(e){const r=canvas.getBoundingClientRect();const t=e.touches?e.touches[0]:e;return{x:t.clientX-r.left,y:t.clientY-r.top}}' +
      'canvas.addEventListener("mousedown",e=>{drawing=true;ctx.beginPath();const p=getPos(e);ctx.moveTo(p.x,p.y)});' +
      'canvas.addEventListener("mousemove",e=>{if(!drawing)return;const p=getPos(e);ctx.lineTo(p.x,p.y);ctx.strokeStyle="#333";ctx.lineWidth=2;ctx.lineCap="round";ctx.stroke();hasSig=true;checkReady()});' +
      'canvas.addEventListener("mouseup",()=>drawing=false);' +
      'canvas.addEventListener("mouseleave",()=>drawing=false);' +
      'canvas.addEventListener("touchstart",e=>{e.preventDefault();drawing=true;ctx.beginPath();const p=getPos(e);ctx.moveTo(p.x,p.y)},{passive:false});' +
      'canvas.addEventListener("touchmove",e=>{e.preventDefault();if(!drawing)return;const p=getPos(e);ctx.lineTo(p.x,p.y);ctx.strokeStyle="#333";ctx.lineWidth=2;ctx.lineCap="round";ctx.stroke();hasSig=true;checkReady()},{passive:false});' +
      'canvas.addEventListener("touchend",()=>drawing=false);' +
      'document.getElementById("clearSig").onclick=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);hasSig=false;checkReady()};' +
      'function gradeForScore(score){if(score>110)return"A-";if(score>100)return"B+";if(score>90)return"B";if(score>80)return"B-";if(score>70)return"C";return"D"}' +
      'function calcTotal(){let t=0;document.querySelectorAll(".score-input").forEach(inp=>{t+=Number(inp.value)||0});document.querySelectorAll("[data-parent-total]").forEach(el=>{let subtotal=0;document.querySelectorAll(\'.score-input[data-parent-seq="\'+el.dataset.parentTotal+\'"]\').forEach(inp=>subtotal+=Number(inp.value)||0);el.textContent=subtotal});document.getElementById("totalScore").textContent=t;document.getElementById("selfProvisionalGrade").textContent="等级："+gradeForScore(t)+"（待核定）";return t}' +
      'function checkReady(){const total=calcTotal();const complete=[...document.querySelectorAll(".score-input")].every(inp=>{const note=document.querySelector(\'.note-input[data-seq="\'+inp.dataset.seq+\'"]\');const value=inp.value.trim();const score=Number(value);return note&&note.value.trim()&&value!==""&&Number.isInteger(score)&&score>=0});document.getElementById("submitBtn").disabled=!(complete&&hasSig&&Number.isInteger(total)&&total<=120)}' +
      'document.querySelectorAll(".score-input").forEach(inp=>inp.addEventListener("input",checkReady));' +
      'document.querySelectorAll(".note-input").forEach(note=>{const sync=()=>{const enabled=note.value.trim().length>0;const score=document.querySelector(\'.score-input[data-seq="\'+note.dataset.seq+\'"]\');if(score){score.disabled=!enabled;if(!enabled)score.value=""}checkReady()};note.addEventListener("input",sync);sync()});' +
      'document.getElementById("submitBtn").onclick=async()=>{' +
      '  const btn=document.getElementById("submitBtn");btn.disabled=true;btn.textContent="提交中...";' +
      '  const details=[];document.querySelectorAll(".score-input").forEach(inp=>{' +
      '    const seq=inp.dataset.seq;const noteInp=document.querySelector(\'.note-input[data-seq="\'+seq+\'"]\');' +
      '    details.push({seq:parseInt(seq),parentSeq:parseInt(inp.dataset.parentSeq),selfScore:Number(inp.value)||0,completion:noteInp?noteInp.value:\'\'});' +
      '  });' +
      '  const total=calcTotal();if(!Number.isInteger(total)||[...document.querySelectorAll(".score-input")].some(inp=>!Number.isInteger(Number(inp.value)))){alert("所有自评分必须为整数");btn.disabled=false;btn.textContent="提交自评";return}if(total>120){alert("自评总分不能超过120分");btn.disabled=false;btn.textContent="提交自评";return}' +
      '  const sigData=canvas.toDataURL("image/png");' +
      '  try{' +
      '    const r=await fetch(SERVER_URL+"/submit",{method:"POST",headers:{"Content-Type":"application/json"},' +
      '      body:JSON.stringify({empId:EMP_ID,name:EMP_NAME,realName:EMP_REAL,month:MONTH,selfScore:total,details,sigData,actionToken:ACTION_TOKEN})});' +
      '    const responseText=await r.text();let d={};try{d=JSON.parse(responseText)}catch(_){d={error:responseText}}if(!r.ok)throw new Error(d.error||("HTTP "+r.status));' +
      '    if(d.success){document.getElementById("formArea").style.display="none";const success=document.getElementById("successArea");success.style.display="block";const grade=gradeForScore(total);success.innerHTML="<h2>✅ 自评已提交</h2><p><strong>自评总分："+total+" 分</strong><br><strong>等级："+grade+"（待核定）</strong><br><small style=\\\"color:#64748b\\\">最终分数和等级以BP核准结果为准</small></p>";if(d.notification&&!d.notification.sent){success.innerHTML+="<p style=\\\"color:#9a3412\\\">上级评分网页链接未能通过钉钉发送，请联系管理员检查发送通道。</p>"}}' +
      '    else{alert("提交失败："+d.error);btn.disabled=false;btn.textContent="提交自评"}' +
      '  }catch(e){alert("网络错误，请重试："+e.message);btn.disabled=false;btn.textContent="提交自评"}' +
      '};' +
      '</script></main></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.method === 'GET' && req.url === '/queue') {
    if (!requireGlobalAccess(req, res)) return;
    let queue = [];
    try { if (fs.existsSync(QUEUE_FILE)) queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch(e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pending: queue.length, tasks: queue }));
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end('{"status":"ok"}');
    return;
  }
  if (req.method === 'GET' && req.url === '/ui-version') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
    res.end(JSON.stringify({ version: DASHBOARD_BUILD_ID }));
    return;
  }
  if (req.method === 'GET' && req.url === '/ping') {
    if (!requireGlobalAccess(req, res)) return;
    let q = 0;
    let directPending = 0;
    try { if (fs.existsSync(QUEUE_FILE)) q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')).length; } catch(e) {}
    try { if (fs.existsSync(PENDING_SENDS_FILE)) directPending = JSON.parse(fs.readFileSync(PENDING_SENDS_FILE, 'utf8')).length; } catch(e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', evalCount: Object.keys(evalData).length, mgrCount: Object.keys(mgrData).length, bpCount: Object.keys(bpData).length, kpiCount: Object.keys(kpiData).length, pendingNotifications: q + directPending, delivery: dingTalkSender.status(), directory: dingTalkDirectory.status(), oaApproval: dingTalkOa.status(), publicServerUrl: PUBLIC_SERVER_URL }));
    return;
  }

  if (req.method === 'GET' && req.url === '/delivery-status') {
    // This endpoint only exposes boolean capability flags. Every authenticated
    // department owner needs it before submitting KPI targets; restricting it
    // to global administrators caused a valid scoped session to be mistaken
    // for a missing DingTalk configuration in the dashboard.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...dingTalkSender.status(), directory: dingTalkDirectory.status(), publicServerUrl: PUBLIC_SERVER_URL }));
    return;
  }

  if (req.method === 'GET' && req.url === '/pending-count') {
    if (!requireGlobalAccess(req, res)) return;
    let pending = [];
    let notifications = [];
    try { if (fs.existsSync(PENDING_SENDS_FILE)) pending = JSON.parse(fs.readFileSync(PENDING_SENDS_FILE, 'utf8')); } catch(e) {}
    try { if (fs.existsSync(QUEUE_FILE)) notifications = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch(e) {}
    const allPending = pending.concat(notifications);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: allPending.length, ready: dingTalkSender.status().ready, messages: allPending.map(m => ({ type: m.type || 'message', userId: m.userId, title: m.title, createdAt: m.createdAt, lastError: m.lastError || null })) }));
    return;
  }

  // Generate personalized KPI confirmation pages for employees
  if (req.method === 'POST' && req.url === '/generate-kpi-pages') {
    if (!requireGlobalAccess(req, res)) return;
    try {
      const data = JSON.parse(await readBody(req));
      if (!data.pages || !Array.isArray(data.pages)) { res.writeHead(400); res.end('{"error":"Need pages array"}'); return; }
      const deniedPage = data.pages.find(page => page && page.empId && !canAccessEmployee(req.accessProfile, page.empId, page.emp));
      if (deniedPage) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '无权提交该员工所属部门的绩效目标', empId: String(deniedPage.empId) }));
        return;
      }
      const sealedPages = data.pages.filter(page => page && page.empId &&
        (sealedWorkflowRecord(page.empId, page.month) || signedDocumentRecord('kpi', page.empId, page.month)));
      if (sealedPages.length) {
        const blocked = sealedPages.map(page => ({
          empId: String(page.empId), name: String(page.emp && page.emp.name || ''), month: String(page.month || '')
        }));
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          error: '选中员工的绩效目标已签署归档或流程已封存，禁止重新提交',
          code: 'KPI_TARGETS_SEALED', sealed: true, blocked
        }));
        return;
      }
      const preparedDrafts = data.pages.map(page => {
        const empId = String(page && page.empId || '').trim();
        const month = String(page && page.month || '').trim();
        const emp = page && page.emp && typeof page.emp === 'object' ? page.emp : null;
        if (!empId || !month || !emp || !String(emp.name || '').trim()) throw new Error('缺少员工或考核月份');
        assertCanonicalAssessmentSubject(empId, emp, '提交绩效目标');
        const authoritativeEmp = authoritativeWorkflowEmployee(empId, emp);
        if (!authoritativeEmp.directMgr) throw new Error('员工“' + String(authoritativeEmp.name || empId) + '”尚未设置直属上级，不能提交目标确认');
        if (kpiTargets[assessmentKey(empId, month)]) throw new Error('员工“' + String(emp.name || empId) + '”当月已有正式目标，不能重复提交');
        const key = assessmentKey(empId, month);
        const previous = kpiTargetDrafts[key];
        if (previous && !(previous.source === 'admin-entry' && previous.status === 'rejected')) {
          throw new Error('员工“' + String(emp.name || empId) + '”已有进行中的目标确认流程，不能重复提交');
        }
        return {
          key,
          record: {
            empId, month,
            emp: authoritativeEmp,
            kpis: validateEmployeeTargetKpis(page.kpis, authoritativeEmp), source: 'admin-entry', status: 'submitted',
            submittedAt: new Date().toISOString(), reviewReason: '', rejectedBy: ''
          }
        };
      });
      preparedDrafts.forEach(item => { kpiTargetDrafts[item.key] = item.record; });
      saveKpiTargetDrafts();
      const draftNotifications = [];
      for (const item of preparedDrafts) {
        const record = item.record;
        const managerName = String(record.emp.directMgr || '').trim();
        const managerUserId = findUserId(managerName);
        const notification = managerUserId
          ? await enqueueBotMessage(managerUserId, '直属上级确认员工绩效目标 - ' + periodEmployeeLabel({ ...record.emp, month: record.month }),
            record.emp.name + '（' + record.emp.realName + '）的' + record.month + '绩效目标已由后台填写完成。\n\n请先核对指标、评分细则、数据来源和权重；确认通过后系统将自动发送BP继续确认。\n\n直属上级确认页面：' + publicLink(targetManagerReviewRoute(record.empId, record.month)))
          : { sent: false, queued: false, error: '未找到直属上级“' + managerName + '”的钉钉账号' };
        draftNotifications.push({ empId: record.empId, name: record.emp.name, managerName, ...notification });
      }
      const draftSent = draftNotifications.filter(item => item.sent).length;
      const draftQueued = draftNotifications.filter(item => item.queued).length;
      const draftFailed = draftNotifications.length - draftSent - draftQueued;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        success: true,
        generated: preparedDrafts.map(item => item.record.emp.name),
        status: 'submitted',
        nextNode: 'target-manager',
        notifications: draftNotifications,
        total: draftNotifications.length,
        sent: draftSent,
        queued: draftQueued,
        failed: draftFailed
      }));
      return;
      const templatePath = path.join(PAGES_DIR, 'KPI\u76ee\u6807\u786e\u8ba4_\u6851\u845a.html');
      let template = '';
      try { template = fs.readFileSync(templatePath, 'utf8'); } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Template not found' })); return; }

      const generated = [];
      for (const page of data.pages) {
        const emp = page.emp;
        const kpis = (Array.isArray(page.kpis) ? page.kpis : []).map(normalizeKpiDefinition);
        const month = page.month;
        const monthShort = month.replace(/20/, '');

        // Build rows once and inject them into both the interactive page and
        // the signed confirmation document embedded in its script.
        const kpiRows = kpis.map(k => '<tr><td>' + escapeHtml(k.seq) + '</td><td>' + renderKpiIndicatorHtml(k) + '</td><td>' + renderKpiTargetHtml(k) + '</td><td>' + renderKpiSourceHtml(k) + '</td><td style="color:#1a73e8;font-weight:600">' + escapeHtml(k.weight) + '%</td></tr>').join('\n');

        // Read template and personalize
        let html = template;
        const employeeLabel = escapeHtml(emp.name) + '\uff08' + escapeHtml(emp.realName) + '\uff09';
        const departmentLabel = escapeHtml(emp.dept) + ' \u00b7 ' + escapeHtml(emp.position);
        html = html.replace(/<title>KPI\u76ee\u6807\u786e\u8ba4[^<]*<\/title>/, '<title>KPI\u76ee\u6807\u786e\u8ba4 - ' + escapeHtml(emp.name) + '</title>');
        html = html.replace(/<title>KPI\u76ee\u6807\u786e\u8ba4\u4e66 - [^<]*<\/title>/g, '<title>KPI\u76ee\u6807\u786e\u8ba4\u4e66 - ' + escapeHtml(emp.name) + ' - ' + escapeHtml(month) + '</title>');
        html = html.replace(/<div class="name">[^<]+<\/div>/, '<div class="name">' + employeeLabel + '</div>');
        html = html.replace(/<div class="dept">[^<]+<\/div>/, '<div class="dept">' + departmentLabel + '</div>');
        html = html.replace(/(<div style="font-weight:500">)[^<]+(<\/div>)/, '$1' + escapeHtml(emp.directMgr) + '$2');
        html = html.replace(/<strong>[^<]*\uff08[^<]*\uff09<\/strong>/g, '<strong>' + employeeLabel + '</strong>');
        html = html.replace(/(<span style="color:#666;font-size:13px">)[^<]+(<\/span>)/g, '$1' + departmentLabel + '$2');
        html = html.replace(/(<span style="font-size:12px;color:#999">\u76f4\u5c5e\u4e0a\u7ea7<\/span><br><strong>)[^<]+(<\/strong>)/g, '$1' + escapeHtml(emp.directMgr) + '$2');
        // Some historic templates lost the opening <tbody>. Rebuild every KPI
        // table from </thead> to <tfoot> instead of relying on that tag.
        html = html.replace(/(<\/thead>)[\s\S]*?(<tfoot>)/g, '$1\n<tbody>\n' + kpiRows + '\n</tbody>\n$2');
        // Replace month references
        html = html.replace(/\u5df2\u9605\u8bfb\u5e76\u77e5\u6089\u4ee5\u4e0a\d+\u5e74\d+\u6708/, '\u5df2\u9605\u8bfb\u5e76\u77e5\u6089\u4ee5\u4e0a' + monthShort);
        // Replace in generateConfirmationHTML function
        html = html.replace(/(<h1>)\d+\u5e74\d+\u6708(KPI\u76ee\u6807\u786e\u8ba4\u4e66<\/h1>)/g, '$1' + monthShort + '$2');
        html = html.replace(/(\u676d\u5dde\u98de\u9014\u884c\u8fdc \u00b7 )\d+\u5e74\d+\u6708/g, '$1' + month);
        html = html.replace(/(<strong>)\u6851\u845a\uff08\u65bc\u601d\u65ed\uff09(<\/strong>)/g, '$1' + emp.name + '\uff08' + emp.realName + '\uff09$2');
        html = html.replace(/(\u4eba\u4e8b\u884c\u653f\u90e8 \u00b7 \u4eba\u4e8b\u884c\u653f\u4e13\u5458)/, emp.dept + ' \u00b7 ' + emp.position);
        html = html.replace(/(<strong>)\u5341\u53f6(<\/strong>)/g, '$1' + emp.directMgr + '$2');
        // Update metadata and use an absolute archive endpoint so downloaded
        // confirmation files can still submit their signatures.
        html = html.replace(/const EMP_META = \{[^}]+\};/, 'const EMP_META = ' + JSON.stringify({
          empId: page.empId || '', name: emp.name, realName: emp.realName,
          dept: emp.dept, position: emp.position, month
        }) + ';');
        html = html.replace(/fetch\(['"]\/submit-kpi['"]/, 'fetch(' + JSON.stringify(PUBLIC_SERVER_URL + '/submit-kpi'));

        const outputPath = path.join(GENERATED_DIR, 'KPI\u76ee\u6807\u786e\u8ba4_' + emp.name + '.html');
        fs.writeFileSync(outputPath, html, 'utf8');
        generated.push(emp.name);
        console.log('[kpi-page] Generated for ' + emp.name + ' (' + kpis.length + ' KPIs)');
        // Store KPI targets for self-eval page generation
        const empId = page.empId || '';
        if (empId) {
          kpiTargets[empId + '|' + month] = { emp, kpis, month };
        }
      }
      // Persist KPI targets
      fs.writeFileSync(KPI_TARGETS_FILE, JSON.stringify(kpiTargets, null, 2), 'utf8');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, generated }));
    } catch(e) {
      res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 员工花名册（从钉钉通讯录同步）
  if (req.method === 'GET' && pathname === '/employee-roster') {
    let roster = [];
    try { if (fs.existsSync(ROSTER_FILE)) roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8')); } catch(e) {}
    let source = 'cache';
    let warning = '';
    const rosterUrl = new URL(req.url, 'http://localhost');
    const refresh = rosterUrl.searchParams.get('refresh') === '1';
    const assessmentMonth = String(rosterUrl.searchParams.get('assessmentMonth') || '').trim();
    if (refresh && !requireGlobalAccess(req, res)) return;
    if (refresh) {
      try {
        roster = await dingTalkDirectory.syncRoster(roster);
        fs.writeFileSync(ROSTER_FILE, JSON.stringify(roster, null, 2), { encoding: 'utf8', mode: 0o640 });
        source = 'dingtalk-live';
      } catch (error) {
        warning = error.message || '钉钉通讯录实时同步失败，已返回最近一次缓存';
        console.error('[dingtalk-directory] Sync failed:', warning);
      }
    }
    // Only an explicit directory refresh can change monthly participation.
    // Ordinary page loads read the frozen assessment roster and never enroll a
    // newly discovered DingTalk user into an earlier month.
    ensureCanonicalAssessmentRoster(roster, {
      addMissing: refresh,
      updateMembership: refresh,
      assessmentMonth: refresh ? assessmentMonth : ''
    });
    const assessmentByName = new Map();
    const assessmentByRealName = new Map();
    const assessmentByUserId = new Map();
    if (Array.isArray(assessmentRoster)) assessmentRoster.forEach(employee => {
      if (!employee || !employee.id) return;
      if (employee.name) assessmentByName.set(String(employee.name), employee);
      if (employee.realName) assessmentByRealName.set(String(employee.realName), employee);
      if (employee.userId) assessmentByUserId.set(String(employee.userId), employee);
    });
    const directoryByUserId = new Map(roster.filter(employee => employee && employee.userId)
      .map(employee => [String(employee.userId), employee]));
    roster = assessmentRoster.filter(employee => employee && employee.id && !PERFORMANCE_ROSTER_EXCLUSIONS.has(employee.name)).map(assessmentEmployee => {
      const directoryEmployee = directoryByUserId.get(String(assessmentEmployee.userId || '')) || {};
      const nick = canonicalEmployeeNickname({
        ...directoryEmployee,
        realName: directoryEmployee.realName || assessmentEmployee.realName || '',
        name: assessmentEmployee.name || ''
      });
      const override = employeeOverrides[nick] || {};
      const rawDepartment = override.department || directoryEmployee.department || assessmentEmployee.department || assessmentEmployee.dept || '';
      const department = organizationDepartmentFor(nick, rawDepartment);
      return {
        ...directoryEmployee,
        nick,
        realName: directoryEmployee.realName || assessmentEmployee.realName || '',
        userId: directoryEmployee.userId || assessmentEmployee.userId || '',
        department,
        hrbp: organizationHrbpFor(nick, department, directoryEmployee.hrbp || assessmentEmployee.hrbp),
        ...override,
        department,
        // The DingTalk userId is not the assessment business key. Returning the
        // canonical ID prevents a cleared/local browser from creating a second
        // E-number for an employee who already exists in the assessment roster.
        assessmentId: String(assessmentEmployee.id),
        assessmentStartMonth: assessmentEmployee.assessmentStartMonth || '2026年6月',
        assessmentInactiveFromMonth: assessmentEmployee.assessmentInactiveFromMonth || '',
        directoryActive: Boolean(directoryEmployee && directoryEmployee.userId),
        title: FIXED_POSITION_BY_NAME[nick] || override.title || directoryEmployee.title || assessmentEmployee.position || '',
        active: true,
        _orgOverride: Object.keys(override).length > 0 || department !== String(rawDepartment || '').trim()
      };
    });
    roster = roster.filter(employee => canAccessDepartment(req.accessProfile, employee.department));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      employees: roster,
      syncedAt: roster.length > 0 ? roster[0].syncedAt : null,
      source,
      warning,
      directory: dingTalkDirectory.status()
    }));
    return;
  }

  // 可由员工管理页面维护的组织信息（当前支持直属上级和部门）。
  if (req.method === 'GET' && req.url === '/employee-overrides') {
    const visibleOverrides = Object.fromEntries(Object.entries(employeeOverrides).filter(([name]) => {
      const identityEntry = Object.entries(dashboardEmployeeIdentities()).find(([, identity]) => identity && identity.name === name);
      return identityEntry && canAccessEmployee(req.accessProfile, identityEntry[0], identityEntry[1]);
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(visibleOverrides));
    return;
  }

  if (req.method === 'GET' && req.url === '/performance-exclusions') {
    const visibleExcludedEmpIds = Array.from(performanceExclusions).filter(empId => canAccessEmployee(req.accessProfile, empId)).sort();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ excludedEmpIds: visibleExcludedEmpIds }));
    return;
  }

  if (req.method === 'POST' && req.url === '/performance-exclusions') {
    if (!requireGlobalAccess(req, res)) return;
    try {
      const data = JSON.parse(await readBody(req));
      if (Array.isArray(data.excludedEmpIds)) {
        performanceExclusions = new Set(data.excludedEmpIds.map(value => String(value || '').trim()).filter(Boolean));
      } else {
        const empId = String(data.empId || '').trim();
        if (!empId) throw new Error('缺少员工ID');
        if (data.excluded === false) performanceExclusions.delete(empId);
        else performanceExclusions.add(empId);
      }
      savePerformanceExclusions();
      const reconciled = await reconcileCompletedDepartmentOaApprovals();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, excludedEmpIds: Array.from(performanceExclusions).sort(), reconciled }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/employee-overrides') {
    if (!requireGlobalAccess(req, res)) return;
    try {
      const data = JSON.parse(await readBody(req));
      const name = String(data.name || '').trim();
      if (!name) { res.writeHead(400); res.end('{"error":"Missing employee name"}'); return; }
      const current = employeeOverrides[name] || {};
      const next = { ...current };
      if (Object.prototype.hasOwnProperty.call(data, 'directMgr')) next.directMgr = String(data.directMgr || '').trim();
      if (Object.prototype.hasOwnProperty.call(data, 'department')) next.department = String(data.department || '').trim();
      employeeOverrides[name] = next;
      fs.writeFileSync(EMPLOYEE_OVERRIDES_FILE, JSON.stringify(employeeOverrides, null, 2), 'utf8');
      repairWorkflowEmployeeSnapshots(kpiTargets, KPI_TARGETS_FILE, 'KPI targets');
      repairWorkflowEmployeeSnapshots(kpiTargetDrafts, KPI_TARGET_DRAFTS_FILE, 'KPI target drafts');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, employee: { name, ...next } }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // Send an authoritative reminder to the person responsible for the current
  // workflow node.  The client only supplies employee + month; the server
  // derives the current node and recipient from persisted workflow data.
  if (req.method === 'POST' && req.url === '/workflow-reminder') {
    try {
      const data = JSON.parse(await readBody(req));
      const empId = String(data.empId || '').trim();
      const month = String(data.month || '').trim();
      const requestedAction = String(data.action || '').trim();
      if (!empId || !month) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少员工或考核月份' })); return; }
      if (!requireEmployeeAccess(req, res, empId)) return;
      const context = workflowReminderContext(empId, month);
      if (context.complete) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '绩效结果已签字归档，无需催办', node: context.node, status: context.status }));
        return;
      }
      if (context.node === 'result-bp-final') {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: 'BP结果确认不使用催办；员工签字后系统已自动通知BP，请从后台点击“BP结果核对”进入处理',
          code: 'BP_RESULT_REVIEW_REMINDER_DISABLED', node: context.node, status: context.status
        }));
        return;
      }
      if (!context.recipientName) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '当前节点未配置' + context.recipientRole + '，无法发送催办', node: context.node, status: context.status }));
        return;
      }
      const userId = findUserId(context.recipientName);
      if (!userId) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '未找到' + context.recipientRole + '“' + context.recipientName + '”的钉钉账号', node: context.node, status: context.status, recipientRole: context.recipientRole, recipientName: context.recipientName }));
        return;
      }
      const cooldownKey = assessmentKey(empId, month) + '|' + context.node;
      const lastSentAt = workflowReminderSentAt.get(cooldownKey) || 0;
      if (Date.now() - lastSentAt < 60000) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: '该节点刚刚已催办，请60秒后再试', node: context.node, status: context.status }));
        return;
      }
      const employeeLabel = shortMonthLabel(month) + String(context.emp.name || '') + (context.emp.realName ? '（' + context.emp.realName + '）' : '');
      const isSelfEvaluationNode = context.node === 'self';
      const isSelfEvaluationReminder = isSelfEvaluationNode && requestedAction === 'remind-self-evaluation';
      const isSelfEvaluationSend = isSelfEvaluationNode && !isSelfEvaluationReminder;
      const notificationName = isSelfEvaluationSend ? '绩效自评通知' : (isSelfEvaluationReminder ? '绩效自评催办' : '绩效催办');
      const text = context.recipientName + '，你好！\n\n' +
        (isSelfEvaluationSend
          ? employeeLabel + '的绩效自评已开放，请填写完成情况、自评分并签字提交。'
          : isSelfEvaluationReminder
            ? employeeLabel + '的绩效自评尚未完成，请尽快填写完成情况、自评分并签字提交。'
          : employeeLabel + '的绩效流程目前处于“' + context.status + '”节点，请及时' + context.actionLabel + '。') + '\n\n' +
        '待办页面：' + publicLink(context.pagePath) + '\n\n' +
        '部门：' + String(context.emp.dept || '--') + '\n' +
        '岗位：' + String(context.emp.position || '--') + '\n' +
        '考核月份：' + month;
      const delivery = await enqueueBotMessage(userId, notificationName + ' - ' + employeeLabel, text);
      let selfEvaluationSentAt = '';
      if (delivery.sent || delivery.queued) {
        workflowReminderSentAt.set(cooldownKey, Date.now());
        if (isSelfEvaluationSend) {
          const draft = kpiTargetDrafts[assessmentKey(empId, month)];
          if (draft && draft.status === 'approved') {
            selfEvaluationSentAt = new Date().toISOString();
            draft.selfEvaluationSentAt = selfEvaluationSentAt;
            draft.selfEvaluationDelivery = {
              sent: Boolean(delivery.sent), queued: Boolean(delivery.queued), channel: delivery.channel || ''
            };
            saveKpiTargetDrafts();
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: Boolean(delivery.sent), accepted: Boolean(delivery.sent || delivery.queued),
        sent: Boolean(delivery.sent), queued: Boolean(delivery.queued), channel: delivery.channel || '',
        receipt: delivery.receipt || null,
        actionType: isSelfEvaluationSend ? 'send-self-evaluation' : (isSelfEvaluationReminder ? 'remind-self-evaluation' : 'reminder'),
        node: context.node, status: context.status, recipientRole: context.recipientRole,
        recipientName: context.recipientName, selfEvaluationSentAt, error: delivery.error || null,
      }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // Send bot message directly (from main system)
  if (req.method === 'POST' && req.url === '/send-bot-msg') {
    try {
      const data = JSON.parse(await readBody(req));
      if (!data.name && !data.userId) { res.writeHead(400); res.end('{"error":"Need name or userId"}'); return; }
      if (!req.accessProfile.global) {
        const identityEntry = Object.entries(dashboardEmployeeIdentities()).find(([, identity]) => identity && identity.name === String(data.name || '').trim());
        if (!identityEntry || !canAccessEmployee(req.accessProfile, identityEntry[0], identityEntry[1])) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '无权向其他部门人员发送绩效通知' }));
          return;
        }
      }
      const userId = data.userId || findUserId(data.name);
      if (!userId) { res.writeHead(400); res.end(JSON.stringify({ error: 'User not found: ' + data.name })); return; }
      const result = await enqueueBotMessage(userId, data.title || data.text, data.text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: Boolean(result.sent), accepted: Boolean(result.sent || result.queued), userId, ...result }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // Batch send bot messages (for KPI submission)
  if (req.method === 'POST' && req.url === '/send-bot-batch') {
    if (!requireGlobalAccess(req, res)) return;
    try {
      const data = JSON.parse(await readBody(req));
      if (!data.messages || !Array.isArray(data.messages)) { res.writeHead(400); res.end('{"error":"Need messages array"}'); return; }
      const results = await enqueueBotBatch(data.messages);
      const sentCount = results.filter(r => r.sent).length;
      const queuedCount = results.filter(r => r.queued).length;
      console.log('[batch-send] ' + sentCount + ' sent directly, ' + queuedCount + ' queued, ' + results.length + ' total');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const errors = results.filter(r => !r.sent).map(r => r.error).filter(Boolean);
      res.end(JSON.stringify({ success: results.length > 0 && sentCount === results.length, accepted: sentCount + queuedCount === results.length, total: results.length, sent: sentCount, queued: queuedCount, error: errors[0] || null, results }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // Lookup userId by name
  if (req.method === 'GET' && req.url.startsWith('/lookup-user/')) {
    const name = decodeURIComponent(req.url.split('/lookup-user/')[1]);
    const identityEntry = Object.entries(dashboardEmployeeIdentities()).find(([, identity]) => identity && identity.name === name);
    if (!identityEntry || !canAccessEmployee(req.accessProfile, identityEntry[0], identityEntry[1])) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '无权查询该员工' }));
      return;
    }
    const userId = findUserId(name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name, userId: userId || null }));
    return;
  }

  // The deployed service hosts the dashboard and API on the same origin.
  // Only the dashboard is exposed here; configuration and JSON data files are never served.
  if (req.method === 'GET' && (req.url === '/' || req.url === '/preview.html')) {
    try {
      const html = buildDashboardHtml(req.accessProfile || readAdminSession(req));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0', 'X-Performance-Build': DASHBOARD_BUILD_ID });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Dashboard unavailable');
    }
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

if (require.main === module) {
  // Fail closed: a malformed dashboard must never be exposed by a new release.
  buildDashboardHtml();
  startWorkflowEventWatcher();
  server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  \u7ee9\u6548\u8bc4\u5206\u901a\u77e5\u670d\u52a1 v3');
  console.log('  \u7aef\u53e3: ' + PORT);
  console.log('  POST /submit     - \u81ea\u8bc4\u63d0\u4ea4 \u2192 \u751f\u6210\u8bc4\u5206\u9875 + \u5165\u961f\u901a\u77e5');
  console.log('  POST /submit-mgr - \u4e0a\u7ea7\u8bc4\u5206\u63d0\u4ea4 \u2192 \u5165\u961f\u901a\u77e5HRBP');
  console.log('  POST /submit-bp  - BP\u6838\u51c6\u63d0\u4ea4 \u2192 \u4fdd\u5b58BP\u8bc4\u5206');
  console.log('  POST /submit-kpi - KPI\u786e\u8ba4\u4e66\u7b7e\u5b57\u56de\u4f20 \u2192 \u4fdd\u5b58\u7b7e\u540d\u786e\u8ba4\u4e66');
  console.log('  POST /submit-result - \u7ee9\u6548\u7ed3\u679c\u786e\u8ba4\u4e66\u7b7e\u5b57\u56de\u4f20');
  console.log('  POST /request-sign-otp - 发送本人钉钉签署验证码');
  console.log('  POST /verify-sign-otp - 校验一次性签署验证码');
  console.log('  GET  /kpi-data   - \u83b7\u53d6KPI\u786e\u8ba4\u4e66\u6570\u636e');
  console.log('  GET  /kpi-targets - 获取服务器保存的KPI目标明细');
  console.log('  GET  /result-data - \u83b7\u53d6\u7ee9\u6548\u7ed3\u679c\u786e\u8ba4\u4e66\u6570\u636e');
  console.log('  GET  /result-page/:empId - \u83b7\u53d6\u7ee9\u6548\u7ed3\u679c\u786e\u8ba4\u9875\u9762');
  console.log('  GET  /kpi-page/:name - \u83b7\u53d6KPI\u786e\u8ba4\u9875\u9762');
  console.log('  GET  /queue      - \u67e5\u770b\u5f85\u53d1\u9001\u901a\u77e5\u961f\u5217');
  console.log('  GET  /signature-audit - 查看防篡改链式签署日志');
  console.log('  GET  /verify-signature-integrity - 校验签署归档完整性');
  console.log('  GET  /oa-approval-status - 查看部门绩效奖金OA提交状态');
  console.log('========================================');
});
const oaRetryTimer = setInterval(() => Promise.all([
  retryPendingOaApprovals(),
  reconcileCompletedDepartmentOaApprovals()
]).catch(error => console.error('[dingtalk-oa] retry loop:', error.message)), 5 * 60 * 1000);
oaRetryTimer.unref();
setTimeout(() => Promise.all([
  retryPendingOaApprovals(),
  reconcileCompletedDepartmentOaApprovals()
]).catch(error => console.error('[dingtalk-oa] startup retry:', error.message)), 10000).unref();
}

module.exports = {
  validateStandardSignature,
  protectSignedDocument,
  verifySignedRecord,
  verifySignatureAuditChain,
  signatureSealPayload,
  publicLink,
  signPublicLinksInText,
  findUserId,
  assessmentMonthOrder,
  nextAssessmentMonth,
  assessmentRosterIncludesMonth,
  ensureCanonicalAssessmentRoster,
  organizationDepartmentFor,
  accessProfileForName,
  canAccessDepartment,
  canAccessApprovalGroup,
  canAccessEmployee,
  filterAssessmentMapForProfile,
  dashboardAccessContext,
  buildDashboardHtml,
  approvalRouteForEmployee,
  assessmentDepartmentRoster,
  departmentCompletionSnapshot,
  reconcileCompletedDepartmentOaApprovals
};
