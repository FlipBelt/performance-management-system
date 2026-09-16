const fs = require('fs');
const path = require('path');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'preview.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'eval-server.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(html.includes('BP确认目标'), '缺少BP目标确认入口');
assert(html.includes('BP结果评分'), '缺少BP结果评分入口');
assert(html.includes('ACCESS_CONTEXT.canManageResultBpStage'), '前端未使用服务端注入的BP评分权限');
assert(html.includes('ACCESS_CONTEXT.canManageManagerStage'), '前端未开放上级环节后台入口');
assert(html.includes('/admin-target-manager-page/'), '缺少后台上级目标确认入口');
assert(html.includes('/admin-manager-page/'), '缺少后台上级结果打分入口');
assert(server.includes("pathname.startsWith('/admin-target-bp-page/')"), 'BP目标后台路由未受管理员鉴权保护');
assert(server.includes("pathname.startsWith('/admin-bp-page/')"), 'BP评分后台路由未受管理员鉴权保护');
assert(server.includes("const BP_SCORER_NAMES = new Set(['桑葚', '薏米', '路得'])"), '服务端未定义BP评分白名单');
assert(server.includes('if (!canPerformBpResultInBackend(req.accessProfile))'), 'BP评分后台路由未执行角色校验');
assert(server.includes('仅系统管理员及桑葚、薏米、路得可提交BP结果评分'), 'BP评分提交接口未执行角色校验');
assert(server.includes("!req.accessProfile.global"), '后台BP操作未限制为全局管理员');
assert(/\/主播\|中控\/\.test\(position\)/.test(server), '服务端未放开中控岗0%单项权重');
assert(/\/主播\|中控\/\.test\(String\(selectedEmployee\.position/.test(html), '前端未放开主播岗和中控岗0%单项权重');
assert(/totalWeight !== 100/.test(html) && /totalWeight !== 100/.test(server), '总权重100%校验不完整');

const targetModeBlock = html.slice(html.indexOf('目标制定方式'), html.indexOf('if (empKpis.length === 0)'));
assert(!targetModeBlock.includes('data-workflow-reminder'), '目标制定方式区仍重复显示催办操作');
assert(!targetModeBlock.includes('targetDraftLabels[targetDraft.status]'), '目标制定方式区仍重复显示流程状态');

console.log('admin BP actions and zero-weight role checks passed');
