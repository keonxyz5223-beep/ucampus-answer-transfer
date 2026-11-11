const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('F:/ds-bot/U校园/ucampus-answer-transfer.user.js', 'utf8');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(source, sandbox);
const { validateAnswers, fingerprint, suggestTasks, compactLabel, alignedMenuPath, answeredMenuFlags, nextMenuJump, taskKey } = sandbox.module.exports;
const snapshot = { pageKey: 'https://uai.unipus.cn/example', fingerprint: 'demo', questions: [
  { id: 'q001', kind: 'radio', options: [{ index: 0, text: 'A. Example' }, { index: 1, text: 'B. Another' }] },
  { id: 'q002', kind: 'checkbox', options: [{ index: 0, text: 'first' }, { index: 1, text: 'second' }] },
  { id: 'q003', kind: 'text', maxLength: 10 },
  { id: 'q004', kind: 'select', options: [{ index: 0, text: 'choose', disabled: true }, { index: 1, text: 'selected' }] },
  { id: 'q005', kind: 'radio', options: [{ index: 0, text: 'duplicate' }, { index: 1, text: 'duplicate' }] },
] };
const data = answers => ({ schema: 'ucampus-answers/v1', pageKey: snapshot.pageKey, fingerprint: 'demo', answers });
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }
check('match exact option text', () => assert.equal(validateAnswers(data([{ id: 'q001', value: 'Ａ.  Example' }]), snapshot)[0].indices[0], 0));
check('match multiple options', () => assert.equal(validateAnswers(data([{ id: 'q002', value: ['first', 'second'] }]), snapshot)[0].indices.length, 2));
check('preserve supplied text', () => assert.equal(validateAnswers(data([{ id: 'q003', value: ' Hello ' }]), snapshot)[0].value, ' Hello '));
check('select enabled option', () => assert.equal(validateAnswers(data([{ id: 'q004', value: 'selected' }]), snapshot)[0].indices[0], 1));
check('reject wrong page', () => assert.throws(() => validateAnswers({ ...data([{ id: 'q001', value: 'A. Example' }]), pageKey: '/other' }, snapshot), /不匹配/));
check('reject changed fingerprint', () => assert.throws(() => validateAnswers({ ...data([{ id: 'q001', value: 'A. Example' }]), fingerprint: 'other' }, snapshot), /不匹配/));
check('reject unknown option', () => assert.throws(() => validateAnswers(data([{ id: 'q001', value: 'C' }]), snapshot), /未唯一匹配/));
check('reject ambiguous option', () => assert.throws(() => validateAnswers(data([{ id: 'q005', value: 'duplicate' }]), snapshot), /未唯一匹配/));
check('reject duplicate question', () => assert.throws(() => validateAnswers(data([{ id: 'q003', value: 'a' }, { id: 'q003', value: 'b' }]), snapshot), /重复/));
check('reject empty text', () => assert.throws(() => validateAnswers(data([{ id: 'q003', value: '' }]), snapshot), /缺少/));
check('reject missing question', () => assert.throws(() => validateAnswers(data([{ id: 'absent', value: 'a' }]), snapshot), /找不到/));
check('reject multiple radio choices', () => assert.throws(() => validateAnswers(data([{ id: 'q001', value: ['A. Example', 'B. Another'] }]), snapshot), /只能选一个/));
check('reject duplicate choices', () => assert.throws(() => validateAnswers(data([{ id: 'q002', value: ['first', 'first'] }]), snapshot), /重复选项/));
check('reject disabled option', () => assert.throws(() => validateAnswers(data([{ id: 'q004', value: 'choose' }]), snapshot), /不可用/));
check('reject overlong text', () => assert.throws(() => validateAnswers(data([{ id: 'q003', value: '12345678901' }]), snapshot), /字数限制/));
check('fingerprint detects structure changes', () => assert.notEqual(fingerprint({ question: 'a' }), fingerprint({ question: 'b' })));
check('compact label ignores the space inside 提交', () => assert.equal(compactLabel('提 交'), '提交'));
check('suggest only the exercise whose whole path is active', () => {
  const tasks = [
    { path: ['Taking in', 'Listening to China', 'While you listen', 'Exercise 1'] },
    { path: ['Taking in', 'Listening to China', 'While you listen', 'Exercise 2'] },
  ];
  const hits = suggestTasks(tasks, ['Taking in', 'Listening to China', 'While you listen', 'Exercise 2']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path.at(-1), 'Exercise 2');
});
check('mark only the exercise leaf, not its folder', () => {
  const tasks = [
    { path: ['Taking in', 'Listening to China', 'While you listen', 'Exercise 1'], answers: ['1945'] },
    { path: ['Taking in', 'Listening to China', 'While you listen', 'Exercise 2'], answers: ['A'] },
  ];
  const flags = answeredMenuFlags([
    ['Unit 1'],
    ['Unit 1', 'Taking in'],
    ['Unit 1', 'Taking in', 'Listening to China'],
    ['Unit 1', 'Taking in', 'Listening to China', 'While you listen'],
    ['Unit 1', 'Taking in', 'Listening to China', 'While you listen', 'Exercise 1'],
    ['Unit 1', 'Taking in', 'Listening to China', 'While you listen', 'Exercise 2'],
    ['Unit 1', 'Taking in', 'Opening up'],
  ], tasks);
  assert.deepEqual(flags, [false, false, false, false, true, true, false]);
});
check('mark the deepest visible folder when the exercise is not listed', () => {
  const tasks = [{ path: ['Taking in', 'Viewing China', 'While you view', 'Exercise 1'], answers: ['B'] }];
  const flags = answeredMenuFlags([
    ['Taking in'],
    ['Taking in', 'Viewing China'],
    ['Taking in', 'Viewing China', 'While you view'],
  ], tasks);
  assert.deepEqual(flags, [false, false, true]);
});
check('aligned path ignores the unit title', () => {
  assert.equal(JSON.stringify(alignedMenuPath(['Unit 1', 'Taking in', 'Listening to China'], ['Taking in', 'Listening to China', 'While you listen', 'Exercise 1'])), JSON.stringify(['Takingin', 'ListeningtoChina']));
});
check('jump picks the deepest menu row on the same branch', () => {
  const entries = [
    { path: ['Unit 1', 'Taking in'], clickable: false },
    { path: ['Unit 1', 'Taking in', 'Listening to China'], clickable: true },
    { path: ['Unit 1', 'Taking in', 'Listening to China', 'While you listen'], clickable: true },
    { path: ['Unit 1', 'Taking in', 'Viewing China', 'Exercise 1'], clickable: true },
  ];
  const task = ['Taking in', 'Listening to China', 'While you listen', 'Exercise 1'];
  const hit = nextMenuJump(entries, task, 0);
  assert.equal(hit.index, 2);
  assert.equal(nextMenuJump(entries, task, hit.covered.length), null);
});
check('identical menu rows jump once', () => {
  const entries = [
    { path: ['Taking in', 'Listening to China'], clickable: true },
    { path: ['Taking in', 'Listening to China'], clickable: true },
  ];
  assert.equal(nextMenuJump(entries, ['Taking in', 'Listening to China', 'Exercise 1'], 0).index, 0);
});
check('submitted key ignores spaces', () => {
  assert.equal(taskKey(['While you listen', 'Exercise 1']), 'Whileyoulisten/Exercise1');
});
check('jump ignores a different branch', () => {
  const entries = [
    { path: ['Taking in', 'Listening to China'], clickable: true },
    { path: ['Speaking out', 'Group discussion'], clickable: true },
  ];
  const hit = nextMenuJump(entries, ['Taking in', 'Listening to China', 'Exercise 1'], 0);
  assert.equal(hit.index, 0);
  assert.equal(nextMenuJump(entries, ['Speaking out', 'Exercise 9'], 0), null);
});
console.log(`${passed} checks passed. Browser and live course validation pending.`);
