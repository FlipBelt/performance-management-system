#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.DATA_DIR || '/var/lib/performance-system');
const apply = process.env.APPLY === 'true';
const July = '2026年7月';
const September = '2026年9月';
const retiredLegacyIds = new Set(['E021', 'E034', 'E039']);

function read(name, fallback) {
  const filename = path.join(dataDir, name);
  return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : fallback;
}

function write(name, value) {
  const filename = path.join(dataDir, name);
  const temp = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(temp, filename);
}

function normalizeDepartment(employee) {
  if (!employee || typeof employee !== 'object') return false;
  const department = String(employee.dept || employee.department || '').trim();
  let changed = false;
  if (department && employee.dept !== department) { employee.dept = department; changed = true; }
  if (Object.prototype.hasOwnProperty.call(employee, 'department')) { delete employee.department; changed = true; }
  return changed;
}

const roster = read('roster.json', []);
const assessmentRoster = read('assessment_roster.json', []);
const drafts = read('kpi_target_drafts.json', {});
const report = { normalizedRoster: 0, normalizedAssessmentRoster: 0, retiredLegacy: [], removedDrafts: [] };

for (const employee of roster) if (normalizeDepartment(employee)) report.normalizedRoster += 1;
for (const employee of assessmentRoster) {
  if (normalizeDepartment(employee)) report.normalizedAssessmentRoster += 1;
  if (!retiredLegacyIds.has(String(employee.id || ''))) continue;
  if (!employee.assessmentStartMonth) employee.assessmentStartMonth = '2026年6月';
  if (!employee.assessmentInactiveFromMonth) employee.assessmentInactiveFromMonth = September;
  report.retiredLegacy.push({ id: employee.id, name: employee.name, inactiveFrom: employee.assessmentInactiveFromMonth });
}

for (const [key, record] of Object.entries(drafts)) {
  const empId = String(record?.empId || key.split('|')[0] || '');
  const month = String(record?.month || key.split('|')[1] || '');
  if (empId === 'E004' && month === July) {
    delete drafts[key];
    report.removedDrafts.push(key);
  }
}

if (apply) {
  write('roster.json', roster);
  write('assessment_roster.json', assessmentRoster);
  write('kpi_target_drafts.json', drafts);
}

console.log(JSON.stringify({ apply, ...report }, null, 2));
