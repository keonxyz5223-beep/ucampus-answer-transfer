// ==UserScript==
// @name         U校园 · 我的答案搬运助手
// @namespace    local.ucampus.answer-transfer
// @version      0.2.4
// @description  按本人整理的答案填写当前练习，并点击页面上的提交节点。只填已给出的答案。
// @match        https://uai.unipus.cn/*
// @match        https://ucontent.unipus.cn/*
// @match        https://ucloud.unipus.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
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
  const COURSE_TASKS = [
    { path: ['Taking in', 'Listening to China', 'While you listen', 'Exercise 1'], kind: 'fill', answers: ['1945', 'his academic career', '1958', 'his lifelong passion', '1988', 'diving limits', 'anniversary celebration', 'rejecting the chair', 'determination'] },
    { path: ['Taking in', 'Listening to China', 'While you listen', 'Exercise 2'], kind: 'choice', answers: ['A', 'B', 'A', 'B', 'A'] },
    { path: ['Taking in', 'Viewing China', 'While you view', 'Exercise 1'], kind: 'choice', answers: ['B', 'B', 'A'] },
    { path: ['Taking in', 'Viewing China', 'While you view', 'Exercise 2'], kind: 'fill', answers: ['barren land', 'generations of workers', 'freezing and long', '20 billion'] },
    { path: ['Taking in', 'Viewing world cultures', 'While you view', 'Exercise 1'], kind: 'choice', answers: ['E', 'H', 'C', 'B', 'F', 'A', 'D', 'G'] },
    { path: ['Taking in', 'Viewing world cultures', 'While you view', 'Exercise 2'], kind: 'fill', answers: ['90 minutes', 'worried', 'on the waves', '10 times', 'dig in', 'focus', 'make this challenge', 'seven miles', 'four months', 'outstanding achievement'] },
    { path: ['Taking in', 'Watching street interviews', 'Exercise 2'], kind: 'fill', answers: ['cup of tea', 'feel good', 'trying new things'] },
    { path: ['Taking in', 'Watching street interviews', 'Exercise 3'], kind: 'choice', answers: ['E', 'D', 'A', 'B', 'C'] },
    { path: ['Taking in', 'Watching street interviews', 'Exercise 4'], kind: 'choice', answers: ['B', 'A', 'C', 'C', 'O'] },
    { path: ['Speaking out', 'Group discussion', 'Get ideas', 'Exercise 2'], kind: 'choice', answers: ['A', 'B', 'C', 'F', 'G', 'I', 'J', 'K'] },
  ];
  function suggestTasks(tasks, activeLabels) {
    const active = new Set((activeLabels || []).map(compactLabel).filter(Boolean));
    return tasks.filter(task => Array.isArray(task.path) && task.path.length > 0 && task.path.every(part => active.has(compactLabel(part))));
  }
  function alignedMenuPath(menuPath, taskPath) {
    const task = (taskPath || []).map(compactLabel).filter(Boolean);
    const menu = [];
    for (const part of menuPath || []) {
      const label = compactLabel(part);
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
    const task = (taskPath || []).map(compactLabel).filter(Boolean);
    const menu = [];
    for (const part of menuPath || []) {
      const label = compactLabel(part);
      if (!label) continue;
      if (!menu.length && !task.includes(label)) continue;
      menu.push(label);
    }
    if (!menu.length || !task.length || menu.length > task.length) return null;
    if (!menu.every((part, index) => part === task[index])) return null;
    return menu;
  }
  function nextMenuJump(entries, taskPath, coveredCount) {
    const want = (taskPath || []).map(compactLabel).filter(Boolean);
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
  function taskKey(path) {
    return (path || []).map(compactLabel).filter(Boolean).join('/');
  }
  // 允许离线验证答案格式，不在 Node 环境启动页面界面。
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { normalize, fingerprint, validateAnswers, compactLabel, suggestTasks, alignedMenuPath, answeredMenuFlags, menuAlignment, nextMenuJump, taskKey, COURSE_TASKS };
    return;
  }
  if (document.getElementById('ucampus-transfer-host')) return;
  const host = document.createElement('div');
  host.id = 'ucampus-transfer-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed;right:16px;top:72px;z-index:2147483646;font:14px/1.5 system-ui,sans-serif;color:#172033}
    section{box-sizing:border-box;width:340px;max-width:90vw;background:#fff;border:1px solid #ccd5df;border-radius:12px;padding:14px;box-shadow:0 6px 28px #0003}
    header{display:flex;align-items:center;justify-content:space-between;font-weight:700;margin-bottom:8px;cursor:grab;user-select:none;touch-action:none}header:active{cursor:grabbing}button{cursor:pointer;border:1px solid #c4ced9;border-radius:6px;background:#f2f6fb;padding:6px 9px;font:inherit;color:inherit;margin:3px 4px 3px 0}button:disabled{opacity:.5;cursor:default}
    textarea,select{box-sizing:border-box;width:100%;resize:vertical;font:12px/1.4 system-ui,sans-serif;border:1px solid #b8c4d1;border-radius:6px;padding:7px;margin:4px 0}textarea{height:108px;font-family:monospace}
    small{display:block;color:#536275;margin:5px 0}pre{white-space:pre-wrap;overflow:auto;max-height:180px;font:12px/1.5 system-ui;margin:7px 0}input{max-width:100%}[hidden]{display:none!important}
    </style><section><header>我的答案搬运助手 <button id="toggle">收起</button></header><div id="body">
    <small>在列表里选一道题，会跳到课本那一页，不会自动填写。有答案但还没交的是红字。填写并提交过的会记住，目录和列表用绿色背景标出。按住标题可以拖动。</small>
    <select id="task"></select>
    <button id="jump">跳到这道题</button><button id="detect">识别当前练习</button><button id="fill-course">填写这道题</button><button id="submit-course">填写并提交</button>
    <button id="scan">采集当前练习</button><button id="export">导出页面资料</button>
    <button id="template">导出答案模板</button><small>导入整理好的 JSON 答案，或粘贴至下方：</small>
    <input id="file" type="file" accept="application/json,.json"><textarea id="answers" placeholder="稍后把整理好的答案导入这里"></textarea>
    <button id="preview">核对答案</button><button id="fill" disabled>填写本页答案</button>
    <pre id="status" role="status">尚未采集。题目位于内嵌页面时，请使用题目所在框架内的面板。</pre>
    </div></section>`;
  (document.body || document.documentElement).appendChild(host);
  const ui = id => shadow.getElementById(id);
  const status = text => { ui('status').textContent = text; };
  let captured = null;
  let checkedText = null;
  let busy = false;
  const visible = element => {
    const style = getComputedStyle(element);
    return element.isConnected && element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
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
  const run = fn => async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (error) { invalidate(); status(error.message || String(error)); }
    finally { busy = false; }
  };
  function getPlan() {
    if (!captured) throw new Error('请先采集当前练习。');
    const fresh = scan();
    if (fresh.fingerprint !== captured.fingerprint) throw new Error('页面内容已变化，请重新采集并匹配答案。');
    return validateAnswers(JSON.parse(ui('answers').value), fresh);
  }
  function activeLabels() {
    return [...document.querySelectorAll('[class*="active"], [aria-selected="true"], [aria-current="true"]')]
      .filter(element => visible(element) && !element.closest('#ucampus-transfer-host'))
      .map(element => normalize(element.innerText || ''))
      .filter(text => text && text.length <= 80);
  }
  function selectedTask() {
    const task = COURSE_TASKS[Number(ui('task').value)];
    if (!task) throw new Error('先选择要填的练习。');
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
      for (const wrap of doc.querySelectorAll('.question-common-abs-choice .option-wrap')) {
        const options = [...wrap.children].filter(element => element.classList.contains('option') && visible(element));
        if (options.length) groups.push(options);
      }
    }
    return groups;
  }
  async function fillCourseTask(task) {
    if (!Array.isArray(task.answers) || !task.answers.length) throw new Error('这道题没有答案，已停止。');
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
    if (groups.length === task.answers.length) plan = groups.map((group, index) => ({ group, letters: [task.answers[index]] }));
    else if (groups.length === 1) plan = [{ group: groups[0], letters: task.answers }];
    else throw new Error(`页面有 ${groups.length} 组选项，答案有 ${task.answers.length} 个，对不上，已停止。`);
    for (const item of plan) {
      for (const letter of item.letters) {
        const matches = item.group.filter(option => optionLetter(option) === letter);
        if (matches.length !== 1) throw new Error(`选项 ${letter} 没有唯一对上。`);
        if (!isChosen(matches[0])) matches[0].click();
      }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    for (const item of plan) {
      for (const letter of item.letters) {
        const option = item.group.find(entry => optionLetter(entry) === letter);
        if (!option || !isChosen(option)) throw new Error(`选项 ${letter} 点了但没有选中，已停止，没有提交。`);
      }
    }
    return `已选择 ${task.answers.join('、')}。`;
  }
  async function clickSubmit() {
    const button = findExactControl('提交');
    if (!button) throw new Error('找不到提交。');
    button.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    const dialog = [...document.querySelectorAll('.ant-modal, [role="dialog"], .ant-modal-root')].find(element => visible(element) && /提交/.test(element.innerText || ''));
    if (!dialog) return '已点击提交，页面上没有确认框。';
    const confirm = [...dialog.querySelectorAll('button, .ant-btn, div, span')].find(element => {
      if (!visible(element)) return false;
      const text = compactLabel(element.innerText || '');
      if (!['确定', '确认', '继续'].includes(text)) return false;
      return ![...element.children].some(child => ['确定', '确认', '继续'].includes(compactLabel(child.innerText || '')));
    });
    if (!confirm) throw new Error('出现了提交确认，但没找到确定。');
    confirm.click();
    return '已点击提交，并点了确认。';
  }
  const SUBMITTED_KEY = 'ucampus-submitted-tasks';
  const PANEL_KEY = 'ucampus-panel-pos';
  function readSubmitted() {
    try {
      const raw = localStorage.getItem(SUBMITTED_KEY);
      if (raw == null) {
        const seeded = [taskKey(['Taking in', 'Listening to China', 'While you listen', 'Exercise 1'])];
        localStorage.setItem(SUBMITTED_KEY, JSON.stringify(seeded));
        return new Set(seeded);
      }
      const data = JSON.parse(raw);
      return new Set(Array.isArray(data) ? data.filter(item => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  }
  function paintTaskOptions() {
    const done = readSubmitted();
    let current = false;
    [...ui('task').options].forEach(option => {
      const task = COURSE_TASKS[Number(option.value)];
      const marked = !!(task && done.has(taskKey(task.path)));
      option.style.backgroundColor = marked ? '#b7ebc6' : '';
      if (option.selected) current = marked;
    });
    ui('task').style.backgroundColor = current ? '#d8f3df' : '';
  }
  function rememberSubmitted(task) {
    const key = taskKey(task.path);
    try {
      const done = readSubmitted();
      done.add(key);
      localStorage.setItem(SUBMITTED_KEY, JSON.stringify([...done]));
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
  function enableDrag() {
    const header = shadow.querySelector('header');
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = host.getBoundingClientRect();
      const originX = event.clientX;
      const originY = event.clientY;
      const move = ev => placePanel(rect.left + ev.clientX - originX, rect.top + ev.clientY - originY);
      const up = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', up);
        header.removeEventListener('pointercancel', up);
        const now = host.getBoundingClientRect();
        try { localStorage.setItem(PANEL_KEY, JSON.stringify({ left: now.left, top: now.top })); } catch { /* 位置记不住也不影响拖动 */ }
      };
      header.setPointerCapture(event.pointerId);
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', up);
      header.addEventListener('pointercancel', up);
    });
  }
  COURSE_TASKS.forEach((task, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = task.path.join(' / ');
    ui('task').appendChild(option);
  });
  paintTaskOptions();
  restorePanel();
  enableDrag();
  function detectTask() {
    const hits = suggestTasks(COURSE_TASKS, activeLabels());
    if (hits.length !== 1) {
      status(hits.length ? `当前页对上 ${hits.length} 道练习，请在列表里选一条。` : '没有从当前页识别出唯一练习，请在列表里选。');
      return;
    }
    ui('task').value = String(COURSE_TASKS.indexOf(hits[0]));
    status(`当前页对上：${hits[0].path.join(' / ')}`);
  }
  ui('toggle').onclick = () => {
    ui('body').hidden = !ui('body').hidden;
    ui('toggle').textContent = ui('body').hidden ? '展开' : '收起';
  };
  ui('scan').onclick = run(capture);
  ui('export').onclick = run(() => download('ucampus-page.json', capture()));
  ui('template').onclick = run(() => {
    const page = capture();
    download('ucampus-answers.template.json', { schema: 'ucampus-answers/v1', pageKey: page.pageKey, fingerprint: page.fingerprint, answers: page.questions.map(question => ({ id: question.id, context: question.context, options: question.options?.map(option => option.text), value: null })) });
  });
  ui('answers').oninput = invalidate;
  ui('file').onchange = run(async () => {
    invalidate();
    const file = ui('file').files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) throw new Error('答案文件超过 4 MB。');
    const text = await file.text();
    JSON.parse(text);
    ui('answers').value = text;
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
  function catalogEntries(menu) {
    const rows = [...menu.querySelectorAll('.pc-slider-menu-unit, .pc-slider-menu-section, .pc-slider-menu-node, .pc-slider-menu-micro')];
    const state = { unit: '', section: '' };
    return rows.map(row => {
      const named = row.classList.contains('pc-slider-menu-unit') ? row.querySelector('.unit-label-item') : row.querySelector('.pc-menu-node-text, .pc-menu-node-name');
      const name = compactLabel((named || row).innerText || '');
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
    for (const menu of document.querySelectorAll('.pc-slider-menu')) {
      for (const entry of catalogEntries(menu)) {
        const clickable = entry.row.classList.contains('pc-slider-menu-node') || entry.row.classList.contains('pc-slider-menu-micro');
        if (!clickable || !entry.row.isConnected) continue;
        entries.push(entry);
      }
    }
    return entries;
  }
  function controlLabel(element) {
    return compactLabel(element.getAttribute('title') || element.textContent || '');
  }
  function headerControls(label) {
    const want = compactLabel(label);
    return [...document.querySelectorAll('.pc-tab-view-container, .pc-task')].filter(element => element.isConnected && !element.closest('#ucampus-transfer-host') && controlLabel(element) === want);
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
      const value = read();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return null;
  }
  async function jumpToTask(task) {
    const want = task.path.map(compactLabel).filter(Boolean);
    let covered = [];
    for (let step = 0; step < 8 && covered.length < want.length; step++) {
      const entries = menuRows();
      const menu = nextMenuJump(entries.map(entry => ({ path: entry.path, clickable: true })), task.path, covered.length);
      if (menu?.ambiguous) throw new Error('目录里有多条对得上，没有跳。');
      if (menu) {
        const row = entries[menu.index].row;
        if (row.classList.contains('pc-menu-micro-lock')) throw new Error('这一节还锁着，没有跳。');
        const key = menu.covered.join('\n');
        if (!row.classList.contains('pc-menu-activity')) {
          row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          row.click();
          const opened = await waitFor(() => menuRows().some(entry => {
            if (!entry.row.classList.contains('pc-menu-activity')) return false;
            const aligned = menuAlignment(entry.path, task.path);
            return aligned && aligned.join('\n') === key;
          }));
          if (!opened) throw new Error('点了目录，页面没有切过去。');
        }
        covered = menu.covered;
        continue;
      }
      const label = task.path[covered.length];
      const controls = await waitFor(() => {
        const found = headerControls(label);
        return found.length ? found : null;
      }, 2500);
      if (!controls) throw new Error(covered.length ? `已经打开到「${task.path[covered.length - 1]}」，上面没有「${label}」。` : `目录里找不到「${label}」。先展开左侧目录。`);
      if (controls.length !== 1) throw new Error(`页面上有多个「${label}」，没有继续跳。`);
      const control = headerControls(label)[0];
      if (headerDisabled(control)) throw new Error(`「${label}」还不能点，没有跳。`);
      if (!headerActive(control)) {
        control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        control.click();
        const opened = await waitFor(() => headerControls(label).some(headerActive));
        if (!opened) throw new Error(`点了「${label}」，页面没有切过去。`);
      }
      covered = want.slice(0, covered.length + 1);
    }
    if (covered.length !== want.length) throw new Error('没有跳到这道题。');
    return `已打开：${task.path.join(' / ')}。还没有填写。`;
  }
  function taskMatches(task, base, name) {
    const path = alignedMenuPath([...base, name], task.path);
    return !!(path && Array.isArray(task.answers) && task.answers.length && path.length === task.path.length);
  }
  function markAnsweredCatalog() {
    const done = readSubmitted();
    const submittedTasks = COURSE_TASKS.filter(task => done.has(taskKey(task.path)));
    const menus = [...document.querySelectorAll('.pc-slider-menu')];
    for (const menu of menus) {
      const entries = catalogEntries(menu);
      const flags = answeredMenuFlags(entries.map(entry => entry.path), COURSE_TASKS);
      const doneFlags = answeredMenuFlags(entries.map(entry => entry.path), submittedTasks);
      entries.forEach((entry, index) => {
        entry.row.classList.toggle('ucampus-submitted', doneFlags[index]);
        entry.row.classList.toggle('ucampus-has-answer', flags[index] && !doneFlags[index]);
      });
      const active = entries.filter(entry => entry.row.classList.contains('pc-menu-activity')).sort((left, right) => right.path.length - left.path.length)[0];
      const base = active ? active.path : [];
      for (const tab of document.querySelectorAll('.pc-task')) {
        const name = compactLabel(tab.innerText || '');
        const aligned = COURSE_TASKS.some(task => taskMatches(task, base, name));
        const submitted = submittedTasks.some(task => taskMatches(task, base, name));
        tab.classList.toggle('ucampus-submitted', submitted);
        tab.classList.toggle('ucampus-has-answer', aligned && !submitted);
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
  ensureAnswerMark();
  markAnsweredCatalog();
  new MutationObserver(() => markAnsweredCatalog()).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(markAnsweredCatalog, 1000);
  ui('detect').onclick = run(async () => detectTask());
  ui('jump').onclick = run(async () => { status(await jumpToTask(selectedTask())); });
  ui('task').onchange = run(async () => {
    paintTaskOptions();
    status(await jumpToTask(selectedTask()));
  });
  ui('fill-course').onclick = run(async () => { status(await fillCourseTask(selectedTask())); });
  ui('submit-course').onclick = run(async () => {
    const task = selectedTask();
    const filled = await fillCourseTask(task);
    const submitted = await clickSubmit();
    const remembered = rememberSubmitted(task);
    status(`${filled}\n${submitted}${remembered ? '\n这道题已记住，目录里标成绿色。' : '\n提交了，但这台浏览器没有记住。'}`);
  });
})();
