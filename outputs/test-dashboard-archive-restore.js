const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dashboardNames = [
  'preview.html',
  String.fromCharCode(0x7ee9, 0x6548, 0x7ba1, 0x7406, 0x7cfb, 0x7edf) + '.html',
];
const results = {};

for (const filename of dashboardNames) {
  const fullPath = path.join(__dirname, filename);
  const html = fs.readFileSync(fullPath, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  for (const script of scripts) new Function(script[1]);
  const resolverStart = html.indexOf('function employeeForEvaluation(evaluation)');
  const resolverEnd = html.indexOf('function evaluationParticipatesInAssessmentMonth', resolverStart);
  const resolverSource = html.slice(resolverStart, resolverEnd).trim();
  const resolveEmployee = new Function('state', 'SERVER_EMPLOYEE_IDENTITIES', 'evaluationIdentityCache', 'ARCHIVES', 'assessmentKey', 'evaluation', `return (${resolverSource})(evaluation);`);
  const resolvedHistoricEmployee = resolveEmployee(
    { employees: [{ id: 'E069', name: '未知员工', position: '未匹配岗位' }], targetDrafts: {} },
    { E069: { name: '玖杉', realName: '周荣', dept: '人事行政部', position: '人事行政专员' } },
    new Map(), [], (empId, month) => empId + '|' + month,
    { empId: 'E069', month: '2026年7月' }
  );
  results[filename] = {
    validScripts: scripts.length > 0,
    loadsTargets: html.includes("fetch(SYNC_SERVER_URL + '/kpi-targets')"),
    archiveOnlyRestore: html.includes('serverArchives.forEach(record => {') && html.includes('const targetInfo = kpiTargetData[empId'),
    preservesExisting: html.includes('const hasLocalTargets = state.kpis.some'),
    restoresReadOnlyDetail: html.includes('已恢复归档KPI只读明细'),
    resolvesHistoricEmployeeIds: html.includes('function employeeForEvaluation(evaluation)') && html.includes('const emp = employeeForEvaluation(ev);'),
    enrichesEvaluationIdentity: html.includes('function enrichEvaluationIdentity(evaluation, serverRecord)') && html.includes('changed = enrichEvaluationIdentity(ev, data) || changed;'),
    backfillsArchiveIdentity: html.includes('changed = enrichEvaluationIdentity(hasEval, { ...record, ...data }) || changed;'),
    cachesServerIdentity: html.includes('const evaluationIdentityCache = new Map();') && html.includes('changed = rememberEvaluationIdentity(record) || changed;'),
    usesServerIdentityMap: html.includes('const SERVER_EMPLOYEE_IDENTITIES = {};') && html.includes('SERVER_EMPLOYEE_IDENTITIES[evaluation.empId]'),
    repairsMalformedLocalEmployee: html.includes('if (direct && serverIdentity)') && html.includes("normalized !== 'undefined'") && html.includes("'未知员工', '未匹配部门', '未匹配岗位'"),
    repairsMalformedIdentityRuntime: resolvedHistoricEmployee.name === '玖杉' && resolvedHistoricEmployee.position === '人事行政专员',
    avoidsUndefinedEmployeeLabels: !html.includes('${emp?.name}</div><div class="text-xs text-gray-500">${emp?.position}</div>'),
  };
}

const hashes = dashboardNames.map((filename) => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, filename))).digest('hex'));
results.identicalDashboards = { sameHash: hashes[0] === hashes[1] };
console.log(JSON.stringify(results));
if (!Object.values(results).every((checks) => Object.values(checks).every(Boolean))) process.exitCode = 1;
