'use strict';
/* global api, esc, toast, views, adminViews, adminTabs, state, render, toLocalInput, markdown, markdownHelp */
const Catering = {
  money: (cents) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }),
  when: (iso) => iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '',
  payment: (entry) => entry.paidAt ? '<span class="badge finished">Bezahlt</span>' : '<span class="badge draft">Offen</span>',
  filter: '',
};

function cateringOffer(offer, data) {
  const booked = new Set(data.entries.filter((e) => e.offerId === offer.id).map((e) => e.guestKey));
  const guests = data.guests.filter((g) => !booked.has(g.key));
  return `<article class="card">
    <h2>${esc(offer.title)}</h2>
    ${offer.description ? `<div class="website-text markdown">${markdown(offer.description)}</div>` : ''}
    <p><strong>${Catering.money(offer.price)}</strong> pro Person</p>
    ${offer.servingAt ? `<p class="meta">Ausgabe: ${esc(Catering.when(offer.servingAt))}</p>` : ''}
    ${offer.deadline ? `<p class="meta">Anmeldung bis: ${esc(Catering.when(offer.deadline))}</p>` : ''}
    <p class="meta">${offer.registered} angemeldet${offer.capacity ? ` · ${Math.max(0, offer.capacity - offer.registered)} Plätze frei` : ''}</p>
    ${!data.loggedIn ? '<p class="hint">Bitte mit Discord anmelden, um dich einzutragen.</p>'
      : !offer.available ? `<p class="hint">${offer.capacity && offer.registered >= offer.capacity ? 'Ausgebucht' : 'Anmeldung geschlossen'}</p>`
        : !guests.length ? '<p class="hint">Deine Gäste sind bereits eingetragen.</p>'
          : `<form data-catering-signup="${esc(offer.id)}">
            <div class="field"><label>Gast<select name="guestKey" required>${guests.map((g) => `<option value="${esc(g.key)}">${esc(g.name)}</option>`).join('')}</select></label></div>
            <button class="primary" type="submit">Für ${Catering.money(offer.price)} anmelden</button>
          </form>`}
  </article>`;
}

function cateringEntries(data, admin = false) {
  if (!data.entries.length) return '<p class="meta">Noch keine Anmeldungen.</p>';
  return `<div style="overflow-x:auto"><table class="admin-list"><thead><tr><th>Gast</th><th>Angebot</th><th>Betrag</th><th>Zahlung</th><th>Aktionen</th></tr></thead>
    <tbody>${data.entries.map((entry) => {
      const offer = data.offers.find((o) => o.id === entry.offerId);
      const canCancel = !entry.paidAt && (admin || (!data.over && offer && offer.open && (!offer.deadline || Date.parse(offer.deadline) > Date.now())));
      return `<tr><td>${esc(entry.name)}</td><td>${esc(offer?.title || 'Entferntes Angebot')}</td>
        <td class="nowrap">${Catering.money(entry.price)}</td><td>${Catering.payment(entry)}${entry.paidAt ? `<div class="meta">${esc(Catering.when(entry.paidAt))}</div>` : ''}</td>
        <td><div class="row">${admin ? `<button data-catering-payment="${esc(entry.id)}">${entry.paidAt ? 'Wieder offen setzen' : 'Als bezahlt markieren'}</button>` : ''}
          ${canCancel ? `<button class="danger" data-catering-cancel="${esc(entry.id)}">Abmelden</button>` : ''}</div></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function bindCateringEntries(app, data) {
  app.querySelectorAll('[data-catering-cancel]').forEach((button) => {
    button.onclick = async () => {
      const entry = data.entries.find((e) => e.id === button.dataset.cateringCancel);
      if (!confirm(`${entry.name} von diesem Catering-Angebot abmelden?`)) return;
      button.disabled = true;
      try { await api('DELETE', '/catering/entries/' + entry.id, { version: entry.version }); toast('Abgemeldet'); await render(); }
      catch (err) { toast(err.message); button.disabled = false; }
    };
  });
  app.querySelectorAll('[data-catering-payment]').forEach((button) => {
    button.onclick = async () => {
      const entry = data.entries.find((e) => e.id === button.dataset.cateringPayment);
      if (entry.paidAt && !confirm('Zahlung wirklich zurücksetzen? Eine eventuell nötige Erstattung muss außerhalb der Anwendung erfolgen.')) return;
      button.disabled = true;
      try {
        await api('PUT', '/catering/entries/' + entry.id, { paid: !entry.paidAt, version: entry.version });
        toast(entry.paidAt ? 'Zahlung zurückgesetzt' : 'Als bezahlt markiert'); await render();
      } catch (err) { toast(err.message); button.disabled = false; }
    };
  });
}

views.catering = {
  label: 'Catering', module: 'catering', events: ['catering', 'people', 'accounts', 'tickets'],
  async render() {
    const data = await api('GET', '/catering');
    const app = document.getElementById('app');
    app.innerHTML = `<div class="page-head"><h1>🍽️ Catering</h1></div>
      <p class="hint">Ein Eintrag gilt für eine Person und ein Angebot. Du kannst dich und die Inhaber deiner bezahlten Tickets anmelden. Zahlung direkt bei der Orga, nicht online.</p>
      ${!data.loggedIn && state.userLogin ? '<p><a class="btn primary discord-btn" href="/api/auth/login">Mit Discord anmelden</a></p>' : ''}
      ${data.over ? '<p class="hint">Dieses Event ist beendet. Neue Selbstanmeldungen sind geschlossen.</p>' : ''}
      <div class="grid">${data.offers.length ? data.offers.map((o) => cateringOffer(o, data)).join('') : '<div class="empty">Noch keine Catering-Angebote vorhanden.</div>'}</div>
      ${data.loggedIn ? `<section class="card"><h2>Meine Anmeldungen</h2>${cateringEntries(data)}
        <p class="hint">Bereits bezahlte Anmeldungen oder Änderungen nach Anmeldeschluss bitte mit der Orga klären. Bei Preisänderungen bleibt der Betrag deiner bestehenden Anmeldung erhalten.</p></section>` : ''}`;
    app.querySelectorAll('[data-catering-signup]').forEach((form) => {
      form.onsubmit = async (ev) => {
        ev.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
        try {
          await api('POST', '/catering/entries', { offerId: form.dataset.cateringSignup, guestKey: form.elements.guestKey.value });
          toast('Für Catering angemeldet'); await render();
        } catch (err) { toast(err.message); button.disabled = false; }
      };
    });
    bindCateringEntries(app, data);
  },
};

adminViews.catering = {
  label: 'Catering', module: 'catering', order: 65, events: ['catering', 'people', 'accounts', 'tickets'],
  async render(editId) {
    const data = await api('GET', '/catering/admin');
    const edit = data.offers.find((o) => o.id === editId);
    const offer = edit || { title: '', description: '', price: 0, capacity: 0, servingAt: null, deadline: null, open: true };
    const paid = data.entries.filter((e) => e.paidAt), unpaid = data.entries.filter((e) => !e.paidAt);
    const sum = (entries) => Catering.money(entries.reduce((n, e) => n + e.price, 0));
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('catering')}
      <div class="two"><section class="card"><h2>${edit ? 'Angebot bearbeiten' : 'Neues Catering-Angebot'}</h2>
        <form id="cateringOfferForm">
          <div class="field"><label for="cTitle">Titel</label><input id="cTitle" name="title" maxlength="120" required value="${esc(offer.title)}" placeholder="z. B. Samstag: Grillbuffet"></div>
          <div class="field"><label for="cDescription">Beschreibung (Markdown)</label><textarea id="cDescription" name="description" maxlength="1000">${esc(offer.description)}</textarea>${markdownHelp('cDescription')}</div>
          <div class="row two-inputs">
            <div class="field"><label for="cPrice">Preis pro Person (€)</label><input id="cPrice" name="price" type="number" min="0" max="10000" step="0.01" required value="${(offer.price / 100).toFixed(2)}"></div>
            <div class="field"><label for="cCapacity">Höchstzahl (0 = unbegrenzt)</label><input id="cCapacity" name="capacity" type="number" min="0" max="10000" step="1" required value="${offer.capacity}"></div>
          </div>
          <div class="field"><label for="cServing">Ausgabezeit (optional)</label><input id="cServing" name="servingAt" type="datetime-local" value="${esc(toLocalInput(offer.servingAt))}"></div>
          <div class="field"><label for="cDeadline">Anmeldeschluss (optional)</label><input id="cDeadline" name="deadline" type="datetime-local" value="${esc(toLocalInput(offer.deadline))}"></div>
          <label class="check field"><input name="open" type="checkbox" ${offer.open ? 'checked' : ''}> Selbstanmeldung geöffnet</label>
          <p class="hint">Preisänderungen gelten nur für neue Anmeldungen. Bestehende Beträge und Zahlungen bleiben erhalten.</p>
          <p class="error" id="cOfferError" role="alert"></p><button class="primary" type="submit">${edit ? 'Speichern' : 'Angebot anlegen'}</button>
          ${edit ? '<a class="btn" href="#/admin/catering">Abbrechen</a>' : ''}
        </form></section>
        <section class="card"><h2>Angebote</h2>${data.offers.length ? `<table class="admin-list"><tbody>${data.offers.map((o) => `<tr><td><strong>${esc(o.title)}</strong>
          <div class="meta">${Catering.money(o.price)} · ${o.registered}${o.capacity ? '/' + o.capacity : ''} angemeldet · ${o.open ? 'geöffnet' : 'geschlossen'}${o.deadline ? ` · Frist: ${esc(Catering.when(o.deadline))}` : ''}</div></td>
          <td><div class="row"><a class="btn" href="#/admin/catering/${esc(o.id)}">Bearbeiten</a>${!o.registered ? `<button class="danger" data-catering-delete="${esc(o.id)}">Löschen</button>` : ''}</div></td></tr>`).join('')}</tbody></table>` : '<p class="meta">Noch keine Angebote.</p>'}
          <p class="hint">Angebote mit Anmeldungen bleiben erhalten. Schließe die Selbstanmeldung, statt das Angebot zu löschen.</p>
        </section></div>
      <section class="card"><h2>Gast zuweisen</h2>
        <p class="hint">Auswahl aus Event-Teilnehmern und registrierten Konten. Neue Gäste zuerst unter „Teilnehmer“ anlegen. Admin-Zuweisung ist auch nach Anmeldeschluss möglich; die Höchstzahl bleibt verbindlich.</p>
        ${data.guests.length && data.offers.length ? `<form id="cateringAssignForm"><div class="row two-inputs">
          <div class="field"><label for="cGuest">Gast</label><select id="cGuest" name="guestKey">${data.guests.map((g) => `<option value="${esc(g.key)}">${esc(g.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="cOffer">Angebot</label><select id="cOffer" name="offerId">${data.offers.map((o) => `<option value="${esc(o.id)}">${esc(o.title)} (${Catering.money(o.price)})</option>`).join('')}</select></div></div>
          <p class="error" id="cAssignError" role="alert"></p><button class="primary" type="submit">Gast zuweisen</button></form>` : '<p class="meta">Bitte zuerst ein Angebot und Gäste anlegen.</p>'}
      </section>
      <section class="card"><h2>Anmeldungen (${data.entries.length})</h2>
        <p><strong>Bezahlt:</strong> ${paid.length} · ${sum(paid)} &nbsp; <strong>Offen:</strong> ${unpaid.length} · ${sum(unpaid)}</p>
        <div class="field"><label for="cFilter">Angebot filtern</label><select id="cFilter"><option value="">Alle Angebote</option>${data.offers.map((o) => `<option value="${esc(o.id)}" ${Catering.filter === o.id ? 'selected' : ''}>${esc(o.title)}</option>`).join('')}</select></div>
        <div id="cEntries"></div><p class="hint">„Bezahlt“ ist eine manuelle Bestätigung, keine Zahlungsabwicklung. Für eine Abmeldung bezahlter Einträge zuerst eine Erstattung klären und den Status bewusst zurücksetzen.</p>
      </section>`;
    const draw = () => {
      document.getElementById('cEntries').innerHTML = cateringEntries({ ...data, entries: data.entries.filter((e) => !Catering.filter || e.offerId === Catering.filter) }, true);
      bindCateringEntries(app, data);
    };
    if (!data.offers.some((o) => o.id === Catering.filter)) Catering.filter = '';
    document.getElementById('cFilter').onchange = (ev) => { Catering.filter = ev.target.value; draw(); }; draw();
    document.getElementById('cateringOfferForm').onsubmit = async (ev) => {
      ev.preventDefault(); const form = ev.target, fields = form.elements, button = form.querySelector('button'); button.disabled = true;
      try {
        const body = { title: fields.title.value, description: fields.description.value, price: Math.round(Number(fields.price.value) * 100),
          capacity: Number(fields.capacity.value), servingAt: fields.servingAt.value ? new Date(fields.servingAt.value).toISOString() : null,
          deadline: fields.deadline.value ? new Date(fields.deadline.value).toISOString() : null, open: fields.open.checked, ...(edit ? { version: edit.version } : {}) };
        await api(edit ? 'PUT' : 'POST', '/catering/offers' + (edit ? '/' + edit.id : ''), body);
        toast('Angebot gespeichert'); if (edit) location.hash = '#/admin/catering'; else await render();
      } catch (err) { document.getElementById('cOfferError').textContent = err.message; button.disabled = false; }
    };
    const assign = document.getElementById('cateringAssignForm');
    if (assign) assign.onsubmit = async (ev) => {
      ev.preventDefault(); const button = assign.querySelector('button'); button.disabled = true;
      try {
        await api('POST', '/catering/entries', { guestKey: assign.elements.guestKey.value, offerId: assign.elements.offerId.value });
        toast('Gast zugewiesen'); await render();
      } catch (err) { document.getElementById('cAssignError').textContent = err.message; button.disabled = false; }
    };
    app.querySelectorAll('[data-catering-delete]').forEach((button) => {
      button.onclick = async () => {
        const entry = data.offers.find((o) => o.id === button.dataset.cateringDelete);
        if (!confirm(`Angebot „${entry.title}“ löschen?`)) return;
        button.disabled = true;
        try { await api('DELETE', '/catering/offers/' + entry.id, { version: entry.version }); await render(); }
        catch (err) { toast(err.message); button.disabled = false; }
      };
    });
  },
};
