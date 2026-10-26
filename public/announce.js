'use strict';
/* global api, esc, toast, state, on, adminViews, adminTabs, liveHandlers, startHooks, render */
// Durchsagen: Banner auf allen Seiten, große Einblendung auf dem Beamer (mit Gong),
// Admin-Seite zum Senden. Auslöser können auch Discord (/announce) und das Programm sein.

const Announce = { active: null, hideTimer: null, lastGongId: null, audio: null };

function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// Dreiklang-Gong per WebAudio (keine Audiodatei nötig). Browser erlauben Ton erst nach einem Klick.
function playGong() {
  const ctx = Announce.audio;
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  [[659.25, 0], [523.25, 0.45], [392.0, 0.9]].forEach(([freq, delay]) => {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + delay);
    gain.gain.exponentialRampToValueAtTime(0.5, t0 + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 1.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + delay);
    osc.stop(t0 + delay + 1.7);
  });
}

function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  if (!Announce.audio) Announce.audio = new AC();
  Announce.audio.resume();
  return true;
}

function isActive(a) {
  return a && !a.endedAt && (!a.until || Date.parse(a.until) > Date.now());
}

// Banner (normale Seiten) und Einblendung (Beamer) aktualisieren
function showAnnouncement() {
  const a = isActive(Announce.active) && on('announcements') ? Announce.active : null;
  const banner = document.getElementById('banner');
  const overlay = document.getElementById('overlay');
  clearTimeout(Announce.hideTimer);
  if (!a) {
    banner.hidden = true;
    overlay.hidden = true;
    return;
  }
  const dismissed = sessionStorageGet('dismissed') === a.id;
  banner.hidden = dismissed;
  banner.innerHTML = `<span class="banner-icon">📢</span>
    <span class="banner-text"><strong>Durchsage${a.by ? ` von ${esc(a.by)}` : ''}:</strong> ${esc(a.text)}</span>
    <button class="banner-close" title="Ausblenden">✕</button>`;
  banner.querySelector('.banner-close').onclick = () => { sessionStorageSet('dismissed', a.id); banner.hidden = true; };

  overlay.hidden = false;
  overlay.innerHTML = `<div class="overlay-box">
    <div class="overlay-label">📢 Durchsage</div>
    <div class="overlay-text">${esc(a.text)}</div>
    <div class="overlay-meta">${a.by ? esc(a.by) + ' · ' : ''}${fmtClock(a.at)}</div>
  </div>`;
  if (Announce.lastGongId !== a.id) {
    Announce.lastGongId = a.id;
    if (a.gong && document.body.classList.contains('beamer-mode')) playGong();
  }
  if (a.until) Announce.hideTimer = setTimeout(showAnnouncement, Date.parse(a.until) - Date.now() + 200);
}

function sessionStorageGet(k) { try { return sessionStorage.getItem('lan-' + k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem('lan-' + k, v); } catch { /* egal */ } }

async function loadAnnouncement() {
  if (!on('announcements')) { Announce.active = null; showAnnouncement(); return null; }
  const data = await api('GET', '/announcements').catch(() => ({ active: null, recent: [] }));
  // Beim ersten Laden keinen Gong für eine bereits laufende Durchsage
  if (Announce.lastGongId === null) Announce.lastGongId = data.active ? data.active.id : '';
  Announce.active = data.active;
  showAnnouncement();
  return data;
}

startHooks.push(loadAnnouncement);
liveHandlers.push((ev) => {
  if (ev.type === 'announce' || ev.type === 'settings') {
    loadAnnouncement().then(() => {
      if (state.route && state.route.view === 'admin:ansagen' && !document.activeElement?.closest?.('form')) render();
    });
  }
});

// ---------- Admin: Durchsagen ----------
const QUICK = ['🍕 Das Essen ist da!', '🏆 Siegerehrung in 5 Minuten', '⏰ Turnierstart in 10 Minuten – bitte an die Plätze', '🧹 Bitte kurz aufräumen'];

adminViews.ansagen = {
  label: 'Durchsagen', module: 'announcements', order: 10,
  async render() {
    const data = await loadAnnouncement() || { active: null, recent: [] };
    const s = await api('GET', '/settings');
    const a = isActive(data.active) ? data.active : null;
    const lampOk = !!s.dmx.url;
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('ansagen')}
      <div class="two">
        <div class="card">
          <h2>Neue Durchsage</h2>
          <form id="annForm">
            <div class="field"><label for="annText">Text</label>
              <textarea id="annText" class="short" maxlength="300" required placeholder="z. B. Pizza für Trödeldö ist da"></textarea></div>
            <div class="quick">${QUICK.map((q) => `<button type="button" class="chip" data-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>
            <div class="row">
              <label class="check"><input type="checkbox" id="annLamp" ${lampOk ? 'checked' : 'disabled'}> 🔴 Lampe${lampOk ? '' : ' (nicht eingerichtet)'}</label>
              <label class="check"><input type="checkbox" id="annGong" checked> 🔔 Gong (Beamer)</label>
              <label class="check"><input type="checkbox" id="annDiscord" ${state.discord ? 'checked' : 'disabled'}> 💬 Discord</label>
            </div>
            <div class="field" style="margin-top:12px"><label for="annSec">Dauer in Sekunden <span class="meta">(0 = bis zum manuellen Beenden)</span></label>
              <input type="number" id="annSec" min="0" max="3600" value="${s.announceSeconds}" style="max-width:140px"></div>
            <p class="error" id="annError"></p>
            <button type="submit" class="primary big">📢 Durchsage senden</button>
          </form>
          <p class="hint">Durchsagen gehen auch in Discord mit <code>/announce</code>${s.announceRole ? ` (Rolle „${esc(s.announceRole)}“)` : ''}.</p>
          ${state.discord && !(state.settings.event && state.settings.event.active)
            ? '<p class="hint">💬 Das Event läuft gerade nicht – Discord-Posts sind pausiert. Starten unter <a href="#/admin/einstellungen">Einstellungen → Event-Zeitraum</a>.</p>' : ''}
        </div>
        <div>
          <div class="card ${a ? 'live' : ''}">
            <h2>Aktuell</h2>
            ${a ? `<p class="ann-live">📢 ${esc(a.text)}</p>
              <p class="meta">${esc(a.by || '')} · seit ${fmtClock(a.at)}${a.until ? ` · bis ${fmtClock(a.until)}` : ' · bis zum Beenden'}</p>
              ${a.lampError ? `<p class="error">⚠️ Lampe: ${esc(a.lampError)}</p>` : ''}
              ${a.discordError ? `<p class="error">⚠️ Discord: ${esc(a.discordError)}</p>` : ''}
              <button class="danger" id="annEnd">Durchsage beenden</button>`
              : '<p class="meta">Gerade läuft keine Durchsage.</p>'}
          </div>
          <div class="card">
            <h2>Letzte Durchsagen</h2>
            ${data.recent.length ? `<ul class="ann-list">${data.recent.map((r) => `<li>
              <span class="meta">${fmtClock(r.at)}</span> ${esc(r.text)}
              <span class="meta">– ${esc(r.by || '')}${r.source === 'discord' ? ' (Discord)' : r.source === 'schedule' ? ' (Programm)' : ''}</span>
              <button class="small" data-repeat="${esc(r.text)}" title="Erneut senden">↻</button></li>`).join('')}</ul>`
              : '<p class="meta">Noch keine.</p>'}
          </div>
        </div>
      </div>`;

    const text = document.getElementById('annText');
    app.querySelectorAll('[data-quick]').forEach((b) => { b.onclick = () => { text.value = b.dataset.quick; text.focus(); }; });
    app.querySelectorAll('[data-repeat]').forEach((b) => { b.onclick = () => { text.value = b.dataset.repeat; text.focus(); }; });
    document.getElementById('annForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/announcements', {
          text: text.value,
          lamp: document.getElementById('annLamp').checked,
          gong: document.getElementById('annGong').checked,
          discord: document.getElementById('annDiscord').checked,
          seconds: Number(document.getElementById('annSec').value),
        });
        toast('📢 Durchsage gesendet');
        text.value = '';
        text.blur();
        render();
      } catch (err) { document.getElementById('annError').textContent = err.message; }
    };
    const endBtn = document.getElementById('annEnd');
    if (endBtn) endBtn.onclick = async () => { await api('POST', '/announcements/end'); toast('Durchsage beendet'); render(); };
  },
};
