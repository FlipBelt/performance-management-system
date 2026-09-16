'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const outputs = __dirname;
const html = fs.readFileSync(path.join(outputs, 'preview.html'), 'utf8');
assert(html.includes('const MIN_ASSESSMENT_MONTH_ORDER = 2026 * 12 + 8'), '月份选项下限不是2026年9月');
assert(/function assessmentMonthOptions\(\)\s*{\s*const start = MIN_ASSESSMENT_MONTH_ORDER/.test(html), '月份筛选未使用统一下限');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-month-cleanup-'));
try {
  fs.writeFileSync(path.join(temp, 'kpi_targets.json'), JSON.stringify({
    'E1|2026年8月': { empId: 'E1', month: '2026年8月' },
    'E1|2026年9月': { empId: 'E1', month: '2026年9月' }
  }));
  fs.writeFileSync(path.join(temp, 'pending_notifications.json'), JSON.stringify([
    { month: '2026年7月', title: '旧通知' }, { month: '2026年9月', title: '新通知' }
  ]));
  const run = spawnSync(process.execPath, [path.join(outputs, 'clear-data-before-month.js'), '--data-dir', temp, '--cutoff', '2026年9月', '--apply'], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr || run.stdout);
  const targets = JSON.parse(fs.readFileSync(path.join(temp, 'kpi_targets.json'), 'utf8'));
  const notifications = JSON.parse(fs.readFileSync(path.join(temp, 'pending_notifications.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(targets), ['E1|2026年9月']);
  assert.strictEqual(notifications.length, 1);
  assert.strictEqual(notifications[0].month, '2026年9月');
  assert(fs.existsSync(path.join(temp, 'maintenance-backups')), '清理前未创建备份');
  console.log('month floor and cleanup checks passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
