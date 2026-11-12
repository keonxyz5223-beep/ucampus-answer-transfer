const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const api = require('../ucampus-answer-transfer.user.js');
const { buildRepeatPlan, executeRepeatPlan, taskKey, buildAutoPlan } = api;
const tasks = [1, 2, 3].map(n => ({ book: 'Book A', path: ['Unit 1', 'Exercise ' + n], kind: 'choice', answers: ['A'] }));
tasks.push({ book: 'Book B', path: ['Unit 1', 'Exercise 1'], kind: 'choice', answers: ['B'] });
const plan = buildRepeatPlan(tasks, new Set(), tasks[1]);
assert.equal(plan.tasks.length, 3);
assert.equal(plan.startIndex, 1);
assert.equal(plan.tasks[0].path.at(-1), 'Exercise 1');
const excluded = new Set([taskKey(tasks[1].path, tasks[1].book)]);
const skippedPlan = buildRepeatPlan(tasks, excluded, tasks[1]);
assert.equal(skippedPlan.startIndex, 1);
assert.equal(skippedPlan.tasks[1].path.at(-1), 'Exercise 3');
assert.throws(() => buildRepeatPlan(tasks, new Set(tasks.slice(0, 3).map(task => taskKey(task.path, task.book))), tasks[0]), /没有可跳转/);
assert.equal(buildAutoPlan(tasks, excluded, tasks[0], 'book', 2).length, 2, 'normal mode retains exclusion behavior');
function clockDeps(overrides = {}) {
  let clock = 0;
  const submitted = [], jumped = [], filled = [], remembered = [];
  const deps = {
    targetCount: 6, endsAt: 60000, now: () => clock, stopped: () => false, report() {},
    jump: async task => jumped.push(task.path.at(-1)),
    fill: async task => filled.push(task.path.at(-1)),
    waitUntil: async deadline => { clock = deadline; }, verify: async () => {},
    submit: async task => submitted.push([task.path.at(-1), clock]), remember: task => remembered.push(task.path.at(-1)),
    ...overrides
  };
  return { deps, submitted, jumped, filled, remembered, setClock: value => clock = value };
}
(async () => {
  const cycle = clockDeps();
  assert.equal(await executeRepeatPlan(plan, 1, cycle.deps), 5);
  assert.deepEqual(cycle.submitted.map(item => item[0]), ['Exercise 2', 'Exercise 3', 'Exercise 1', 'Exercise 2', 'Exercise 3']);
  assert.ok(cycle.submitted.every(item => item[1] < 60000), 'no new submit at or after total zero');
  assert.equal(cycle.remembered.length, 5);
  // Early idle events can exceed the pace count while the total timer stays fixed.
  const early = clockDeps();
  let current = 0;
  early.deps.waitUntil = async deadline => { current = Math.min(deadline, current + 5000); early.setClock(current); return { early: true }; };
  assert.equal(await executeRepeatPlan(plan, 1, early.deps), 11);
  assert.ok(early.submitted.length > early.deps.targetCount, 'count is pacing, not cap');
  assert.equal(early.deps.now(), 60000);
  const jumpFailure = clockDeps();
  jumpFailure.deps.jump = async task => { jumpFailure.jumped.push(task.path.at(-1)); if (task.path.at(-1) === 'Exercise 2') throw Error('目录未找到'); };
  assert.equal(await executeRepeatPlan(plan, 1, jumpFailure.deps), 5);
  assert.equal(jumpFailure.jumped.filter(name => name === 'Exercise 2').length, 1, 'failed task is skipped on future laps');
  assert.deepEqual(jumpFailure.submitted.map(item => item[0]), ['Exercise 3', 'Exercise 1', 'Exercise 3', 'Exercise 1', 'Exercise 3']);
  const allFail = clockDeps();
  allFail.deps.jump = async task => { allFail.jumped.push(task.path.at(-1)); throw Error('目录未找到'); };
  assert.equal(await executeRepeatPlan(plan, 1, allFail.deps), 0);
  assert.equal(allFail.jumped.length, 3, 'all failures wait for cutoff without spinning');
  assert.equal(allFail.deps.now(), 60000);
  const lateVerify = clockDeps(); lateVerify.deps.verify = async () => lateVerify.setClock(60000);
  assert.equal(await executeRepeatPlan(plan, 1, lateVerify.deps), 0);
  assert.equal(lateVerify.submitted.length, 0);
  const fillFail = clockDeps(); fillFail.deps.fill = async () => { throw Error('填写失败'); };
  await assert.rejects(executeRepeatPlan(plan, 1, fillFail.deps), /填写失败/);
  assert.equal(fillFail.submitted.length, 0);
  const submitFail = clockDeps(); submitFail.deps.submit = async () => { throw Error('提交失败'); };
  await assert.rejects(executeRepeatPlan(plan, 1, submitFail.deps), /提交失败/);
  assert.equal(submitFail.remembered.length, 0);
  let cancelled = false;
  const protection = clockDeps({ stopped: () => cancelled });
  protection.deps.waitUntil = async () => { cancelled = true; };
  await assert.rejects(executeRepeatPlan(plan, 1, protection.deps), /已停止/);
  assert.equal(protection.submitted.length, 0);
  // Completed pages must expose one real redo control; no blind clicks.
  const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'ucampus-answer-transfer.user.js'), 'utf8');
  const begin = source.indexOf('  async function reopenRepeatTask('), end = source.indexOf('  async function clickSubmit(', begin);
  for (const n of [0, 1, 2]) {
    let summary = true, clicks = 0;
    const controls = Array.from({ length: n }, () => ({ click() { clicks++; summary = false; } }));
    const box = { assertAutoContext() {}, assertSubmissionAllowed() {}, pageDocuments: () => [{}], submissionComplete: () => summary,
      exactTextNodes: (doc, label) => label === '重新作答' ? controls : [], actionElement: element => element,
      actionDisabled: () => false, autoState: { cancelled: false, endsAt: 60000 }, Date: { now: () => 0 }, waitFor: async read => read() };
    vm.createContext(box); vm.runInContext(source.slice(begin, end) + '\nthis.reopen = reopenRepeatTask;', box);
    if (n === 1) { await box.reopen(tasks[0]); assert.equal(clicks, 1); }
    else { await assert.rejects(box.reopen(tasks[0]), error => error.code === 'REPEAT_UNAVAILABLE'); assert.equal(clicks, 0); }
  }
  console.log('PASS repeat: book order and wrap, completed items included, failures skipped, total cutoff, pacing count not cap, protection/fill/submit stop, exact redo controls');
})().catch(error => { console.error(error); process.exitCode = 1; });
