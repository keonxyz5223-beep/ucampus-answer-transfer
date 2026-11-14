// ==UserScript==
// @name         U校园 · 我的答案搬运助手
// @namespace    local.ucampus.answer-transfer
// @version      0.4.17
// @description  按本人整理的答案填写当前练习，并点击页面上的提交节点。只填已给出的答案。
// @match        https://uai.unipus.cn/*
// @match        https://ucontent.unipus.cn/*
// @match        https://ucloud.unipus.cn/*
// @updateURL    https://dl.keon5223.xyz/api/install/__UCAMPUS_INSTALL_TOKEN__/update.meta.js
// @downloadURL  https://dl.keon5223.xyz/api/install/__UCAMPUS_INSTALL_TOKEN__/script.user.js
// @run-at       document-idle
// @sandbox      raw
// @connect      dl.keon5223.xyz
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// ==/UserScript==

(() => {
  'use strict';
  const SCRIPT_VERSION = '0.4.17';
  const RELEASE_METADATA_URL = 'https://dl.keon5223.xyz/api/version/ucampus';
  const DOWNLOAD_PORTAL_URL = 'https://dl.keon5223.xyz/download?software=ucampus';
  // 由官网下载服务为每次授权安装替换；公开仓库只含占位符，不含真实凭据。
  const INSTALLATION_TOKEN = '__UCAMPUS_INSTALL_TOKEN__';
  function installationDownloadUrl(token = INSTALLATION_TOKEN) {
    return typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token) && !token.startsWith('__')
      ? 'https://dl.keon5223.xyz/api/install/' + encodeURIComponent(token) + '/script.user.js' : DOWNLOAD_PORTAL_URL;
  }
  function parseReleaseMetadata(text) {
    let data;
    try { data = JSON.parse(String(text)); } catch { throw new Error('版本接口未返回有效JSON，请检查下载站状态。'); }
    if (data?.schema !== 'ucampus-release/v1' || typeof data.version !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(data.version)) {
      throw new Error('版本资料格式不正确，不能据此判断是否需要更新。');
    }
    return data;
  }
  const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  function fingerprint(value) {
    let hash = 2166136261;
    for (const char of JSON.stringify(value)) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
  function validateAnswers(data, snapshot) {
    if (data?.schema !== 'ucampus-answers/v1') throw new Error('答案文件格式不正确。');
    if (data.pageKey !== snapshot.pageKey || data.fingerprint !== snapshot.fingerprint) {
      throw new Error('答案与当前页面不匹配，请重新采集对应练习。');
    }
    if (!Array.isArray(data.answers) || !data.answers.length) throw new Error('答案列表为空。');
    const seen = new Set();
    return data.answers.map(answer => {
      if (seen.has(answer.id)) throw new Error(`题目 ${answer.id} 重复。`);
      seen.add(answer.id);
      const question = snapshot.questions.find(item => item.id === answer.id);
      if (!question) throw new Error(`找不到题目 ${answer.id}。`);
      if (question.kind === 'text') {
        if (typeof answer.value !== 'string' || !answer.value.trim()) throw new Error(`${answer.id} 缺少文字答案。`);
        if (question.maxLength > 0 && answer.value.length > question.maxLength) throw new Error(`${answer.id} 超出输入框字数限制。`);
        return { question, value: answer.value };
      }
      if (!['radio', 'checkbox', 'select'].includes(question.kind)) throw new Error('暂不支持此类控件。');
      const values = Array.isArray(answer.value) ? answer.value : [answer.value];
      if (!values.length || values.some(item => typeof item !== 'string' || !normalize(item))) throw new Error(`${answer.id} 缺少选项文字。`);
      if (question.kind !== 'checkbox' && values.length !== 1) throw new Error(`${answer.id} 只能选一个答案。`);
      const indices = values.map(value => {
        const matches = question.options.filter(option => normalize(option.text) === normalize(value));
        if (matches.length !== 1) throw new Error(`${answer.id} 的选项“${value}”未唯一匹配。`);
        if (matches[0].disabled) throw new Error(`${answer.id} 的目标选项不可用。`);
        return matches[0].index;
      });
      if (new Set(indices).size !== indices.length) throw new Error(`${answer.id} 包含重复选项。`);
      return { question, indices };
    });
  }
  const compactLabel = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '');
  function routeLabel(value) {
    return compactLabel(value).replace(/^Lectures(?=\d+$)/, 'Lecture').replace(/^UnitTest$/i, 'Unittest');
  }
  const DEFAULT_BOOK = '新视野大学英语（第四版）视听说教程3';
  const CONFIRMED_BOOKS = ['新视野大学英语（第四版）视听说教程1', '新视野大学英语（第四版）视听说教程2', DEFAULT_BOOK, '新四级强化辅导 翻译（新版）'];
  function bookName(value) {
    const text = normalize(value), compact = compactLabel(text);
    return CONFIRMED_BOOKS.find(name => compactLabel(name) === compact) || text || DEFAULT_BOOK;
  }
  function taskBook(task) { return bookName(task?.book || DEFAULT_BOOK); }
  function accountRecord(schoolValue, studentValue, details = {}) {
    const school = normalize(schoolValue), student = normalize(studentValue);
    if (school.length < 2 || school.length > 100 || !/^[A-Za-z0-9_-]{4,40}$/.test(student)) return null;
    return {
      key: encodeURIComponent(compactLabel(school)) + '/' + encodeURIComponent(student),
      school, student, label: school + ' · 学号 ' + student,
      appUserId: String(details.appUserId || ''), schId: String(details.schId || '')
    };
  }
  function accountFromHomeFields(school, roleText, state = {}) {
    const text = normalize(String(roleText || '').replace(/["“”']/g, ''));
    const match = /学号\s*[:：]?\s*([A-Za-z0-9_-]{4,40})(?![A-Za-z0-9_-])/.exec(text);
    if (!match || state.code && normalize(state.code) !== match[1]) return null;
    return accountRecord(school, match[1], { appUserId: state.userId, schId: state.schId });
  }
  function accountFromHomeState(state) {
    return state?.userId ? accountRecord(state.schName, state.code, { appUserId: state.userId, schId: state.schId }) : null;
  }
  function accountFromPlayer(payload, portal, binding = null) {
    const candidates = [payload?.value?.userInfo, payload?.data?.userInfo, payload?.rt?.userInfo, payload?.value?.user,
      payload?.data?.user, payload?.rt?.user, payload?.value, payload?.data, payload?.rt, payload?.user, payload];
    const user = candidates.find(item => item && typeof item === 'object' &&
      (item.appUserId || item.user_id || item.userId || item.open_id || item.openId || item.studentId || item.studentNo || item.user_num || item.id));
    if (!user) return null;
    const rawStudent = user.studentId ?? user.studentNo ?? user.user_num ?? user.student_code ?? user.code;
    const student = /^[A-Za-z0-9_-]{4,40}$/.test(String(rawStudent || '')) ? String(rawStudent) : '';
    const userId = user.appUserId ?? user.user_id ?? user.userId ?? user.open_id ?? user.openId ?? user.id;
    const schId = user.schId ?? user.school ?? user.user_school_id;
    const school = user.schName || user.schoolName || user.school_name || (typeof user.school === 'string' && !/^\d+$/.test(user.school) ? user.school : '');
    if (binding && userId && String(userId) === String(binding.appUserId) &&
        String(schId || '') === String(binding.schId || '') &&
        (!student || student === binding.student) && (!school || compactLabel(school) === compactLabel(binding.school))) {
      const linked = accountRecord(binding.school, binding.student, { appUserId: userId, schId });
      if (linked) return linked;
    }
    if (portal?.appUserId && userId && String(userId) === portal.appUserId &&
        (!portal.schId || !schId || String(schId) === portal.schId) && (!student || student === portal.student)) return portal;
    if (portal?.appUserId && userId && portal.student === normalize(student) && portal.appUserId !== String(userId) && /^[A-Za-z0-9_-]{1,80}$/.test(String(userId))) {
      const resolvedSchool = school || (portal.schId && String(schId) === portal.schId ? portal.school : '学校待确认');
      return { key: 'site-id/' + encodeURIComponent(String(schId || '')) + '/' + encodeURIComponent(String(userId)),
        school: resolvedSchool, student: String(student), label: resolvedSchool + ' · 学号 ' + String(student), appUserId: String(userId), schId: String(schId || '') };
    }
    const direct = accountRecord(school, student, { appUserId: userId, schId });
    if (direct) return direct;
    const sameSchool = !!(portal?.schId && schId && String(schId) === portal.schId);
    const sameUser = !!(portal?.appUserId && userId && String(userId) === portal.appUserId);
    if (sameSchool || sameUser && !portal?.schId) {
      const resolved = accountRecord(portal.school, student, { appUserId: userId, schId });
      if (resolved) return resolved; // 同校另一学号也分配自己的记录区。
    }
    const unknownSchool = schId ? '学校编号 ' + String(schId) : '';
    const separate = accountRecord(unknownSchool, student, { appUserId: userId, schId });
    if (separate && (schId || userId)) return separate;
    if (userId && /^[A-Za-z0-9_-]{1,80}$/.test(String(userId))) return {
      key: 'site-id/' + encodeURIComponent(String(schId || '')) + '/' + encodeURIComponent(String(userId)), school: unknownSchool || '学校待确认', student: '',
      label: (unknownSchool || '学校待确认') + ' · 账号编号 ' + String(userId), appUserId: String(userId), schId: String(schId || '')
    };
    return null;
  }
  function storedValue(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return undefined; }
  }
  function usableStoredValue(key, value) {
    if (key === 'ucampus-submitted-tasks' || key.startsWith('ucampus-submitted-tasks/v2/')) return Array.isArray(value) && value.every(item => typeof item === 'string');
    if (key === 'ucampus-imported-course-tasks/v1') {
      if (value?.schema !== 'ucampus-course-answers/v1' || !Array.isArray(value.tasks)) return false;
      try { if (value.tasks.length) validateCourseImport(value); return true; } catch { return false; }
    }
    return value !== undefined && value !== null;
  }
  function sharedRead(key, fallback) {
    let value, local;
    try { if (typeof GM_getValue === 'function') value = storedValue(GM_getValue(key)); } catch {}
    try { local = storedValue(localStorage.getItem(key)); } catch {}
    const hasShared = usableStoredValue(key, value), hasLocal = usableStoredValue(key, local);
    if (!hasShared && !hasLocal) return fallback;
    let merged = hasShared ? value : local;
    if (hasShared && hasLocal && key === 'ucampus-submitted-tasks') merged = [...new Set([...value, ...local])];
    // 分账号记录以扩展存储为准；否则其他域名旧缓存会把已撤回的标记重新合并进来。
    if (hasShared && hasLocal && key === 'ucampus-imported-course-tasks/v1') {
      // 根course也属于教材身份，不能在合并跨书答案时丢掉。
      const tasks = new Map();
      for (const data of [local, value]) for (const task of data.tasks) {
        const item = { ...task, book: bookName(task.book || data.course || DEFAULT_BOOK) };
        tasks.set(taskKey(item.path?.[0] === 'Unit 1' ? item.path.slice(1) : item.path, item.book), item);
      }
      merged = { schema: 'ucampus-course-answers/v1', tasks: [...tasks.values()] };
    }
    // 不只写扩展存储；让当前域名也留一份，后续页面可继续恢复。
    if (JSON.stringify(merged) !== JSON.stringify(value)) { try { if (typeof GM_setValue === 'function') GM_setValue(key, merged); } catch {} }
    if (JSON.stringify(merged) !== JSON.stringify(local)) { try { localStorage.setItem(key, JSON.stringify(merged)); } catch {} }
    return merged;
  }
  function sharedWrite(key, value) {
    let saved = false;
    try { if (typeof GM_setValue === 'function') { GM_setValue(key, value); saved = true; } } catch {}
    try { localStorage.setItem(key, JSON.stringify(value)); saved = true; } catch {}
    if (!saved) throw new Error('浏览器没有保存书架数据，请检查脚本存储权限。');
  }
  function shelfStorageKey() {
    const identity = isShelfPage() ? accountOnHome() : accountIdentity;
    return identity?.key ? 'ucampus-owned-books/v2/' + identity.key : '';
  }
  function ownedBooks() {
    const key = shelfStorageKey(), saved = key ? sharedRead(key, []) : [];
    return [...new Set((Array.isArray(saved) ? saved : []).filter(name => typeof name === 'string' && name.length >= 2 && name.length < 150).map(bookName))];
  }
  function knownBookNames() {
    return [...new Set([...CONFIRMED_BOOKS, ...ownedBooks(), ...COURSE_TASKS.map(taskBook)])];
  }
  function isShelfPage() {
    return !!(typeof window !== 'undefined' && window.location &&
      ['uai.unipus.cn', 'ucloud.unipus.cn'].includes(window.location.hostname) && /^\/portal\/?$/.test(window.location.pathname));
  }
  function booksInText(value, names = knownBookNames()) {
    const text = compactLabel(value);
    return names.filter(name => text.includes(compactLabel(name)));
  }
  function shelfBooksFromPage() {
    if (!isShelfPage()) return [];
    const nodes = [...document.querySelectorAll('a, [title], h2, h3, h4, p, span, div')];
    const names = [], knownBooks = knownBookNames();
    for (const element of nodes) {
      const text = normalize(element.getAttribute('title') || element.textContent || '');
      if (!text || text.length > 180) continue;
      const known = booksInText(text, knownBooks);
      if ((!known.length && !element.matches?.('.course-name, .course-title, .book-name, [class*="courseName"]')) || element.closest('#ucampus-transfer-host') || !visible(element)) continue;
      if (known.length === 1) names.push(known[0]);
      else if (element.matches?.('.course-name, .course-title, .book-name, [class*="courseName"]') && text.length >= 5 && text.length < 120) names.push(bookName(text));
    }
    return [...new Set(names)];
  }
  function readShelf(quiet = false) {
    const found = shelfBooksFromPage();
    if (!found.length) {
      if (!quiet) throw new Error(isShelfPage()
        ? '已在U校园首页，但暂未读到教材名称。请等“我的教程”卡片加载出来，再读取书架。'
        : '请先进入U校园首页“我的教程”，再点“读取首页书架”。');
      return [];
    }
    const key = shelfStorageKey();
    if (!key) { if (!quiet) throw new Error('首页账号还没识别，暂不保存书架。请等个人资料加载后重试。'); return []; }
    const merged = [...new Set([...ownedBooks(), ...found])];
    const previous = sharedRead(key, []);
    if (JSON.stringify(previous) !== JSON.stringify(merged)) sharedWrite(key, merged);
    if (!quiet) { paintTaskOptions(); status('已从首页读取 ' + found.length + ' 本教材；未收录答案的显示（0/0）。'); }
    return found;
  }
  function activeBook() {
    if (!isShelfPage()) {
      const names = knownBookNames(), found = new Set();
      const nodes = document.querySelectorAll('title, [title], h1, h2, .course-name, .course-title, span');
      for (const element of nodes) {
        const text = normalize(element.getAttribute('title') || element.textContent || '');
        if (!text || text.length >= 150) continue;
        const hits = booksInText(text, names);
        // 只对可能是教材标题的少数节点检查布局，避免逐个span强制读布局。
        if (!hits.length || element.closest('#ucampus-transfer-host') || !visible(element)) continue;
        hits.forEach(name => found.add(name));
      }
      if (found.size === 1) return [...found][0];
    }
    return bookName(sharedRead('ucampus-active-book/v1', DEFAULT_BOOK));
  }
  function buildAutoPlan(tasks, done, selected, scope, count, includeReserve = false) {
    if (!selected) throw new Error('先选择开始的练习。');
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('题数请输入1至500的整数。');
    const start = tasks.indexOf(selected), unit = isUnitToken(selected.path[0]) ? unitNumberFrom(selected.path[0]) : '1';
    const candidates = tasks.slice(Math.max(0, start)).filter(task => taskBook(task) === taskBook(selected) && !done.has(taskKey(task.path, task.book)) && (scope === 'book' || (isUnitToken(task.path[0]) ? unitNumberFrom(task.path[0]) : '1') === unit));
    if (candidates.length < count) throw new Error('从所选题往后仅有 ' + candidates.length + ' 道未提交且有答案的练习，不够计划的 ' + count + ' 道。');
    return (includeReserve ? candidates : candidates.slice(0, count)).map(task => ({ ...task, path: task.path.slice(), answers: task.answers.slice() }));
  }
  function buildRepeatPlan(tasks, excluded, selected) {
    if (!selected) throw new Error('先选择开始的练习。');
    const start = tasks.indexOf(selected);
    if (start < 0) throw new Error('所选练习不在当前答案库中。');
    const candidates = tasks.map((task, index) => ({ task, index }))
      .filter(({ task }) => taskBook(task) === taskBook(selected) && !excluded.has(taskKey(task.path, task.book)));
    if (!candidates.length) throw new Error('这本书没有可跳转且有答案的练习，不能启动重复答题。');
    const first = candidates.findIndex(({ index }) => index >= start);
    return { tasks: candidates.map(({ task }) => ({ ...task, path: task.path.slice(), answers: task.answers.slice() })), startIndex: first < 0 ? 0 : first };
  }
  function isTimedSessionAbort(error) {
    const message = String(error?.message || error);
    return /定时任务已停止|账号身份已变化|与任务教材不同|离开计划中的练习|提交过于快了|休息会再提交|标记未能保存/.test(message);
  }
  function skipTimedQuestion(error) {
    if (!error || typeof error !== 'object') error = new Error(String(error));
    if (!error.code) error.code = 'QUESTION_SKIP';
    return error;
  }
  function isUnreadPage(error) {
    const message = String(error?.message || error);
    return /页面有 \d+ 个空|页面有 \d+ 组选项|当前页没有找到选项|没有唯一对上或不可编辑/.test(message);
  }
  async function fillWhenPageReady(deps) {
    const started = deps.now();
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const due = started + attempt * 1000;
      while (deps.now() < due) {
        if (deps.stopped()) throw new Error('定时任务已停止。');
        await deps.sleep(Math.max(1, Math.min(200, due - deps.now())));
      }
      if (deps.stopped()) throw new Error('定时任务已停止。');
      deps.onAttempt?.(attempt);
      try { return await deps.fill(); }
      catch (error) {
        if (deps.stopped()) throw new Error('定时任务已停止。');
        if (isTimedSessionAbort(error) || !isUnreadPage(error)) throw error;
        lastError = error;
      }
    }
    throw skipTimedQuestion(lastError || new Error('三次都没有读到题目。'));
  }
  async function executeRepeatPlan(plan, minutes, deps) {
    const count = deps.targetCount;
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440 || !Number.isInteger(count) || count < 1 || count > 500) throw new Error('请设置有效的总分钟数和1至500的节奏题数。');
    const slot = minutes * 60000 / count;
    let end = deps.endsAt ?? deps.now() + minutes * 60000;
    if (slot < 1000 || !plan.tasks?.length) throw new Error('重复答题需要可用练习，平均每道至少1秒。');
    const failed = new Set();
    let cursor = plan.startIndex, completed = 0;
    const check = () => { if (deps.stopped()) throw new Error('定时任务已停止。'); };
    try {
      while (deps.now() < end) {
        check();
        const task = plan.tasks[cursor]; cursor = (cursor + 1) % plan.tasks.length;
        const key = taskKey(task.path, task.book);
        if (failed.has(key)) {
          if (failed.size === plan.tasks.length) {
            deps.onPhase?.('waiting');
            deps.report('这本书已无可跳转的练习，等待总倒计时归零；不会重复尝试失败题。');
            await deps.waitUntil(end, null, completed, count); check();
          }
          continue;
        }
        const deadline = Math.min(deps.now() + slot, end);
        deps.onTask?.(task, completed, count, deadline);
        deps.onPhase?.('jumping');
        deps.report('重复答题：正在打开第 ' + (completed + 1) + ' 次练习：' + task.path.join(' / '));
        try { await deps.jump(task); check(); }
        catch (error) {
          check(); if (deps.now() >= end) break;
          failed.add(key); deps.onSkip?.(task, error, failed.size);
          continue;
        }
        if (deps.now() >= end) break;
        let perturbMs = 0;
        if (deps.perturbationMs) {
          const rolled = Number(deps.perturbationMs(task));
          if (Number.isFinite(rolled) && rolled > 0) perturbMs = rolled;
          deps.onPerturb?.(perturbMs);
        }
        try {
          deps.onPhase?.('filling'); await deps.fill(task); check();
          if (deps.now() >= end) break;
          deps.onPhase?.('waiting');
          const waited = await deps.waitUntil(deadline, task, completed, count); check();
          if (deps.now() >= end) break;
          if (waited?.early !== true && perturbMs > 0) {
            const perturbDeadline = deps.now() + perturbMs;
            deps.onPhase?.('perturbing');
            deps.onTask?.(task, completed, count, perturbDeadline);
            deps.onRepeatHold?.(Math.max(0, end - deps.now()));
            end += perturbMs;
            deps.onRepeatCredit?.(perturbMs);
            const perturb = await deps.waitUntil(perturbDeadline, task, completed, count); check();
            const unused = Math.max(0, perturbDeadline - deps.now());
            if (unused) { end -= unused; deps.onRepeatCredit?.(-unused); }
            if (perturb?.early === true) deps.report?.('长时间未操作，已结束这一题的随机扰动。');
            if (deps.now() >= end) break;
          }
          deps.onPhase?.('checking'); await deps.verify(task); check();
          if (deps.now() >= end) break;
          deps.onPhase?.('submitting'); await deps.submit(task); check();
          deps.remember(task); completed++; deps.onProgress?.(completed);
          deps.report('重复答题已确认提交 ' + completed + ' 次；继续按本书顺序循环，直至总时间结束。');
        } catch (error) {
          if (deps.stopped()) throw new Error('定时任务已停止。');
          if (deps.now() >= end) break;
          if (isTimedSessionAbort(error)) throw error;
          failed.add(key); deps.onSkip?.(task, skipTimedQuestion(error), failed.size);
          continue;
        }
      }
    } catch (error) {
      check();
      if (deps.now() < end) throw error;
      // 截止时终止尚未完成的操作；未确认成功的请求不标绿。
    }
    check(); return completed;
  }
  function isRateLimitNotice(text) {
    return /^您?的?操作过于频繁[，,]?请休息几分钟后再继续学习吧[！!。.]?$/.test(compactLabel(text));
  }
  function createSubmitProtection(until = 0) {
    return {
      until: Number.isFinite(until) ? until : 0,
      trigger(now) { this.until = now + 8 * 60 * 1000; return this.until; },
      active(now) { return this.until > now; },
      seconds(now) { return Math.max(0, Math.ceil((this.until - now) / 1000)); }
    };
  }
  async function executeTimedPlan(plan, minutes, deps) {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new Error('总分钟数应大于0且不超过1440。');
    const target = deps.targetCount ?? plan.length;
    if (!Number.isInteger(target) || target < 1 || target > plan.length) throw new Error('可用练习不足计划题数。');
    const totalMs = minutes * 60000;
    if (totalMs / target < 10000) throw new Error('平均每道至少10秒。');
    let budgetMs = totalMs, completed = 0, skipped = 0, shortened = 0;
    const queue = plan.slice(0, target);
    const check = () => { if (deps.stopped()) throw new Error('定时任务已停止。'); };
    while (queue.length && completed < target) {
      check();
      let dropped = 0;
      while (queue.length && budgetMs / queue.length < 10000) { queue.pop(); dropped++; }
      if (dropped) deps.report?.('剩余时间不足10秒，未开始后面 ' + dropped + ' 道。');
      if (!queue.length) break;
      const slot = budgetMs / queue.length;
      const task = queue.shift();
      const started = deps.now();
      const deadline = started + slot;
      deps.onTask?.(task, completed, target, deadline);
      deps.onPhase?.('jumping');
      deps.report?.('正在打开第 ' + (completed + 1) + '/' + target + ' 道，已跳过 ' + skipped + ' 道：' + task.path.join(' / '));
      try { await deps.jump(task); check(); }
      catch (error) {
        check();
        if (!deps.skipJumpFailures) throw error;
        skipped++;
        budgetMs -= Math.min(10000, Math.max(0, deps.now() - started));
        deps.onSkip?.(task, error, skipped);
        deps.report?.('已跳过跳转失败的练习：' + task.path.join(' / ') + '；剩余时间重新平分。');
        continue;
      }
      let perturbMs = 0;
      if (deps.perturbationMs) {
        const rolled = Number(deps.perturbationMs(task));
        if (Number.isFinite(rolled) && rolled > 0) perturbMs = rolled;
        deps.onPerturb?.(perturbMs);
      }
      let charged = false;
      try {
        deps.onPhase?.('filling');
        await deps.fill(task); check();
        if (deps.now() > deadline) throw new Error('第 ' + (completed + 1) + ' 道加载或填写超过分配时间，跳过这一题，没有赶时间连交。');
        deps.onPhase?.('waiting');
        const waited = await deps.waitUntil(deadline, task, completed, target); check();
        if (waited?.early === true) {
          const saved = Math.max(0, deadline - deps.now());
          budgetMs -= Math.max(0, slot - saved);
          shortened += saved;
          charged = true;
          deps.onScheduleShift?.(shortened, saved);
        } else {
          budgetMs -= slot;
          charged = true;
          if (perturbMs > 0) {
            const perturbDeadline = deps.now() + perturbMs;
            deps.onPhase?.('perturbing');
            deps.onTask?.(task, completed, target, perturbDeadline);
            const perturb = await deps.waitUntil(perturbDeadline, task, completed, target); check();
            if (perturb?.early === true) deps.report?.('长时间未操作，已结束这一题的随机扰动。');
          }
        }
        deps.onPhase?.('checking');
        await deps.verify(task); check();
        deps.onPhase?.('submitting');
        await deps.submit(task);
        deps.remember(task); completed++;
        deps.onProgress?.(completed);
        deps.report?.('已提交 ' + completed + '/' + target + ' 道，已跳过 ' + skipped + ' 道。');
      } catch (error) {
        if (deps.stopped()) throw new Error('定时任务已停止。');
        if (isTimedSessionAbort(error)) throw error;
        skipped++;
        if (!charged) budgetMs -= Math.min(slot, Math.max(0, deps.now() - started));
        deps.onSkip?.(task, skipTimedQuestion(error), skipped);
        deps.report?.('已跳过未能填写或提交的练习：' + task.path.join(' / ') + '；定时继续。');
        continue;
      }
    }
    check();
    return completed;
  }
  function isUnitToken(value) {
    return /^Unit\d+$/.test(compactLabel(value));
  }
  function unitNumberFrom(value) {
    const match = /^Unit(\d+)/.exec(compactLabel(value));
    return match ? match[1] : '';
  }
  function taskBodyPath(taskPath) {
    const path = taskPath || [];
    return isUnitToken(path[0]) ? path.slice(1) : path.slice();
  }
  function unitCompatible(menuPath, taskPath) {
    const taskUnit = isUnitToken((taskPath || [])[0]) ? unitNumberFrom(taskPath[0]) : '';
    const menuUnit = unitNumberFrom((menuPath || [])[0] || '');
    if (taskUnit) return !menuUnit || menuUnit === taskUnit;
    if (menuUnit && menuUnit !== '1') return false;
    return true;
  }
  const COURSE_TASKS = [
    { path: ['Taking in', 'Listening to China', 'While you listen', 'Exercise 1'], kind: 'fill', answers: ['1945', 'his academic career', '1958', 'his lifelong passion', '1988', 'diving limits', 'anniversary celebration', 'rejecting the chair', 'determination'] },
    { path: ['Taking in', 'Listening to China', 'While you listen', 'Exercise 2'], kind: 'choice', answers: ['A', 'B', 'A', 'B', 'A'] },
    { path: ['Taking in', 'Viewing China', 'While you view', 'Exercise 1'], kind: 'choice', answers: ['B', 'B', 'A'] },
    { path: ['Taking in', 'Viewing China', 'While you view', 'Exercise 2'], kind: 'fill', answers: ['barren land', 'generations of workers', 'freezing and long', '20 billion'] },
    { path: ['Taking in', 'Viewing world cultures', 'While you view', 'Exercise 1'], kind: 'choice', answers: ['E', 'H', 'C', 'B', 'F', 'A', 'D', 'G'] },
    { path: ['Taking in', 'Viewing world cultures', 'While you view', 'Exercise 2'], kind: 'fill', answers: ['90 minutes', 'worried', 'on the waves', '10 times', 'dig in', 'focus', 'make this challenge', 'seven miles', 'four months', 'outstanding achievement'] },
    { path: ['Taking in', 'Watching street interviews', 'Exercise 2'], kind: 'fill', answers: ['cup of tea', 'feel good', 'trying new things'] },
    { path: ['Taking in', 'Watching street interviews', 'Exercise 3'], kind: 'choice', answers: ['E', 'D', 'A', 'B', 'C'] },
    { path: ['Taking in', 'Watching street interviews', 'Exercise 4'], kind: 'choice', answers: ['B', 'A', 'C', 'C', 'C'] },
    { path: ['Speaking out', 'Group discussion', 'Get ideas', 'Exercise 2'], kind: 'choice', answers: ['A', 'B', 'C', 'F', 'G', 'I', 'J', 'K'] },
    { path: ['Further listening', 'Conversation'], kind: 'choice', answers: ['B', 'C', 'A', 'A'] },
    { path: ['Further listening', 'Passage'], kind: 'choice', answers: ['A', 'A', 'B'] },
    { path: ['Further listening', 'Lecture 1'], kind: 'choice', answers: ['D', 'C', 'A'] },
    { path: ['Further listening', 'Lecture 2'], kind: 'choice', answers: ['B', 'D', 'A', 'A'] },
    { path: ['Unit test', 'Conversation'], kind: 'choice', answers: ['B', 'C', 'C', 'D'] },
    { path: ['Unit test', 'Passage'], kind: 'choice', answers: ['D', 'B', 'A'] },
    { path: ['Unit test', 'Lecture'], kind: 'choice', answers: ['C', 'B', 'A', 'C'] },
    { path: ['Unit 2', 'Taking in', 'Listening to China', 'While you listen', 'Exercise 2'], kind: 'fill', answers: ['fighting a battle', 'misunderstandings', 'my energy', 'Chinese calligraphy', 'incredibly fulfilling', 'build connections'] },
    { path: ['Unit 2', 'Taking in', 'Listening to China', 'While you listen', 'Exercise 3'], kind: 'choice', answers: ['B', 'A', 'A', 'B', 'B'] },
    { path: ['Unit 2', 'Taking in', 'Viewing China', 'While you view', 'Exercise 1'], kind: 'choice', answers: ['D', 'C', 'B'] },
    { path: ['Unit 2', 'Taking in', 'Viewing China', 'While you view', 'Exercise 2'], kind: 'fill', answers: ['vividly colored', 'facial gestures', 'silk cloth', 'different emotions'] },
    { path: ['Unit 2', 'Taking in', 'Viewing world cultures', 'While you view', 'Exercise 1'], kind: 'choice', answers: ['D', 'F', 'C', 'H', 'B', 'E', 'A', 'G'] },
    { path: ['Unit 2', 'Taking in', 'Viewing world cultures', 'While you view', 'Exercise 2'], kind: 'fill', answers: ['starting badly', 'tired', 'looking happy', 'having problems', 'enjoying the experience', 'amazing story', 'just enjoy it'] },
    { path: ['Unit 2', 'Taking in', 'Watching street interviews', 'Exercise 2'], kind: 'fill', answers: ['good mood', 'sun', 'brings a smile'] },
    { path: ['Unit 2', 'Taking in', 'Watching street interviews', 'Exercise 3'], kind: 'choice', answers: ['A', 'D', 'C', 'B'] },
    { path: ['Unit 2', 'Taking in', 'Watching street interviews', 'Exercise 4'], kind: 'choice', answers: ['A', 'C', 'E', 'F'] },
    { path: ['Unit 2', 'Speaking out', 'Group discussion', 'Get ideas', 'Exercise 1'], kind: 'choice', answers: ['B', 'A', 'B', 'A', 'A', 'A'] },
    { path: ['Unit 2', 'Speaking out', 'Group discussion', 'Get ideas', 'Exercise 2'], kind: 'choice', answers: ['A', 'C', 'D', 'F'] },
    { path: ['Unit 2', 'Further listening', 'Conversation'], kind: 'choice', answers: ['A', 'C', 'C', 'B'] },
    { path: ['Unit 2', 'Further listening', 'Passage'], kind: 'choice', answers: ['B', 'A', 'C', 'C'] },
    { path: ['Unit 2', 'Further listening', 'Lectures 1'], kind: 'choice', answers: ['B', 'C', 'D'] },
    { path: ['Unit 2', 'Further listening', 'Lectures 2'], kind: 'choice', answers: ['D', 'B', 'A', 'D'] },
    { path: ['Unit 2', 'Unit test', 'Conversation'], kind: 'choice', answers: ['B', 'C', 'B', 'D'] },
    { path: ['Unit 2', 'Unit test', 'Passage'], kind: 'choice', answers: ['D', 'C', 'B'] },
    { path: ['Unit 2', 'Unit test', 'Lecture'], kind: 'choice', answers: ['D', 'B', 'C'] },
  ];
  // 已由本人截图确认的第三、第四单元；导入的自定义答案稍后仍优先覆盖。
  COURSE_TASKS.push(...[
  {
    "path": [
      "Unit 3",
      "Taking in",
      "Listening to China",
      "While you listen",
      "Exercise 1"
    ],
    "kind": "fill",
    "answers": [
      "alley",
      "traditional Chinese culture",
      "boundaries",
      "gain advantages",
      "moved",
      "compromise",
      "inspire"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Taking in",
      "Listening to China",
      "While you listen",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "B",
      "A",
      "A"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Taking in",
      "Viewing China",
      "While you view",
      "Exercise 1"
    ],
    "kind": "choice",
    "answers": [
      "D",
      "B",
      "C"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Taking in",
      "Viewing China",
      "While you view",
      "Exercise 2"
    ],
    "kind": "fill",
    "answers": [
      "disaster relief aid",
      "responded swiftly",
      "technical consultations",
      "over 400 million",
      "combat these trials"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Taking in",
      "Viewing world cultures",
      "While you view",
      "Exercise 1"
    ],
    "kind": "choice",
    "answers": [
      "E",
      "A",
      "F",
      "B",
      "D",
      "C"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Taking in",
      "Viewing world cultures",
      "While you view",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "C",
      "A",
      "D"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Taking in",
      "Watching street interviews",
      "Exercise 2"
    ],
    "kind": "fill",
    "answers": [
      "a block of",
      "similar things",
      "quite a lot"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Taking in",
      "Watching street interviews",
      "Exercise 3"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "D",
      "A",
      "C"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Taking in",
      "Watching street interviews",
      "Exercise 4"
    ],
    "kind": "choice",
    "answers": [
      "AEG",
      "D",
      "F",
      "BH",
      "C"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Speaking out",
      "Group discussion",
      "Get ideas",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "B",
      "C",
      "E"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Further listening",
      "Conversation"
    ],
    "kind": "choice",
    "answers": [
      "D",
      "A",
      "B",
      "D"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Further listening",
      "Passage"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "C",
      "C"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Further listening",
      "Lecture 1"
    ],
    "kind": "choice",
    "answers": [
      "C",
      "D",
      "A"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Further listening",
      "Lecture 2"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "D",
      "C",
      "B"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Unit test",
      "Conversation"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "C",
      "B",
      "B"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Unit test",
      "Passage"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "D",
      "C",
      "D"
    ]
  },
  {
    "path": [
      "Unit 3",
      "Unit test",
      "Lecture"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "C",
      "C"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Taking in",
      "Listening to China",
      "While you listen",
      "Exercise 1"
    ],
    "kind": "fill",
    "answers": [
      "Development of BDS",
      "BDS-1 for China's use only",
      "BDS-3 for the whole world",
      "transportation",
      "disaster relief",
      "short message",
      "innovative services",
      "humanity"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Taking in",
      "Listening to China",
      "While you listen",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "B",
      "B",
      "A"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Taking in",
      "Viewing China",
      "While you view",
      "Exercise 1"
    ],
    "kind": "choice",
    "answers": [
      "D",
      "C"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Taking in",
      "Viewing China",
      "While you view",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "A",
      "A",
      "B",
      "A"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Taking in",
      "Viewing world cultures",
      "While you view",
      "Exercise 1"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "B",
      "A"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Taking in",
      "Viewing world cultures",
      "While you view",
      "Exercise 2"
    ],
    "kind": "fill",
    "answers": [
      "easy",
      "suit",
      "fish heads",
      "left",
      "wonderful",
      "fear"
    ],
    "corrections": [
      {
        "action": "change",
        "from": "difficult",
        "to": "easy"
      },
      {
        "action": "change",
        "from": "mask",
        "to": "suit"
      },
      {
        "action": "change",
        "from": "meat",
        "to": "fish heads"
      },
      {
        "action": "change",
        "from": "right",
        "to": "left"
      },
      {
        "action": "change",
        "from": "frightening",
        "to": "wonderful"
      },
      {
        "action": "change",
        "from": "nervousness",
        "to": "fear"
      }
    ]
  },
  {
    "path": [
      "Unit 4",
      "Taking in",
      "Watching street interviews",
      "Exercise 2"
    ],
    "kind": "fill",
    "answers": [
      "happening",
      "concern",
      "challenges"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Taking in",
      "Watching street interviews",
      "Exercise 3"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "BD",
      "FEDEAFBC"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Taking in",
      "Watching street interviews",
      "Exercise 4"
    ],
    "kind": "fill",
    "answers": [
      "wars",
      "harmony",
      "chat more",
      "less conflict",
      "in power",
      "response",
      "farms",
      "source of fuel",
      "agreeing with",
      "natural resources",
      "each other's shoes",
      "judge",
      "switch the roles"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Speaking out",
      "Group discussion",
      "Get ideas",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "B",
      "D",
      "F",
      "H",
      "I"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Further listening",
      "Conversation"
    ],
    "kind": "choice",
    "answers": [
      "C",
      "B",
      "C",
      "B"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Further listening",
      "Passage"
    ],
    "kind": "choice",
    "answers": [
      "D",
      "D",
      "B"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Further listening",
      "Lecture 1"
    ],
    "kind": "choice",
    "answers": [
      "D",
      "B",
      "C"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Further listening",
      "Lecture 2"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "A",
      "D",
      "B"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Unit test",
      "Conversation"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "B",
      "D",
      "D"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Unit test",
      "Passage"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "B",
      "C"
    ]
  },
  {
    "path": [
      "Unit 4",
      "Unit test",
      "Lecture"
    ],
    "kind": "choice",
    "answers": [
      "D",
      "C",
      "B",
      "D"
    ]
  }
]);
  // 用户截图确认的 Unit 5、6；仍优先使用个人导入的答案。分组题待题面核实。
  COURSE_TASKS.push(...[
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Listening to China",
      "While you listen",
      "Exercise 1"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "D",
      "E",
      "C",
      "F",
      "A"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Listening to China",
      "While you listen",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "A",
      "A",
      "A",
      "B",
      "B"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Listening to China",
      "While you listen",
      "Exercise 3"
    ],
    "kind": "fill",
    "answers": [
      "ticking away",
      "antique clock restoration",
      "work on",
      "repairing them",
      "put the spotlight",
      "occupation"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Viewing China",
      "While you view",
      "Exercise 1"
    ],
    "kind": "choice",
    "answers": [
      "C",
      "D",
      "A"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Viewing China",
      "While you view",
      "Exercise 2"
    ],
    "kind": "fill",
    "answers": [
      "more than six decades",
      "natural forests",
      "forestry engineer",
      "endangered species",
      "the protection of forest resources"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Viewing world cultures",
      "While you view",
      "Exercise 1"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "C",
      "D"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Viewing world cultures",
      "While you view",
      "Exercise 2"
    ],
    "kind": "fill",
    "answers": [
      "break down",
      "very confused",
      "the opportunity",
      "negative cycle",
      "the other side",
      "exit homelessness"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Watching street interviews",
      "Exercise 2"
    ],
    "kind": "fill",
    "answers": [
      "producer",
      "dream job",
      "a successful band"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Watching street interviews",
      "Exercise 3"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "C",
      "D",
      "G",
      "J"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Watching street interviews",
      "Exercise 4"
    ],
    "kind": "choice",
    "answers": [
      "E",
      "B",
      "A",
      "D",
      "C"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Taking in",
      "Watching street interviews",
      "Exercise 5"
    ],
    "kind": "fill",
    "answers": [
      "footballer",
      "professional",
      "on my own",
      "design houses",
      "teach",
      "doctor",
      "starting a band"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Speaking out",
      "Group discussion",
      "Get ideas",
      "Exercise 2"
    ],
    "kind": "fill",
    "answers": [
      "takes a shower",
      "switches on the lights",
      "coming in",
      "seated at the table",
      "have a little nap",
      "snack time",
      "take the children home"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Further listening",
      "Conversation"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "B",
      "D",
      "C"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Further listening",
      "Passage"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "D",
      "C"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Further listening",
      "Lecture 1"
    ],
    "kind": "choice",
    "answers": [
      "C",
      "C",
      "D",
      "D"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Further listening",
      "Lecture 2"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "D",
      "B"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Unit test",
      "Conversation"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "C",
      "D",
      "B"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Unit test",
      "Passage"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "C",
      "D"
    ]
  },
  {
    "path": [
      "Unit 5",
      "Unit test",
      "Lecture"
    ],
    "kind": "choice",
    "answers": [
      "D",
      "B",
      "C",
      "B"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Opening up",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "AEG",
      "CFHK",
      "BDIJ"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Taking in",
      "Listening to China",
      "While you listen",
      "Exercise 1"
    ],
    "kind": "fill",
    "answers": [
      "basic necessities",
      "well-managed nationwide database",
      "multiple strategies",
      "providing social assistance",
      "sustainability",
      "employment opportunities"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Taking in",
      "Listening to China",
      "While you listen",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "C",
      "D",
      "E"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Taking in",
      "Viewing China",
      "While you view",
      "Exercise 1"
    ],
    "kind": "choice",
    "answers": [
      "C",
      "A"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Taking in",
      "Viewing China",
      "While you view",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "B",
      "B",
      "A",
      "A"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Taking in",
      "Viewing world cultures",
      "While you view",
      "Exercise 1"
    ],
    "kind": "choice",
    "answers": [
      "D",
      "B",
      "E",
      "C",
      "A"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Taking in",
      "Viewing world cultures",
      "While you view",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "B",
      "B",
      "B",
      "A"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Taking in",
      "Watching street interviews",
      "Exercise 2"
    ],
    "kind": "fill",
    "answers": [
      "fixing problems",
      "sort out",
      "solving problems"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Taking in",
      "Watching street interviews",
      "Exercise 3"
    ],
    "kind": "fill",
    "answers": [
      "Yes",
      "Yes",
      "Yes",
      "Yes",
      "With some things",
      "Most of the time"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Taking in",
      "Watching street interviews",
      "Exercise 4"
    ],
    "kind": "choice",
    "answers": [
      "E",
      "A",
      "C",
      "B",
      "D",
      "C",
      "A",
      "B"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Speaking out",
      "Group discussion",
      "Get ideas",
      "Exercise 2"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "D",
      "G"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Further listening",
      "Conversation"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "B",
      "C",
      "D"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Further listening",
      "Passage"
    ],
    "kind": "choice",
    "answers": [
      "D",
      "C",
      "D",
      "B"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Further listening",
      "Lecture 1"
    ],
    "kind": "choice",
    "answers": [
      "C",
      "C",
      "B"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Further listening",
      "Lecture 2"
    ],
    "kind": "choice",
    "answers": [
      "D",
      "C",
      "A",
      "B"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Unit test",
      "Conversation"
    ],
    "kind": "choice",
    "answers": [
      "A",
      "B",
      "B",
      "C"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Unit test",
      "Passage"
    ],
    "kind": "choice",
    "answers": [
      "C",
      "B",
      "C"
    ]
  },
  {
    "path": [
      "Unit 6",
      "Unit test",
      "Lecture"
    ],
    "kind": "choice",
    "answers": [
      "C",
      "A",
      "C"
    ]
  }
]);
  function suggestTasks(tasks, activeLabels) {
    const active = new Set((activeLabels || []).map(routeLabel).filter(Boolean));
    const pageUnits = [...active].map(unitNumberFrom).filter(Boolean);
    return tasks.filter(task => {
      if (!Array.isArray(task.path) || !task.path.length) return false;
      const taskUnit = isUnitToken(task.path[0]) ? unitNumberFrom(task.path[0]) : '';
      if (pageUnits.length) {
        if (taskUnit && !pageUnits.includes(taskUnit)) return false;
        if (!taskUnit && !pageUnits.includes('1') && pageUnits.some(number => number !== '1')) return false;
      }
      const parts = taskUnit ? task.path.slice(1) : task.path;
      return parts.length > 0 && parts.every(part => active.has(routeLabel(part)));
    });
  }
  function navigationPath(path) {
    // 网页可能把板块标题和同名可点击子目录各放一层。
    // 只合并连续、精确同名的导航层级，不改答案路径或提交记录键。
    const result = [];
    for (const part of path || []) {
      if (!routeLabel(part)) continue;
      if (result.length && routeLabel(result[result.length - 1]) === routeLabel(part)) continue;
      result.push(part);
    }
    return result;
  }
  function alignedMenuPath(menuPath, taskPath) {
    if (!unitCompatible(menuPath, taskPath)) return null;
    const task = navigationPath(taskBodyPath(taskPath)).map(routeLabel).filter(Boolean);
    const menu = [];
    for (const part of navigationPath(menuPath)) {
      const label = routeLabel(part);
      if (!label) continue;
      if (!menu.length && !task.includes(label)) continue;
      menu.push(label);
    }
    if (!menu.length || !task.length) return null;
    for (let start = 0; start + menu.length <= task.length; start++) {
      if (!menu.every((part, index) => part === task[start + index])) continue;
      if (start === 0 || start + menu.length === task.length) return menu;
    }
    return null;
  }
  function answeredMenuFlags(entries, tasks) {
    const paths = (tasks || []).filter(task => Array.isArray(task.path) && task.path.length && Array.isArray(task.answers) && task.answers.length).map(task => task.path);
    const hits = (entries || []).map(entry => paths.map(path => alignedMenuPath(entry, path)).filter(Boolean));
    return hits.map((own, index) => own.length > 0 && !hits.some((other, otherIndex) => otherIndex !== index && other.some(hit => own.some(item => item.length < hit.length && item.every((part, partIndex) => part === hit[partIndex])))));
  }
  function menuAlignment(menuPath, taskPath) {
    if (!unitCompatible(menuPath, taskPath)) return null;
    const task = navigationPath(taskBodyPath(taskPath)).map(routeLabel).filter(Boolean);
    const menu = [];
    for (const part of navigationPath(menuPath)) {
      const label = routeLabel(part);
      if (!label) continue;
      if (!menu.length && !task.includes(label)) continue;
      menu.push(label);
    }
    if (!menu.length || !task.length || menu.length > task.length) return null;
    if (!menu.every((part, index) => part === task[index])) return null;
    return menu;
  }
  function nextMenuJump(entries, taskPath, coveredCount) {
    const want = navigationPath(taskBodyPath(taskPath)).map(routeLabel).filter(Boolean);
    const covered = coveredCount || 0;
    const ranked = [];
    (entries || []).forEach((entry, index) => {
      if (!entry?.clickable) return;
      const aligned = menuAlignment(entry.path, taskPath);
      if (!aligned || aligned.length <= covered) return;
      if (!aligned.slice(0, covered).every((part, index) => part === want[index])) return;
      ranked.push({ index, key: aligned.join('\n'), length: aligned.length, labels: aligned });
    });
    if (!ranked.length) return null;
    const best = Math.max(...ranked.map(item => item.length));
    const keys = [...new Set(ranked.filter(item => item.length === best).map(item => item.key))];
    if (keys.length !== 1) return { ambiguous: keys.length };
    const hit = ranked.find(item => item.length === best && item.key === keys[0]);
    return { index: hit.index, covered: hit.labels };
  }
  function taskKey(path, book) {
    const body = (path || []).map(compactLabel).filter(Boolean).join('/');
    const name = bookName(book || DEFAULT_BOOK);
    return name === DEFAULT_BOOK ? body : compactLabel(name) + '//' + body;
  }
  function correctionDetails(task) {
    let corrections = task?.corrections;
    // 兼容0.2.13以前导入器未保留corrections的这道已知练习，不必重新导入。
    if (!corrections && task && taskKey(task.path, task.book) === taskKey(['Unit 4', 'Taking in', 'Viewing world cultures', 'While you view', 'Exercise 2'])) {
      const from = ['difficult', 'mask', 'meat', 'right', 'frightening', 'nervousness'];
      const to = ['easy', 'suit', 'fish heads', 'left', 'wonderful', 'fear'];
      if (task.answers.join('\n') === to.join('\n')) corrections = from.map((word, i) => ({ action: 'change', from: word, to: to[i] }));
    }
    if (corrections == null) return [];
    if (task.kind !== 'fill' || !Array.isArray(corrections) || corrections.length !== task.answers.length) throw new Error('改错操作数与答案数不符。');
    return corrections.map((entry, i) => {
      const action = entry?.action || 'change';
      if (!['change', 'add-before', 'delete', 'mark-correct'].includes(action)) throw new Error('未知改错操作，不能猜测。');
      const from = typeof entry.from === 'string' ? entry.from.trim() : '';
      const to = typeof entry.to === 'string' ? entry.to.trim() : '';
      if (action !== 'mark-correct' && !from) throw new Error('改错缺少原词或添加位置。');
      if (['change', 'add-before'].includes(action) && (!to || to !== task.answers[i].trim())) throw new Error('修改/添加内容与答案不一致。');
      return { action, from, to };
    });
  }
  function validateCourseImport(data) {
    if (data?.schema !== 'ucampus-course-answers/v1') throw new Error('整单元答案格式应为 ucampus-course-answers/v1。');
    if (!Array.isArray(data.tasks) || !data.tasks.length || data.tasks.length > 500) throw new Error('请提供 1 至 500 道练习。');
    const seen = new Set();
    return data.tasks.map(task => {
      if (!Array.isArray(task.path) || task.path.length < 3 || task.path.some(part => typeof part !== 'string' || !part.trim()) || !/^Unit [1-9]\d*$/.test(task.path[0])) throw new Error('每道练习需要完整路径，并以 Unit 1、Unit 2 等开头。');
      if (!['fill', 'choice'].includes(task.kind)) throw new Error('kind 只能是 fill 或 choice。');
      if (!Array.isArray(task.answers) || !task.answers.length || task.answers.some(a => typeof a !== 'string' || !a.trim())) throw new Error('答案必须是非空字符串数组。');
      if (task.kind === 'choice' && task.answers.some(a => !/^[A-Z]+$/.test(a))) throw new Error('选择题每一组必须是大写字母。同一题多选写成一组，例如 AEG；斜杠只用来分组，不要写进答案。');
      const path = task.path.map(part => part.trim());
      if (path[0] === 'Unit 1') path.shift();
      const book = bookName(task.book || data.course || DEFAULT_BOOK);
      if (book.length > 150) throw new Error('教材名过长。');
      const key = taskKey(path, book);
      if (seen.has(key)) throw new Error('文件中有重复练习：' + path.join(' / '));
      seen.add(key);
      const result = { path, kind: task.kind, answers: task.answers.map(a => a.trim()) };
      if (book !== DEFAULT_BOOK) result.book = book;
      const corrections = correctionDetails({ ...result, corrections: task.corrections });
      if (corrections.length) result.corrections = corrections;
      return result;
    });
  }
  function groupCourseTasks(tasks, submitted, owned = [], onlyOwned = false) {
    const done = submitted || new Set(), books = new Map(owned.map(name => [bookName(name), { name: bookName(name), units: new Map(), done: 0, total: 0 }]));
    tasks.forEach((task, index) => {
      const bookName = taskBook(task);
      if (onlyOwned && !books.has(bookName)) return;
      const number = isUnitToken(task.path[0]) ? Number(unitNumberFrom(task.path[0])) : 1;
      if (!books.has(bookName)) books.set(bookName, { name: bookName, units: new Map(), done: 0, total: 0 });
      const book = books.get(bookName);
      if (!book.units.has(number)) book.units.set(number, { number, key: bookName + '/' + number, entries: [], done: 0, total: 0 });
      const unit = book.units.get(number), marked = done.has(taskKey(task.path, task.book));
      unit.entries.push({ task, index, marked }); unit.total++; book.total++;
      if (marked) { unit.done++; book.done++; }
    });
    return [...books.values()].map(book => ({ ...book, units: [...book.units.values()].sort((a, b) => a.number - b.number) }));
  }
  function formatTaskAnswers(task) {
    if (!task) return '';
    const corrections = correctionDetails(task);
    if (corrections.length) return corrections.map((entry, i) => {
      let text;
      if (entry.action === 'change') text = '修改（change）：把 ' + entry.from + ' 替换为 ' + entry.to;
      else if (entry.action === 'add-before') text = '添加（add-before）：在 ' + entry.from + ' 前面添加 ' + entry.to;
      else if (entry.action === 'delete') text = '删除（delete）：删除 ' + entry.from;
      else text = '原句正确（mark-correct）：标记本句无须修改';
      return (i + 1) + '. ' + text;
    }).join('\n');
    return task.answers.map((answer, index) => (index + 1) + '. ' + answer).join('\n');
  }
  // 允许离线验证答案格式，不在 Node 环境启动页面界面。
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { normalize, fingerprint, validateAnswers, compactLabel, suggestTasks, alignedMenuPath, answeredMenuFlags, menuAlignment, nextMenuJump, navigationPath, taskKey, unitCompatible, validateCourseImport, planSequenceMoves, groupCourseTasks, formatTaskAnswers, correctionDetails, accountRecord, accountFromHomeFields, accountFromHomeState, accountFromPlayer, compareVersions, installationDownloadUrl, parseReleaseMetadata, isRateLimitNotice, createSubmitProtection, buildAutoPlan, executeTimedPlan, buildRepeatPlan, executeRepeatPlan, fillWhenPageReady, isUnreadPage, bookName, taskBook, CONFIRMED_BOOKS, COURSE_TASKS };
    return;
  }
  if (document.getElementById('ucampus-transfer-host')) return;
  const host = document.createElement('div');
  host.id = 'ucampus-transfer-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
:host{all:initial;position:fixed;right:20px;top:32px;z-index:2147483646;font:13px/1.55 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:#24334b;--accent:#345bea;--line:#e3e9f3;--muted:#738096;color-scheme:light}
*,*::before,*::after{box-sizing:border-box} [hidden]{display:none!important}
section{width:480px;max-width:calc(100vw - 24px);max-height:calc(100vh - 56px);display:flex;flex-direction:column;background:#f4f7fc;border:1px solid #dce4f0;border-radius:20px;box-shadow:0 20px 65px #203a6324,0 3px 12px #203a6312;overflow:hidden}
header{display:flex;align-items:center;gap:11px;padding:17px 18px 14px;background:#fff;cursor:grab;user-select:none;touch-action:none;flex-shrink:0}header:active{cursor:grabbing}.brand-mark{display:grid;place-items:center;width:39px;height:39px;flex-shrink:0;border-radius:13px;background:linear-gradient(140deg,#5479ff,#3455d9);color:#fff;font:bold 24px/1 'Segoe UI',sans-serif;box-shadow:0 5px 12px #345bea25}.brand-copy{flex:1;min-width:0}.brand-copy strong{display:block;font-size:16px;letter-spacing:.3px;color:#1c2c46}.brand-copy span{font-size:10px;letter-spacing:1.1px;color:#8793a6}.version{font-size:10px;color:#8793a6;font-weight:500;margin-left:5px;letter-spacing:0}
button{appearance:none;cursor:pointer;border:1px solid #dce4f0;border-radius:9px;background:#fff;padding:9px 11px;font:600 12px/1.45 'Segoe UI','Microsoft YaHei',sans-serif;font-family:inherit;color:#465975;transition:background .15s,border-color .15s,box-shadow .15s,transform .15s;min-width:0}button:hover:not(:disabled){background:#f0f4ff;border-color:#aebef8;box-shadow:0 2px 5px #2548a00b}button:active:not(:disabled){transform:translateY(1px)}button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #345bea38;outline-offset:2px}button:disabled{opacity:.42;cursor:default}#toggle,#timer-toggle{padding:6px 10px;border:0;background:#f0f3f9;color:#67758b;font-size:11px}
.current-banner{padding:0 18px 13px;background:#fff;border-bottom:1px solid var(--line)}#current-task{display:block;margin:0;padding:9px 11px;border-radius:9px;color:#3157c2;background:#edf2ff;font-size:11px;line-height:1.6;font-weight:600;overflow-wrap:anywhere}#body,#timer-body{overflow:auto;overscroll-behavior:contain;padding:14px;min-height:0;scrollbar-width:thin;scrollbar-color:#cbd5e6 transparent}#body::-webkit-scrollbar,#task-tree::-webkit-scrollbar,textarea::-webkit-scrollbar{width:5px}#body::-webkit-scrollbar-thumb,#task-tree::-webkit-scrollbar-thumb,textarea::-webkit-scrollbar-thumb{background:#cbd5e6;border-radius:10px}
.card{background:#fff;border:1px solid var(--line);border-radius:13px;padding:13px;margin-bottom:11px}.card-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;gap:8px}.card-heading strong{font-size:13px;color:#253752}.caption{font-size:10px;font-weight:500;color:#92a0b3;letter-spacing:.5px}.toolbar{display:grid;grid-template-columns:1fr 1fr;gap:7px}.toolbar button{padding:7px 5px;font-size:11px;background:#f7f9fd}.legend{display:flex;gap:12px;font-size:10px;color:#7d8b9e;margin:10px 0 0}.legend span{display:flex;align-items:center;gap:4px}.dot{width:6px;height:6px;border-radius:50%;display:inline-block}.dot.pending{background:#c65460}.dot.done{background:#47a778}.dot.current{background:#4168e9}
#data-note{font-size:10px;color:#8190a6;margin:8px 0 0}#books-note{margin:0}#task-tree{height:min(340px,42vh);min-height:210px;overflow:auto;overflow-x:hidden;overscroll-behavior:contain;margin-top:10px;scrollbar-width:thin}#task-tree>details{border:1px solid #e8edf5;border-radius:9px;margin-bottom:6px;background:#fff}#task-tree>details>summary{font-size:11px;line-height:1.7;padding:9px 10px;color:#41516b;background:#f8faff;border-radius:9px}#task-tree .unit{margin:4px 5px 7px}summary{cursor:pointer;font-weight:600;list-style:none;position:relative;padding-right:16px;overflow-wrap:anywhere}summary::-webkit-details-marker{display:none}summary::after{content:'›';font:18px/1 sans-serif;color:#9aa8ba;position:absolute;right:3px;top:50%;transform:translateY(-50%) rotate(0deg);transition:transform .15s}details[open]>summary::after{transform:translateY(-50%) rotate(90deg)}#task-tree>details>summary::after{right:9px}#task-tree .unit>summary{padding:9px 11px;font-size:12px;color:#6b7e97}.task-row{display:block;width:calc(100% - 8px);margin:4px;padding:10px 12px;text-align:left;font-size:11px;font-weight:400;line-height:1.65;white-space:pre-line;border:1px solid #f0e2e6;border-radius:8px;color:#b15160;background:#fffafb}.task-row::first-line{font-size:12px;font-weight:650}.task-row.done{background:#edf8f1;color:#397556;border-color:#d9eddf}.task-row.current{border-color:#6f8cf0;background:#eef3ff;color:#315cc9;box-shadow:inset 3px 0 #436be5}.task-row.chosen:not(.current){outline:1px dashed #aab8cf;outline-offset:-1px}
small{display:block;font-size:10px;color:#8190a6;line-height:1.7;margin:7px 0 0}.hint{margin-top:9px}.card>summary{font-size:12px;color:#354864;padding:0 19px 0 0}.card[open]>summary{margin-bottom:10px}.answer-title{color:#8a98aa;font-size:10px;font-weight:400;margin-left:5px}#answer-path{font-size:10px;color:#8290a5;overflow-wrap:anywhere;margin:5px 0 8px}
textarea,select,input[type=number]{width:100%;font-family:inherit;font-size:12px;color:#354760;border:1px solid #dfe6f1;border-radius:9px;background:#fbfcff;padding:9px 11px}textarea{height:110px;resize:vertical;line-height:1.9;display:block;scrollbar-width:thin}#answer-display{background:#f7f9fd;color:#3a4f70;font-family:'Cascadia Mono',Consolas,'Microsoft YaHei',monospace;letter-spacing:.2px}#answers{margin:10px 0;font-family:Consolas,monospace;font-size:11px}select{margin:10px 0;appearance:auto}input[type=file]{max-width:100%;font-size:11px;color:#8090a7}input[type=file]::file-selector-button{border:1px solid #dbe4f3;background:#f3f6fd;color:#50688c;border-radius:7px;padding:7px 9px;margin-right:8px;cursor:pointer;font-family:inherit}label{font-size:11px;color:#6b7e97;display:block}input[type=number]{margin-top:5px;font-size:18px;font-weight:650;color:#304c8f;font-variant-numeric:tabular-nums}
.utility-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}.utility-actions button{font-size:10px;padding:7px 3px;border-color:#e5eaf3;color:#7b8ba2}.main-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px}#submit-course{grid-column:1/-1;background:var(--accent);color:#fff;border-color:var(--accent);font-size:13px;padding:11px;box-shadow:0 4px 10px #345bea1d}#submit-course:hover:not(:disabled),#auto-start:hover:not(:disabled){background:#284bd1;border-color:#284bd1}#fill-course{color:#4960a0;background:#f4f7ff;border-color:#dfe6fc}#submit-only{color:#36805d;background:#f3faf6;border-color:#daeee3}.number-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}#auto-preview{background:#f2f5fe;color:#647ca9;border-radius:8px;padding:9px 10px;margin:0 0 10px;font-size:10px}.auto-actions{display:grid;grid-template-columns:1fr 76px;gap:7px}#auto-start{background:#345bea;border-color:#345bea;color:#fff}#auto-stop{color:#c26068;background:#fff5f6;border-color:#f1dce0}#auto-skipped{font-size:10px;background:#fff8ec;color:#a57933;border-radius:8px;padding:8px;max-height:100px;margin-top:10px}#auto-skipped:empty{display:none}.import-actions{display:flex;flex-wrap:wrap;gap:6px}.import-actions button{font-size:10px;padding:7px 9px}.advanced-tools{margin-top:12px;padding-top:10px;border-top:1px solid #edf1f7}.advanced-tools>summary{font-size:11px;color:#92a0b3}.advanced-tools .import-actions{margin-top:10px}
.status-card{padding:11px 12px;background:#edf2fc;border:1px solid #dfe7f5;border-radius:11px}.status-label{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:650;letter-spacing:.5px;color:#8293ae}.status-label::before{content:'';width:5px;height:5px;background:#6e8ad1;border-radius:50%}pre{white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere;font:11px/1.8 'Segoe UI','Microsoft YaHei',sans-serif;font-family:inherit;max-height:145px;margin:5px 0 0;color:#536d96}#status[data-state=error]{color:#b15a61}#status[data-state=success]{color:#38795c}.panel-foot{text-align:center;font-size:9px;letter-spacing:.5px;color:#a3aec0;margin:10px 0 0}
@media(max-width:480px){:host{right:12px;top:16px}section{max-height:calc(100vh - 32px)}header{padding:13px 14px}#body{padding:10px}}

.timer-window{position:fixed;right:520px;top:32px;width:320px;z-index:2147483646}.timer-window header{padding:14px;gap:9px}.timer-window .brand-copy strong{font-size:15px}.timer-mark{width:34px;height:34px;display:grid;place-items:center;border-radius:11px;background:#eaf0ff;color:#4167dc;font-size:25px;font-weight:650}.timer-window .current-banner{padding:0 14px 12px}#timer-summary{background:#edf2ff;color:#4c68a7;font-size:10px;padding:8px 10px;border-radius:8px;margin:0;max-height:52px;overflow:hidden;overflow-wrap:anywhere}#timer-start-path{margin:0;font-size:10px;overflow-wrap:anywhere;color:#7085a5}#timer-stop-quick{padding:6px 9px;color:#bb5963;background:#fff4f5;border-color:#f1d9dd;font-size:11px}#timer-body{padding:12px}.timer-window #auto-scope{font-size:11px}.timer-window #timer-status[data-state=error]{color:#b15a61}.timer-window #timer-status[data-state=success]{color:#38795c}.timer-link{display:block;width:100%;margin:0 0 11px;padding:10px;background:#edf2ff;border-color:#d9e2fc;color:#4666c7}.update-route{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;font-size:11px;color:#70829b}.update-route select{flex:1;border:1px solid #dce4f0;border-radius:8px;background:#fff;padding:7px 8px;font:inherit;color:#31435f}
.timer-metrics{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:9px}.timer-stat{border:1px solid #dfe7f7;background:#fff;border-radius:12px;padding:10px 12px}.timer-stat small{margin:0;font-size:10px;color:#8594aa}.timer-stat strong{display:block;margin-top:4px;font-size:23px;font-weight:650;line-height:1.3;color:#3b60c7;font-variant-numeric:tabular-nums}#timer-remaining{font-size:21px}#timer-perturb{display:block;margin-top:6px;color:#4869c1;font-size:12px;font-weight:650;line-height:1.35}.timer-progress-line{display:flex;justify-content:space-between;gap:8px;font-size:10px;margin:0 2px 12px;color:#7a8fac}#timer-phase{color:#4869c1}#timer-task{margin:0;color:#5b7298;font-size:11px;line-height:1.8;overflow-wrap:anywhere}
.window-links{display:grid;grid-template-columns:1fr 1fr;gap:8px}.log-window{position:fixed;right:856px;top:32px;width:340px;max-height:360px;z-index:2147483646}.log-window header{padding:13px;gap:8px}.log-window .brand-copy strong{font-size:15px}#log-export,#log-clear,#log-close{padding:6px 8px;font-size:10px;color:#71839e;border-color:#e0e7f2}#log-body{padding:0 12px 12px;min-height:0;overflow:hidden}#log-list{height:235px;max-height:calc(100vh - 190px);overflow:auto;border:1px solid #e0e8f5;border-radius:10px;background:#fff;padding:9px 10px;color:#5b7195;font-size:11px;line-height:1.9;scrollbar-width:thin;margin:0}#log-body small{font-size:9px;margin-top:7px}
/* 胡桃主题：梅花、蝶影与暖金描边，保持正文易读。 */
:host{--accent:#8d3048;--line:#eadce0;--muted:#917982;color:#473640}section{background:#fcf6f4;border-color:#e7cbd0;box-shadow:0 20px 65px #49202d28,0 3px 12px #49202d12}header{background:linear-gradient(105deg,#fff9f6 0%,#f8e8e9 72%,#efd5d6 100%);border-bottom:1px solid #e7cbd0}.brand-mark{position:relative;background:linear-gradient(140deg,#7d253d,#aa4351);box-shadow:0 5px 12px #70243d40;color:#ffe9bd}.brand-mark::after{content:'✿';position:absolute;right:-6px;top:-8px;color:#d9a160;font-size:16px;text-shadow:0 1px 2px #fff}.brand-copy strong{color:#643044}.brand-copy span,.caption{color:#9b6975}.current-banner{background:#fff9f6;border-color:#ead6d7}#current-task,#timer-summary{background:#faeceb;color:#79384d}.card{border-color:#eedfe0;background:#fffcfa}.card-heading strong{color:#76394d}.task-row.current{border-color:#af6875;background:#faeeed;color:#7c3448;box-shadow:inset 3px 0 #9a4257}.dot.current{background:#9a4257}.timer-link{background:#faedec;color:#833d50;border-color:#e9cbcf}.timer-mark{background:#f7e6e4;color:#92445b}#submit-course,#auto-start{background:#8d3048;border-color:#8d3048;box-shadow:0 4px 10px #8d304830}#submit-course:hover:not(:disabled),#auto-start:hover:not(:disabled){background:#75253d;border-color:#75253d}#fill-course{color:#833e52;background:#fff5f3;border-color:#efd6da}.timer-stat strong,#timer-phase{color:#8d3048}#log-list{background:#fffaf8;color:#674e58;border-color:#eddce0}#log-export{color:#81394c;background:#fff5ee;border-color:#e8d1c7}button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline-color:#a0486266}.panel-foot::before{content:'✿  ';color:#b96b79}
#update-banner{padding:10px 14px;background:#fff2dc;border-bottom:1px solid #e8c59a;color:#714634}#update-banner strong{display:block;font-size:12px}#update-banner p{margin:3px 0 7px;font-size:11px}#update-banner div{display:flex;gap:8px}#update-banner button{font-size:11px;padding:5px 10px}#update-now{background:#8d3048;color:#fff;border-color:#8d3048}
.idle-confirm-option{display:flex;align-items:center;gap:8px;padding:9px 12px;margin-bottom:9px;background:#fffaf5;border:1px solid var(--line);border-radius:10px;cursor:pointer}.idle-confirm-option input{accent-color:#8d3048;width:15px;height:15px;flex-shrink:0}
#account-banner{margin:0 0 8px;padding:8px 11px;border:1px solid #ead2d5;border-radius:9px;background:#fff8f6;color:#783b4e;font-size:12px;font-weight:650;overflow-wrap:anywhere}.account-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}.account-actions button{font-size:10px;padding:6px 9px;color:#804151;background:#fff7f5}.jump-check-actions{display:grid;grid-template-columns:1fr 1fr 70px;gap:6px;margin-top:9px}.jump-check-actions button{padding:8px 4px;font-size:11px}.jump-check-actions #jump-check-stop{color:#ad5263;background:#fff4f5}#jump-check-results{max-height:185px;overflow:auto;margin-top:9px;padding:8px 10px;background:#fff8f5;border:1px solid #eedfe0;border-radius:9px;font-size:11px;line-height:1.7}#jump-check-results:empty{display:none}#submit-top{background:#8d3048;color:#fff;border-color:#8d3048;padding:7px 8px;font-size:10px;white-space:nowrap}.task-line{display:flex;align-items:stretch;gap:3px;margin:4px}.task-line .task-row{flex:1;width:auto;margin:0}.task-manual{flex:0 0 71px;font-size:10px;padding:5px 4px;white-space:normal}.task-row.unreachable:not(.current){background:#f6ebff;border-color:#ddc2f3;color:#6a3d86}.task-row.unreachable.current{box-shadow:inset 3px 0 #8d4db8}.dot.unreachable{background:#c49ae0}
#submit-protection{position:fixed;width:240px;max-width:calc(100vw - 24px);padding:14px;background:#fff4e5;border:1px solid #d59a60;border-radius:14px;box-shadow:0 6px 24px #49202d33;z-index:2147483647;color:#79384d}#submit-protection strong{font-size:14px}#submit-protection-clock{display:block;font-size:30px;font-variant-numeric:tabular-nums;color:#8d3048}#submit-protection p{font-size:11px;margin:5px 0}#submit-protection[hidden]{display:none}
</style>
<aside id="submit-protection" hidden role="status" aria-label="提交保护倒计时"><strong>提交过快 · 休息一会</strong><b id="submit-protection-clock">08:00</b><p>提交过于快了，休息会再提交。</p><p>再次出现网页频繁操作提示时，重新计时8分钟。定时任务已停止，不会自动续跑。</p></aside>
<section aria-label="U校园答案搬运助手">
<header><div class="brand-mark">U</div><div class="brand-copy"><span>✿ 胡桃的学习手记 · U校园</span><strong>答案搬运助手 <b class="version">v${SCRIPT_VERSION}</b></strong></div><button id="submit-top" title="填写并提交所选练习">填写并提交</button><button id="toggle" title="收起或展开助手">收起</button></header>
<div id="update-banner" role="status" hidden><strong id="update-title">发现新版本</strong><p>官网已发布新版。已授权安装可更新；首次官网下载需向作者获取验证码。GitHub源码继续公开。</p><div><button id="update-now">前往更新</button><button id="update-later">稍后</button></div></div>
<div class="current-banner"><div id="account-banner" role="status">当前登录账号：正在识别学校和学号…</div><small id="current-task">当前题：识别中</small></div>
<div id="body">
<div class="card">
<div class="card-heading"><strong>我的教材</strong><span class="caption">练习目录</span></div>
<select id="task" hidden aria-hidden="true" tabindex="-1"></select>
<div class="toolbar"><button id="read-books">读取首页书架</button><button id="sync-records">同步跨页面记录</button></div>
<small id="data-note"></small><small id="account-note">账号识别中；提交标记暂不显示。</small><div class="account-actions"><button id="refresh-account" type="button">重新核对账号</button><button id="bind-account" type="button" hidden>绑定学校和学号</button><button id="claim-legacy" type="button" disabled>认领旧版提交记录</button></div><small>旧版标绿需认领；「同步跨页面记录」只同步数据，不会自动指定账号。</small><small id="books-note">仅显示当前账号首页实际读到的教材；有内置答案不代表账号拥有该书。无答案的教材显示（0/0）。</small>
<div id="task-tree" aria-label="按教材和单元分类的练习目录"></div>
<div class="legend"><span><i class="dot pending"></i>有答案 · 未交</span><span><i class="dot done"></i>已提交</span><span><i class="dot current"></i>当前题</span><span><i class="dot unreachable"></i>跳转未找到</span></div>
<small>单元进度为（已做/已收录）。紫底是跨账号共享的跳转失败题；列表右侧按钮只改当前账号的本地提交标记，不会向网站提交。</small>
<div class="jump-check-actions"><button id="jump-check-unit">检查当前单元</button><button id="jump-check-book">检查整本教材</button><button id="jump-check-stop" disabled>停止</button></div>
<small>整本教材只完整检查一次，结果跨账号共享；仅显示未找到的练习。检查期间请保持课本页打开。</small><pre id="jump-check-results" role="status" aria-live="polite"></pre>
</div>
<details class="card" id="answer-view" open><summary>所选练习答案 <span class="answer-title">按顺序查看 · 可复制</span></summary><small id="answer-path"></small><textarea id="answer-display" readonly aria-label="所选练习答案"></textarea></details>
<div class="card"><div class="card-heading"><strong>练习操作</strong><span class="caption">选择后执行</span></div>
<div class="utility-actions"><button id="jump">跳到这道题</button><button id="detect">识别当前练习</button><button id="bind-route">记住当前页位置</button></div>
<div class="main-actions"><button id="submit-course">填写并提交</button><button id="fill-course">仅填写答案</button><button id="submit-only" title="提交网页现有答案，不重新填写">仅提交</button></div><small class="hint">手动改好答案后用「仅提交」，保留网页现有内容。</small></div>
<div class="window-links"><button id="show-timer" class="timer-link">定时答题窗口 ↗</button><button id="toggle-log" class="timer-link">关闭日志窗口</button></div>
<button id="check-update" class="timer-link">检查新版</button><small>仅读取公开版本号；官网下载及后续更新使用可撤销的安装授权。GitHub源码仍公开。</small>
<label class="idle-confirm-option"><input id="auto-idle-confirm" type="checkbox">手动答题时，长时间未操作自动点「确定」</label><small>定时答题会自动确认指定的闲置提示，填完并核对当前题后提前提交，跳过的等待时间不补回。</small>
<details class="card" id="import-panel"><summary>导入答案与页面工具</summary><small>选择答案 JSON 自动导入，或粘贴后点导入。</small><input id="file" type="file" accept="application/json,.json"><textarea id="answers" placeholder="在此粘贴完整答案 JSON"></textarea><div class="import-actions"><button id="import-course">导入整单元答案</button><button id="preview">核对答案</button><button id="fill" disabled>填写本页答案</button></div><small>导入只保存；同一本书、同一道题的答案会更新。</small>
<details class="advanced-tools"><summary>页面资料与模板</summary><div class="import-actions"><button id="scan">采集当前练习</button><button id="export">导出页面资料</button><button id="template">导出答案模板</button></div></details></details>
<div class="status-card"><div class="status-label">运行状态</div><pre id="status" role="status" aria-live="polite">准备就绪。选择一道练习开始。</pre></div><div class="panel-foot">拖动顶部标题可移动窗口</div>
</div></section>
<section id="timer-window" class="timer-window" aria-label="独立定时答题窗口">
<header id="timer-header"><div class="timer-mark">✦</div><div class="brand-copy"><span>独立任务窗口</span><strong>定时答题</strong></div><button id="timer-stop-quick" disabled title="停止正在运行的定时任务">停止</button><button id="timer-toggle">收起</button></header>
<div class="current-banner"><small id="timer-summary">未启动 · 先在主窗口选择起始练习</small></div>
<div id="timer-body"><div class="timer-metrics"><div class="timer-stat"><small>已用时</small><strong id="timer-elapsed">00:00</strong></div><div class="timer-stat"><small>距本题计划提交</small><strong id="timer-remaining">—</strong><small id="timer-perturb">扰动未开启</small></div></div><small id="timer-total" hidden>总倒计时：—</small><div class="timer-progress-line"><span id="timer-progress">已完成 0 / 0 道</span><span id="timer-phase">未启动</span></div><div class="card"><div class="card-heading"><strong>当前练习</strong><span class="caption">实际任务位置</span></div><small id="timer-task">尚未开始</small></div><div class="card"><div class="card-heading"><strong>所选练习</strong><span class="caption">与主窗口同步</span></div><small id="timer-start-path"></small></div>
<div class="card"><div id="auto-panel">
<div class="number-grid"><label>总分钟数<input id="auto-minutes" type="number" min="0.1" max="1440" step="0.1" value="5"></label><label><span id="auto-count-label">练习数</span><input id="auto-count" type="number" min="1" max="500" step="1" value="5"></label></div>
<label class="idle-confirm-option"><input id="auto-repeat" type="checkbox">重复答题（包含已做题，整本循环至倒计时结束）</label><small id="auto-repeat-note" hidden>从所选题开始，走到书末后从本书第一题继续。练习数只用于计算间隔；跳转失败或三次都读不到就跳过。闲置提示可提前提交，但重复模式的总时间不缩短。</small>
<label class="idle-confirm-option"><input id="auto-perturb" type="checkbox">随机扰动（每题单独加一段等待）</label><div class="number-grid"><label>扰动上限（秒）<input id="auto-perturb-seconds" type="number" min="1" max="500" step="1" value="100"></label></div><small id="auto-perturb-note">每题在自己的分配时间后，再等 0 到所填秒数。不计入总时间，也不平分。长时间未操作会结束这一题的扰动并提交，下一题重新抽。重复答题同样另加这一段，总倒计时在扰动期间停住。</small>
<select id="auto-scope"><option value="unit">从所选题往后 · 当前单元</option><option value="book">从所选题往后 · 当前教材</option></select>
<small id="auto-preview">5分钟做5道练习，平均1分钟一道。先填，到时间再提交。</small><div class="auto-actions"><button id="auto-start">开始定时任务</button><button id="auto-stop" disabled>停止</button></div>
<small>每题是一整页练习。跳转成功后第1、2、3秒各读一次，读到就填；三次都读不到就下一题。请保持页面打开，电脑不要休眠。</small><pre id="auto-skipped" aria-label="跳转失败记录"></pre></div></div>
<div class="status-card"><div class="status-label">定时任务状态</div><pre id="timer-status" role="status" aria-live="polite">设置分钟数和题数后，点击开始。</pre></div><div class="panel-foot">独立拖动、收起 · 收起不会停止任务</div></div></section>
<section id="log-window" class="log-window" aria-label="实时操作日志窗口"><header id="log-header"><div class="timer-mark">✿</div><div class="brand-copy"><span>本地留存 · 最近120条</span><strong>操作日志</strong></div><button id="log-export" title="将最近120条日志下载为文本">导出</button><button id="log-clear">清空</button><button id="log-close">关闭</button></header><div id="log-body"><pre id="log-list" role="log" aria-live="polite" aria-label="实时操作记录">还没有操作记录。</pre><small>最近120条保存在本机；导出前可查看并清理个人信息。关闭此窗不会停止任务。</small></div></section>`;
  (document.body || document.documentElement).appendChild(host);
  const ui = id => shadow.getElementById(id);
  const ACTIVITY_LOG_KEY = 'ucampus-activity-log/v1';
  function readActivityLog() {
    try {
      const saved = sharedRead(ACTIVITY_LOG_KEY, []);
      if (!Array.isArray(saved)) return [];
      return saved.filter(item => item && typeof item.time === 'string' && /^\d{1,2}:\d{2}:\d{2}$/.test(item.time) && typeof item.message === 'string')
        .slice(-120).map(item => ({ time: item.time, message: item.message.slice(0, 160), at: typeof item.at === 'string' ? item.at : '' }));
    } catch { return []; }
  }
  let activityLog = readActivityLog(), lastActivityMessage = activityLog.at(-1)?.message || '';
  function shortLogMessage(text) {
    const message = String(text || '').trim();
    if (!message) return '';
    let match;
    if (/^第 \d+\/\d+ 道已填写/.test(message)) return '答案已填好，等待提交。';
    if ((match = /^正在打开第 (\d+)\/(\d+)/.exec(message))) return '正在打开第 ' + match[1] + '/' + match[2] + ' 题。';
    if ((match = /^已提交 (\d+)\/(\d+)/.exec(message))) return '提交成功，完成 ' + match[1] + '/' + match[2] + ' 题。';
    if ((match = /^定时任务完成，已确认提交 (\d+)\/(\d+)/.exec(message))) return '任务完成，共提交 ' + match[1] + ' 题。';
    if (/^已跳过跳转失败的练习/.test(message)) return '';
    if (/^正在停止/.test(message)) return '正在停止，等待当前操作结束。';
    if (/^定时任务已停止/.test(message)) return '任务已停止。';
    const lastLine = message.split('\n').filter(Boolean).at(-1) || message;
    if (/等待提交按钮|正在提交/.test(lastLine)) return '正在提交答案。';
    if (/等待确认|已处理第/.test(lastLine)) return '正在确认提交。';
    if (/已提交，页面已显示答题小结/.test(message)) return '当前练习已提交。';
    return message.split('\n')[0].replace(/当前可见目录：.*$/, '请检查课本目录。').slice(0, 160);
  }
  function renderActivityLog() {
    if (ui('log-window').hidden) return;
    const list = ui('log-list');
    const nearBottom = !Number.isFinite(list.scrollHeight) || list.scrollHeight - list.scrollTop - list.clientHeight < 36;
    const text = activityLog.length ? activityLog.map(item => item.time + '  ' + item.message).join('\n') : '还没有操作记录。';
    if (list.textContent !== text) list.textContent = text;
    if (nearBottom && Number.isFinite(list.scrollHeight)) list.scrollTop = list.scrollHeight;
  }
  function appendActivityLog(text) {
    const message = shortLogMessage(text);
    if (!message || message === lastActivityMessage) return;
    lastActivityMessage = message;
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    activityLog.push({ time, message, at: now.toISOString() });
    if (activityLog.length > 120) activityLog.splice(0, activityLog.length - 120);
    try { sharedWrite(ACTIVITY_LOG_KEY, activityLog); } catch { /* 存储不可用时仍显示本页日志 */ }
    renderActivityLog();
  }
  function formatTimerDuration(seconds) {
    const value = Math.max(0, Math.floor(seconds)), minutes = Math.floor(value / 60), rest = String(value % 60).padStart(2, '0');
    return minutes < 60 ? String(minutes).padStart(2, '0') + ':' + rest : String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0') + ':' + rest;
  }
  function updateTimerMetrics() {
    const state = autoState || {}, now = state.finishedAt ?? Date.now();
    const elapsed = Number.isFinite(state.startedAt) ? (now - state.startedAt) / 1000 : 0;
    const phaseNames = { jumping: '正在跳转', settling: '等待页面', filling: '正在填写', waiting: '等待提交', perturbing: '随机扰动', checking: '核对页面', submitting: '正在提交', stopping: '正在停止', completed: '已完成', stopped: '已停止', failed: '异常停止' };
    let remaining = '—';
    if (state.running && Number.isFinite(state.deadline)) remaining = state.phase === 'submitting' ? '提交中' : state.phase === 'checking' ? '核对中' : state.phase === 'stopping' ? '停止中' : Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000)) + ' 秒';
    const fields = {
      'timer-elapsed': formatTimerDuration(elapsed), 'timer-remaining': remaining,
      'timer-progress': state.repeating ? '重复答题 · 已确认提交 ' + (state.completed || 0) + ' 次' : '已完成 ' + (state.completed || 0) + ' / ' + (state.targetCount || 0) + ' 道',
      'timer-phase': phaseNames[state.phase] || '未启动',
      'timer-task': state.currentTask ? state.currentTask.path.join(' / ') : ui('timer-start-path').textContent || '先在主窗口选择起始练习',
      'timer-perturb': perturbCaption(state)
    };
    ui('timer-total').hidden = !state.repeating;
    if (state.repeating) {
      const credit = state.repeatCreditMs || 0;
      const remainingMs = state.phase === 'perturbing' && Number.isFinite(state.repeatFrozenMs) ? state.repeatFrozenMs : state.endsAt + credit - now;
      ui('timer-total').textContent = '总倒计时：' + formatTimerDuration(Math.ceil(Math.max(0, remainingMs) / 1000));
    }
    for (const [id, text] of Object.entries(fields)) if (ui(id).textContent !== text) ui(id).textContent = text;
  }
  function perturbCaption(state) {
    if (!ui('auto-perturb').checked) return '扰动未开启';
    if (Number.isFinite(state.perturbMs)) return '本题扰动 ' + Math.round(state.perturbMs / 1000) + ' 秒';
    const max = Number(ui('auto-perturb-seconds').value) || 0;
    return '扰动 0–' + max + ' 秒';
  }
  function timerStatus(text) {
    if (ui('timer-status').textContent !== text) ui('timer-status').textContent = text;
    ui('timer-status').setAttribute('data-state', /失败|未完成|超过|不够/.test(text) ? 'error' : /完成|已提交/.test(text) ? 'success' : 'info');
    const summary = String(text).split('\n')[0];
    if (ui('timer-summary').textContent !== summary) ui('timer-summary').textContent = summary;
  }
  const status = text => {
    ui('status').textContent = text;
    appendActivityLog(text);
    if (autoState?.running) timerStatus(text);
    ui('status').setAttribute('data-state', /失败|未完成|找不到|未找到|卡在|超过|无法|不够/.test(text) ? 'error' : /完成|已提交|已导入|已合并/.test(text) ? 'success' : 'info');
  };
  const SUBMIT_PROTECTION_KEY = 'ucampus-submit-protection-until/v1';
  const SUBMIT_PROTECTION_REASON = '提交单个题相隔时间过短，已触发保护';
  const submitProtection = createSubmitProtection(Number(sharedRead(SUBMIT_PROTECTION_KEY, 0)));
  let visibleRateNotices = new Set();
  const protectedDocuments = new WeakSet();
  function protectionActive() {
    const saved = Number(sharedRead(SUBMIT_PROTECTION_KEY, 0));
    if (Number.isFinite(saved)) submitProtection.until = Math.max(submitProtection.until, saved);
    return submitProtection.active(Date.now());
  }
  function stopForSubmitProtection() {
    if (!autoState?.running || autoState.stopReason === SUBMIT_PROTECTION_REASON) return;
    autoState.cancelled = true; autoState.stopReason = SUBMIT_PROTECTION_REASON;
    autoState.phase = 'stopping'; updateTimerMetrics();
    timerStatus(SUBMIT_PROTECTION_REASON + '。定时答题已停止，8分钟后也不会自动继续。');
    status(SUBMIT_PROTECTION_REASON + '。定时答题已停止。');
  }
  function refreshProtectionWindow(notice) {
    const panel = ui('submit-protection'), active = protectionActive();
    panel.hidden = !active;
    if (!active) return;
    stopForSubmitProtection();
    ui('submit-protection-clock').textContent = formatTimerDuration(submitProtection.seconds(Date.now()));
    const box = notice?.closest?.('.ant-modal, [role="dialog"], .system-info-modal')?.getBoundingClientRect();
    const width = Math.min(240, window.innerWidth - 24), height = panel.offsetHeight || 160;
    let left = box ? box.right + 12 : window.innerWidth - width - 16;
    if (left + width > window.innerWidth - 12) left = box ? box.left - width - 12 : left;
    panel.style.left = Math.max(12, Math.min(left, window.innerWidth - width - 12)) + 'px';
    panel.style.top = Math.max(12, Math.min(box?.top || 80, window.innerHeight - height - 12)) + 'px';
  }
  function beginSubmitProtection(notice) {
    submitProtection.trigger(Date.now());
    try { sharedWrite(SUBMIT_PROTECTION_KEY, submitProtection.until); } catch { /* 本页仍执行保护 */ }
    stopForSubmitProtection();
    appendActivityLog('识别到网页频繁操作提示，提交保护重新计时8分钟。');
    refreshProtectionWindow(notice);
  }
  function scanRateNotices() {
    const current = new Set();
    for (const doc of pageDocuments()) {
      installSubmissionGuard(doc);
      for (const notice of doc.querySelectorAll('.ant-modal-confirm-content, .system-info-modal, [role="dialog"]')) {
        if (!visible(notice)) continue;
        const leaves = [notice, ...notice.querySelectorAll('span, p')];
        if (!leaves.some(node => isRateLimitNotice(node.textContent || ''))) continue;
        // 一个提示按最里层内容节点计；同一弹窗常驻不反复重置倒计时。
        if (notice.querySelector('.ant-modal-confirm-content')) continue;
        current.add(notice);
        if (!visibleRateNotices.has(notice)) beginSubmitProtection(notice);
      }
    }
    visibleRateNotices = current;
    return current.values().next().value;
  }
  function assertSubmissionAllowed() {
    scanRateNotices();
    if (!protectionActive()) return;
    refreshProtectionWindow();
    throw new Error('提交过于快了，休息会再提交。剩余 ' + formatTimerDuration(submitProtection.seconds(Date.now())));
  }
  function submissionClick(event) {
    const path = event.composedPath?.() || [event.target];
    const ownControl = path.some(node => ['submit-top', 'submit-course', 'submit-only', 'auto-start'].includes(node?.id));
    const ownUI = path.includes(host);
    const nativeControl = !ownUI && path.some(node => {
      if (!node?.getAttribute) return false;
      const text = compactLabel(node.innerText || node.textContent || node.value || node.getAttribute('aria-label') || '');
      if (/^(提交|确认提交|确定提交)$/.test(text) || node.type === 'submit') return true;
      if (!/^(确定|确认|继续)$/.test(text)) return false;
      const dialog = node.closest('.ant-modal, [role="dialog"], .system-info-modal');
      return dialog && /提交/.test(dialog.textContent || '');
    });
    if (!ownControl && !nativeControl && event.type !== 'submit') return;
    scanRateNotices();
    if (!protectionActive()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    refreshProtectionWindow();
    const message = '提交过于快了，休息会再提交。剩余 ' + formatTimerDuration(submitProtection.seconds(Date.now()));
    status(message);
    if (event.isTrusted) window.alert(message);
  }
  function installSubmissionGuard(doc) {
    if (protectedDocuments.has(doc)) return;
    protectedDocuments.add(doc);
    doc.addEventListener('click', submissionClick, true);
    doc.addEventListener('submit', submissionClick, true);
    // 在填题中触发保护后，阻止该任务后续的程序点击；用户仍可浏览页面。
    doc.addEventListener('click', event => {
      if (!event.isTrusted && autoState?.running && autoState.stopReason === SUBMIT_PROTECTION_REASON && !event.composedPath?.().includes(host)) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, true);
  }
  const IDLE_CONFIRM_KEY = 'ucampus-idle-confirm-enabled/v1';
  const idleConfirmInput = ui('auto-idle-confirm');
  idleConfirmInput.checked = sharedRead(IDLE_CONFIRM_KEY, false) === true;
  idleConfirmInput.onchange = () => {
    try { sharedWrite(IDLE_CONFIRM_KEY, idleConfirmInput.checked); }
    catch (error) { idleConfirmInput.checked = !idleConfirmInput.checked; status('自动确认设置未保存：' + error.message); }
  };
  const confirmedIdleButtons = new WeakSet();
  const IDLE_SENTENCE = '由于你长时间未操作，请点确定继续使用。';
  function idleDocs() {
    const docs = [], seen = new Set();
    const add = doc => {
      if (!doc || seen.has(doc)) return;
      seen.add(doc);
      docs.push(doc);
      let frames = [];
      try { frames = [...doc.querySelectorAll('iframe,frame')]; } catch { return; }
      for (const frame of frames) {
        try { if (frame.contentDocument) add(frame.contentDocument); } catch { /* 跨域框架读不到 */ }
      }
    };
    add(document);
    let win = window;
    for (let depth = 0; depth < 6 && win.parent && win.parent !== win; depth += 1) {
      win = win.parent;
      try { add(win.document); } catch { break; }
    }
    return docs;
  }
  function idleRoots(doc) {
    const roots = [];
    const visit = root => {
      if (!root || roots.includes(root)) return;
      roots.push(root);
      let nodes = [];
      try { nodes = root.querySelectorAll('*'); } catch { return; }
      for (const element of nodes) if (element.shadowRoot) visit(element.shadowRoot);
    };
    try { visit(doc); } catch { /* 这一层读不到 */ }
    return roots;
  }
  function nextIdleBox(box) {
    if (!box) return null;
    if (box.parentElement) return box.parentElement;
    const root = box.getRootNode?.();
    return root && root.host && root.host !== box ? root.host : null;
  }
  function isOwnIdleNode(node) {
    if (!host || !node) return false;
    if (node === host || host.contains?.(node)) return true;
    const root = node.getRootNode?.();
    return !!(root && (root === host.shadowRoot || root.host === host));
  }
  function idleSentenceNear(button) {
    const doc = button.ownerDocument;
    let box = button;
    for (let depth = 0; box && depth < 8 && box !== doc?.body && box !== doc?.documentElement; depth += 1, box = nextIdleBox(box)) {
      let text = '';
      try { text = normalize(box.textContent); } catch { continue; }
      if (text.includes(IDLE_SENTENCE)) return true;
    }
    return false;
  }
  function idleButtons(doc) {
    const found = [];
    const add = button => { if (button && !isOwnIdleNode(button) && !found.includes(button)) found.push(button); };
    for (const root of idleRoots(doc)) {
      if (isOwnIdleNode(root) || isOwnIdleNode(root.host)) continue;
      let marked = [];
      try { marked = [...root.querySelectorAll('[id^="mask_notice_id_"]')]; } catch { marked = []; }
      for (const button of marked) {
        if (/^mask_notice_id_\d{13}$/.test(button.id || '') && normalize(button.textContent) === '确定') add(button);
      }
      let walker;
      try { walker = doc.createTreeWalker(root.nodeType === 9 ? (root.body || root) : root, NodeFilter.SHOW_TEXT); } catch { continue; }
      let node;
      while ((node = walker.nextNode())) {
        if (isOwnIdleNode(node) || !normalize(node.textContent).includes('长时间未操作')) continue;
        let box = node.parentElement;
        for (let depth = 0; box && depth < 8 && box !== doc.body && box !== doc.documentElement; depth += 1, box = nextIdleBox(box)) {
          let controls = [];
          try { controls = [...box.querySelectorAll('button,a,div,span,[role="button"]')]; } catch { continue; }
          const button = controls.find(item => !isOwnIdleNode(item) && normalize(item.textContent) === '确定');
          if (button) { add(button); break; }
        }
      }
    }
    return found;
  }
  function confirmIdleNotice() {
    if (!idleConfirmInput.checked && !autoState?.running) return;
    if (protectionActive()) return;
    let docs = [document];
    try { docs = idleDocs(); } catch { /* 只查当前页 */ }
    for (const doc of docs) {
      let buttons = [];
      try { buttons = idleButtons(doc); } catch { continue; }
      for (const button of buttons) {
        if (confirmedIdleButtons.has(button) || button.disabled || !idleSentenceNear(button)) continue;
        confirmedIdleButtons.add(button);
        try { button.click(); } catch { confirmedIdleButtons.delete(button); continue; }
        const now = new Date();
        appendActivityLog('已自动确认网页的长时间未操作提示 ' + now.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0'));
        if (autoState?.running && !autoState.cancelled && autoState.currentTask && ['jumping', 'filling', 'waiting', 'perturbing'].includes(autoState.phase)) {
          autoState.idleSubmitTaskKey = taskKey(autoState.currentTask.path, autoState.currentTask.book);
          appendActivityLog(autoState.phase === 'perturbing' ? '定时任务在随机扰动期间收到闲置提示，结束这一题的扰动并提交；下一题重新抽。' : '定时任务收到闲置提示，当前题填写并核对后提前提交；没用完的分配时间退回后续题目。');
        }
      }
    }
  }
  if (typeof MutationObserver === 'function') {
    let idleScanTimer;
    const scheduleIdleScan = () => {
      if (idleScanTimer) return;
      idleScanTimer = setTimeout(() => { idleScanTimer = null; try { scanRateNotices(); } catch { /* 不影响闲置检测 */ } confirmIdleNotice(); }, 150);
    };
    new MutationObserver(scheduleIdleScan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    idleConfirmInput.addEventListener('change', scheduleIdleScan);
  }
  // 等界面及定时状态初始化后扫描，避免初始化期间读取未建立的状态。
  setTimeout(() => { try { refreshProtectionWindow(scanRateNotices()); } catch { /* 频繁提示失败不影响闲置检测 */ } confirmIdleNotice(); }, 0);
  setInterval(() => { try { refreshProtectionWindow(scanRateNotices()); } catch { /* 频繁提示失败不影响闲置检测 */ } confirmIdleNotice(); }, 500);
  const ROUTE_KEY = 'ucampus-learned-routes/v1';
  let taskTreeSignature = '';
  let lastTreeFocus = '';
  const taskTreeNodes = new Map();
  let captured = null;
  let checkedText = null;
  let busy = false;
  var autoState = { running: false, cancelled: false };
  function repeatTimeUp(now = Date.now()) {
    return !!(autoState?.repeating && now >= (autoState.endsAt || 0) + (autoState.repeatCreditMs || 0));
  }
  let jumpCheckState = { running: false, cancelled: false };
  let shelfScanAt = 0;
  function visible(element) {
    const style = getComputedStyle(element);
    return element.isConnected && element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }
  function selector(element) {
    const parts = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const tag = node.localName;
      const siblings = node.parentElement ? [...node.parentElement.children].filter(item => item.localName === tag) : [node];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
      if (node === document.documentElement) break;
    }
    return parts.join(' > ');
  }
  function label(element) {
    return normalize([...element.labels || []].map(item => item.innerText).join(' ') || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') || '');
  }
  function context(element) {
    const parent = element.closest('fieldset,[role="group"],[role="radiogroup"],[data-question-id],.question,.question-item,.question-container') || element.parentElement;
    return normalize(parent?.innerText).slice(0, 2400);
  }
  function scan() {
    const questions = [];
    const groups = new Map();
    const controls = [...document.querySelectorAll('input,textarea,select')].filter(element => {
      if (!visible(element) || element.disabled || element.readOnly) return false;
      return element.localName !== 'input' || ['text', 'search', 'radio', 'checkbox'].includes(element.type);
    });
    for (const element of controls) {
      const type = element.type;
      if (type === 'radio' || type === 'checkbox') {
        const key = element.name ? `${type}|${element.form ? selector(element.form) : 'document'}|${element.name}` : selector(element);
        let question = groups.get(key);
        if (!question) {
          question = { kind: type, context: context(element), options: [] };
          groups.set(key, question);
          questions.push(question);
        }
        question.options.push({ index: question.options.length, text: label(element) || normalize(element.parentElement?.innerText) || `选项 ${question.options.length + 1}`, selector: selector(element), disabled: false });
      } else if (element.localName === 'select') {
        // 多选 select 需要单独适配，避免当作单选填写。
        if (element.multiple) continue;
        questions.push({ kind: 'select', selector: selector(element), label: label(element), context: context(element), options: [...element.options].map((option, index) => ({ index, text: normalize(option.textContent), disabled: option.disabled || !!option.closest('optgroup[disabled]') })) });
      } else {
        questions.push({ kind: 'text', selector: selector(element), label: label(element), context: context(element), maxLength: element.maxLength });
      }
    }
    questions.forEach((question, index) => { question.id = `q${String(index + 1).padStart(3, '0')}`; });
    const customControls = [...document.querySelectorAll('[role="radio"],[role="checkbox"],[role="combobox"],[contenteditable="true"],select[multiple]')]
      .filter(visible).filter(element => !['input', 'select'].includes(element.localName) || element.multiple)
      .map(element => ({ tag: element.localName, role: element.getAttribute('role'), text: normalize(element.innerText).slice(0, 500), selector: selector(element) }));
    const pageKey = location.origin + location.pathname + location.hash.split('?')[0];
    const buttons = [...document.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(visible)
      .map(element => ({ text: normalize(element.innerText || element.value || element.getAttribute('aria-label')), selector: selector(element), disabled: !!element.disabled })).filter(button => button.text);
    const frames = [...document.querySelectorAll('iframe')].map(element => {
      try { const url = new URL(element.src, location.href); return { origin: url.origin, path: url.pathname, sameOrigin: url.origin === location.origin }; }
      catch { return { origin: 'unknown' }; }
    });
    const result = { schema: 'ucampus-page/v1', pageKey, title: document.title, questions, customControls, buttons, frames };
    result.fingerprint = fingerprint({ pageKey, questions, customControls });
    return result;
  }
  function invalidate() { checkedText = null; ui('fill').disabled = true; }
  function capture() {
    captured = scan();
    invalidate();
    status(`采集到 ${captured.questions.length} 组标准控件、${captured.customControls.length} 个待适配自定义控件。\n请检查“导出页面资料”中的内容是否属于当前练习。${captured.frames.length ? '\n存在内嵌页面；外层面板无法采集跨域框架内题目，请在题目框架内使用面板。' : ''}`);
    return captured;
  }
  function download(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const run = (fn, options = {}) => async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (error) {
      invalidate();
      const message = error.message || String(error);
      status(message);
      if (options.alertOnError) {
        const title = options.actionName || '操作';
        const hint = options.errorHint || '请先查看网页和面板提示，确认当前状态。如果网页答案已填好或已手动改好，可用“仅提交”，不会重新填写。';
        try { window.alert(title + '未完成\n\n' + message + '\n\n' + hint); } catch { /* 页面禁止弹窗时仍保留面板提示 */ }
      }
    }
    finally { busy = false; }
  };
  function getPlan() {
    if (!captured) throw new Error('请先采集当前练习。');
    const fresh = scan();
    if (fresh.fingerprint !== captured.fingerprint) throw new Error('页面内容已变化，请重新采集并匹配答案。');
    return validateAnswers(JSON.parse(ui('answers').value), fresh);
  }
  function activeLabels() {
    return [...document.querySelectorAll('.pc-menu-activity, .pc-header-task-activity, .pc-header-tab-activity, [class*="active"], [aria-selected="true"], [aria-current="true"]')]
      .filter(element => visible(element) && !element.closest('#ucampus-transfer-host'))
      .map(element => normalize(element.innerText || ''))
      .filter(text => text && text.length <= 80);
  }
  function selectedTask() {
    const task = COURSE_TASKS[Number(ui('task').value)];
    if (!task || ui('task').value === '') throw new Error('先读取首页书架，再选择要填的练习。');
    if (!ownedBooks().includes(taskBook(task))) throw new Error('当前账号的首页书架尚未读到这本教材，请先在首页读取书架。');
    if (taskBook(task) !== activeBook()) throw new Error('所选练习属于“' + taskBook(task) + '”，请先从首页打开这本教材。');
    return task;
  }
  function findExactControl(label) {
    const want = compactLabel(label);
    const nodes = [...document.querySelectorAll('body *')].filter(element => {
      if (!visible(element) || element.closest('#ucampus-transfer-host')) return false;
      if (compactLabel(element.innerText || '') !== want) return false;
      return ![...element.children].some(child => compactLabel(child.innerText || '') === want);
    });
    nodes.sort((a, b) => {
      const left = a.getBoundingClientRect();
      const right = b.getBoundingClientRect();
      return left.width * left.height - right.width * right.height;
    });
    return nodes[0] || null;
  }
  function blankInputs() {
    return [...document.querySelectorAll('input, textarea')].filter(element => {
      if (!visible(element) || element.disabled || element.readOnly || element.closest('#ucampus-transfer-host')) return false;
      return element.localName === 'textarea' || ['text', 'search', ''].includes(element.type);
    });
  }
  function setNativeValue(element, value) {
    const prototype = element.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function optionLetter(option) {
    const judgment = option.querySelector('.uls-judgment__option-badge');
    if (judgment) {
      const badge = compactLabel(judgment.textContent);
      if (badge === 'T') return 'A';
      if (badge === 'F') return 'B';
    }
    const badge = option.querySelector('.uls-sc__option-badge');
    const raw = compactLabel(badge ? badge.textContent : '');
    if (/^[A-Z]$/.test(raw)) return raw;
    const caption = option.querySelector(':scope > .caption');
    const letter = compactLabel(caption ? caption.textContent : '');
    if (/^[A-Z]$/.test(letter)) return letter;
    const match = normalize(option.innerText).match(/^([A-Z])(?:\b|[.．、])/);
    return match ? match[1] : '';
  }
  function isChosen(option) {
    return option.classList.contains('uls-sc__option--selected')
      || option.classList.contains('selected')
      || option.getAttribute('aria-checked') === 'true'
      || option.getAttribute('aria-pressed') === 'true';
  }
  function pageDocuments() {
    const docs = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch { /* 跨域框架读不到 */ }
    }
    return docs;
  }
  function choiceGroups() {
    const groups = [];
    for (const doc of pageDocuments()) {
      const cards = new Map();
      for (const option of [...doc.querySelectorAll('.uls-sc__option')].filter(visible)) {
        const card = option.closest('.uls-sc__options-card, .uls-sc__question') || option.parentElement;
        if (!cards.has(card)) cards.set(card, []);
        cards.get(card).push(option);
      }
      groups.push(...cards.values());
      for (const wrap of doc.querySelectorAll('.question-common-abs-choice .option-wrap, .question-common-abs-banked-cloze .option-wrap')) {
        const options = [...wrap.children].filter(element => element.classList.contains('option') && visible(element));
        if (options.length) groups.push(options);
      }
    }
    return groups;
  }
  function sequenceLetters(root) {
    return [...root.querySelectorAll('.sequence-reply-view-item-text')].filter(visible).map(optionLetter);
  }
  function sortingController(root, letters) {
    // 限定为当前排序控件的祖先组件，只使用其正常拖动回调和已显示的选项。
    for (let element = root, depth = 0; element && depth < 5; element = element.parentElement, depth++) {
      const key = Object.keys(element).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
      for (let fiber = key && element[key], count = 0; fiber && count < 60; fiber = fiber.return, count++) {
        const instance = fiber.stateNode;
        if (!instance || typeof instance.onSortEnd !== 'function' || !Array.isArray(instance.state?.options)) continue;
        const names = instance.state.options.map(option => compactLabel(option.name));
        if (names.length === letters.length && names.every((name, index) => name === letters[index])) return instance;
      }
    }
    return null;
  }
  function planSequenceMoves(current, target) {
    if (!Array.isArray(target) || current.length !== target.length || !current.length) throw new Error('排序卡片数与答案数不符，未移动。');
    if (current.some(letter => !/^[A-Z]$/.test(letter)) || new Set(current).size !== current.length || new Set(target).size !== target.length || target.some(letter => !current.includes(letter))) throw new Error('排序答案与页面字母不是一一对应，未移动。');
    const order = current.slice(), moves = [];
    target.forEach((letter, newIndex) => {
      const oldIndex = order.indexOf(letter);
      if (oldIndex === newIndex) return;
      order.splice(newIndex, 0, order.splice(oldIndex, 1)[0]);
      moves.push({ oldIndex, newIndex, order: order.slice() });
    });
    return moves;
  }
  async function fillSequenceTask(task) {
    const roots = pageDocuments().flatMap(doc => [...doc.querySelectorAll('.sequence-view')].filter(visible));
    if (!roots.length) return null;
    if (roots.length !== 1 || task.kind !== 'choice') throw new Error('排序控件或答案类型不唯一，未填写。');
    const root = roots[0];
    if (root.querySelector('.sortable-list-wrapper-review')) throw new Error('此排序题已在答题小结中，不能修改。');
    const current = sequenceLetters(root);
    const moves = planSequenceMoves(current, task.answers);
    const controller = sortingController(root, current);
    if (!controller || controller.props?.isReview) throw new Error('没有找到可编辑的排序控制器，未移动；请提供页面资料。');
    // 即使默认顺序已正确，也触发一次正常排序回调，确保空答案被写入。
    const actions = moves.length ? moves : [{ oldIndex: 0, newIndex: 0, order: current }];
    for (const move of actions) {
      if (!root.isConnected || controller.props?.isReview) throw new Error('排序页面已变化，停止填写。');
      controller.onSortEnd({ oldIndex: move.oldIndex, newIndex: move.newIndex });
      const kept = await waitFor(() => {
        const shown = sequenceLetters(root);
        const state = controller.state.options.map(option => compactLabel(option.name));
        return shown.join('/') === move.order.join('/') && state.join('/') === move.order.join('/');
      });
      if (!kept) throw new Error('排序结果没有保留，未提交。');
    }
    if (sequenceLetters(root).join('/') !== task.answers.join('/')) throw new Error('排序最终读回不符，未提交。');
    return '已按给定答案排序并核对：' + task.answers.join(' → ') + '。';
  }
  async function fillScoopDropdownTask(task) {
    const docs = pageDocuments();
    const wrappers = () => docs.flatMap(doc => [...doc.querySelectorAll('.scoop-select-wrapper')].filter(visible));
    if (!wrappers().length) return null;
    if (wrappers().length !== task.answers.length) throw new Error('页面下拉空数与答案数量不符，未填写。');
    const expected = [];
    for (let index = 0; index < task.answers.length; index++) {
      const wrapper = wrappers()[index];
      const trigger = wrapper.querySelector('.user-answer');
      if (!trigger || trigger.classList.contains('answer-right') || trigger.classList.contains('answer-wrong')) throw new Error('此下拉题不可编辑，可能已经提交。');
      trigger.click();
      const options = await waitFor(() => {
        const items = [...wrapper.querySelectorAll('.scoop-select .select-option')].filter(visible);
        return items.length ? items : null;
      });
      if (!options) throw new Error('点击下拉框后没有出现候选项；未提交。');
      const answer = task.answers[index];
      const matches = options.filter(option => task.kind === 'choice'
        ? optionLetter(option) === answer
        : normalize(option.textContent) === normalize(answer));
      if (matches.length !== 1) throw new Error('第 ' + (index + 1) + ' 空找不到唯一选项 ' + answer + '，未提交；请截展开的下拉选项。');
      const option = matches[0];
      if (option.disabled || option.getAttribute('aria-disabled') === 'true' || option.classList.contains('ant-menu-item-disabled')) throw new Error('目标下拉选项不可编辑，未提交。');
      expected.push(normalize(option.textContent));
      option.click();
      const kept = await waitFor(() => {
        const current = wrappers()[index]?.querySelector('.user-answer-text');
        return current && normalize(current.textContent) === expected[index];
      });
      if (!kept) throw new Error('第 ' + (index + 1) + ' 个下拉答案没有保留，未提交。');
    }
    if (!wrappers().every((wrapper, index) => normalize(wrapper.querySelector('.user-answer-text')?.textContent) === expected[index])) throw new Error('下拉答案最终读回不符，未提交。');
    return '已填写并核对 ' + expected.length + ' 个下拉答案：' + task.answers.join('、') + '。';
  }
  async function fillDropdownTask(task) {
    const docs = pageDocuments();
    const find = () => docs.flatMap(doc => [...doc.querySelectorAll('.uls-ds__select-trigger')].filter(visible));
    const triggers = find();
    if (!triggers.length) return null;
    if (triggers.length !== task.answers.length) throw new Error('下拉题空数与答案数量不符，已停止。');
    const expected = [];
    for (let index = 0; index < triggers.length; index++) {
      const trigger = find()[index];
      if (trigger.disabled) throw new Error('下拉框不可编辑，可能已经提交。');
      const shared = !!trigger.closest('.is-shared');
      const answer = task.answers[index];
      trigger.click();
      const readOptions = () => docs.flatMap(doc => [...doc.querySelectorAll('.uls-ds__menu-item, .uls-ds__mobile-menu-item')].filter(visible));
      const options = await waitFor(() => { const items = readOptions(); return items.length ? items : null; });
      if (!options) throw new Error('点击下拉框后没有出现候选项。');
      const matches = options.filter(option => {
        const label = option.querySelector('.uls-ds__mobile-menu-label');
        const text = option.querySelector('.uls-ds__mobile-menu-text');
        return task.kind === 'choice'
          ? (shared ? compactLabel(label ? label.textContent : option.textContent) === answer : optionLetter(option) === answer)
          : normalize(text ? text.textContent : option.textContent) === normalize(answer);
      });
      if (matches.length !== 1 || matches[0].disabled) throw new Error('下拉选项未唯一对上或已被占用：' + answer);
      expected.push(shared ? answer : normalize((matches[0].querySelector('.uls-ds__mobile-menu-text') || matches[0]).textContent));
      matches[0].click();
      const kept = await waitFor(() => {
        const current = find()[index];
        return current && normalize(current.textContent) === expected[index] && current.getAttribute('aria-expanded') !== 'true';
      });
      if (!kept) throw new Error('第 ' + (index + 1) + ' 个下拉答案没有保留，未提交。');
    }
    if (!find().every((trigger, i) => normalize(trigger.textContent) === expected[i])) throw new Error('下拉答案读回不一致，未提交。');
    return '已填写并核对 ' + expected.length + ' 个下拉答案。';
  }
  async function fillWordBankTask(task) {
    const roots = pageDocuments().flatMap(doc => [...doc.querySelectorAll('.uls-bc')].filter(visible));
    if (!roots.length) return null;
    if (roots.length !== 1) throw new Error('页面有多个词库，未填写。');
    const root = roots[0];
    const blanks = () => [...root.querySelectorAll('.uls-bc__blank')].filter(visible);
    const options = () => [...root.querySelectorAll('.uls-bc__option')].filter(visible);
    if (blanks().length !== task.answers.length) throw new Error('词库空数与答案数量不符，已停止。');
    // 只按页面明确显示的字母或完整文字匹配，不把无字母的候选词顺序猜成 A/B。
    const expected = task.answers.map(answer => {
      const hits = options().filter(option => task.kind === 'choice' ? optionLetter(option) === answer : normalize(option.textContent) === normalize(answer));
      if (hits.length !== 1) throw new Error('词库没有唯一匹配 ' + answer + '；请提供该题页面截图。');
      return normalize(hits[0].textContent);
    });
    if (new Set(expected).size !== expected.length) throw new Error('此词库不允许重复使用同一选项，已停止。');
    if (blanks().some(blank => blank.disabled)) throw new Error('词库不可编辑，可能已提交。');
    // 已有答案先清空，避免旧选项占用后续目标。
    for (let i = 0; i < expected.length; i++) {
      if (!blanks()[i].classList.contains('has-value')) continue;
      const clear = blanks()[i].closest('.uls-bc__blank-wrap')?.querySelector('.uls-bc__blank-clear');
      if (!clear) throw new Error('找不到清空按钮，未继续填写。');
      clear.click();
      if (!await waitFor(() => !blanks()[i].classList.contains('has-value'))) throw new Error('旧词库答案未清空。');
    }
    for (let i = 0; i < expected.length; i++) {
      const blank = blanks()[i];
      blank.click();
      if (!await waitFor(() => blanks()[i].getAttribute('aria-pressed') === 'true')) throw new Error('词库空格未激活。');
      const option = options().find(item => normalize(item.textContent) === expected[i]);
      if (!option || option.disabled) throw new Error('词库选项不可用：' + expected[i]);
      option.click();
      if (!await waitFor(() => normalize(blanks()[i].textContent) === expected[i])) throw new Error('词库答案未保留，未提交。');
    }
    if (!blanks().every((blank, i) => normalize(blank.textContent) === expected[i])) throw new Error('词库答案读回不一致，未提交。');
    return '已填写并核对 ' + expected.length + ' 个词库答案。';
  }
  function correctionApplied(row, pair) {
    const base = '.mistake-atom.' + pair.action;
    if (pair.action === 'mark-correct') return !!row.querySelector(base);
    const changed = [...row.querySelectorAll(base + ':not(.target) .mistake-atom-text')];
    const expected = pair.action === 'delete' ? pair.from : pair.to;
    return changed.length === 1 && normalize(changed[0].textContent) === normalize(expected);
  }
  async function fillCorrectionTask(task) {
    const docs = pageDocuments();
    const roots = docs.flatMap(doc => [...doc.querySelectorAll('.question-revise-mistake')].filter(visible));
    if (!roots.length) return null;
    if (roots.length !== 1) throw new Error('当前页有多组改错题，未填写。');
    const pairs = correctionDetails(task);
    if (!pairs.length) throw new Error('这道改错题缺少原词及操作说明，不能只凭改后的词猜位置。');
    const root = roots[0], rows = () => [...root.querySelectorAll('.comp-revise-mistake-reply')].filter(visible);
    await waitFor(() => rows().length === pairs.length);
    if (rows().length !== pairs.length) throw new Error('改错句数与答案数不符，未填写。');
    const plan = pairs.map((pair, index) => {
      const row = rows()[index];
      if (row.querySelector('.mistake-item.nobg')) throw new Error('当前改错题已在小结中，不能修改。');
      if (correctionApplied(row, pair)) return { pair, index, skip: true };
      if (row.querySelector('.mistake-atom.target')) throw new Error('第 ' + (index + 1) + ' 句已有其他修改，请先撤销后再填。');
      const words = [...row.querySelectorAll('.mistake-atom.word .mistake-atom-text')].filter(visible);
      const matches = pair.action === 'mark-correct' ? words.slice(0, 1) : words.filter(word => normalize(word.textContent) === normalize(pair.from));
      if (matches.length !== 1) throw new Error('第 ' + (index + 1) + ' 句找不到唯一原词 ' + pair.from + '，未修改。');
      return { pair, index, word: matches[0] };
    });
    for (const item of plan) {
      if (item.skip) continue;
      const { pair, index, word } = item;
      if (!word.closest('.operating')) word.click();
      const popup = await waitFor(() => {
        const all = docs.flatMap(doc => [...doc.querySelectorAll('.popover-mistake-atom')].filter(visible));
        return all.length === 1 ? all[0] : null;
      });
      if (!popup) throw new Error('没有出现唯一的改错操作框，未提交。');
      const aliases = { change: ['change', '修改', '替换'], 'add-before': ['add-before', '在前添加', '添加'], delete: ['delete', '删除'], 'mark-correct': ['mark-correct', '标记正确', '标记为正确'] };
      const actions = [...popup.querySelectorAll('.mistake-item-action')].filter(element => visible(element) && aliases[pair.action].includes(normalize(element.textContent).toLowerCase()));
      if (actions.length !== 1) throw new Error('找不到唯一的 ' + pair.action + ' 操作，未提交。');
      actions[0].click();
      if (pair.action === 'change' || pair.action === 'add-before') {
        const input = await waitFor(() => [...popup.querySelectorAll('input.edit-form-input')].find(visible));
        if (!input || input.disabled || input.readOnly) throw new Error('没有出现可编辑的修改框。');
        setNativeValue(input, pair.to);
        const confirm = await waitFor(() => [...popup.querySelectorAll('.button-mistake-submit')].find(button => visible(button) && !button.disabled && !button.classList.contains('ant-btn-loading') && input.value === pair.to));
        if (!confirm) throw new Error('改词确认按钮未就绪，未提交。');
        confirm.click();
      }
      if (!await waitFor(() => correctionApplied(rows()[index], pair))) throw new Error('第 ' + (index + 1) + ' 句修改结果没有保留，未提交。');
    }
    if (!pairs.every((pair, index) => correctionApplied(rows()[index], pair))) throw new Error('改错结果最终核对不符，未提交。');
    return '已按标注完成并核对 ' + pairs.length + ' 处改错。';
  }
  async function fillCourseTask(task) {
    if (!Array.isArray(task.answers) || !task.answers.length) throw new Error('这道题没有答案，已停止。');
    const correction = await fillCorrectionTask(task);
    if (correction) return correction;
    const sequence = await fillSequenceTask(task);
    if (sequence) return sequence;
    const scoop = await fillScoopDropdownTask(task);
    if (scoop) return scoop;
    const dropdown = await fillDropdownTask(task);
    if (dropdown) return dropdown;
    const bank = await fillWordBankTask(task);
    if (bank) return bank;
    if (task.kind === 'fill') {
      const inputs = blankInputs();
      if (inputs.length !== task.answers.length) throw new Error(`页面有 ${inputs.length} 个空，答案有 ${task.answers.length} 个，已停止。`);
      inputs.forEach((input, index) => setNativeValue(input, task.answers[index]));
      if (!inputs.every((input, index) => input.value === task.answers[index])) throw new Error('填空没有保留下来，已停止。');
      return `已填写 ${inputs.length} 个空。`;
    }
    if (task.kind !== 'choice') throw new Error('这道题的题型还没适配。');
    const groups = choiceGroups();
    if (!groups.length) throw new Error('当前页没有找到选项。');
    let plan;
    if (groups.length === task.answers.length) plan = groups.map((group, index) => ({ group, letters: [...task.answers[index]] }));
    else if (groups.length === 1) plan = [{ group: groups[0], letters: task.answers.flatMap(answer => [...answer]) }];
    else throw new Error(`页面有 ${groups.length} 组选项，答案有 ${task.answers.length} 个，对不上，已停止。`);
    for (const item of plan) {
      for (const letter of item.letters) {
        const matches = item.group.filter(option => optionLetter(option) === letter);
        if (matches.length !== 1 || matches[0].disabled) throw new Error('选项 ' + letter + ' 没有唯一对上或不可编辑。');
      }
    }
    for (const item of plan) {
      for (const option of item.group) {
        const wanted = item.letters.includes(optionLetter(option));
        const multi = !!option.closest('.multipleChoice') || option.getAttribute('role') === 'checkbox';
        if ((wanted && !isChosen(option)) || (!wanted && isChosen(option) && multi)) option.click();
      }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    for (const item of plan) {
      for (const letter of item.letters) {
        const option = item.group.find(entry => optionLetter(entry) === letter);
        if (!option || !isChosen(option)) throw new Error(`选项 ${letter} 点了但没有选中，已停止，没有提交。`);
      }
    }
    for (const item of plan) {
      if (item.group.some(option => isChosen(option) !== item.letters.includes(optionLetter(option)))) throw new Error('选项与答案不一致，未提交。');
    }
    return `已选择 ${task.answers.join('、')}。`;
  }
  function exactTextNodes(doc, label, root) {
    const want = compactLabel(label);
    return [...(root || doc).querySelectorAll(root ? 'button, [role="button"], div, span, a' : 'body *')].filter(element => {
      if (!visible(element) || element.closest('#ucampus-transfer-host')) return false;
      if (compactLabel(element.innerText || element.textContent || '') !== want) return false;
      return ![...element.children].some(child => visible(child) && compactLabel(child.innerText || child.textContent || '') === want);
    });
  }
  function actionElement(leaf) {
    for (let element = leaf, depth = 0; element && depth < 7; element = element.parentElement, depth++) {
      if (element.localName === 'button' || element.getAttribute('role') === 'button') return element;
      const key = Object.keys(element).find(key => key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$'));
      if (key && typeof element[key]?.onClick === 'function') return element;
    }
    return leaf;
  }
  function actionDisabled(element) {
    for (let current = element, depth = 0; current && depth < 5; current = current.parentElement, depth++) {
      if (current.disabled || current.getAttribute('aria-disabled') === 'true' || /(?:^|[\s_-])disabled(?:$|[\s_-])/.test(current.className || '')) return true;
    }
    return false;
  }
  function submitButtons(docs) {
    return [...new Set(docs.flatMap(doc => exactTextNodes(doc, '提交').filter(node => !node.closest('.ant-modal, [role="dialog"], .scoop-select-dropdown, .popover-mistake-atom')).map(actionElement)))].filter(visible);
  }
  function submissionComplete(docs) {
    // 只认当前页面真正出现的答题小结，不把点击过按钮当作提交成功。
    return docs.some(doc => exactTextNodes(doc, '答题小结').length > 0);
  }
  async function reopenRepeatTask(task) {
    assertAutoContext(task);
    assertSubmissionAllowed();
    const docs = pageDocuments();
    if (!submissionComplete(docs)) return;
    const unavailable = message => Object.assign(new Error(message), { code: 'REPEAT_UNAVAILABLE' });
    const labels = ['重新作答', '重新答题', '再做一次', '重新练习', '再练一次', '重做'];
    const controls = [...new Set(docs.flatMap(doc => labels.flatMap(label => exactTextNodes(doc, label).map(actionElement))))]
      .filter(control => !actionDisabled(control));
    if (controls.length !== 1) throw unavailable('当前题在答题小结中，没有唯一可用的重答入口，跳过此题。');
    if (autoState.cancelled || repeatTimeUp()) throw new Error('重复答题已停止或总时间已结束。');
    controls[0].click();
    if (!await waitFor(() => !submissionComplete(pageDocuments()), 6000)) throw unavailable('点击重答后仍在答题小结，跳过此题。');
    assertAutoContext(task);
  }
  async function clickSubmit(report = () => {}, shouldStop = () => false) {
    assertSubmissionAllowed();
    const docs = pageDocuments();
    if (submissionComplete(docs)) throw new Error('页面已经是答题小结，未重复提交。');
    report('答案已填写，等待网页提交按钮可用……');
    // 等下拉菜单关闭、React状态刷新及网页按钮更新后，再取新的按钮节点。
    await new Promise(resolve => setTimeout(resolve, 300));
    const button = await waitFor(() => {
      const buttons = submitButtons(docs).filter(button => !actionDisabled(button));
      return buttons.length === 1 ? buttons[0] : null;
    }, 5000);
    if (!button) {
      const buttons = submitButtons(docs);
      throw new Error(buttons.length > 1 ? '页面有多个提交入口，没有盲点。' : buttons.length ? '网页提交按钮仍不可用，答案已保留。' : '答案已填写，但没有找到网页提交按钮。');
    }
    assertSubmissionAllowed();
    if (shouldStop()) throw new Error('定时任务已停止，未点击提交。');
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    button.click();
    report('已点击网页提交，正在等待确认框或答题小结……');
    const acted = new Map();
    const started = Date.now();
    let confirmed = 0;
    while (Date.now() - started < 15000) {
      assertSubmissionAllowed();
      if (shouldStop()) throw new Error('定时任务已停止；已发出的提交请求无法撤回。');
      if (submissionComplete(docs)) return '已提交，页面已显示答题小结。';
      const dialogs = docs.flatMap(doc => [...doc.querySelectorAll('.ant-modal, [role="dialog"], .system-info-modal')].filter(visible));
      for (const dialog of dialogs) {
        const text = normalize(dialog.innerText || dialog.textContent || '');
        if (/没有作答|未作答|没有答完|请完成后提交|暂不能提交|无法提交|网络不太好|提交失败/.test(text)) throw new Error('网页未完成提交：' + text.slice(0, 260));
        if (!/提交/.test(text) || acted.get(dialog) === text) continue;
        const confirms = [...new Set(['确定', '确认', '继续', '确认提交'].flatMap(label => exactTextNodes(null, label, dialog).map(actionElement)))].filter(element => !actionDisabled(element));
        if (confirms.length !== 1) throw new Error('出现了提交确认，但没有找到唯一可用的确定按钮。');
        if (++confirmed > 3) throw new Error('确认框重复出现，停止重试。');
        acted.set(dialog, text);
        if (shouldStop()) throw new Error('定时任务已停止，未继续确认。');
        assertSubmissionAllowed();
        confirms[0].click();
        report('已处理第 ' + confirmed + ' 个提交确认，等待答题小结……');
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('答案已填写，已点击提交' + (confirmed ? '并确认' : '') + '，但尚未检测到答题小结；没有标绿。请查看页面是否仍有提示。');
  }
  const SUBMITTED_KEY = 'ucampus-submitted-tasks'; // 0.4.6 及更早版本的待认领记录
  const SUBMITTED_BY_ACCOUNT = 'ucampus-submitted-tasks/v2/';
  const LEGACY_OWNER_KEY = 'ucampus-submitted-legacy-owner/v1';
  const NAV_CHECK_KEY = 'ucampus-navigation-check/v1'; // 同一脚本的所有账号共享，每本书独立
  function readNavigationChecks() {
    const value = sharedRead(NAV_CHECK_KEY, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function navigationBookRecord(book = activeBook()) {
    const entry = readNavigationChecks()[bookName(book)];
    return entry && typeof entry === 'object' ? entry : {};
  }
  function navigationFailures(book = activeBook()) {
    const value = navigationBookRecord(book).failures;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function saveNavigationResult(task, error) {
    const book = taskBook(task), checks = readNavigationChecks(), entry = { ...navigationBookRecord(book) };
    const failures = { ...(entry.failures || {}) }, key = taskKey(task.path, task.book);
    if (error) failures[key] = { reason: String(error.message || error).slice(0, 450), at: Date.now() };
    else delete failures[key];
    checks[book] = { ...entry, failures };
    sharedWrite(NAV_CHECK_KEY, checks);
    paintTaskOptions();
  }
  function finishBookNavigationCheck(book) {
    const checks = readNavigationChecks();
    checks[book] = { ...navigationBookRecord(book), checkedAt: Date.now() };
    sharedWrite(NAV_CHECK_KEY, checks);
    paintTaskOptions();
  }
  var accountIdentity = null;
  const accountSubmittedKey = () => accountIdentity ? SUBMITTED_BY_ACCOUNT + accountIdentity.key : '';
  const PANEL_KEY = 'ucampus-panel-pos';
  const TIMER_PANEL_KEY = 'ucampus-auto-panel-pos/v1';
  const TIMER_COLLAPSED_KEY = 'ucampus-auto-panel-collapsed/v1';
  const LOG_PANEL_KEY = 'ucampus-log-panel-pos/v1';
  const LOG_VISIBLE_KEY = 'ucampus-log-visible/v1';
  function readSubmitted() {
    const key = accountSubmittedKey();
    if (!key) return new Set();
    const data = sharedRead(key, []);
    const done = new Set(Array.isArray(data) ? data.filter(item => typeof item === 'string') : []);
    // 当播放器先只认出网站账号编号、后来首页补全学校与学号时，把同一账号的临时记录并入正式记录区。
    if (accountIdentity.student && accountIdentity.appUserId) {
      const alias = SUBMITTED_BY_ACCOUNT + 'site-id/' + encodeURIComponent(accountIdentity.schId || '') + '/' + encodeURIComponent(accountIdentity.appUserId);
      if (alias !== key) {
        const previous = sharedRead(alias, []);
        if (Array.isArray(previous) && previous.length) {
          for (const item of previous) done.add(item);
          try { sharedWrite(key, [...done]); sharedWrite(alias, []); } catch { /* 存储故障时本页仍展示匹配到的记录 */ }
        }
      }
    }
    return done;
  }
  function setAccountIdentity(next) {
    const previous = accountIdentity?.key || '';
    if (previous === (next?.key || '')) return;
    if (autoState.running) autoState.cancelled = true;
    if (jumpCheckState.running) jumpCheckState.cancelled = true;
    accountIdentity = next;
    storedDataSignature = '';
    paintTaskOptions(readSubmitted());
    markAnsweredCatalog();
    status(next ? '已识别账号，提交记录已切换到当前账号。' : '账号身份未确认；提交标记暂不显示。');
  }
  const ACCOUNT_SNAPSHOT_KEY = 'ucampus-account-from-home/v1';
  const ACCOUNT_BINDINGS_KEY = 'ucampus-player-account-bindings/v1';
  let lastPlayerIdentity = null;
  const playerBindingKey = identity => identity?.appUserId ? encodeURIComponent(identity.schId || '') + '/' + encodeURIComponent(identity.appUserId) : '';
  function playerBinding(identity) {
    const record = sharedRead(ACCOUNT_BINDINGS_KEY, {})?.[playerBindingKey(identity)];
    return record && record.appUserId === identity?.appUserId && String(record.schId || '') === String(identity?.schId || '') &&
      accountRecord(record.school, record.student) ? record : null;
  }
  async function fetchPlayerIdentity() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/auth/api/user', { credentials: 'same-origin', redirect: 'manual', signal: controller.signal });
      if (!response.ok) return null;
      return await response.json();
    } catch { return null; }
    finally { clearTimeout(timeout); }
  }
  function accountOnHome() {
    let state = {};
    try { state = JSON.parse(localStorage.getItem('PORTAL_STATE_PERSISTENT') || '{}') || {}; } catch {}
    const stored = accountFromHomeState(state);
    const schools = [...document.querySelectorAll('[class*="UserPanel_cardSchool__"]')].filter(visible);
    const roles = [...document.querySelectorAll('[class*="UserPanel_roleId__"]')].filter(visible);
    const shown = schools.length === 1 && roles.length === 1
      ? accountFromHomeFields(schools[0].innerText || schools[0].textContent, roles[0].innerText || roles[0].textContent, state) : null;
    if (stored && shown && stored.key !== shown.key) return null;
    return shown || stored;
  }
  function lastHomeAccount() {
    const saved = sharedRead(ACCOUNT_SNAPSHOT_KEY, null);
    if (!saved || !accountRecord(saved.school, saved.student) || saved.key !== accountRecord(saved.school, saved.student).key) return null;
    return saved;
  }
  let accountRefreshPromise = null;
  async function refreshAccountIdentity() {
    if (accountRefreshPromise) return accountRefreshPromise;
    accountRefreshPromise = (async () => {
      let next = null;
      if (window.location.hostname === 'ucontent.unipus.cn') {
        const payload = await fetchPlayerIdentity();
        lastPlayerIdentity = payload ? accountFromPlayer(payload, null) : null;
        if (lastPlayerIdentity) next = accountFromPlayer(payload, lastHomeAccount(), playerBinding(lastPlayerIdentity));
      } else {
        next = accountOnHome();
        if (next && JSON.stringify(lastHomeAccount()) !== JSON.stringify(next)) { try { sharedWrite(ACCOUNT_SNAPSHOT_KEY, next); } catch {} }
      }
      setAccountIdentity(next);
      return next;
    })();
    try { return await accountRefreshPromise; }
    finally { accountRefreshPromise = null; }
  }
  async function requireAccountIdentity() {
    const next = await refreshAccountIdentity();
    if (!next) throw new Error('无法核对当前学校和学号。请先打开 U校园首页，确认个人资料显示，再返回课本页刷新。');
    return next.key;
  }
  function readTaskRoutes() {
    try {
      const data = JSON.parse(localStorage.getItem(ROUTE_KEY) || '{}');
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      const valid = {};
      for (const [key, path] of Object.entries(data)) {
        if (Array.isArray(path) && path.length >= 2 && path.length <= 10 && isUnitToken(path[0]) && path.every(part => typeof part === 'string' && part.length > 0 && part.length < 180)) valid[key] = path;
      }
      return valid;
    } catch { return {}; }
  }
  function taskRoute(task) {
    return navigationPath(readTaskRoutes()[taskKey(task.path, task.book)] || task.path);
  }
  function knownTaskHits(labels, book = activeBook(), routes = readTaskRoutes()) {
    return COURSE_TASKS.filter(task => taskBook(task) === book && suggestTasks([{ ...task, path: routes[taskKey(task.path, task.book)] || task.path }], labels).length === 1);
  }
  function saveCurrentTaskRoute(task) {
    const expectedUnit = isUnitToken(task.path[0]) ? unitNumberFrom(task.path[0]) : '1';
    const active = catalogMenus().flatMap(menu => catalogEntries(menu).filter(entry => visible(entry.row) && entry.row.classList.contains('pc-menu-activity')));
    const units = [...new Set(active.map(entry => unitNumberFrom(entry.path[0])).filter(Boolean))];
    if (units.length !== 1 || units[0] !== expectedUnit) throw new Error('当前网页单元与所选题不一致，没有记位置。');
    active.sort((a, b) => b.path.length - a.path.length);
    if (!active[0]) throw new Error('没有读到当前活动目录，没有记位置。');
    const route = navigationPath(['Unit ' + expectedUnit, ...active[0].path.slice(1)]);
    const labels = [...document.querySelectorAll('.pc-tab-view-container, .pc-task')].filter(element => visible(element) && headerActive(element)).map(controlLabel);
    for (const label of labels) if (label && !route.some(part => routeLabel(part) === routeLabel(label))) route.push(label);
    const want = taskBodyPath(task.path), body = route.slice(1);
    if (!body.length || routeLabel(body[0]) !== routeLabel(want[0]) || routeLabel(body.at(-1)) !== routeLabel(want.at(-1))) throw new Error('当前页面的板块或练习编号与所选题不一致，没有记位置。');
    const routes = readTaskRoutes(); routes[taskKey(task.path, task.book)] = route;
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
    paintTaskOptions();
    return '已记住这道题的网页位置，以后从列表按此位置跳转：' + route.join(' / ');
  }
  function currentTaskHits(book = activeBook()) {
    const bases = [], routes = readTaskRoutes();
    for (const menu of catalogMenus()) {
      const active = catalogEntries(menu).filter(entry => visible(entry.row) && entry.row.classList.contains('pc-menu-activity'));
      active.sort((a, b) => b.path.length - a.path.length);
      if (active[0]) bases.push(active[0].path);
    }
    const labels = [...document.querySelectorAll('.pc-tab-view-container, .pc-task')].filter(element => visible(element) && headerActive(element)).map(controlLabel);
    const hits = bases.flatMap(base => knownTaskHits([...base, ...labels], book, routes));
    const unique = [...new Map(hits.map(task => [taskKey(task.path, task.book), task])).values()];
    return unique;
  }
  function pageCurrentUnit() {
    const active = catalogMenus().flatMap(menu => catalogEntries(menu).filter(entry => visible(entry.row) && entry.row.classList.contains('pc-menu-activity')));
    const numbers = [...new Set(active.map(entry => unitNumberFrom(entry.path[0])).filter(Boolean))];
    return numbers.length === 1 ? Number(numbers[0]) : 0;
  }
  function renderTaskTree(done, current, pageBook = activeBook()) {
    const names = ownedBooks();
    const books = groupCourseTasks(COURSE_TASKS, done, names, true);
    const signature = JSON.stringify([names, COURSE_TASKS.map(task => [task.book || '', task.path])]);
    if (signature !== taskTreeSignature) {
      taskTreeSignature = signature; lastTreeFocus = ''; taskTreeNodes.clear(); ui('task-tree').replaceChildren();
      if (!names.length) {
        const empty = document.createElement('small');
        empty.textContent = '还没读取到当前账号的首页教材。请打开首页「我的教程」，点「读取首页书架」，再回课本页刷新。未在首页读到的内置教材不会显示。';
        ui('task-tree').appendChild(empty);
      }
      for (const book of books) {
        const bookNode = document.createElement('details'), bookTitle = document.createElement('summary');
        bookNode.appendChild(bookTitle); ui('task-tree').appendChild(bookNode);
        taskTreeNodes.set(book.name, { node: bookNode, title: bookTitle });
        if (!book.units.length) { const empty = document.createElement('small'); empty.textContent = '暂无已导入答案（0/0）'; bookNode.appendChild(empty); }
        for (const unit of book.units) {
          const unitNode = document.createElement('details'), unitTitle = document.createElement('summary');
          unitNode.className = 'unit'; unitNode.appendChild(unitTitle); bookNode.appendChild(unitNode);
          const rows = new Map();
          for (const entry of unit.entries) {
            const line = document.createElement('div'); line.className = 'task-line';
            const row = document.createElement('button'); row.type = 'button'; row.className = 'task-row';
            row.onclick = () => { ui('task').value = String(entry.index); ui('task').dispatchEvent(new Event('change', { bubbles: true })); };
            const action = document.createElement('button'); action.type = 'button'; action.className = 'task-manual';
            action.onclick = run(async () => {
              const key = await requireAccountIdentity();
              if (autoState.running || jumpCheckState.running) throw new Error('请先停止定时任务或跳转检查，再改提交标记。');
              const task = COURSE_TASKS[entry.index], done = readSubmitted(), taskId = taskKey(task.path, task.book), marked = done.has(taskId);
              if (accountIdentity?.key !== key) throw new Error('当前账号已变化，请重新核对。');
              if (!window.confirm(marked ? '撤回这道题在当前账号的本地已提交标记？网页实际提交不会撤回。' : '仅将这道题标记为当前账号已提交？不会填写或提交到 U校园。')) return;
              if (marked) done.delete(taskId); else done.add(taskId);
              sharedWrite(accountSubmittedKey(), [...done]);
              markAnsweredCatalog();
              status(marked ? '已撤回当前账号的本地已提交标记；网页提交不会撤回。' : '已手动标记当前账号已提交；未向网页发送提交。');
            }, { alertOnError: true, actionName: '手动更改提交标记' });
            line.append(row, action); unitNode.appendChild(line); rows.set(entry.index, { row, action });
          }
          taskTreeNodes.set(unit.key, { node: unitNode, title: unitTitle, rows });
        }
      }
    }
    const currentIndex = current ? COURSE_TASKS.indexOf(current) : -1;
    const currentUnit = current ? (isUnitToken(current.path[0]) ? Number(unitNumberFrom(current.path[0])) : 1) : pageCurrentUnit();
    const currentBook = current ? taskBook(current) : pageBook;
    const focus = current ? taskKey(current.path, current.book) : currentUnit ? currentBook + '/unit/' + currentUnit : '';
    const recenter = !!focus && focus !== lastTreeFocus;
    if (recenter && currentIndex >= 0) ui('task').value = String(currentIndex);
    let currentRow = null, currentUnitNode = null;
    const failedByBook = new Map(books.map(book => [book.name, navigationFailures(book.name)]));
    for (const book of books) {
      const bookState = taskTreeNodes.get(book.name);
      const bookText = book.name + '（' + book.done + '/' + book.total + '）';
      if (bookState.title.textContent !== bookText) bookState.title.textContent = bookText;
      if (recenter) bookState.node.open = book.name === currentBook;
      for (const unit of book.units) {
        const state = taskTreeNodes.get(unit.key);
        const title = 'Unit ' + unit.number + '（' + unit.done + '/' + unit.total + '）';
        if (state.title.textContent !== title) state.title.textContent = title;
        const activeUnit = book.name === currentBook && unit.number === currentUnit;
        if (recenter) state.node.open = activeUnit;
        if (activeUnit) currentUnitNode = state.node;
        for (const entry of unit.entries) {
          const { row, action } = state.rows.get(entry.index), isCurrent = entry.index === currentIndex;
          const failure = failedByBook.get(book.name)[taskKey(entry.task.path, entry.task.book)];
          const parts = taskBodyPath(entry.task.path);
          const text = (isCurrent ? '▶ 当前题 · ' : '') + parts.at(-1) + '\n' + parts.slice(0, -1).join(' · ');
          if (row.textContent !== text) row.textContent = text;
          row.classList.toggle('done', entry.marked); row.classList.toggle('current', isCurrent); row.classList.toggle('chosen', String(entry.index) === ui('task').value);
          row.classList.toggle('unreachable', !!failure); row.title = failure ? '跳转未找到：' + failure.reason : '';
          action.textContent = entry.marked ? '撤回标记' : '标记已提交'; action.disabled = !accountIdentity || autoState.running || jumpCheckState.running;
          action.title = entry.marked ? '仅撤回当前账号的本地标记' : '仅标记当前账号本地已提交，不向网站提交';
          if (isCurrent) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
          if (isCurrent) currentRow = row;
        }
      }
    }
    const selectedTaskEntry = ui('task').value === '' ? null : COURSE_TASKS[Number(ui('task').value)];
    const selected = selectedTaskEntry && names.includes(taskBook(selectedTaskEntry)) ? selectedTaskEntry : null;
    const answerText = formatTaskAnswers(selected), pathText = selected ? selected.path.join(' / ') : '请选择练习';
    if (ui('answer-display').value !== answerText) ui('answer-display').value = answerText;
    ui('answer-display').style.height = selected && correctionDetails(selected).length ? '180px' : '112px';
    if (ui('answer-path').textContent !== pathText) ui('answer-path').textContent = pathText;
    if (ui('timer-start-path').textContent !== pathText) ui('timer-start-path').textContent = pathText;
    updateTimerMetrics();
    if (recenter) {
      lastTreeFocus = focus;
      const target = currentRow || currentUnitNode;
      if (target) requestAnimationFrame(() => {
        // 只滚动列表，避免把整页课本或面板一起滚走。
        const box = ui('task-tree'), rect = box.getBoundingClientRect(), item = target.getBoundingClientRect();
        box.scrollTop += item.top - rect.top - (box.clientHeight - item.height) / 2;
      });
    }
  }
  function paintTaskOptions(done = readSubmitted(), book = activeBook()) {
    const visibleBooks = new Set(ownedBooks());
    const hits = currentTaskHits(book);
    const current = hits.length === 1 && visibleBooks.has(taskBook(hits[0])) ? hits[0] : null;
    const chosen = ui('task').value === '' ? null : COURSE_TASKS[Number(ui('task').value)];
    if (!chosen || !visibleBooks.has(taskBook(chosen))) {
      const first = COURSE_TASKS.findIndex(task => visibleBooks.has(taskBook(task)));
      ui('task').value = first < 0 ? '' : String(first);
    }
    const currentKey = current ? taskKey(current.path, current.book) : '';
    const caption = current ? '▶ 当前题：' + current.path.join(' / ') : '当前题：未唯一识别（不影响手选练习）';
    if (ui('current-task').textContent !== caption) ui('current-task').textContent = caption;
    [...ui('task').options].forEach(option => {
      const task = COURSE_TASKS[Number(option.value)];
      const marked = !!(task && done.has(taskKey(task.path, task.book)));
      option.style.backgroundColor = marked ? '#b7ebc6' : '#ffffff';
      const isCurrent = !!task && taskKey(task.path, task.book) === currentKey;
      const text = (isCurrent ? '▶ 当前题 · ' : '') + task.path.join(' / ');
      if (option.textContent !== text) option.textContent = text;
      option.style.color = isCurrent ? '#145ac0' : '#172033';
      option.style.fontWeight = isCurrent ? '700' : '400';
    });
    // 不给 select 本身上色。Edge 会把这个颜色铺到下拉列表的每一行。
    ui('task').style.backgroundColor = '';
    renderTaskTree(done, current, book);
    const checked = !!navigationBookRecord(book).checkedAt;
    ui('jump-check-book').disabled = jumpCheckState.running || checked;
    ui('jump-check-book').title = checked ? '这本教材已经完整检查过一次，结果由所有账号共享' : '';
    ui('jump-check-book').textContent = checked ? '整本已检查' : '检查整本教材';
    if (!jumpCheckState.running) {
      const failures = navigationFailures(book);
      const names = COURSE_TASKS.filter(task => taskBook(task) === book && failures[taskKey(task.path, task.book)])
        .map(task => '✗ ' + task.path.join(' / ') + '：' + failures[taskKey(task.path, task.book)].reason);
      ui('jump-check-results').textContent = checked || names.length
        ? (checked ? '本教材已完整检查一次；' : '已有检查记录；') + '未找到 ' + names.length + ' 道。' + (names.length ? '\n' + names.join('\n') : '') : '';
    }
    updateDataNote(done);
  }
  function rememberSubmitted(task) {
    const accountKey = accountSubmittedKey();
    if (!accountKey) return false;
    const key = taskKey(task.path, task.book);
    try {
      const done = readSubmitted();
      done.add(key);
      sharedWrite(accountKey, [...done]);
    } catch {
      return false;
    }
    paintTaskOptions();
    markAnsweredCatalog();
    return true;
  }
  function placePanel(left, top) {
    const rect = host.getBoundingClientRect();
    const width = rect.width || 340;
    const height = rect.height || 80;
    const maxLeft = Math.max(8, window.innerWidth - Math.min(width, 120));
    const maxTop = Math.max(8, window.innerHeight - Math.min(height, 48));
    host.style.left = `${Math.min(Math.max(8, left), maxLeft)}px`;
    host.style.top = `${Math.min(Math.max(8, top), maxTop)}px`;
    host.style.right = 'auto';
  }
  function restorePanel() {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_KEY) || 'null');
      if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
      placePanel(saved.left, saved.top);
    } catch { /* 没有保存过位置 */ }
  }
  function enableDrag(panel = host, header = shadow.querySelector('header'), positionKey = PANEL_KEY, place = placePanel) {
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      const originX = event.clientX;
      const originY = event.clientY;
      const move = ev => place(rect.left + ev.clientX - originX, rect.top + ev.clientY - originY);
      const up = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', up);
        header.removeEventListener('pointercancel', up);
        const now = panel.getBoundingClientRect();
        try { localStorage.setItem(positionKey, JSON.stringify({ left: now.left, top: now.top })); } catch { /* 位置记不住也不影响拖动 */ }
      };
      header.setPointerCapture(event.pointerId);
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', up);
      header.addEventListener('pointercancel', up);
    });
  }
  function placeTimerPanel(left, top) {
    const panel = ui('timer-window'), rect = panel.getBoundingClientRect();
    const width = rect.width || 320;
    panel.style.left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - Math.min(width, 120))) + 'px';
    panel.style.top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - 60)) + 'px';
    panel.style.right = 'auto';
  }
  function setTimerCollapsed(collapsed, save = true) {
    ui('timer-body').hidden = collapsed;
    ui('timer-toggle').textContent = collapsed ? '展开' : '收起';
    if (save) { try { localStorage.setItem(TIMER_COLLAPSED_KEY, JSON.stringify(collapsed)); } catch {} }
  }
  function restoreTimerPanel() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(TIMER_PANEL_KEY) || 'null'); } catch {}
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) placeTimerPanel(saved.left, saved.top);
    else {
      const main = host.getBoundingClientRect(), width = ui('timer-window').getBoundingClientRect().width || 320;
      const left = main.left - width - 16;
      const right = main.left + (main.width || 408) + 16;
      if (left >= 8) placeTimerPanel(left, main.top);
      else if (right + width <= window.innerWidth - 8) placeTimerPanel(right, main.top);
      else placeTimerPanel(Math.max(8, window.innerWidth - width - 12), Math.min(main.top + 96, window.innerHeight - 120));
    }
    let collapsed = false;
    try { collapsed = JSON.parse(localStorage.getItem(TIMER_COLLAPSED_KEY) || 'false') === true; } catch {}
    setTimerCollapsed(collapsed, false);
  }
  function placeLogPanel(left, top) {
    const panel = ui('log-window'), width = panel.getBoundingClientRect().width || 340;
    panel.style.left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - Math.min(width, 120))) + 'px';
    panel.style.top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - 60)) + 'px';
    panel.style.right = 'auto';
  }
  function setLogVisible(visible, save = true) {
    ui('log-window').hidden = !visible;
    ui('toggle-log').textContent = visible ? '关闭日志窗口' : '显示日志窗口';
    if (save) { try { localStorage.setItem(LOG_VISIBLE_KEY, JSON.stringify(visible)); } catch {} }
    if (visible) { const rect = ui('log-window').getBoundingClientRect(); placeLogPanel(rect.left, rect.top); renderActivityLog(); }
  }
  function restoreLogPanel() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(LOG_PANEL_KEY) || 'null'); } catch {}
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) placeLogPanel(saved.left, saved.top);
    else {
      const timer = ui('timer-window').getBoundingClientRect(), width = ui('log-window').getBoundingClientRect().width || 340;
      const left = timer.left - width - 16;
      if (left >= 8) placeLogPanel(left, timer.top);
      else placeLogPanel(12, Math.min(timer.top + (timer.height || 320) + 16, Math.max(12, window.innerHeight - 360)));
    }
    let visible = true;
    try { visible = JSON.parse(localStorage.getItem(LOG_VISIBLE_KEY) || 'true') !== false; } catch {}
    // 定位时先不把未布局的隐藏元素坐标写回。
    ui('log-window').hidden = !visible;
    ui('toggle-log').textContent = visible ? '关闭日志窗口' : '显示日志窗口';
    if (visible) renderActivityLog();
  }
  const IMPORT_KEY = 'ucampus-imported-course-tasks/v1';
  function mergeCourseTasks(tasks) {
    for (const task of tasks) {
      const index = COURSE_TASKS.findIndex(old => taskKey(old.path, old.book) === taskKey(task.path, task.book));
      if (index >= 0) COURSE_TASKS[index] = task;
      else COURSE_TASKS.push(task);
    }
  }
  function refreshTaskList() {
    const selected = COURSE_TASKS[Number(ui('task').value)];
    ui('task').replaceChildren();
    COURSE_TASKS.forEach((task, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = task.path.join(' / ');
      ui('task').appendChild(option);
    });
    if (selected) ui('task').value = String(COURSE_TASKS.findIndex(t => taskKey(t.path, t.book) === taskKey(selected.path, selected.book)));
    paintTaskOptions();
    markAnsweredCatalog();
  }
  function importCourse(data) {
    const tasks = validateCourseImport(data);
    let saved = [];
    const raw = sharedRead(IMPORT_KEY, null);
    if (raw) saved = validateCourseImport(typeof raw === 'string' ? JSON.parse(raw) : raw);
    const combined = new Map(saved.map(t => [taskKey(t.path, t.book), t]));
    tasks.forEach(t => combined.set(taskKey(t.path, t.book), t));
    // Unit 1 的运行时路径省略单元前缀；导出存储仍使用统一格式。
    const serial = [...combined.values()].map(t => ({ ...t, path: isUnitToken(t.path[0]) ? t.path : ['Unit 1', ...t.path] }));
    sharedWrite(IMPORT_KEY, { schema: 'ucampus-course-answers/v1', tasks: serial });
    mergeCourseTasks(tasks);
    refreshTaskList();
    status('已导入并保存 ' + tasks.length + ' 道练习。请在列表选择对应练习；导入不会填写或提交。');
  }
  try {
    const raw = sharedRead(IMPORT_KEY, null);
    if (raw) mergeCourseTasks(validateCourseImport(typeof raw === 'string' ? JSON.parse(raw) : raw));
  } catch (error) { status('保存的整单元答案读取失败：' + error.message); }
  COURSE_TASKS.forEach((task, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = task.path.join(' / ');
    ui('task').appendChild(option);
  });
  paintTaskOptions();
  restorePanel();
  enableDrag();
  restoreTimerPanel();
  enableDrag(ui('timer-window'), ui('timer-header'), TIMER_PANEL_KEY, placeTimerPanel);
  restoreLogPanel();
  enableDrag(ui('log-window'), ui('log-header'), LOG_PANEL_KEY, placeLogPanel);
  ui('toggle-log').onclick = () => setLogVisible(ui('log-window').hidden);
  ui('log-close').onclick = () => setLogVisible(false);
  ui('log-export').onclick = () => {
    if (!activityLog.length) { window.alert('暂无可导出的日志。'); return; }
    const lines = activityLog.map(item => {
      const date = item.at && !Number.isNaN(Date.parse(item.at)) ? new Date(item.at).toLocaleDateString('sv-SE') + ' ' : '';
      return date + item.time + '  ' + item.message;
    });
    const blob = new Blob(['\uFEFF' + 'U校园答案搬运助手 v' + SCRIPT_VERSION + ' 操作日志（最近120条）\n' + lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url;
    link.download = 'U校园操作日志-' + new Date().toLocaleDateString('sv-SE') + '.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  ui('log-clear').onclick = () => {
    try { sharedWrite(ACTIVITY_LOG_KEY, []); } catch { window.alert('日志未能清空本地存储，请检查浏览器存储权限。'); return; }
    activityLog = []; lastActivityMessage = ''; renderActivityLog();
  };
  ui('timer-toggle').onclick = () => setTimerCollapsed(!ui('timer-body').hidden);
  function compareVersions(left, right) {
    const parse = value => {
      const [core, suffix = ''] = String(value).split('-', 2);
      return { parts: core.split('.').map(part => /^\d+$/.test(part) ? Number(part) : 0), suffix };
    };
    const a = parse(left), b = parse(right);
    for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index++) {
      const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
      if (diff) return diff;
    }
    if (!a.suffix && b.suffix) return 1;
    if (a.suffix && !b.suffix) return -1;
    return a.suffix.localeCompare(b.suffix);
  }
  function openAuthorizedUpdate() {
    const url = installationDownloadUrl();
    if (typeof GM_openInTab === 'function') GM_openInTab(url, { active: true });
    else window.open(url, '_blank', 'noopener');
  }
  function checkScriptUpdate() {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('当前脚本没有联网权限，请核对篡改猴权限。')); return; }
      GM_xmlhttpRequest({
        method: 'GET', url: RELEASE_METADATA_URL + '?t=' + Date.now(), timeout: 15000,
        onload: response => {
          if (response.status !== 200) { reject(new Error('官网版本检查失败，HTTP ' + response.status + '。')); return; }
          try {
            const remote = parseReleaseMetadata(response.responseText).version;
            const diff = compareVersions(remote, SCRIPT_VERSION);
            if (diff > 0) {
              openAuthorizedUpdate();
              resolve('发现新版本 ' + remote + '，已打开更新入口。首次官网下载需验证码；已授权安装可继续更新。');
            } else resolve(diff === 0 ? '当前已是最新版本 ' + SCRIPT_VERSION + '。' : '本地版本 ' + SCRIPT_VERSION + ' 比官网的 ' + remote + ' 新。');
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('连不上官网版本接口，请检查网络。')),
        ontimeout: () => reject(new Error('检查更新超时。'))
      });
    });
  }
  // 版本号公开；不为检查新版下载完整软件，也不夹带安装凭据。
  const AUTO_UPDATE_INTERVAL = 5 * 60 * 1000;
  let lastAutoUpdateCheck = 0, autoUpdateChecking = false, autoUpdateVersion = '';
  ui('update-now').onclick = () => { if (autoUpdateVersion) openAuthorizedUpdate(); };
  ui('update-later').onclick = () => {
    ui('update-banner').hidden = true;
    try { sessionStorage.setItem('ucampus-update-dismissed/v1', autoUpdateVersion); } catch {}
  };
  function checkUpdateInBackground() {
    if (document.hidden || autoUpdateChecking || Date.now() - lastAutoUpdateCheck < AUTO_UPDATE_INTERVAL || typeof GM_xmlhttpRequest !== 'function') return;
    lastAutoUpdateCheck = Date.now(); autoUpdateChecking = true;
    try { GM_xmlhttpRequest({
      method: 'GET', url: RELEASE_METADATA_URL + '?t=' + lastAutoUpdateCheck, timeout: 8000,
      onload: response => {
        autoUpdateChecking = false;
        if (response.status !== 200) return;
        let remote;
        try { remote = parseReleaseMetadata(response.responseText).version; } catch { return; }
        if (compareVersions(remote, SCRIPT_VERSION) <= 0) { ui('update-banner').hidden = true; return; }
        autoUpdateVersion = remote;
        let dismissed = '';
        try { dismissed = sessionStorage.getItem('ucampus-update-dismissed/v1') || ''; } catch {}
        if (dismissed !== remote) { ui('update-title').textContent = '发现新版本 v' + remote; ui('update-banner').hidden = false; }
      },
      onerror: () => { autoUpdateChecking = false; }, ontimeout: () => { autoUpdateChecking = false; }
    }); } catch { autoUpdateChecking = false; }
  }
  setTimeout(checkUpdateInBackground, 1500);
  setInterval(checkUpdateInBackground, AUTO_UPDATE_INTERVAL);
  window.addEventListener('focus', checkUpdateInBackground);
  document.addEventListener('visibilitychange', checkUpdateInBackground);
  ui('check-update').onclick = run(async () => {
    status('正在检查官网版本号……'); status(await checkScriptUpdate());
  }, { alertOnError: true, actionName: '检查更新' });
  ui('show-timer').onclick = () => {
    setTimerCollapsed(false);
    const rect = ui('timer-window').getBoundingClientRect();
    placeTimerPanel(rect.left, rect.top);
  };
  function detectTask() {
    const hits = knownTaskHits(activeLabels());
    if (hits.length !== 1) {
      status(hits.length ? `当前页对上 ${hits.length} 道练习，请在列表里选一条。` : '没有从当前页识别出唯一练习，请在列表里选。');
      return;
    }
    ui('task').value = String(COURSE_TASKS.indexOf(hits[0]));
    lastTreeFocus = ''; paintTaskOptions();
    status(`当前页对上：${hits[0].path.join(' / ')}`);
  }
  ui('toggle').onclick = () => {
    ui('body').hidden = !ui('body').hidden;
    ui('toggle').textContent = ui('body').hidden ? '展开' : '收起';
    if (!ui('body').hidden) { lastTreeFocus = ''; paintTaskOptions(); }
  };
  ui('scan').onclick = run(capture);
  ui('export').onclick = run(() => download('ucampus-page.json', capture()));
  ui('template').onclick = run(() => {
    const page = capture();
    download('ucampus-answers.template.json', { schema: 'ucampus-answers/v1', pageKey: page.pageKey, fingerprint: page.fingerprint, answers: page.questions.map(question => ({ id: question.id, context: question.context, options: question.options?.map(option => option.text), value: null })) });
  });
  ui('answers').oninput = invalidate;
  ui('import-course').onclick = run(() => importCourse(JSON.parse(ui('answers').value)));
  ui('file').onchange = run(async () => {
    invalidate();
    const file = ui('file').files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) throw new Error('答案文件超过 4 MB。');
    const text = await file.text();
    const data = JSON.parse(text);
    ui('answers').value = text;
    if (data.schema === 'ucampus-course-answers/v1') { importCourse(data); return; }
    status('已导入答案。点击“核对答案”查看匹配结果。');
  });
  ui('preview').onclick = run(() => {
    const plan = getPlan();
    checkedText = ui('answers').value;
    ui('fill').disabled = false;
    status(plan.map(item => `${item.question.id}：${item.value ?? item.indices.map(index => item.question.options[index].text).join(' / ')}`).join('\n') + `\n已匹配 ${plan.length} 题。请核对文字后填写。`);
  });
  ui('fill').onclick = run(async () => {
    if (ui('answers').value !== checkedText) throw new Error('答案已变化，请重新核对。');
    const plan = getPlan();
    invalidate();
    let count = 0;
    for (const item of plan) {
      // 每题重新查找，避免 React 更新后持有已经脱离文档的元素。
      if (scan().fingerprint !== captured.fingerprint) throw new Error(`页面结构变化，停止填写。已处理 ${count} 题，请检查后重新采集。`);
      const question = item.question;
      if (question.kind === 'text' || question.kind === 'select') {
        const element = document.querySelector(question.selector);
        if (!element || !visible(element) || element.disabled || element.readOnly) throw new Error(`${question.id} 控件已失效。`);
        const prototype = question.kind === 'select' ? HTMLSelectElement.prototype : element.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const property = question.kind === 'select' ? 'selectedIndex' : 'value';
        Object.getOwnPropertyDescriptor(prototype, property).set.call(element, question.kind === 'select' ? item.indices[0] : item.value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        for (const option of question.options) {
          const element = document.querySelector(option.selector);
          if (!element || !visible(element) || element.disabled) throw new Error(`${question.id} 选项已失效。`);
          const wanted = item.indices.includes(option.index);
          if (question.kind === 'radio' && !wanted) continue;
          if (element.checked !== wanted) element.click();
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      // 检查页面是否实际保留本题答案，不把事件已发出当作填写成功。
      let retained;
      if (question.kind === 'text' || question.kind === 'select') {
        const element = document.querySelector(question.selector);
        retained = element && (question.kind === 'text' ? element.value === item.value : element.selectedIndex === item.indices[0]);
      } else {
        retained = question.options.every(option => {
          const element = document.querySelector(option.selector);
          return element && element.checked === item.indices.includes(option.index);
        });
      }
      if (!retained) throw new Error(`${question.id} 未保留预期答案，已停止。请检查当前页。`);
      count++;
    }
    status(`已填写并读回核对 ${count} 题。\n标准控件已填写。播放器里的题用上面的「填写这道题」。`);
  });
  function catalogMenus() {
    // 两种播放器目录根节点均支持，嵌套时只扫描外层一次。
    const roots = [...new Set([...document.querySelectorAll('.pc-slider-menu'), ...document.querySelectorAll('.pc-slider-content-menu')])];
    return roots.filter(root => !roots.some(other => other !== root && other.contains?.(root)));
  }
  function catalogEntries(menu) {
    const rows = [...menu.querySelectorAll('.pc-slider-menu-unit, .pc-slider-menu-section, .pc-slider-menu-node, .pc-slider-menu-micro')];
    const state = { unit: '', section: '' };
    return rows.map(row => {
      const named = row.classList.contains('pc-slider-menu-unit') ? row.querySelector('.unit-label-item') : row.querySelector('.pc-menu-node-text, .pc-menu-node-name');
      const name = compactLabel((named || row).innerText || (named || row).textContent || (named || row).getAttribute?.('title') || '');
      let path;
      if (row.classList.contains('pc-slider-menu-unit')) {
        state.unit = name;
        state.section = '';
        path = [name];
      } else if (row.classList.contains('pc-slider-menu-section')) {
        state.section = name;
        path = [state.unit, name].filter(Boolean);
      } else if (row.classList.contains('pc-slider-menu-micro')) {
        path = [state.unit, state.section, name].filter(Boolean);
      } else {
        path = [state.unit, name].filter(Boolean);
      }
      return { row, path };
    });
  }
  function menuRows() {
    const entries = [];
    for (const menu of catalogMenus()) {
      for (const entry of catalogEntries(menu)) {
        const clickable = entry.row.classList.contains('pc-slider-menu-node') || entry.row.classList.contains('pc-slider-menu-micro');
        if (!clickable || !visible(entry.row)) continue;
        entries.push(entry);
      }
    }
    return entries;
  }
  function controlLabel(element) {
    return routeLabel(element.getAttribute('title') || element.textContent || '');
  }
  function headerControls(label) {
    const want = routeLabel(label);
    const controls = [...document.querySelectorAll('.pc-tab-view-container, .pc-task')].filter(element => element.isConnected && visible(element) && !element.closest('#ucampus-transfer-host') && controlLabel(element) === want);
    return controls.filter(element => !controls.some(other => other !== element && element.contains?.(other)));
  }
  function headerActive(element) {
    if (element.classList.contains('pc-task')) return element.classList.contains('pc-header-task-activity');
    return !!element.closest('.pc-header-tab-activity');
  }
  function headerDisabled(element) {
    if (element.classList.contains('pc-task')) return element.classList.contains('pc-header-task-disabled');
    return element.classList.contains('pc-header-tab-disabled') || !!element.closest('.pc-header-tab-disabled');
  }
  async function waitFor(read, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start <= timeout) {
      if (typeof autoState !== 'undefined' && autoState?.running) {
        if (autoState.cancelled) throw new Error('定时任务已停止。');
        if (repeatTimeUp()) throw new Error('重复答题总倒计时已结束。');
        if (autoState.jumpDeadline && Date.now() >= autoState.jumpDeadline) throw new Error('跳转超过10秒，没有打开。');
      }
      if (jumpCheckState.running && jumpCheckState.cancelled) throw new Error('跳转检查已停止。');
      const value = read();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (typeof autoState !== 'undefined' && autoState?.jumpDeadline && Date.now() >= autoState.jumpDeadline) throw new Error('跳转超过10秒，没有打开。');
    return null;
  }
  async function jumpToTask(task) {
    const original = task;
    if (taskBook(task) !== activeBook()) throw new Error('当前网页教材与所选练习不同，请先打开对应教材。');
    task = { ...task, path: taskRoute(task) };
    const want = taskBodyPath(task.path).map(routeLabel).filter(Boolean);
    let covered = [];
    for (let step = 0; step < 8 && covered.length < want.length; step++) {
      if (jumpCheckState.running && jumpCheckState.cancelled) throw new Error('跳转检查已停止。');
      let entries = menuRows().filter(entry => unitCompatible(entry.path, task.path));
      let menu = nextMenuJump(entries.map(entry => ({ path: entry.path, clickable: true })), task.path, covered.length);
      if (!menu && !covered.length) {
        const ready = await waitFor(() => {
          const latest = menuRows().filter(entry => unitCompatible(entry.path, task.path));
          const next = nextMenuJump(latest.map(entry => ({ path: entry.path, clickable: true })), task.path, 0);
          return next ? { entries: latest, menu: next } : null;
        }, 6000);
        if (ready) { entries = ready.entries; menu = ready.menu; }
        else {
          const unit = isUnitToken(task.path[0]) ? unitNumberFrom(task.path[0]) : '1';
          const shown = [...new Set(menuRows().filter(entry => unitCompatible(entry.path, task.path)).map(entry => entry.path.slice(1).join(' / ')))];
          throw new Error(shown.length
            ? '课本目录中的 Unit ' + unit + ' 目录未找到「' + taskBodyPath(task.path)[0] + '」。当前可见目录：' + shown.slice(0, 14).join('、') + '。可手动打开目标题后记住位置。'
            : '没有读到课本目录中的 Unit ' + unit + ' 的练习目录。请展开课本的“目录”栏并确认该单元已显示，再重试。');
        }
      }
      if (menu?.ambiguous) throw new Error('目录里有多条对得上，没有跳。');
      if (menu) {
        const row = entries[menu.index].row;
        if (row.classList.contains('pc-menu-micro-lock')) throw new Error('这一节还锁着，没有跳。');
        const key = menu.covered.join('\n');
        if (!row.classList.contains('pc-menu-activity')) {
          row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          row.click();
          const opened = await waitFor(() => menuRows().some(entry => {
            if (!unitCompatible(entry.path, task.path) || !entry.row.classList.contains('pc-menu-activity')) return false;
            const aligned = menuAlignment(entry.path, task.path);
            return aligned && aligned.join('\n') === key;
          }), 7000);
          if (!opened) throw new Error('点了目录，页面没有切过去。');
        }
        covered = menu.covered;
        continue;
      }
      const label = taskBodyPath(task.path)[covered.length];
      const controls = await waitFor(() => {
        const found = headerControls(label);
        const usable = found.filter(element => !headerDisabled(element));
        return usable.length ? usable : null;
      }, 6000);
      if (!controls) {
        const shown = [...document.querySelectorAll('.pc-tab-view-container, .pc-task')].filter(visible).map(controlLabel);
        throw new Error('跳转卡在「' + label + '」。当前标签：' + [...new Set(shown)].join('、') + '。可手动打开目标题，再点“记住当前页位置”。');
      }
      if (controls.length !== 1) throw new Error(`页面上有多个「${label}」，没有继续跳。`);
      const control = headerControls(label)[0];
      if (headerDisabled(control)) throw new Error(`「${label}」还不能点，没有跳。`);
      if (!headerActive(control)) {
        control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        control.click();
        const opened = await waitFor(() => headerControls(label).some(headerActive), 7000);
        if (!opened) throw new Error(`点了「${label}」，页面没有切过去。`);
      }
      covered = want.slice(0, covered.length + 1);
    }
    if (covered.length !== want.length) throw new Error('没有跳到这道题。');
    const confirmed = await waitFor(() => {
      const hits = currentTaskHits();
      return hits.length === 1 && taskKey(hits[0].path, hits[0].book) === taskKey(original.path, original.book);
    }, 7000);
    if (!confirmed) throw new Error('目录已点击，但实际题目尚未核对为目标练习，没有填写或提交。');
    return `已打开：${original.path.join(' / ')}。还没有填写。`;
  }
  async function checkTaskJumps(scope) {
    if (!catalogMenus().length || isShelfPage()) throw new Error('请先打开具体教材的课本播放器，再检查跳转。');
    const book = activeBook();
    if (scope === 'book' && navigationBookRecord(book).checkedAt) throw new Error('这本教材已经完整检查过一次；失败题已在目录中标为浅紫色。当前单元仍可检查。');
    const unit = scope === 'unit' ? pageCurrentUnit() : 0;
    if (scope === 'unit' && !unit) throw new Error('无法唯一识别当前单元，请在课本目录打开该单元的一道练习后重试。');
    const tasks = COURSE_TASKS.filter(task => taskBook(task) === book && (scope === 'book' || (isUnitToken(task.path[0]) ? Number(unitNumberFrom(task.path[0])) : 1) === unit));
    if (!tasks.length) throw new Error('当前范围没有已收录的练习。');
    const lines = [], result = ui('jump-check-results');
    let passed = 0, failed = 0;
    jumpCheckState = { running: true, cancelled: false };
    ui('jump-check-unit').disabled = true;
    ui('jump-check-book').disabled = true;
    ui('jump-check-stop').disabled = false;
    result.textContent = `准备检查 ${tasks.length} 道练习……`;
    try {
      for (let i = 0; i < tasks.length && !jumpCheckState.cancelled; i++) {
        const task = tasks[i];
        const name = task.path.join(' / ');
        result.textContent = `正在检查 ${i + 1}/${tasks.length}：${name}\n` + lines.join('\n');
        try {
          await jumpToTask(task);
          if (jumpCheckState.cancelled) break;
          passed++;
          saveNavigationResult(task, null);
        } catch (error) {
          if (jumpCheckState.cancelled) break;
          failed++;
          lines.push('✗ ' + name + '：' + (error.message || String(error)));
          saveNavigationResult(task, error);
        }
        result.textContent = `已检查 ${passed + failed}/${tasks.length}，成功 ${passed}，失败 ${failed}\n` + lines.join('\n');
        result.scrollTop = result.scrollHeight;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const summary = (jumpCheckState.cancelled ? '跳转检查已停止' : '跳转检查完成') + `：${passed + failed}/${tasks.length} 道，成功 ${passed}，失败 ${failed}。`;
      if (scope === 'book' && !jumpCheckState.cancelled && passed + failed === tasks.length) finishBookNavigationCheck(book);
      result.textContent = summary + (failed ? '\n仅列出未找到：\n' + lines.join('\n') : '\n没有未找到的练习。');
      status(summary + (failed ? ' 仅未找到的练习列在教材目录下。' : ''));
    } finally {
      jumpCheckState.running = false;
      ui('jump-check-unit').disabled = false;
      ui('jump-check-book').disabled = !!navigationBookRecord(book).checkedAt;
      ui('jump-check-stop').disabled = true;
      paintTaskOptions();
    }
  }
  function taskMatches(task, base, name) {
    const path = alignedMenuPath([...base, name], task.path);
    return !!(path && Array.isArray(task.answers) && task.answers.length && path.length === navigationPath(taskBodyPath(task.path)).length);
  }
  function markAnsweredCatalog() {
    if (isShelfPage() && Date.now() - shelfScanAt > 10000) { shelfScanAt = Date.now(); readShelf(true); }
    const done = readSubmitted(), book = activeBook();
    paintTaskOptions(done, book);
    const availableTasks = COURSE_TASKS.filter(task => taskBook(task) === book);
    const submittedTasks = availableTasks.filter(task => done.has(taskKey(task.path, task.book)));
    const menus = catalogMenus();
    for (const menu of menus) {
      const entries = catalogEntries(menu);
      const flags = answeredMenuFlags(entries.map(entry => entry.path), availableTasks);
      const doneFlags = answeredMenuFlags(entries.map(entry => entry.path), submittedTasks);
      entries.forEach((entry, index) => {
        setCatalogClass(entry.row, 'ucampus-submitted', doneFlags[index]);
        setCatalogClass(entry.row, 'ucampus-has-answer', flags[index] && !doneFlags[index]);
      });
      const active = entries.filter(entry => visible(entry.row) && entry.row.classList.contains('pc-menu-activity')).sort((left, right) => right.path.length - left.path.length)[0];
      const base = active ? active.path : [];
      for (const tab of document.querySelectorAll('.pc-task')) {
        const name = compactLabel(tab.innerText || '');
        const aligned = availableTasks.some(task => taskMatches(task, base, name));
        const submitted = submittedTasks.some(task => taskMatches(task, base, name));
        setCatalogClass(tab, 'ucampus-submitted', submitted);
        setCatalogClass(tab, 'ucampus-has-answer', aligned && !submitted);
      }
    }
  }
  function ensureAnswerMark() {
    if (document.getElementById('ucampus-answer-mark')) return;
    const style = document.createElement('style');
    style.id = 'ucampus-answer-mark';
    style.textContent = '.pc-slider-menu .ucampus-has-answer:not(.pc-menu-activity):not(.ucampus-submitted),.pc-slider-menu .ucampus-has-answer:not(.pc-menu-activity):not(.ucampus-submitted) .pc-menu-node-text,.pc-slider-menu .ucampus-has-answer:not(.pc-menu-activity):not(.ucampus-submitted) .pc-menu-node-name,.pc-slider-menu .ucampus-has-answer:not(.pc-menu-activity):not(.ucampus-submitted) .unit-label-item,.pc-task.ucampus-has-answer:not(.pc-header-task-activity):not(.ucampus-submitted){color:#d40000 !important}.pc-slider-menu .ucampus-submitted,.pc-task.ucampus-submitted{background-color:#d8f3df !important}.pc-slider-menu .ucampus-submitted.pc-menu-activity,.pc-task.ucampus-submitted.pc-header-task-activity{outline:2px solid #1f8a4c}';
    (document.head || document.documentElement).appendChild(style);
  }
  function setCatalogClass(element, name, enabled) {
    if (element.classList.contains(name) !== !!enabled) element.classList.toggle(name, !!enabled);
  }
  const NAVIGATION_SCOPE = '.pc-slider-menu, .pc-slider-content-menu, .pc-tab-view-container, .pc-task, .pc-header-tab-activity, .course-name, .course-title, h1, h2, title';
  function relevantNavigationMutation(record) {
    if (isShelfPage()) return true;
    const target = record.target?.nodeType === 3 ? record.target.parentElement : record.target;
    if (!target || target === host || target.closest?.('#ucampus-transfer-host')) return false;
    if (record.type === 'attributes' && record.attributeName === 'class') {
      const strip = value => String(value || '').split(/\s+/).filter(name => name && name !== 'ucampus-submitted' && name !== 'ucampus-has-answer').sort().join(' ');
      if (strip(record.oldValue) === strip(target.getAttribute?.('class'))) return false;
    }
    if (target.matches?.(NAVIGATION_SCOPE) || target.closest?.(NAVIGATION_SCOPE)) return true;
    return record.type === 'childList' && [...record.addedNodes || [], ...record.removedNodes || []].some(node => node.matches?.(NAVIGATION_SCOPE) || node.querySelector?.(NAVIGATION_SCOPE));
  }
  let catalogRefreshTimer = null, lastCatalogRefreshAt = 0;
  function scheduleCatalogRefresh() {
    if (document.hidden || catalogRefreshTimer !== null) return;
    const delay = Math.max(200, 500 - (Date.now() - lastCatalogRefreshAt));
    catalogRefreshTimer = setTimeout(() => {
      catalogRefreshTimer = null;
      if (document.hidden) return;
      lastCatalogRefreshAt = Date.now();
      markAnsweredCatalog();
    }, delay);
  }
  ensureAnswerMark();
  markAnsweredCatalog();
  new MutationObserver(records => {
    if (records.some(relevantNavigationMutation)) scheduleCatalogRefresh();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'aria-selected', 'aria-current'] });
  // 路由和相关目录变化触发刷新，十秒兜底；后台不扫描整页。
  setInterval(() => { if (!document.hidden) scheduleCatalogRefresh(); }, 10000);
  if (typeof window.addEventListener === 'function') window.addEventListener('hashchange', scheduleCatalogRefresh);
  document.addEventListener?.('visibilitychange', () => { if (!document.hidden) scheduleCatalogRefresh(); });
  function autoProgressPreview() {
    const repeating = ui('auto-repeat').checked;
    const perturb = ui('auto-perturb').checked;
    ui('auto-repeat-note').hidden = !repeating;
    ui('auto-perturb').disabled = autoState.running;
    ui('auto-perturb-seconds').disabled = !perturb || autoState.running;
    ui('auto-perturb-note').hidden = false;
    ui('auto-count-label').textContent = repeating ? '节奏题数' : '练习数';
    ui('auto-scope').disabled = repeating || autoState.running;
    const minutes = Number(ui('auto-minutes').value), count = Number(ui('auto-count').value);
    const perturbText = perturb ? ' 每题另加 0–' + (Number(ui('auto-perturb-seconds').value) || 0) + ' 秒随机扰动，不计入总时间。' : '';
    ui('auto-preview').textContent = minutes > 0 && count > 0 ? repeating ? '总时间 ' + minutes + ' 分钟，约每 ' + (minutes * 60 / count).toFixed(1) + ' 秒提交一题；包含已做题，整书循环，时间归零停止。' + perturbText : minutes + '分钟做' + count + '道练习，平均每道 ' + (minutes * 60 / count).toFixed(1) + ' 秒；先填，到时间再提交。跳转失败最多扣10秒，剩余时间再平分。' + perturbText : '请输入总分钟数和练习数。';
    updateTimerMetrics();
  }
  function assertAutoContext(task) {
    if (!accountIdentity || accountIdentity.key !== autoState.accountKey) throw new Error('账号身份已变化，定时任务已停止。');
    if (taskBook(task) !== activeBook()) throw new Error('当前网页教材与任务教材不同，已停止。请先从首页打开对应教材。');
    const hits = currentTaskHits();
    if (hits.length !== 1 || taskKey(hits[0].path, hits[0].book) !== taskKey(task.path, task.book)) throw new Error('网页已离开计划中的练习，已停止，没有提交其他题。');
  }
  async function startTimedTask() {
    assertSubmissionAllowed();
    const expectedAccountKey = await requireAccountIdentity();
    if (!catalogMenus().length || isShelfPage()) throw new Error('请先打开具体课本练习页，再启动定时任务。');
    const selected = selectedTask();
    if (taskBook(selected) !== activeBook()) throw new Error('请先打开所选教材，不会跨书填写。');
    const failedKeys = Object.keys(navigationFailures(taskBook(selected)));
    const repeating = ui('auto-repeat').checked;
    const excluded = new Set([...(repeating ? [] : readSubmitted()), ...failedKeys]);
    const plan = repeating ? buildRepeatPlan(COURSE_TASKS, excluded, selected) : buildAutoPlan(COURSE_TASKS, excluded, selected, ui('auto-scope').value || 'unit', Number(ui('auto-count').value), false);
    const targetCount = Number(ui('auto-count').value);
    const minutes = Number(ui('auto-minutes').value);
    const perturbOn = ui('auto-perturb').checked;
    const perturbMax = Number(ui('auto-perturb-seconds').value);
    if (perturbOn && (!Number.isInteger(perturbMax) || perturbMax < 1 || perturbMax > 500)) throw new Error('随机扰动请填写1至500的整数秒。');
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440 || minutes * 60000 / targetCount < (repeating ? 1000 : 10000)) throw new Error(repeating ? '分钟数应大于0且不超过1440，平均每道至少1秒。' : '分钟数应大于0且不超过1440，平均每道至少10秒。');
    autoState = { running: true, cancelled: false, accountKey: expectedAccountKey, skipped: [], startedAt: Date.now(), repeating, endsAt: Date.now() + minutes * 60000, completed: 0, targetCount, phase: 'jumping', shortenedMs: 0, idleSubmitTaskKey: '' };
    autoState.clockTimer = setInterval(updateTimerMetrics, 1000);
    updateTimerMetrics();
    ui('auto-skipped').textContent = failedKeys.length ? '已按整本教材共享检查结果预先跳过 ' + failedKeys.length + ' 道跳转未找到的练习（不计完成）。' : '';
    ui('auto-start').disabled = true; ui('auto-stop').disabled = false; ui('timer-stop-quick').disabled = false;
    for (const id of ['auto-minutes', 'auto-count', 'auto-scope', 'auto-repeat', 'auto-perturb', 'auto-perturb-seconds']) ui(id).disabled = true;
    timerStatus('正在准备定时任务……');
    try {
      const execute = repeating ? executeRepeatPlan : executeTimedPlan;
      const completed = await execute(plan, minutes, {
        targetCount, endsAt: autoState.endsAt, skipJumpFailures: true,
        onTask: (task, completed, target, deadline) => { autoState.idleSubmitTaskKey = ''; autoState.currentTask = task; autoState.deadline = deadline; autoState.completed = completed; updateTimerMetrics(); },
        onPhase: phase => { autoState.phase = phase; if (phase === 'jumping') autoState.perturbMs = null; if (phase !== 'perturbing') autoState.repeatFrozenMs = null; updateTimerMetrics(); },
        onProgress: completed => { autoState.completed = completed; updateTimerMetrics(); },
        onRepeatHold: ms => { autoState.repeatFrozenMs = ms; updateTimerMetrics(); },
        onRepeatCredit: ms => { autoState.repeatCreditMs = (autoState.repeatCreditMs || 0) + ms; updateTimerMetrics(); },
        onScheduleShift: (total, saved) => { autoState.shortenedMs = total; autoState.idleSubmitTaskKey = ''; appendActivityLog('闲置提示提前提交，退回分配时间 ' + Math.ceil(saved / 1000) + ' 秒，后续题目重新平分。'); updateTimerMetrics(); },
        onPerturb: ms => { autoState.perturbMs = ms; updateTimerMetrics(); },
        onSkip: (task, error) => {
          autoState.skipped.push(task.path.join(' / ') + '：' + (error?.message || String(error)));
          if (error?.code !== 'REPEAT_UNAVAILABLE' && error?.code !== 'QUESTION_SKIP') saveNavigationResult(task, error);
          appendActivityLog('跳过：' + task.path.join(' / ') + '。原因：' + String(error?.message || error).split(/[。\n]/)[0]);
          ui('auto-skipped').textContent = '跳过记录（不计完成）：\n' + autoState.skipped.join('\n');
        },
        now: () => Date.now(), stopped: () => autoState.cancelled, report: status,
        perturbationMs: perturbOn ? () => Math.floor(Math.random() * (perturbMax + 1)) * 1000 : null,
        jump: async task => {
          if (!repeating) autoState.jumpDeadline = Date.now() + 10000;
          try { await jumpToTask(task); if (repeating) await reopenRepeatTask(task); }
          finally { autoState.jumpDeadline = 0; }
        },
        fill: task => fillWhenPageReady({
          now: () => Date.now(),
          stopped: () => autoState.cancelled || repeatTimeUp(),
          sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
          onAttempt: attempt => { autoState.phase = 'settling'; updateTimerMetrics(); timerStatus('跳转成功后第 ' + attempt + ' 秒读取页面。'); },
          fill: async () => { assertAutoContext(task); return fillCourseTask(task); }
        }),
        waitUntil: async (deadline, task, index, total) => {
          while (Date.now() < deadline) {
            if (autoState.cancelled) throw new Error('定时任务已停止。');
            assertSubmissionAllowed();
            if (task && autoState.idleSubmitTaskKey === taskKey(task.path, task.book)) { autoState.idleSubmitTaskKey = ''; return { early: true }; }
            if (repeatTimeUp()) return;
            status(task ? '第 ' + (index + 1) + '/' + total + ' 道已填写，' + Math.ceil((deadline - Date.now()) / 1000) + ' 秒后提交。' : '没有可跳转练习，等待总倒计时结束。');
            await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
          }
        },
        verify: async task => { await requireAccountIdentity(); assertAutoContext(task); },
        submit: async () => { await clickSubmit(status, () => autoState.cancelled || repeatTimeUp()); },
        remember: task => {
          if (accountIdentity?.key !== expectedAccountKey || !rememberSubmitted(task)) throw new Error('提交已完成，但当前账号标记未能保存；已停止后续任务。');
        }
      });
      autoState.phase = 'completed';
      const summary = repeating ? '重复答题总倒计时结束，已确认提交 ' + completed + ' 次；不会再进入下一题或发起提交。' : '定时任务完成，已确认提交 ' + completed + '/' + targetCount + ' 道练习；跳过 ' + autoState.skipped.length + ' 道跳转失败的练习，详情见跳过记录。';
      status(summary); timerStatus(summary);
    } catch (error) {
      if (autoState.cancelled) { autoState.phase = 'stopped'; const message = autoState.stopReason ? autoState.stopReason + '。定时任务已停止，冷却结束后不会自动继续。' : '定时任务已停止，不再填写或发起提交。已发出的请求无法撤回，请以网页结果为准。'; status(message); timerStatus(message); }
      else { autoState.phase = 'failed'; timerStatus('定时任务未完成：' + (error.message || String(error))); throw error; }
    } finally {
      if (typeof clearInterval === 'function' && autoState.clockTimer !== undefined) clearInterval(autoState.clockTimer);
      autoState.finishedAt = Date.now(); autoState.running = false; updateTimerMetrics();
      ui('auto-start').disabled = false; ui('auto-stop').disabled = true; ui('timer-stop-quick').disabled = true;
      for (const id of ['auto-minutes', 'auto-count', 'auto-scope', 'auto-repeat', 'auto-perturb', 'auto-perturb-seconds']) ui(id).disabled = false;
      autoProgressPreview();
    }
  }
  function updateDataNote(done) {
    const matched = COURSE_TASKS.filter(task => done.has(taskKey(task.path, task.book))).length;
    const text = '本地标记已提交：' + matched + '道（含手动标记）；教程3已收录Unit 1—6（部分分组题待核实）。';
    if (ui('data-note').textContent !== text) ui('data-note').textContent = text;
    const legacy = sharedRead(SUBMITTED_KEY, []);
    const owner = sharedRead(LEGACY_OWNER_KEY, null)?.key || '';
    const unclaimed = Array.isArray(legacy) ? legacy.filter(key => !done.has(key)).length : 0;
    ui('account-banner').textContent = accountIdentity
      ? '当前登录：' + accountIdentity.school + '｜' + (accountIdentity.student ? '学号 ' + accountIdentity.student : '账号编号 ' + accountIdentity.appUserId)
      : '当前登录账号：学校和学号尚未识别';
    ui('account-note').textContent = accountIdentity
      ? '提交记录按当前账号隔离。' + (owner && owner !== accountIdentity.key ? '旧版记录已归属其他账号。' : unclaimed ? '另有 ' + unclaimed + ' 条旧版记录待认领。' : '')
      : '账号尚未识别；旧版记录仍在本机，识别后可认领，当前不显示标绿。';
    ui('bind-account').hidden = window.location.hostname !== 'ucontent.unipus.cn';
    ui('bind-account').disabled = !lastPlayerIdentity?.appUserId;
    ui('bind-account').textContent = playerBinding(lastPlayerIdentity) ? '修改账号绑定' : '绑定学校和学号';
    ui('claim-legacy').disabled = !accountIdentity?.student || !accountIdentity?.school || /^学校(编号|待确认)/.test(accountIdentity.school) || !unclaimed || !!owner && owner !== accountIdentity.key;
    ui('claim-legacy').textContent = unclaimed ? '认领旧版提交记录（' + unclaimed + '条）' : '没有待认领的旧记录';
    return matched;
  }
  ui('claim-legacy').onclick = run(async () => {
    await requireAccountIdentity();
    if (!accountIdentity) throw new Error('尚未确认账号，不能认领旧记录。');
    const owner = sharedRead(LEGACY_OWNER_KEY, null)?.key || '';
    if (owner && owner !== accountIdentity.key) throw new Error('旧版记录已归属另一个账号。');
    const old = sharedRead(SUBMITTED_KEY, []);
    if (!Array.isArray(old) || !old.length) throw new Error('没有可认领的旧版记录。');
    if (!window.confirm('旧版记录没有账号信息，可能包含多个账号的标记。确定将这些标记归到当前账号吗？')) return;
    const done = readSubmitted();
    for (const key of old) done.add(key);
    sharedWrite(accountSubmittedKey(), [...done]);
    sharedWrite(LEGACY_OWNER_KEY, { key: accountIdentity.key });
    paintTaskOptions(done);
    markAnsweredCatalog();
    status('已将 ' + old.length + ' 条旧版标记归到当前账号。请核对绿色进度。');
  });
  let storedLibrarySignature = '', storedDataSignature = '';
  function syncStoredData(announce = false) {
    if (busy && !announce) return; // 下次定时刷新或focus继续读，不丢失远端更新。
    const raw = sharedRead(IMPORT_KEY, null);
    const signature = JSON.stringify(raw);
    if (signature !== storedLibrarySignature) {
      if (raw?.tasks?.length) mergeCourseTasks(validateCourseImport(raw));
      storedLibrarySignature = signature;
      refreshTaskList();
    }
    const done = readSubmitted();
    const dataSignature = JSON.stringify([signature, accountSubmittedKey(), [...done], ownedBooks()]);
    if (dataSignature !== storedDataSignature || announce) {
      storedDataSignature = dataSignature;
      paintTaskOptions(done);
    }
    const matched = updateDataNote(done);
    if (announce) status('已合并本页旧数据和扩展共享数据；当前库匹配到 ' + matched + ' 道已提交练习。\n如果仍少：请在原来做题的课本标签页刷新，再点本按钮；首次需从原课本域名迁移。这里只同步记录，不填写、不提交。');
  }
  if (typeof GM_addValueChangeListener === 'function') {
    for (const key of [IMPORT_KEY, SUBMITTED_KEY]) GM_addValueChangeListener(key, (name, oldValue, value, remote) => {
      if (!remote) return;
      try { syncStoredData(); } catch (error) { status('共享数据读取失败：' + error.message); }
    });
  }
  if (typeof window.addEventListener === 'function') {
    for (const event of ['focus', 'pageshow', 'storage']) window.addEventListener(event, () => {
      try { syncStoredData(); } catch (error) { status('旧数据同步失败：' + error.message); }
    });
  }
  setInterval(() => { if (!document.hidden) { try { syncStoredData(); } catch {} } }, 30000);
  ui('sync-records').onclick = run(() => syncStoredData(true));
  try { syncStoredData(); } catch (error) { status('旧数据同步失败：' + error.message); }
  void refreshAccountIdentity();
  setInterval(() => { if (!document.hidden) void refreshAccountIdentity(); }, window.location.hostname === 'ucontent.unipus.cn' ? 30000 : 5000);
  window.addEventListener('focus', () => { void refreshAccountIdentity(); });
  ui('refresh-account').onclick = run(async () => {
    const identity = await refreshAccountIdentity();
    status(identity ? '当前账号：' + identity.label + '；提交记录已按账号隔离。' : '没有确认学校与学号。可先在 U校园首页确认学校和学号，再回课本页使用「绑定学校和学号」。');
  });
  ui('bind-account').onclick = run(async () => {
    if (window.location.hostname !== 'ucontent.unipus.cn') throw new Error('请在课本播放器页面绑定账号。');
    const payload = await fetchPlayerIdentity(), player = payload ? accountFromPlayer(payload, null) : null;
    if (!player?.appUserId || !lastPlayerIdentity || playerBindingKey(player) !== playerBindingKey(lastPlayerIdentity)) throw new Error('课本登录编号未读取到或已切换，请刷新账号后重试。');
    const home = lastHomeAccount(), bound = playerBinding(player);
    const school = window.prompt('课本账号编号 ' + player.appUserId + ' 对应的 U校园学校名称：', bound?.school || home?.school || '');
    if (school === null) return;
    const student = window.prompt('课本账号编号 ' + player.appUserId + ' 对应的 U校园学号：', bound?.student || home?.student || '');
    if (student === null) return;
    const record = accountRecord(school, student, { appUserId: player.appUserId, schId: player.schId });
    if (!record || /^学校(编号|待确认)/.test(record.school)) throw new Error('学校名称或学号格式不正确，未保存绑定。');
    if (player.student && player.student !== record.student) throw new Error('课本接口返回的学号与填写的不一致，未保存绑定。');
    if (player.school && !/^学校(编号|待确认)/.test(player.school) && compactLabel(player.school) !== compactLabel(record.school)) throw new Error('课本接口返回的学校与填写的不一致，未保存绑定。');
    if (!window.confirm('确认把当前课本账号编号 ' + player.appUserId + ' 绑定到「' + record.school + ' · 学号 ' + record.student + '」？以后该编号使用这个账号的独立提交记录；旧版共用记录仍需单独认领。')) return;
    const latest = await fetchPlayerIdentity(), live = latest ? accountFromPlayer(latest, null) : null;
    if (!live?.appUserId || playerBindingKey(live) !== playerBindingKey(player)) throw new Error('保存前课本登录账号发生变化，未绑定。');
    const bindings = sharedRead(ACCOUNT_BINDINGS_KEY, {});
    bindings[playerBindingKey(player)] = record;
    sharedWrite(ACCOUNT_BINDINGS_KEY, bindings);
    await refreshAccountIdentity();
    if (accountIdentity?.key !== record.key) throw new Error('绑定已保存，但课本接口身份无法与填写内容对应；未切换提交记录。');
    status('已绑定当前课本账号编号 ' + player.appUserId + '：' + record.school + ' · 学号 ' + record.student + '。旧版共用记录不会自动认领。');
  }, { alertOnError: true, actionName: '绑定课本账号' });
  ui('read-books').onclick = run(async () => readShelf());
  ui('auto-minutes').oninput = autoProgressPreview; ui('auto-count').oninput = autoProgressPreview;
  ui('auto-repeat').onchange = autoProgressPreview; ui('auto-perturb').onchange = autoProgressPreview; ui('auto-perturb-seconds').oninput = autoProgressPreview;
  autoProgressPreview();
  ui('auto-start').onclick = run(async () => {
    try { await startTimedTask(); } catch (error) { timerStatus('定时任务未完成：' + (error.message || String(error))); throw error; }
  });
  const stopTimedTask = () => { if (autoState.running) { autoState.cancelled = true; autoState.phase = 'stopping'; updateTimerMetrics(); status('正在停止任务，不再进入下一题……'); } };
  ui('auto-stop').onclick = stopTimedTask;
  ui('timer-stop-quick').onclick = stopTimedTask;
  document.addEventListener('click', event => {
    if (!isShelfPage()) return;
    for (const element of event.composedPath()) {
      if (!element || typeof element.textContent !== 'string' || element.textContent.length > 250) continue;
      const names = booksInText(element.textContent);
      if (names.length === 1) { sharedWrite('ucampus-active-book/v1', names[0]); break; }
    }
  }, true);
  ui('detect').onclick = run(async () => detectTask());
  const jumpErrorOptions = { alertOnError: true, actionName: '跳转', errorHint: '请查看当前网页及上面的失败原因。可手动打开对应练习后，点“记住当前页位置”，再尝试跳转。' };
  ui('jump').onclick = run(async () => { const task = selectedTask(); const result = await jumpToTask(task); saveNavigationResult(task, null); status(result); }, jumpErrorOptions);
  ui('jump-check-unit').onclick = run(() => checkTaskJumps('unit'));
  ui('jump-check-book').onclick = run(() => checkTaskJumps('book'));
  ui('jump-check-stop').onclick = () => { if (jumpCheckState.running) { jumpCheckState.cancelled = true; ui('jump-check-results').textContent = '正在停止跳转检查……\n' + ui('jump-check-results').textContent; } };
  ui('bind-route').onclick = run(async () => { status(saveCurrentTaskRoute(selectedTask())); });
  ui('task').onchange = run(async () => {
    paintTaskOptions();
    const task = selectedTask(); const result = await jumpToTask(task);
    saveNavigationResult(task, null); status(result);
  }, jumpErrorOptions);
  ui('fill-course').onclick = run(async () => { status(await fillCourseTask(selectedTask())); });
  ui('submit-course').onclick = run(async () => {
    assertSubmissionAllowed();
    const accountKey = await requireAccountIdentity();
    const task = selectedTask();
    const filled = await fillCourseTask(task);
    if (await requireAccountIdentity() !== accountKey) throw new Error('账号已切换，停止提交。');
    status(filled + "\n正在提交……");
    const submitted = await clickSubmit(message => status(filled + "\n" + message));
    const remembered = accountIdentity?.key === accountKey && rememberSubmitted(task);
    status(`${filled}\n${submitted}${remembered ? '\n这道题已记住，目录里标成绿色。' : '\n提交了，但这台浏览器没有记住。'}`);
  }, { alertOnError: true, actionName: '填写并提交' });
  ui('submit-top').onclick = () => ui('submit-course').click();
  ui('submit-only').onclick = run(async () => {
    // 只提交网页现有答案；不调用填写函数，也不依赖列表当前选项。
    assertSubmissionAllowed();
    const accountKey = await requireAccountIdentity();
    const hits = currentTaskHits();
    const task = hits.length === 1 ? hits[0] : null;
    status('保留网页现有答案，正在提交……');
    const submitted = await clickSubmit(status);
    const remembered = task && accountIdentity?.key === accountKey ? rememberSubmitted(task) : false;
    status(submitted + (remembered ? '\n当前实际练习已标绿。' : task ? '\n提交已确认，但本浏览器未记住标记。' : '\n当前练习未唯一识别，没有更改任何题的标记。'));
  }, { alertOnError: true, actionName: '仅提交' });
})();
