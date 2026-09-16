const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-oa-exclusions-'));
const seed = (name, value) => fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));

for (const [name, value] of Object.entries({
  'selfeval_data.json': {},
  'mgrscore_data.json': {},
  'bpscore_data.json': {},
  'kpi_confirm_data.json': {},
  'result_confirm_data.json': {},
  'pending_notifications.json': [],
  'roster.json': [],
  'workflow_resets.json': {},
  'oa_approval_data.json': {},
  'admin_dingtalk_binding.json': {},
  'employee_overrides.json': {},
  'performance_exclusions.json': ['E006'],
  'assessment_roster.json': [
    { id: 'E004', name: '桑葚', realName: '於思旭', dept: '人事行政部', active: true },
    { id: 'E006', name: '路得', realName: '戈为静', dept: '人事行政部', active: true }
  ],
  'kpi_targets.json': {
    'E004|2026年7月': { month: '2026年7月', emp: { name: '桑葚', dept: '人事行政部' }, kpis: [{ name: '测试', weight: 100 }] },
    'E006|2026年7月': { month: '2026年7月', emp: { name: '路得', dept: '人事行政部' }, kpis: [{ name: '旧目标', weight: 100 }] }
  }
})) seed(name, value);

process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
const server = require('./eval-server');
const snapshot = server.departmentCompletionSnapshot('E004', '2026年7月', '人事行政部');

assert.strictEqual(snapshot.complete, false);
assert.strictEqual(snapshot.employeeCount, 1, '已移出考核员工不应阻塞部门OA');
assert.deepStrictEqual(snapshot.pending.map(item => item.empId), ['E004']);
console.log('department OA performance-exclusion test passed');
