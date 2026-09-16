const fs = require('fs');
const path = require('path');

for (const filename of ['preview.html', '绩效管理系统.html']) {
  const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
  const assertions = [
    [source.includes("evaluation.status === '已完成' && evaluation.bpScore != null"), '只统计已完成且有BP最终分的记录'],
    [source.includes('const lowScoreEmployees = finalizedEvals.filter'), '低分预警只使用最终完成记录'],
    [source.includes('const performanceStars = finalizedEvals.map'), '绩效之星只使用最终完成记录'],
    [source.includes('有效样本 ${finalizedEvals.length} 人'), '有效样本人数只使用最终完成记录'],
    [!source.includes('有效样本 ${confirmedEvals.length} 人'), '禁止将流程中记录计入有效样本'],
    [!source.includes('const lowScoreEmployees = confirmedEvals'), '禁止将空分误判为低分'],
  ];

  for (const [ok, message] of assertions) {
    if (!ok) throw new Error(`${filename}: ${message}`);
  }
}

console.log('dashboard finalized metrics regression tests passed');
