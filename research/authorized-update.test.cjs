const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const api = require('../ucampus-answer-transfer.user.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'ucampus-answer-transfer.user.js'), 'utf8');
const portal = 'https://dl.keon5223.xyz/download?software=ucampus';
assert.equal(api.installationDownloadUrl(), portal, 'public template cannot embed shared authorization');
for (const bad of ['', '__UCAMPUS_INSTALL_TOKEN__', 'https://evil.example/', '../escape', null, {}, 'A'.repeat(129)]) assert.equal(api.installationDownloadUrl(bad), portal);
const credential = 'test_only_nonsecret_'.padEnd(43, 'X');
const updateUrl = 'https://dl.keon5223.xyz/api/install/' + credential + '/script.user.js';
assert.equal(api.installationDownloadUrl(credential), updateUrl);
assert.deepEqual(api.parseReleaseMetadata('{"schema":"ucampus-release/v1","version":"0.4.14"}'), { schema: 'ucampus-release/v1', version: '0.4.14' });
for (const data of ['<html>验证码</html>', '{}', '{"schema":"other","version":"0.4.14"}', '{"schema":"ucampus-release/v1","version":"latest"}']) assert.throws(() => api.parseReleaseMetadata(data));
assert.equal((source.match(/__UCAMPUS_INSTALL_TOKEN__/g) || []).length, 3, 'exact placeholder count for server template signing');
assert.match(source, /@updateURL\s+https:\/\/dl\.keon5223\.xyz\/api\/install\/__UCAMPUS_INSTALL_TOKEN__\/update\.meta\.js/);
assert.match(source, /@downloadURL\s+https:\/\/dl\.keon5223\.xyz\/api\/install\/__UCAMPUS_INSTALL_TOKEN__\/script\.user\.js/);
function runtime(status = 200, responseText = '{"schema":"ucampus-release/v1","version":"0.4.14"}') {
  const requests = [], opened = [], widgets = new Map();
  const ui = id => { if (!widgets.has(id)) widgets.set(id, { hidden: true, textContent: '' }); return widgets.get(id); };
  const box = {
    RELEASE_METADATA_URL: 'https://dl.keon5223.xyz/api/version/ucampus', SCRIPT_VERSION: '0.4.13',
    Date: { now: () => 1000000 }, document: { hidden: false, addEventListener() {} },
    window: { addEventListener() {}, open: url => opened.push(url) },
    GM_openInTab: url => opened.push(url), installationDownloadUrl: () => updateUrl,
    GM_xmlhttpRequest: options => { requests.push(options); options.onload({ status, responseText }); },
    parseReleaseMetadata: api.parseReleaseMetadata, compareVersions: api.compareVersions,
    sessionStorage: { getItem: () => '', setItem() {} }, ui,
    setTimeout() {}, setInterval() {}, run: fn => fn, status() {}
  };
  vm.createContext(box);
  const begin = source.indexOf('  function openAuthorizedUpdate()'), end = source.indexOf("  ui('show-timer').onclick", begin);
  assert.ok(begin > 0 && end > begin);
  vm.runInContext(source.slice(begin, end) + '\nthis.api = { checkScriptUpdate, checkUpdateInBackground };', box);
  return { box, requests, opened, ui };
}
(async () => {
  const manual = runtime();
  assert.match(await manual.box.api.checkScriptUpdate(), /新版本/);
  assert.deepEqual(manual.opened, [updateUrl]);
  assert.ok(manual.requests.every(request => request.url.startsWith('https://dl.keon5223.xyz/api/version/ucampus?')));
  assert.ok(manual.requests.every(request => !request.url.includes(credential) && !request.headers?.Range));
  const background = runtime(); background.box.api.checkUpdateInBackground();
  assert.equal(background.opened.length, 0, 'passive check does not open or download software');
  assert.equal(background.ui('update-banner').hidden, false);
  background.ui('update-now').onclick(); assert.deepEqual(background.opened, [updateUrl]);
  const invalid = runtime(200, '<html>请验证</html>');
  await assert.rejects(invalid.box.api.checkScriptUpdate(), /未返回有效JSON/);
  invalid.box.api.checkUpdateInBackground(); assert.equal(invalid.ui('update-banner').hidden, true);
  const denied = runtime(403, '{}'); await assert.rejects(denied.box.api.checkScriptUpdate(), /HTTP 403/);
  const current = runtime(200, '{"schema":"ucampus-release/v1","version":"0.4.13"}');
  assert.match(await current.box.api.checkScriptUpdate(), /最新版本/); assert.equal(current.opened.length, 0);
  console.log('PASS authorized updates: public template has no credential, metadata-only checks, personalized update destination, HTML/403 errors, no passive download or token leakage');
})().catch(error => { console.error(error); process.exitCode = 1; });
