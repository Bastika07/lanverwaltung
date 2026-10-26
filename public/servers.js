'use strict';
/* global api, esc, toast, state, views, adminViews, adminTabs, render, copyBtn */
// Gastserver: Teilnehmer melden eigene Server an und bekommen sofort IP und FQDN.
// Die Orga sieht alle, sperrt oder löscht sie und exportiert die DNS-Einträge.

const GS = { last: null }; // zuletzt angemeldeter Server – Ergebnis oben anzeigen

function serverResult(s) {
  return `<div class="card hint-card"><h2>✅ ${esc(s.name)} ist angemeldet</h2>
    <dl class="kv"><dt>FQDN</dt><dd><code>${esc(s.fqdn)}</code> ${copyBtn(s.fqdn)}</dd>
      <dt>IP-Adresse</dt><dd><code>${esc(s.ip)}</code> ${copyBtn(s.ip)}</dd>
      <dt>Reverse-DNS</dt><dd>${s.reverse ? 'vorgemerkt – die Orga trägt ihn ein' : 'nicht gewünscht'}</dd></dl>
    <p class="hint">Stell die IP fest an deinem Server ein. Die DNS-Einträge legt die Orga an. Die Daten bekommst du auch per Discord-Nachricht.</p></div>`;
}

views.server = {
  label: 'Gastserver', module: 'servers', events: ['servers'],
  async render() {
    const d = await api('GET', '/servers');
    const mine = d.mine;
    let form;
    if (!d.loggedIn) {
      form = `<div class="card"><h2>Server anmelden</h2><p>Gastserver können Teilnehmer mit Ticket anmelden.</p>
        ${state.userLogin ? '<a class="btn primary big discord-btn" href="/api/auth/login">Mit Discord anmelden</a>' : ''}</div>`;
    } else if (!d.member) {
      form = `<div class="card"><h2>Server anmelden</h2><p class="meta">Dein Discord-Konto gehört noch zu keinem Ticket für ${esc(d.event.name)}.
        Verknüpfe dich im Discord mit <code>/ich</code> oder frag die Orga.</p></div>`;
    } else if (!d.open || !d.domain) {
      form = '<div class="card"><h2>Server anmelden</h2><p class="meta">Die Anmeldung für Gastserver ist gerade geschlossen.</p></div>';
    } else if (mine.length >= d.maxPerAccount) {
      form = `<div class="card"><h2>Server anmelden</h2><p class="meta">Du hast schon ${mine.length} Gastserver – mehr gehen nicht. Lösche einen, um einen neuen anzumelden.</p></div>`;
    } else {
      form = `<form id="gsForm" class="card"><h2>Server anmelden</h2>
        <div class="field"><label for="gsName">Servername</label>
          <div class="row"><input id="gsName" required maxlength="63" pattern="[a-z0-9]([a-z0-9\\-]*[a-z0-9])?" placeholder="z. B. cs2-turnier" style="max-width:240px;text-transform:lowercase">
          <span class="meta">.${esc(d.domain)}</span></div>
          <p class="hint">Kleinbuchstaben, Ziffern und Bindestrich.</p></div>
        <div class="field"><label for="gsDesc">Beschreibung</label><input id="gsDesc" required maxlength="300" placeholder="z. B. Counter-Strike 2 Dedicated, 5v5, Passwort im Discord"></div>
        <label class="check field"><input type="checkbox" id="gsRev"> Reverse-Eintrag im DNS (PTR) gewünscht</label>
        <p class="error" id="gsError"></p>
        <button class="primary" type="submit" ${d.free ? '' : 'disabled'}>Anmelden und IP bekommen</button>
        ${d.free ? '' : '<p class="hint">Es sind keine IP-Adressen mehr frei – bitte bei der Orga melden.</p>'}
      </form>`;
    }
    const app = document.getElementById('app');
    app.innerHTML = `<div class="page-head"><h1>Gastserver <span class="meta">${esc(d.event.name)}</span></h1></div>
      ${GS.last ? serverResult(GS.last) : ''}
      <div class="two"><div>${form}
        ${mine.length ? `<div class="card"><h2>Deine Server</h2><table class="admin-list"><tbody>${mine.map((s) => `<tr>
          <td><strong>${esc(s.fqdn)}</strong> ${copyBtn(s.fqdn)}<div class="meta">${esc(s.description)}${s.reverse ? ' · Reverse-DNS' : ''}${s.blocked ? ' · <strong>gesperrt</strong>' : ''}</div></td>
          <td class="nowrap"><code>${esc(s.ip)}</code> ${copyBtn(s.ip)}</td>
          <td><button class="small danger" data-gsdel="${s.id}" title="Abmelden">🗑</button></td></tr>`).join('')}</tbody></table></div>` : ''}</div>
        <div class="card"><h2>Alle Gastserver (${d.servers.length})</h2>
          ${d.servers.length ? `<table class="admin-list"><tbody>${d.servers.map((s) => `<tr>
            <td><strong>${esc(s.fqdn)}</strong><div class="meta">${esc(s.description)}${s.owner ? ` · ${esc(s.owner)}` : ''}</div></td>
            <td class="nowrap"><code>${esc(s.ip)}</code> ${copyBtn(s.ip)}</td></tr>`).join('')}</tbody></table>` : '<p class="meta">Noch keine angemeldet.</p>'}
        </div></div>`;

    const f = document.getElementById('gsForm');
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        GS.last = await api('POST', '/servers', { name: document.getElementById('gsName').value.trim().toLowerCase(), description: document.getElementById('gsDesc').value, reverse: document.getElementById('gsRev').checked });
        toast(`🖥️ ${GS.last.fqdn} → ${GS.last.ip}`);
        document.activeElement.blur();
        render();
      } catch (err) { document.getElementById('gsError').textContent = err.message; }
    };
    app.querySelectorAll('[data-gsdel]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Server abmelden? Die IP wird wieder frei.')) return;
        try { await api('DELETE', '/servers/' + b.dataset.gsdel); GS.last = null; toast('Abgemeldet'); render(); } catch (err) { toast(err.message); }
      };
    });
  },
};

// ---------- Admin ----------
adminViews.server = {
  label: 'Gastserver', module: 'servers', order: 46, events: ['servers'],
  async render() {
    const d = await api('GET', '/servers/admin');
    const c = d.config;
    const q = `?event=${encodeURIComponent(d.event.id)}`;
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('server')}
      <div class="two">
        <form id="gscForm" class="card"><h2>Einstellungen <span class="meta">${esc(d.event.name)}</span></h2>
          <div class="field"><label for="gcDomain">Domain</label><input id="gcDomain" value="${esc(c.domain)}" placeholder="z. B. gast.lan" ${d.servers.length ? 'disabled title="Gibt es schon Server, bleibt die Domain fest"' : ''}></div>
          <div class="row two-inputs">
            <div class="field"><label for="gcFrom">IP-Bereich von</label><input id="gcFrom" value="${esc(c.ipFrom)}" placeholder="10.10.50.10"></div>
            <div class="field"><label for="gcTo">bis</label><input id="gcTo" value="${esc(c.ipTo)}" placeholder="10.10.50.250"></div>
          </div>
          <div class="field"><label for="gcMax">Höchstens pro Person</label><input id="gcMax" type="number" min="1" max="20" value="${c.maxPerAccount}" style="max-width:120px"></div>
          <label class="check field"><input type="checkbox" id="gcOpen" ${c.open ? 'checked' : ''}> Anmeldung offen</label>
          <p class="error" id="gcError"></p>
          <button class="primary" type="submit">Speichern</button>
          <p class="hint">Nächste freie IP: <strong>${d.free ? esc(d.free) : '– keine –'}</strong>. Anmelden dürfen Teilnehmer mit Ticket; sie bekommen IP und FQDN sofort.</p>
        </form>
        <div class="card"><h2>DNS-Einträge</h2>
          <p class="meta">Die Einträge legst du selbst im DNS-Server an: A-Records für alle aktiven Server, PTR nur dort, wo ein Reverse-Eintrag gewünscht ist.</p>
          <div class="row"><a class="btn" href="/api/servers/export.txt${q}" target="_blank" rel="noopener">📄 Zonendatei-Zeilen</a>
            <a class="btn" href="/api/servers/export.csv${q}">⬇ CSV</a></div>
        </div>
      </div>
      <div class="card"><h2>Gastserver (${d.servers.length})</h2>
        ${d.servers.length ? `<div style="overflow-x:auto"><table class="admin-list"><tbody>${d.servers.map((s) => `<tr class="${s.blocked ? 'past' : ''}">
          <td><strong>${esc(s.fqdn)}</strong>${s.blocked ? ' <span class="badge">gesperrt</span>' : ''}<div class="meta">${esc(s.description)}</div></td>
          <td class="nowrap"><code>${esc(s.ip)}</code></td>
          <td class="nowrap">${s.reverse ? '↩ PTR' : '<span class="meta">kein PTR</span>'}</td>
          <td>${esc(s.owner)}<div class="meta">${new Date(s.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</div></td>
          <td><div class="row"><button class="small" data-gsblock="${s.id}" data-blocked="${s.blocked ? 1 : 0}">${s.blocked ? 'Entsperren' : 'Sperren'}</button>
            <button class="small danger" data-gsdel="${s.id}" title="Löschen">🗑</button></div></td></tr>`).join('')}</tbody></table></div>` : '<p class="meta">Noch keine angemeldet.</p>'}
      </div>`;

    const v = (id) => document.getElementById(id).value;
    document.getElementById('gscForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('PUT', '/servers/config', { domain: v('gcDomain'), ipFrom: v('gcFrom').trim(), ipTo: v('gcTo').trim(), maxPerAccount: Number(v('gcMax')), open: document.getElementById('gcOpen').checked });
        toast('Gespeichert');
        document.activeElement.blur();
        render();
      } catch (err) { document.getElementById('gcError').textContent = err.message; }
    };
    app.querySelectorAll('[data-gsblock]').forEach((b) => {
      b.onclick = async () => { await api('POST', `/servers/${b.dataset.gsblock}/block`, { blocked: b.dataset.blocked !== '1' }); render(); };
    });
    app.querySelectorAll('[data-gsdel]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Gastserver löschen? Die IP wird wieder frei.')) return;
        await api('DELETE', '/servers/' + b.dataset.gsdel);
        render();
      };
    });
  },
};
