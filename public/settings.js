'use strict';
/* global api, esc, toast, adminViews, adminTabs, loadMe, render, adminEvent */
// Einstellungen: Module an/aus (pro Event), dazu für alle Events Admin-Zugang, Beamer, Durchsagen, DMX-Lampe.
// Name und Zeitraum der Events stehen unter „Events“ (events.js).

// restrict: lässt sich auf „nur Teilnehmer mit Ticket“ stellen
const MODULES = [
  { key: 'details', label: '📋 Event', hint: 'Allgemeine Eventdetails: Beginn, Ort, Mindestalter, Tickets und Preise', restrict: true },
  { key: 'tournaments', label: '🏆 Turniere', hint: 'Turnierbäume, Ligen, „Jetzt dran“, Discord-Anmeldung', restrict: true },
  { key: 'announcements', label: '📢 Durchsagen', hint: 'Banner, Beamer-Einblendung, Gong, Lampe, /announce' },
  { key: 'schedule', label: '🗓️ Programm', hint: 'Zeitplan mit Countdown und Discord-Erinnerungen', restrict: true },
  { key: 'info', label: 'ℹ️ Infos', hint: 'Infos vor Ort: WLAN, Gameserver, Spieleliste, Hausregeln', restrict: true },
  { key: 'people', label: '👥 Teilnehmer', hint: 'Teilnehmerliste mit Discord (/ich) und Steam', restrict: true },
  { key: 'seating', label: '💺 Sitzplan', hint: 'Plätze im Raum (braucht „Teilnehmer“)', restrict: true },
  { key: 'beamer', label: '📺 Beamer', hint: 'Vollbild-Infoscreen für Leinwand oder zweiten Bildschirm', restrict: true },
  { key: 'servers', label: '🖥️ Gastserver', hint: 'Teilnehmer melden eigene Server an und bekommen IP und FQDN', restrict: true },
  { key: 'tickets', label: '🎟️ Tickets', hint: 'Ticketverkauf mit Discord-Login, Anschrift, Überweisung und Check-in' },
  { key: 'catering', label: '🍽️ Catering', hint: 'Essensangebote, eigene Anmeldung, Gäste zuweisen und Bezahlung verwalten', restrict: true },
  { key: 'cs2', label: '🔫 CS2-Matches', hint: 'Counter-Strike-2-Matches über TMT2 anlegen und Ergebnisse übernehmen (nur Orga, braucht den TMT2-Container)' },
];

adminViews.einstellungen = {
  label: 'Einstellungen', order: 90, events: ['settings'],
  async render() {
    const s = await api('GET', '/settings');
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('einstellungen')}
      <form id="setForm" class="editor">
        <div class="two">
          <div>
            <div class="card"><h2>🔑 Admin-Zugang</h2>
              <div class="field"><label for="adRole">Discord-Rolle für den Admin-Bereich <span class="meta">(eindeutige Rollen-ID)</span></label>
                <input id="adRole" value="${esc(s.adminRole || '')}" inputmode="numeric" pattern="[1-9][0-9]{16,19}" maxlength="20" placeholder="Discord-Rollen-ID"></div>
              ${s.adminRoleWarning ? `<p class="error">${esc(s.adminRoleWarning)}</p>` : ''}
              <p class="hint">Wer diese Rolle hat, meldet sich mit „Mit Discord anmelden“ an. Server-Inhaber und Rollen mit Administrator-Recht
                kommen immer hinein. Wird die Rolle entzogen, endet die Sitzung nach spätestens 10 Minuten.
                Discord-Entwicklermodus einschalten, dann bei der Rolle „ID kopieren“. Bisherige Rollennamen bewusst durch diese ID ersetzen; Namensgleichheit gewährt keinen Zugang.</p>
            </div>
            <div class="card"><h2>🎮 Events</h2>
              <p class="meta">Name, Zeitraum, Start und Ende der LAN-Events (und damit die Discord-Kanäle) verwaltest du unter <a href="#/admin/events">Events</a>.</p>
            </div>
            <div class="card"><h2>Module <span class="meta">für ${esc(adminEvent() ? adminEvent().name : '')}</span></h2>
              <p class="meta">Jedes Event hat seine eigene Auswahl – oben in der Leiste wählst du das Event. Ausgeschaltete Module verschwinden
                für Besucher aus Webseite, Beamer und Discord. Du kannst sie trotzdem schon vorbereiten. Neue Events übernehmen die Auswahl ihrer Vorlage.</p>
              <div class="modules">${MODULES.map((m) => `<div class="module-row"><label class="module-toggle">
                <input type="checkbox" data-module="${m.key}" ${s.modules[m.key] ? 'checked' : ''}>
                <span><strong>${m.label}</strong><span class="meta">${esc(m.hint)}</span></span></label>
                ${m.restrict ? `<select data-access="${m.key}" title="Wer sieht das Modul?">
                  <option value="public">öffentlich</option>
                  <option value="tickets" ${(s.access || {})[m.key] === 'tickets' ? 'selected' : ''}>🔒 nur Teilnehmer mit Ticket</option></select>` : ''}</div>`).join('')}</div>
              <p class="hint">„Nur Teilnehmer mit Ticket“: sichtbar für alle, die mit Discord angemeldet sind und ein bezahltes Ticket für das Event haben
                oder als verknüpfte Person (<code>/ich</code>) in der Teilnehmerliste stehen – auf der Webseite und bei den Discord-Befehlen.</p>
            </div>
            <div class="card"><h2>📺 Beamer</h2>
              <div class="field"><label for="bSec">Sekunden pro Folie</label><input id="bSec" type="number" min="5" max="600" value="${s.beamerSeconds}" style="max-width:140px"></div>
              <p class="hint">Beamer-Ansicht öffnen: <a href="#/beamer">${esc(location.host)}/#/beamer</a> – für Ton einmal auf 🔔 klicken.</p>
            </div>
          </div>
          <div>
            <div class="card"><h2>📢 Durchsagen</h2>
              <div class="field"><label for="aSec">Standard-Dauer in Sekunden (0 = bis zum Beenden)</label><input id="aSec" type="number" min="0" max="3600" value="${s.announceSeconds}" style="max-width:140px"></div>
              <div class="field"><label for="aRole">Discord-Rolle für <code>/announce</code> <span class="meta">(leer = alle)</span></label><input id="aRole" value="${esc(s.announceRole)}" placeholder="z. B. Orga"></div>
              <div class="field"><label for="rMin">Programm: Standard-Erinnerung (Minuten vorher)</label><input id="rMin" type="number" min="0" max="1440" value="${s.remindMinutes}" style="max-width:140px"></div>
              <label class="check"><input type="checkbox" id="mPlayers" ${s.mentionPlayers ? 'checked' : ''}> Spieler in Turnier-Ansagen in Discord erwähnen (nur verknüpfte)</label>
            </div>
            <div class="card"><h2>🔴 DMX-Lampe</h2>
              <p class="meta">Die Lampe hängt per USB-DMX an einem Raspberry Pi mit OLA. Hier die Adresse der OLA-Weboberfläche eintragen.</p>
              <div class="field"><label for="dUrl">OLA-Adresse</label><input id="dUrl" value="${esc(s.dmx.url)}" placeholder="http://192.168.1.50:9090"></div>
              <div class="row two-inputs">
                <div class="field"><label for="dUni">Universe</label><input id="dUni" type="number" min="0" value="${s.dmx.universe}"></div>
                <div class="field"><label for="dOn">Kanäle bei Durchsage</label><input id="dOn" value="${esc(s.dmx.on)}" placeholder="1=255"></div>
                <div class="field"><label for="dOff">Kanäle im Ruhezustand</label><input id="dOff" value="${esc(s.dmx.off)}" placeholder="leer = alles aus"></div>
              </div>
              <p class="hint">Format <code>Kanal=Wert</code>, mehrere mit Komma, z. B. <code>1=255, 4=255</code> (Rot + Dimmer).</p>
              <div class="row"><button type="button" id="lampOn">🔴 Testen: an</button><button type="button" id="lampOff">⚫ aus</button>
                <span class="meta">(vorher speichern)</span></div>
            </div>
          </div>
        </div>
        <p class="error" id="setError"></p>
        <button type="submit" class="primary big">Einstellungen speichern</button>
      </form>`;

    const v = (id) => document.getElementById(id).value;
    document.getElementById('setForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('PUT', '/settings', {
          beamerSeconds: Number(v('bSec')),
          announceSeconds: Number(v('aSec')),
          announceRole: v('aRole'),
          adminRole: v('adRole'),
          remindMinutes: Number(v('rMin')),
          mentionPlayers: document.getElementById('mPlayers').checked,
          modules: Object.fromEntries([...app.querySelectorAll('[data-module]')].map((c) => [c.dataset.module, c.checked])),
          access: Object.fromEntries([...app.querySelectorAll('[data-access]')].map((c) => [c.dataset.access, c.value])),
          dmx: { url: v('dUrl'), universe: Number(v('dUni')), on: v('dOn'), off: v('dOff') },
        });
        await loadMe();
        toast('Einstellungen gespeichert');
        document.activeElement.blur();
        render();
      } catch (err) { document.getElementById('setError').textContent = err.message; }
    };
    const lamp = async (onOff) => {
      try { await api('POST', '/announcements/lamp', { on: onOff }); toast(onOff ? 'Lampe an' : 'Lampe aus'); } catch (err) { toast(err.message); }
    };
    document.getElementById('lampOn').onclick = () => lamp(true);
    document.getElementById('lampOff').onclick = () => lamp(false);
  },
};
