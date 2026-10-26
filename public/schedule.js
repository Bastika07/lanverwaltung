'use strict';
/* global api, esc, toast, on, views, adminViews, adminTabs, homeCards, beamerSlides, countdownText, render, markdown, markdownHelp */
// Programm: Zeitplan mit Countdown (Seite, Startseite, Beamer) und Admin-Pflege.

const Sched = {
  load: () => api('GET', '/schedule'),
  time: (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
  day: (iso) => new Date(iso).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }),
  // Zustand eines Punktes: vorbei / läuft / kommt
  status(e, now = Date.now()) {
    const start = Date.parse(e.start);
    const end = e.end ? Date.parse(e.end) : start + 30 * 60000; // ohne Ende: 30 Min als "läuft"
    if (now >= end) return 'past';
    if (now >= start) return 'now';
    return 'next';
  },
  // Laufende und kommende Punkte
  upcoming(list) { return list.filter((e) => Sched.status(e) !== 'past'); },
};

function schedItem(e) {
  const st = Sched.status(e);
  return `<li class="sched-item ${st}">
    <div class="sched-time">${Sched.time(e.start)}${e.end ? `<span>– ${Sched.time(e.end)}</span>` : ''}</div>
    <div class="sched-body">
      <div class="sched-title">${esc(e.title)}${e.announce ? ' <span title="Mit Durchsage">📢</span>' : ''}</div>
      ${e.note ? `<div class="meta markdown">${markdown(e.note)}</div>` : ''}
    </div>
    <div class="sched-state">${st === 'now' ? '<span class="badge running">läuft</span>'
      : st === 'next' ? `<span class="countdown" data-countdown="${e.start}">${countdownText(e.start)}</span>` : ''}</div>
  </li>`;
}

// Nach Tagen gruppiert
function schedList(list) {
  const days = [];
  for (const e of list) {
    const d = Sched.day(e.start);
    if (!days.length || days[days.length - 1].day !== d) days.push({ day: d, items: [] });
    days[days.length - 1].items.push(e);
  }
  return days.map((d) => `<h2 class="section-title">${esc(d.day)}</h2><ul class="sched">${d.items.map(schedItem).join('')}</ul>`).join('');
}

views.programm = {
  label: 'Programm', module: 'schedule', events: ['schedule'],
  async render() {
    const list = await Sched.load();
    document.getElementById('app').innerHTML = `<div class="page-head"><h1>Programm</h1></div>
      ${list.length ? `<div class="card">${schedList(list)}</div>` : '<div class="empty">Noch kein Programm eingetragen.</div>'}`;
  },
};

// Startseite: was läuft / kommt als Nächstes
homeCards.push({
  module: 'schedule', order: 10,
  async render() {
    const next = Sched.upcoming(await Sched.load()).slice(0, 3);
    if (!next.length) return '';
    return `<div class="card next-card"><div class="row" style="justify-content:space-between">
      <h2>🗓️ Als Nächstes</h2><a href="#/programm" class="meta">Ganzes Programm →</a></div>
      <ul class="sched compact">${next.map(schedItem).join('')}</ul></div>`;
  },
});

// Beamer-Folie
beamerSlides.push({
  module: 'schedule', order: 20,
  async build() {
    const next = Sched.upcoming(await Sched.load()).slice(0, 8);
    if (!next.length) return [];
    return [{ title: '🗓️ Programm', html: `<div class="beamer-sched"><ul class="sched">${next.map(schedItem).join('')}</ul></div>`, width: 1100 }];
  },
});

// ---------- Admin ----------
// <input type="datetime-local"> erwartet Ortszeit ohne Zeitzone
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

adminViews.programm = {
  label: 'Programm', module: 'schedule', order: 20, events: ['schedule'],
  async render(editId) {
    const [list, s] = await Promise.all([Sched.load(), api('GET', '/settings')]);
    const edit = list.find((e) => e.id === editId);
    const def = new Date(Date.now() + 60 * 60000);
    def.setMinutes(0, 0, 0);
    const e = edit || { title: '', start: def.toISOString(), end: null, note: '', remind: s.remindMinutes, announce: false };
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('programm')}
      <div class="two">
        <div class="card">
          <h2>${edit ? 'Programmpunkt bearbeiten' : 'Neuer Programmpunkt'}</h2>
          <form id="schedForm">
            <div class="field"><label for="sTitle">Titel</label><input id="sTitle" maxlength="120" required value="${esc(e.title)}" placeholder="z. B. Abendessen"></div>
            <div class="row two-inputs">
              <div class="field"><label for="sStart">Beginn</label><input id="sStart" type="datetime-local" required value="${toLocalInput(e.start)}"></div>
              <div class="field"><label for="sEnd">Ende <span class="meta">(optional)</span></label><input id="sEnd" type="datetime-local" value="${toLocalInput(e.end)}"></div>
            </div>
            <div class="field"><label for="sNote">Hinweis <span class="meta">(optional, Markdown)</span></label><textarea id="sNote" class="short" maxlength="500" placeholder="z. B. Pizza wird im Flur verteilt">${esc(e.note)}</textarea>${markdownHelp('sNote')}</div>
            <div class="field"><label for="sRemind">Erinnerung in Discord vorher (Minuten, 0 = keine)</label><input id="sRemind" type="number" min="0" max="1440" value="${e.remind}" style="max-width:140px"></div>
            <label class="check field"><input type="checkbox" id="sAnnounce" ${e.announce ? 'checked' : ''} ${on('announcements') ? '' : 'disabled'}> 📢 Zum Beginn als Durchsage (Lampe, Gong, Einblendung)</label>
            <p class="error" id="sError"></p>
            <div class="row">
              <button type="submit" class="primary">${edit ? 'Speichern' : 'Hinzufügen'}</button>
              ${edit ? '<a class="btn" href="#/admin/programm">Abbrechen</a>' : ''}
            </div>
          </form>
        </div>
        <div class="card">
          <h2>Programm (${list.length})</h2>
          ${list.length ? `<table class="admin-list"><tbody>${list.map((x) => `<tr class="${Sched.status(x)}">
            <td class="nowrap">${Sched.day(x.start).split(',')[0]}<br><strong>${Sched.time(x.start)}</strong></td>
            <td><strong>${esc(x.title)}</strong>${x.announce ? ' 📢' : ''}<div class="meta markdown">${markdown(x.note || '')}</div>${x.remind ? `<div class="meta">⏰ ${x.remind} Min vorher</div>` : ''}</td>
            <td><div class="row"><a class="btn" href="#/admin/programm/${x.id}">Bearbeiten</a><button class="danger" data-del="${x.id}">Löschen</button></div></td>
          </tr>`).join('')}</tbody></table>` : '<p class="meta">Noch leer.</p>'}
        </div>
      </div>`;

    document.getElementById('schedForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const val = (id) => document.getElementById(id).value;
      const body = {
        title: val('sTitle'),
        start: new Date(val('sStart')).toISOString(),
        end: val('sEnd') ? new Date(val('sEnd')).toISOString() : null,
        note: val('sNote'),
        remind: Number(val('sRemind')),
        announce: document.getElementById('sAnnounce').checked,
      };
      try {
        if (edit) await api('PUT', '/schedule/' + edit.id, body);
        else await api('POST', '/schedule', body);
        toast(edit ? 'Gespeichert' : 'Hinzugefügt');
        document.activeElement.blur();
        if (edit) location.hash = '#/admin/programm'; else render();
      } catch (err) { document.getElementById('sError').textContent = err.message; }
    };
    app.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Programmpunkt löschen?')) return;
        await api('DELETE', '/schedule/' + b.dataset.del);
        render();
      };
    });
  },
};
