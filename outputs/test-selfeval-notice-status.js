'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const fileName of ['preview.html', '绩效管理系统.html']) {
  const dashboard = fs.readFileSync(path.join(__dirname, fileName), 'utf8');
  assert(dashboard.includes('function selfEvaluationNoticeWasSent(empId, month)'), fileName + ' must distinguish an unsent self-evaluation from an active one');
  assert(dashboard.includes('draft.selfEvaluationSentAt'), fileName + ' must use the authoritative self-evaluation send timestamp');
  assert(dashboard.includes('delivery.deliveredAt'), fileName + ' must accept a confirmed delivery record');
  assert(dashboard.includes('{ text: "待发送自评", cls: "badge-amber", order: 1 }'), fileName + ' must show the pending-send state');
  assert(dashboard.includes('{ text: "自评中", cls: "badge-amber", order: 1 }'), fileName + ' must retain the sent/in-progress state');
  assert(dashboard.includes('"待发送自评": 0, "自评中": 0'), fileName + ' must report both states independently');

  const scripts = [...dashboard.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(script => script.trim());
  assert(scripts.length > 0, fileName + ' must contain an inline application script');
  scripts.forEach(script => new Function(script));
}

console.log('self-evaluation notice status checks passed');
