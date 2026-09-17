'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  accessProfileForName,
  canAccessDepartment,
  canAccessApprovalGroup,
  canAccessEmployee,
  filterAssessmentMapForProfile,
  dashboardAccessContext,
  buildDashboardHtml,
  organizationDepartmentFor
} = require('./eval-server');

for (const name of ['桑葚', '薏米', '路得', 'Ben']) {
  const profile = accessProfileForName(name);
  assert.equal(profile.authorized, true, name + ' should be authorized');
  assert.equal(profile.global, true, name + ' should be a global admin');
  assert.equal(canAccessDepartment(profile, '任意部门'), true);
}

const qq = accessProfileForName('球球');
assert.deepEqual(qq.departments, ['客户运营部', '采购仓储部', '产品设计']);
assert.equal(canAccessDepartment(qq, '客户运营部'), true);
assert.equal(canAccessDepartment(qq, '采购仓储部'), true);
assert.equal(canAccessDepartment(qq, '产品设计'), true);
assert.equal(canAccessDepartment(qq, '财务部'), false);
assert.equal(canAccessApprovalGroup(qq, '采购仓储部、产品设计'), true);
assert.equal(canAccessApprovalGroup(qq, '总裁办、人事行政部、财务部'), false);

const hj = accessProfileForName('豪杰');
for (const department of ['品牌营销部', '天猫', '京东', '兴趣电商']) {
  assert.equal(canAccessDepartment(hj, department), true, '豪杰 should access ' + department);
}
assert.equal(canAccessDepartment(hj, '财务部'), false);

const singleDepartmentRoles = {
  '达古': '天猫', '多乐': '京东', '俊俊': '兴趣电商', '红豆': '客户运营部',
  '惜君': '信息技术部', '廿一': '产品设计', '安妮': '财务部'
};
for (const [name, department] of Object.entries(singleDepartmentRoles)) {
  const profile = accessProfileForName(name);
  assert.deepEqual(profile.departments, [department]);
  assert.equal(canAccessDepartment(profile, department), true);
  assert.equal(canAccessDepartment(profile, '人事行政部'), false);
}

assert.equal(accessProfileForName('普通员工').authorized, false);

const daGu = accessProfileForName('达古');
assert.equal(canAccessEmployee(daGu, 'test-tmall', { name: '图图', dept: '营销中心' }), true);
assert.equal(canAccessEmployee(daGu, 'test-jd', { name: '归雾', dept: '营销中心' }), false);
assert.equal(canAccessEmployee(daGu, 'E035', { name: '图图', dept: '天猫' }), false, 'request metadata must not override the canonical 京东 identity');
const filtered = filterAssessmentMapForProfile({
  'test-tmall|2026年7月': { empId: 'test-tmall', emp: { name: '图图', dept: '营销中心' } },
  'test-jd|2026年7月': { empId: 'test-jd', emp: { name: '归雾', dept: '营销中心' } }
}, daGu);
assert.deepEqual(Object.keys(filtered), ['test-tmall|2026年7月']);

assert.equal(organizationDepartmentFor('豪杰', '营销中心'), '品牌营销部', 'legacy DingTalk department name must normalize to the new name');
assert.equal(canAccessDepartment(hj, '营销中心'), true, 'legacy department labels remain access-compatible during migration');

assert.deepEqual(dashboardAccessContext(qq), {
  name: '球球', role: '跨部门负责人', global: false,
  departments: ['客户运营部', '采购仓储部', '产品设计'], canManageOrganization: false,
  canAuthorTargets: false, canInitiateTargetAdjustment: false, canManageMonthlyEvents: false, canViewOperationLogs: false, canManageManagerStage: true,
  canManageTargetBpStage: false, canManageResultBpStage: false
});

const daGuHtml = buildDashboardHtml(daGu);
const seedMatch = daGuHtml.match(/const EMPLOYEES = (\[[\s\S]*?\]);\n\n    const KPIS/);
assert.ok(seedMatch, 'permission-filtered employee seed should be present');
const daGuEmployees = JSON.parse(seedMatch[1]);
assert.ok(daGuEmployees.length > 0, '达古 should receive the 天猫 roster');
assert.ok(daGuEmployees.every(employee => employee.dept === '天猫'), '达古 page must not embed other departments');
assert.ok(daGuHtml.includes('"name":"达古"'));
assert.ok(daGuHtml.includes('"global":false'));

const qqHtml = buildDashboardHtml(qq);
const qqSeed = JSON.parse(qqHtml.match(/const EMPLOYEES = (\[[\s\S]*?\]);\n\n    const KPIS/)[1]);
assert.ok(qqSeed.length > 0);
assert.ok(qqSeed.every(employee => qq.departments.includes(employee.dept)), '球球 page must contain only the three authorized departments');

// Department owners must be allowed to run the non-sensitive DingTalk channel
// readiness check before submitting targets. The route is already protected by
// requireAdmin; an additional global-only gate would falsely report the channel
// as unconfigured for scoped administrators such as 惜君.
const serverSource = fs.readFileSync(path.join(__dirname, 'eval-server.js'), 'utf8');
const deliveryRoute = serverSource.match(/if \(req\.method === 'GET' && req\.url === '\/delivery-status'\) \{([\s\S]*?)\n  \}/);
assert.ok(deliveryRoute, 'delivery-status route should exist');
assert.ok(!deliveryRoute[1].includes('requireGlobalAccess'), 'delivery-status must be available to authenticated scoped administrators');

const dashboardSource = fs.readFileSync(path.join(__dirname, 'preview.html'), 'utf8');
assert.ok(dashboardSource.includes("if (!deliveryResponse.ok)"), 'dashboard should distinguish permission/session errors from missing channel configuration');

console.log('Access-control matrix checks passed');
