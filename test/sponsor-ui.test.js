'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/website.js'), 'utf8');
function context() {
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return vm.createContext({ URL, esc: escape, markdown: escape, views: {}, adminViews: {}, startHooks: [], liveHandlers: [], homeCards: [] });
}
test('sponsor cards render only local responsive images with escaped meaningful alt text', () => {
  const ctx = context(); vm.runInContext(source, ctx);
  ctx.entries = [{ name: 'Logo "<test>', description: '', tier: '', url: '', image: { url: '/api/website/sponsor-images/' + 'a'.repeat(32), width: 2, height: 1 } }];
  const html = vm.runInContext('sponsorCards(entries)', ctx);
  assert.match(html, /class="sponsor-image"/);
  assert.match(html, /alt="Logo von Logo &quot;&lt;test&gt;"/);
  assert.match(html, /width="2" height="1"/);
  for (const url of ['https://tracker.invalid/a.png', 'data:image/png;base64,AA', '/api/website/sponsor-images/../../secret', '//tracker.invalid/a']) {
    ctx.entries[0].image.url = url;
    assert.doesNotMatch(vm.runInContext('sponsorCards(entries)', ctx), /<img/);
  }
  delete ctx.entries[0].image;
  assert.match(vm.runInContext('sponsorCards(entries)', ctx), /<h2>Logo/);
  const css = fs.readFileSync(require.resolve('../public/style.css'), 'utf8');
  assert.match(css, /\.sponsor-image\s*\{[^}]*max-width:\s*100%[^}]*height:\s*auto/);
});
test('sponsor admin exposes constrained upload, preview and separate image removal without losing stable IDs', async () => {
  const ctx = context(), elements = Object.fromEntries(['app', 'sponsorEditors', 'sponsorAdd', 'websiteForm'].map((id) => [id, { innerHTML: '', querySelectorAll: () => [] }]));
  Object.assign(ctx, { api: async () => ({ version: 1, pages: Object.fromEntries(['impressum', 'datenschutz', 'agb', 'verhaltenskodex'].map((k) => [k, { enabled: false, text: '' }])), cookies: { text: '' }, sponsors: { entries: [{ id: 'b'.repeat(32), name: 'Demo', image: { url: '/api/website/sponsor-images/' + 'a'.repeat(32), width: 2, height: 1 } }] } }), document: { getElementById: (id) => elements[id] }, adminTabs: () => '', markdownHelp: () => '', structuredClone });
  vm.runInContext(source, ctx); await vm.runInContext('adminViews.website.render()', ctx);
  assert.match(elements.sponsorEditors.innerHTML, /type="file"[^>]*accept="image\/png"/);
  assert.match(elements.sponsorEditors.innerHTML, /Bild entfernen/);
  assert.match(elements.sponsorEditors.innerHTML, /<img[^>]*class="sponsor-image"/);
  assert.match(elements.app.innerHTML, /128 KiB/);
  assert.match(source, /id: entries\[i\]\.id/);
});

// Run the production SSE routing decision, not a duplicate of its relevance rules.
const appSource = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const connectEventsSource = appSource.slice(appSource.indexOf('function connectEvents() {'), appSource.indexOf('// ---------- Start ----------'));

async function liveEditor(options = {}) {
  const ctx = context(), calls = [], renders = [];
  const config = { version: 1, pages: Object.fromEntries(['impressum', 'datenschutz', 'agb', 'verhaltenskodex'].map((key) => [key, { enabled: false, text: 'Saved legal' }])), cookies: { enabled: false, text: 'Saved cookies' }, sponsors: { enabled: false, text: 'Saved introduction', entries: [{ id: 'b'.repeat(32), name: 'Saved name', tier: '', url: '', description: '', enabled: true }] } };
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  function controls(html) {
    return [...html.matchAll(/<(input|textarea|button)\b([^>]*)>([^<]*)/g)].map((match) => {
      const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])]));
      return { attrs, value: attrs.value ?? (match[1] === 'textarea' ? decode(match[3]) : ''), checked: /\bchecked\b/.test(match[2]), disabled: /\bdisabled\b/.test(match[2]), dataset: { move: attrs['data-move'] } };
    });
  }
  let staticControls = [], boxes = [], editorHtml = '';
  const elements = { websiteError: {}, websiteFooter: {}, cookieNotice: {} };
  elements.app = { set innerHTML(html) {
    staticControls = controls(html);
    for (const el of staticControls) if (el.attrs.id) elements[el.attrs.id] = el;
    elements.websiteForm = {
      querySelector: () => staticControls.find((el) => el.attrs.type === 'submit'),
      querySelectorAll: () => [...staticControls, ...boxes.flatMap((box) => box.controls)],
    };
  } };
  elements.sponsorEditors = {
    get innerHTML() { return editorHtml; },
    set innerHTML(html) {
      editorHtml = html;
      boxes = [...html.matchAll(/<fieldset\b[^>]*>([\s\S]*?)<\/fieldset>/g)].map((match) => {
        const list = controls(match[1]);
        return { controls: list, querySelector(selector) {
          const field = selector.match(/^\[data-field="(.*?)"\]$/);
          if (field) return list.find((el) => el.attrs['data-field'] === field[1]);
          const attribute = selector.slice(1, -1);
          return list.find((el) => Object.hasOwn(el.attrs, attribute));
        }, querySelectorAll: () => list.filter((el) => el.attrs['data-move']) };
      });
    },
    querySelectorAll: () => boxes,
  };
  // Boolean data attributes are kept by this tiny DOM adapter too.
  const parseControls = controls;
  controls = (html) => {
    const list = parseControls(html);
    [...html.matchAll(/<(input|textarea|button)\b([^>]*)>/g)].forEach((match, i) => {
      for (const name of ['data-image-upload', 'data-image-remove', 'data-remove']) if (new RegExp('\\b' + name + '(?:\\s|$)').test(match[2])) list[i].attrs[name] = '';
    });
    return list;
  };
  let eventSource;
  Object.assign(ctx, { structuredClone, confirm: () => true, adminTabs: () => '', markdownHelp: () => '', toast: () => {}, buildNav: () => {},
    document: { getElementById: (id) => elements[id], activeElement: null, body: { classList: { toggle() {} } } },
    state: { route: { view: 'admin:website', name: 'website' } }, dlg: { open: false },
    EventSource: class { constructor() { eventSource = this; } },
    FileReader: class { readAsDataURL(file) { this.result = 'data:image/png;base64,' + file.data; this.onload(); } },
    render: () => { const pending = vm.runInContext('adminViews.website.render()', ctx); renders.push(pending); return pending; },
    api: async (method, url, body) => {
      calls.push({ method, url, body });
      await options.beforeRequest?.({ method, url, body });
      if (url === '/website') return { pages: {}, cookies: null, sponsors: null };
      if (method === 'GET') return structuredClone(config);
      config.version++;
      if (url === '/website/admin') {
        Object.assign(config, structuredClone(body), { version: config.version });
        config.sponsors.entries.forEach((entry, i) => { entry.id ||= String(i + 1).repeat(32); });
      } else if (method === 'PUT') config.sponsors.entries[0].image = { url: '/api/website/sponsor-images/' + 'a'.repeat(32), width: 2, height: 1 };
      else delete config.sponsors.entries[0].image;
      // Disabling the focused input loses focus in Chrome. Deliver the self-broadcast
      // while the request is in flight with no active form control, as in the browser bug.
      await eventSource.onmessage({ data: JSON.stringify({ type: 'website' }) });
      await Promise.all(renders);
      return structuredClone(config);
    } });
  vm.runInContext(source, ctx);
  vm.runInContext(connectEventsSource, ctx);
  vm.runInContext('connectEvents()', ctx);
  await vm.runInContext('adminViews.website.render()', ctx);
  return { ctx, calls, renders, elements, get boxes() { return boxes; }, emit: (type) => eventSource.onmessage({ data: JSON.stringify({ type }) }) };
}

function deferred() { return Promise.withResolvers(); }
function submit(editor) {
  const form = editor.elements.websiteForm;
  return form.onsubmit({ preventDefault() {}, target: form });
}
function assertFrozen(editor, phase) {
  for (const control of editor.elements.websiteForm.querySelectorAll('input, textarea, select, button')) {
    assert.equal(control.disabled, true, `${phase}: ${JSON.stringify(control.attrs)} must be disabled`);
  }
}

test('pending text save freezes every control and rejects overlapping editor mutations until refresh finishes', async () => {
  const saved = deferred(), refreshing = deferred(), refreshStarted = deferred();
  const editor = await liveEditor({ beforeRequest: async ({ method, url }) => {
    if (method === 'PUT' && url === '/website/admin') await saved.promise;
    if (url === '/website') { refreshStarted.resolve(); await refreshing.promise; }
  } });
  const { elements } = editor;
  elements.sponsorAdd.onclick();
  editor.boxes[1].querySelector('[data-field="name"]').value = 'New sponsor';
  elements.web_impressum_text.value = 'Legal draft';
  // An independently disabled static control must retain its state after saving.
  elements.web_cookie_text.disabled = true;
  const pending = submit(editor);
  assertFrozen(editor, 'pending PUT');
  const originalHtml = elements.sponsorEditors.innerHTML;
  const upload = editor.boxes[0].querySelector('[data-image-upload]');
  upload.files = [{ size: 70, type: 'image/png', data: 'cG5n' }];
  await submit(editor);
  await upload.onchange();
  await editor.boxes[0].querySelector('[data-image-remove]').onclick();
  elements.sponsorAdd.onclick();
  editor.boxes[0].querySelectorAll('[data-move]')[1].onclick();
  editor.boxes[0].querySelector('[data-remove]').onclick();
  assert.equal(editor.calls.filter((call) => call.method !== 'GET').length, 1, 'one text save, no image mutation or duplicate save');
  assert.equal(elements.sponsorEditors.innerHTML, originalHtml, 'programmatic list actions must also be blocked');
  assertFrozen(editor, 'pending PUT');
  saved.resolve();
  await refreshStarted.promise;
  assertFrozen(editor, 'pending public refresh');
  await submit(editor);
  assert.equal(editor.calls.filter((call) => call.method !== 'GET').length, 1);
  refreshing.resolve();
  await pending;
  assert.equal(editor.boxes.length, 2);
  assert.equal(editor.boxes[1].querySelector('[data-field="name"]').value, 'New sponsor');
  assert.equal(elements.web_impressum_text.value, 'Legal draft');
  assert.equal(elements.web_impressum_text.disabled, false);
  assert.equal(elements.web_cookie_text.disabled, true);
  assert.equal(elements.sponsorAdd.disabled, false);
  assert.equal(elements.websiteForm.querySelector('[type="submit"]').disabled, false);
  assert.equal(editor.boxes[1].querySelector('[data-image-upload]').disabled, false, 'newly saved sponsor now accepts images');
  assert.equal(editor.boxes[1].querySelector('[data-image-remove]').disabled, true);
  assert.deepEqual(editor.boxes.map((box) => box.querySelectorAll('[data-move]').map((el) => el.disabled)), [[true, false], [false, true]]);
});

for (const operation of ['text save', 'image upload', 'image removal']) {
  for (const failure of ['conflict', 'network']) {
    test(`${operation} restores original control states and drafts after deferred ${failure} failure`, async () => {
      const response = deferred();
      let armed = false;
      const editor = await liveEditor({ beforeRequest: ({ method }) => {
        if (armed && method !== 'GET') return response.promise;
      } });
      const file = { size: 70, type: 'image/png', data: 'cG5n' };
      if (operation === 'image removal') {
        const upload = editor.boxes[0].querySelector('[data-image-upload]');
        upload.files = [file]; await upload.onchange();
      }
      const { elements } = editor;
      elements.sponsorAdd.onclick();
      editor.boxes[1].querySelector('[data-field="name"]').value = 'Unsaved new sponsor';
      editor.boxes[0].querySelector('[data-field="name"]').value = 'Unsaved existing sponsor';
      elements.web_impressum_text.value = 'Unsaved legal';
      elements.web_cookie_text.value = 'Unsaved cookie';
      elements.web_sponsor_text.value = 'Unsaved introduction';
      elements.web_sponsors_on.checked = true;
      elements.web_cookie_text.disabled = true;
      const controls = elements.websiteForm.querySelectorAll('input, textarea, select, button');
      const disabledBefore = controls.map((el) => el.disabled);
      const htmlBefore = elements.sponsorEditors.innerHTML;
      armed = true;
      let pending;
      if (operation === 'text save') pending = submit(editor);
      else if (operation === 'image removal') pending = editor.boxes[0].querySelector('[data-image-remove]').onclick();
      else {
        const upload = editor.boxes[0].querySelector('[data-image-upload]');
        upload.files = [file]; pending = upload.onchange();
      }
      assertFrozen(editor, operation);
      await submit(editor);
      const message = failure === 'conflict' ? 'Version conflict (409)' : 'Network request failed';
      response.reject(new Error(message));
      await pending;
      assert.equal(elements.websiteError.textContent, message);
      assert.deepEqual(controls.map((el) => el.disabled), disabledBefore, 'exact original states restored');
      assert.equal(elements.sponsorEditors.innerHTML, htmlBefore, 'failure does not redraw draft fields');
      assert.equal(editor.boxes[0].querySelector('[data-field="name"]').value, 'Unsaved existing sponsor');
      assert.equal(editor.boxes[1].querySelector('[data-field="name"]').value, 'Unsaved new sponsor');
      assert.equal(editor.boxes[1].querySelector('[data-image-upload]').disabled, true, 'unsaved sponsor still cannot upload');
      assert.equal(elements.web_impressum_text.value, 'Unsaved legal');
      assert.equal(elements.web_cookie_text.value, 'Unsaved cookie');
      assert.equal(elements.web_sponsor_text.value, 'Unsaved introduction');
      assert.equal(elements.web_sponsors_on.checked, true);
      assert.equal(editor.renders.length, 0);
      elements.sponsorAdd.onclick();
      assert.equal(editor.boxes.length, 3, 'busy state released after failure');
    });
  }
}

test('website SSE during sponsor upload/removal preserves all editor drafts without focus', async () => {
  const editor = await liveEditor();
  const { elements } = editor;
  const drafts = { web_impressum_text: 'Unsaved legal', web_cookie_text: 'Unsaved cookies', web_sponsor_text: 'Unsaved introduction' };
  for (const [id, text] of Object.entries(drafts)) elements[id].value = text;
  elements.web_impressum_on.checked = true;
  elements.web_cookies_on.checked = true;
  elements.web_sponsors_on.checked = true;
  editor.boxes[0].querySelector('[data-field="name"]').value = 'Unsaved name';
  const upload = editor.boxes[0].querySelector('[data-image-upload]');
  upload.files = [{ size: 70, type: 'image/png', data: 'cG5n' }];
  await upload.onchange();
  for (const operation of ['upload', 'removal']) {
    if (operation === 'removal') await editor.boxes[0].querySelector('[data-image-remove]').onclick();
    assert.equal(elements.web_impressum_text.value, drafts.web_impressum_text, `${operation}: legal draft`);
    assert.equal(elements.web_cookie_text.value, drafts.web_cookie_text, `${operation}: cookie draft`);
    assert.equal(elements.web_sponsor_text.value, drafts.web_sponsor_text, `${operation}: sponsor introduction draft`);
    for (const id of ['web_impressum_on', 'web_cookies_on', 'web_sponsors_on']) assert.equal(elements[id].checked, true);
    assert.equal(editor.boxes[0].querySelector('[data-field="name"]').value, 'Unsaved name');
    assert.equal(editor.boxes[0].querySelector('[data-image-upload]').disabled, false);
    assert.equal(editor.boxes[0].querySelector('[data-image-remove]').disabled, operation === 'removal');
    assert.equal(elements.sponsorAdd.disabled, false);
    assert.equal(elements.web_impressum_text.disabled, false);
    assert.equal(editor.renders.length, 0, 'SSE must not replace the website editor');
  }
  assert.deepEqual(editor.calls.filter((call) => call.method !== 'GET').map((call) => [call.method, call.body.version]), [['PUT', 1], ['DELETE', 2]]);
  // Late broadcasts also must not discard a draft once image controls regain focusability.
  await editor.emit('website');
  await Promise.all(editor.renders);
  assert.equal(editor.renders.length, 0);
  assert.equal(elements.web_impressum_text.value, drafts.web_impressum_text);
});

test('admin upload and remove handlers preserve unsaved sponsor text and send versioned image-only requests', async () => {
  const ctx = context(), calls = [], fields = Object.fromEntries(['name', 'tier', 'url', 'description', 'enabled'].map((key) => [key, { value: key === 'name' ? 'Unsaved name' : '', checked: true }]));
  const controls = { upload: { files: [{ size: 70, type: 'image/png', data: 'cG5n' }] }, remove: {}, up: { dataset: { move: 'up' } }, down: { dataset: { move: 'down' } }, delete: {} };
  const box = { querySelector(selector) {
    if (selector.startsWith('[data-field=')) return fields[selector.match(/"(.*?)"/)[1]];
    return controls[{ '[data-image-upload]': 'upload', '[data-image-remove]': 'remove', '[data-remove]': 'delete' }[selector]];
  }, querySelectorAll: () => [controls.up, controls.down] };
  let config = { version: 1, pages: Object.fromEntries(['impressum', 'datenschutz', 'agb', 'verhaltenskodex'].map((key) => [key, { enabled: false, text: '' }])), cookies: { text: '' }, sponsors: { entries: [{ id: 'b'.repeat(32), name: 'Saved name', tier: '', url: '', description: '', enabled: true }] } };
  const elements = { app: {}, sponsorEditors: { querySelectorAll: () => [box] }, sponsorAdd: {}, websiteForm: { querySelectorAll: () => [] }, websiteError: {}, websiteFooter: {}, cookieNotice: {} };
  Object.assign(ctx, { structuredClone, adminTabs: () => '', markdownHelp: () => '', toast: () => {}, buildNav: () => {},
    document: { getElementById: (id) => elements[id], body: { classList: { toggle() {} } } },
    FileReader: class { readAsDataURL(file) { this.result = 'data:image/png;base64,' + file.data; this.onload(); } },
    api: async (method, url, body) => {
      calls.push({ method, url, body });
      if (url === '/website') return { pages: {}, cookies: null, sponsors: null };
      if (method === 'GET') return structuredClone(config);
      config.version++;
      if (method === 'PUT') config.sponsors.entries[0].image = { url: '/api/website/sponsor-images/' + 'a'.repeat(32), width: 2, height: 1 };
      else delete config.sponsors.entries[0].image;
      return structuredClone(config);
    } });
  vm.runInContext(source, ctx); await vm.runInContext('adminViews.website.render()', ctx);
  await controls.upload.onchange();
  assert.equal(calls[1].method, 'PUT'); assert.equal(calls[1].url, '/website/sponsors/' + 'b'.repeat(32) + '/image');
  assert.equal(calls[1].body.version, 1); assert.equal(calls[1].body.data, 'cG5n');
  assert.match(elements.sponsorEditors.innerHTML, /value="Unsaved name"/);
  assert.match(elements.sponsorEditors.innerHTML, /class="sponsor-image"/);
  await controls.remove.onclick();
  const removal = calls.find((call) => call.method === 'DELETE'); assert.equal(removal.body.version, 2);
  assert.doesNotMatch(elements.sponsorEditors.innerHTML, /<img/);
  assert.match(elements.sponsorEditors.innerHTML, /value="Unsaved name"/);
  assert.equal(elements.websiteError.textContent, '');
});
