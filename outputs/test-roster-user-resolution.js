const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-roster-user-'));
const files = {
  'selfeval_data.json': {}, 'mgrscore_data.json': {}, 'bpscore_data.json': {},
  'kpi_confirm_data.json': {}, 'result_confirm_data.json': {},
  'pending_notifications.json': [], 'kpi_targets.json': {},
  'workflow_resets.json': {}, 'oa_approval_data.json': {},
  'admin_dingtalk_binding.json': {}, 'employee_overrides.json': {},
  'performance_exclusions.json': [], 'userid_cache.json': {},
  'roster.json': [{ nick: '廿一', realName: '孙伟强', userId: '462814292223125268', active: true }]
};
for (const [name, value] of Object.entries(files)) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
const server = require('./eval-server');
assert.strictEqual(server.findUserId('廿一'), '462814292223125268');
assert.strictEqual(server.findUserId('孙伟强'), '462814292223125268');
const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'userid_cache.json'), 'utf8'));
assert.strictEqual(cache['廿一'], '462814292223125268');
assert.strictEqual(cache['孙伟强'], '462814292223125268');
console.log('synchronized roster recipient resolution test passed');
