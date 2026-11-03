'use strict';
/* global api, esc, state, on, views, beamerSlides, Bracket, Sched, schedItem, loadFull, nowPlaying, nowItem,
   podium, typeLabel, renderKO, renderDE, renderRR, render, unlockAudio, Announce, speak, pname, soundMode, nextSoundMode, soundReady, SOUND_MODES */
// Beamer-Ansicht: Vollbild-Infoscreen. Wechselt durch Folien der aktiven Module
// (Turniere, Programm, Infos, Sitzplan); Durchsagen legen sich darüber.

const beamer = { idx: 0, timer: null, seen: null };

// Neu anstehende Spiele vorlesen. Das erste Laden (und jeder neue Aufruf des Beamers) liest nichts vor.
function speakNewMatches(now) {
  const keys = new Map(now.map((x) => [`${x.t.id}:${x.m.id}:${x.m.a}:${x.m.b}`, x]));
  const fresh = beamer.seen ? [...keys].filter(([k]) => !beamer.seen.has(k)).map(([, x]) => x) : [];
  beamer.seen = new Set(keys.keys());
  if (!state.settings.speakMatches || soundMode() !== 'speak' || !fresh.length) return;
  if (fresh.length > 3) { speak(`${fresh.length} neue Spiele sind dran. Bitte auf den Beamer schauen.`); return; }
  for (const { t, m } of fresh) speak(`${t.name}, ${m.label}: ${pname(t, m.a)} gegen ${pname(t, m.b)}. Ihr seid dran.`);
}
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/beamer')) beamer.seen = null; });

// Ton-Knopf: vor dem Freigabe-Klick deutlich sichtbar, danach zeigt er die Stufe und schaltet sie reihum
function beamerSoundButton() {
  const btn = document.getElementById('beamerSound');
  if (!btn) return;
  const [icon, label] = soundReady() ? SOUND_MODES[soundMode()] : ['🔇', 'Ton aktivieren'];
  btn.innerHTML = `${icon} <span>${label}</span>`;
  btn.title = soundReady() ? 'Klicken schaltet um: Ton aus → nur Gong → Gong und vorlesen' : 'Browser spielen Ton erst nach einem Klick ab';
  btn.closest('.beamer-tools').classList.toggle('attention', !soundReady());
}
// Freigeben und danach den Knopf aktualisieren (resume() wirkt erst asynchron)
const beamerUnlock = () => { unlockAudio(); Promise.resolve(Announce.audio && Announce.audio.resume()).then(beamerSoundButton, beamerSoundButton); };

function stopBeamer() {
  clearInterval(beamer.timer);
  beamer.timer = null;
}

// Folien: Turniere zuerst, dann die der anderen Module
async function beamerSlideList(pinnedId) {
  if (pinnedId) return [{ tournament: await api('GET', '/tournaments/' + pinnedId) }];
  const slides = [];
  if (on('tournaments')) {
    const list = (await api('GET', '/tournaments')).filter((t) => t.status !== 'draft');
    const running = list.filter((t) => !t.finished);
    const shown = running.length ? running : list.filter((t) => t.finished).slice(0, 2); // sonst die letzten Sieger
    for (const t of await loadFull(shown)) slides.push({ tournament: t });
  }
  const extra = beamerSlides.filter((s) => on(s.module)).sort((a, b) => a.order - b.order);
  for (const s of extra) slides.push(...await s.build().catch(() => []));
  return slides;
}

async function beamerSidebar() {
  let html = '';
  if (on('schedule') && typeof Sched !== 'undefined') {
    const next = Sched.upcoming(await Sched.load()).slice(0, 3);
    if (next.length) html += `<h2>🗓️ Als Nächstes</h2><ul class="sched compact">${next.map(schedItem).join('')}</ul>`;
  }
  if (on('tournaments')) {
    const running = (await api('GET', '/tournaments')).filter((t) => t.status !== 'draft' && !t.finished);
    const now = nowPlaying(await loadFull(running));
    speakNewMatches(now);
    html += `<h2>⚔️ Jetzt dran</h2>${now.length
      ? `<div class="now-list">${now.slice(0, 8).map(nowItem).join('')}</div>${now.length > 8 ? `<p class="meta">… und ${now.length - 8} weitere</p>` : ''}`
      : '<p class="meta">Gerade keine offenen Spiele.</p>'}`;
  }
  return html;
}

views.beamer = {
  label: 'Beamer', module: 'beamer',
  async render(pinnedId) {
    const app = document.getElementById('app');
    const [slides, side] = await Promise.all([beamerSlideList(pinnedId), beamerSidebar()]);
    const name = state.settings.eventName || 'LAN-Party';
    const tools = `<div class="beamer-tools">
      <button id="beamerSound"></button>
      <button id="beamerFull" title="Vollbild">⛶</button><a class="btn" href="#/" title="Beamer-Ansicht verlassen">✕</a></div>`;

    if (!slides.length) {
      app.innerHTML = `<div class="beamer"><div class="beamer-main"><div class="beamer-empty">🎮 ${esc(name)}<br><span>Willkommen!</span></div></div>
        ${side ? `<aside class="beamer-side">${side}<div class="beamer-url">Infos & Ergebnisse:<br><strong>${esc(location.host)}</strong></div></aside>` : ''}${tools}</div>`;
    } else {
      beamer.idx %= slides.length;
      const slide = slides[beamer.idx];
      const t = slide.tournament;
      const view = t ? Bracket.compute(t) : null;
      if (t) state.tournament = t;
      app.innerHTML = `<div class="beamer">
        <div class="beamer-main">
          <div class="beamer-head">
            <div><h1>${esc(t ? t.name : slide.title)}</h1>
              <div class="meta">${t ? `${t.game ? esc(t.game) + ' · ' : ''}${typeLabel(t.type)} · ${t.participants.length} ${(t.teamSize || 1) > 1 ? 'Teams' : 'Teilnehmer'}` : esc(name)}</div></div>
            ${slides.length > 1 ? `<div class="beamer-dots">${slides.map((_, i) => `<span class="${i === beamer.idx ? 'on' : ''}"></span>`).join('')}</div>` : ''}
          </div>
          <div class="beamer-stage"><div class="beamer-fit" id="beamerFit">${t ? `${podium(t, view)}<div id="board"></div>` : slide.html}</div></div>
        </div>
        ${side ? `<aside class="beamer-side">${side}<div class="beamer-url">Infos & Ergebnisse:<br><strong>${esc(location.host)}</strong></div></aside>` : ''}
        ${tools}
      </div>`;
      const fit = document.getElementById('beamerFit');
      if (t) {
        const board = document.getElementById('board');
        if (view.type === 'ko') renderKO(board, t, view);
        else if (view.type === 'de') renderDE(board, t, view);
        else { fit.style.width = '1200px'; renderRR(board, t, view); }
      } else if (slide.width) fit.style.width = slide.width + 'px';
      fitBeamer();
    }

    document.getElementById('beamerFull').onclick = () => {
      beamerUnlock();
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    };
    document.getElementById('beamerSound').onclick = () => {
      if (soundReady()) { nextSoundMode(); beamerSoundButton(); } else beamerUnlock();
    };
    beamerSoundButton();
    // Rotation unabhängig von Live-Updates, damit häufige Änderungen den Wechsel nicht aufhalten
    if (!pinnedId && slides.length > 1) {
      if (!beamer.timer) beamer.timer = setInterval(() => { beamer.idx++; render(); }, (state.settings.beamerSeconds || 20) * 1000);
    } else stopBeamer();
  },
};

// Inhalt so skalieren, dass er die Fläche füllt, ohne zu scrollen
function fitBeamer() {
  const stage = document.querySelector('.beamer-stage');
  const fit = document.getElementById('beamerFit');
  if (!stage || !fit) return;
  fit.style.transform = 'none';
  const w = fit.scrollWidth, h = fit.scrollHeight;
  const scale = Math.min(stage.clientWidth / w, stage.clientHeight / h, 2.2);
  fit.style.transform = `scale(${scale})`;
  fit.style.left = `${Math.max(0, (stage.clientWidth - w * scale) / 2)}px`;
}
window.addEventListener('resize', fitBeamer);
