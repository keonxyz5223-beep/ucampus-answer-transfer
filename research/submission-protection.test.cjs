const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { isRateLimitNotice, createSubmitProtection, executeTimedPlan } = require('../ucampus-answer-transfer.user.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'ucampus-answer-transfer.user.js'), 'utf8');
const text = '您的操作过于频繁，请休息几分钟后再继续学习吧！';
assert.equal(isRateLimitNotice(text), true);
assert.equal(isRateLimitNotice('操作过于频繁，请休息几分钟后再继续学习吧!'), true);
for (const unrelated of ['提交成功', '网络不太好，请重试', '由于你长时间未操作，请点确定继续使用。', '这段使用说明包含' + text]) assert.equal(isRateLimitNotice(unrelated), false);
const state = createSubmitProtection();
assert.equal(state.active(0), false);
assert.equal(state.trigger(1000), 481000);
assert.equal(state.seconds(1001), 480);
assert.equal(state.active(481000), false);
assert.equal(state.trigger(400000), 880000);
assert.equal(state.seconds(400000), 480);
function browserMock() {
  let clock = 1000, notices = [], idleButtons = [], alerts = [], logs = [];
  const storage = new Map(), widgets = new Map(), listeners = new Map();
  const host = { id: 'ucampus-transfer-host' };
  const ui = id => {
    if (!widgets.has(id)) widgets.set(id, { hidden: true, checked: false, style: {}, offsetHeight: 160, textContent: '', addEventListener() {} });
    return widgets.get(id);
  };
  const doc = {
    documentElement: {},
    querySelectorAll: selector => selector.startsWith('button[id^=') ? idleButtons : notices,
    addEventListener: (type, handler) => listeners.set(type, [...listeners.get(type) || [], handler])
  };
  const box = {
    console, Date: { now: () => clock }, document: doc, host,
    window: { innerWidth: 1200, innerHeight: 800, alert: value => alerts.push(value) },
    autoState: { running: false, cancelled: false },
    compactLabel: value => String(value).replace(/\s+/g, ''), normalize: value => String(value).replace(/\s+/g, ' ').trim(),
    isRateLimitNotice, createSubmitProtection, visible: node => node.visible !== false,
    sharedRead: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    sharedWrite: (key, value) => storage.set(key, value), ui, pageDocuments: () => [doc],
    formatTimerDuration: seconds => String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0'),
    taskKey: (path, book) => book + '/' + path.join('/'),
    updateTimerMetrics() {}, status: value => logs.push(value), timerStatus: value => logs.push(value), appendActivityLog: value => logs.push(value),
    setTimeout: () => 1, setInterval: () => 2, getComputedStyle: () => ({ visibility: 'visible' })
  };
  vm.createContext(box);
  const start = source.indexOf("  const SUBMIT_PROTECTION_KEY ="), end = source.indexOf('  const ROUTE_KEY', start);
  vm.runInContext(source.slice(start, end) + '\nthis.api = { scanRateNotices, assertSubmissionAllowed, confirmIdleNotice, submissionClick, refreshProtectionWindow, beginSubmitProtection };', box);
  function notice() { return { visible: true, textContent: text, querySelectorAll: () => [], querySelector: () => null, closest: () => ({ getBoundingClientRect: () => ({ right: 700, left: 200, top: 140 }) }) }; }
  function click(id, nativeText) {
    const element = nativeText ? { textContent: nativeText, getAttribute() {}, closest() { return null; } } : { id };
    const event = { type: 'click', isTrusted: true, composedPath: () => nativeText ? [element] : [element, host], preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    box.api.submissionClick(event);
    return event;
  }
  return { box, ui, storage, alerts, logs, listeners, notice, click, setClock: value => clock = value, setNotices: value => notices = value, setIdle: value => idleButtons = value };
}
async function main() {
  const mock = browserMock();
  const warning = mock.notice();
  mock.setNotices([warning]);
  mock.box.autoState = { running: true, cancelled: false };
  mock.box.api.scanRateNotices();
  assert.equal(mock.box.autoState.cancelled, true);
  assert.equal(mock.box.autoState.stopReason, '提交单个题相隔时间过短，已触发保护');
  assert.equal(mock.storage.get('ucampus-submit-protection-until/v1'), 481000);
  mock.setClock(2000); mock.box.api.scanRateNotices();
  assert.equal(mock.storage.get('ucampus-submit-protection-until/v1'), 481000, 'same visible dialog must not restart every scan');
  for (const id of ['submit-top', 'submit-course', 'submit-only', 'auto-start']) assert.equal(mock.click(id).prevented, true, id);
  assert.equal(mock.click(null, '提交').prevented, true, 'native submit intercepted');
  const formEvent = { type: 'submit', isTrusted: true, composedPath: () => [], preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  mock.box.api.submissionClick(formEvent);
  assert.equal(formEvent.prevented, true, 'keyboard/form submit intercepted');
  assert.equal(mock.click('read-books').prevented, undefined, 'non-submit UI remains available');
  mock.setNotices([]); mock.box.api.scanRateNotices();
  mock.setClock(3000); mock.setNotices([warning]); mock.box.api.scanRateNotices();
  assert.equal(mock.storage.get('ucampus-submit-protection-until/v1'), 483000, 'same node reappearing restarts eight minutes');
  mock.setNotices([]); mock.setClock(483000); mock.box.api.scanRateNotices(); mock.box.api.refreshProtectionWindow();
  assert.equal(mock.ui('submit-protection').hidden, true);
  assert.equal(mock.click('submit-top').prevented, undefined);
  assert.equal(mock.box.autoState.cancelled, true, 'expiry must not resume stopped plan');
  // A new page restores the shared absolute deadline.
  const restored = browserMock(); restored.storage.set('ucampus-submit-protection-until/v1', 900000);
  assert.throws(() => restored.box.api.assertSubmissionAllowed(), /休息会再提交/);
  // Idle notice exact matching, one click per button, independent of manual-only checkbox during a timed task.
  const idle = browserMock(); let clicks = 0;
  const button = { id: 'mask_notice_id_1794486975168', disabled: false, textContent: '确定', parentElement: { textContent: '由于你长时间未操作，请点确定继续使用。确定' }, getClientRects: () => [{}], click: () => clicks++ };
  idle.setIdle([button]); idle.box.api.confirmIdleNotice(); assert.equal(clicks, 0);
  idle.box.autoState = { running: true, cancelled: false, phase: 'filling', currentTask: { book: 'Book', path: ['Exercise 3'] } };
  idle.box.api.confirmIdleNotice(); idle.box.api.confirmIdleNotice();
  assert.equal(clicks, 1);
  assert.equal(idle.box.autoState.idleSubmitTaskKey, 'Book/Exercise 3');
  const plan = Array.from({ length: 5 }, (_, i) => ({ path: ['Exercise ' + (i + 1)] }));
  let now = 0, saved = 0; const submissions = [], filled = [], verified = [];
  const deps = {
    now: () => now, stopped: () => false, report() {}, jump: async () => {},
    fill: async task => filled.push(task.path[0]),
    waitUntil: async (deadline, task, index) => { if (index === 2) { now = 150000; return { early: true }; } now = deadline; },
    onScheduleShift: total => saved = total,
    verify: async task => verified.push(task.path[0]),
    submit: async task => { assert.equal(filled.at(-1), task.path[0]); assert.equal(verified.at(-1), task.path[0]); submissions.push(now); },
    remember() {}
  };
  assert.equal(await executeTimedPlan(plan, 5, deps), 5);
  assert.deepEqual(submissions, [60000, 120000, 150000, 225000, 300000]);
  assert.equal(saved, 30000, '2:30 idle returns 30s to the remaining two questions');
  let submits = 0;
  assert.equal(await executeTimedPlan(plan, 5, { ...deps, now: () => 0, fill: async () => { throw Error('填写失败'); }, submit: async () => submits++ }), 0);
  assert.equal(submits, 0, 'a fill mismatch skips the question instead of stopping the timer');
  let cancelled = false;
  await assert.rejects(executeTimedPlan(plan, 5, { ...deps, now: () => 0, stopped: () => cancelled, waitUntil: async () => { cancelled = true; return { early: true }; }, submit: async () => submits++ }), /已停止/);
  assert.equal(submits, 0, 'cooldown cancellation wins over idle early-submit');
  // Production clickSubmit must re-check after loading and before confirmation/result marking.
  for (const trigger of ['before-click', 'after-click']) {
    let blocked = false, buttonClicks = 0;
    const context = {
      assertSubmissionAllowed() { if (blocked) throw Error('提交过于快了，休息会再提交'); },
      pageDocuments: () => [{}], submissionComplete: () => false,
      setTimeout: fn => { fn(); return 1; }, Date,
      actionDisabled: () => false,
      submitButtons: () => [{ scrollIntoView() {}, click() { buttonClicks++; if (trigger === 'after-click') blocked = true; } }],
      waitFor: async read => { const buttons = read(); if (trigger === 'before-click') blocked = true; return buttons; }
    };
    vm.createContext(context);
    const fnStart = source.indexOf('  async function clickSubmit('), fnEnd = source.indexOf('  const SUBMITTED_KEY', fnStart);
    vm.runInContext(source.slice(fnStart, fnEnd) + '\nthis.submit = clickSubmit;', context);
    await assert.rejects(context.submit(), /休息会再提交/);
    assert.equal(buttonClicks, trigger === 'before-click' ? 0 : 1);
  }
  console.log('PASS protection: exact notice, persisted 8-minute deadline, reset on reappearance, all submit entries blocked, no auto-resume');
  console.log('PASS idle: exact one-shot confirmation, fill+verify before submission, unused slot returned, no submit on failure/cancel');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
