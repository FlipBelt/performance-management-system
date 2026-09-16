'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dashboard = fs.readFileSync(path.join(__dirname, 'preview.html'), 'utf8');

assert(dashboard.includes('function targetInviteCandidates(month)'), 'bulk target invitation must have one eligibility function');
assert(dashboard.includes('employeeParticipatesInMonth(employee, month)'), 'bulk invitations must use the selected month roster');
assert(dashboard.includes('state.targetDrafts[key] || state.submittedTargetKeys.includes(key)'), 'active and submitted target workflows must be skipped');
assert(dashboard.includes('isKpiSubmissionLocked(employee.id, month)'), 'signed target archives must be skipped');
assert(dashboard.includes('data-invite-month-targets'), 'KPI page must expose the bulk invitation button');
assert(dashboard.includes('一键邀请当月员工填写目标'), 'bulk invitation must be clearly labelled');
assert(dashboard.includes("fetch(SYNC_SERVER_URL + '/delivery-status')"), 'notification channel must be checked before sending');
assert(dashboard.includes("fetch(SYNC_SERVER_URL + '/invite-target-draft'"), 'bulk invitation must reuse the authoritative single-employee endpoint');
assert(dashboard.includes('已有目标、确认中或已归档'), 'confirmation must explain which employees will be skipped');
assert(dashboard.includes('成功 ' + "' + sent.length + '" + ' 人，失败 '), 'completion status must report successes and failures');

assert(dashboard.includes('function targetReminderCandidates(month)'), 'bulk target reminders must have one eligibility function');
assert(dashboard.includes("invited: { key: 'employee-fill'"), 'employee target authoring must route to the employee reminder stage');
assert(dashboard.includes("submitted: { key: 'manager-review'"), 'submitted targets must route to the manager reminder stage');
assert(dashboard.includes("manager_approved: { key: 'bp-review'"), 'manager-approved targets must route to the BP reminder stage');
assert(dashboard.includes("approved: { key: 'employee-sign'"), 'BP-approved targets must route to the employee signature reminder stage');
assert(dashboard.includes("draft.status === 'rejected' && draft.source === 'admin-entry'"), 'admin-rejected drafts must not be bulk-reminded');
assert(dashboard.includes('data-remind-month-targets'), 'KPI page must expose the bulk target reminder button');
assert(dashboard.includes('一键催办当月目标流程'), 'bulk target reminder must be clearly labelled');
assert(dashboard.includes("sendWorkflowReminder(candidate.employee.id, month, 'reminder', { silent: true })"), 'bulk reminders must reuse the authoritative reminder endpoint');
assert(dashboard.includes('员工填写目标') && dashboard.includes('上级确认目标') && dashboard.includes('BP确认目标') && dashboard.includes('员工确认目标签字'), 'bulk reminder summary must explain every target workflow stage');
assert(dashboard.includes('已归档和无待办流程的员工将自动跳过'), 'bulk reminder confirmation must explain archive and no-workflow skips');

const scripts = [...dashboard.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(script => script.trim());
assert(scripts.length > 0, 'dashboard must contain an inline application script');
scripts.forEach(script => new Function(script));

console.log('bulk target invitation UI checks passed');
