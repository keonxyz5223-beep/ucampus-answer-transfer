const assert = require('node:assert/strict');
const { executeTimedPlan, nextMenuJump, navigationPath, COURSE_TASKS } = require('../ucampus-answer-transfer.user.js');

function bodyLength(path) {
  return navigationPath(String(path[0] || '').replace(/\s+/g, '').startsWith('Unit') && /^Unit\d+/.test(String(path[0]).replace(/\s+/g, '')) ? path.slice(1) : path).length;
}

function planDeps(hooks = {}) {
  let now = 0;
  const submissions = [], skipped = [];
  const deps = {
    now: () => now,
    stopped: () => false,
    report() {},
    skipJumpFailures: true,
    jump: async () => {},
    fill: async () => {},
    waitUntil: async deadline => { now = deadline; },
    verify: async () => {},
    submit: async task => submissions.push({ path: task.path.join('/'), at: now }),
    remember() {},
    onSkip: (task, error) => skipped.push(task.path.join('/') + ' ' + error.message),
    ...hooks
  };
  return { get now() { return now; }, set now(value) { now = value; }, submissions, skipped, deps };
}

async function main() {
  const plan = Array.from({ length: 5 }, (_, i) => ({ path: ['Exercise ' + (i + 1)] }));
  const failed = planDeps({
    jump: async task => {
      if (task.path[0] === 'Exercise 3') {
        failed.now += 10000;
        throw new Error('跳转超过10秒，没有打开。');
      }
    }
  });
  assert.equal(await executeTimedPlan(plan, 5, failed.deps), 4);
  assert.deepEqual(failed.submissions.map(item => item.at), [60000, 120000, 215000, 300000]);
  assert.equal(failed.skipped.length, 1);

  const perturbed = planDeps({
    perturbationMs: () => 5000,
    waitUntil: async deadline => { perturbed.now = deadline; }
  });
  assert.equal(await executeTimedPlan(plan, 5, perturbed.deps), 5);
  assert.deepEqual(perturbed.submissions.map(item => item.at), [65000, 130000, 195000, 260000, 325000]);

  const cut = planDeps({
    perturbationMs: () => 10000,
    waitUntil: async (deadline, task, index) => {
      if (index === 0 && deadline > 60000) { cut.now = deadline - 4000; return { early: true }; }
      cut.now = deadline;
    }
  });
  const shifts = [];
  cut.deps.onScheduleShift = total => shifts.push(total);
  assert.equal(await executeTimedPlan(plan, 5, cut.deps), 5);
  assert.deepEqual(cut.submissions.map(item => item.at), [66000, 136000, 206000, 276000, 346000]);
  assert.deepEqual(shifts, [], 'unused perturbation is not returned to the pool');

  await assert.rejects(executeTimedPlan(plan, 0.5, planDeps().deps), /至少10秒/);

  let unreachable = 0;
  for (const task of COURSE_TASKS) {
    const menu = [];
    for (let length = 1; length <= task.path.length; length++) menu.push({ path: task.path.slice(0, length), clickable: true });
    const hit = nextMenuJump(menu, task.path, 0);
    if (!hit || hit.ambiguous || hit.covered.length !== bodyLength(task.path)) unreachable++;
  }
  assert.equal(unreachable, 0, 'every built-in task must match its own menu path');
  assert.equal(nextMenuJump([{ path: ['Unit 3', 'Taking in', 'Exercise 1'], clickable: true }], ['Unit 3', 'Further listening', 'Lecture 1'], 0), null);

  console.log('PASS timed plan: 10s skip reallocates, perturbation stays outside the budget, idle cuts one question only');
  console.log('PASS jump audit: ' + COURSE_TASKS.length + ' built-in tasks match their own paths');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
