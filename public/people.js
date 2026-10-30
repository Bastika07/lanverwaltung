'use strict';
/* global api, esc, toast, on, views, adminViews, adminTabs, beamerSlides, render, adminEvent, state */
// Teilnehmer des Events (mit Discord-Verknüpfung und Steam), Sitzplan und die globale
// Personenverwaltung mit Statistik, wer wie oft dabei war.

const People = { load: () => api('GET', '/people') };

// Steam-Angabe -> Profil-Link (URL, 17-stellige SteamID64 oder Profilname)
function steamUrl(v) {
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null; // andere Schemata (javascript: …) nie verlinken
  if (/^\d{17}$/.test(v)) return `https://steamcommunity.com/profiles/${v}`;
  return `https://steamcommunity.com/id/${encodeURIComponent(v)}`;
}

// Sitzplan als Raster: Flächen (Bereiche, Wände, Eingänge) liegen unter den Plätzen.
// Plätze sind kompakt: Farbe = Status (frei, besetzt, gesperrt), Kürzel = Kategorie, Details im Tooltip.
// opts: { editor, selected: seatId, selectedArea, anchor: {x,y}, areaMode, highlight: personId oder Set,
//   mine: Set(seatId) – eigene Plätze, pickable: (seat) => bool – wählbar beim Reservieren }
const AREA_ICON = { door: '🚪 ', exit: '🏃 ' };
function seatTitle(s, cat, p) {
  return `Platz ${s.label}${cat ? ` · ${cat.name}` : ''}${s.locked ? ' · gesperrt' : ''}${p ? `: ${p.name}${p.clan ? ` [${p.clan}]` : ''}` : s.locked ? '' : ' · frei'}`;
}
function seatMap(data, opts = {}) {
  const { cols, rows, seats } = data.seating;
  const cats = Object.fromEntries((data.seating.categories || []).map((c) => [c.id, c]));
  const bySeat = Object.fromEntries(data.people.filter((p) => p.seat).map((p) => [p.seat, p]));
  const hl = opts.highlight instanceof Set ? opts.highlight : new Set(opts.highlight ? [opts.highlight] : []);
  const pos = (x, y, w = 1, h = 1) => `grid-column:${x + 1} / span ${w};grid-row:${y + 1} / span ${h}`;
  let html = (data.seating.areas || []).map((a) => `<div class="area kind-${a.kind} ${a.w >= a.h ? 'horiz' : 'vert'} ${opts.selectedArea === a.id ? 'selected' : ''}" data-area="${a.id}"
    style="${pos(a.x, a.y, a.w, a.h)};--area:${a.color}" title="${esc(a.label)}"><span>${AREA_ICON[a.kind] || ''}${esc(a.label)}</span></div>`).join('');
  if (opts.editor) {
    const taken = new Set(seats.map((s) => `${s.x},${s.y}`));
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (taken.has(`${x},${y}`)) continue;
        const anchor = opts.anchor && opts.anchor.x === x && opts.anchor.y === y;
        html += `<div class="cell empty ${anchor ? 'anchor' : ''}" data-x="${x}" data-y="${y}" style="${pos(x, y)}"></div>`;
      }
    }
  }
  for (const s of seats) {
    const p = bySeat[s.id];
    const cat = cats[s.category];
    const cls = ['seat', p ? 'taken' : s.locked ? 'locked' : 'free'];
    if (p && hl.has(p.id)) cls.push('hl');
    if (opts.selected === s.id) cls.push('selected');
    if (opts.anchor && opts.anchor.x === s.x && opts.anchor.y === s.y) cls.push('anchor');
    if (opts.mine && opts.mine.has(s.id)) cls.push('mine');
    if (opts.pickable) cls.push(opts.pickable(s) ? 'pick' : 'nopick');
    const text = opts.editor ? s.label : (cat && cat.short) || '';
    html += `<div class="${cls.join(' ')}" data-seat="${s.id}" data-x="${s.x}" data-y="${s.y}" title="${esc(seatTitle(s, cat, p))}"
      style="${pos(s.x, s.y)}${cat ? `;--cat:${cat.color}` : ''}">${esc(text)}</div>`;
  }
  return `<div class="seatmap-wrap"><div class="seatmap ${opts.editor ? 'editor-grid' : ''} ${opts.areaMode ? 'area-mode' : ''}"
    style="--cols:${cols};--rows:${rows}">${html}</div></div>`;
}

function seatLegend(seating, opts = {}) {
  const cats = seating.categories || [];
  return `<div class="seat-legend"><span><i class="lg-free"></i>frei</span><span><i class="lg-taken"></i>besetzt</span>
    ${seating.seats.some((s) => s.locked) ? '<span><i class="lg-locked"></i>gesperrt</span>' : ''}
    ${opts.mine ? '<span><i class="lg-mine"></i>deine Plätze</span>' : ''}
    ${cats.map((c) => `<span><i style="background:${c.color}">${esc(c.short || '')}</i>${esc(c.name)}</span>`).join('')}</div>`;
}

// Antippen eines Platzes zeigt die Details (auf dem Handy gibt es keinen Tooltip)
function bindSeatInfo(root) {
  const box = root.querySelector('.seat-info');
  if (!box) return;
  root.querySelectorAll('.seatmap .seat').forEach((el) => {
    el.addEventListener('click', () => { box.textContent = el.title; box.hidden = false; });
  });
}

views.leute = {
  label: 'Teilnehmer', module: 'people', events: ['people'],
  async render() {
    const data = await People.load();
    const seatsOn = on('seating') && data.seating.seats.length > 0;
    const label = (p) => {
      const s = data.seating.seats.find((x) => x.id === p.seat);
      return s ? s.label : '';
    };
    const people = data.people.slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const app = document.getElementById('app');
    app.innerHTML = `<div class="page-head"><h1>Teilnehmer <span class="meta">(${people.length})</span></h1>
        <input id="pSearch" type="search" placeholder="Wer sitzt wo? Name oder Clan …" style="max-width:280px"></div>
      ${people.length ? `<div>
        ${seatsOn ? `<div class="card" id="mapCard"><h2>💺 Sitzplan</h2><div id="mapBox">${seatMap(data)}</div>${seatLegend(data.seating)}
          <p class="seat-info meta" hidden></p></div>` : ''}
        <div class="card"><h2>👥 Alle</h2><table class="people-table"><tbody>
          ${people.map((p) => `<tr data-person="${p.id}" data-name="${esc(`${p.name} ${p.clan || ''}`.toLowerCase())}">
            <td><strong>${esc(p.name)}</strong>${p.clan ? ` <span class="meta">[${esc(p.clan)}]</span>` : ''}${p.note ? `<div class="meta">${esc(p.note)}</div>` : ''}</td>
            ${seatsOn ? `<td class="nowrap">${label(p) ? `💺 ${esc(label(p))}` : ''}</td>` : ''}
            <td class="nowrap">${p.discordName ? `<span class="meta" title="Mit Discord verknüpft">💬 ${esc(p.discordName)}</span>` : ''}</td>
            <td class="nowrap">${steamUrl(p.steam) ? `<a href="${esc(steamUrl(p.steam))}" target="_blank" rel="noopener noreferrer">Steam ↗</a>` : ''}</td>
          </tr>`).join('')}
        </tbody></table>
        <p class="hint">Mit Discord verknüpfen: im Discord <code>/ich</code> eingeben und deinen Namen wählen, den Clan setzt du mit <code>/clan</code>.</p></div>
      </div>` : '<div class="empty">Noch keine Teilnehmer eingetragen.</div>'}`;

    const search = document.getElementById('pSearch');
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      const rows = [...app.querySelectorAll('[data-person]')];
      rows.forEach((r) => { r.hidden = !!q && !r.dataset.name.includes(q); });
      const hits = new Set(q ? rows.filter((r) => !r.hidden).map((r) => r.dataset.person) : []);
      if (seatsOn) { document.getElementById('mapBox').innerHTML = seatMap(data, { highlight: hits }); bindSeatInfo(document.getElementById('mapCard')); }
    };
    if (seatsOn) bindSeatInfo(document.getElementById('mapCard'));
  },
};

beamerSlides.push({
  module: 'seating', order: 50,
  async build() {
    const data = await People.load();
    if (!data.seating.seats.length || !data.people.some((p) => p.seat)) return [];
    return [{ title: '💺 Sitzplan', html: `<div class="beamer-seats">${seatMap(data)}${seatLegend(data.seating)}</div>`, width: Math.max(900, data.seating.cols * 38 + 60) }];
  },
});

// Admin tables keep independent sort state; moving rows preserves drafts and pending writes.
const peopleCollator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
const personsSort = { key: 'events', direction: 'desc' };
const participantSort = { key: 'name', direction: 'asc' };
function peopleSortHeader(key, label) {
  return `<th><button type="button" class="small" data-sort="${esc(key)}" data-label="${esc(label)}">${esc(label)}</button></th>`;
}
function bindPeopleSort(tableId, sorting) {
  const table = document.getElementById(tableId);
  if (!table?.querySelector) return;
  const body = table.querySelector('tbody');
  const buttons = [...table.querySelectorAll('[data-sort]')];
  const value = (row, key) => {
    if (key === 'events' || key === 'checkedIn') return Number(row.dataset[key]);
    if (key === 'seat') {
      const select = row.querySelector('[data-k="seat"]');
      return select?.value ? (select.options[select.selectedIndex]?.textContent || '').trim() : '';
    }
    return String(row.querySelector(`[data-k="${key}"]`)?.value ?? row.dataset[key] ?? '').trim();
  };
  const apply = () => {
    [...body.children].sort((a, b) => {
      const av = value(a, sorting.key), bv = value(b, sorting.key);
      if ((av === '') !== (bv === '')) return av === '' ? 1 : -1;
      const order = typeof av === 'number' ? av - bv : peopleCollator.compare(av, bv);
      return (sorting.direction === 'desc' ? -order : order)
        || peopleCollator.compare(value(a, 'name'), value(b, 'name'))
        || peopleCollator.compare(a.dataset.pid || a.dataset.id, b.dataset.pid || b.dataset.id);
    }).forEach((row) => body.appendChild(row));
    buttons.forEach((button) => {
      const active = button.dataset.sort === sorting.key;
      if (active) button.parentElement.setAttribute('aria-sort', sorting.direction === 'asc' ? 'ascending' : 'descending');
      else button.parentElement.removeAttribute('aria-sort');
      button.textContent = button.dataset.label + (active ? (sorting.direction === 'asc' ? ' ▲' : ' ▼') : '');
      button.setAttribute('aria-label', `${button.dataset.label}: ${active && sorting.direction === 'asc' ? 'absteigend' : 'aufsteigend'} sortieren`);
    });
  };
  buttons.forEach((button) => { button.onclick = () => {
    sorting.direction = sorting.key === button.dataset.sort && sorting.direction === 'asc' ? 'desc' : 'asc';
    sorting.key = button.dataset.sort; apply();
  }; });
  apply();
}

// ---------- Admin: Teilnehmer ----------
adminViews.teilnehmer = {
  label: 'Teilnehmer', module: 'people', order: 30, events: ['people'],
  async render() {
    const [data, persons] = await Promise.all([People.load(), api('GET', '/persons')]);
    const here = new Set(data.people.map((p) => p.id));
    const known = persons.filter((p) => !here.has(p.id)).sort((a, b) => b.events.length - a.events.length || a.name.localeCompare(b.name, 'de'));
    const evName = adminEvent() ? adminEvent().name : '';
    const seatOpts = (p) => `<option value="">–</option>${data.seating.seats.slice().sort((a, b) => a.label.localeCompare(b.label, 'de', { numeric: true }))
      .map((s) => `<option value="${s.id}" ${p.seat === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}`;
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('teilnehmer')}
      <div class="two">
        <div class="card"><h2>Teilnehmer hinzufügen</h2>
          ${known.length ? `<form id="pKnown"><div class="field"><label for="pKnownSel">Bekannte Personen (von früheren Events) <span class="meta">– Mehrfachauswahl mit Strg/⌘</span></label>
            <select id="pKnownSel" multiple size="${Math.min(8, known.length)}">${known.map((p) => `<option value="${p.id}">${esc(p.name)}${p.events.length ? ` (${p.events.length}× dabei)` : ''}</option>`).join('')}</select></div>
            <button class="primary" type="submit">Übernehmen</button></form><hr>` : ''}
          <form id="pAdd"><div class="field"><label for="pNames">Neue Namen, einer pro Zeile</label>
            <textarea id="pNames" class="short" placeholder="Anna&#10;Bernd"></textarea></div>
            <p class="error" id="pError"></p><button class="primary" type="submit">Hinzufügen</button></form>
          <p class="hint">Von der Orga hinzugefügte Personen sind für dieses Event freigegeben. Selbstanmeldungen per <code>/ich</code> geben keine geschützten Rechte.
            Bestehende Personen werden mit eigenem bezahltem Ticket, Ticketcode oder durch die Orga mit Discord verknüpft.
            Interne Notizen werden Besuchern nicht angezeigt.</p>
        </div>
        <div class="card"><h2>Hinweis</h2>
          <p class="meta">Das ist die Teilnehmerliste von <strong>${esc(evName)}</strong>. Name, Discord, Steam und Notiz gehören zur Person und gelten
            für alle Events (siehe „Personen“), der Platz nur für dieses Event. Änderungen in der Tabelle werden sofort gespeichert.
            Steam: Profil-Link, SteamID64 oder Profilname.
          ${on('seating') ? 'Plätze legst du im Reiter „Sitzplan“ an.' : ''}</p>
        </div>
      </div>
      <div class="card editor"><h2>Alle (${data.people.length})</h2>
        ${data.people.length ? `<div style="overflow-x:auto"><table id="participantsTable" class="people-admin"><thead><tr>${peopleSortHeader('name', 'Name')}${peopleSortHeader('clan', 'Clan')}${peopleSortHeader('discordName', 'Discord')}${peopleSortHeader('steam', 'Steam')}${peopleSortHeader('note', 'Notiz')}${on('seating') ? peopleSortHeader('seat', 'Platz') : ''}<th></th></tr></thead><tbody>
        ${data.people.map((p) => `<tr data-id="${p.id}" data-discord-name="${esc(p.discordName || '')}">
          <td><input data-k="name" value="${esc(p.name)}"></td>
          <td><input data-k="clan" value="${esc(p.clan || '')}" placeholder="Clan" maxlength="40" style="max-width:130px"></td>
          <td class="nowrap">${p.discordName ? `💬 ${esc(p.discordName)} <button class="small" data-unlink title="Verknüpfung lösen">✕</button>` : '<button class="small" data-link>Discord verknüpfen</button>'}
            <label class="check"><input type="checkbox" data-approve ${p.approved ? 'checked' : ''}> Orga-Freigabe</label></td>
          <td><input data-k="steam" value="${esc(p.steam)}" placeholder="Steam"></td>
          <td><input data-k="note" value="${esc(p.note)}" placeholder="z. B. Rolle"></td>
          ${on('seating') ? `<td><select data-k="seat">${seatOpts(p)}</select></td>` : ''}
          <td><button class="small danger" data-del title="Aus diesem Event entfernen">✕</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="meta">Noch niemand.</p>'}
      </div>`;

    bindPeopleSort('participantsTable', participantSort);
    if (document.getElementById('pKnown')) {
      document.getElementById('pKnown').onsubmit = async (e) => {
        e.preventDefault();
        const personIds = [...document.getElementById('pKnownSel').selectedOptions].map((o) => o.value);
        if (!personIds.length) return;
        try { const added = await api('POST', '/people', { personIds }); toast(`${added.length} übernommen`); render(); } catch (err) { toast(err.message); }
      };
    }
    document.getElementById('pAdd').onsubmit = async (e) => {
      e.preventDefault();
      const names = document.getElementById('pNames').value.split('\n').map((s) => s.trim()).filter(Boolean);
      try {
        const added = await api('POST', '/people', { names });
        toast(`${added.length} hinzugefügt`);
        document.activeElement.blur();
        render();
      } catch (err) { document.getElementById('pError').textContent = err.message; }
    };
    app.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      const put = async (body) => {
        try { await api('PUT', '/people/' + id, body); toast('Gespeichert'); } catch (err) { toast(err.message); render(); }
      };
      tr.querySelectorAll('[data-k]').forEach((el) => { el.onchange = () => put({ [el.dataset.k]: el.value }); });
      const unlink = tr.querySelector('[data-unlink]');
      if (unlink) unlink.onclick = async () => { await put({ unlinkDiscord: true }); render(); };
      const link = tr.querySelector('[data-link]');
      if (link) link.onclick = async () => { const discordId = prompt('Verifizierte Discord-Benutzer-ID (Entwicklermodus → Benutzer-ID kopieren):'); if (discordId) { await put({ discordId }); render(); } };
      tr.querySelector('[data-approve]').onchange = (e) => put({ approved: e.target.checked });
      tr.querySelector('[data-del]').onclick = async () => {
        if (!confirm('Aus diesem Event entfernen? Die Person bleibt unter „Personen“ erhalten.')) return;
        await api('DELETE', '/people/' + id);
        render();
      };
    });
  },
};

// ---------- Admin: Personen (alle Events) ----------
const PersonsAdmin = { q: '', account: null, accountRequest: 0 };
const PERSON_ACCOUNT_FIELDS = [
  ['firstName', 'Vorname'], ['lastName', 'Nachname'], ['street', 'Straße und Hausnummer'],
  ['zip', 'PLZ'], ['city', 'Ort'], ['email', 'E-Mail', 'email'], ['birthdate', 'Geburtsdatum', 'date'],
];
const personAccountKey = (t) => `${t.kind}:${t.id}`;
const personAccountLabel = (t) => t.kind === 'order' ? `Abendkasse · ${t.ref} · ${t.eventName}`
  : `${t.relationship === 'own' ? 'Eigenes Ticketkonto' : 'Käuferkonto'} · ${t.name || t.id}`;
function snapshotPersonAccountDraft() {
  const a = PersonsAdmin.account, form = document.getElementById('personAccountForm');
  if (a && form?.accountState === a && form.accountTarget === a.selected) {
    a.draft = Object.fromEntries(PERSON_ACCOUNT_FIELDS.map(([k]) => [k, document.getElementById('pa_' + k).value]));
  }
}
function personAccountForm() {
  const a = PersonsAdmin.account;
  if (!a) return '';
  const t = a.data.targets.find((x) => personAccountKey(x) === a.selected);
  if (t && !a.draft) a.draft = { ...t.profile };
  return `<div class="card editor"><h2>Ticketkonto: ${esc(a.data.person.name)}</h2>
    ${!t ? '<p>Keine zugeordneten Ticketkonten oder Abendkassenbestellungen gefunden.</p><button id="pa_close">Schließen</button>' : `
    <form id="personAccountForm">
      <label>Zuordnung<select id="pa_target">${a.data.targets.map((x) => `<option value="${esc(personAccountKey(x))}" ${x === t ? 'selected' : ''}>${esc(personAccountLabel(x))}</option>`).join('')}</select></label>
      <p class="meta">${t.kind === 'order' ? `Kontaktdaten nur für diese Abendkassenbestellung (${esc(t.ref)}, ${esc(t.eventName)}).`
        : t.relationship === 'buyer' ? 'Achtung: Diese Daten gehören dem Käufer, nicht zwingend der ausgewählten Person. Änderungen betreffen dessen gesamtes Ticketkonto.'
          : 'Kontaktdaten dieses Ticketkontos gelten eventübergreifend.'}</p>
      <p class="meta">Nur auf Wunsch des Kontoinhabers ändern. Discord-Verknüpfung, Einwilligung, Ticketnamen, Preise und Zahlungsstatus bleiben unverändert.</p>
      ${PERSON_ACCOUNT_FIELDS.map(([k, label, type]) => `<label>${label}<input id="pa_${k}" type="${type || 'text'}" value="${esc(a.draft[k] || '')}" required></label>`).join('')}
      <p id="pa_error" class="error" role="alert"></p>
      <div class="row"><button type="submit" class="primary">Kontaktdaten speichern</button><button type="button" id="pa_reload">Neu laden</button><button type="button" id="pa_close">Schließen</button></div>
    </form>`}</div>`;
}
async function openPersonAccount(id) {
  if (PersonsAdmin.account?.busy) return;
  if (PersonsAdmin.account && !confirm('Ticketkonto öffnen und ungespeicherte Änderungen verwerfen?')) return;
  const request = ++PersonsAdmin.accountRequest;
  try {
    const data = await api('GET', `/persons/${encodeURIComponent(id)}/ticket-accounts`);
    if (request !== PersonsAdmin.accountRequest) return;
    PersonsAdmin.account = { data, selected: data.targets.length ? personAccountKey(data.targets[0]) : null, draft: null, busy: false, committed: false, error: '' };
    await render();
  } catch (err) { toast(err.message); }
}
function bindPersonAccount(app) {
  const a = PersonsAdmin.account;
  if (!a) return;
  document.getElementById('pa_close').onclick = () => {
    if (a.busy || !confirm('Ticketkonto schließen und ungespeicherte Änderungen verwerfen?')) return;
    PersonsAdmin.account = null; PersonsAdmin.accountRequest++; return render();
  };
  const form = document.getElementById('personAccountForm');
  if (!form) return;
  form.accountState = a; form.accountTarget = a.selected;
  const sync = () => {
    const current = document.getElementById('personAccountForm');
    if (current?.accountState !== a) return;
    current.querySelectorAll('input, select, button').forEach((el) => { el.disabled = a.busy || a.committed; });
    document.getElementById('pa_error').textContent = a.error;
  };
  sync();
  document.getElementById('pa_target').onchange = () => {
    if (a.busy || a.committed) { document.getElementById('pa_target').value = a.selected; return; }
    if (!confirm('Zuordnung wechseln und ungespeicherte Änderungen verwerfen?')) {
      document.getElementById('pa_target').value = a.selected; return;
    }
    a.selected = document.getElementById('pa_target').value; a.draft = null; a.error = ''; return render();
  };
  document.getElementById('pa_reload').onclick = () => {
    if (a.busy || a.committed) return;
    return openPersonAccount(a.data.person.id);
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (a.busy || a.committed || PersonsAdmin.account !== a || document.getElementById('personAccountForm') !== form) return;
    const t = a.data.targets.find((x) => personAccountKey(x) === a.selected);
    if (!t) return;
    snapshotPersonAccountDraft();
    const profile = { ...a.draft };
    a.busy = true; a.error = ''; PersonsAdmin.accountRequest++; sync();
    try {
      await api('PUT', `/persons/${encodeURIComponent(a.data.person.id)}/ticket-accounts/${t.kind}/${encodeURIComponent(t.id)}`, { profile, version: t.version });
      a.committed = true;
      PersonsAdmin.account = null; PersonsAdmin.accountRequest++;
      toast('Kontaktdaten gespeichert'); await render();
    } catch (err) { a.error = err.message; }
    finally { a.busy = false; sync(); }
  };
}

adminViews.personen = {
  label: 'Personen', module: 'people', order: 32, events: ['people', 'tickets', 'accounts'], preserveDraft: true,
  async render() {
    const persons = await api('GET', '/persons');
    const q = PersonsAdmin.q.toLowerCase();
    const shown = persons.filter((p) => !q || [p.name, p.clan, p.discordName, p.note].join(' ').toLowerCase().includes(q));
    const eventCount = (state.events || { events: [] }).events.length;
    const regulars = persons.filter((p) => p.events.length >= 2).length;
    const app = document.getElementById('app');
    if (PersonsAdmin.account && !PersonsAdmin.account.busy && !persons.some((p) => p.id === PersonsAdmin.account.data.person.id)) PersonsAdmin.account = null;
    snapshotPersonAccountDraft();
    app.innerHTML = `${adminTabs('personen')}
      ${personAccountForm()}
      <div class="stats">
        <div class="stat"><span>${persons.length}</span>Personen</div>
        <div class="stat"><span>${regulars}</span>mehr als einmal dabei</div>
        <div class="stat"><span>${eventCount}</span>Events</div>
      </div>
      <div class="card editor"><div class="row" style="justify-content:space-between"><h2>Alle Personen</h2>
        <input id="psSearch" type="search" placeholder="Suchen …" value="${esc(PersonsAdmin.q)}" style="max-width:240px"></div>
        <p class="meta">Personen gelten für alle Events. Hier siehst du, wer wie oft dabei war (Teilnehmerliste) und wie oft per Ticket eingecheckt hat.
          Doppelte Einträge derselben Person führst du mit „Zusammenführen“ zusammen.</p>
        ${shown.length ? `<div style="overflow-x:auto"><table id="personsTable" class="people-admin"><thead><tr>${peopleSortHeader('name', 'Name')}${peopleSortHeader('clan', 'Clan')}${peopleSortHeader('events', 'Dabei')}${peopleSortHeader('checkedIn', 'Eingecheckt')}${peopleSortHeader('discordName', 'Discord')}${peopleSortHeader('steam', 'Steam')}${peopleSortHeader('note', 'Notiz')}<th></th></tr></thead><tbody>
        ${shown.map((p) => `<tr data-pid="${p.id}" data-events="${p.events.length}" data-checked-in="${p.checkedIn || 0}" data-discord-name="${esc(p.discordName || '')}">
          <td><input data-k="name" value="${esc(p.name)}"></td>
          <td><input data-k="clan" value="${esc(p.clan || '')}" placeholder="Clan" maxlength="40" style="max-width:130px"></td>
          <td class="nowrap" title="${esc(p.events.map((e) => e.name).join(', '))}"><strong>${p.events.length}×</strong>
            <div class="meta">${esc(p.events.slice(-3).map((e) => e.name).join(', '))}${p.events.length > 3 ? ' …' : ''}</div></td>
          <td class="nowrap">${p.checkedIn ? `${p.checkedIn}×` : '<span class="meta">–</span>'}</td>
          <td class="nowrap">${p.discordName ? `💬 ${esc(p.discordName)}${p.account ? ' <span class="meta" title="Hat ein Ticket-Konto mit hinterlegten Daten">🎟️</span>' : ''} <button class="small" data-unlink title="Verknüpfung lösen">✕</button>` : '<span class="meta">–</span>'}</td>
          <td><input data-k="steam" value="${esc(p.steam)}" placeholder="Steam"></td>
          <td><input data-k="note" value="${esc(p.note)}" placeholder="Notiz"></td>
          <td><div class="row"><button type="button" class="small" data-ticket-account="${esc(p.id)}">🎟️ Ticketkonto</button><select data-merge title="Mit einer anderen Person zusammenführen"><option value="">Zusammenführen mit …</option>
            ${persons.filter((x) => x !== p).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
            <button class="small danger" data-pdel title="Person überall löschen">🗑</button></div></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="meta">Keine Personen gefunden.</p>'}
      </div>`;

    bindPeopleSort('personsTable', personsSort);
    bindPersonAccount(app);
    app.querySelectorAll('[data-ticket-account]').forEach((button) => {
      button.onclick = () => openPersonAccount(button.dataset.ticketAccount);
    });
    document.getElementById('psSearch').onchange = (e) => { PersonsAdmin.q = e.target.value; render(); };
    app.querySelectorAll('tr[data-pid]').forEach((tr) => {
      const p = persons.find((x) => x.id === tr.dataset.pid);
      const put = async (body) => {
        try { await api('PUT', '/persons/' + p.id, body); toast('Gespeichert'); } catch (err) { toast(err.message); render(); }
      };
      tr.querySelectorAll('[data-k]').forEach((el) => { el.onchange = () => put({ [el.dataset.k]: el.value }); });
      const unlink = tr.querySelector('[data-unlink]');
      if (unlink) unlink.onclick = async () => { await put({ unlinkDiscord: true }); render(); };
      tr.querySelector('[data-merge]').onchange = async (e) => {
        const into = persons.find((x) => x.id === e.target.value);
        if (!into) return;
        if (!confirm(`„${p.name}“ in „${into.name}“ zusammenführen? Teilnahmen, Tickets und Teams gehen auf „${into.name}“ über, „${p.name}“ wird gelöscht.`)) { e.target.value = ''; return; }
        try { await api('POST', `/persons/${p.id}/merge`, { into: into.id }); toast('Zusammengeführt'); } catch (err) { toast(err.message); }
        render();
      };
      tr.querySelector('[data-pdel]').onclick = async () => {
        if (!confirm(`„${p.name}“ endgültig löschen? Die Person verschwindet aus allen Events (auch aus der Statistik).`)) return;
        await api('DELETE', '/persons/' + p.id);
        render();
      };
    });
  },
};

// ---------- Admin: Sitzplan-Editor ----------
// Modi (paint): null = einzelne Plätze anlegen/auswählen, 'block' = Rechteck mit Plätzen füllen,
// 'erase' = Plätze im Rechteck entfernen, 'area' = Fläche zeichnen/auswählen, Kategorie-ID / 'none' = Kategorie
// zuweisen, 'lock' = sperren an/aus. Rechtecke entstehen mit zwei Klicks (anchor = erster Klick).
const SeatEdit = { data: null, selected: null, selectedArea: null, dirty: false, paint: null, preview: null, anchor: null };

function nextLabel(seats) {
  const nums = seats.map((s) => Number(s.label)).filter(Number.isFinite);
  return String((nums.length ? Math.max(...nums) : 0) + 1);
}
const newHexId = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('');
const CAT_COLORS = ['#4f8cff', '#2fbf71', '#f5b301', '#e5484d', '#a855f7', '#14b8a6', '#f97316', '#ec4899'];
const AREA_KINDS = { area: 'Bereich', wall: 'Wand', door: 'Eingang', exit: 'Notausgang' };
const AREA_COLORS = { area: '#6b7a99', wall: '#8b95a8', door: '#4f8cff', exit: '#1f9d55' };
const TWO_CLICK = ['block', 'erase', 'area'];
const MODE_HINT = {
  '': 'Klick in ein leeres Feld legt einen Platz an, Klick auf einen Platz wählt ihn aus.',
  block: 'Erst eine Ecke, dann die gegenüberliegende Ecke anklicken: alle freien Felder dazwischen werden Plätze (fortlaufend nummeriert).',
  erase: 'Erst eine Ecke, dann die gegenüberliegende Ecke anklicken: alle Plätze dazwischen werden entfernt.',
  area: 'Zwei Ecken anklicken zeichnet eine Fläche (Bereich, Wand, Eingang, Notausgang). Klick auf eine Fläche wählt sie aus.',
};

adminViews.sitzplan = {
  label: 'Sitzplan', module: 'seating', order: 35, events: ['people'],
  async render() {
    if (!SeatEdit.dirty) SeatEdit.data = await People.load();
    const d = SeatEdit.data;
    const st = d.seating;
    st.categories = st.categories || [];
    st.areas = st.areas || [];
    const cats = st.categories;
    if (!st.seats.some((s) => s.id === SeatEdit.selected)) SeatEdit.selected = null;
    if (!st.areas.some((a) => a.id === SeatEdit.selectedArea)) SeatEdit.selectedArea = null;
    if (SeatEdit.paint && !['none', 'lock', ...TWO_CLICK].includes(SeatEdit.paint) && !cats.some((c) => c.id === SeatEdit.paint)) SeatEdit.paint = null;
    const sel = st.seats.find((s) => s.id === SeatEdit.selected);
    const area = st.areas.find((a) => a.id === SeatEdit.selectedArea);
    const holder = sel && d.people.find((p) => p.seat === sel.id);
    const pv = SeatEdit.preview;
    const mode = SeatEdit.paint || '';
    const chip = (m, label) => `<button class="chip ${mode === m ? 'active' : ''}" data-paint="${m}">${label}</button>`;
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('sitzplan')}
      <div class="editor">
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <h2>Sitzplan <span class="meta">${st.seats.length} Plätze · gilt für alle Events</span></h2>
            <div class="row">
              <label class="inline">Spalten <input id="sCols" type="number" min="2" max="80" value="${st.cols}"></label>
              <label class="inline">Zeilen <input id="sRows" type="number" min="2" max="60" value="${st.rows}"></label>
              <button class="primary" id="sSave" ${SeatEdit.dirty ? '' : 'disabled'}>Plan speichern</button>
            </div>
          </div>
          <div class="toolbar paint-bar">
            <span class="meta">Klick-Modus:</span>
            ${chip('', '✏️ Einzelne Plätze')}${chip('block', '▦ Platz-Block')}${chip('erase', '✕ Plätze entfernen')}${chip('area', '▭ Fläche zeichnen')}
            ${chip('lock', '🔒 sperren an/aus')}
          </div>
          ${cats.length ? `<div class="toolbar paint-bar"><span class="meta">Kategorie zuweisen:</span>
            ${cats.map((c) => chip(c.id, `<i class="dot" style="background:${c.color}"></i>${esc(c.short ? `${c.short} · ` : '')}${esc(c.name)}`)).join('')}
            ${chip('none', 'ohne Kategorie')}</div>` : ''}
          <p class="hint">${MODE_HINT[mode] || 'Klick auf Plätze weist zu.'}
            ${SeatEdit.anchor ? '<strong>Erste Ecke gesetzt – jetzt die zweite anklicken.</strong>' : ''}
            ${SeatEdit.dirty ? '<strong>Ungespeicherte Änderungen.</strong>' : ''}</p>
          <div id="seatEditMap">${seatMap(d, { editor: true, selected: SeatEdit.selected, selectedArea: SeatEdit.selectedArea, anchor: SeatEdit.anchor, areaMode: mode === 'area' })}</div>
          ${seatLegend(st)}
        </div>
        <div class="two">
          <div>
            ${sel ? `<div class="card seat-panel"><h2>Platz ${esc(sel.label)}</h2>
              <div class="row">
                <label class="inline">Bezeichnung <input id="sLabel" maxlength="12" value="${esc(sel.label)}"></label>
                <label class="inline">Kategorie <select id="sCat"><option value="">– keine –</option>
                  ${cats.map((c) => `<option value="${c.id}" ${sel.category === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
                <label class="check"><input type="checkbox" id="sLock" ${sel.locked ? 'checked' : ''}> 🔒 gesperrt</label>
              </div>
              <div class="row" style="margin-top:10px">
                <label class="inline">Belegt von <select id="sPerson" ${SeatEdit.dirty ? 'disabled title="Erst Plan speichern"' : ''}><option value="">– frei –</option>
                  ${d.people.slice().sort((a, b) => a.name.localeCompare(b.name, 'de')).map((p) => `<option value="${p.id}" ${holder && holder.id === p.id ? 'selected' : ''}>${esc(p.name)}${p.seat && p.seat !== sel.id ? ' (hat schon Platz)' : ''}</option>`).join('')}
                </select></label>
                <button class="danger" id="sDel">Platz entfernen</button>
              </div>
              <p class="hint">Gesperrte Plätze kann niemand selbst buchen, und die Defragmentierung lässt sie stehen (z. B. Orga, Technik).
                Die Belegung gilt für das oben gewählte Event.</p></div>` : ''}
            ${area ? `<div class="card seat-panel"><h2>Fläche</h2>
              <div class="row">
                <label class="inline">Art <select id="aKind">${Object.entries(AREA_KINDS).map(([k, l]) => `<option value="${k}" ${area.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
                <label class="inline">Beschriftung <input id="aLabel" maxlength="40" value="${esc(area.label)}"></label>
                <label class="inline">Farbe <input id="aColor" type="color" value="${area.color}"></label>
              </div>
              <div class="row" style="margin-top:10px">
                ${['x', 'y', 'w', 'h'].map((k) => `<label class="inline">${{ x: 'Spalte', y: 'Zeile', w: 'Breite', h: 'Höhe' }[k]}
                  <input data-ageo="${k}" type="number" min="1" value="${k === 'x' || k === 'y' ? area[k] + 1 : area[k]}" style="max-width:80px"></label>`).join('')}
                <button class="danger" id="aDel">Fläche entfernen</button>
              </div></div>` : ''}
            <div class="card"><h2>Kategorien</h2>
              <div id="catList">${cats.map((c) => `<div class="cat-row" data-cat="${c.id}">
                <input type="color" value="${c.color}" data-cat-color> <input value="${esc(c.short || '')}" maxlength="2" data-cat-short placeholder="L" style="max-width:52px" title="Kürzel im Plan">
                <input value="${esc(c.name)}" maxlength="40" data-cat-name>
                <span class="meta">${st.seats.filter((s) => s.category === c.id).length} Plätze</span>
                <button class="small danger" data-cat-del title="Kategorie entfernen">✕</button></div>`).join('') || '<p class="meta">Noch keine – z. B. „Loge“ mit Kürzel „L“, „Parkett“, „Orga“.</p>'}</div>
              <button class="small" id="catAdd">+ Kategorie</button>
              <p class="hint">Das Kürzel steht im Plan auf dem Platz. Welche Ticketart in welcher Kategorie sitzen darf, stellst du bei den Ticketarten ein.</p>
            </div>
          </div>
          <div class="card"><h2>🧩 Defragmentieren</h2>
            <p class="meta">Füllt pro Kategorie die Plätze lückenlos von vorne auf (in der Reihenfolge der Platznummern).
              Tickets einer Bestellung sitzen danach direkt nebeneinander. Gesperrte Plätze bleiben unverändert.
              Betroffene Käufer bekommen eine Discord-Nachricht. Gilt für das oben gewählte Event.</p>
            ${SeatEdit.dirty ? '<p class="hint">Bitte erst den Plan speichern.</p>' : `<button id="dfPreview">Vorschau berechnen</button>`}
            ${pv ? (pv.length ? `<table class="defrag"><thead><tr><th>Person</th><th>von</th><th></th><th>nach</th></tr></thead><tbody>
                ${pv.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.fromLabel)}</td><td>→</td><td><strong>${esc(m.toLabel)}</strong></td></tr>`).join('')}</tbody></table>
                <button class="primary" id="dfApply">${pv.length} Umzug${pv.length === 1 ? '' : 'züge'} übernehmen</button>`
              : '<p>✅ Nichts zu tun – der Plan ist schon lückenlos.</p>') : ''}
          </div>
        </div>
      </div>`;

    const mark = () => { SeatEdit.dirty = true; SeatEdit.preview = null; render(); };
    const $ = (id) => document.getElementById(id);
    app.querySelectorAll('[data-paint]').forEach((b) => {
      b.onclick = () => { SeatEdit.paint = b.dataset.paint || null; SeatEdit.anchor = null; render(); };
    });

    // Rechteck aus erstem Klick (anchor) und zweitem Klick
    const rect = (x, y) => {
      const a = SeatEdit.anchor;
      return { x: Math.min(a.x, x), y: Math.min(a.y, y), w: Math.abs(a.x - x) + 1, h: Math.abs(a.y - y) + 1 };
    };
    const inside = (r, s) => s.x >= r.x && s.x < r.x + r.w && s.y >= r.y && s.y < r.y + r.h;
    $('seatEditMap').onclick = (ev) => {
      const el = ev.target.closest('[data-seat], [data-area], .cell');
      if (!el) return;
      const seat = el.dataset.seat && st.seats.find((s) => s.id === el.dataset.seat);
      const ar = el.dataset.area && st.areas.find((a) => a.id === el.dataset.area);
      if (mode === 'area' && ar) { SeatEdit.selectedArea = ar.id; SeatEdit.selected = null; SeatEdit.anchor = null; render(); return; }
      if (el.dataset.x === undefined) return;
      const x = Number(el.dataset.x), y = Number(el.dataset.y);
      if (TWO_CLICK.includes(mode)) {
        if (!SeatEdit.anchor) { SeatEdit.anchor = { x, y }; render(); return; }
        const r = rect(x, y);
        SeatEdit.anchor = null;
        if (mode === 'block') {
          const used = new Set(st.seats.map((s) => `${s.x},${s.y}`));
          for (let yy = r.y; yy < r.y + r.h; yy++) {
            for (let xx = r.x; xx < r.x + r.w; xx++) {
              if (!used.has(`${xx},${yy}`)) st.seats.push({ id: newHexId(), x: xx, y: yy, label: nextLabel(st.seats), category: null, locked: false });
            }
          }
        } else if (mode === 'erase') {
          st.seats = st.seats.filter((s) => !inside(r, s));
        } else {
          const a = { id: newHexId(), ...r, label: 'Bereich', kind: 'area', color: AREA_COLORS.area };
          st.areas.push(a);
          SeatEdit.selectedArea = a.id;
          SeatEdit.selected = null;
        }
        mark();
        return;
      }
      if (mode) {
        if (!seat) return;
        if (mode === 'lock') seat.locked = !seat.locked;
        else seat.category = mode === 'none' ? null : mode;
        mark();
        return;
      }
      if (seat) { SeatEdit.selected = seat.id; SeatEdit.selectedArea = null; render(); return; }
      const s = { id: newHexId(), x, y, label: nextLabel(st.seats), category: null, locked: false };
      st.seats.push(s);
      SeatEdit.selected = s.id;
      mark();
    };

    const resize = () => {
      st.cols = Math.min(Math.max(Number($('sCols').value) || st.cols, 2), 80);
      st.rows = Math.min(Math.max(Number($('sRows').value) || st.rows, 2), 60);
      st.seats = st.seats.filter((s) => s.x < st.cols && s.y < st.rows);
      st.areas = st.areas.filter((a) => a.x < st.cols && a.y < st.rows)
        .map((a) => ({ ...a, w: Math.min(a.w, st.cols - a.x), h: Math.min(a.h, st.rows - a.y) }));
      mark();
    };
    $('sCols').onchange = resize;
    $('sRows').onchange = resize;
    $('sSave').onclick = async () => {
      try {
        await api('PUT', '/seating', st);
        SeatEdit.dirty = false;
        toast('Sitzplan gespeichert');
        render();
      } catch (err) { toast(err.message); }
    };

    // Kategorien
    $('catAdd').onclick = () => {
      cats.push({ id: newHexId(), name: `Bereich ${cats.length + 1}`, short: '', color: CAT_COLORS[cats.length % CAT_COLORS.length] });
      mark();
    };
    app.querySelectorAll('.cat-row').forEach((row) => {
      const c = cats.find((x) => x.id === row.dataset.cat);
      row.querySelector('[data-cat-name]').onchange = (e) => { c.name = e.target.value.trim() || c.name; mark(); };
      row.querySelector('[data-cat-short]').onchange = (e) => { c.short = e.target.value.trim().slice(0, 2); mark(); };
      row.querySelector('[data-cat-color]').onchange = (e) => { c.color = e.target.value; mark(); };
      row.querySelector('[data-cat-del]').onclick = () => {
        if (!confirm(`Kategorie „${c.name}“ entfernen? Die Plätze bleiben, nur ohne Kategorie.`)) return;
        st.categories = cats.filter((x) => x !== c);
        for (const s of st.seats) if (s.category === c.id) s.category = null;
        mark();
      };
    });

    // Defragmentierung
    const dfPreview = $('dfPreview');
    if (dfPreview) dfPreview.onclick = async () => { SeatEdit.preview = (await api('POST', '/seats/defrag', {})).moves; render(); };
    const dfApply = $('dfApply');
    if (dfApply) dfApply.onclick = async () => {
      if (!confirm('Umzüge jetzt übernehmen? Betroffene bekommen eine Discord-Nachricht.')) return;
      const r = await api('POST', '/seats/defrag', { apply: true });
      SeatEdit.preview = null;
      toast(`${r.moves.length} Plätze neu verteilt`);
      render();
    };

    if (sel) {
      $('sLabel').onchange = (e) => { sel.label = e.target.value.trim() || sel.label; mark(); };
      $('sCat').onchange = (e) => { sel.category = e.target.value || null; mark(); };
      $('sLock').onchange = (e) => { sel.locked = e.target.checked; mark(); };
      $('sPerson').onchange = async (e) => {
        try {
          if (e.target.value) await api('PUT', '/people/' + e.target.value, { seat: sel.id });
          else if (holder) await api('PUT', '/people/' + holder.id, { seat: null });
          toast('Platz zugewiesen');
          SeatEdit.data = await People.load();
          render();
        } catch (err) { toast(err.message); }
      };
      $('sDel').onclick = () => {
        st.seats = st.seats.filter((s) => s !== sel);
        SeatEdit.selected = null;
        mark();
      };
    }

    if (area) {
      $('aKind').onchange = (e) => {
        const wasDefault = Object.values(AREA_KINDS).includes(area.label) || !area.label;
        area.kind = e.target.value;
        area.color = AREA_COLORS[area.kind];
        if (wasDefault) area.label = area.kind === 'wall' ? '' : AREA_KINDS[area.kind];
        mark();
      };
      $('aLabel').onchange = (e) => { area.label = e.target.value.trim(); mark(); };
      $('aColor').onchange = (e) => { area.color = e.target.value; mark(); };
      app.querySelectorAll('[data-ageo]').forEach((inp) => {
        inp.onchange = () => {
          const k = inp.dataset.ageo;
          let v = Math.floor(Number(inp.value)) || 1;
          if (k === 'x' || k === 'y') v -= 1; // Anzeige ab 1
          area[k] = Math.max(k === 'w' || k === 'h' ? 1 : 0, v);
          area.x = Math.min(area.x, st.cols - 1);
          area.y = Math.min(area.y, st.rows - 1);
          area.w = Math.min(area.w, st.cols - area.x);
          area.h = Math.min(area.h, st.rows - area.y);
          mark();
        };
      });
      $('aDel').onclick = () => {
        st.areas = st.areas.filter((a) => a !== area);
        SeatEdit.selectedArea = null;
        mark();
      };
    }
  },
};
