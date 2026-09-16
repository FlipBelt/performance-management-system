const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-oa-groups-'));
const seed = (name, value) => fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
const month = '2026年8月';
const employee = (id, name, department, directMgr = '') => ({
  id, name, realName: name + '实名', department, directMgr, active: true, assessmentStartMonth: '2026年6月'
});

const roster = [
  employee('TM1', '达古', '营销中心', '豪杰'),
  employee('TM2', '图图', '营销中心', '达古'),
  employee('TM3', '三七', '营销中心', '达古'),
  employee('TM4', '临时天猫成员', '营销中心', '达古'),
  employee('JD1', '多乐', '营销中心', '豪杰'),
  employee('JD2', '归雾', '营销中心', '多乐'),
  employee('JD3', '雯雯', '营销中心', '多乐'),
  employee('IN1', '俊俊', '营销中心', '豪杰'),
  employee('IN2', '六六', '营销中心', '俊俊'),
  employee('IN3', '大林', '营销中心', '俊俊'),
  employee('IN4', '小曹', '营销中心', '俊俊'),
  employee('IN5', '栗子', '营销中心', '俊俊'),
  employee('IN6', '一添', '营销中心', '俊俊'),
  employee('IN7', '云锦', '营销中心', '俊俊'),
  employee('MK1', '豪杰', '营销中心', 'Ben'),
  employee('FN1', 'Ben', '总裁办'),
  employee('FN2', '桑葚', '人事行政部', '路得'),
  employee('FN3', '安妮', '财务部', 'Ben'),
  employee('SC1', '球球', '采购仓储部', 'Ben'),
  employee('SC2', '廿一', '产品设计', '球球'),
  employee('IT1', '惜君', '信息技术部', 'Ben')
];

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
  'assessment_roster.json': roster,
  'kpi_targets.json': {}
})) seed(name, value);

process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
const server = require('./eval-server');

assert.strictEqual(server.organizationDepartmentFor('图图', '营销中心'), '天猫');
assert.strictEqual(server.organizationDepartmentFor('归雾', '营销中心'), '京东');
assert.strictEqual(server.organizationDepartmentFor('六六', '营销中心'), '兴趣电商');
assert.strictEqual(server.organizationDepartmentFor('豪杰', '营销中心'), '品牌营销部');
assert.strictEqual(server.approvalRouteForEmployee({ name: '临时天猫成员', department: '营销中心', directMgr: '达古' }).key, '天猫');

const snapshot = department => server.departmentCompletionSnapshot('', month, department);
assert.strictEqual(snapshot('天猫').employeeCount, 4, '天猫审批组应包含达古、固定成员及达古的其他直属人员');
assert.strictEqual(snapshot('天猫').department, '天猫');
assert.strictEqual(snapshot('京东').employeeCount, 3);
assert.strictEqual(snapshot('兴趣电商').employeeCount, 7);
assert.strictEqual(snapshot('品牌营销部').employeeCount, 1, '品牌营销部只保留未划入三个营销组的人员');
assert.strictEqual(snapshot('人事行政部').employeeCount, 3, '总裁办、人事行政部、财务部必须统一作为一个门槛');
assert.strictEqual(snapshot('人事行政部').approvalGroupKey, '总裁办、人事行政部、财务部');
assert.strictEqual(snapshot('产品设计').employeeCount, 2, '采购仓储部与产品设计必须统一作为一个门槛');
assert.strictEqual(snapshot('产品设计').approvalGroupKey, '采购仓储部、产品设计');
assert.strictEqual(snapshot('信息技术部').employeeCount, 1, '其余部门仍按原部门独立审批');

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('OA approval grouping checks passed');
