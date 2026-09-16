const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const outputDir = __dirname;
const expected = new Map([
  [0, 'D'], [70, 'D'], [70.01, 'C'], [80, 'C'],
  [80.01, 'B-'], [90, 'B-'], [90.01, 'B'], [100, 'B'],
  [100.01, 'B+'], [110, 'B+'], [110.01, 'A-'],
]);

function read(name) {
  return fs.readFileSync(path.join(outputDir, name), 'utf8');
}

function extractFunction(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert(match, `missing ${name}`);
  return match[0];
}

function checkServerRules() {
  const source = read('eval-server.js');
  const context = {};
  vm.runInNewContext(`${extractFunction(source, 'getGradeInfo')}; this.getGradeInfo = getGradeInfo;`, context);
  for (const [score, grade] of expected) {
    assert.strictEqual(context.getGradeInfo(score).grade, grade, `server grade for ${score}`);
  }
  for (const text of [
    "['A-', '优秀', 'X＞110 · 系数1.2'",
    "['B+', '优良', '100＜X≤110 · 系数1.1'",
    "['B', '良好', '90＜X≤100 · 系数1.0'",
    "['B-', '合格', '80＜X≤90 · 系数0.9'",
    "['C', '需改进', '70＜X≤80 · 系数0.7'",
    "['D', '不合格', 'X≤70 · 系数0'",
  ]) assert(source.includes(text), `mobile guide missing ${text}`);
}

function checkDashboard(name) {
  const source = read(name);
  const rulesMatch = source.match(/const GRADE_RULES = \[[\s\S]*?\n\s*\];/);
  const getGradeMatch = source.match(/const getGrade = \(score\) => \{[\s\S]*?\n\s*\};/);
  assert(rulesMatch && getGradeMatch, `${name} grade definitions missing`);
  const context = {};
  vm.runInNewContext(`${rulesMatch[0]}; ${getGradeMatch[0]}; this.getGrade = getGrade;`, context);
  for (const [score, grade] of expected) {
    assert.strictEqual(context.getGrade(score).grade, grade, `${name} grade for ${score}`);
  }
}

function checkTemplates() {
  const result = read('绩效结果确认书模板.html');
  for (const text of ['>A-</span></div><div>优秀</div>', 'X＞110', '100＜X≤110', 'X≤70']) {
    assert(result.includes(text), `result template missing ${text}`);
  }

  const bp = read('BP核准_桑葚.html');
  for (const text of [
    "if (total > 110) grade = 'A-'",
    "else if (total > 100) grade = 'B+'",
    "else if (total > 90) grade = 'B'",
    "else if (total > 80) grade = 'B-'",
    "else if (total > 70) grade = 'C'",
    '系统根据BP核准总分自动评级',
  ]) assert(bp.includes(text), `BP template missing ${text}`);

  const self = read('绩效自评_桑葚.html');
  const manager = read('上级评分_桑葚.html');
  assert(self.includes('等级：--（待核定）'), 'self template missing provisional grade');
  assert(manager.includes('等级：--（待核定）'), 'manager template missing provisional grade');
  assert(manager.includes('最终分数和等级以BP核准结果为准'), 'manager template missing BP authority hint');
}

checkServerRules();
checkDashboard('preview.html');
checkDashboard('绩效管理系统.html');
checkDashboard('绩效管理系统.jsx');
checkTemplates();
console.log(JSON.stringify({ ok: true, checkedBoundaries: [...expected.keys()] }));
