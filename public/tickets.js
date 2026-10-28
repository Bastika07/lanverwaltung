'use strict';
/* global api, esc, toast, state, on, views, adminViews, adminTabs, startHooks, liveHandlers, render, scopeEventId, copyBtn, toLocalInput, QR, renderLogin, seatMap, seatLegend, loadMe, websiteLegalLinks, markdown, markdownHelp */
// Tickets: Anmeldung mit Discord, eigene Daten, Bestellung mit Namen pro Ticket,
// Überweisungsdaten, eigene Tickets – und die Verwaltung im Admin-Bereich.
// Gibt es Tickets für mehrere Events (Vorverkauf fürs nächste), wählt der Besucher das Event (state.ticketEvent).

const euro = (cents) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const dateDe = (iso) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const STATUS = { pending: ['offen', 'running'], paid: ['bezahlt', 'finished'], cancelled: ['storniert', 'draft'] };
const statusBadge2 = (s) => `<span class="badge ${STATUS[s][1]}">${STATUS[s][0]}</span>`;

const Tix = { account: null, loginEnabled: false, editProfile: false, pick: null }; // pick: Ticket, für das gerade ein Platz gewählt wird

// Der QR-Code enthält den Check-in-Link: Orga scannt mit der normalen Handy-Kamera.
const checkinUrl = (code) => `${state.settings.publicUrl || location.origin}/#/checkin/${code}`;
const qrSvg = (code) => QR.svg(checkinUrl(code));

// Alle bezahlten Tickets einer Bestellung drucken (eine Seite je Ticket)
function printTickets(o) {
  let area = document.getElementById('printArea');
  if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
  const name = o.eventName || state.settings.eventName || 'LAN-Party';
  area.innerHTML = o.tickets.map((t) => `<div class="print-ticket">
    <div class="pt-event">🎮 ${esc(name)}</div>
    <div class="pt-qr">${qrSvg(t.code)}</div>
    <div class="pt-holder">${esc(t.holder)}</div>
    <div class="pt-type">${esc(t.typeName)}</div>
    <div class="pt-code">${esc(t.code)}</div>
    <div class="pt-ref">Bestellung ${esc(o.ref)} · beim Einlass vorzeigen</div>
  </div>`).join('');
  window.print();
}

async function loadAccount() {
  if (!on('tickets')) { Tix.account = null; return; }
  const r = await api('GET', '/account').catch(() => ({ account: null, loginEnabled: false }));
  Tix.account = r.account;
  Tix.loginEnabled = r.loginEnabled;
}
startHooks.push(loadAccount);
liveHandlers.push((ev) => { if (ev.type === 'settings') loadAccount(); });

// Verkaufszeitraum einer Ticketart als Text
function saleInfo(t) {
  if (t.onSale) return t.saleEnd ? `Verkauf bis ${dateDe(t.saleEnd)}` : '';
  if (t.available === 0) return 'ausverkauft';
  if (t.saleStart && Date.parse(t.saleStart) > Date.now()) return `Verkauf ab ${dateDe(t.saleStart)}`;
  return 'derzeit nicht erhältlich';
}

function profileForm(a, privacy) {
  const p = a.profile || { firstName: '', lastName: '', street: '', zip: '', city: '', email: a.discordEmail || '', birthdate: '' };
  const f = (id, label, val, attrs = '') => `<div class="field"><label for="pf_${id}">${label}</label><input id="pf_${id}" value="${esc(val)}" ${attrs} required></div>`;
  return `<form id="profileForm">
    <div class="row two-inputs">${f('firstName', 'Vorname', p.firstName, 'autocomplete="given-name"')}${f('lastName', 'Nachname', p.lastName, 'autocomplete="family-name"')}</div>
    ${f('street', 'Straße und Hausnummer', p.street, 'autocomplete="street-address"')}
    <div class="row two-inputs">${f('zip', 'PLZ', p.zip, 'autocomplete="postal-code" inputmode="numeric" maxlength="5" style="max-width:120px"')}${f('city', 'Ort', p.city, 'autocomplete="address-level2"')}</div>
    <div class="row two-inputs">${f('email', 'E-Mail', p.email, 'type="email" autocomplete="email"')}${f('birthdate', 'Geburtsdatum', p.birthdate, 'type="date" autocomplete="bday"')}</div>
    <div class="privacy markdown">${markdown(privacy)}</div>
    ${websiteLegalLinks(['datenschutz'])}
    <label class="check field"><input type="checkbox" id="pf_consent" ${a.consentAt ? 'checked' : ''}> Ich habe den Datenschutzhinweis gelesen und bin einverstanden.</label>
    <p class="error" id="pfError"></p>
    <div class="row"><button class="primary" type="submit">Daten speichern</button>
      ${a.complete ? '<button type="button" id="pfCancel">Abbrechen</button>' : ''}</div>
  </form>`;
}

function orderCard(o, bank) {
  const pending = o.status === 'pending';
  return `<div class="card order ${o.status}">
    <div class="row" style="justify-content:space-between"><h3>🎟️ ${esc(o.ref)}</h3>${statusBadge2(o.status)}</div>
    <p class="meta">${o.eventName ? `<strong>${esc(o.eventName)}</strong> · ` : ''}Bestellt am ${dateDe(o.createdAt)} · ${o.tickets.length} Ticket${o.tickets.length === 1 ? '' : 's'} · ${euro(o.total)}</p>
    ${pending ? `<div class="paybox">
      <strong>Bitte überweisen bis ${dateDe(o.dueAt)}:</strong>
      <dl class="kv">
        ${bank.holder ? `<dt>Empfänger</dt><dd>${esc(bank.holder)}</dd>` : ''}
        ${bank.iban ? `<dt>IBAN</dt><dd><code>${esc(bank.iban.replace(/(.{4})/g, '$1 ').trim())}</code> ${copyBtn(bank.iban)}</dd>` : ''}
        ${bank.bic ? `<dt>BIC</dt><dd><code>${esc(bank.bic)}</code>${bank.bank ? ` · ${esc(bank.bank)}` : ''}</dd>` : ''}
        <dt>Betrag</dt><dd><strong>${euro(o.total)}</strong> ${copyBtn((o.total / 100).toFixed(2).replace('.', ','))}</dd>
        <dt>Verwendungszweck</dt><dd><code>${esc(o.ref)}</code> ${copyBtn(o.ref)}</dd>
      </dl>
      <p class="hint">Bitte genau diesen Verwendungszweck angeben, damit wir die Zahlung zuordnen können. Die Bestätigung kommt, sobald das Geld da ist.</p>
    </div>` : ''}
    <table class="tix"><tbody>${o.tickets.map((t) => `<tr>
      <td>${esc(t.typeName)}<div class="meta">${euro(t.price)}</div></td>
      <td>${o.status === 'cancelled' ? esc(t.holder) : `<input data-holder="${t.id}" value="${esc(t.holder)}" maxlength="60">`}
        ${o.status === 'paid' && t.personId ? `<input data-clan="${t.id}" value="${esc(t.clan || '')}" maxlength="40" placeholder="Clan (optional)" class="clan-input">` : ''}</td>
      <td class="nowrap">${o.status === 'paid' ? `<span class="ticket-code" title="Beim Einlass vorzeigen">${esc(t.code)}</span>
        <button class="small" data-qr="${t.code}" title="QR-Code für den Einlass">▦ QR</button>${t.checkedInAt ? ' ✅' : ''}` : ''}</td>
    </tr>${o.status === 'paid' ? `<tr class="qr-row" data-qr-row="${t.code}" hidden><td colspan="3">
      <div class="qr-box">${qrSvg(t.code)}<div><strong>${esc(t.holder)}</strong><div class="meta">${esc(t.typeName)}</div>
      <div class="ticket-code">${esc(t.code)}</div><p class="hint">Beim Einlass vorzeigen – Bildschirm hell stellen oder ausdrucken.</p></div></div>
    </td></tr>` : ''}`).join('')}</tbody></table>
    ${o.status !== 'cancelled' ? `<div class="row"><button class="small" data-save-holders="${o.id}">Namen${o.status === 'paid' ? ' und Clans' : ''} speichern</button>
      ${o.status === 'paid' ? `<button class="small" data-print="${o.id}">🖨 Tickets drucken</button>` : ''}
      ${pending ? `<button class="small danger" data-cancel-order="${o.id}">Bestellung stornieren</button>` : ''}</div>` : ''}
  </div>`;
}

// ---------- Platzwahl (nach dem Kauf) ----------
function seatPicker(sd) {
  if (!sd || !sd.tickets.length || !sd.seating.seats.length) return '';
  const label = (id) => (sd.seating.seats.find((s) => s.id === id) || {}).label;
  const cats = Object.fromEntries((sd.seating.categories || []).map((c) => [c.id, c.name]));
  if (Tix.pick && !sd.tickets.some((t) => t.ticketId === Tix.pick)) Tix.pick = null;
  if (!Tix.pick) { const free = sd.tickets.find((t) => !t.seat); if (free && sd.open) Tix.pick = free.ticketId; }
  const cur = sd.tickets.find((t) => t.ticketId === Tix.pick);
  const people = Object.entries(sd.occupied).map(([seat, o]) => ({ id: seat, seat, name: o.name, clan: o.clan }));
  const mine = new Set(Object.entries(sd.occupied).filter(([, o]) => o.mine).map(([seat]) => seat));
  const pickable = (s) => !!cur && !s.locked && !sd.occupied[s.id] && (cur.allowed === null || cur.allowed.includes(s.category));
  return `<div class="card seat-picker"><h2>💺 Deine Plätze</h2>
    ${sd.open ? '<p class="meta">Wähle ein Ticket und tippe auf einen freien Platz. Ein erneuter Tipp auf den Platz des gewählten Tickets gibt ihn wieder frei.</p>'
      : '<p class="hint">Die Platzwahl ist gerade geschlossen.</p>'}
    <div class="pick-list">${sd.tickets.map((t) => `<button class="pick-ticket ${t.ticketId === Tix.pick ? 'active' : ''}" data-pick="${t.ticketId}" ${sd.open ? '' : 'disabled'}>
      <strong>${esc(t.holder)}</strong><span class="meta">${esc(t.typeName)}${t.allowed ? ` · ${t.allowed.map((c) => esc(cats[c] || '')).join(', ')}` : ''}</span>
      <span>${t.seat ? `💺 Platz <strong>${esc(label(t.seat))}</strong>` : '<em>noch kein Platz</em>'}</span></button>`).join('')}</div>
    ${seatMap({ seating: sd.seating, people }, { mine, pickable: sd.open ? pickable : null })}
    ${seatLegend(sd.seating, { mine: true })}
    ${cur && cur.seat && sd.open ? `<button class="small" id="seatRelease">Platz von ${esc(cur.holder)} freigeben</button>` : ''}
  </div>`;
}

function bindSeatPicker(sd) {
  document.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => { Tix.pick = b.dataset.pick; render(); }; });
  const release = async () => { await api('POST', '/seats/reserve', { ticketId: Tix.pick, seatId: null }); toast('Platz freigegeben'); render(); };
  document.querySelectorAll('.seat-picker .seat.pick').forEach((c) => {
    c.onclick = async () => {
      try {
        const r = await api('POST', '/seats/reserve', { ticketId: Tix.pick, seatId: c.dataset.seat });
        toast(`💺 Platz ${r.seat} reserviert`);
        Tix.pick = null; // nächstes Ticket ohne Platz wird automatisch gewählt
        render();
      } catch (err) { toast(err.message); render(); }
    };
  });
  // Eigener Platz: Ticket dazu wählen – ist es schon gewählt, Platz freigeben
  document.querySelectorAll('.seat-picker .seat.mine').forEach((c) => {
    c.onclick = async () => {
      const t = sd && sd.tickets.find((x) => x.seat === c.dataset.seat);
      if (!t || !sd.open) return;
      if (t.ticketId === Tix.pick) await release();
      else { Tix.pick = t.ticketId; render(); }
    };
  });
  const rel = document.getElementById('seatRelease');
  if (rel) rel.onclick = release;
}

views.tickets = {
  label: 'Tickets', module: 'tickets', events: ['tickets', 'accounts'],
  async render() {
    await loadAccount();
    let pub = await api('GET', '/tickets');
    // Für das aktuelle Event gibt es keine Tickets, aber für ein anderes (Vorverkauf): das zeigen
    if (!state.ticketEvent && !pub.types.length && pub.events.some((e) => e.id !== pub.event.id)) {
      state.ticketEvent = pub.events.find((e) => e.id !== pub.event.id).id;
      pub = await api('GET', '/tickets');
    }
    const evChips = pub.events.length > 1 ? `<div class="event-chips">${pub.events.map((e) => `<button class="chip ${e.id === pub.event.id ? 'active' : ''}" data-tev="${e.id}">
      ${esc(e.name)}${e.start ? ` <span class="meta">${dateDe(e.start)}</span>` : ''}</button>`).join('')}</div>` : '';
    const a = Tix.account;
    const hint = state.route.query.get('hinweis');
    const types = pub.types;
    let mine = null;
    if (a) mine = await api('GET', '/tickets/mine').catch(() => null);
    Tix.orders = mine ? mine.orders : [];
    const seatData = Tix.seatData = a && a.complete && on('seating') && mine && mine.orders.some((o) => o.status === 'paid' && o.eventId === pub.event.id)
      ? await api('GET', '/seats/mine').catch(() => null) : null;
    const sellable = types.filter((t) => t.onSale);

    const typeList = types.length ? `<div class="grid tix-types">${types.map((t) => `<div class="card tix-type ${t.onSale ? '' : 'off'}">
        <div class="row" style="justify-content:space-between"><h3>${esc(t.name)}</h3><span class="price">${t.price ? euro(t.price) : 'kostenlos'}</span></div>
        ${t.description ? `<div class="meta markdown">${markdown(t.description)}</div>` : ''}
        <p class="meta">${[t.available != null && t.onSale ? `noch ${t.available} verfügbar` : '', saleInfo(t)].filter(Boolean).join(' · ')}</p></div>`).join('')}</div>`
      : '<div class="empty">Der Ticketverkauf hat noch nicht begonnen.</div>';

    let accountHtml;
    if (!a) {
      accountHtml = Tix.loginEnabled
        ? `<div class="card login-card"><h2>Anmelden</h2>
            <p>Um Tickets zu bestellen, melde dich mit deinem Discord-Konto an${pub.requireMember ? ' (nur für Mitglieder unseres Discord-Servers)' : ''}.</p>
            <a class="btn primary big discord-btn" href="/api/auth/login">Mit Discord anmelden</a>
            <p class="hint">Wir erhalten dabei nur deinen Discord-Namen und – falls freigegeben – deine E-Mail-Adresse.</p></div>`
        : '<div class="card"><p class="meta">Die Anmeldung für den Ticketverkauf ist noch nicht eingerichtet.</p></div>';
    } else {
      const head = `<div class="row account-head">${a.avatar ? `<img src="${esc(a.avatar)}" alt="" class="avatar">` : '👤'}
        <div><strong>${esc(a.name)}</strong><div class="meta">angemeldet mit Discord</div></div>
        <span class="spacer"></span><button class="small" id="userLogout">Abmelden</button></div>`;
      const profile = !a.complete || Tix.editProfile
        ? `<div class="card"><h2>Deine Daten</h2>${a.complete ? '' : '<p class="meta">Bevor du bestellen kannst, brauchen wir deine Anschrift.</p>'}${profileForm(a, pub.privacy)}</div>`
        : `<div class="card"><div class="row" style="justify-content:space-between"><h2>Deine Daten</h2><button class="small" id="pfEdit">Ändern</button></div>
            <p>${esc(a.profile.firstName)} ${esc(a.profile.lastName)}<br>${esc(a.profile.street)}<br>${esc(a.profile.zip)} ${esc(a.profile.city)}</p>
            <p class="meta">${esc(a.profile.email)} · geb. ${dateDe(a.profile.birthdate)}</p></div>`;
      const order = a.complete && sellable.length ? `<div class="card"><h2>Tickets bestellen <span class="meta">für ${esc(pub.event.name)}</span></h2>
          <form id="orderForm">
            ${sellable.map((t) => {
              const max = Math.min(t.maxPerOrder, t.available ?? t.maxPerOrder);
              return `<div class="order-line"><label for="q_${t.id}">${esc(t.name)} <span class="meta">${t.price ? euro(t.price) : 'kostenlos'}</span></label>
                <select id="q_${t.id}" data-qty="${t.id}">${Array.from({ length: max + 1 }, (_, i) => `<option>${i}</option>`).join('')}</select></div>`;
            }).join('')}
            <div id="holderBox"></div>
            <p class="order-total" id="orderTotal"></p>
            <p class="error" id="orderError"></p>
            ${websiteLegalLinks(['agb', 'verhaltenskodex', 'datenschutz'])}
            <button class="primary big" type="submit" id="orderBtn" disabled>Kostenpflichtig bestellen</button>
            <p class="hint">Bezahlt wird per Überweisung. Nach der Bestellung siehst du die Bankdaten; zahlbar innerhalb von ${pub.payDays} Tagen.</p>
          </form></div>` : '';
      const orders = mine && mine.orders.length
        ? `<h2 class="section-title">Deine Bestellungen</h2>${mine.orders.map((o) => orderCard(o, mine.bank)).join('')}` : '';
      accountHtml = `<div class="card">${head}</div>${profile}${seatPicker(seatData)}${order}${orders}
        <details class="danger-zone"><summary>Konto löschen</summary>
          <p class="meta">Löscht Profil, Konto und Sitzungen und löst deine Discord-Verknüpfung. Deine verknüpfte Person wird pseudonymisiert; offene Bestellungen werden storniert. Bezahlte Tickets bleiben gültig, Tickets anderer Inhaber und Ergebnisstände bleiben erhalten. Gastserver werden gesperrt; für DNS/IP-Freigaben bitte die Orga informieren. Sicherungen und bereits versandte Nachrichten werden dadurch nicht automatisch gelöscht.</p>
          <button class="danger" id="deleteAccount">Mein Konto endgültig löschen</button></details>`;
    }

    document.getElementById('app').innerHTML = `<div class="page-head"><h1>Tickets <span class="meta">${esc(pub.event.name)}</span></h1></div>
      ${hint ? `<div class="card hint-card">ℹ️ ${esc(hint)}</div>` : ''}
      ${evChips}
      ${!pub.saleOpen ? '<div class="card hint-card">Der Ticketverkauf ist gerade geschlossen.</div>' : ''}
      ${typeList}
      <div class="tix-account">${accountHtml}</div>`;
    document.querySelectorAll('[data-tev]').forEach((b) => { b.onclick = () => { state.ticketEvent = b.dataset.tev; Tix.pick = null; render(); }; });
    bindTicketPage(a, sellable, pub.event);
  },
};

function bindTicketPage(a, sellable, ev) {
  const $ = (id) => document.getElementById(id);
  if (!a) return;
  bindSeatPicker(Tix.seatData);
  $('userLogout').onclick = async () => { await api('POST', '/auth/logout'); Tix.account = null; await loadMe(); toast('Abgemeldet'); render(); };
  if ($('pfEdit')) $('pfEdit').onclick = () => { Tix.editProfile = true; render(); };
  if ($('pfCancel')) $('pfCancel').onclick = () => { Tix.editProfile = false; render(); };
  if ($('profileForm')) {
    $('profileForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = { consent: $('pf_consent').checked };
      for (const k of ['firstName', 'lastName', 'street', 'zip', 'city', 'email', 'birthdate']) body[k] = $('pf_' + k).value;
      try {
        await api('PUT', '/account', body);
        Tix.editProfile = false;
        toast('Daten gespeichert');
        document.activeElement.blur();
        render();
      } catch (err) { $('pfError').textContent = err.message; }
    };
  }

  // Bestellung: je Ticket ein Namensfeld, Summe live
  if ($('orderForm')) {
    const update = () => {
      const keep = Object.fromEntries([...document.querySelectorAll('[data-holder-new]')].map((i) => [i.dataset.holderNew, i.value]));
      let html = '', total = 0, n = 0;
      for (const t of sellable) {
        const q = Number($('q_' + t.id).value);
        total += q * t.price;
        for (let i = 0; i < q; i++) {
          const key = `${t.id}:${i}`;
          const def = n === 0 ? a.name : '';
          html += `<div class="field holder-line"><label>${esc(t.name)} #${i + 1} – Name</label>
            <input data-holder-new="${key}" data-type="${t.id}" value="${esc(keep[key] ?? def)}" maxlength="60" required placeholder="Name des Gastes"></div>`;
          n++;
        }
      }
      $('holderBox').innerHTML = n ? `<p class="meta">Für wen sind die Tickets? Der Name erscheint in der Teilnehmerliste und kann später geändert werden.</p>${html}` : '';
      $('orderTotal').innerHTML = n ? `Summe: <strong>${euro(total)}</strong> für ${n} Ticket${n === 1 ? '' : 's'}` : '';
      $('orderBtn').disabled = !n;
    };
    document.querySelectorAll('[data-qty]').forEach((s) => { s.onchange = update; });
    update();
    $('orderForm').onsubmit = async (e) => {
      e.preventDefault();
      const items = [...document.querySelectorAll('[data-holder-new]')].map((i) => ({ typeId: i.dataset.type, holder: i.value }));
      const total = $('orderTotal').textContent;
      if (!confirm(`Verbindlich bestellen für „${ev.name}“?\n${total}\n\nDie Bankdaten für die Überweisung bekommst du im nächsten Schritt.`)) return;
      try {
        const o = await api('POST', '/tickets/orders', { items });
        toast(o.status === 'paid' ? '🎟️ Tickets bestätigt' : `🎟️ Bestellt: ${o.ref}`);
        document.activeElement.blur();
        render();
      } catch (err) { $('orderError').textContent = err.message; }
    };
  }

  document.querySelectorAll('[data-qr]').forEach((b) => {
    b.onclick = () => { const row = document.querySelector(`[data-qr-row="${b.dataset.qr}"]`); row.hidden = !row.hidden; };
  });
  document.querySelectorAll('[data-print]').forEach((b) => {
    b.onclick = () => { const o = Tix.orders.find((x) => x.id === b.dataset.print); if (o) printTickets(o); };
  });
  document.querySelectorAll('[data-save-holders]').forEach((b) => {
    b.onclick = async () => {
      const card = b.closest('.order');
      const holders = Object.fromEntries([...card.querySelectorAll('[data-holder]')].map((i) => [i.dataset.holder, i.value]));
      const clans = Object.fromEntries([...card.querySelectorAll('[data-clan]')].map((i) => [i.dataset.clan, i.value]));
      try { await api('PUT', `/tickets/orders/${b.dataset.saveHolders}/holders`, { holders, clans }); toast('Gespeichert'); render(); } catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('[data-cancel-order]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Bestellung wirklich stornieren? Die Tickets werden wieder freigegeben.')) return;
      try { await api('POST', `/tickets/orders/${b.dataset.cancelOrder}/cancel`); toast('Storniert'); render(); } catch (err) { toast(err.message); }
    };
  });
  if ($('deleteAccount')) {
    $('deleteAccount').onclick = async () => {
      if (!confirm('Konto löschen und verknüpfte Person pseudonymisieren? Bezahlte Tickets bleiben gültig, Zugriff auf Bestellungen und Gastserver entfällt.')) return;
      await api('DELETE', '/account');
      Tix.account = null;
      toast('Konto gelöscht');
      render();
    };
  }
}

// ---------- Admin ----------
const TixAdmin = { filter: 'pending', q: '', editType: null, checkin: '' }; // checkin: letzte Meldung (übersteht Neuzeichnen)

const BOX_FIELDS = ['firstName', 'lastName', 'street', 'zip', 'city', 'email', 'birthdate'];
const BoxOffice = { edit: null, holders: null, bookings: new Map() }; // In-memory drafts, scoped by event.
function snapshotBoxBooking() {
  const form = document.getElementById('boxOfficeForm'), b = form?.booking;
  if (!b || b.committed) return;
  for (const id of [...BOX_FIELDS.map((k) => 'bo_' + k), 'bo_type', 'bo_person', 'bo_holder', 'bo_paid']) {
    b.values[id] = document.getElementById(id).value;
  }
  b.privacy = document.getElementById('bo_privacy').checked;
}
function boxBooking(eventId) {
  if (!BoxOffice.bookings.has(eventId)) BoxOffice.bookings.set(eventId, { values: {}, privacy: false, saving: false, committed: false, error: '' });
  return BoxOffice.bookings.get(eventId);
}
function boxOfficeForm(d) {
  const types = d.types.filter((t) => t.active);
  const editing = d.orders.find((o) => o.id === BoxOffice.edit && o.source === 'box_office');
  const profile = editing ? editing.buyer.profile : {};
  const holders = d.orders.find((o) => o.id === BoxOffice.holders && o.status !== 'cancelled');
  const labels = ['Vorname', 'Nachname', 'Straße und Hausnummer', 'PLZ', 'Ort', 'E-Mail', 'Geburtsdatum'];
  const candidates = [...(d.persons || [])];
  const previousPerson = boxBooking(d.event.id).values.bo_person;
  if (previousPerson && !candidates.some((p) => p.id === previousPerson)) candidates.push({ id: previousPerson, name: 'Ausgewählte Person nicht mehr verfügbar' });
  return `<div class="card"><h2>${editing ? `Kontaktdaten bearbeiten: ${esc(editing.ref)}` : 'Abendkasse – ohne Discord'}</h2><form id="boxOfficeForm">
    <h3>Käufer / Kontakt</h3>
    ${BOX_FIELDS.map((k, i) => `<div class="field"><label for="bo_${k}">${labels[i]}</label><input id="bo_${k}" value="${esc(profile[k] || '')}" required maxlength="${[60, 60, 120, 10, 80, 120, 10][i]}" ${k === 'email' ? 'type="email"' : k === 'birthdate' ? 'type="date"' : k === 'zip' ? 'inputmode="numeric"' : ''}></div>`).join('')}
    ${editing ? '<p class="meta">Nur Kontaktdaten: Ticketnamen, Codes, Zahlung und Check-in bleiben unverändert.</p>' : `
    <div class="field"><label for="bo_type">Ticketart</label><select id="bo_type" required>${types.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} · ${euro(t.price)} · ${t.quota == null ? 'unbegrenzt verfügbar' : `noch ${Math.max(0, t.quota - t.sold)} verfügbar`}</option>`).join('')}</select></div>
    <div class="field"><label for="bo_person">Ticketinhaber – Person auswählen</label><select id="bo_person"><option value="">Neue Person anlegen</option>${candidates.sort((a, b) => a.name.localeCompare(b.name, 'de')).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.discordName ? ` · ${esc(p.discordName)}` : ''}</option>`).join('')}</select></div>
    <p class="meta">Eine bestehende Person wird über ihre Personen-ID verknüpft, ohne einen doppelten Eintrag anzulegen. Käufer-Kontaktdaten bleiben davon getrennt.</p>
    <div class="field"><label for="bo_holder">Neue Person – Anzeigename (optional; sonst voller Käufername)</label><input id="bo_holder" maxlength="60"></div>
    <div class="field"><label for="bo_paid">Zahlung</label><select id="bo_paid"><option value="pending">Offen – noch nicht bezahlt</option><option value="paid">Bar bezahlt</option></select></div>
    <div class="privacy markdown">${markdown(d.settings.privacy)}</div>${websiteLegalLinks(['datenschutz'])}
    <label class="check field"><input type="checkbox" id="bo_privacy" required> Der Datenschutzhinweis wurde der Person bereitgestellt.</label>
    <p id="bo_summary"></p>`}<p class="error" id="bo_error"></p>
    <button class="primary" type="submit" ${editing || types.length ? '' : 'disabled'}>${editing ? 'Kontaktdaten speichern' : 'Ticket anlegen'}</button>
    ${editing ? '<button type="button" id="bo_cancel">Abbrechen</button>' : ''}
  </form>
  ${holders ? `<form id="boHoldersForm"><h3>Ticketnamen: ${esc(holders.ref)}</h3><p class="meta">Kontaktdaten bleiben unverändert.</p>
    ${holders.tickets.map((t) => `<div class="field"><label for="bo_ticket_${esc(t.id)}">${esc(t.typeName || 'Ticket')} – Name / Nickname</label><input id="bo_ticket_${esc(t.id)}" value="${esc(t.holder)}" maxlength="60" required></div>`).join('')}
    <p class="error" id="bo_holders_error"></p><button class="primary" type="submit">Ticketnamen speichern</button><button type="button" id="bo_holders_cancel">Abbrechen</button></form>` : ''}</div>`;
}
// Unlock only failed writes; committed forms stay locked even if refresh fails.
function bindBoxSave(form, error, request, done, status = { saving: false, committed: false, error: '' }) {
  const controls = [...form.querySelectorAll('input, select, button')].map((c) => [c, c.disabled]);
  const sync = () => {
    controls.forEach(([c, disabled]) => { c.disabled = status.saving || status.committed || (c.id === 'bo_holder' && form.booking ? !!form.booking.values.bo_person : disabled); });
    error.textContent = status.error;
  };
  status.sync = sync; sync();
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (status.saving || status.committed || document.getElementById(form.id) !== form) return;
    snapshotBoxBooking();
    status.saving = true; status.error = ''; sync();
    try { const result = await request(); status.committed = true; await done(result); }
    catch (err) { status.error = err.message; }
    finally { status.saving = false; status.sync(); }
  };
}
function bindBoxOffice(d) {
  const $ = (id) => document.getElementById(id);
  const requireCurrentEvent = () => {
    // api() uses the live event scope, which can change before this form is replaced.
    if (scopeEventId() !== d.event.id) throw new Error('Die ausgewählte Veranstaltung wurde geändert. Bitte neu laden.');
  };
  const editing = d.orders.find((o) => o.id === BoxOffice.edit && o.source === 'box_office');
  const booking = editing ? null : boxBooking(d.event.id);
  if (booking) {
    $('boxOfficeForm').booking = booking;
    for (const [id, value] of Object.entries(booking.values)) if ($(id)) $(id).value = value;
    $('bo_privacy').checked = booking.privacy;
    const person = (d.persons || []).find((p) => p.id === $('bo_person').value);
    if ($('bo_person').value) { $('bo_holder').value = person ? person.name : 'Person nicht mehr verfügbar'; $('bo_holder').disabled = true; }
  }
  const summary = () => {
    const t = d.types.find((x) => x.id === $('bo_type').value);
    $('bo_summary').textContent = t ? `1 × ${t.name} · Summe: ${euro(t.price)} · ${$('bo_paid').value === 'paid' ? 'Bar bezahlt' : 'Offen'}` : 'Keine aktive Ticketart verfügbar.';
  };
  if (!editing) {
    $('bo_type').onchange = $('bo_paid').onchange = summary; summary();
    $('bo_person').onchange = () => {
      if (booking.saving || booking.committed) { $('bo_person').value = booking.values.bo_person || ''; return; }
      const p = (d.persons || []).find((p) => p.id === $('bo_person').value);
      booking.values.bo_person = $('bo_person').value;
      $('bo_holder').disabled = !!$('bo_person').value;
      $('bo_holder').value = p ? p.name : '';
    };
  }
  if ($('bo_cancel')) $('bo_cancel').onclick = () => { BoxOffice.edit = null; render(); };
  bindBoxSave($('boxOfficeForm'), $('bo_error'), async () => {
    requireCurrentEvent();
    const buyerProfile = Object.fromEntries(BOX_FIELDS.map((k) => [k, $('bo_' + k).value]));
    if (editing) return api('PUT', `/tickets/orders/${encodeURIComponent(editing.id)}/buyer`, { buyerProfile, version: editing.version });
    if (!$('bo_privacy').checked) throw new Error('Bitte die Bereitstellung des Datenschutzhinweises bestätigen.');
    const personId = $('bo_person').value;
    if (personId && !(d.persons || []).some((p) => p.id === personId)) throw new Error('Die ausgewählte Person ist nicht mehr verfügbar. Bitte neu laden.');
    const item = { typeId: $('bo_type').value, ...(personId ? { personId } : { holder: $('bo_holder').value.trim() || `${buyerProfile.firstName} ${buyerProfile.lastName}`.trim() }) };
    return api('POST', '/tickets/admin/orders', { buyerProfile, items: [item], paid: $('bo_paid').value === 'paid', privacyConfirmed: true });
  }, (o) => {
      BoxOffice.edit = null;
      TixAdmin.filter = o.status; TixAdmin.q = '';
      if (booking && BoxOffice.bookings.get(d.event.id) === booking) BoxOffice.bookings.delete(d.event.id);
      toast(`${editing ? 'Kontaktdaten gespeichert' : 'Ticket angelegt'}: ${o.ref}`); return render();
  }, booking || undefined);
  document.querySelectorAll('[data-bo-edit]').forEach((b) => { b.onclick = () => { BoxOffice.edit = b.dataset.boEdit; BoxOffice.holders = null; render(); }; });
  document.querySelectorAll('[data-oprint]').forEach((b) => { b.onclick = () => { const o = d.orders.find((x) => x.id === b.dataset.oprint && x.status === 'paid'); if (o) printTickets(o); }; });
  document.querySelectorAll('[data-bo-holders]').forEach((b) => { b.onclick = () => { BoxOffice.holders = b.dataset.boHolders; BoxOffice.edit = null; render(); }; });
  const holders = d.orders.find((o) => o.id === BoxOffice.holders && o.status !== 'cancelled');
  if (holders) {
    $('bo_holders_cancel').onclick = () => { BoxOffice.holders = null; render(); };
    bindBoxSave($('boHoldersForm'), $('bo_holders_error'), () => {
      requireCurrentEvent();
      return api('PUT', `/tickets/orders/${encodeURIComponent(holders.id)}/holders`, {
        holders: Object.fromEntries(holders.tickets.map((t) => [t.id, $('bo_ticket_' + t.id).value])),
      });
    }, () => { BoxOffice.holders = null; toast('Ticketnamen gespeichert'); return render(); });
  }
}

adminViews.tickets = {
  label: 'Tickets', module: 'tickets', order: 45, events: ['tickets', 'accounts'], preserveDraft: true,
  async render() {
    snapshotBoxBooking();
    const [d, acc, ppl] = await Promise.all([api('GET', '/tickets/admin'), api('GET', '/accounts'), api('GET', '/people').catch(() => null)]);
    d.seatCategories = ppl ? ppl.seating.categories || [] : [];
    const s = d.settings;
    const et = d.types.find((t) => t.id === TixAdmin.editType) || null;
    const q = TixAdmin.q.toLowerCase();
    const orders = d.orders.filter((o) => (TixAdmin.filter === 'all' || o.status === TixAdmin.filter)
      && (!q || [o.ref, o.buyer.name, o.buyer.profile && `${o.buyer.profile.firstName} ${o.buyer.profile.lastName}`, ...o.tickets.map((t) => t.holder + ' ' + t.code)]
        .join(' ').toLowerCase().includes(q)));
    const count = (st) => d.orders.filter((o) => o.status === st).length;
    const app = document.getElementById('app');

    snapshotBoxBooking();
    app.innerHTML = `${adminTabs('tickets')}
      <div class="stats">
        <div class="stat"><span>${d.stats.paidTickets}</span>bezahlte Tickets</div>
        <div class="stat"><span>${d.stats.tickets - d.stats.paidTickets}</span>offen</div>
        <div class="stat"><span>${euro(d.stats.revenue)}</span>eingegangen</div>
        <div class="stat"><span>${euro(d.stats.open)}</span>ausstehend</div>
        <div class="stat"><span>${d.stats.checkedIn}</span>eingecheckt</div>
      </div>

      ${boxOfficeForm(d)}
      <div class="card"><div class="row" style="justify-content:space-between">
        <h2>Bestellungen <span class="meta">${esc(d.event.name)}</span></h2>
        <div class="row"><a class="btn small" href="/api/tickets/export.csv?event=${encodeURIComponent(d.event.id)}">⬇ CSV-Export</a></div></div>
        <div class="toolbar">
          ${[['pending', `Offen (${count('pending')})`], ['paid', `Bezahlt (${count('paid')})`], ['cancelled', `Storniert (${count('cancelled')})`], ['all', 'Alle']]
            .map(([k, l]) => `<button class="chip ${TixAdmin.filter === k ? 'active' : ''}" data-ofilter="${k}">${l}</button>`).join('')}
          <input id="oSearch" type="search" placeholder="Suchen: Verwendungszweck, Name, Code …" value="${esc(TixAdmin.q)}">
        </div>
        ${orders.length ? `<div style="overflow-x:auto"><table class="orders"><tbody>${orders.map((o) => {
          const p = o.buyer.profile;
          const overdue = o.status === 'pending' && Date.parse(o.dueAt) < Date.now();
          return `<tr class="${o.status}">
            <td><strong>${esc(o.ref)}</strong> ${statusBadge2(o.status)}${overdue ? ' <span class="badge overdue">überfällig</span>' : ''}
              <div class="meta">${dateDe(o.createdAt)}${o.source === 'box_office' ? ' · Abendkasse' : ''}${o.status === 'paid' && o.paymentMethod === 'cash' ? ' · bar bezahlt' : ''}${o.status === 'pending' ? ` · fällig ${dateDe(o.dueAt)}` : ''}${o.paidAt ? ` · bezahlt ${dateDe(o.paidAt)}` : ''}</div></td>
            <td>${esc(o.buyer.name)}${p ? `<details><summary class="meta">${esc(p.firstName)} ${esc(p.lastName)}</summary>
              <div class="meta">${esc(p.street)}, ${esc(p.zip)} ${esc(p.city)}<br>${esc(p.email)} · ${dateDe(p.birthdate)} (${o.buyer.age} J.)</div></details>` : ''}</td>
            <td>${o.tickets.map((t) => `<div>${esc(t.holder)} <span class="meta">· ${esc(t.typeName)} · <code>${esc(t.code)}</code>${t.checkedInAt ? ' ✅' : ''}</span></div>`).join('')}</td>
            <td class="nowrap"><strong>${euro(o.total)}</strong></td>
            <td><div class="row">
              ${o.status === 'pending' ? `<button class="small primary" data-paid="${o.id}">✓ Bezahlt</button>` : ''}
              ${o.source === 'box_office' ? `<button class="small" data-bo-edit="${esc(o.id)}">Daten bearbeiten</button>` : ''}
              ${o.status !== 'cancelled' ? `<button class="small" data-bo-holders="${esc(o.id)}">Ticketnamen</button>` : ''}
              ${o.status === 'paid' ? `<button class="small" data-oprint="${esc(o.id)}">Tickets drucken</button>` : ''}
              ${o.status === 'paid' ? `<button class="small" data-unpaid="${o.id}" title="Zahlung zurücknehmen">↩</button>` : ''}
              ${o.status !== 'cancelled' ? `<button class="small danger" data-ocancel="${o.id}">Storno</button>` : ''}
            </div></td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="meta">Keine Bestellungen in dieser Ansicht.</p>'}
      </div>

      <div class="two">
        <div class="card"><h2>Ticketarten <span class="meta">${esc(d.event.name)}</span></h2>
          ${d.types.length ? `<table class="admin-list"><tbody>${d.types.map((t) => `<tr class="${t.active ? '' : 'past'}">
            <td><strong>${esc(t.name)}</strong> ${t.onSale ? '<span class="badge finished">im Verkauf</span>' : '<span class="badge draft">nicht im Verkauf</span>'}
              <div class="meta">${euro(t.price)} · ${t.sold} verkauft${t.quota != null ? ` von ${t.quota}` : ''}${t.participant === false ? ' · kein Teilnehmerplatz'
                : (t.seatCategories || []).length ? ` · sitzt in: ${t.seatCategories.map((id) => esc((d.seatCategories.find((c) => c.id === id) || {}).name || '?')).join(', ')}` : ''}</div></td>
            <td><div class="row"><button class="small" data-tedit="${t.id}">Bearbeiten</button>${t.sold ? '' : `<button class="small danger" data-tdel="${t.id}">Löschen</button>`}</div></td>
          </tr>`).join('')}</tbody></table>` : '<p class="meta">Noch keine Ticketart angelegt.</p>'}
          <h3 style="margin-top:16px">${et ? `„${esc(et.name)}“ bearbeiten` : 'Neue Ticketart'}</h3>
          <form id="typeForm">
            <div class="row two-inputs">
              <div class="field"><label for="tName">Name</label><input id="tName" required maxlength="80" value="${esc(et ? et.name : '')}" placeholder="z. B. Teilnehmer mit Platz"></div>
              <div class="field"><label for="tPrice">Preis (€)</label><input id="tPrice" required inputmode="decimal" value="${et ? (et.price / 100).toFixed(2).replace('.', ',') : ''}" style="max-width:110px"></div>
            </div>
            <div class="field"><label for="tDesc">Beschreibung (Markdown)</label><textarea id="tDesc" class="short" maxlength="300" placeholder="z. B. inkl. Frühstück, Sitzplatz mit Strom und LAN">${esc(et ? et.description : '')}</textarea>${markdownHelp('tDesc')}</div>
            <div class="row two-inputs">
              <div class="field"><label for="tQuota">Kontingent <span class="meta">(leer = unbegrenzt)</span></label><input id="tQuota" type="number" min="0" value="${et && et.quota != null ? et.quota : ''}"></div>
              <div class="field"><label for="tMax">Max. pro Bestellung</label><input id="tMax" type="number" min="1" max="50" value="${et ? et.maxPerOrder : 10}"></div>
            </div>
            <div class="row two-inputs">
              <div class="field"><label for="tStart">Verkauf ab <span class="meta">(optional)</span></label><input id="tStart" type="datetime-local" value="${toLocalInput(et && et.saleStart)}"></div>
              <div class="field"><label for="tEnd">Verkauf bis <span class="meta">(optional)</span></label><input id="tEnd" type="datetime-local" value="${toLocalInput(et && et.saleEnd)}"></div>
            </div>
            ${(d.seatCategories || []).length ? `<div class="field"><label>Darf sitzen in <span class="meta">(nichts angehakt = überall)</span></label>
              <div class="row">${d.seatCategories.map((c) => `<label class="check"><input type="checkbox" data-tcat="${c.id}" ${et && (et.seatCategories || []).includes(c.id) ? 'checked' : ''}>
                <i class="dot" style="background:${c.color}"></i>${esc(c.name)}</label>`).join('')}</div></div>` : ''}
            <label class="check"><input type="checkbox" id="tActive" ${!et || et.active ? 'checked' : ''}> aktiv (sichtbar)</label>
            <label class="check field"><input type="checkbox" id="tPart" ${!et || et.participant !== false ? 'checked' : ''}> zählt als LAN-Teilnehmer (landet in Teilnehmerliste/Sitzplan)</label>
            <p class="error" id="tError"></p>
            <div class="row"><button class="primary" type="submit">${et ? 'Speichern' : 'Anlegen'}</button>${et ? '<button type="button" id="tCancel">Abbrechen</button>' : ''}</div>
          </form>
        </div>

        <div>
          <div class="card"><h2>🎫 Check-in</h2>
            <form id="checkinForm" class="row"><input id="ciCode" placeholder="Ticket-Code (32 Zeichen)" maxlength="32" style="max-width:340px;text-transform:uppercase">
              <button class="primary" type="submit">Einchecken</button></form>
            <p id="ciResult" class="meta">${TixAdmin.checkin}</p>
          </div>
          <div class="card"><h2>Verkauf & Zahlung</h2>
            <form id="tsForm">
              <h3>Nur für ${esc(d.event.name)}</h3>
              <label class="check"><input type="checkbox" id="sOpen" ${s.saleOpen ? 'checked' : ''}> Ticketverkauf geöffnet</label>
              <label class="check field"><input type="checkbox" id="sSeats" ${s.seatSelection ? 'checked' : ''}> Platzwahl offen: Käufer reservieren ihre Sitzplätze selbst (nach Zahlung)</label>
              <div class="row two-inputs">
                <div class="field"><label for="sDays">Zahlungsfrist (Tage)</label><input id="sDays" type="number" min="1" max="90" value="${s.payDays}"></div>
                <div class="field"><label for="sAge">Mindestalter Käufer <span class="meta">(0 = keins)</span></label><input id="sAge" type="number" min="0" max="99" value="${s.minAge}"></div>
              </div>
              <h3>Für alle Events</h3>
              <label class="check field"><input type="checkbox" id="sMember" ${s.requireMember ? 'checked' : ''}> Nur Mitglieder unseres Discord-Servers dürfen bestellen</label>
              <div class="row two-inputs">
                <div class="field"><label for="bHolder">Kontoinhaber</label><input id="bHolder" value="${esc(s.bank.holder)}"></div>
                <div class="field"><label for="bIban">IBAN</label><input id="bIban" value="${esc(s.bank.iban)}"></div>
              </div>
              <div class="row two-inputs">
                <div class="field"><label for="bBic">BIC</label><input id="bBic" value="${esc(s.bank.bic)}"></div>
                <div class="field"><label for="bBank">Bank</label><input id="bBank" value="${esc(s.bank.bank)}"></div>
              </div>
              <div class="field"><label for="sPrivacy">Datenschutzhinweis (Markdown, wird bei der Registrierung angezeigt)</label><textarea id="sPrivacy" class="short">${esc(s.privacy)}</textarea>${markdownHelp('sPrivacy')}</div>
              <p class="error" id="sError"></p>
              <button class="primary" type="submit">Speichern</button>
            </form>
          </div>
          <div class="card"><h2>Discord-Login</h2>
            ${acc.loginEnabled ? '<p>✅ eingerichtet</p>' : `<p class="error">⚠️ Noch nicht eingerichtet${acc.hasSecret ? '' : ' – DISCORD_CLIENT_SECRET fehlt'}.</p>`}
            <p class="meta">Im Discord Developer Portal unter OAuth2 → Redirects genau diese Adresse eintragen:</p>
            <p><code>${esc(acc.redirectUri)}</code> ${copyBtn(acc.redirectUri)}</p>
            <p class="meta">${acc.accounts.length} registrierte Konten, davon ${acc.accounts.filter((x) => x.complete).length} mit vollständigen Daten.</p>
          </div>
        </div>
      </div>`;
    bindTicketAdmin(et);
    bindBoxOffice(d);
  },
};

function bindTicketAdmin(et) {
  const $ = (id) => document.getElementById(id);
  const v = (id) => $(id).value;
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); render(); } catch (err) { toast(err.message); } };

  document.querySelectorAll('[data-ofilter]').forEach((b) => { b.onclick = () => { TixAdmin.filter = b.dataset.ofilter; render(); }; });
  $('oSearch').onchange = () => { TixAdmin.q = $('oSearch').value; render(); };
  document.querySelectorAll('[data-paid]').forEach((b) => { b.onclick = () => act(() => api('POST', `/tickets/orders/${b.dataset.paid}/paid`, { paid: true }), 'Als bezahlt markiert'); });
  document.querySelectorAll('[data-unpaid]').forEach((b) => {
    b.onclick = () => confirm('Zahlung wirklich zurücknehmen?') && act(() => api('POST', `/tickets/orders/${b.dataset.unpaid}/paid`, { paid: false }), 'Zurückgenommen');
  });
  document.querySelectorAll('[data-ocancel]').forEach((b) => {
    b.onclick = () => confirm('Bestellung stornieren? Die Tickets werden wieder freigegeben.') && act(() => api('POST', `/tickets/orders/${b.dataset.ocancel}/cancel`), 'Storniert');
  });
  document.querySelectorAll('[data-tedit]').forEach((b) => { b.onclick = () => { TixAdmin.editType = b.dataset.tedit; render(); }; });
  document.querySelectorAll('[data-tdel]').forEach((b) => {
    b.onclick = () => confirm('Ticketart löschen?') && act(() => api('DELETE', '/tickets/types/' + b.dataset.tdel), 'Gelöscht');
  });
  if ($('tCancel')) $('tCancel').onclick = () => { TixAdmin.editType = null; render(); };

  $('typeForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      name: v('tName'), price: v('tPrice'), description: v('tDesc'), quota: v('tQuota') === '' ? null : Number(v('tQuota')),
      maxPerOrder: Number(v('tMax')), active: $('tActive').checked, participant: $('tPart').checked,
      seatCategories: [...document.querySelectorAll('[data-tcat]:checked')].map((c) => c.dataset.tcat),
      saleStart: v('tStart') ? new Date(v('tStart')).toISOString() : null, saleEnd: v('tEnd') ? new Date(v('tEnd')).toISOString() : null,
    };
    try {
      if (et) await api('PUT', '/tickets/types/' + et.id, body); else await api('POST', '/tickets/types', body);
      TixAdmin.editType = null;
      toast('Ticketart gespeichert');
      document.activeElement.blur();
      render();
    } catch (err) { $('tError').textContent = err.message; }
  };

  $('tsForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/tickets/settings', {
        saleOpen: $('sOpen').checked, requireMember: $('sMember').checked, seatSelection: $('sSeats').checked, payDays: Number(v('sDays')), minAge: Number(v('sAge')), privacy: v('sPrivacy'),
        bank: { holder: v('bHolder'), iban: v('bIban'), bic: v('bBic'), bank: v('bBank') },
      });
      toast('Gespeichert');
      document.activeElement.blur();
      render();
    } catch (err) { $('sError').textContent = err.message; }
  };

  $('checkinForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = v('ciCode').trim().toUpperCase();
    try {
      const r = await api('POST', '/tickets/checkin/' + encodeURIComponent(code), {});
      TixAdmin.checkin = `✅ <strong>${esc(r.holder)}</strong> (${esc(r.typeName)}, ${esc(r.ref)}, ${esc(r.eventName)}) eingecheckt.`;
      $('ciCode').value = '';
    } catch (err) { TixAdmin.checkin = `<span class="error">⚠️ ${esc(code)}: ${esc(err.message)}</span>`; }
    $('ciResult').innerHTML = TixAdmin.checkin;
  };
}

// ---------- Check-in nach dem Scannen (#/checkin/<code>) ----------
views.checkin = {
  label: null, module: 'tickets', events: ['tickets'],
  async render(code) {
    const app = document.getElementById('app');
    if (!state.admin) {
      renderLogin();
      app.insertAdjacentHTML('afterbegin', '<div class="card hint-card" style="max-width:380px;margin:20px auto 0">🎫 Ticket-Check-in: bitte als Orga anmelden.</div>');
      return;
    }
    let t;
    try { t = await api('GET', '/tickets/code/' + encodeURIComponent(code || '')); } catch (err) {
      app.innerHTML = `<div class="checkin-card bad"><div class="ci-icon">⛔</div><h1>${esc(err.message)}</h1><p class="meta">Code: ${esc(code || '–')}</p>
        <a class="btn" href="#/admin/tickets">Zur Ticketverwaltung</a></div>`;
      return;
    }
    const time = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const valid = t.status === 'paid';
    const cls = !valid ? 'bad' : t.checkedInAt ? 'warn' : 'good';
    app.innerHTML = `<div class="checkin-card ${cls}">
      <div class="ci-icon">${!valid ? '⛔' : t.checkedInAt ? '⚠️' : '🎫'}</div>
      <h1>${esc(t.holder)}</h1>
      <p class="ci-type">${esc(t.typeName)}</p>
      <p class="meta">${esc(t.eventName)} · Code <code>${esc(t.code)}</code> · Bestellung ${esc(t.ref)}${t.buyer ? ` · gekauft von ${esc(t.buyer)}` : ''}</p>
      ${t.otherEvent ? `<p class="ci-status">⚠️ Dieses Ticket gilt für „${esc(t.eventName)}“, nicht für das aktuelle Event</p>` : ''}
      ${!valid ? `<p class="ci-status">${t.status === 'cancelled' ? 'Ticket ist storniert' : 'Ticket ist noch nicht bezahlt'}</p>`
        : t.checkedInAt ? `<p class="ci-status">Bereits eingecheckt um ${time(t.checkedInAt)}</p><button id="ciUndo">Check-in zurücknehmen</button>`
        : '<button class="primary huge" id="ciGo">✅ Einchecken</button>'}
      ${t.others.length ? `<div class="ci-others"><p class="meta">Weitere Tickets dieser Bestellung:</p>${t.others.map((x) =>
        `<a href="#/checkin/${esc(x.code)}" class="btn small">${esc(x.holder)}${x.checkedInAt ? ' ✅' : ''}</a>`).join(' ')}</div>` : ''}
      <p class="hint">Nächstes Ticket: einfach den QR-Code mit der Kamera scannen.</p>
    </div>`;
    const go = document.getElementById('ciGo');
    if (go) go.onclick = async () => {
      try { await api('POST', '/tickets/checkin/' + encodeURIComponent(t.code), {}); toast(`✅ ${t.holder} eingecheckt`); render(); } catch (err) { toast(err.message); }
    };
    const undo = document.getElementById('ciUndo');
    if (undo) undo.onclick = async () => {
      if (!confirm('Check-in zurücknehmen?')) return;
      await api('POST', '/tickets/checkin/' + encodeURIComponent(t.code), { undo: true });
      render();
    };
  },
};
