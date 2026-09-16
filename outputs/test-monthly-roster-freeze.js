const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-month-roster-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'development';

const existing = {
  id: 'E001', userId: 'u-existing', name: '原员工', realName: '原姓名',
  department: '财务部', position: '会计', active: true, assessmentStartMonth: '2026年6月'
};
const legacyWithoutUserId = {
  id: 'E099', name: '旧员工', realName: '旧姓名', dept: '财务部',
  position: '会计', active: true, assessmentStartMonth: '2026年6月'
};
const cachedRoster = [
  { nick: '原员工', realName: '原姓名', userId: 'u-existing', department: '财务部', title: '会计', active: true, syncedAt: '2026-08-24T01:00:00.000Z' },
  { nick: '新员工', realName: '新姓名', userId: 'u-new', department: '财务部', title: '会计', active: true, syncedAt: '2026-08-24T01:00:00.000Z' }
];
fs.writeFileSync(path.join(dataDir, 'assessment_roster.json'), JSON.stringify([existing, legacyWithoutUserId]), 'utf8');
fs.writeFileSync(path.join(dataDir, 'roster.json'), JSON.stringify(cachedRoster), 'utf8');

const server = require('./eval-server');

// Ordinary startup/page reads may update known identity metadata, but must not
// enroll a newly cached DingTalk user.
server.ensureCanonicalAssessmentRoster(cachedRoster, { addMissing: false });
let persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'assessment_roster.json'), 'utf8'));
assert.strictEqual(persisted.length, 2);

// Only explicit synchronization enrolls the new user into the selected month.
server.ensureCanonicalAssessmentRoster(cachedRoster, {
  addMissing: true,
  updateMembership: true,
  assessmentMonth: '2026年8月'
});
persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'assessment_roster.json'), 'utf8'));
const added = persisted.find(employee => employee.userId === 'u-new');
assert(added && added.id.startsWith('D'));
assert.strictEqual(added.assessmentStartMonth, '2026年8月');
assert.strictEqual(server.assessmentRosterIncludesMonth(added, '2026年7月'), false);
assert.strictEqual(server.assessmentRosterIncludesMonth(added, '2026年8月'), true);

// A directory departure in August remains assessable for August and is
// removed beginning in September. Repeated later syncs must not move the
// already-recorded boundary forward.
server.ensureCanonicalAssessmentRoster([cachedRoster[0]], {
  addMissing: true,
  updateMembership: true,
  assessmentMonth: '2026年8月'
});
persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'assessment_roster.json'), 'utf8'));
const departed = persisted.find(employee => employee.userId === 'u-new');
assert.strictEqual(departed.assessmentInactiveFromMonth, '2026年9月');
assert.strictEqual(server.assessmentRosterIncludesMonth(departed, '2026年8月'), true);
assert.strictEqual(server.assessmentRosterIncludesMonth(departed, '2026年9月'), false);
server.ensureCanonicalAssessmentRoster([cachedRoster[0]], {
  addMissing: true,
  updateMembership: true,
  assessmentMonth: '2026年9月'
});
persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'assessment_roster.json'), 'utf8'));
assert.strictEqual(persisted.find(employee => employee.userId === 'u-new').assessmentInactiveFromMonth, '2026年9月');

// Legacy rows without a persisted DingTalk userId are matched by name. If no
// current directory identity matches, an explicit refresh must retire them
// from the following month instead of leaving them in every future period.
const legacyDeparted = persisted.find(employee => employee.id === 'E099');
assert.strictEqual(legacyDeparted.assessmentInactiveFromMonth, '2026年9月');
assert.strictEqual(server.assessmentRosterIncludesMonth(legacyDeparted, '2026年8月'), true);
assert.strictEqual(server.assessmentRosterIncludesMonth(legacyDeparted, '2026年9月'), false);

const dashboard = fs.readFileSync(path.join(__dirname, 'preview.html'), 'utf8');
assert(dashboard.includes('const DEFAULT_ASSESSMENT_MONTH = currentAssessmentMonth();'), 'entry month must follow the browser current year/month');
assert(dashboard.includes('kpiMonth: DEFAULT_ASSESSMENT_MONTH'));
assert(dashboard.includes('kanbanMonth: DEFAULT_ASSESSMENT_MONTH'));
assert(dashboard.includes('evalMonth: DEFAULT_ASSESSMENT_MONTH'));
assert(dashboard.includes('empMonth: DEFAULT_ASSESSMENT_MONTH'));
assert(dashboard.includes('employeeParticipatesInMonth(e, state.empMonth)'));
assert(dashboard.includes("employeeParticipatesInMonth(e, state.kpiMonth)"));
assert(dashboard.includes("employeeParticipatesInMonth(e, state.kanbanMonth)"));
assert(dashboard.includes('evaluationParticipatesInAssessmentMonth(evaluation)'), 'evaluation rows must honor the employee assessment month');
assert(dashboard.includes('data-eval-month-highlight'), 'evaluation month selector must be visually prominent');
const monthSelectorIndex = dashboard.indexOf('data-eval-month-highlight');
const evaluationTabIndex = dashboard.indexOf('data-eval-subtab="evaluation"', monthSelectorIndex);
assert(monthSelectorIndex >= 0 && evaluationTabIndex > monthSelectorIndex, 'month selector must appear before the evaluation tab');
assert(dashboard.includes('employee.directoryActive !== false'), 'directory comparison must only use current DingTalk members');
assert(dashboard.includes('离职人员在'), 'sync dialog must explain next-month departure behavior');
assert(!dashboard.includes('人已从绩效考核中移除</span>'), 'removed employee banner must stay hidden');

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('monthly roster freeze checks passed');
