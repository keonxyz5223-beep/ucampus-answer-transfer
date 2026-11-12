const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const api = require('../ucampus-answer-transfer.user.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'ucampus-answer-transfer.user.js'), 'utf8');
const book3 = api.CONFIRMED_BOOKS[2], book2 = api.CONFIRMED_BOOKS[1];
const store = new Map([['ucampus-owned-books/v1', api.CONFIRMED_BOOKS]]);
let home = true, homeIdentity = { key: 'account-A' };
const box = {
  isShelfPage: () => home, accountOnHome: () => homeIdentity, accountIdentity: null,
  sharedRead: (key, fallback) => store.has(key) ? store.get(key) : fallback,
  sharedWrite: (key, value) => store.set(key, value), bookName: api.bookName, taskBook: api.taskBook,
  CONFIRMED_BOOKS: api.CONFIRMED_BOOKS, COURSE_TASKS: api.COURSE_TASKS
};
vm.createContext(box);
const begin = source.indexOf('  function shelfStorageKey('), end = source.indexOf('  function isShelfPage(', begin);
vm.runInContext(source.slice(begin, end) + '\nthis.api = { ownedBooks, shelfStorageKey, knownBookNames };', box);
assert.equal(box.api.ownedBooks().length, 0, 'legacy hardcoded books must not appear for a fresh account');
store.set('ucampus-owned-books/v2/account-A', [book2]);
assert.equal(box.api.ownedBooks().join('|'), book2);
assert.equal(box.api.ownedBooks().includes(book3), false, 'built-in answers do not imply account owns book');
homeIdentity = { key: 'account-B' };
assert.equal(box.api.ownedBooks().length, 0, 'another account does not inherit books');
home = false; box.accountIdentity = { key: 'account-A' };
assert.equal(box.api.ownedBooks().join('|'), book2, 'player reads bound account shelf');
box.accountIdentity = null;
assert.equal(box.api.ownedBooks().length, 0, 'unidentified player cannot borrow previous home account');
box.accountIdentity = { key: 'account-A' };
store.set('ucampus-owned-books/v2/account-A', [book2, book3]);
assert.ok(box.api.ownedBooks().includes(book3), 'book becomes visible once actually seen on home shelf');
const grouped = api.groupCourseTasks(api.COURSE_TASKS, new Set(), [book2], true);
assert.equal(grouped.length, 1);
assert.equal(grouped[0].name, book2);
assert.equal(grouped[0].total, 0, 'no answers may be shown for another book');
const real = api.groupCourseTasks(api.COURSE_TASKS, new Set(), [book3], true);
assert.equal(real[0].total, 96);
for (const unit of real[0].units) for (const entry of unit.entries) assert.equal(api.COURSE_TASKS[entry.index], entry.task, 'filtering must retain original task indexes');
console.log('PASS shelf: legacy hardcoded books hidden, per-account ownership, unknown player isolated, home detection enables built-in book, task indexes preserved');
