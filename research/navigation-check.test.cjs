const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require('node:path').join(__dirname, '..', 'ucampus-answer-transfer.user.js'), 'utf8');
const section = script.split("const NAV_CHECK_KEY = 'ucampus-navigation-check/v1';")[1]?.split('  let accountIdentity = null;')[0];
assert.ok(section, 'navigation check helpers must exist');
const store = new Map();
const taskKey = (path, book) => book + '/' + path.join('/');
const env = {
  sharedRead: (key, fallback) => store.has(key) ? structuredClone(store.get(key)) : fallback,
  sharedWrite: (key, value) => store.set(key, structuredClone(value)),
  taskBook: task => task.book,
  taskKey,
  bookName: value => value,
  activeBook: () => 'Book A',
  paintTaskOptions: () => {}
};
vm.createContext(env);
vm.runInContext("const NAV_CHECK_KEY = 'ucampus-navigation-check/v1';" + section + `\nthis.api = { saveNavigationResult, finishBookNavigationCheck, navigationFailures, navigationBookRecord };`, env);
const first = { book: 'Book A', path: ['Unit 1', 'Exercise 1'] };
const second = { book: 'Book B', path: ['Unit 1', 'Exercise 1'] };
env.api.saveNavigationResult(first, new Error('目录未找到'));
assert.equal(env.api.navigationFailures('Book A')[taskKey(first.path, first.book)].reason, '目录未找到');
assert.deepEqual(Object.keys(env.api.navigationFailures('Book B')), []);
env.api.saveNavigationResult(second, new Error('另一书未找到'));
env.api.finishBookNavigationCheck('Book A');
assert.ok(env.api.navigationBookRecord('Book A').checkedAt);
assert.equal(env.api.navigationBookRecord('Book B').checkedAt, undefined);
env.api.saveNavigationResult(first, null);
assert.deepEqual(Object.keys(env.api.navigationFailures('Book A')), []);
assert.equal(env.api.navigationFailures('Book B')[taskKey(second.path, second.book)].reason, '另一书未找到');
const start = script.indexOf('function buildAutoPlan('), end = script.indexOf('  async function executeTimedPlan(', start);
assert.ok(start > 0 && end > start);
vm.runInContext(script.slice(start, end) + `\nthis.buildAutoPlan = buildAutoPlan;`, Object.assign(env, {
  isUnitToken: token => /^Unit \d+$/.test(token),
  unitNumberFrom: token => token.slice(5),
  COURSE_TASKS: [],
  taskBook: task => task.book
}));
const tasks = [first, { book: 'Book A', path: ['Unit 1', 'Exercise 2'] }, { book: 'Book A', path: ['Unit 1', 'Exercise 3'] }]
  .map(task => ({ ...task, answers: ['A'] }));
const excluded = new Set([taskKey(tasks[1].path, tasks[1].book)]);
const plan = env.buildAutoPlan(tasks, excluded, tasks[0], 'book', 2, true);
assert.equal(plan.length, 2);
assert.equal(plan.some(task => task.path.at(-1) === 'Exercise 2'), false);
const sharedStart = script.indexOf('function storedValue('), sharedEnd = script.indexOf('  function ownedBooks()', sharedStart);
assert.ok(sharedStart > 0 && sharedEnd > sharedStart);
const gm = new Map(), local = new Map();
const storageEnv = {
  GM_getValue: key => gm.get(key), GM_setValue: (key, value) => gm.set(key, structuredClone(value)),
  localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) },
  validateCourseImport: () => {}, bookName: value => value, taskKey
};
vm.createContext(storageEnv);
vm.runInContext(script.slice(sharedStart, sharedEnd) + `\nthis.api = { sharedRead, sharedWrite };`, storageEnv);
const scoped = 'ucampus-submitted-tasks/v2/account-A';
gm.set(scoped, []); local.set(scoped, JSON.stringify(['old-mark']));
assert.equal(storageEnv.api.sharedRead(scoped, []).length, 0, 'stale local mark must not resurrect after removal');
assert.equal(JSON.parse(local.get(scoped)).length, 0, 'stale local cache should be replaced');
console.log('共享跳转结果按书隔离、定时排除失败题、撤回标记不被旧缓存恢复：通过');
