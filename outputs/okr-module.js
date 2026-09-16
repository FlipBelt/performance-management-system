const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ELIGIBLE = Object.freeze({
  '俊俊': { empId: 'E031', realName: '廉峻', dept: '兴趣电商', position: '兴趣电商负责人', directMgr: '豪杰', hrbp: '薏米' },
  '廿一': { empId: 'E049', realName: '孙伟强', dept: '产品设计', position: '服装设计师', directMgr: 'Ben', hrbp: '薏米' }
});

const GRADES = Object.freeze([
  ['S+', 400, '重大贡献，重要表率'],
  ['S', 300, '高难度目标出色完成，重大创新改善'],
  ['S-', 220, '完成很难目标，付出巨大努力'],
  ['A+', 170, '工作努力，出色创新改善'],
  ['A', 130, '完成较难目标，有较好创新改善'],
  ['A-', 100, '工作认真，有一定创新改善'],
  ['B+', 50, '完成一定目标，工作表现认真负责'],
  ['B', 30, '工作表现良好'],
  ['B-', 0, '基本完成目标，工作表现需提升'],
  ['C', 0, '目标完成度较低，需要明显改进'],
  ['D', 0, '未完成主要目标，工作表现不达标']
]);
const GRADE_COEFFICIENTS = Object.freeze(Object.fromEntries(GRADES));
const WEEK_LABELS = Object.freeze(['第一周', '第二周', '第三周', '第四周', '第五周']);
const WEEKLY_ENTRY_STATUSES = Object.freeze(new Set([
  'target_submitted', 'target_manager_approved', 'target_bp_approved',
  'target_confirmed', 'self_review_invited'
]));
const STATUS_LABELS = Object.freeze({
  invited: '待员工填写OKR', target_submitted: '待上级确认OKR目标',
  target_manager_approved: '待BP确认OKR目标', target_bp_approved: '待员工确认OKR目标',
  target_confirmed: '待发送OKR自评', self_review_invited: '待员工填写OKR结果', self_reviewed: '待上级评定OKR等级',
  manager_graded: '待BP核定OKR等级', completed: '待员工确认OKR结果',
  result_signed_pending_bp: '待BP复核OKR结果归档', result_confirmed: 'OKR已完成归档'
});

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"'`]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
  })[char]);
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function monthOrder(month) {
  const match = String(month || '').match(/^(\d{4})年(\d{1,2})月$/);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : NaN;
}

function monthFromOrder(order) {
  return Math.floor(order / 12) + '年' + (order % 12 + 1) + '月';
}

function validateMonth(month) {
  if (!Number.isFinite(monthOrder(month)) || monthOrder(month) < monthOrder('2026年9月')) {
    throw new Error('OKR考核月份不得早于2026年9月');
  }
  return String(month);
}

function normalizeObjectives(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) throw new Error('请填写1至10项O（月度）');
  const objectives = raw.map((objective, oi) => {
    const title = String(objective && objective.title || '').trim();
    const weight = Number(objective && objective.weight);
    if (!title) throw new Error('第' + (oi + 1) + '项O（月度）不能为空');
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new Error('第' + (oi + 1) + '项O权重必须为1至100的整数');
    const rawKrs = objective && objective.keyResults;
    if (!Array.isArray(rawKrs) || rawKrs.length < 1 || rawKrs.length > 15) throw new Error('第' + (oi + 1) + '项O请填写1至15项KR（月度）');
    const keyResults = rawKrs.map((kr, ki) => {
      const result = String(kr && kr.result || '').trim();
      const krWeight = Number(kr && kr.weight);
      if (!result) throw new Error('O' + (oi + 1) + '的KR（月度）' + (ki + 1) + '不能为空');
      if (!Number.isInteger(krWeight) || krWeight < 1 || krWeight > 100) throw new Error('O' + (oi + 1) + '的KR' + (ki + 1) + '权重必须为1至100的整数');
      return { seq: ki + 1, result, weight: krWeight };
    });
    const krTotal = keyResults.reduce((sum, kr) => sum + kr.weight, 0);
    if (krTotal !== weight) throw new Error('第' + (oi + 1) + '项O下的KR权重合计必须等于O权重' + weight + '%，当前为' + krTotal + '%');
    return { seq: oi + 1, title, weight, keyResults };
  });
  const oTotal = objectives.reduce((sum, objective) => sum + objective.weight, 0);
  const krTotal = objectives.flatMap(objective => objective.keyResults).reduce((sum, kr) => sum + kr.weight, 0);
  if (oTotal !== 100 || krTotal !== 100) throw new Error('月度O权重和全部月度KR权重均必须合计100%，当前分别为' + oTotal + '%、' + krTotal + '%');
  return objectives;
}

function normalizeWeeklyObjectives(raw) {
  const source = Array.isArray(raw) ? raw : [];
  return WEEK_LABELS.map((label, weekIndex) => {
    const week = source.find(item => Number(item && item.week) === weekIndex + 1) || source[weekIndex] || {};
    const rawObjectives = Array.isArray(week.objectives) ? week.objectives : [];
    const objectives = rawObjectives.filter(objective => {
      const title = String(objective && objective.title || '').trim();
      const keyResults = Array.isArray(objective && objective.keyResults) ? objective.keyResults : [];
      return title || keyResults.some(kr => String(kr && kr.result || '').trim());
    }).map((objective, oi) => {
      const title = String(objective && objective.title || '').trim();
      const weight = Number(objective && objective.weight);
      if (!title) throw new Error(label + '第' + (oi + 1) + '项O不能为空');
      if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new Error(label + '第' + (oi + 1) + '项O权重必须为1至100的整数');
      const rawKrs = Array.isArray(objective && objective.keyResults) ? objective.keyResults : [];
      const keyResults = rawKrs.filter(kr => String(kr && kr.result || '').trim()).map((kr, ki) => {
        const krWeight = Number(kr && kr.weight);
        if (!Number.isInteger(krWeight) || krWeight < 1 || krWeight > 100) throw new Error(label + '第' + (oi + 1) + '项O的第' + (ki + 1) + '条KR权重必须为1至100的整数');
        return { seq: ki + 1, result: String(kr.result).trim(), weight: krWeight };
      });
      if (!keyResults.length) throw new Error(label + '第' + (oi + 1) + '项O请至少填写一条KR');
      if (keyResults.length > 15) throw new Error(label + '第' + (oi + 1) + '项O最多填写15条KR');
      const krTotal = keyResults.reduce((sum, kr) => sum + kr.weight, 0);
      if (krTotal !== weight) throw new Error(label + '第' + (oi + 1) + '项O下的KR权重合计必须等于O权重' + weight + '%，当前为' + krTotal + '%');
      return { seq: oi + 1, title, weight, keyResults };
    });
    if (objectives.length > 10) throw new Error(label + '最多填写10项O');
    const oTotal = objectives.reduce((sum, objective) => sum + objective.weight, 0);
    if (objectives.length && oTotal !== 100) throw new Error(label + 'O权重合计必须为100%，当前为' + oTotal + '%');
    return { week: weekIndex + 1, label, objectives };
  });
}

function legacyWeeklyObjectives(objectives) {
  return WEEK_LABELS.map((label, weekIndex) => {
    const weeklyObjectives = [];
    (Array.isArray(objectives) ? objectives : []).forEach(objective => {
      (Array.isArray(objective.keyResults) ? objective.keyResults : []).forEach(kr => {
        const plan = Array.isArray(kr.weeklyPlans) ? kr.weeklyPlans[weekIndex] : null;
        if (plan && (String(plan.okr || '').trim() || String(plan.kpi || '').trim())) {
          weeklyObjectives.push({ title: String(plan.okr || objective.title || '').trim(), weight: '', keyResults: [{ result: String(plan.kpi || kr.result || '').trim(), weight: '' }] });
        }
      });
    });
    return { week: weekIndex + 1, label, objectives: weeklyObjectives };
  });
}

function snapshotObjectives(objectives) {
  return JSON.parse(JSON.stringify(Array.isArray(objectives) ? objectives : []));
}

function objectiveChanges(before, after) {
  const left = JSON.stringify(before || []);
  const right = JSON.stringify(after || []);
  return left === right ? [] : [{ field: 'OKR目标内容', before: left, after: right }];
}

function createOkrModule(context) {
  const dataFile = path.join(context.dataDir, 'okr_workflows.json');
  const targetArchiveDir = path.join(context.dataDir, 'archives', 'okr-targets');
  const resultArchiveDir = path.join(context.dataDir, 'archives', 'okr-results');
  fs.mkdirSync(targetArchiveDir, { recursive: true });
  fs.mkdirSync(resultArchiveDir, { recursive: true });
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '{}', 'utf8');
  let records = JSON.parse(fs.readFileSync(dataFile, 'utf8') || '{}');
  const signingChallenges = new Map();
  const signingVerifications = new Map();

  function sha256(value) {
    return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
  }
  function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function cleanupSigningSessions() {
    const now = Date.now();
    signingChallenges.forEach((item, id) => { if (item.expiresAt <= now) signingChallenges.delete(id); });
    signingVerifications.forEach((item, token) => { if (item.expiresAt <= now || item.used) signingVerifications.delete(token); });
  }
  function validateSignature(data, record) {
    const signatureText = String(data.signatureText || '').replace(/\s/g, '');
    const realName = String(record.emp.realName || '').replace(/\s/g, '');
    if (!signatureText || signatureText !== realName || data.signatureFormat !== 'realName') return '请逐字手写员工真实姓名';
    if (data.signatureStyle !== '手写楷体') return '必须由员工本人手写签名';
    const metrics = data.signatureMetrics;
    const characters = Array.from(realName);
    if (!metrics || metrics.manuallyDrawn !== true || Number(metrics.expectedCharacterCount) !== characters.length || !Array.isArray(metrics.characters) || metrics.characters.length !== characters.length) return '未检测到完整的本人手写笔迹';
    if (Number(metrics.crossSlotStrokeCount) !== 0 || Number(metrics.pointCount) < characters.length * 3 || Number(metrics.pathLength) < characters.length * 35 || Number(metrics.strokeCount) < Math.max(characters.length * 2, 3)) return '手写笔迹过少、存在连写或不够清晰';
    for (let index = 0; index < characters.length; index += 1) {
      const item = metrics.characters[index] || {};
      if (item.character !== characters[index] || Number(item.inkPixels) < 35 || Number(item.widthRatio) < 0.08 || Number(item.heightRatio) < 0.10) return '第' + (index + 1) + '个字笔迹不足或不清晰';
    }
    if (typeof data.signatureData !== 'string' || !data.signatureData.startsWith('data:image/png;base64,') || data.signatureData.length < 500) return '签名图片不清晰或数据不完整';
    return '';
  }

  function save() {
    const temporary = dataFile + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(records, null, 2), { encoding: 'utf8', mode: 0o640 });
    fs.renameSync(temporary, dataFile);
  }

  function key(empId, month) { return String(empId) + '|' + String(month); }
  function weeklyEntryAllowed(record) {
    return Boolean(record && WEEKLY_ENTRY_STATUSES.has(record.status));
  }
  function currentWeeklyObjectives(record) {
    if (Array.isArray(record && record.operationalWeeklyObjectives)) return record.operationalWeeklyObjectives;
    if (Array.isArray(record && record.weeklyObjectives)) return record.weeklyObjectives;
    return legacyWeeklyObjectives(record && record.objectives);
  }
  function eligibleById(empId) {
    const found = Object.entries(ELIGIBLE).find(([, employee]) => employee.empId === String(empId));
    return found ? { name: found[0], ...found[1] } : null;
  }
  function assertEligible(empId) {
    const employee = eligibleById(empId);
    if (!employee) throw new Error('仅俊俊和廿一参加OKR流程');
    return employee;
  }
  function route(type, empId, month) {
    const encoded = Buffer.from(String(empId) + '|' + String(month), 'utf8').toString('base64url');
    return '/okr-' + type + '/' + encoded;
  }
  function decodeRoute(pathname, prefix) {
    let decoded = '';
    try { decoded = Buffer.from(pathname.slice(prefix.length), 'base64url').toString('utf8'); } catch (_) {}
    const parts = decoded.split('|');
    return { empId: parts[0] || '', month: parts[1] || '' };
  }
  function recordFor(data) {
    const record = records[key(data.empId, data.month)];
    if (!record) throw new Error('未找到该员工当月OKR流程');
    return record;
  }
  function replyJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  function page(title, body, script = '') {
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>' +
      '*{box-sizing:border-box}body{margin:0;background:#f2f6f4;color:#10211d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{max-width:1320px;margin:26px auto;padding:0 18px}.card{background:#fff;border:1px solid #dce7e2;border-radius:16px;padding:24px;box-shadow:0 10px 28px rgba(20,55,45,.07)}h1{margin:0 0 5px;font-size:26px}h2{font-size:18px}.sub{color:#64748b;margin-bottom:20px}.banner{padding:12px 14px;background:#ecfdf5;color:#066a55;border:1px solid #a7f3d0;border-radius:10px;margin:12px 0}.warn{background:#fff7ed;color:#9a3412;border-color:#fed7aa}.btn{appearance:none;border:1px solid #cbd5e1;background:#fff;color:#193b33;border-radius:9px;padding:10px 16px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:5px}.btn.primary{background:#155e55;border-color:#155e55;color:#fff}.btn.danger{color:#b42318;border-color:#fecaca;background:#fff7f7}.btn:disabled{opacity:.5}.actions{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:20px}.objective{border:1px solid #d8e3df;border-radius:13px;padding:18px;margin:15px 0;background:#fbfdfc}.objective-head{display:grid;grid-template-columns:1fr 130px 120px;gap:12px;align-items:end}.kr{margin-top:16px;padding-top:16px;border-top:1px dashed #cbd9d3}.kr-main{display:grid;grid-template-columns:minmax(260px,1fr) 130px 120px;gap:12px;align-items:end}.period-title{display:flex;align-items:center;justify-content:space-between;margin:26px 0 8px;padding-bottom:10px;border-bottom:2px solid #d7e8e1}.period-title strong{font-size:18px;color:#155e55}.weekly-editor{display:grid;gap:18px;margin-top:18px}.week-card{padding:18px;border:1px solid #cfe1da;border-radius:14px;background:#f8fbfa}.week-card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.week-chip{padding:6px 11px;border-radius:999px;background:#def5e9;color:#176556;font-size:13px;font-weight:800}.week-objective{background:#fff;border:1px solid #dce7e2;border-radius:11px;padding:14px;margin-top:12px}.week-objective-head{display:grid;grid-template-columns:minmax(260px,1fr) 110px;gap:12px;align-items:end}.week-kr{display:grid;grid-template-columns:minmax(260px,1fr) 110px;gap:12px;align-items:end;padding-top:12px;margin-top:12px;border-top:1px dashed #dce7e2}.week-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:12px}.del-kr{min-height:42px;white-space:nowrap}.label{font-size:12px;color:#64748b;margin:0 0 5px}.input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;font:inherit;min-height:42px}.input:focus{outline:2px solid #99f6e4;border-color:#0f766e}textarea.input{min-height:88px;resize:vertical}.status{display:inline-flex;border-radius:999px;padding:5px 10px;font-size:12px;font-weight:750;background:#fff7ed;color:#b45309;border:1px solid #fed7aa}.grade-table{min-width:0}.grade-table th:first-child,.grade-table td:first-child{width:90px;text-align:center;font-weight:800}.grade-table th:last-child,.grade-table td:last-child{width:150px;text-align:center}.table-wrap{overflow:auto;border:1px solid #dce5e1;border-radius:11px}table{border-collapse:collapse;width:100%;min-width:900px}th,td{padding:11px 12px;border-bottom:1px solid #e7eeeb;text-align:left;vertical-align:top}th{background:#f5f8f7}.muted{color:#64748b}.review-o{border:1px solid #dce7e2;border-radius:12px;margin:12px 0;overflow:hidden}.review-o>header{background:#f2f8f5;padding:12px 14px;font-weight:750}.review-kr{padding:12px 14px;border-top:1px solid #e5ece9}.weekly-review{margin:14px 0;padding:14px;border:1px solid #dce7e2;border-radius:12px}.weekly-review>header{font-weight:800;color:#176556;margin-bottom:8px}.weekly-review-o{padding:10px 0;border-top:1px solid #edf2ef}.weekly-review-o:first-of-type{border-top:0}.completion{background:#f8fafc;border-radius:8px;padding:9px;margin-top:8px;white-space:pre-wrap}.summary{width:100%;min-height:130px}.totals{font-weight:750;color:#155e55}.history{margin-top:16px;padding:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px}.admin-grid{display:grid;grid-template-columns:repeat(2,minmax(280px,1fr));gap:14px}.employee-card{border:1px solid #dbe5e1;border-radius:14px;padding:18px}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}@media(max-width:900px){.objective-head,.kr-main,.week-objective-head,.week-kr{grid-template-columns:1fr}.del-kr{width:100%}.admin-grid{grid-template-columns:1fr}.page{margin:10px auto}.card{padding:17px}}</style></head><body><main class="page"><section class="card">' + body + '</section></main>' + (script ? '<script>' + script + '</script>' : '') + '</body></html>';
  }

  function gradeGuide() {
    return '<h2>OKR等级</h2><div class="table-wrap"><table class="grade-table"><thead><tr><th>等级</th><th>描述</th><th>独立奖金发放系数</th></tr></thead><tbody>' + GRADES.map(([grade, coefficient, description]) => '<tr><td>' + grade + '</td><td>' + esc(description) + '</td><td>' + coefficient + '%</td></tr>').join('') + '</tbody></table></div>';
  }

  function weeklyReviewContent(record, useOperational) {
    const weekly = useOperational ? currentWeeklyObjectives(record) : (Array.isArray(record.weeklyObjectives) ? record.weeklyObjectives : legacyWeeklyObjectives(record.objectives));
    return weekly.filter(period => Array.isArray(period.objectives) && period.objectives.length).map(period =>
      '<section class="weekly-review"><header>' + esc(period.label) + ' O / KR</header>' + period.objectives.map((objective, oi) =>
        '<div class="weekly-review-o"><strong>O（' + esc(period.label) + '）' + (oi + 1) + '：' + esc(objective.title) + '</strong> <span class="muted">（' + esc(objective.weight) + '%）</span>' +
        (objective.keyResults || []).map((kr, ki) => '<div class="muted" style="margin-top:6px">KR（' + esc(period.label) + '）' + (ki + 1) + '：' + esc(kr.result) + '（' + esc(kr.weight) + '%）' + (kr.completion ? '<div class="completion"><strong>完成情况：</strong>' + esc(kr.completion) + '</div>' : '') + '</div>').join('') + '</div>'
      ).join('') + '</section>'
    ).join('');
  }

  function weeklySelfReviewContent(record) {
    const weekly = currentWeeklyObjectives(record);
    return weekly.filter(period => Array.isArray(period.objectives) && period.objectives.length).map(period =>
      '<section class="weekly-review"><header>' + esc(period.label) + ' O / KR</header>' + period.objectives.map((objective, oi) =>
        '<div class="weekly-review-o"><strong>O（' + esc(period.label) + '）' + (oi + 1) + '：' + esc(objective.title) + '</strong> <span class="muted">（' + esc(objective.weight) + '%）</span>' +
        (objective.keyResults || []).map((kr, ki) => '<div class="review-kr"><strong>KR（' + esc(period.label) + '）' + (ki + 1) + '：' + esc(kr.result) + '</strong> <span class="muted">（' + esc(kr.weight) + '%）</span><div class="label" style="margin-top:9px">实际完成情况与依据</div><textarea class="input weekly-completion-input" data-week="' + esc(period.week) + '" data-oi="' + oi + '" data-ki="' + ki + '">' + esc(kr.completion || '') + '</textarea></div>').join('') + '</div>'
      ).join('') + '</section>'
    ).join('');
  }

  function reviewContent(record, useOperational) {
    const monthly = (record.objectives || []).map(objective => '<section class="review-o"><header>O（月度）' + objective.seq + '：' + esc(objective.title) + ' <span class="muted">（' + objective.weight + '%）</span></header>' + objective.keyResults.map(kr => '<div class="review-kr"><strong>KR（月度）' + kr.seq + '：' + esc(kr.result) + '</strong> <span class="muted">（' + kr.weight + '%）</span>' + (kr.completion ? '<div class="completion"><strong>完成情况：</strong>' + esc(kr.completion) + '</div>' : '') + '</div>').join('') + '</section>').join('');
    const weekly = weeklyReviewContent(record, useOperational === true);
    return '<div class="period-title"><strong>月度 O / KR</strong><span class="muted">O及KR权重合计100%</span></div>' + monthly + '<div class="period-title"><strong>周度 O / KR</strong><span class="muted">第一至第五周</span></div>' + (weekly || '<div class="muted">暂未填写周度O/KR。</div>');
  }

  function resultReviewContent(record) {
    const monthly = (record.objectives || []).map(objective => '<section class="review-o"><header>O（月度）' + objective.seq + '：' + esc(objective.title) + ' <span class="muted">（' + objective.weight + '%）</span></header>' + objective.keyResults.map(kr => '<div class="review-kr"><strong>KR（月度）' + kr.seq + '：' + esc(kr.result) + '</strong> <span class="muted">（' + kr.weight + '%）</span>' + (kr.completion ? '<div class="completion"><strong>完成情况：</strong>' + esc(kr.completion) + '</div>' : '') + '</div>').join('') + '</section>').join('');
    return '<div class="period-title"><strong>月度 O / KR</strong><span class="muted">周度记录不带入完成情况及评级流程</span></div>' + monthly;
  }

  function formPage(record, role) {
    const employeeMode = role === 'employee';
    const expected = employeeMode ? ['invited', 'target_rejected'] : role === 'manager' ? ['target_submitted'] : ['target_manager_approved'];
    const actionable = expected.includes(record.status);
    const title = employeeMode ? '填写每月OKR目标' : role === 'manager' ? '直属上级确认OKR目标' : 'BP确认OKR目标';
    const previous = Object.values(records).filter(item => item.empId === record.empId && monthOrder(item.month) < monthOrder(record.month) && Array.isArray(item.objectives) && item.objectives.length).sort((a, b) => monthOrder(b.month) - monthOrder(a.month))[0];
    const initial = snapshotObjectives(record.objectives && record.objectives.length ? record.objectives : [{ title: '', weight: 100, keyResults: [{ result: '', weight: 100 }] }]);
    const initialWeekly = snapshotObjectives(Array.isArray(record.weeklyObjectives) ? record.weeklyObjectives : legacyWeeklyObjectives(record.objectives));
    const action = employeeMode ? 'okr-target-submit' : role === 'manager' ? 'okr-target-manager' : 'okr-target-bp';
    const body = '<style>.week-objective-head,.week-kr{grid-template-columns:minmax(260px,1fr) 120px 110px}@media(max-width:900px){.week-objective-head,.week-kr{grid-template-columns:1fr}}</style><h1>' + title + '</h1><div class="sub">' + esc(record.month) + ' · ' + esc(record.emp.name) + '（' + esc(record.emp.realName) + '）· ' + esc(record.emp.dept) + '</div>' +
      '<div class="banner">月度与每周均按“O＋KR”填写：月度及每个已填写周次的O权重均须合计100%，每项O下的KR权重合计须等于该O权重；每个O均可增加多条KR。第五周按当月实际情况填写。</div>' +
      (record.reviewReason ? '<div class="banner warn">退回原因：' + esc(record.reviewReason) + '</div>' : '') +
      (actionable ? '<div class="period-title"><strong>月度 O / KR</strong><span class="muted">月度权重合计须为100%</span></div><div id="editor"></div><div class="actions"><div>' + (employeeMode ? '<button class="btn" id="copy">从上月复制</button> ' : '') + '<button class="btn" id="addO">＋增加O（月度）</button></div><div class="totals">月度O合计 <span id="oTotal">0</span>% · 月度KR合计 <span id="krTotal">0</span>%</div></div><div class="period-title"><strong>第一至第五周 O / KR</strong><span class="muted">每周均可增加多个O，每个O可增加多条KR</span></div><div class="weekly-editor" id="weeklyEditor"></div><div class="actions"><span></span><button class="btn primary" id="submit">' + (employeeMode ? '提交给直属上级' : role === 'manager' ? '确认并发送BP' : 'BP确认OKR目标') + '</button></div>' : '<div class="banner">当前状态：' + esc(STATUS_LABELS[record.status] || record.status) + '</div>' + reviewContent(record)) +
      (Array.isArray(record.adjustments) && record.adjustments.length ? '<div class="history"><strong>目标调整记录</strong><br>' + record.adjustments.map(item => esc(item.actorRole + ' ' + item.actorName + ' 于 ' + item.adjustedAt + ' 调整了OKR目标')).join('<br>') + '</div>' : '');
    if (!actionable) return page(title, body);
    const script = 'const META=' + safeJson({ empId: record.empId, month: record.month, role }) + ';const TOKEN=' + safeJson(context.workflowActionToken(action, record.empId, record.month)) + ';const SERVER=' + safeJson(context.publicServerUrl) + ';const WEEKS=' + safeJson(WEEK_LABELS) + ';let data=' + safeJson(initial) + ';let weeklyData=' + safeJson(initialWeekly) + ';const previous=' + safeJson(previous ? { objectives: previous.objectives, weeklyObjectives: Array.isArray(previous.weeklyObjectives) ? previous.weeklyObjectives : legacyWeeklyObjectives(previous.objectives) } : null) + ';' +
      'const esc=s=>String(s??"").replace(/[&<>"\']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","\'":"&#39;"}[c]));' +
      'function snap(){data=[...document.querySelectorAll("#editor .objective")].map((o,oi)=>{const keyResults=[...o.querySelectorAll(".kr")].map((k,ki)=>({seq:ki+1,result:k.querySelector(".kr-result").value,weight:Number(k.querySelector(".kr-weight").value)}));return {seq:oi+1,title:o.querySelector(".o-title").value,weight:Number(o.querySelector(".o-weight").value),keyResults}});weeklyData=[...document.querySelectorAll(".week-card")].map((w,wi)=>{const objectives=[...w.querySelectorAll(".week-objective")].map((o,oi)=>{const keyResults=[...o.querySelectorAll(".week-kr")].map((k,ki)=>({seq:ki+1,result:k.querySelector(".week-kr-result").value,weight:Number(k.querySelector(".week-kr-weight").value)}));return {seq:oi+1,title:o.querySelector(".week-o-title").value,weight:Number(o.querySelector(".week-o-weight").value),keyResults}});return {week:wi+1,label:WEEKS[wi],objectives}})}' +
      'function render(){document.getElementById("editor").innerHTML=data.map((o,oi)=>`<section class="objective" data-oi="${oi}"><div class="objective-head"><div><div class="label">O（月度）</div><textarea class="input o-title" placeholder="填写月度目标O">${esc(o.title)}</textarea></div><div><div class="label">O权重(%)</div><input class="input o-weight" type="number" min="1" max="100" step="1" value="${esc(o.weight)}"></div><button class="btn danger del-o" type="button">删除O（月度）</button></div><div class="krs">${(o.keyResults||[]).map((k,ki)=>`<div class="kr" data-ki="${ki}"><div class="kr-main"><div><div class="label">KR（月度）</div><textarea class="input kr-result" placeholder="填写月度关键结果KR">${esc(k.result)}</textarea></div><div><div class="label">KR权重(%)</div><input class="input kr-weight" type="number" min="1" max="100" step="1" value="${esc(k.weight)}"></div><button class="btn danger del-kr" type="button">删除KR（月度）</button></div></div>`).join("")}</div><button class="btn add-kr" type="button" style="margin-top:12px">＋增加KR（月度）</button></section>`).join("");weeklyEditor.innerHTML=WEEKS.map((label,wi)=>{const period=weeklyData[wi]||{week:wi+1,label,objectives:[]};const ot=(period.objectives||[]).reduce((s,o)=>s+(Number(o.weight)||0),0);const kt=(period.objectives||[]).flatMap(o=>o.keyResults||[]).reduce((s,k)=>s+(Number(k.weight)||0),0);return `<section class="week-card" data-wi="${wi}"><div class="week-card-head"><span class="week-chip">${label}${wi===4?"（如适用）":""}</span><div class="week-actions" style="margin-top:0"><span class="muted week-total">O ${ot}% · KR ${kt}%</span><button class="btn add-week-o" type="button">＋增加O（${label}）</button></div></div><div class="week-objectives">${(period.objectives||[]).map((o,oi)=>`<div class="week-objective" data-oi="${oi}"><div class="week-objective-head"><div><div class="label">O（${label}）</div><textarea class="input week-o-title" placeholder="填写${label}目标O">${esc(o.title)}</textarea></div><div><div class="label">O权重(%)</div><input class="input week-o-weight" type="number" min="1" max="100" step="1" value="${esc(o.weight??"")}"></div><button class="btn danger del-week-o" type="button">删除O</button></div>${(o.keyResults||[]).map((k,ki)=>`<div class="week-kr" data-ki="${ki}"><div><div class="label">KR（${label}）</div><textarea class="input week-kr-result" placeholder="填写${label}关键结果KR">${esc(k.result)}</textarea></div><div><div class="label">KR权重(%)</div><input class="input week-kr-weight" type="number" min="1" max="100" step="1" value="${esc(k.weight??"")}"></div><button class="btn danger del-week-kr" type="button">删除KR</button></div>`).join("")}<div class="week-actions"><button class="btn add-week-kr" type="button">＋增加KR</button></div></div>`).join("")}</div></section>`}).join("");bind();totals()}' +
      'function bind(){document.querySelectorAll(".del-o").forEach((b,i)=>b.onclick=()=>{snap();if(data.length<2)return alert("至少保留一个O（月度）");data.splice(i,1);render()});document.querySelectorAll(".add-kr").forEach((b,i)=>b.onclick=()=>{snap();data[i].keyResults.push({result:"",weight:""});render()});document.querySelectorAll("#editor .objective").forEach((o,oi)=>o.querySelectorAll(".del-kr").forEach((b,ki)=>b.onclick=()=>{snap();if(data[oi].keyResults.length<2)return alert("每个O（月度）至少保留一条KR（月度）");data[oi].keyResults.splice(ki,1);render()}));document.querySelectorAll(".add-week-o").forEach((b,wi)=>b.onclick=()=>{snap();const first=weeklyData[wi].objectives.length===0;weeklyData[wi].objectives.push({title:"",weight:first?100:"",keyResults:[{result:"",weight:first?100:""}]});render()});document.querySelectorAll(".week-card").forEach((w,wi)=>w.querySelectorAll(".week-objective").forEach((o,oi)=>{o.querySelector(".del-week-o").onclick=()=>{snap();weeklyData[wi].objectives.splice(oi,1);render()};o.querySelector(".add-week-kr").onclick=()=>{snap();weeklyData[wi].objectives[oi].keyResults.push({result:"",weight:""});render()};o.querySelectorAll(".del-week-kr").forEach((b,ki)=>b.onclick=()=>{snap();if(weeklyData[wi].objectives[oi].keyResults.length<2)return alert("每个周度O至少保留一条KR");weeklyData[wi].objectives[oi].keyResults.splice(ki,1);render()})}));document.querySelectorAll("input").forEach(x=>x.oninput=totals)}function totals(){const os=[...document.querySelectorAll(".o-weight")].reduce((s,x)=>s+(Number(x.value)||0),0);const ks=[...document.querySelectorAll(".kr-weight")].reduce((s,x)=>s+(Number(x.value)||0),0);oTotal.textContent=os;krTotal.textContent=ks;document.querySelectorAll(".week-card").forEach(w=>{const wo=[...w.querySelectorAll(".week-o-weight")].reduce((s,x)=>s+(Number(x.value)||0),0);const wk=[...w.querySelectorAll(".week-kr-weight")].reduce((s,x)=>s+(Number(x.value)||0),0);w.querySelector(".week-total").textContent=`O ${wo}% · KR ${wk}%`})}' +
      'addO.onclick=()=>{snap();data.push({title:"",weight:"",keyResults:[{result:"",weight:""}]});render()};' + (employeeMode ? 'copy.onclick=()=>{if(!previous)return alert("上月暂无可复制的OKR目标");if(confirm("复制会替换当前内容，是否继续？")){data=JSON.parse(JSON.stringify(previous.objectives));weeklyData=JSON.parse(JSON.stringify(previous.weeklyObjectives));render()}};' : '') +
      'submit.onclick=async()=>{snap();submit.disabled=true;try{const r=await fetch(SERVER+"/okr-action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...META,action:' + safeJson(action) + ',objectives:data,weeklyObjectives:weeklyData,actionToken:TOKEN})});const x=await r.json();if(!r.ok||!x.success)throw new Error(x.error||"提交失败");document.querySelector(".card").innerHTML=`<div class="banner"><strong>处理成功</strong><br>${esc(x.message||"")}</div>`}catch(e){alert(e.message);submit.disabled=false}};render();';
    return page(title, body, script);
  }

  function weeklyEntryPage(record) {
    const actionable = weeklyEntryAllowed(record);
    const initialWeekly = snapshotObjectives(currentWeeklyObjectives(record));
    const monthlyReference = (record.objectives || []).map((objective, oi) =>
      '<section class="review-o"><header>O（月度）' + (oi + 1) + '：' + esc(objective.title) + ' <span class="muted">（' + esc(objective.weight) + '%）</span></header>' +
      (objective.keyResults || []).map((kr, ki) => '<div class="review-kr"><strong>KR（月度）' + (ki + 1) + '：</strong>' + esc(kr.result) + ' <span class="muted">（' + esc(kr.weight) + '%）</span></div>').join('') + '</section>'
    ).join('');
    const body = '<style>.week-objective-head,.week-kr{grid-template-columns:minmax(260px,1fr) 120px 110px}@media(max-width:900px){.week-objective-head,.week-kr{grid-template-columns:1fr}}</style>' +
      '<h1>填写/更新OKR周度计划</h1><div class="sub">' + esc(record.month) + ' · ' + esc(record.emp.name) + '（' + esc(record.emp.realName) + '）· ' + esc(record.emp.dept) + '</div>' +
      '<div class="banner">周度O/KR独立保存，不修改已确认的月度目标，不改变当前审批节点，也不会自动发送消息。每个已填写周次的O权重须合计100%，每项O下的KR权重合计须等于该O权重。</div>' +
      '<div class="period-title"><strong>月度OKR参考（只读）</strong><span class="muted">用于制定周度计划，不随周度内容修改</span></div>' + (monthlyReference || '<div class="muted">暂无已填写的月度OKR。</div>') +
      (actionable
        ? '<div class="period-title"><strong>第一至第五周 O / KR</strong><span class="muted">可按实际进度逐周填写或更新</span></div><div class="weekly-editor" id="weeklyEditor"></div><div class="actions"><span class="muted">未填写的周次可以留空，第五周按当月实际情况填写。</span><button class="btn primary" id="submit" type="button">保存周度O/KR</button></div>'
        : '<div class="banner warn">当前状态为“' + esc(STATUS_LABELS[record.status] || record.status) + '”，周度填写入口已关闭。</div>' + reviewContent(record, true));
    if (!actionable) return page('填写/更新OKR周度计划', body);
    const script = 'const META=' + safeJson({ empId: record.empId, month: record.month, action: 'okr-weekly-save' }) + ';' +
      'const TOKEN=' + safeJson(context.workflowActionToken('okr-weekly-save', record.empId, record.month)) + ';' +
      'const SERVER=' + safeJson(context.publicServerUrl) + ';const WEEKS=' + safeJson(WEEK_LABELS) + ';let weeklyData=' + safeJson(initialWeekly) + ';' +
      'const weeklyEditor=document.getElementById("weeklyEditor"),submit=document.getElementById("submit");' +
      'const esc=s=>String(s??"").replace(/[&<>"\']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","\'":"&#39;"}[c]));' +
      'function snap(){weeklyData=[...document.querySelectorAll(".week-card")].map((w,wi)=>{const objectives=[...w.querySelectorAll(".week-objective")].map((o,oi)=>{const keyResults=[...o.querySelectorAll(".week-kr")].map((k,ki)=>({seq:ki+1,result:k.querySelector(".week-kr-result").value,weight:Number(k.querySelector(".week-kr-weight").value)}));return{seq:oi+1,title:o.querySelector(".week-o-title").value,weight:Number(o.querySelector(".week-o-weight").value),keyResults}});return{week:wi+1,label:WEEKS[wi],objectives}})}' +
      'function totals(){document.querySelectorAll(".week-card").forEach(w=>{const os=[...w.querySelectorAll(".week-o-weight")].reduce((s,x)=>s+(Number(x.value)||0),0);const ks=[...w.querySelectorAll(".week-kr-weight")].reduce((s,x)=>s+(Number(x.value)||0),0);w.querySelector(".week-total").textContent=`O ${os}% · KR ${ks}%`})}' +
      'function bind(){document.querySelectorAll(".add-week-o").forEach((b,wi)=>b.onclick=()=>{snap();const first=weeklyData[wi].objectives.length===0;weeklyData[wi].objectives.push({title:"",weight:first?100:"",keyResults:[{result:"",weight:first?100:""}]});render()});document.querySelectorAll(".week-card").forEach((w,wi)=>w.querySelectorAll(".week-objective").forEach((o,oi)=>{o.querySelector(".del-week-o").onclick=()=>{snap();weeklyData[wi].objectives.splice(oi,1);render()};o.querySelector(".add-week-kr").onclick=()=>{snap();weeklyData[wi].objectives[oi].keyResults.push({result:"",weight:""});render()};o.querySelectorAll(".del-week-kr").forEach((b,ki)=>b.onclick=()=>{snap();if(weeklyData[wi].objectives[oi].keyResults.length<2)return alert("每个周度O至少保留一条KR");weeklyData[wi].objectives[oi].keyResults.splice(ki,1);render()})}));document.querySelectorAll("input").forEach(x=>x.oninput=totals)}' +
      'function render(){weeklyEditor.innerHTML=WEEKS.map((label,wi)=>{const period=weeklyData[wi]||{week:wi+1,label,objectives:[]};const ot=(period.objectives||[]).reduce((s,o)=>s+(Number(o.weight)||0),0);const kt=(period.objectives||[]).flatMap(o=>o.keyResults||[]).reduce((s,k)=>s+(Number(k.weight)||0),0);return `<section class="week-card" data-wi="${wi}"><div class="week-card-head"><span class="week-chip">${label}${wi===4?"（如适用）":""}</span><div class="week-actions" style="margin-top:0"><span class="muted week-total">O ${ot}% · KR ${kt}%</span><button class="btn add-week-o" type="button">＋增加O（${label}）</button></div></div><div class="week-objectives">${(period.objectives||[]).map((o,oi)=>`<div class="week-objective" data-oi="${oi}"><div class="week-objective-head"><div><div class="label">O（${label}）</div><textarea class="input week-o-title" placeholder="填写${label}目标O">${esc(o.title)}</textarea></div><div><div class="label">O权重(%)</div><input class="input week-o-weight" type="number" min="1" max="100" step="1" value="${esc(o.weight??"")}"></div><button class="btn danger del-week-o" type="button">删除O</button></div>${(o.keyResults||[]).map((k,ki)=>`<div class="week-kr" data-ki="${ki}"><div><div class="label">KR（${label}）</div><textarea class="input week-kr-result" placeholder="填写${label}关键结果KR">${esc(k.result)}</textarea></div><div><div class="label">KR权重(%)</div><input class="input week-kr-weight" type="number" min="1" max="100" step="1" value="${esc(k.weight??"")}"></div><button class="btn danger del-week-kr" type="button">删除KR</button></div>`).join("")}<div class="week-actions"><button class="btn add-week-kr" type="button">＋增加KR</button></div></div>`).join("")}</div></section>`}).join("");bind();totals()}' +
      'submit.onclick=async()=>{snap();submit.disabled=true;try{const r=await fetch(SERVER+"/okr-action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...META,weeklyObjectives:weeklyData,actionToken:TOKEN})});const x=await r.json();if(!r.ok||!x.success)throw new Error(x.error||"保存失败");document.querySelector(".card").innerHTML=`<div class="banner"><strong>周度O/KR已保存。</strong><br>现有OKR流程节点未改变。</div>`}catch(e){alert(e.message);submit.disabled=false}};render();';
    return page('填写/更新OKR周度计划', body, script);
  }

  function confirmationPage(record, result) {
    const isResult = result === true;
    const required = isResult ? 'completed' : 'target_bp_approved';
    const action = isResult ? 'okr-result-confirm' : 'okr-target-confirm';
    const title = isResult ? '员工确认OKR结果' : '员工确认OKR目标';
    const resultBlock = isResult ? '<div class="banner"><strong>BP最终核定等级：' + esc(record.bpGrade) + '</strong><br>OKR奖金发放系数：' + esc(record.finalCoefficient) + '%（单独用于OKR奖金计算，不与KPI系数组合）</div>' : '';
    const weeklyEntryBlock = !isResult && weeklyEntryAllowed(record) ? '<div class="banner"><strong>周度O/KR填写入口已开放</strong><br>周度内容独立保存，不影响本页月度目标签字。<div style="margin-top:10px"><a class="btn" target="_blank" rel="noopener" href="' + esc(context.publicLink(route('weekly-fill', record.empId, record.month))) + '">填写/更新周度O/KR</a></div></div>' : '';
    const alreadyHandled = '<div class="banner">当前状态：' + esc(STATUS_LABELS[record.status] || record.status) + '</div>';
    if (true) {
      const signingBlock = record.status === required ? '<style>.identity{padding:16px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:12px;margin-top:22px}.identity-row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.identity-row label{flex:1;min-width:190px}.signature{margin-top:16px;border:1px solid #dce7e2;border-radius:12px;padding:16px}.signature-guides{display:grid;position:absolute;inset:8px;pointer-events:none}.signature-guide{border:1px dashed #b9c9c2;display:flex;align-items:flex-start;justify-content:center;color:#94a3b8;font-size:12px;padding-top:6px}.canvas-wrap{position:relative;margin-top:10px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;overflow:hidden}.canvas-wrap canvas{display:block;width:100%;height:180px;touch-action:none}.sign-status{font-size:13px;color:#64748b;margin-top:8px}.sign-status.good{color:#047857}.sign-status.bad{color:#b42318}</style>' +
        '<section class="identity"><h2 style="margin-top:0">第一步：钉钉本人验证</h2><div class="identity-row"><button class="btn primary" id="sendOtp" type="button">发送验证码到本人钉钉</button><label><div class="label">6位验证码</div><input class="input" id="otp" inputmode="numeric" maxlength="6" placeholder="请输入验证码" disabled></label><button class="btn" id="verifyOtp" type="button" disabled>验证身份</button></div><div class="sign-status" id="identityStatus">请先向本人钉钉发送验证码。</div></section>' +
        '<section class="signature"><h2 style="margin-top:0">第二步：本人手写签名</h2><div class="muted">请在分字框内逐字手写真实姓名“' + esc(record.emp.realName) + '”，不允许代签或电子生成签名。</div><div class="canvas-wrap"><div class="signature-guides" id="guides"></div><canvas id="signatureCanvas"></canvas></div><div class="sign-status" id="signatureStatus">完成钉钉验证后可开始书写。</div><div class="actions"><button class="btn" id="clearSignature" type="button">清除重写</button><button class="btn primary" id="confirm" type="button" disabled>确认签名并归档</button></div></section>' : alreadyHandled;
      const resolvedSigningBlock = isResult ? signingBlock.replace('确认签名并归档', '确认签名并提交BP复核') : signingBlock;
      const body = '<h1>' + title + '</h1><div class="sub">' + esc(record.month) + ' · ' + esc(record.emp.name) + '（' + esc(record.emp.realName) + '）</div>' + resultBlock + weeklyEntryBlock + (isResult ? resultReviewContent(record) : reviewContent(record)) + resolvedSigningBlock;
      const script = record.status === required ? 'const META=' + safeJson({ empId: record.empId, month: record.month, action, realName: record.emp.realName }) + ';const TOKEN=' + safeJson(context.workflowActionToken(action, record.empId, record.month)) + ';const SERVER=' + safeJson(context.publicServerUrl) + ';const sendOtp=document.getElementById("sendOtp"),otp=document.getElementById("otp"),verifyOtp=document.getElementById("verifyOtp"),guides=document.getElementById("guides"),identityStatus=document.getElementById("identityStatus"),signatureStatus=document.getElementById("signatureStatus"),clearSignature=document.getElementById("clearSignature"),confirm=document.getElementById("confirm");const pagePath=location.pathname,pageToken=new URLSearchParams(location.search).get("token")||"";let challengeId="",verificationToken="",verified=false,drawing=false,trusted=false,lastX=0,lastY=0,pointCount=0,strokeCount=0,pathLength=0,crossSlotStrokeCount=0,strokeMinX=0,strokeMaxX=0,latestMetrics=null;const canvas=document.getElementById("signatureCanvas"),ctx=canvas.getContext("2d"),chars=Array.from(META.realName);guides.style.gridTemplateColumns=`repeat(${chars.length},1fr)`;guides.innerHTML=chars.map((c,i)=>`<div class="signature-guide">${i+1} · ${c}</div>`).join("");function resize(){const r=canvas.parentElement.getBoundingClientRect();canvas.width=Math.max(600,Math.floor(r.width*2));canvas.height=360;ctx.strokeStyle="#111827";ctx.lineWidth=5;ctx.lineCap="round";ctx.lineJoin="round"}resize();function clear(){ctx.clearRect(0,0,canvas.width,canvas.height);drawing=false;trusted=false;pointCount=strokeCount=pathLength=crossSlotStrokeCount=0;latestMetrics=null;confirm.disabled=true;signatureStatus.textContent=verified?"请在每个分字框内逐字手写。":"完成钉钉验证后可开始书写。";signatureStatus.className="sign-status"}clearSignature.onclick=clear;function pos(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height}}function metrics(){const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data,slotWidth=canvas.width/chars.length;const items=chars.map((character,index)=>{let inkPixels=0,minX=canvas.width,maxX=-1,minY=canvas.height,maxY=-1;const start=Math.floor(index*slotWidth),end=Math.min(canvas.width,Math.ceil((index+1)*slotWidth));for(let y=0;y<canvas.height;y+=2)for(let x=start;x<end;x+=2)if(pixels[(y*canvas.width+x)*4+3]>30){inkPixels++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)}const widthRatio=maxX>=0?(maxX-minX+1)/slotWidth:0,heightRatio=maxY>=0?(maxY-minY+1)/canvas.height:0;return{character,inkPixels,widthRatio,heightRatio}});const valid=trusted&&pointCount>=chars.length*3&&pathLength>=chars.length*35&&strokeCount>=Math.max(chars.length*2,3)&&crossSlotStrokeCount===0&&items.every(x=>x.inkPixels>=35&&x.widthRatio>=.08&&x.heightRatio>=.10);return{valid,manuallyDrawn:trusted,signatureFormat:"realName",expectedCharacterCount:chars.length,pointCount,strokeCount,pathLength:Math.round(pathLength),crossSlotStrokeCount,characters:items}}canvas.onpointerdown=e=>{if(!verified){signatureStatus.textContent="请先完成钉钉本人验证。";signatureStatus.className="sign-status bad";return}e.preventDefault();drawing=true;trusted=trusted||e.isTrusted;strokeCount++;const p=pos(e);lastX=strokeMinX=strokeMaxX=p.x;lastY=p.y;ctx.beginPath();ctx.moveTo(p.x,p.y);try{canvas.setPointerCapture(e.pointerId)}catch(_){}};canvas.onpointermove=e=>{if(!drawing)return;e.preventDefault();const p=pos(e);ctx.lineTo(p.x,p.y);ctx.stroke();pathLength+=Math.hypot(p.x-lastX,p.y-lastY);pointCount++;strokeMinX=Math.min(strokeMinX,p.x);strokeMaxX=Math.max(strokeMaxX,p.x);lastX=p.x;lastY=p.y};function stop(e){if(!drawing)return;if(e)e.preventDefault();const width=canvas.width/chars.length;if(Math.floor(Math.max(0,strokeMinX)/width)!==Math.floor(Math.min(canvas.width-1,strokeMaxX)/width))crossSlotStrokeCount++;drawing=false;latestMetrics=metrics();signatureStatus.textContent=latestMetrics.valid?"手写签名检查通过。":"笔迹不足、不清晰或存在跨字连写，请清除后逐字重写。";signatureStatus.className="sign-status "+(latestMetrics.valid?"good":"bad");confirm.disabled=!(verified&&latestMetrics.valid)}canvas.onpointerup=stop;canvas.onpointercancel=stop;otp.oninput=()=>{otp.value=otp.value.replace(/\D/g,"").slice(0,6)};sendOtp.onclick=async()=>{sendOtp.disabled=true;identityStatus.textContent="正在发送验证码…";try{const r=await fetch(SERVER+"/okr-sign-otp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({empId:META.empId,month:META.month,pagePath,pageToken})});const x=await r.json();if(!r.ok||!x.success)throw new Error(x.error||"发送失败");challengeId=x.challengeId;otp.disabled=false;verifyOtp.disabled=false;otp.focus();identityStatus.textContent="验证码已发送至本人钉钉，5分钟内有效。"}catch(e){identityStatus.textContent="发送失败："+e.message;identityStatus.className="sign-status bad";sendOtp.disabled=false}};verifyOtp.onclick=async()=>{if(!/^\d{6}$/.test(otp.value))return identityStatus.textContent="请输入6位验证码。";verifyOtp.disabled=true;identityStatus.textContent="正在验证身份…";try{const r=await fetch(SERVER+"/okr-sign-verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({challengeId,code:otp.value})});const x=await r.json();if(!r.ok||!x.success)throw new Error(x.error||"验证失败");verificationToken=x.verificationToken;verified=true;otp.disabled=true;sendOtp.disabled=true;identityStatus.textContent="本人钉钉验证通过，请手写真实姓名。";identityStatus.className="sign-status good";clear()}catch(e){identityStatus.textContent="验证失败："+e.message;identityStatus.className="sign-status bad";verifyOtp.disabled=false}};confirm.onclick=async()=>{latestMetrics=metrics();if(!verified||!verificationToken||!latestMetrics.valid)return;confirm.disabled=true;try{const r=await fetch(SERVER+"/okr-action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...META,actionToken:TOKEN,verificationToken,signatureText:META.realName,signatureFormat:"realName",signatureStyle:"手写楷体",signatureMetrics:latestMetrics,signatureData:canvas.toDataURL("image/png")})});const x=await r.json();if(!r.ok||!x.success)throw new Error(x.error||"确认失败");document.querySelector(".card").innerHTML=`<div class="banner"><strong>签名确认成功，OKR目标已归档。</strong></div>`}catch(e){alert(e.message);confirm.disabled=false}};' : '';
      const numericOtpCompatibility = record.status === required ? ';otp.addEventListener("input",()=>{otp.value=Array.from(String(otp.value||"")).filter(c=>c>="0"&&c<="9").join("").slice(0,6)});verifyOtp.addEventListener("click",async event=>{event.preventDefault();event.stopImmediatePropagation();const code=Array.from(String(otp.value||"")).filter(c=>c>="0"&&c<="9").join("").slice(0,6);otp.value=code;if(code.length!==6){identityStatus.textContent="请输入6位数字验证码。";identityStatus.className="sign-status bad";return}verifyOtp.disabled=true;identityStatus.textContent="正在验证身份…";identityStatus.className="sign-status";try{const response=await fetch(SERVER+"/okr-sign-verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({challengeId,code})});const result=await response.json();if(!response.ok||!result.success)throw new Error(result.error||"验证失败");verificationToken=result.verificationToken;verified=true;otp.disabled=true;sendOtp.disabled=true;identityStatus.textContent="本人钉钉验证通过，请手写真实姓名。";identityStatus.className="sign-status good";clear()}catch(error){identityStatus.textContent="验证失败："+error.message;identityStatus.className="sign-status bad";verifyOtp.disabled=false}},true);' : '';
      const resolvedScript = isResult ? (script + numericOtpCompatibility).replace('签名确认成功，OKR目标已归档。', 'OKR结果签字成功，已提交BP复核归档。') : script + numericOtpCompatibility;
      return page(title, body, resolvedScript);
    }
    const body = '<h1>' + title + '</h1><div class="sub">' + esc(record.month) + ' · ' + esc(record.emp.name) + '（' + esc(record.emp.realName) + '）</div>' + resultBlock + weeklyEntryBlock + (isResult ? resultReviewContent(record) : reviewContent(record)) + (record.status === required ? '<div class="actions"><span class="muted">确认即表示本人已阅读并认可以上内容。</span><button class="btn primary" id="confirm">本人确认</button></div>' : alreadyHandled);
    const script = record.status === required ? 'const META=' + safeJson({ empId: record.empId, month: record.month, action }) + ';const TOKEN=' + safeJson(context.workflowActionToken(action, record.empId, record.month)) + ';confirm.onclick=async()=>{if(!window.confirm("确认以上OKR结果内容？"))return;confirm.disabled=true;const r=await fetch(' + safeJson(context.publicServerUrl + '/okr-action') + ',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...META,actionToken:TOKEN})});const x=await r.json();if(!r.ok)throw new Error(x.error||"确认失败");document.querySelector(".card").innerHTML=`<div class="banner"><strong>确认成功，系统已归档。</strong></div>`};' : '';
    return page(title, body, script);
  }

  function selfReviewPage(record) {
    const actionable = record.status === 'self_review_invited';
    const body = '<h1>填写OKR月度结果</h1><div class="sub">' + esc(record.month) + ' · ' + esc(record.emp.name) + '（' + esc(record.emp.realName) + '）</div>' + (actionable ? '<div class="banner">请填写月度KR的实际完成情况与依据；周度记录不带入本页，OKR等级由直属上级评定、BP复核。</div><div id="review"><div class="period-title"><strong>月度 O / KR</strong></div>' + (record.objectives || []).map((objective, oi) => '<section class="review-o"><header>O（月度）' + (oi + 1) + '：' + esc(objective.title) + '</header>' + objective.keyResults.map((kr, ki) => '<div class="review-kr"><strong>KR（月度）' + (ki + 1) + '：' + esc(kr.result) + '</strong><div class="label" style="margin-top:9px">实际完成情况与依据</div><textarea class="input completion-input" data-oi="' + oi + '" data-ki="' + ki + '">' + esc(kr.completion || '') + '</textarea></div>').join('') + '</section>').join('') + '</div><div class="label">月度总结</div><textarea class="input summary" id="summary"></textarea><div class="actions"><span></span><button class="btn primary" id="submit">提交给直属上级评级</button></div>' : '<div class="banner">当前状态：' + esc(STATUS_LABELS[record.status] || record.status) + '</div>' + resultReviewContent(record));
    const action = 'okr-self-review';
    const script = actionable ? 'const META=' + safeJson({ empId: record.empId, month: record.month, action }) + ';const TOKEN=' + safeJson(context.workflowActionToken(action, record.empId, record.month)) + ';submit.onclick=async()=>{const completions=[...document.querySelectorAll(".completion-input")].map(x=>({objectiveIndex:Number(x.dataset.oi),krIndex:Number(x.dataset.ki),completion:x.value.trim()}));submit.disabled=true;try{const r=await fetch(' + safeJson(context.publicServerUrl + '/okr-action') + ',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...META,actionToken:TOKEN,completions,summary:summary.value.trim()})});const x=await r.json();if(!r.ok)throw new Error(x.error||"提交失败");document.querySelector(".card").innerHTML=`<div class="banner"><strong>OKR完成情况已提交直属上级评级。</strong></div>`}catch(e){alert(e.message);submit.disabled=false}};' : '';
    return page('填写OKR月度结果', body, script);
  }

  function gradePage(record, role) {
    const isManager = role === 'manager';
    const required = isManager ? 'self_reviewed' : 'manager_graded';
    const action = isManager ? 'okr-manager-grade' : 'okr-bp-grade';
    const title = isManager ? '直属上级评定OKR等级' : 'BP核定OKR最终等级';
    const ratingForm = record.status === required ? '<div class="label">' + (isManager ? '直属上级评定等级' : 'BP最终核定等级') + '</div><select class="input" id="grade">' + GRADES.map(([grade]) => '<option' + (record.managerGrade === grade ? ' selected' : '') + '>' + grade + '</option>').join('') + '</select><div class="label" style="margin-top:12px">评语</div><textarea class="input summary" id="comment"></textarea>' + gradeGuide() + '<div class="actions"><span></span><button class="btn primary" id="submit">' + (isManager ? '提交给BP核定' : '核定最终OKR等级') + '</button></div>' : '<div class="banner">当前状态：' + esc(STATUS_LABELS[record.status] || record.status) + '</div>' + gradeGuide();
    const body = '<h1>' + title + '</h1><div class="sub">' + esc(record.month) + ' · ' + esc(record.emp.name) + '（' + esc(record.emp.realName) + '）</div><div class="banner">' + (record.managerGrade ? '<strong>上级评定等级：' + esc(record.managerGrade) + '</strong><br>' : '') + '月度总结：' + esc(record.summary || '--') + '</div>' + resultReviewContent(record) + ratingForm;
    const script = record.status === required ? 'const META=' + safeJson({ empId: record.empId, month: record.month, action }) + ';const TOKEN=' + safeJson(context.workflowActionToken(action, record.empId, record.month)) + ';submit.onclick=async()=>{submit.disabled=true;try{const r=await fetch(' + safeJson(context.publicServerUrl + '/okr-action') + ',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...META,actionToken:TOKEN,grade:grade.value,comment:comment.value.trim()})});const x=await r.json();if(!r.ok)throw new Error(x.error||"提交失败");document.querySelector(".card").innerHTML=`<div class="banner"><strong>处理成功。</strong><br>${x.message||""}</div>`}catch(e){alert(e.message);submit.disabled=false}};' : '';
    return page(title, body, script);
  }

  function resultBpReviewPage(record) {
    const actionable = record.status === 'result_signed_pending_bp';
    const action = 'okr-result-bp-final';
    const signature = record.resultSignature || {};
    const body = '<h1>BP复核OKR结果并归档</h1><div class="sub">' + esc(record.month) + ' · ' + esc(record.emp.name) + '（' + esc(record.emp.realName) + '）</div>' +
      '<div class="banner"><strong>最终等级：' + esc(record.bpGrade) + '　独立奖金发放系数：' + esc(record.finalCoefficient) + '%</strong><br>员工已完成钉钉验证及手写签名，请BP核对结果后正式归档。</div>' + resultReviewContent(record) +
      (signature.signatureData ? '<section style="margin-top:20px;text-align:center"><h2>员工手写签名</h2><img src="' + esc(signature.signatureData) + '" alt="员工手写签名" style="max-width:420px;width:100%;border:1px solid #dce7e2;border-radius:10px"><div class="muted">签署时间：' + esc(signature.signedAt) + '</div></section>' : '') +
      (actionable ? '<div class="actions"><span class="muted">归档后OKR结果将正式封存。</span><button class="btn primary" id="approve">核对无误并归档</button></div>' : '<div class="banner"><strong>该OKR结果已经BP复核并正式归档。</strong><br>归档时间：' + esc(record.resultBpReviewedAt || '') + '</div>');
    const script = actionable ? 'const META=' + safeJson({ empId: record.empId, month: record.month, action }) + ';const TOKEN=' + safeJson(context.workflowActionToken(action, record.empId, record.month)) + ';document.getElementById("approve").onclick=async function(){this.disabled=true;this.textContent="归档中…";try{const r=await fetch(' + safeJson(context.publicServerUrl + '/okr-action') + ',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...META,actionToken:TOKEN})});const x=await r.json();if(!r.ok||!x.success)throw new Error(x.error||"归档失败");document.querySelector(".card").innerHTML=`<div class="banner"><strong>BP复核完成，OKR结果已正式归档。</strong></div>`}catch(e){alert(e.message);this.disabled=false;this.textContent="核对无误并归档"}};' : '';
    return page('BP复核OKR结果', body, script);
  }

  function archive(record, type) {
    const isResult = type === 'result';
    const directory = isResult ? resultArchiveDir : targetArchiveDir;
    const filename = record.month + '_' + record.empId + '_' + record.emp.name + '_' + (isResult ? 'OKR结果确认' : 'OKR目标确认') + '.html';
    const signature = isResult ? record.resultSignature : record.targetSignature;
    const signatureBlock = signature ? '<section style="margin-top:24px;padding:18px;border-top:2px solid #dce7e2;text-align:center"><h2>员工本人签名确认</h2><img src="' + esc(signature.signatureData) + '" alt="员工手写签名" style="max-width:420px;width:100%;height:auto;border:1px solid #dce7e2;border-radius:10px;background:#fff"><div class="muted" style="margin-top:8px">签署人：' + esc(signature.realName) + ' · 钉钉验证码已验证 · 签署时间：' + esc(signature.signedAt) + '</div></section>' : '';
    const bpArchiveBlock = isResult && record.resultBpReviewedAt ? '<section class="banner"><strong>BP复核归档完成</strong><br>复核人：' + esc(record.resultBpReviewedBy) + ' · 复核时间：' + esc(record.resultBpReviewedAt) + '</section>' : '';
    const content = page(isResult ? 'OKR结果确认书' : 'OKR目标确认书', '<h1>' + (isResult ? 'OKR结果确认书' : 'OKR目标确认书') + '</h1><div class="sub">' + esc(record.month) + ' · ' + esc(record.emp.name) + '（' + esc(record.emp.realName) + '）</div>' + (isResult ? '<div class="banner"><strong>最终等级：' + esc(record.bpGrade) + '　独立奖金发放系数：' + esc(record.finalCoefficient) + '%</strong></div>' : '') + (isResult ? resultReviewContent(record) : reviewContent(record)) + signatureBlock + bpArchiveBlock);
    fs.writeFileSync(path.join(directory, filename), content, { encoding: 'utf8', mode: 0o640 });
    return path.relative(context.dataDir, path.join(directory, filename)).replace(/\\/g, '/');
  }

  function actionPagePath(record) {
    const map = {
      invited: ['fill', record.emp.name], target_rejected: ['fill', record.emp.name],
      target_submitted: ['target-manager', record.emp.directMgr], target_manager_approved: ['target-bp', record.emp.hrbp],
      target_bp_approved: ['target-confirm', record.emp.name], self_review_invited: ['self-review', record.emp.name],
      self_reviewed: ['manager-grade', record.emp.directMgr], manager_graded: ['bp-grade', record.emp.hrbp],
      completed: ['result-confirm', record.emp.name], result_signed_pending_bp: ['result-bp', record.emp.hrbp]
    };
    const item = map[record.status];
    return item ? { pagePath: route(item[0], record.empId, record.month), recipient: item[1] } : null;
  }

  async function notify(record, title, text, type, recipient) {
    const userId = context.findUserId(recipient);
    if (!userId) return { sent: false, error: '未找到' + recipient + '的钉钉账号' };
    return context.enqueueBotMessage(userId, title, text + '\n\n办理页面：' + context.publicLink(route(type, record.empId, record.month)));
  }

  function adminPage(profile) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const currentMonth = now.getFullYear() + '年' + (now.getMonth() + 1) + '月';
    const visibleEmployees = Object.entries(ELIGIBLE).map(([name, employee]) => ({ name, ...employee })).filter(employee => context.canAccessEmployee(profile, employee.empId, employee));
    const body = '<div class="toolbar"><div><h1>OKR管理</h1><div class="sub">俊俊、廿一每月同时参加KPI与OKR；本页管理月度及周度目标流程，评级由直属上级评定、BP复核。</div></div><a class="btn" href="/">返回绩效系统</a></div><div class="toolbar"><label><strong>考核月份：</strong> <input class="input" style="width:150px" id="month" value="' + esc(monthOrder(currentMonth) < monthOrder('2026年9月') ? '2026年9月' : currentMonth) + '"></label><button class="btn" id="refresh">查询月份</button></div><div class="admin-grid" id="cards">' + visibleEmployees.map(employee => '<div class="employee-card" data-emp="' + employee.empId + '"><h2>' + esc(employee.name) + '（' + esc(employee.realName) + '）</h2><div class="muted">' + esc(employee.dept) + ' · ' + esc(employee.position) + '</div><div class="record" style="margin-top:13px">正在读取…</div></div>').join('') + '</div>';
    const script = 'const employees=' + safeJson(visibleEmployees) + ';const SERVER=' + safeJson(context.publicServerUrl) + ';const labels=' + safeJson(STATUS_LABELS) + ';const weeklyStatuses=new Set(' + safeJson([...WEEKLY_ENTRY_STATUSES]) + ');const m=document.getElementById("month");function esc(s){return String(s??"").replace(/[&<>"\']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","\'":"&#39;"}[c]))}async function load(){const r=await fetch(SERVER+"/okr-data");const data=await r.json();employees.forEach(emp=>{const record=data[emp.empId+"|"+m.value];const box=document.querySelector(`[data-emp="${emp.empId}"] .record`);if(!record){box.innerHTML=`<span class="status">尚未启动</span><div class="actions"><span></span><button class="btn primary invite">邀请员工填写OKR</button></div>`;box.querySelector(".invite").onclick=()=>invite(emp);return}const links={target_submitted:"target-manager",target_manager_approved:"target-bp",target_bp_approved:"target-confirm",target_confirmed:"self-review",self_reviewed:"manager-grade",manager_graded:"bp-grade",completed:"result-confirm",invited:"fill",target_rejected:"fill"};const type=links[record.status],weekly=weeklyStatuses.has(record.status);box.innerHTML=`<span class="status">${esc(labels[record.status]||record.status)}</span>${record.bpGrade?`<div class="banner"><strong>最终等级 ${esc(record.bpGrade)} · 独立系数 ${esc(record.finalCoefficient)}%</strong></div>`:""}<div class="actions"><button class="btn remind">一键催办</button><div>${weekly?`<a class="btn" target="_blank" href="${SERVER}/okr-admin-open/weekly-fill/${encodeURIComponent(emp.empId)}/${encodeURIComponent(m.value)}">填写/更新周度O/KR</a>`:""}${type?` <a class="btn" target="_blank" href="${SERVER}/okr-admin-open/${type}/${encodeURIComponent(emp.empId)}/${encodeURIComponent(m.value)}">打开当前办理页</a>`:""}</div></div>`;box.querySelector(".remind").onclick=()=>remind(emp)})}async function invite(emp){const r=await fetch(SERVER+"/okr-invite",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({empId:emp.empId,month:m.value})});const x=await r.json();if(!r.ok)return alert(x.error||"邀请失败");alert("OKR填写邀请已发送");load()}async function remind(emp){const r=await fetch(SERVER+"/okr-remind",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({empId:emp.empId,month:m.value})});const x=await r.json();alert(r.ok?"催办已发送":(x.error||"催办失败"))}refresh.onclick=load;load();';
    return page('OKR管理', body, script);
  }

  async function handle(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/okr-admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(adminPage(req.accessProfile)); return true;
    }
    if (req.method === 'GET' && pathname === '/okr-data') {
      const filtered = Object.fromEntries(Object.entries(records).filter(([, record]) => context.canAccessEmployee(req.accessProfile, record.empId, record.emp)));
      replyJson(res, 200, filtered); return true;
    }
    if (req.method === 'GET' && pathname === '/okr-archive-view') {
      try {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const data = { empId: query.get('empId') || '', month: query.get('month') || '' };
        const record = recordFor(data);
        if (!context.canAccessEmployee(req.accessProfile, record.empId, record.emp)) { res.writeHead(403); res.end('无权查看该员工归档'); return true; }
        const result = query.get('type') === 'result';
        const relativeFile = result ? record.resultArchiveFile : record.targetArchiveFile;
        if (!relativeFile) throw new Error('对应OKR归档尚未生成');
        const fullPath = path.resolve(context.dataDir, relativeFile);
        const allowedRoot = path.resolve(result ? resultArchiveDir : targetArchiveDir) + path.sep;
        if (!fullPath.startsWith(allowedRoot) || !fs.existsSync(fullPath)) throw new Error('对应OKR归档文件不存在');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'inline; filename="okr-archive.html"', 'Cache-Control': 'private, no-store' });
        res.end(fs.readFileSync(fullPath, 'utf8'));
      } catch (error) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(error.message); }
      return true;
    }
    if (req.method === 'GET' && pathname.startsWith('/okr-admin-open/')) {
      const parts = pathname.split('/').filter(Boolean);
      const type = String(parts[1] || '');
      const empId = decodeURIComponent(parts[2] || '');
      const month = decodeURIComponent(parts[3] || '');
      const allowedTypes = new Set(['fill', 'weekly-fill', 'target-manager', 'target-bp', 'target-confirm', 'self-review', 'manager-grade', 'bp-grade', 'result-confirm', 'result-bp']);
      const record = records[key(empId, month)];
      if (!record || !allowedTypes.has(type) || !context.canAccessEmployee(req.accessProfile, empId, record.emp)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('未找到可办理的OKR流程'); return true;
      }
      res.writeHead(302, { Location: context.publicLink(route(type, empId, month)), 'Cache-Control': 'no-store' }); res.end(); return true;
    }
    if (req.method === 'POST' && pathname === '/okr-invite') {
      try {
        const data = JSON.parse(await context.readBody(req));
        const employee = assertEligible(data.empId); const month = validateMonth(data.month);
        if (!context.canAccessEmployee(req.accessProfile, employee.empId, employee)) { replyJson(res, 403, { error: '无权访问该员工数据' }); return true; }
        const recordKey = key(employee.empId, month);
        if (records[recordKey]) {
          // Invitation is an idempotent workflow start. A slow or interrupted
          // browser refresh must never cause a second employee notification.
          replyJson(res, 200, { success: true, status: records[recordKey].status, alreadyInvited: true, record: records[recordKey] });
          return true;
        }
        const record = records[recordKey] || { empId: employee.empId, month, emp: employee, objectives: [], adjustments: [] };
        record.status = 'invited'; record.invitedAt = new Date().toISOString(); records[recordKey] = record; save();
        const delivery = await notify(record, month + ' OKR目标填写邀请', '请填写本月OKR目标。OKR与KPI并行，O权重及KR权重均须合计100%。', 'fill', employee.name);
        record.invitationDelivery = {
          completedAt: new Date().toISOString(),
          sent: Boolean(delivery && delivery.sent), queued: Boolean(delivery && delivery.queued),
          disabled: Boolean(delivery && delivery.disabled), channel: String(delivery && delivery.channel || ''),
          receipt: delivery && delivery.receipt || null, error: String(delivery && delivery.error || '')
        };
        save();
        replyJson(res, 200, { success: true, status: record.status, alreadyInvited: false, notification: delivery, record });
      } catch (error) { replyJson(res, 400, { error: error.message }); }
      return true;
    }
    if (req.method === 'POST' && pathname === '/okr-remind') {
      try {
        const data = JSON.parse(await context.readBody(req)); const record = recordFor(data);
        if (!context.canAccessEmployee(req.accessProfile, record.empId, record.emp)) { replyJson(res, 403, { error: '无权访问该员工数据' }); return true; }
        const current = actionPagePath(record); if (!current) throw new Error('OKR流程已完成，无需催办');
        const userId = context.findUserId(current.recipient); if (!userId) throw new Error('未找到' + current.recipient + '的钉钉账号');
        const delivery = await context.enqueueBotMessage(userId, 'OKR流程催办 - ' + record.month + record.emp.name, record.month + record.emp.name + '的OKR流程当前处于“' + STATUS_LABELS[record.status] + '”，请及时处理。\n\n待办页面：' + context.publicLink(current.pagePath));
        replyJson(res, 200, { success: true, notification: delivery });
      } catch (error) { replyJson(res, 400, { error: error.message }); }
      return true;
    }
    if (req.method === 'POST' && pathname === '/okr-send-self-review') {
      try {
        const data = JSON.parse(await context.readBody(req)); const record = recordFor(data);
        if (!context.canAccessEmployee(req.accessProfile, record.empId, record.emp)) { replyJson(res, 403, { error: '无权访问该员工数据' }); return true; }
        if (record.status !== 'target_confirmed') throw new Error('仅已完成OKR目标签字的员工可以发送自评');
        const delivery = await notify(record, '填写OKR月度结果 - ' + record.month, '你的OKR目标已确认归档，请填写各KR完成情况和月度总结。', 'self-review', record.emp.name);
        if (!delivery || (!delivery.sent && !delivery.queued && !delivery.disabled)) throw new Error(delivery && delivery.error || 'OKR自评通知发送失败');
        record.status = 'self_review_invited'; record.selfReviewSentAt = new Date().toISOString(); save();
        replyJson(res, 200, { success: true, status: record.status, notification: delivery });
      } catch (error) { replyJson(res, 400, { error: error.message }); }
      return true;
    }
    if (req.method === 'POST' && pathname === '/okr-sign-otp') {
      try {
        cleanupSigningSessions();
        const data = JSON.parse(await context.readBody(req));
        const record = recordFor(data);
        const resultSigning = String(data.pagePath || '') === route('result-confirm', record.empId, record.month);
        const expectedStatus = resultSigning ? 'completed' : 'target_bp_approved';
        if (record.status !== expectedStatus) throw new Error(resultSigning ? '当前不在员工确认OKR结果节点' : '当前不在员工确认OKR目标节点');
        const expectedPath = route(resultSigning ? 'result-confirm' : 'target-confirm', record.empId, record.month);
        if (String(data.pagePath || '') !== expectedPath || !safeEqual(data.pageToken, context.signPath(expectedPath))) {
          replyJson(res, 403, { error: '无效或已失效的OKR确认链接' }); return true;
        }
        const documentType = resultSigning ? 'result' : 'target';
        const recent = [...signingChallenges.values()].find(item => item.empId === record.empId && item.month === record.month && item.documentType === documentType && item.expiresAt > Date.now() && item.attempts < 5);
        if (recent) {
          replyJson(res, 200, { success: true, resumed: true, challengeId: recent.challengeId, expiresIn: Math.max(1, Math.ceil((recent.expiresAt - Date.now()) / 1000)) }); return true;
        }
        const userId = context.findUserId(record.emp.name);
        if (!userId) throw new Error('未找到该员工本人的钉钉账号，不能签署');
        const testCode = process.env.NODE_ENV === 'test' && /^\d{6}$/.test(String(process.env.SIGNING_OTP_TEST_CODE || '')) ? String(process.env.SIGNING_OTP_TEST_CODE) : '';
        const code = testCode || String(crypto.randomInt(100000, 1000000));
        const challengeId = crypto.randomUUID();
        const challenge = { challengeId, empId: record.empId, month: record.month, documentType, codeHash: sha256(challengeId + '|' + code), attempts: 0, createdAt: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000 };
        const documentLabel = resultSigning ? 'OKR结果' : 'OKR目标';
        const delivery = await context.sendSigningOtpNow(userId, documentLabel + '签署验证码 - ' + record.month, record.emp.realName + '，你正在确认' + record.month + documentLabel + '。\n\n本人验证码：' + code + '\n\n验证码5分钟内有效，请勿转发或告知他人。');
        if (!delivery || !delivery.sent) throw new Error('验证码未能发送到本人钉钉，请稍后重试');
        signingChallenges.set(challengeId, challenge);
        replyJson(res, 200, { success: true, challengeId, expiresIn: 300, delivery: { sent: true } });
      } catch (error) { replyJson(res, 400, { error: error.message }); }
      return true;
    }
    if (req.method === 'POST' && pathname === '/okr-sign-verify') {
      try {
        cleanupSigningSessions();
        const data = JSON.parse(await context.readBody(req));
        const challenge = signingChallenges.get(String(data.challengeId || ''));
        if (!challenge || challenge.expiresAt <= Date.now()) throw new Error('验证码已失效，请重新发送');
        challenge.attempts += 1;
        if (challenge.attempts > 5) { signingChallenges.delete(challenge.challengeId); throw new Error('验证码错误次数过多，请重新发送'); }
        if (!safeEqual(challenge.codeHash, sha256(challenge.challengeId + '|' + String(data.code || '')))) throw new Error('验证码错误');
        signingChallenges.delete(challenge.challengeId);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        signingVerifications.set(verificationToken, { empId: challenge.empId, month: challenge.month, documentType: challenge.documentType, verifiedAt: new Date().toISOString(), expiresAt: Date.now() + 10 * 60 * 1000, used: false });
        replyJson(res, 200, { success: true, verificationToken, verifiedAt: new Date().toISOString(), expiresIn: 600 });
      } catch (error) { replyJson(res, 400, { error: error.message }); }
      return true;
    }
    const publicPages = [
      ['/okr-fill/', 'fill'], ['/okr-weekly-fill/', 'weekly-fill'], ['/okr-target-manager/', 'target-manager'], ['/okr-target-bp/', 'target-bp'],
      ['/okr-target-confirm/', 'target-confirm'], ['/okr-self-review/', 'self-review'],
      ['/okr-manager-grade/', 'manager-grade'], ['/okr-bp-grade/', 'bp-grade'], ['/okr-result-confirm/', 'result-confirm'], ['/okr-result-bp/', 'result-bp']
    ];
    if (req.method === 'GET') {
      const matched = publicPages.find(([prefix]) => pathname.startsWith(prefix));
      if (matched) {
        if (!context.isValidPublicToken(req, pathname)) { res.writeHead(403); res.end('Invalid or missing link token'); return true; }
        try {
          const data = decodeRoute(pathname, matched[0]); const record = recordFor(data); let html = '';
          if (matched[1] === 'fill') html = formPage(record, 'employee');
          else if (matched[1] === 'weekly-fill') html = weeklyEntryPage(record);
          else if (matched[1] === 'target-manager') html = formPage(record, 'manager');
          else if (matched[1] === 'target-bp') html = formPage(record, 'bp');
          else if (matched[1] === 'target-confirm') html = confirmationPage(record, false);
          else if (matched[1] === 'self-review') html = selfReviewPage(record);
          else if (matched[1] === 'manager-grade') html = gradePage(record, 'manager');
          else if (matched[1] === 'bp-grade') html = gradePage(record, 'bp');
          else if (matched[1] === 'result-bp') html = resultBpReviewPage(record);
          else html = confirmationPage(record, true);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' }); res.end(html);
        } catch (error) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(error.message); }
        return true;
      }
    }
    if (req.method === 'POST' && pathname === '/okr-action') {
      try {
        const data = JSON.parse(await context.readBody(req)); const action = String(data.action || '');
        if (!context.isValidWorkflowAction(data, action)) { replyJson(res, 403, { error: '无效或已失效的流程链接' }); return true; }
        const record = recordFor(data); let delivery = null; let message = '';
        if (action === 'okr-weekly-save') {
          if (!weeklyEntryAllowed(record)) throw new Error('当前OKR流程节点不可填写周度O/KR');
          const before = snapshotObjectives(currentWeeklyObjectives(record));
          const next = normalizeWeeklyObjectives(data.weeklyObjectives);
          record.operationalWeeklyObjectives = next;
          record.weeklyUpdatedAt = new Date().toISOString();
          record.weeklyUpdates = Array.isArray(record.weeklyUpdates) ? record.weeklyUpdates : [];
          record.weeklyUpdates.push({ updatedAt: record.weeklyUpdatedAt, before, after: snapshotObjectives(next) });
          message = '周度O/KR已保存，现有OKR流程节点未改变。';
        } else if (action === 'okr-target-submit') {
          if (!['invited', 'target_rejected'].includes(record.status)) throw new Error('OKR目标已经提交，不能重复处理');
          record.objectives = normalizeObjectives(data.objectives); record.weeklyObjectives = normalizeWeeklyObjectives(data.weeklyObjectives); record.status = 'target_submitted'; record.submittedAt = new Date().toISOString(); record.reviewReason = '';
          delivery = await notify(record, '直属上级确认OKR目标 - ' + record.month + record.emp.name, record.emp.name + '已提交OKR目标，请确认或直接调整。', 'target-manager', record.emp.directMgr); message = '已通知直属上级确认OKR目标。';
        } else if (action === 'okr-target-manager' || action === 'okr-target-bp') {
          const manager = action === 'okr-target-manager'; const required = manager ? 'target_submitted' : 'target_manager_approved';
          if (record.status !== required) throw new Error('当前OKR目标不在该确认节点');
          const next = normalizeObjectives(data.objectives); const nextWeekly = normalizeWeeklyObjectives(data.weeklyObjectives);
          const beforeTarget = { objectives: snapshotObjectives(record.objectives), weeklyObjectives: snapshotObjectives(Array.isArray(record.weeklyObjectives) ? record.weeklyObjectives : legacyWeeklyObjectives(record.objectives)) };
          const afterTarget = { objectives: snapshotObjectives(next), weeklyObjectives: snapshotObjectives(nextWeekly) };
          const changes = objectiveChanges(beforeTarget, afterTarget);
          if (changes.length) { record.adjustments = record.adjustments || []; record.adjustments.push({ actorRole: manager ? '直属上级' : 'BP', actorName: manager ? record.emp.directMgr : record.emp.hrbp, adjustedAt: new Date().toISOString(), before: beforeTarget, after: afterTarget }); }
          record.objectives = next; record.weeklyObjectives = nextWeekly;
          if (manager) { record.status = 'target_manager_approved'; delivery = await notify(record, 'BP确认OKR目标 - ' + record.month + record.emp.name, '直属上级已确认OKR目标，请BP继续核对或调整。', 'target-bp', record.emp.hrbp); message = '上级已确认，已发送BP。'; }
          else { record.status = 'target_bp_approved'; delivery = await notify(record, '员工确认OKR目标 - ' + record.month, 'BP已确认你的OKR目标，请本人确认。', 'target-confirm', record.emp.name); message = 'BP已确认，已发送员工确认OKR目标。'; }
        } else if (action === 'okr-target-confirm') {
          if (record.status !== 'target_bp_approved') throw new Error('当前不在员工确认OKR目标节点');
          cleanupSigningSessions();
          const verification = signingVerifications.get(String(data.verificationToken || ''));
          if (!verification || verification.documentType !== 'target' || verification.used || verification.expiresAt <= Date.now() || verification.empId !== record.empId || verification.month !== record.month) throw new Error('本人钉钉验证未完成或已失效');
          const signatureError = validateSignature(data, record);
          if (signatureError) throw new Error(signatureError);
          verification.used = true;
          record.targetSignature = { realName: record.emp.realName, signatureText: data.signatureText, signatureData: data.signatureData, signatureMetrics: data.signatureMetrics, verifiedAt: verification.verifiedAt, signedAt: new Date().toISOString(), method: 'dingtalk-otp+handwriting' };
          record.status = 'target_confirmed'; record.targetConfirmedAt = record.targetSignature.signedAt; record.targetArchiveFile = archive(record, 'target');
          message = 'OKR目标已确认并归档，请管理员在后台手动发送OKR自评。';
        } else if (action === 'okr-self-review') {
          if (record.status !== 'self_review_invited') throw new Error('当前不在员工填写OKR结果节点');
          const completions = Array.isArray(data.completions) ? data.completions : [];
          record.objectives.forEach((objective, oi) => objective.keyResults.forEach((kr, ki) => { const item = completions.find(value => value.objectiveIndex === oi && value.krIndex === ki); if (!item || !String(item.completion || '').trim()) throw new Error('请填写O' + (oi + 1) + ' KR' + (ki + 1) + '的完成情况'); kr.completion = String(item.completion).trim(); }));
          record.summary = String(data.summary || '').trim(); if (!record.summary) throw new Error('请填写OKR月度总结');
          delete record.selfGrade; record.status = 'self_reviewed';
          delivery = await notify(record, '直属上级评定OKR等级 - ' + record.month + record.emp.name, record.emp.name + '已提交OKR完成情况，请直属上级评定等级。', 'manager-grade', record.emp.directMgr); message = 'OKR月度结果已提交直属上级。';
        } else if (action === 'okr-manager-grade' || action === 'okr-bp-grade') {
          if (!Object.prototype.hasOwnProperty.call(GRADE_COEFFICIENTS, data.grade)) throw new Error('无效的OKR等级');
          const manager = action === 'okr-manager-grade'; const required = manager ? 'self_reviewed' : 'manager_graded';
          if (record.status !== required) throw new Error('当前不在该等级评定节点');
          if (manager) { record.managerGrade = data.grade; record.managerComment = String(data.comment || '').trim(); record.status = 'manager_graded'; delivery = await notify(record, 'BP核定OKR等级 - ' + record.month + record.emp.name, '直属上级已评定OKR等级，请BP核定最终等级。', 'bp-grade', record.emp.hrbp); message = '上级等级已提交BP核定。'; }
          else { record.bpGrade = data.grade; record.bpComment = String(data.comment || '').trim(); record.finalCoefficient = GRADE_COEFFICIENTS[data.grade]; record.status = 'completed'; record.completedAt = new Date().toISOString(); delivery = await notify(record, '员工确认OKR结果 - ' + record.month, 'BP已核定你的OKR最终等级为' + data.grade + '，独立奖金发放系数为' + record.finalCoefficient + '%，请本人确认结果。', 'result-confirm', record.emp.name); message = 'BP最终等级已核定，独立奖金发放系数为' + record.finalCoefficient + '%。'; }
        } else if (action === 'okr-result-confirm') {
          if (record.status !== 'completed') throw new Error('当前不在员工确认OKR结果节点');
          cleanupSigningSessions();
          const verification = signingVerifications.get(String(data.verificationToken || ''));
          if (!verification || verification.documentType !== 'result' || verification.used || verification.expiresAt <= Date.now() || verification.empId !== record.empId || verification.month !== record.month) throw new Error('本人钉钉验证未完成或已失效');
          const signatureError = validateSignature(data, record);
          if (signatureError) throw new Error(signatureError);
          verification.used = true;
          record.resultSignature = { realName: record.emp.realName, signatureText: data.signatureText, signatureData: data.signatureData, signatureMetrics: data.signatureMetrics, verifiedAt: verification.verifiedAt, signedAt: new Date().toISOString(), method: 'dingtalk-otp+handwriting' };
          record.status = 'result_signed_pending_bp'; record.resultConfirmedAt = record.resultSignature.signedAt;
          delivery = await notify(record, 'BP复核OKR结果归档 - ' + record.month + record.emp.name, record.emp.name + '已完成OKR结果签字，请BP核对无误后正式归档。', 'result-bp', record.emp.hrbp); message = 'OKR结果已签字，等待BP复核归档。';
        } else if (action === 'okr-result-bp-final') {
          if (record.status !== 'result_signed_pending_bp') throw new Error('当前不在BP复核OKR结果归档节点');
          record.status = 'result_confirmed'; record.resultBpReviewedAt = new Date().toISOString(); record.resultBpReviewedBy = record.emp.hrbp; record.resultArchiveFile = archive(record, 'result'); message = 'OKR结果已完成BP复核并正式归档。';
        } else throw new Error('无效的OKR流程操作');
        save(); replyJson(res, 200, { success: true, status: record.status, message, notification: delivery });
      } catch (error) { replyJson(res, 400, { error: error.message }); }
      return true;
    }
    return false;
  }

  return { handle, statusLabels: STATUS_LABELS, grades: GRADE_COEFFICIENTS, eligible: ELIGIBLE, getRecords: () => records, validateObjectives: normalizeObjectives, validateWeeklyObjectives: normalizeWeeklyObjectives };
}

module.exports = { createOkrModule, ELIGIBLE, GRADES, GRADE_COEFFICIENTS, STATUS_LABELS, validateObjectives: normalizeObjectives, validateWeeklyObjectives: normalizeWeeklyObjectives };
