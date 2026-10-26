'use strict';
/* global api, esc, toast, state, adminViews, adminTabs, loadMe, render, toLocalInput, countdownText, setAdminEvent */
// Eventverwaltung: Events anlegen (mit Vorlage), Zeitraum, starten/beenden, löschen.

const EvAdmin = { edit: null }; // id des Events im Bearbeiten-Formular

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '');
function evStatus(e) {
  if (e.active) return `<span class="badge running">läuft</span>${e.end ? ` <span class="meta">bis ${fmtDate(e.end)}</span>` : ''}`;
  if (e.over) return `<span class="badge finished">vorbei</span>${e.endedAt ? ` <span class="meta">${fmtDate(e.endedAt)}</span>` : ''}`;
  if (e.start && Date.parse(e.start) > Date.now()) return `<span class="badge">geplant</span> <span class="meta">Beginn <span data-countdown="${e.start}">${countdownText(e.start)}</span></span>`;
  return '<span class="badge draft">nicht gestartet</span>';
}

adminViews.events = {
  label: 'Events', order: 5, events: ['settings', 'tickets', 'people', 'tournament'],
  async render() {
    const list = await api('GET', '/event');
    state.events = list;
    const ev = list.events.find((e) => e.id === EvAdmin.edit) || null;
    const latest = list.events.slice().sort((a, b) => (b.start || b.createdAt).localeCompare(a.start || a.createdAt))[0];
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('events')}
      <div class="card"><h2>🎮 Events</h2>
        <p class="meta">Jedes Event hat eigene Turniere, Programm, Infos, Ticketarten, Bestellungen und Teilnehmerliste.
          Personen, Konten, Sitzplan-Layout, Bankdaten und die übrigen Einstellungen gelten für alle Events.
          Besucher sehen das laufende Event, sonst das nächste geplante.</p>
        <div style="overflow-x:auto"><table class="admin-list"><tbody>${list.events.slice().reverse().map((e) => `<tr class="event-row ${e.active ? 'active-ev' : ''} ${e.over ? 'past' : ''}">
          <td><strong>${esc(e.name)}</strong> ${e.id === list.currentId ? '<span class="badge">für Besucher</span>' : ''}
            <div class="meta">${e.start ? fmtDate(e.start) : 'kein Beginn'}${e.end ? ` – ${fmtDate(e.end)}` : ''}</div>
            ${e.error ? `<div class="error">⚠️ Discord: ${esc(e.error)}</div>` : ''}</td>
          <td>${evStatus(e)}</td>
          <td class="meta">${e.counts.tournaments} Turniere · ${e.counts.attendees} Teilnehmer · ${e.counts.tickets} bezahlte Tickets${e.sale.saleOpen ? '' : ' · Verkauf zu'}</td>
          <td><div class="row">
            <button class="small" data-ev-use="${e.id}" title="Turniere, Programm, Tickets … dieses Events bearbeiten">Bearbeiten</button>
            <button class="small" data-ev-edit="${e.id}">Name & Zeitraum</button>
            ${e.active ? `<button class="small danger" data-ev-end="${e.id}">⏹ Beenden</button>` : `<button class="small" data-ev-start="${e.id}">▶ Starten</button>`}
            ${!e.active && !e.counts.orders && list.events.length > 1 ? `<button class="small danger" data-ev-del="${e.id}" title="Löschen">🗑</button>` : ''}
          </div></td></tr>`).join('')}</tbody></table></div>
      </div>

      <div class="two">
        <div class="card"><h2>${ev ? `„${esc(ev.name)}“ bearbeiten` : 'Neues Event'}</h2>
          <form id="evForm">
            <div class="field"><label for="evName">Name</label><input id="evName" required maxlength="60" value="${esc(ev ? ev.name : '')}" placeholder="z. B. Seniorenlan #6"></div>
            <div class="row two-inputs">
              <div class="field"><label for="evStart">Beginn</label><input id="evStart" type="datetime-local" value="${toLocalInput(ev && ev.start)}"></div>
              <div class="field"><label for="evEnd">Ende</label><input id="evEnd" type="datetime-local" value="${toLocalInput(ev && ev.end)}"></div>
            </div>
            ${ev ? '' : `<div class="field"><label for="evCopy">Übernehmen von</label><select id="evCopy"><option value="">– nichts, leer anlegen –</option>
              ${list.events.map((e) => `<option value="${e.id}" ${e === latest ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
              <p class="hint">Übernimmt Infos (WLAN, Gameserver, Spiele, Regeln), Ticketarten und Verkaufseinstellungen.
                Turniere, Programm, Bestellungen und Teilnehmer beginnen leer.</p></div>`}
            <p class="error" id="evError"></p>
            <div class="row"><button class="primary" type="submit">${ev ? 'Speichern' : 'Event anlegen'}</button>${ev ? '<button type="button" id="evCancel">Abbrechen</button>' : ''}</div>
          </form>
        </div>
        <div class="card"><h2>So funktioniert's</h2>
          <ul class="meta">
            <li><strong>Vorverkauf:</strong> Lege das nächste Event an und öffne den Ticketverkauf (Admin → Tickets mit dem Event oben ausgewählt).
              Käufer wählen auf der Ticketseite, für welches Event sie bestellen – auch während ein anderes läuft.</li>
            <li><strong>Start und Ende</strong> geschehen automatisch zum eingetragenen Zeitraum oder per Knopf. Es läuft immer nur ein Event;
              startest du ein anderes, wird das laufende beendet.</li>
            <li><strong>Discord:</strong> Zum Start legt der Bot die Kategorie „🎮 &lt;Eventname&gt;“ mit <code>#lan-ansagen</code> und <code>#turnier-ansagen</code>
              und die Voice-Kanäle der Turniere an, zum Ende löscht er sie. Außerhalb eines laufenden Events gehen keine Ansagen nach Discord.</li>
            <li><strong>Archiv:</strong> Vergangene Events bleiben mit Turnieren, Teilnehmern und Bestellungen erhalten.
              Wer wie oft dabei war, steht unter „Personen“.</li>
          </ul>
        </div>
      </div>`;

    const $ = (id) => document.getElementById(id);
    const v = (id) => $(id).value;
    const iso = (id) => (v(id) ? new Date(v(id)).toISOString() : null);
    const act = async (fn, msg) => { try { await fn(); toast(msg); await loadMe(); render(); } catch (err) { toast(err.message); } };

    $('evForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: v('evName'), start: iso('evStart'), end: iso('evEnd') };
      try {
        if (ev) await api('PUT', '/event/' + ev.id, body);
        else {
          const created = await api('POST', '/event', { ...body, copyFrom: v('evCopy') || null });
          setAdminEvent(created.id); // gleich weiter vorbereiten (Ticketarten, Programm …)
        }
        EvAdmin.edit = null;
        toast(ev ? 'Gespeichert' : 'Event angelegt – du bearbeitest jetzt dieses Event');
        document.activeElement.blur();
        await loadMe();
        render();
      } catch (err) { $('evError').textContent = err.message; }
    };
    if ($('evCancel')) $('evCancel').onclick = () => { EvAdmin.edit = null; render(); };
    app.querySelectorAll('[data-ev-edit]').forEach((b) => { b.onclick = () => { EvAdmin.edit = b.dataset.evEdit; render(); }; });
    app.querySelectorAll('[data-ev-use]').forEach((b) => {
      b.onclick = () => { setAdminEvent(b.dataset.evUse); location.hash = '#/admin'; };
    });
    app.querySelectorAll('[data-ev-start]').forEach((b) => {
      const e = list.events.find((x) => x.id === b.dataset.evStart);
      const running = list.events.find((x) => x.active);
      b.onclick = () => confirm(`„${e.name}“ jetzt starten?${running ? `\n„${running.name}“ wird dabei beendet.` : ''}\nDer Bot legt die Discord-Kanäle an.`)
        && act(() => api('POST', `/event/${e.id}/start`), 'Event gestartet');
    });
    app.querySelectorAll('[data-ev-end]').forEach((b) => {
      b.onclick = () => confirm('Event jetzt beenden? Die Discord-Ansage- und Voice-Kanäle werden gelöscht.')
        && act(() => api('POST', `/event/${b.dataset.evEnd}/end`), 'Event beendet');
    });
    app.querySelectorAll('[data-ev-del]').forEach((b) => {
      const e = list.events.find((x) => x.id === b.dataset.evDel);
      b.onclick = () => confirm(`„${e.name}“ mit allen Turnieren, Programmpunkten und Teilnahmen löschen?`)
        && act(() => api('DELETE', '/event/' + e.id), 'Event gelöscht');
    });
  },
};
