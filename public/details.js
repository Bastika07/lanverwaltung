'use strict';
/* global api, esc, toast, state, views, adminViews, adminTabs, homeCards, render, richText, markdownHelp */
// Eventdetails: allgemeine Infos zum Event (Beginn, Ende, Ort, Mindestalter, Tickets …) für
// Interessierte und Käufer – auch für kommende Events. Die Infos vor Ort (WLAN, Server) stehen in info.js.

const eur = (cents) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const longDate = (iso) => new Date(iso).toLocaleString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
const mapUrl = (address) => `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`;

function detailsHtml(d) {
  const x = d.details;
  const rows = [
    d.event.start ? ['Beginn', esc(longDate(d.event.start))] : null,
    d.event.end ? ['Ende', esc(longDate(d.event.end))] : null,
    x.capacity ? ['Teilnehmer', `${x.capacity}`] : null,
    d.minAge ? ['Mindestalter', `${d.minAge} Jahre`] : null,
    x.location || x.address ? ['Location', `${x.location ? `<strong>${esc(x.location)}</strong>` : ''}${x.address
      ? `${x.location ? '<br>' : ''}${esc(x.address)} <a href="${mapUrl(x.address)}" target="_blank" rel="noopener noreferrer">Karte ↗</a>` : ''}`] : null,
    x.spectatorFee ? ['Zuschauer', esc(x.spectatorFee)] : null,
  ].filter(Boolean);
  return `<div class="card"><h2>📋 Details zur ${esc(d.event.name)}</h2>
      ${rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : '<p class="meta">Noch keine Details eingetragen.</p>'}
      ${x.text ? `<div class="markdown">${richText(x.text)}</div>` : ''}
    </div>
    ${d.tickets.length ? `<div class="card"><h2>🎟️ Tickets und Eintrittspreise</h2>
      <table class="admin-list"><tbody>${d.tickets.map((t) => `<tr><td><strong>${esc(t.name)}</strong>${t.description ? `<div class="meta markdown">${richText(t.description)}</div>` : ''}</td>
        <td class="nowrap" style="text-align:right"><strong>${t.price ? eur(t.price) : 'kostenlos'}</strong></td></tr>`).join('')}</tbody></table>
      ${state.settings.modules.tickets ? '<p><a class="btn primary" href="#/tickets">Zu den Tickets</a></p>' : ''}</div>` : ''}`;
}

views.event = {
  label: 'Event', module: 'details', events: ['details', 'tickets', 'settings'],
  async render() {
    const d = await api('GET', '/details');
    const chips = d.events.length > 1 ? `<div class="event-chips">${d.events.map((e) => `<button class="chip ${e.id === d.event.id ? 'active' : ''}" data-dev="${e.id}">
      ${esc(e.name)}${e.start ? ` <span class="meta">${new Date(e.start).toLocaleDateString('de-DE')}</span>` : ''}</button>`).join('')}</div>` : '';
    document.getElementById('app').innerHTML = `<div class="page-head"><h1>${esc(d.event.name)}</h1></div>${chips}${detailsHtml(d)}`;
    document.querySelectorAll('[data-dev]').forEach((b) => { b.onclick = () => { state.detailsEvent = b.dataset.dev; render(); }; });
  },
};

// Startseite: Kurzinfo mit Link zu den Details
homeCards.push({
  module: 'details', order: 1,
  async render() {
    const d = await api('GET', '/details');
    const x = d.details;
    if (!d.event.start && !x.location) return '';
    return `<a class="card home-details" href="#/event" style="display:block;text-decoration:none;color:inherit">
      <strong>📋 ${esc(d.event.name)}</strong>
      <span class="meta">${[d.event.start ? new Date(d.event.start).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) : '', x.location].filter(Boolean).map(esc).join(' · ')} – alle Details ›</span></a>`;
  },
});

// ---------- Admin ----------
adminViews.details = {
  label: 'Eventdetails', module: 'details', order: 6, events: ['details'],
  async render() {
    const d = await api('GET', '/details');
    const x = d.details;
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('details')}
      <div class="two">
        <form id="dForm" class="card editor"><h2>Details zu ${esc(d.event.name)}</h2>
          <div class="row two-inputs">
            <div class="field"><label for="dLoc">Location</label><input id="dLoc" maxlength="120" value="${esc(x.location)}" placeholder="z. B. Schützenhalle Maschen"></div>
            <div class="field"><label for="dCap">Teilnehmerzahl</label><input id="dCap" type="number" min="0" value="${x.capacity ?? ''}" placeholder="z. B. 200" style="max-width:140px"></div>
          </div>
          <div class="field"><label for="dAddr">Adresse</label><input id="dAddr" maxlength="300" value="${esc(x.address)}" placeholder="Straße, PLZ Ort"></div>
          <div class="field"><label for="dFee">Zuschauer / Begleiter</label><input id="dFee" maxlength="120" value="${esc(x.spectatorFee)}" placeholder="z. B. 5 Euro Eintritt ohne PC"></div>
          <div class="field"><label for="dText">Weitere Infos (Markdown)</label><textarea id="dText">${esc(x.text)}</textarea>${markdownHelp('dText')}</div>
          <p class="error" id="dError"></p>
          <button class="primary" type="submit">Speichern</button>
        </form>
        <div>
          <div class="card"><h2>Automatisch</h2>
            <p class="meta">Diese Angaben kommen aus dem Event und bleiben so immer aktuell:</p>
            <ul class="meta"><li><strong>Beginn und Ende</strong> – unter „Events“</li><li><strong>Mindestalter</strong> – unter „Tickets → Verkauf“</li>
              <li><strong>Tickets und Preise</strong> – die aktiven Ticketarten mit Beschreibung</li></ul>
            <p class="hint">Die Infos vor Ort (WLAN, Gameserver, Spiele, Regeln) pflegst du im Reiter „Infos“.</p>
          </div>
          <div class="card"><h2>Vorschau</h2>${detailsHtml(d)}</div>
        </div>
      </div>`;
    const v = (id) => document.getElementById(id).value;
    document.getElementById('dForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('PUT', '/details', { location: v('dLoc'), address: v('dAddr'), capacity: v('dCap'), spectatorFee: v('dFee'), text: v('dText') });
        toast('Gespeichert');
        document.activeElement.blur();
        render();
      } catch (err) { document.getElementById('dError').textContent = err.message; }
    };
  },
};
