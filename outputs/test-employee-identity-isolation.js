const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const server = fs.readFileSync(path.join(__dirname, 'eval-server.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(__dirname, 'preview.html'), 'utf8');
const dashboardCopy = fs.readFileSync(path.join(__dirname, '绩效管理系统.html'), 'utf8');

const checks = {
  serverOwnsImmutableIds: server.includes('function ensureCanonicalAssessmentRoster(roster, options = {})') &&
    server.includes("return 'D' + sha256(seed).slice(0, 12).toUpperCase()") &&
    server.includes('assessmentId: String(assessmentEmployee.id)'),
  historicIdentityRepair: server.includes('function repairAssessmentStoreIdentities') &&
    server.includes("repairAssessmentStoreIdentities(kpiTargets, KPI_TARGETS_FILE") &&
    server.includes("repairAssessmentStoreIdentities(evalData, DATA_FILE") &&
    server.includes("repairAssessmentStoreIdentities(kpiData, KPI_DATA_FILE"),
  signedSealRemainsVerifiableAfterCanonicalMigration: server.includes('data.identityMigration && data.identityMigration.originalEmpId || data.empId'),
  writePathIdentityGuard: [
    "assertCanonicalAssessmentSubject(empId, emp, '提交绩效目标')",
    "assertCanonicalAssessmentSubject(empId, emp, '邀请员工填写目标')",
    "assertCanonicalAssessmentSubject(data.empId, targetInfo.emp, '员工自评')",
    "assertCanonicalAssessmentSubject(data.empId, targetInfo.emp, '绩效目标签字')",
    "assertCanonicalAssessmentSubject(data.empId, targetInfo.emp, '绩效结果签字')"
  ].every(fragment => server.includes(fragment)),
  browserCollisionQuarantine: dashboard.includes('function purgeCollidingLocalWorkflowId(empId)') &&
    dashboard.includes('authoritativeOldIdentity && !identityMatchesRosterSubject') &&
    dashboard.includes('已隔离员工ID碰撞，未迁移旧员工绩效数据'),
  dashboardsIdentical: crypto.createHash('sha256').update(dashboard).digest('hex') ===
    crypto.createHash('sha256').update(dashboardCopy).digest('hex')
};

console.log(JSON.stringify(checks));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
