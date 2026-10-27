'use strict';
/* global Bracket */

const app = document.getElementById('app');
const state = { admin: false, discord: false, settings: { modules: {} }, route: null, tournament: null, readOnly: false };

// ---------- Modul-Registry ----------
// Die Module (announce.js, schedule.js …) tragen hier ihre Seiten, Admin-Reiter,
// Karten für die Startseite und Folien für den Beamer ein.
const views = {};      // views[name] = { label, module, render(id), events: [...] }
const adminViews = {}; // adminViews[name] = { label, module, order, render(id), events: [...] }
const homeCards = [];  // { module, order, render: async () => html, bind?: () => void }
const enabledMod = (key) => !key || !!state.settings.modules[key];
// Für mich sichtbar: Modul an und öffentlich – oder ich bin Admin bzw. Teilnehmer mit Ticket
const on = (key) => enabledMod(key) && (state.admin || state.member || (state.access || {})[key] !== 'tickets');
const lockedMod = (key) => enabledMod(key) && !on(key); // an, aber nur für Teilnehmer mit Ticket
const startHooks = []; // Module: beim Start einmal ausführen (z. B. aktive Durchsage laden)
const beamerSlides = []; // { module, order, build: async () => [{ title, html, wide? }] }

// Countdown-Anzeigen: Elemente mit data-countdown="<ISO-Zeit>" werden jede Sekunde aktualisiert
function countdownText(iso) {
  let sec = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (sec <= 0) return 'jetzt';
  const h = Math.floor(sec / 3600); sec -= h * 3600;
  const m = Math.floor(sec / 60); sec -= m * 60;
  if (h >= 24) { const d = Math.floor(h / 24); return `in ${d} ${d === 1 ? 'Tag' : 'Tagen'}${h % 24 ? ` ${h % 24} Std` : ''}`; }
  if (h > 0) return `in ${h} Std ${String(m).padStart(2, '0')} Min`;
  if (m >= 10) return `in ${m} Min`;
  return `in ${m}:${String(sec).padStart(2, '0')} Min`;
}
setInterval(() => {
  document.querySelectorAll('[data-countdown]').forEach((el) => { el.textContent = countdownText(el.dataset.countdown); });
}, 1000);

// ---------- Hilfen ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Event, auf das sich Anfragen beziehen (siehe lib/event.js): im Admin-Bereich das dort gewählte,
// auf der Ticketseite das gewählte Vorverkaufs-Event, sonst bestimmt der Server das aktuelle.
function scopeEventId() {
  const v = state.route ? state.route.view : '';
  if (state.admin && (v.startsWith('admin') || v === 'tournament')) return adminEvent() ? adminEvent().id : null;
  if (v === 'tickets') return state.ticketEvent;
  if (v === 'event') return state.detailsEvent;
  return null;
}

async function api(method, url, body) {
  const ev = scopeEventId();
  const res = await fetch('/api' + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(ev ? { 'X-Event': ev } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler ' + res.status);
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

const TYPE_LABELS = { ko: 'Single Elimination', de: 'Double Elimination', rr: 'Jeder gegen jeden' };
function typeLabel(type) { return TYPE_LABELS[type] || TYPE_LABELS.ko; }

function statusBadge(s) {
  if (s.status === 'draft') return '<span class="badge draft">Entwurf</span>';
  if (s.finished) return '<span class="badge finished">Beendet</span>';
  return '<span class="badge running">Läuft</span>';
}

function pname(t, idx) {
  if (idx === undefined) return null;
  if (idx === null) return 'Freilos';
  return t.participants[idx];
}

// ---------- Routing ----------
function parseRoute() {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const r = parseParts(parts);
  r.query = new URLSearchParams(query || '');
  return r;
}

function parseParts(parts) {
  if (parts[0] === 't' && parts[1]) return { view: 'tournament', id: parts[1] };
  if (parts[0] === 'admin') {
    if (parts[1] === 't' && parts[2]) return { view: 'adminEdit', id: parts[2] };
    if (parts[1] && adminViews[parts[1]]) return { view: 'admin:' + parts[1], name: parts[1], id: parts[2] };
    return { view: 'admin' };
  }
  if (parts[0] && views[parts[0]] && on(views[parts[0]].module)) return { view: parts[0], id: parts[1] };
  if (parts[0] && views[parts[0]] && lockedMod(views[parts[0]].module)) return { view: 'locked', name: parts[0] };
  return { view: 'home' };
}

// Navigation nach aktiven Modulen
function buildNav() {
  const items = [{ href: '#/', label: 'Start', views: ['home', 'tournament'] }];
  for (const [name, v] of Object.entries(views)) {
    if (v.visible && !v.visible()) continue;
    if (v.label && on(v.module)) items.push({ href: '#/' + name, label: v.label, views: [name] });
    else if (v.label && lockedMod(v.module)) items.push({ href: '#/' + name, label: '🔒 ' + v.label, views: [] });
  }
  items.push({ href: '#/admin', label: 'Admin', admin: true });
  const cur = state.route ? state.route.view : 'home';
  document.getElementById('nav').innerHTML = items.map((i) => {
    const active = i.admin ? cur.startsWith('admin') : i.views.includes(cur);
    return `<a href="${i.href}" class="${active ? 'active' : ''}">${esc(i.label)}</a>`;
  }).join('');
  const name = state.settings.eventName || 'LAN-Party';
  document.getElementById('brand').textContent = '🎮 ' + name;
  document.title = name;
}

// Neuzeichnen serialisieren: nie zwei gleichzeitig (sonst überschreibt ein älteres Ergebnis
// ein neueres); Anfragen während eines laufenden Durchgangs werden zu einem zusammengefasst.
let renderRunning = null, renderAgain = false;
async function render() {
  if (renderRunning) { renderAgain = true; return renderRunning; }
  renderRunning = doRender();
  try { await renderRunning; } finally {
    renderRunning = null;
    if (renderAgain) { renderAgain = false; await render(); }
  }
}

async function doRender() {
  state.route = parseRoute();
  const r = state.route;
  buildNav();
  app.classList.toggle('wide', r.view === 'tournament' || r.view === 'leute');
  document.body.classList.toggle('beamer-mode', r.view === 'beamer');
  state.readOnly = r.view === 'beamer';
  if (r.view !== 'beamer' && typeof stopBeamer === 'function') stopBeamer();
  try {
    if (r.view === 'home') await renderHome();
    else if (r.view === 'tournament') await renderTournament(r.id);
    else if (r.view === 'admin') await renderAdmin();
    else if (r.view === 'adminEdit') await renderAdminEdit(r.id);
    else if (r.view === 'locked') renderLocked(r.name);
    else if (r.view.startsWith('admin:')) {
      if (!state.admin) renderLogin();
      else await adminViews[r.name].render(r.id);
    } else await views[r.view].render(r.id);
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p><a href="#/">Zur Übersicht</a></div>`;
  }
}

// ---------- Events im Admin-Bereich ----------
// Der Admin wählt, welches Event er bearbeitet (Turniere, Programm, Tickets …). Ohne Wahl: das aktuelle.
const evLabel = (e, list) => `${e.name}${e.active ? ' · läuft' : e.over ? ' · vorbei' : e.start && Date.parse(e.start) > Date.now() ? ' · geplant' : ' · nicht gestartet'}`
  + (e.id === list.currentId && !e.active ? ' · für Besucher' : '');
function adminEvent() {
  const list = state.events;
  if (!list) return null;
  return list.events.find((e) => e.id === state.adminEventId) || list.events.find((e) => e.id === list.currentId) || null;
}
function setAdminEvent(id) {
  state.adminEventId = id;
  try { localStorage.setItem('adminEvent', id); } catch { /* Speicher gesperrt */ }
}
try { state.adminEventId = localStorage.getItem('adminEvent'); } catch { /* Speicher gesperrt */ }
async function loadEvents() { state.events = state.admin ? await api('GET', '/event').catch(() => null) : null; }

// Reiterleiste im Admin-Bereich
function adminTabs(active) {
  const tabs = [{ name: '', label: 'Turniere', module: 'tournaments', order: 0 },
    ...Object.entries(adminViews).map(([name, v]) => ({ name, ...v }))].sort((a, b) => a.order - b.order);
  const list = state.events, cur = adminEvent();
  const evOn = (key) => !key || (cur && cur.modules ? !!cur.modules[key] && (key !== 'seating' || !!cur.modules.people) : on(key)); // Module des bearbeiteten Events
  const other = list && cur && cur.id !== list.currentId ? list.events.find((e) => e.id === list.currentId) : null;
  return `${list ? `<div class="event-bar ${other ? 'other' : ''}">
      <label>🎮 Du bearbeitest <select id="evSwitch">${list.events.map((e) => `<option value="${e.id}" ${e === cur ? 'selected' : ''}>${esc(evLabel(e, list))}</option>`).join('')}</select></label>
      ${other ? `<span class="meta">Besucher sehen gerade „${esc(other.name)}“.</span>` : ''}
      <a href="#/admin/events" class="small btn">Events verwalten</a></div>` : ''}
    <nav class="admin-tabs">${tabs.map((t) => `<a href="#/admin${t.name ? '/' + t.name : ''}" class="${t.name === active ? 'active' : ''} ${evOn(t.module) ? '' : 'off'}"
    title="${evOn(t.module) ? '' : 'Modul in diesem Event ausgeschaltet – für Besucher unsichtbar'}">${esc(t.label)}</a>`).join('')}
    <span class="spacer"></span><button id="logout" class="small">Abmelden</button></nav>`;
}
document.addEventListener('click', (e) => { if (e.target.id === 'logout') logout(); });
document.addEventListener('change', (e) => { if (e.target.id === 'evSwitch') { setAdminEvent(e.target.value); render(); } });

// Modul nur für Teilnehmer mit Ticket: Hinweis statt Inhalt
function renderLocked(name) {
  const v = views[name];
  app.innerHTML = `<div class="card" style="max-width:460px;margin:40px auto;text-align:center">
    <h2>🔒 ${esc(v.label)}</h2>
    <p>Das gibt es nur für Teilnehmer mit Ticket.</p>
    ${state.userLogin ? '<a class="btn primary big discord-btn" href="/api/auth/login">Mit Discord anmelden</a>' : ''}
    <p class="hint">Angemeldet und trotzdem gesperrt? Dann gehört dein Discord-Konto noch zu keinem Ticket – verknüpfe dich im Discord mit <code>/ich</code> oder frag die Orga.</p>
  </div>`;
}

// ---------- Übersicht ----------
async function renderHome() {
  const cards = homeCards.filter((c) => on(c.module)).sort((a, b) => a.order - b.order);
  const cardHtml = await Promise.all(cards.map((c) => c.render().catch(() => '')));
  const tournamentsOn = on('tournaments');
  const list = tournamentsOn ? (await api('GET', '/tournaments')).filter((t) => t.status !== 'draft') : [];
  const running = list.filter((t) => !t.finished);
  const done = list.filter((t) => t.finished);
  const now = nowPlaying(await loadFull(running));
  const section = (title, items) => (items.length
    ? `<h2 class="section-title">${title} (${items.length})</h2><div class="grid">${items.map(tournamentCard).join('')}</div>` : '');
  app.innerHTML = `
    <div class="page-head"><h1>${esc(state.settings.eventName || 'LAN-Party')}</h1></div>
    ${eventCountdown()}
    ${cardHtml.join('')}
    ${now.length ? `<div class="card now-card">
      <h2>⚔️ Jetzt dran <span class="meta">(${now.length})</span></h2>
      <div class="now-list">${now.map(nowItem).join('')}</div>
      <p class="hint">Klick auf ein Spiel, um das Ergebnis einzutragen.</p>
    </div>` : ''}
    ${!tournamentsOn ? '' : list.length ? section('Laufende Turniere', running) + section('Beendete Turniere', done)
      : '<div class="empty">Noch keine Turniere gestartet.</div>'}`;
  bindNowItems(now);
  for (const c of cards) if (c.bind) c.bind();
}

// Vor der LAN: Countdown bis zum Beginn
function eventCountdown() {
  const ev = state.settings.event;
  if (!ev || ev.active || !ev.start || Date.parse(ev.start) <= Date.now()) return '';
  const when = new Date(ev.start).toLocaleString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return `<div class="card event-countdown">⏳ <strong>${esc(state.settings.eventName)}</strong> beginnt
    <span class="countdown" data-countdown="${ev.start}">${countdownText(ev.start)}</span> <span class="meta">(${esc(when)})</span></div>`;
}

// ---------- "Jetzt dran" ----------
const loadFull = (summaries) => Promise.all(summaries.map((s) => api('GET', '/tournaments/' + s.id)));

// Alle spielbaren Spiele über alle laufenden Turniere
function nowPlaying(tournaments) {
  return tournaments.flatMap((t) => Bracket.playable(Bracket.compute(t)).map((m) => ({ t, m })));
}

function nowItem({ t, m }, i) {
  return `<button class="now-item" data-now="${i}">
    <span class="now-where">${esc(t.name)} · ${esc(m.label)}</span>
    <span class="now-vs"><strong>${esc(pname(t, m.a))}</strong> <span class="vs">vs</span> <strong>${esc(pname(t, m.b))}</strong></span>
  </button>`;
}

function bindNowItems(now) {
  app.querySelectorAll('[data-now]').forEach((el) => {
    if (state.readOnly) return;
    const { t, m } = now[Number(el.dataset.now)];
    el.addEventListener('click', () => { state.tournament = t; openMatchDialog(t, m); });
  });
}

function tournamentCard(t) {
  return `<a class="card tcard" href="#/t/${t.id}">
    <div class="row" style="justify-content:space-between"><h3>${esc(t.name)}</h3>${statusBadge(t)}</div>
    <div class="meta">${t.game ? esc(t.game) + ' · ' : ''}${typeLabel(t.type)} · ${t.participants} Teilnehmer</div>
    ${t.champion ? `<div style="margin-top:8px">🏆 <strong>${esc(t.champion)}</strong></div>` : ''}
  </a>`;
}

// ---------- Turnieransicht ----------
async function renderTournament(id) {
  const t = await api('GET', '/tournaments/' + id);
  state.tournament = t;
  if (t.status === 'draft') {
    app.innerHTML = `<div class="page-head"><div><h1>${esc(t.name)}</h1>
      <div class="meta">Entwurf – noch nicht gestartet.</div></div>
      ${state.admin ? `<a class="btn" href="#/admin/t/${t.id}">Bearbeiten</a>` : ''}</div>`;
    return;
  }
  const view = Bracket.compute(t);
  const scrollLefts = [...app.querySelectorAll('.bracket-wrap')].map((w) => w.scrollLeft);

  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(t.name)}</h1>
        <div class="meta">${t.game ? esc(t.game) + ' · ' : ''}${typeLabel(t.type)} · ${t.participants.length} Teilnehmer</div>
      </div>
      <div class="row">
        ${view.finished ? '<span class="badge finished">Beendet</span>' : '<span class="badge running">Läuft</span>'}
        ${on('beamer') ? `<a class="btn" href="#/beamer/${t.id}" title="Vollbild-Ansicht für Beamer/Leinwand">📺 Beamer</a>` : ''}
        ${state.admin ? `<a class="btn" href="#/admin/t/${t.id}">Bearbeiten</a>` : ''}
      </div>
    </div>
    ${podium(t, view)}
    ${state.admin ? '<p class="admin-note">🛠️ Admin-Modus: Klicke auf ein beliebiges gespieltes Spiel, um das Ergebnis zu korrigieren oder zu löschen.</p>' : ''}
    ${!state.admin ? `<p class="hint">Ergebnisse dürfen nur angemeldete, verknüpfte Spieler dieses Spiels eintragen. ${state.userLogin ? '<a href="/api/auth/login">Mit Discord anmelden</a> · ' : ''}Discord-Verknüpfung: <code>/ich</code> mit eigenem Ticket oder Ticketcode; ohne Ticket hilft die Orga.</p>` : ''}
    ${!view.finished ? `<p class="hint" style="margin-bottom:14px">Auf ein <strong>gelb markiertes</strong> Spiel klicken, um das Ergebnis einzutragen.${state.admin ? '' : ' Eingetragene Ergebnisse sind gesperrt und können nur von der Turnierleitung geändert werden.'}</p>` : ''}
    <div id="board"></div>`;

  const board = document.getElementById('board');
  if (view.type === 'ko') renderKO(board, t, view);
  else if (view.type === 'de') renderDE(board, t, view);
  else renderRR(board, t, view);
  app.querySelectorAll('.bracket-wrap').forEach((w, i) => { w.scrollLeft = scrollLefts[i] || 0; });
  const teams = await teamsCard(t);
  if (teams) board.insertAdjacentHTML('afterend', teams);
}

// Team-Mitglieder (über Discord gegründete/beigetretene Teams)
async function teamsCard(t) {
  if ((t.teamSize || 1) <= 1 || !t.members || !Object.keys(t.members).length || !on('people')) return '';
  const { people } = await api('GET', '/people').catch(() => ({ people: [] }));
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  return `<div class="card" style="margin-top:16px"><h2>👥 Teams</h2><div class="teams">${t.participants.map((team) => {
    const m = (t.members[team] || []).map((id) => byId[id]).filter(Boolean);
    return `<div class="team"><strong>${esc(team)}</strong> <span class="meta">(${m.length}/${t.teamSize})</span>
      <div class="meta">${m.map((p, i) => esc(p.name) + (i === 0 ? ' 👑' : '')).join(', ') || '–'}</div></div>`;
  }).join('')}</div></div>`;
}

function podium(t, view) {
  if (!view.finished || !view.placements.length) return '';
  const medals = { 1: '🥇', 2: '🥈', 3: '🥉', 4: '' };
  return `<div class="podium">${view.placements.map((p) => `
    <div class="place p${p.place}">
      <div class="l">${medals[p.place] || ''} Platz ${p.place}</div>
      <div class="n">${esc(t.participants[p.p])}</div>
    </div>`).join('')}</div>`;
}

function canEdit(m) {
  if (state.readOnly || state.tournament.status !== 'running') return false;
  if (m.status === 'ready') return state.admin || (state.tournament.reportableMatches || []).includes(m.id);
  return state.admin && m.status === 'done';
}

// --- Turnierbäume (Single & Double Elimination) ---
const COL_W = 210, GAP_X = 56, BOX_H = 62, UNIT = 82, TOP = 34;
const colX = (r) => r * (COL_W + GAP_X);

function matchBox(t, m, x, y) {
  const cls = ['match', m.status];
  if (m.status === 'bye' && m.a === null && m.b === null) cls.push('empty');
  if (canEdit(m)) cls.push('clickable');
  const slot = (idx, side, hint) => {
    const name = pname(t, idx);
    const c = ['slot'];
    if (name === null) c.push('tbd');
    if (m.status === 'done') c.push(m.winner === idx ? 'win' : 'lose');
    if (m.status === 'bye' && m.winner === idx && idx !== null) c.push('win');
    const label = name ?? (m.status === 'skip' ? 'entfällt' : hint || 'offen');
    return `<div class="${c.join(' ')}"><span class="name" title="${esc(label)}">${esc(label)}</span>
      <span class="score">${m.score ? m.score[side] : ''}</span></div>`;
  };
  return `<div class="${cls.join(' ')}" data-match="${m.id}" style="left:${x}px;top:${y - BOX_H / 2}px;width:${COL_W}px;height:${BOX_H}px">
    ${slot(m.a, 'a', m.hintA)}${slot(m.b, 'b', m.hintB)}</div>`;
}

// Zeichnet einen Baum. centerY(r, i) liefert die vertikale Mitte, feeds(r, i) die Vorgänger-Spiele.
function drawTree(t, { rounds, names, centerY, feeds, extra = '', minHeight = 0 }) {
  let html = '', paths = '', height = minHeight;
  names.forEach((n, r) => {
    html += `<div class="round-title" style="left:${colX(r)}px;width:${COL_W}px">${esc(n)}</div>`;
  });
  rounds.forEach((list, r) => {
    list.forEach((m, i) => {
      const y = centerY(r, i);
      height = Math.max(height, y + BOX_H / 2 + 10);
      html += matchBox(t, m, colX(r), y);
      for (const [pr, pi] of feeds(r, i)) {
        const prev = rounds[pr][pi];
        const y1 = centerY(pr, pi);
        const x1 = colX(pr) + COL_W;
        const xm = x1 + GAP_X / 2;
        const hot = prev.winner !== undefined && prev.winner !== null;
        paths += `<path class="${hot ? 'hot' : ''}" d="M${x1} ${y1} H${xm} V${y} H${colX(r)}"/>`;
      }
    });
  });
  const width = colX(rounds.length - 1) + COL_W;
  return `<div class="bracket-wrap"><div class="bracket" style="width:${width}px;height:${height}px">
    <svg class="lines" width="${width}" height="${height}">${paths}</svg>${html}${extra}</div></div>`;
}

const halving = (r, i) => (r > 0 ? [[r - 1, 2 * i], [r - 1, 2 * i + 1]] : []);

function renderKO(board, t, view) {
  const centerY = (r, i) => TOP + (i + 0.5) * UNIT * Math.pow(2, r);
  const last = view.totalRounds - 1;
  let extra = '', minHeight = 0;
  if (view.third) {
    const y = centerY(last, 0) + BOX_H + 56;
    extra = `<div class="match-label" style="left:${colX(last)}px;top:${y - BOX_H / 2 - 20}px">Spiel um Platz 3</div>`
      + matchBox(t, view.third, colX(last), y);
    minHeight = y + BOX_H / 2 + 10;
  }
  board.innerHTML = drawTree(t, { rounds: view.rounds, names: view.roundNames, centerY, feeds: halving, extra, minHeight });
  bindMatchClicks(board, t, view);
}

function renderDE(board, t, view) {
  const wb = drawTree(t, {
    rounds: view.rounds, names: view.roundNames, feeds: halving,
    centerY: (r, i) => TOP + (i + 0.5) * UNIT * Math.pow(2, r),
  });
  const lb = view.losers.length ? drawTree(t, {
    rounds: view.losers, names: view.loserNames,
    centerY: (r, i) => TOP + (i + 0.5) * UNIT * Math.pow(2, Math.floor(r / 2)),
    feeds: (r, i) => (r === 0 ? [] : r % 2 === 1 ? [[r - 1, i]] : [[r - 1, 2 * i], [r - 1, 2 * i + 1]]),
  }) : '';
  const gf = drawTree(t, {
    rounds: view.finals.map((m) => [m]), names: view.finalNames,
    centerY: () => TOP + UNIT / 2,
    feeds: (r) => (r > 0 ? [[r - 1, 0]] : []),
  });
  board.innerHTML = `
    <h2 class="section-title">Gewinnerrunde</h2>${wb}
    ${lb ? `<h2 class="section-title">Verliererrunde</h2>${lb}` : ''}
    <h2 class="section-title">Grand Final</h2>${gf}
    ${view.finals[1] ? '<p class="hint">Das Reset-Spiel findet nur statt, wenn der Sieger der Verliererrunde das erste Grand Final gewinnt (dann haben beide je eine Niederlage).</p>' : ''}`;
  bindMatchClicks(board, t, view);
}

// --- Jeder gegen jeden ---
function renderRR(board, t, view) {
  const table = `<div class="card"><h2>Tabelle</h2><div style="overflow-x:auto"><table>
    <thead><tr><th>#</th><th>Teilnehmer</th><th class="num">Sp</th><th class="num">S</th><th class="num">U</th><th class="num">N</th>
    <th class="num hide-sm">Tore</th><th class="num">Diff</th><th class="num">Pkt</th></tr></thead>
    <tbody>${view.standings.map((s) => `<tr class="${view.finished && s.place === 1 ? 'leader' : ''}">
      <td>${s.place}</td><td>${view.finished && s.place === 1 ? '🏆 ' : ''}${esc(t.participants[s.p])}</td>
      <td class="num">${s.played}</td><td class="num">${s.w}</td><td class="num">${s.d}</td><td class="num">${s.l}</td>
      <td class="num hide-sm">${s.gf}:${s.ga}</td><td class="num">${s.gf - s.ga > 0 ? '+' : ''}${s.gf - s.ga}</td><td class="num"><strong>${s.pts}</strong></td>
    </tr>`).join('')}</tbody></table></div>
    <p class="hint">Sieg 3 Punkte, Unentschieden 1 Punkt.</p></div>`;

  const rounds = `<div class="rr-rounds">${view.rounds.map((list, r) => `
    <div class="card"><h3>${esc(view.roundNames[r])}</h3>
      ${list.map((m) => {
        const cls = ['rr-match', m.status];
        if (canEdit(m)) cls.push('clickable');
        const wa = m.status === 'done' && m.winner === m.a ? 'w' : '';
        const wb = m.status === 'done' && m.winner === m.b ? 'w' : '';
        return `<div class="${cls.join(' ')}" data-match="${m.id}">
          <span class="${wa}">${esc(pname(t, m.a))}</span>
          <span class="res">${m.score ? `${m.score.a} : ${m.score.b}` : '– : –'}</span>
          <span class="b ${wb}">${esc(pname(t, m.b))}</span></div>`;
      }).join('')}
    </div>`).join('')}</div>`;

  board.innerHTML = table + rounds;
  bindMatchClicks(board, t, view);
}

function bindMatchClicks(board, t, view) {
  if (state.readOnly) return;
  board.querySelectorAll('[data-match]').forEach((el) => {
    const m = view.matches.find((x) => x.id === el.dataset.match);
    if (!m) return;
    if (canEdit(m)) {
      el.title = m.status === 'done' ? 'Ergebnis korrigieren' : 'Ergebnis eintragen';
      el.addEventListener('click', () => openMatchDialog(t, m));
    } else if (m.status === 'done') {
      el.classList.add('locked');
      el.title = 'Ergebnis eingetragen – Änderungen nur durch die Turnierleitung';
      el.addEventListener('click', () => toast('🔒 Ergebnis bereits eingetragen – Änderungen nur durch die Turnierleitung'));
    }
  });
}

// ---------- Ergebnis-Dialog ----------
// Nutzer: Eintrag nur einmal, mit Bestätigungsschritt. Admin: jederzeit ändern oder löschen.
const dlg = document.getElementById('matchDialog');
const $ = (id) => document.getElementById(id);
let dlgMatch = null;
let dlgConfirming = false;

function setConfirming(on) {
  dlgConfirming = on;
  $('mdInputs').hidden = on;
  $('mdConfirm').hidden = !on;
  $('mdHint').hidden = on;
  $('mdCancel').textContent = on ? 'Zurück' : 'Abbrechen';
  if (on) $('mdSave').textContent = 'Endgültig speichern';
  else if (state.admin) $('mdSave').textContent = dlgMatch.m.status === 'done' ? 'Korrektur speichern' : 'Speichern';
  else $('mdSave').textContent = 'Weiter';
}

function openMatchDialog(t, m) {
  dlgMatch = { t, m };
  const done = m.status === 'done';
  $('mdTitle').textContent = done ? 'Ergebnis korrigieren' : 'Ergebnis eintragen';
  $('mdNameA').textContent = pname(t, m.a);
  $('mdNameB').textContent = pname(t, m.b);
  $('mdA').value = m.score ? m.score.a : '';
  $('mdB').value = m.score ? m.score.b : '';
  $('mdError').textContent = '';

  let hint = t.type !== 'rr'
    ? 'Kein Unentschieden möglich – der Gewinner zieht automatisch in die nächste Runde ein.'
    : 'Unentschieden ist erlaubt.';
  if (done) hint += ' Achtung: Ändert sich der Gewinner, werden davon abhängige spätere Ergebnisse gelöscht.';
  else if (!state.admin) hint += ' Nach dem Speichern kann das Ergebnis nur noch die Turnierleitung ändern.';
  $('mdHint').textContent = hint;
  $('mdReset').hidden = !(state.admin && done);
  setConfirming(false);
  dlg.showModal();
  $('mdA').focus();
}

async function saveResult(a, b) {
  const { t, m } = dlgMatch;
  try {
    await api('POST', `/tournaments/${t.id}/matches/${m.id}`, { a, b });
    dlg.close();
    toast(m.status === 'done' ? 'Ergebnis korrigiert' : 'Ergebnis gespeichert');
    render();
  } catch (err) {
    setConfirming(false);
    $('mdError').textContent = err.message;
    render(); // z. B. wenn jemand anderes schneller war
  }
}

$('mdCancel').addEventListener('click', () => {
  if (dlgConfirming) setConfirming(false);
  else dlg.close();
});

$('matchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { t, m } = dlgMatch;
  const a = Number($('mdA').value);
  const b = Number($('mdB').value);
  if (t.type !== 'rr' && a === b) {
    $('mdError').textContent = 'Im K.-o.-System ist kein Unentschieden möglich.';
    return;
  }
  $('mdError').textContent = '';
  // Admin speichert direkt, Nutzer bestätigen erst – danach ist das Ergebnis gesperrt.
  if (state.admin || dlgConfirming) return saveResult(a, b);
  const winner = a > b ? pname(t, m.a) : b > a ? pname(t, m.b) : null;
  $('mdConfirm').innerHTML = `
    <div class="md-score"><span>${esc(pname(t, m.a))}</span><strong>${a} : ${b}</strong><span>${esc(pname(t, m.b))}</span></div>
    <p>${winner ? `Sieger: <strong>${esc(winner)}</strong>` : 'Unentschieden'}</p>
    <p class="md-warn">🔒 Bitte prüfen: Nach dem Speichern kannst du das Ergebnis nicht mehr ändern. Korrekturen sind dann nur noch durch die Turnierleitung möglich.</p>`;
  setConfirming(true);
});

$('mdReset').addEventListener('click', async () => {
  const { t, m } = dlgMatch;
  if (!confirm('Ergebnis löschen? Davon abhängige spätere Ergebnisse werden ebenfalls entfernt.')) return;
  try {
    await api('DELETE', `/tournaments/${t.id}/matches/${m.id}`);
    dlg.close();
    toast('Ergebnis gelöscht');
    render();
  } catch (err) {
    $('mdError').textContent = err.message;
  }
});

// ---------- Admin ----------
const adminFilter = { status: 'all', q: '' };

async function renderAdmin() {
  if (!state.admin) return renderLogin();
  const list = await api('GET', '/tournaments');
  app.innerHTML = `
    ${adminTabs('')}
    <div class="two">
      <div class="card">
        <h2>Alle Turniere (${list.length})</h2>
        <div class="toolbar">
          ${[['all', 'Alle'], ['draft', 'Entwürfe'], ['running', 'Laufend'], ['finished', 'Beendet']].map(([k, l]) =>
            `<button class="chip ${adminFilter.status === k ? 'active' : ''}" data-filter="${k}">${l}</button>`).join('')}
          <input id="adminSearch" type="search" placeholder="Suchen…" value="${esc(adminFilter.q)}">
        </div>
        <div id="adminList"></div>
      </div>
      <div class="card">
        <h2>Neues Turnier</h2>
        ${tournamentForm({ name: '', game: '', type: 'ko', thirdPlace: true, gfReset: true, participants: [] }, true)}
      </div>
    </div>`;
  bindTournamentForm(null);

  const draw = () => {
    const q = adminFilter.q.toLowerCase();
    const items = list.filter((t) => {
      const st = t.status === 'draft' ? 'draft' : t.finished ? 'finished' : 'running';
      if (adminFilter.status !== 'all' && st !== adminFilter.status) return false;
      return !q || (t.name + ' ' + (t.game || '')).toLowerCase().includes(q);
    });
    document.getElementById('adminList').innerHTML = items.length ? `<table class="admin-list"><tbody>${items.map((t) => `
      <tr><td><a href="#/admin/t/${t.id}"><strong>${esc(t.name)}</strong></a> ${statusBadge(t)}
        <div class="meta">${t.game ? esc(t.game) + ' · ' : ''}${typeLabel(t.type)} · ${t.participants} Teilnehmer
        ${t.champion ? ` · 🏆 ${esc(t.champion)}` : ''}</div></td>
        <td><div class="row">
          ${t.status !== 'draft' ? `<a class="btn" href="#/t/${t.id}">Ansehen</a>` : ''}
          <a class="btn" href="#/admin/t/${t.id}">Bearbeiten</a>
          <button data-dup="${t.id}" title="Neues Turnier mit gleichen Teilnehmern und Einstellungen">Duplizieren</button>
          <button class="danger" data-del="${t.id}" data-name="${esc(t.name)}">Löschen</button>
        </div></td></tr>`).join('')}
      </tbody></table>` : '<p class="meta">Keine passenden Turniere.</p>';
  };
  draw();

  app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    adminFilter.status = b.dataset.filter;
    app.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
    draw();
  }));
  document.getElementById('adminSearch').addEventListener('input', (e) => { adminFilter.q = e.target.value; draw(); });
  document.getElementById('adminList').addEventListener('click', async (e) => {
    const dup = e.target.closest('[data-dup]');
    const del = e.target.closest('[data-del]');
    try {
      if (dup) {
        const copy = await api('POST', `/tournaments/${dup.dataset.dup}/duplicate`);
        location.hash = '#/admin/t/' + copy.id;
      } else if (del) {
        if (!confirm(`Turnier „${del.dataset.name}“ wirklich löschen?`)) return;
        await api('DELETE', '/tournaments/' + del.dataset.del);
        toast('Turnier gelöscht');
        render();
      }
    } catch (err) { toast(err.message); }
  });
}

function tournamentForm(t, isNew) {
  const locked = !isNew && t.status !== 'draft';
  return `<form id="tform">
    <div class="field"><label for="fName">Name</label><input id="fName" value="${esc(t.name)}" maxlength="100" required placeholder="z. B. Mario Kart Cup"></div>
    <div class="field"><label for="fGame">Spiel / Disziplin <span class="meta">(optional)</span></label><input id="fGame" value="${esc(t.game)}" maxlength="100"></div>
    <div class="field"><label for="fType">Modus</label>
      <select id="fType" ${locked ? 'disabled' : ''}>
        <option value="ko" ${t.type === 'ko' ? 'selected' : ''}>Single Elimination (K.-o., eine Niederlage = raus)</option>
        <option value="de" ${t.type === 'de' ? 'selected' : ''}>Double Elimination (raus nach zwei Niederlagen)</option>
        <option value="rr" ${t.type === 'rr' ? 'selected' : ''}>Jeder gegen jeden (Liga)</option>
      </select></div>
    <div class="field" id="thirdField" ${t.type !== 'ko' ? 'hidden' : ''}><label class="check"><input type="checkbox" id="fThird" ${t.thirdPlace ? 'checked' : ''} ${locked ? 'disabled' : ''}> Spiel um Platz 3</label></div>
    <div class="field" id="resetField" ${t.type !== 'de' ? 'hidden' : ''}><label class="check"><input type="checkbox" id="fReset" ${t.gfReset !== false ? 'checked' : ''} ${locked ? 'disabled' : ''}> Grand Final mit Reset</label>
      <p class="hint">Gewinnt der Sieger der Verliererrunde das Grand Final, folgt ein Entscheidungsspiel.</p></div>
    <div class="field"><label for="fTeam">Spieler pro Team</label>
      <input id="fTeam" type="number" min="1" max="20" value="${t.teamSize || 1}" ${locked ? 'disabled' : ''} style="max-width:120px">
      <p class="hint">1 = Einzelspieler. Bei Teams treten sich Teams gegenüber; über Discord können Spieler Teams gründen und beitreten.</p></div>
    <div class="field"><label for="fPart">Teilnehmer / Teams <span class="meta">(einer pro Zeile${isNew || !locked ? ', Reihenfolge = Setzliste' : ''})</span></label>
      <textarea id="fPart" placeholder="Anna&#10;Bernd&#10;Clara&#10;...">${esc(t.participants.join('\n'))}</textarea>
      ${!locked && on('people') ? '<button type="button" class="small" id="fPick">👥 Aus Teilnehmerliste wählen</button><div id="fPicker"></div>' : ''}
      <p class="hint" id="partCount"></p>
      ${locked ? '<p class="hint">Turnier läuft: Teilnehmer können nur umbenannt werden (Anzahl und Reihenfolge bleiben gleich).</p>' : ''}
    </div>
    ${state.discord && !locked ? `<div class="field"><label class="check"><input type="checkbox" id="fSignup" ${t.signup ? 'checked' : ''}> Anmeldung über Discord offen</label>
      <p class="hint">Solange das Turnier ein Entwurf ist, melden sich Spieler selbst an: <code>/anmelden</code> bzw. bei Teams <code>/team gruenden</code> und <code>/team beitreten</code>.</p></div>` : ''}
    ${state.discord ? `<div class="field"><label class="check"><input type="checkbox" id="fDiscord" ${t.discordEnabled !== false ? 'checked' : ''}> Discord-Voice-Kanäle anlegen</label>
      <p class="hint">Eine Kategorie mit dem Turniernamen und ein Voice-Kanal pro Teilnehmer/Team. Wird beim Löschen des Turniers mit entfernt.</p></div>` : ''}
    <p class="error" id="fError"></p>
    <button type="submit" class="primary">${isNew ? 'Turnier anlegen' : 'Speichern'}</button>
  </form>`;
}

function readForm() {
  return {
    name: document.getElementById('fName').value,
    game: document.getElementById('fGame').value,
    type: document.getElementById('fType').value,
    thirdPlace: document.getElementById('fThird').checked,
    gfReset: document.getElementById('fReset').checked,
    participants: document.getElementById('fPart').value.split('\n').map((s) => s.trim()).filter(Boolean),
    ...(document.getElementById('fDiscord') ? { discordEnabled: document.getElementById('fDiscord').checked } : {}),
    ...(document.getElementById('fSignup') ? { signup: document.getElementById('fSignup').checked } : {}),
    ...(!document.getElementById('fTeam').disabled ? { teamSize: Number(document.getElementById('fTeam').value) } : {}),
  };
}

// Auswahl aus der Teilnehmerliste: angehakte Namen werden an die Liste angehängt
async function openPeoplePicker() {
  const box = document.getElementById('fPicker');
  if (box.innerHTML) { box.innerHTML = ''; return; }
  const { people } = await api('GET', '/people');
  const part = document.getElementById('fPart');
  const have = new Set(part.value.split('\n').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const list = people.filter((p) => !have.has(p.name.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  box.innerHTML = list.length ? `<div class="picker">${list.map((p) => `<label class="check"><input type="checkbox" value="${esc(p.name)}"> ${esc(p.name)}</label>`).join('')}
    <div class="row"><button type="button" class="small" id="fPickAll">Alle</button><button type="button" class="small primary" id="fPickOk">Übernehmen</button></div></div>`
    : '<p class="hint">Alle Teilnehmer sind schon in der Liste.</p>';
  const all = document.getElementById('fPickAll');
  if (!all) return;
  all.onclick = () => box.querySelectorAll('input').forEach((c) => { c.checked = true; });
  document.getElementById('fPickOk').onclick = () => {
    const names = [...box.querySelectorAll('input:checked')].map((c) => c.value);
    part.value = [part.value.trim(), ...names].filter(Boolean).join('\n');
    part.dispatchEvent(new Event('input'));
    box.innerHTML = '';
  };
}

function bindTournamentForm(t) {
  const pick = document.getElementById('fPick');
  if (pick) pick.onclick = openPeoplePicker;
  const part = document.getElementById('fPart');
  const count = () => {
    const n = part.value.split('\n').filter((s) => s.trim()).length;
    document.getElementById('partCount').textContent = `${n} Teilnehmer` +
      (document.getElementById('fType').value !== 'rr' && n > 1 ? ` · Baumgröße ${Bracket.nextPow2(n)} · ${Bracket.nextPow2(n) - n} Freilos(e), werden automatisch vergeben` : '')
      + (document.getElementById('fType').value === 'rr' && n % 2 === 1 ? ' · ungerade Anzahl: pro Spieltag hat einer spielfrei' : '');
  };
  part.addEventListener('input', count);
  document.getElementById('fType').addEventListener('change', (e) => {
    document.getElementById('thirdField').hidden = e.target.value !== 'ko';
    document.getElementById('resetField').hidden = e.target.value !== 'de';
    count();
  });
  count();
  document.getElementById('tform').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = readForm();
      if (t) {
        await api('PUT', '/tournaments/' + t.id, body);
        toast('Gespeichert');
        render();
      } else {
        const created = await api('POST', '/tournaments', body);
        location.hash = '#/admin/t/' + created.id;
      }
    } catch (err) {
      document.getElementById('fError').textContent = err.message;
    }
  });
}

async function renderAdminEdit(id) {
  if (!state.admin) return renderLogin();
  const t = await api('GET', '/tournaments/' + id);
  const view = t.status === 'running' ? Bracket.compute(t) : null;
  const played = Object.keys(t.results).length;
  app.innerHTML = `
    <div class="page-head">
      <div>${adminTabs('')}<a href="#/admin" class="meta">← Alle Turniere</a><h1>${esc(t.name)}</h1>
        <div>${statusBadge({ status: t.status, finished: view && view.finished })}</div></div>
      ${t.status === 'running' ? `<a class="btn primary" href="#/t/${t.id}">Turnierbaum öffnen</a>` : ''}
    </div>
    <div class="two">
      <div class="card"><h2>Einstellungen</h2>${tournamentForm(t, false)}</div>
      <div>
        <div class="card">
          <h2>Ablauf</h2>
          ${t.status === 'draft' ? `
            <p class="meta">Das Turnier ist ein Entwurf und für Besucher noch nicht sichtbar. Beim Start wird der Spielplan erzeugt.</p>
            <div class="row">
              <button class="primary" id="startShuffle">Starten (Auslosung)</button>
              <button id="startSeeded">Starten (Setzliste)</button>
            </div>
            <p class="hint">„Setzliste“ nutzt die Reihenfolge der Teilnehmerliste (1. = Topgesetzt, bekommt ggf. Freilos).</p>` : `
            <p class="meta">Das Turnier läuft. ${played} Ergebnis${played === 1 ? '' : 'se'} eingetragen.
              Ergebnisse korrigierst du direkt im Turnierbaum per Klick auf das Spiel.</p>
            <div class="row">
              <button class="danger" id="resetBtn">Zurück auf Entwurf</button>
            </div>
            <p class="hint">Setzt das Turnier zurück – alle Ergebnisse und die Auslosung werden gelöscht.</p>`}
        </div>
        ${state.discord ? `<div class="card" id="discordCard">${discordCard(t)}</div>` : ''}
        ${await teamsCard(t)}
        <div class="card">
          <h2>Weitere Aktionen</h2>
          <div class="row">
            <button id="dupBtn">Duplizieren</button>
            <button class="danger" id="deleteBtn">Turnier endgültig löschen</button>
          </div>
          <p class="hint">Duplizieren legt einen neuen Entwurf mit gleichen Teilnehmern und Einstellungen an.</p>
        </div>
      </div>
    </div>`;
  bindTournamentForm(t);
  const start = async (shuffle) => {
    try {
      await api('POST', `/tournaments/${t.id}/start`, { shuffle });
      location.hash = '#/t/' + t.id;
    } catch (err) { toast(err.message); }
  };
  const s1 = document.getElementById('startShuffle');
  if (s1) s1.onclick = () => start(true);
  const s2 = document.getElementById('startSeeded');
  if (s2) s2.onclick = () => start(false);
  const rb = document.getElementById('resetBtn');
  if (rb) rb.onclick = async () => {
    if (!confirm('Turnier wirklich zurücksetzen? Alle Ergebnisse gehen verloren.')) return;
    await api('POST', `/tournaments/${t.id}/reset`);
    toast('Zurückgesetzt');
    render();
  };
  bindDiscordCard(t);
  document.getElementById('dupBtn').onclick = async () => {
    const copy = await api('POST', `/tournaments/${t.id}/duplicate`);
    location.hash = '#/admin/t/' + copy.id;
  };
  document.getElementById('deleteBtn').onclick = async () => {
    const extra = t.discord ? '\nDie Discord-Kategorie und alle Voice-Kanäle werden ebenfalls gelöscht.' : '';
    if (!confirm(`Turnier „${t.name}“ wirklich löschen?${extra}`)) return;
    await api('DELETE', '/tournaments/' + t.id);
    location.hash = '#/admin';
  };
}

function discordCard(t) {
  const d = t.discord;
  const st = t.discordStatus || {};
  const count = d ? Object.keys(d.channels || {}).length : 0;
  let body;
  const view = t.status === 'running' ? Bracket.compute(t) : null;
  const finished = !!(view && view.finished);
  const eventActive = !!(adminEvent() && adminEvent().active);
  if (t.discordEnabled === false) {
    body = '<p class="meta">Für dieses Turnier deaktiviert. Aktivieren über „Discord-Voice-Kanäle anlegen“ in den Einstellungen.</p>';
  } else if (!eventActive && st.state !== 'pending' && !finished) {
    body = '<p class="meta">⏸️ Kein Event aktiv – die Voice-Kanäle werden zum Event-Beginn angelegt und zum Ende wieder entfernt (Einstellungen → Event-Zeitraum).</p>'
      + (st.state === 'error' ? `<p class="error">⚠️ ${esc(st.error)}</p>` : '');
  } else if (finished && st.state !== 'pending') {
    body = '<p class="meta">🏁 Turnier beendet – die Voice-Kanäle wurden entfernt. Wird ein Ergebnis korrigiert, sodass das Turnier wieder läuft, werden sie neu angelegt.</p>'
      + (st.state === 'error' ? `<p class="error">⚠️ ${esc(st.error)}</p>` : '');
  } else if (st.state === 'pending') {
    body = '<p class="meta">⏳ Kanäle werden in Discord abgeglichen …</p>';
  } else {
    body = (d ? `<p>📁 <strong>${esc(t.name)}</strong> mit ${count} ${count === 1 ? 'Voice-Kanal' : 'Voice-Kanälen'}</p>` : '<p class="meta">Noch keine Kanäle angelegt.</p>')
      + (st.state === 'error' ? `<p class="error">⚠️ ${esc(st.error)}</p>` : '');
  }
  body += t.discordEnabled === false ? '' : (t.announceError
    ? `<p class="error">⚠️ Ansagen: ${esc(t.announceError)}</p>`
    : '<p class="meta">📢 Start, Ergebnisse, nächste Spiele und Sieger werden im Textkanal angesagt.</p>');
  return `<h2>Discord</h2>${body}
    ${t.discordEnabled !== false && ((!finished && eventActive) || t.discord) ? '<button id="discordSync">Jetzt abgleichen</button><p class="hint">Legt fehlende Kanäle neu an (z. B. wenn sie in Discord von Hand gelöscht wurden) und korrigiert Namen.</p>' : ''}`;
}

function bindDiscordCard(t) {
  const btn = document.getElementById('discordSync');
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Wird abgeglichen …';
    try {
      const updated = await api('POST', `/tournaments/${t.id}/discord`);
      toast(updated.discordStatus?.state === 'error' ? 'Discord-Abgleich fehlgeschlagen' : 'Discord abgeglichen');
      refreshDiscordCard(t.id, updated);
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Jetzt abgleichen'; }
  };
}

async function refreshDiscordCard(id, t) {
  const card = document.getElementById('discordCard');
  if (!card) return;
  t = t || await api('GET', '/tournaments/' + id);
  card.innerHTML = discordCard(t);
  bindDiscordCard(t);
}

// Admin-Anmeldung: mit Discord (Rolle auf dem Server), das Passwort nur als Notzugang
function renderLogin() {
  const ways = state.adminLogin || { discord: false, password: true };
  const hint = state.route && state.route.query.get('hinweis');
  app.innerHTML = `<div class="card" style="max-width:380px;margin:40px auto">
    <h2>Admin-Login</h2>
    ${hint ? `<p class="error">${esc(hint)}</p>` : ''}
    ${ways.discord ? `<a class="btn primary big discord-btn" href="/api/auth/login?admin=1">Mit Discord anmelden</a>
      <p class="hint">Zugang hat, wer auf unserem Discord-Server die Admin-Rolle hat.</p>` : ''}
    ${ways.password ? `${ways.discord ? '<details><summary class="meta">Mit Passwort anmelden (Notzugang)</summary>' : ''}
    <form id="loginForm">
      <div class="field"><label for="pw">Passwort</label><input type="password" id="pw" autocomplete="current-password" required></div>
      <p class="error" id="loginError"></p>
      <button class="${ways.discord ? '' : 'primary'}" type="submit">Anmelden</button>
    </form>${ways.discord ? '</details>' : ''}` : ''}
  </div>`;
  if (!ways.password) return;
  if (!ways.discord) document.getElementById('pw').focus();
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/login', { password: document.getElementById('pw').value });
      await loadMe();
      render();
    } catch (err) {
      document.getElementById('loginError').textContent = err.message;
    }
  });
}

async function logout() {
  await api('POST', '/logout');
  state.admin = false;
  location.hash = '#/';
}

// ---------- Live-Aktualisierung ----------
// Ereignisse: { type: 'tournament'|'announce'|'schedule'|'info'|'people'|'settings', id }
const liveHandlers = []; // Module können zusätzlich reagieren (z. B. Durchsage-Banner)

async function loadMe() {
  const me = await api('GET', '/me');
  state.admin = me.admin;
  state.discord = me.discord;
  state.settings = me.settings;
  state.adminLogin = me.adminLogin;
  state.access = me.access;
  state.member = me.member;
  state.userLogin = me.userLogin;
  await loadEvents();
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = async (e) => {
    const ev = JSON.parse(e.data);
    for (const h of liveHandlers) h(ev);
    if (['settings', 'tickets', 'people', 'accounts'].includes(ev.type)) { await loadMe().catch(() => {}); buildNav(); }
    const r = state.route;
    if (!r) return;
    if (r.view === 'adminEdit' && ev.type === 'tournament' && r.id === ev.id) { refreshDiscordCard(ev.id).catch(() => {}); return; }
    if (dlg.open || document.activeElement?.closest?.('form, .editor')) return; // Eingaben nicht überschreiben
    const v = r.view.startsWith('admin:') ? adminViews[r.name] : views[r.view];
    // Uploads can disable or replace focused controls; these editors own their drafts.
    // Background handlers still run. Explicit navigation reloads the saved state.
    if (v?.preserveDraft) return;
    const relevant = ev.type === 'settings'
      || r.view === 'beamer' || r.view === 'home'
      || (r.view === 'tournament' && ev.type === 'tournament' && r.id === ev.id)
      || (v && v.events && v.events.includes(ev.type));
    if (relevant && ev.type !== 'announce') render();
  };
  es.onerror = () => { es.close(); setTimeout(connectEvents, 3000); };
}

// ---------- Start ----------
window.addEventListener('hashchange', render);
// Start erst, wenn alle Modul-Skripte geladen sind und sich registriert haben
document.addEventListener('DOMContentLoaded', async () => {
  try { await loadMe(); } catch { /* offline */ }
  for (const h of startHooks) await h();
  await render();
  connectEvents();
});
