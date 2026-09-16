const fs = require('fs');
const path = require('path');

const dashboard = fs.readFileSync(path.join(__dirname, 'preview.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'eval-server.js'), 'utf8');
const resultTemplate = fs.readFileSync(path.join(__dirname, '绩效结果确认书模板.html'), 'utf8');

const checks = {
  serverAuthoritativeTargetReconcile: dashboard.includes('function reconcileServerTargets(kpiTargetData)') &&
    dashboard.includes('state.kpis = state.kpis.filter(kpi => !(kpi.empId === empId && kpi.month === month))') &&
    dashboard.includes('const reconciledServerTargets = reconcileServerTargets(kpiTargetData)'),
  allTargetSourcesIncluded: !dashboard.includes("targetInfo.source !== 'employee-self-fill'"),
  realtimeRefresh: dashboard.includes('setInterval(() => { syncFromServer(); }, 5000)') &&
    dashboard.includes("window.addEventListener('focus', () => syncFromServer())") &&
    dashboard.includes("document.addEventListener('visibilitychange'"),
  disputeReminder: resultTemplate.includes('绩效如有异议，请于收到绩效2日内联系BP进行校准') &&
    resultTemplate.includes('逾期未反馈的，视为对绩效结果的认可，不再受理异议申请'),
  employeeSignatureDoesNotArchive: server.includes("protectSignedDocument('result', data, verificationResult.verification, req, { archive: false })") &&
    server.includes("data.bpReviewStatus = 'pending'") && server.includes('pendingBpReview: true'),
  bpFinalArchiveEndpoint: server.includes("pathname === '/review-result-bp'") &&
    server.includes("isValidWorkflowAction(data, 'result-bp-final')") && server.includes("appendSignatureAudit(req, 'RESULT_BP_ARCHIVED'") &&
    server.includes("record.archiveFile = archiveSignedDocument('result'"),
  departmentOaAfterBpArchive: server.indexOf('const oaApproval = await maybeSubmitDepartmentOa(empId, month, targetInfo.emp.dept);') >
    server.indexOf("record.bpReviewStatus = 'approved'"),
  dashboardPendingStage: dashboard.includes('待BP归档') && dashboard.includes('员工已签，待BP归档'),
  templateWaitsForBp: resultTemplate.includes('已通知BP复核；BP核对无误后将正式归档') &&
    !resultTemplate.includes('绩效结果已确认并自动归档')
};

console.log(JSON.stringify(checks));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
