'use strict';
/* global api, esc, toast, views, adminViews, adminTabs, homeCards, beamerSlides, render, markdown, markdownHelp */
// Info-Bereich: WLAN, Gameserver, Spieleliste, Hausregeln.

// Nur http(s)-Links zulassen (kein javascript:, data: …)
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);

// Gemeinsame Markdown-Darstellung für die Freitextfelder.
function richText(s) {
  return markdown(s);
}

// Kopieren – auch ohne HTTPS (dort fehlt navigator.clipboard)
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* Rückfall unten */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

const copyBtn = (value, label = 'Kopieren') => (value ? `<button class="small copy" data-copy="${esc(value)}" title="${label}">📋</button>` : '');

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  toast((await copyText(b.dataset.copy)) ? 'Kopiert' : 'Kopieren nicht möglich – bitte markieren');
});

const hasWifi = (i) => i.wifi && i.wifi.ssid;

function wifiBlock(i) {
  if (!hasWifi(i)) return '';
  return `<div class="card info-wifi"><h2>📶 WLAN</h2>
    <dl class="kv">
      <dt>Name</dt><dd><code>${esc(i.wifi.ssid)}</code> ${copyBtn(i.wifi.ssid)}</dd>
      ${i.wifi.password ? `<dt>Passwort</dt><dd><code>${esc(i.wifi.password)}</code> ${copyBtn(i.wifi.password)}</dd>` : ''}
    </dl>${i.wifi.note ? `<div class="meta markdown">${richText(i.wifi.note)}</div>` : ''}</div>`;
}

function serverTable(i) {
  if (!i.servers.length) return '';
  return `<div class="card"><h2>🖥️ Gameserver</h2><div style="overflow-x:auto"><table class="info-table"><thead><tr><th>Server</th><th>Adresse</th><th>Passwort</th></tr></thead><tbody>
    ${i.servers.map((s) => `<tr><td><strong>${esc(s.name)}</strong>${s.game ? `<div class="meta">${esc(s.game)}</div>` : ''}${s.note ? `<div class="meta markdown">${richText(s.note)}</div>` : ''}</td>
      <td class="nowrap"><code>${esc(s.address)}</code> ${copyBtn(s.address)}</td>
      <td class="nowrap">${s.password ? `<code>${esc(s.password)}</code> ${copyBtn(s.password)}` : '<span class="meta">–</span>'}</td></tr>`).join('')}
  </tbody></table></div></div>`;
}

views.infos = {
  label: 'Infos', module: 'info', events: ['info'],
  async render() {
    const i = await api('GET', '/info');
    const empty = !hasWifi(i) && !i.servers.length && !i.games.length && !i.rules && !i.extra;
    document.getElementById('app').innerHTML = `<div class="page-head"><h1>Infos</h1></div>
      ${empty ? '<div class="empty">Noch keine Infos eingetragen.</div>' : `<div class="two">
        <div>${wifiBlock(i)}${serverTable(i)}
          ${i.extra ? `<div class="card"><h2>ℹ️ Sonstiges</h2><div class="markdown">${richText(i.extra)}</div></div>` : ''}</div>
        <div>
          ${i.games.length ? `<div class="card"><h2>🎮 Spiele</h2><p class="meta">Bitte vorher installieren und aktualisieren.</p><ul class="games">
            ${i.games.map((g) => `<li><strong>${esc(g.name)}</strong>${safeUrl(g.link) ? ` <a href="${esc(safeUrl(g.link))}" target="_blank" rel="noopener noreferrer">↗</a>` : ''}${g.note ? `<div class="meta markdown">${richText(g.note)}</div>` : ''}</li>`).join('')}
          </ul></div>` : ''}
          ${i.rules ? `<div class="card"><h2>📜 Hausregeln</h2><div class="markdown">${richText(i.rules)}</div></div>` : ''}
        </div></div>`}`;
  },
};

// Startseite: WLAN auf einen Blick
homeCards.push({
  module: 'info', order: 30,
  async render() {
    const i = await api('GET', '/info');
    if (!hasWifi(i)) return '';
    return `<div class="card info-strip">📶 <strong>WLAN</strong> <code>${esc(i.wifi.ssid)}</code>
      ${i.wifi.password ? `· Passwort <code>${esc(i.wifi.password)}</code> ${copyBtn(i.wifi.password)}` : ''}
      <a href="#/infos" class="meta" style="margin-left:auto">Alle Infos →</a></div>`;
  },
});

beamerSlides.push({
  module: 'info', order: 40,
  async build() {
    const i = await api('GET', '/info');
    if (!hasWifi(i) && !i.servers.length) return [];
    return [{
      title: 'ℹ️ Infos',
      width: 1100,
      html: `<div class="beamer-info">
        ${hasWifi(i) ? `<div class="bi-block"><div class="bi-label">📶 WLAN</div><div class="bi-big">${esc(i.wifi.ssid)}</div>
          ${i.wifi.password ? `<div class="bi-label">Passwort</div><div class="bi-big">${esc(i.wifi.password)}</div>` : ''}</div>` : ''}
        ${i.servers.length ? `<div class="bi-block"><div class="bi-label">🖥️ Gameserver</div>${i.servers.slice(0, 6).map((s) =>
          `<div class="bi-row"><strong>${esc(s.name)}</strong> <code>${esc(s.address)}</code>${s.password ? ` · PW <code>${esc(s.password)}</code>` : ''}</div>`).join('')}</div>` : ''}
      </div>`,
    }];
  },
});

// ---------- Admin ----------
// Editierbare Liste: Zeilen mit Feldern, + und ✕
let listEditorId = 0;
function listEditor(id, rows, fields) {
  const row = (r = {}, uid = 'LIST_ROW_ID') => `<div class="le-row">${fields.map((f) => f.key === 'note'
    ? `<div class="le-note" style="flex:${f.flex || 1}"><textarea id="${uid}_note" class="short" data-f="note" aria-label="${esc(f.label)} (Markdown)" placeholder="${esc(f.label)} (Markdown)">${esc(r[f.key] || '')}</textarea>${markdownHelp(`${uid}_note`)}</div>`
    : `<input data-f="${f.key}" placeholder="${esc(f.label)}" value="${esc(r[f.key] || '')}" style="flex:${f.flex || 1}">`).join('')}
    <button type="button" class="small danger le-del" title="Entfernen">✕</button></div>`;
  return `<div class="list-editor" id="${id}" data-template="${esc(row())}">${rows.map((r) => row(r, `${id}_${++listEditorId}`)).join('')}</div>
    <button type="button" class="small le-add" data-for="${id}">+ Hinzufügen</button>`;
}

function readList(id) {
  return [...document.querySelectorAll(`#${id} .le-row`)].map((r) =>
    Object.fromEntries([...r.querySelectorAll('[data-f]')].map((i) => [i.dataset.f, i.value.trim()])));
}

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('le-del')) e.target.closest('.le-row').remove();
  if (e.target.classList.contains('le-add')) {
    const box = document.getElementById(e.target.dataset.for);
    box.insertAdjacentHTML('beforeend', box.dataset.template.replaceAll('LIST_ROW_ID', `${box.id}_${++listEditorId}`));
    box.lastElementChild.querySelector('input').focus();
  }
});

adminViews.infos = {
  label: 'Infos', module: 'info', order: 40,
  async render() {
    const i = await api('GET', '/info');
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('infos')}
      <form id="infoForm" class="editor">
        <div class="two">
          <div>
            <div class="card"><h2>📶 WLAN</h2>
              <div class="row two-inputs">
                <div class="field"><label for="wSsid">Name (SSID)</label><input id="wSsid" value="${esc(i.wifi.ssid)}"></div>
                <div class="field"><label for="wPw">Passwort</label><input id="wPw" value="${esc(i.wifi.password)}"></div>
              </div>
              <div class="field"><label for="wNote">Hinweis (Markdown)</label><textarea id="wNote" class="short" placeholder="z. B. Kabel bevorzugt, Switch unter dem Tisch">${esc(i.wifi.note)}</textarea>${markdownHelp('wNote')}</div>
            </div>
            <div class="card"><h2>🖥️ Gameserver</h2>
              ${listEditor('servers', i.servers, [{ key: 'name', label: 'Name', flex: 1.2 }, { key: 'game', label: 'Spiel' }, { key: 'address', label: 'IP:Port', flex: 1.3 }, { key: 'password', label: 'Passwort' }, { key: 'note', label: 'Hinweis', flex: 1.4 }])}
            </div>
            <div class="card"><h2>ℹ️ Sonstiges</h2><label for="iExtra">Inhalt (Markdown)</label><textarea id="iExtra" class="short">${esc(i.extra)}</textarea>${markdownHelp('iExtra')}</div>
          </div>
          <div>
            <div class="card"><h2>🎮 Spiele</h2>
              ${listEditor('games', i.games, [{ key: 'name', label: 'Spiel', flex: 1.2 }, { key: 'note', label: 'Hinweis (z. B. Version, Mods)', flex: 2 }, { key: 'link', label: 'Link', flex: 1.4 }])}
            </div>
            <div class="card"><h2>📜 Hausregeln</h2><label for="iRules">Regeln (Markdown)</label><textarea id="iRules" class="short">${esc(i.rules)}</textarea>${markdownHelp('iRules')}</div>
          </div>
        </div>
        <p class="error" id="iError"></p>
        <button type="submit" class="primary big">Infos speichern</button>
      </form>`;
    document.getElementById('infoForm').onsubmit = async (e) => {
      e.preventDefault();
      const v = (id) => document.getElementById(id).value;
      try {
        await api('PUT', '/info', {
          wifi: { ssid: v('wSsid'), password: v('wPw'), note: v('wNote') },
          servers: readList('servers'), games: readList('games'), rules: v('iRules'), extra: v('iExtra'),
        });
        toast('Infos gespeichert');
        document.activeElement.blur();
        render();
      } catch (err) { document.getElementById('iError').textContent = err.message; }
    };
  },
};
