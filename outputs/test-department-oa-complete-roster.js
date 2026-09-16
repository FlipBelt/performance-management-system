const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-oa-roster-'));
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
  'performance_exclusions.json': [],
  'assessment_roster.json': [
    { id: 'E048', name: '关月', realName: '王素含', dept: '产品设计', active: true },
    { id: 'E049', name: '廿一', realName: '孙伟强', dept: '产品设计', active: true }
  ],
  'kpi_targets.json': {
    'E049|2026年7月': { month: '2026年7月', emp: { name: '廿一', realName: '孙伟强', dept: '产品设计' }, kpis: [{ name: '测试', weight: 100 }] }
  }
})) seed(name, value);

process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
const server = require('./eval-server');
const snapshot = server.departmentCompletionSnapshot('E049', '2026年7月', '产品设计');

assert.strictEqual(snapshot.complete, false);
assert.strictEqual(snapshot.employeeCount, 2, '部门完成门槛必须包含尚未创建目标的参评员工');
assert.deepStrictEqual(snapshot.pending.map(item => item.empId), ['E048', 'E049']);
assert.strictEqual(snapshot.pending[0].waitingFor, '绩效目标');
assert.strictEqual(snapshot.pending[1].waitingFor, 'BP核准');
console.log('department OA complete-roster gate test passed');
