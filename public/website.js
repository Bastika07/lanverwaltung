'use strict';
/* global api, esc, toast, views, adminViews, adminTabs, homeCards, startHooks, liveHandlers, buildNav, render, markdown, markdownHelp */
// Kein HTML-Editor und keine externen Bilder/Embeds: Inhalte können keine Skripte oder Tracker laden.
const Website = { pages: {}, cookies: null, sponsors: null, dismissed: null };
const WEBSITE_TITLES = { impressum: 'Impressum', datenschutz: 'Datenschutzerklärung', agb: 'AGB', verhaltenskodex: 'Verhaltenskodex' };
const websiteText = (text) => `<div class="website-text markdown">${markdown(text)}</div>`;
function websiteLegalLinks(keys) {
  const links = keys.filter((key) => Website.pages[key]).map((key) => `<a href="#/${key}" target="_blank" rel="noopener">${esc(Website.pages[key].title)} ↗</a>`);
  return links.length ? `<p class="hint">${links.join(' · ')}</p>` : '';
}
const sponsorUrl = (value) => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
function sponsorCards(entries) {
  return `<div class="grid">${entries.map((s) => {
    const url = sponsorUrl(s.url);
    return `<article class="card sponsor-card">${s.tier ? `<span class="badge">${esc(s.tier)}</span>` : ''}<h2>${esc(s.name)}</h2>
      ${websiteText(s.description)}${url ? `<p><a href="${esc(url)}" target="_blank" rel="sponsored noopener noreferrer">Website besuchen ↗</a></p>` : ''}</article>`;
  }).join('')}</div>`;
}
function websiteChrome() {
  const footer = document.getElementById('websiteFooter');
  const links = Object.entries(Website.pages).map(([key, p]) => `<a href="#/${key}">${esc(p.title)}</a>`);
  if (Website.sponsors) links.push('<a href="#/sponsoren">Sponsoren</a>');
  if (Website.cookies) links.push('<a href="#/cookies">Cookie-Hinweis</a>');
  footer.innerHTML = links.join(''); footer.hidden = !links.length;
  const notice = document.getElementById('cookieNotice');
  let acknowledged = Website.dismissed;
  try { acknowledged = sessionStorage.getItem('lan-cookie-notice') || acknowledged; } catch { /* ohne Browserspeicher bedienbar */ }
  notice.hidden = !Website.cookies || acknowledged === Website.cookies.revision;
  document.body.classList.toggle('cookie-notice-open', !notice.hidden);
  if (!Website.cookies) { notice.innerHTML = ''; return; }
  notice.innerHTML = `<h2 id="cookieNoticeTitle">Cookies &amp; Browserspeicher</h2>${websiteText(Website.cookies.text)}
    <p class="hint">Hinweis, keine Einwilligungsabfrage: Die Anwendung lädt keine optionalen Analyse- oder Marketingdienste.</p>
    <div class="row"><a href="#/cookies">Details</a>${Website.pages.datenschutz ? '<a href="#/datenschutz">Datenschutzerklärung</a>' : ''}
      <span class="spacer"></span><button type="button" id="cookieNoticeClose" class="primary">Hinweis schließen</button></div>`;
  document.getElementById('cookieNoticeClose').onclick = () => {
    Website.dismissed = Website.cookies.revision;
    try { sessionStorage.setItem('lan-cookie-notice', Website.dismissed); } catch { /* gilt dann bis zum Neuladen */ }
    websiteChrome();
  };
}
async function loadWebsite() {
  Object.assign(Website, await api('GET', '/website'));
  websiteChrome(); buildNav();
}
startHooks.push(async () => { await loadWebsite().catch(() => {}); });
liveHandlers.push((ev) => { if (ev.type === 'website') loadWebsite().catch(() => {}); });

for (const key of Object.keys(WEBSITE_TITLES)) {
  views[key] = { events: ['website'], async render() {
    await loadWebsite();
    const p = Website.pages[key];
    document.getElementById('app').innerHTML = p ? `<div class="page-head"><h1>${esc(p.title)}</h1></div><article class="card legal-document">${websiteText(p.text)}
      ${p.updatedAt ? `<p class="meta">Stand: ${esc(new Date(p.updatedAt).toLocaleDateString('de-DE'))}</p>` : ''}</article>`
      : '<div class="card"><h1>Seite nicht veröffentlicht</h1><p>Die Orga hat diesen Inhalt noch nicht freigegeben.</p></div>';
  } };
}
views.sponsoren = { label: 'Sponsoren', visible: () => !!Website.sponsors, events: ['website'], async render() {
  await loadWebsite();
  document.getElementById('app').innerHTML = `<div class="page-head"><h1>Sponsoren</h1></div>${Website.sponsors
    ? websiteText(Website.sponsors.text) + sponsorCards(Website.sponsors.entries)
    : '<div class="card">Das Sponsoren-Modul ist nicht veröffentlicht.</div>'}`;
} };
views.cookies = { events: ['website'], async render() {
  await loadWebsite();
  document.getElementById('app').innerHTML = `<div class="page-head"><h1>Cookies &amp; Browserspeicher</h1></div>${Website.cookies ? `<div class="card">
    ${websiteText(Website.cookies.text)}
    <h2>Technisch notwendige Funktionen</h2><ul>
      <li><code>session</code>: Admin-Anmeldung, maximal 7 Tage; HttpOnly, SameSite=Strict.</li>
      <li><code>lan_user</code>: Besucher-Anmeldung mit Discord, maximal 30 Tage; HttpOnly, SameSite=Lax.</li>
      <li><code>lan_state</code>: Schutz des Discord-Anmeldevorgangs, maximal 10 Minuten; HttpOnly, SameSite=Lax, Pfad /api/auth.</li>
      <li>Alle Anmelde-Cookies werden bei HTTPS mit Secure gesetzt. Sie werden nur beim jeweiligen Anmeldevorgang benötigt.</li>
      <li>Lokaler Browserspeicher <code>adminEvent</code>: zuletzt im Admin-Bereich gewähltes Event, bis zum Löschen des Browserspeichers.</li>
      <li>Sitzungsspeicher <code>lan-dismissed</code> und <code>lan-cookie-notice</code>: geschlossene Durchsage und Cookie-Hinweis, für die aktuelle Browser-Tab-Sitzung.</li>
    </ul><p>Die Anwendung lädt keine Analyse-/Marketingdienste und keine externen Sponsorenbilder. Externe Links werden erst beim Anklicken geöffnet.
      Zusätzliche Dienste am Proxy oder eigene spätere Erweiterungen müssen gesondert geprüft werden.</p>
    ${Website.pages.datenschutz ? '<p><a href="#/datenschutz">Zur Datenschutzerklärung</a></p>' : ''}
    <button type="button" id="cookieNoticeReopen">Hinweis erneut anzeigen</button></div>` : '<div class="card">Der Cookie-Hinweis ist nicht aktiviert.</div>'}`;
  const reopen = document.getElementById('cookieNoticeReopen');
  if (reopen) reopen.onclick = () => {
    Website.dismissed = null;
    try { sessionStorage.removeItem('lan-cookie-notice'); } catch { /* Speicher gesperrt */ }
    websiteChrome(); document.getElementById('cookieNoticeClose').focus();
  };
} };
homeCards.push({ order: 95, async render() {
  return Website.sponsors && Website.sponsors.entries.length ? `<section><h2>Unsere Sponsoren</h2>${sponsorCards(Website.sponsors.entries)}</section>` : '';
} });

adminViews.website = { label: 'Website & Rechtliches', order: 85, events: ['website'], async render() {
  const s = await api('GET', '/website/admin');
  const app = document.getElementById('app');
  app.innerHTML = `${adminTabs('website')}<form id="websiteForm" class="editor">
    <div class="card"><h1>Website-Module</h1><p>Diese Einstellungen gelten für <strong>alle Events</strong>. Veröffentlichung ist unabhängig von Event-Modulen und Ticketzugang.</p>
      <p class="hint">Keine Rechtsberatung und keine fertigen Rechtstexte: Inhalte durch die verantwortliche Orga erstellen und prüfen lassen.
      Unveröffentlichte Entwürfe sehen nur Admins. Markdown ermöglicht Formatierung; HTML wird als Text angezeigt, externe Bilder und Skripte sind nicht erlaubt.</p></div>
    ${Object.entries(WEBSITE_TITLES).map(([key, title]) => `<section class="card"><h2>${title}</h2>
      <label class="check"><input id="web_${key}_on" type="checkbox" ${s.pages[key].enabled ? 'checked' : ''}> Modul veröffentlichen (öffentlich im Footer)</label>
      <div class="field"><label for="web_${key}_text">Inhalt (Markdown)</label><textarea id="web_${key}_text" class="legal-editor" maxlength="60000">${esc(s.pages[key].text)}</textarea>${markdownHelp(`web_${key}_text`)}</div></section>`).join('')}
    <section class="card"><h2>Cookie-Banner</h2>
      <label class="check"><input id="web_cookies_on" type="checkbox" ${s.cookies.enabled ? 'checked' : ''}> Cookie-Hinweis und Detailseite aktivieren</label>
      <p class="hint">Nur notwendige Cookies/Browserspeicher, keine optionalen Tracker: schließbarer Hinweis statt „Alle akzeptieren“.
        Das Schließen wird nur für die Tab-Sitzung gespeichert; Änderungen am Hinweis oder veröffentlichten Datenschutztext zeigen ihn erneut.
        Bei künftigen optionalen Diensten ist vor deren Laden eine echte Einwilligungssteuerung erforderlich.</p>
      <div class="field"><label for="web_cookie_text">Hinweistext (Markdown)</label><textarea id="web_cookie_text" maxlength="3000">${esc(s.cookies.text)}</textarea>${markdownHelp('web_cookie_text')}</div></section>
    <section class="card"><h2>Sponsoren</h2>
      <label class="check"><input id="web_sponsors_on" type="checkbox" ${s.sponsors.enabled ? 'checked' : ''}> Sponsoren auf Startseite und eigener Seite veröffentlichen</label>
      <div class="field"><label for="web_sponsor_text">Einleitung (Markdown)</label><textarea id="web_sponsor_text" maxlength="5000">${esc(s.sponsors.text)}</textarea>${markdownHelp('web_sponsor_text')}</div>
      <p class="hint">Name, Kategorie, Beschreibung und optionaler HTTPS-Link. Keine extern geladenen Logos oder Tracker. Reihenfolge per Pfeil ändern.</p>
      <div id="sponsorEditors"></div><button type="button" id="sponsorAdd">Sponsor hinzufügen</button></section>
    <div class="card"><p class="hint">AGB und Verhaltenskodex werden als Informationsseiten veröffentlicht. Dieses Modul erfasst keine vertragliche Zustimmung beim Ticketkauf.</p>
      <p class="error" id="websiteError" role="alert"></p><button type="submit" class="primary big">Website-Module speichern</button></div></form>`;
  let entries = structuredClone(s.sponsors.entries);
  const editors = document.getElementById('sponsorEditors');
  function readEntries() {
    return [...editors.querySelectorAll('[data-sponsor]')].map((box) => {
      const value = (key) => box.querySelector(`[data-field="${key}"]`).value;
      return { name: value('name'), tier: value('tier'), url: value('url'), description: value('description'), enabled: box.querySelector('[data-field="enabled"]').checked };
    });
  }
  function drawEntries() {
    editors.innerHTML = entries.map((entry, i) => `<fieldset class="sponsor-editor" data-sponsor="${i}"><legend>Sponsor ${i + 1}</legend>
      <label class="check"><input type="checkbox" data-field="enabled" ${entry.enabled ? 'checked' : ''}> Sichtbar bei veröffentlichtem Modul</label>
      <div class="row two-inputs"><div class="field"><label for="sponsor_${i}_name">Name</label><input id="sponsor_${i}_name" data-field="name" maxlength="120" required value="${esc(entry.name)}"></div>
      <div class="field"><label for="sponsor_${i}_tier">Kategorie (z. B. Gold)</label><input id="sponsor_${i}_tier" data-field="tier" maxlength="80" value="${esc(entry.tier)}"></div></div>
      <div class="field"><label for="sponsor_${i}_url">HTTPS-Link (optional)</label><input id="sponsor_${i}_url" data-field="url" type="url" maxlength="1000" value="${esc(entry.url)}" placeholder="https://..."></div>
      <div class="field"><label for="sponsor_${i}_description">Beschreibung (Markdown)</label><textarea id="sponsor_${i}_description" data-field="description" maxlength="2000">${esc(entry.description)}</textarea>${markdownHelp(`sponsor_${i}_description`)}</div>
      <div class="row"><button type="button" data-move="up" aria-label="Sponsor ${i + 1} nach oben" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" data-move="down" aria-label="Sponsor ${i + 1} nach unten" ${i === entries.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" data-remove class="danger">Entfernen</button></div></fieldset>`).join('');
    editors.querySelectorAll('[data-sponsor]').forEach((box, i) => {
      box.querySelector('[data-remove]').onclick = () => { if (!confirm('Sponsor aus diesem Entwurf entfernen? Wirksam nach dem Speichern.')) return; entries = readEntries(); entries.splice(i, 1); drawEntries(); };
      box.querySelectorAll('[data-move]').forEach((button) => { button.onclick = () => {
        entries = readEntries(); const j = i + (button.dataset.move === 'up' ? -1 : 1);
        if (j >= 0 && j < entries.length) { [entries[i], entries[j]] = [entries[j], entries[i]]; drawEntries(); }
      }; });
    });
    document.getElementById('sponsorAdd').disabled = entries.length >= 40;
  }
  drawEntries();
  document.getElementById('sponsorAdd').onclick = () => { entries = readEntries(); if (entries.length < 40) entries.push({ name: '', tier: '', url: '', description: '', enabled: true }); drawEntries(); };
  document.getElementById('websiteForm').onsubmit = async (event) => {
    event.preventDefault();
    const error = document.getElementById('websiteError'); error.textContent = '';
    const button = event.target.querySelector('[type="submit"]'); button.disabled = true;
    try {
      const result = await api('PUT', '/website/admin', { version: s.version,
        pages: Object.fromEntries(Object.keys(WEBSITE_TITLES).map((key) => [key, { enabled: document.getElementById(`web_${key}_on`).checked, text: document.getElementById(`web_${key}_text`).value }])),
        cookies: { enabled: document.getElementById('web_cookies_on').checked, text: document.getElementById('web_cookie_text').value },
        sponsors: { enabled: document.getElementById('web_sponsors_on').checked, text: document.getElementById('web_sponsor_text').value, entries: readEntries() },
      });
      s.version = result.version;
      await loadWebsite(); toast('Website-Module gespeichert');
    } catch (err) { error.textContent = err.message; } finally { button.disabled = false; }
  };
} };
