const assert = require('assert');
const fs = require('fs');
const path = require('path');

const preview = fs.readFileSync(path.join(__dirname, 'preview.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'eval-server.js'), 'utf8');

assert.match(preview, /name:\s*['"]廿一['"][^\n]+directMgr:\s*['"]Ben['"]/, '廿一的默认直属上级应为 Ben');
assert.match(preview, /id:\s*['"]manager-ben['"][^\n]+name:\s*['"]Ben['"]/, 'Ben 应始终存在于直属上级候选目录');
assert.doesNotMatch(preview, /const candidates = state\.employees\.filter\(item => !state\.removedEmps\.includes\(item\.id\)\)/, '直属上级候选人不能受当月考核移除名单限制');
assert.match(server, /['"]廿一['"]:\s*\{\s*department:\s*['"]产品设计['"],\s*directMgr:\s*['"]Ben['"]\s*\}/, '新部署数据应默认保存廿一直属上级为 Ben');
assert.match(server, /function authoritativeWorkflowEmployee\(/, '服务端应以权威组织配置生成流程员工快照');
assert.match(server, /record\.emp = authoritativeWorkflowEmployee\(record\.empId, record\.emp\)/, '员工提交目标时应重新核对权威直属上级');
assert.match(server, /repairWorkflowEmployeeSnapshots\(kpiTargetDrafts/, '启动及配置更新时应修复历史流程中的旧上级快照');

console.log('manager directory regression tests passed');
