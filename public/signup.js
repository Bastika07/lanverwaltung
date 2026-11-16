'use strict';
/* global api, esc, toast, state, views, render, typeLabel, fmtDay */
// „Meine Turniere“: Besucher melden sich selbst an, gründen Teams, fragen den Beitritt an und verwalten als Captain
// ihr Team. Gleiche Regeln wie die Discord-Befehle; geprüft wird alles auf dem Server (lib/tournaments.js).

const suCoins = (c) => (c && c.budget ? `<div class="su-coins" title="Turnier-Coins für dieses Event">🪙 Du hast noch <strong>${c.left}</strong> von ${c.budget} Coins</div>` : '');

function suStatus(t) {
  if (t.status === 'running') return t.finished ? '<span class="badge finished">Beendet</span>' : '<span class="badge running">Läuft</span>';
  return t.open ? '<span class="badge running">Anmeldung offen</span>' : '<span class="badge draft">Anmeldung geschlossen</span>';
}

function suFacts(t, budget) {
  const facts = [t.game, typeLabel(t.type), t.teamSize > 1 ? `Teams à ${t.teamSize}` : 'Einzelspieler',
    `${t.count}${t.maxParticipants ? ' / ' + t.maxParticipants : ''} ${t.teamSize > 1 ? 'Teams' : 'angemeldet'}`,
    budget && t.coins ? `kostet ${t.coins} 🪙` : budget ? 'kostenlos' : '',
    t.open && t.signupUntil ? `Anmeldeschluss ${fmtDay(t.signupUntil)}` : ''].filter(Boolean);
  return `<div class="meta">${facts.map(esc).join(' · ')}</div>`;
}

// Warum man sich gerade nicht anmelden kann (null = es geht)
function suBlocked(t, coins, joining) {
  if (!t.open) return 'Die Anmeldung ist geschlossen.';
  if (!joining && t.maxParticipants && t.count >= t.maxParticipants) return 'Das Turnier ist voll.';
  if (coins.budget && t.coins > coins.left) return `Dafür fehlen dir Coins (kostet ${t.coins}, du hast noch ${coins.left}).`;
  return null;
}

const suBtn = (act, t, label, extra = '', cls = '') => `<button class="${cls}" data-su="${act}" data-t="${esc(t.id)}" ${extra}>${label}</button>`;

function suSingle(t, coins) {
  if (t.entry) {
    return `<p class="su-state ok">✅ Du bist angemeldet als <strong>${esc(t.entry)}</strong>.</p>
      ${t.open ? suBtn('leave', t, 'Abmelden', '', 'danger small') + (t.coins && coins.budget ? ` <span class="hint">Du bekommst deine ${t.coins} Coins zurück.</span>` : '') : '<p class="hint">Abmelden geht nicht mehr – bitte bei der Orga melden.</p>'}`;
  }
  const why = suBlocked(t, coins);
  return why ? `<p class="hint">${esc(why)}</p>` : suBtn('join', t, `Jetzt anmelden${t.coins && coins.budget ? ` (${t.coins} 🪙)` : ''}`, '', 'primary');
}

function suMyTeam(t, coins) {
  const team = t.team;
  const draft = t.status === 'draft';
  const members = team.members.map((m) => `<li>${m.captain ? '👑 ' : ''}${esc(m.name)}${m.captain ? ' <span class="meta">(Captain)</span>' : ''}
    ${team.captain && draft && !m.captain ? `<button class="small" data-su="remove" data-t="${esc(t.id)}" data-person="${esc(m.id)}" title="Aus dem Team entfernen">Entfernen</button>` : ''}</li>`).join('');
  let html = `<p class="su-state ok">🛡️ Du bist im Team <strong>${esc(team.name)}</strong> (${team.members.length}/${t.teamSize})${team.captain ? ' – du bist der Captain.' : '.'}</p>
    <ul class="su-members">${members}</ul>`;
  if (team.captain && team.requests.length) {
    html += `<div class="su-requests"><strong>📨 Beitrittsanfragen</strong>
      ${team.requests.map((r) => `<div class="row su-request"><span>${esc(r.name)}</span>
        <button class="primary small" data-su="accept" data-t="${esc(t.id)}" data-person="${esc(r.id)}" ${team.members.length >= t.teamSize ? 'disabled title="Das Team ist voll"' : ''}>Annehmen</button>
        <button class="small" data-su="decline" data-t="${esc(t.id)}" data-person="${esc(r.id)}">Ablehnen</button></div>`).join('')}
      ${t.coins && coins.budget ? `<p class="hint">Beim Annehmen zahlt die Person selbst ${t.coins} Coins.</p>` : ''}</div>`;
  } else if (team.captain && draft && team.members.length < t.teamSize) {
    html += '<p class="hint">Noch Platz im Team: Deine Mitspieler wählen auf dieser Seite dein Team aus und fragen den Beitritt an. Du bestätigst hier.</p>';
  }
  if (!draft) return html + '<p class="hint">Das Turnier läuft – Änderungen am Team macht nur noch die Orga.</p>';
  if (team.captain) {
    html += `<form class="row su-rename" data-t="${esc(t.id)}"><input name="name" maxlength="${Bracket.NAME_MAX}" value="${esc(team.name)}" aria-label="Teamname" style="max-width:220px">
      <button class="small" type="submit">Umbenennen</button></form>`;
    if (t.open) html += `<div class="row">${suBtn('dissolve', t, 'Team auflösen', '', 'danger small')}</div>
      <p class="hint">Auflösen meldet das ganze Team ab, alle bekommen ihre Coins zurück. Eine Übergabe der Captain-Rolle gibt es nicht.</p>`;
  } else if (t.open) {
    html += `<div class="row">${suBtn('leave-team', t, 'Team verlassen', '', 'danger small')}</div>`;
  }
  return html;
}

function suTeamChoice(t, coins) {
  if (t.request) {
    return `<p class="su-state wait">⏳ Deine Anfrage an <strong>${esc(t.request)}</strong> wartet auf den Captain.</p>
      ${suBtn('cancel', t, 'Anfrage zurückziehen', '', 'small')}`;
  }
  const why = suBlocked(t, coins, true);
  if (why) return `<p class="hint">${esc(why)}</p>`;
  const full = t.maxParticipants && t.count >= t.maxParticipants;
  const teams = t.teams.map((x) => {
    const isFull = x.size >= t.teamSize;
    return `<div class="team su-team"><div class="row" style="justify-content:space-between"><span><strong>${esc(x.name)}</strong> <span class="meta">(${x.size}/${t.teamSize})</span></span>
      <button class="small" data-su="request" data-t="${esc(t.id)}" data-team="${esc(x.name)}" ${isFull ? 'disabled' : ''}>${isFull ? 'Voll' : 'Beitritt anfragen'}</button></div>
      ${x.members.length ? `<div class="meta">${x.members.map((n) => esc(n) + (n === x.captain ? ' 👑' : '')).join(', ')}</div>` : ''}</div>`;
  }).join('');
  return `<div class="su-choice">
    <div><strong>Einem Team beitreten</strong>
      ${t.teams.length ? `<div class="teams">${teams}</div><p class="hint">Der Captain des Teams muss deine Anfrage bestätigen.</p>` : '<p class="meta">Noch keine Teams – gründe einfach das erste.</p>'}</div>
    <div><strong>Oder ein eigenes Team gründen</strong>
      ${full ? '<p class="hint">Das Turnier ist voll, neue Teams gehen nicht mehr.</p>' : `<form class="row su-found" data-t="${esc(t.id)}">
        <input name="name" required maxlength="${Bracket.NAME_MAX}" placeholder="Teamname" aria-label="Teamname" style="max-width:220px">
        <button class="primary" type="submit">Team gründen${t.coins && coins.budget ? ` (${t.coins} 🪙)` : ''}</button></form>
        <p class="hint">Du wirst Captain und bestätigst, wer mitspielt.</p>`}</div></div>`;
}

function suCard(t, coins) {
  const body = t.teamSize > 1 ? (t.team ? suMyTeam(t, coins) : t.status === 'draft' ? suTeamChoice(t, coins) : '') : t.status === 'draft' || t.entry ? suSingle(t, coins) : '';
  return `<div class="card su-card" id="su-${esc(t.id)}">
    <div class="row" style="justify-content:space-between"><h2>${esc(t.name)}</h2>${suStatus(t)}</div>
    ${suFacts(t, coins.budget)}
    <div class="su-body">${body}</div>
    ${t.status !== 'draft' ? `<p class="hint"><a href="#/t/${esc(t.id)}">Zum Turnierbaum</a></p>` : ''}</div>`;
}

const suHelp = (coins) => `<details class="card su-help"><summary><strong>❓ So funktioniert’s</strong></summary>
  <ul>
    <li><strong>Einzelturnier:</strong> „Jetzt anmelden“ drücken – fertig. Abmelden geht, solange die Anmeldung offen ist.</li>
    <li><strong>Teamturnier:</strong> Eine Person gründet das Team und ist damit <strong>Captain</strong> 👑. Alle anderen wählen das Team aus und drücken „Beitritt anfragen“. Der Captain nimmt die Anfrage an oder lehnt sie ab.</li>
    <li><strong>Captain:</strong> kann bis zum Turnierstart den Teamnamen ändern und Mitglieder entfernen. Verlässt der Captain das Team, wird es aufgelöst.</li>
    ${coins.budget ? `<li><strong>Coins 🪙:</strong> Du hast ${coins.budget} Coins für dieses Event. Manche (Preis-)Turniere kosten Coins, damit niemand alle Preisturniere spielt. Bei Teams zahlt jedes Mitglied selbst, sobald es im Team ist. Wer abgemeldet wird – auch weil ein Team aufgelöst wird – bekommt seine Coins zurück.</li>` : ''}
    <li><strong>Turnier gestartet:</strong> Ab dann ändert nur noch die Orga etwas an den Teams.</li>
  </ul><p class="hint">Das Gleiche geht auch im Discord mit <code>/anmelden</code> und <code>/team</code>.</p></details>`;

views['meine-turniere'] = {
  label: 'Meine Turniere', module: 'tournaments', events: ['tournament', 'people', 'accounts'],
  visible: () => !!state.userLogin,
  async render() {
    const d = await api('GET', '/tournaments/signup');
    const app = document.getElementById('app');
    const head = `<div class="page-head"><div><h1>Meine Turniere</h1><div class="meta">Anmelden, Teams gründen und verwalten</div></div>${suCoins(d.coins)}</div>`;
    if (!d.loggedIn) {
      app.innerHTML = `${head}<div class="card" style="max-width:520px"><h2>Mit Discord anmelden</h2>
        <p>Für Turniere meldest du dich mit deinem Discord-Konto an – dem gleichen, das du im LAN-Discord nutzt.</p>
        ${state.userLogin ? '<a class="btn primary big discord-btn" href="/api/auth/login?ziel=turniere">Mit Discord anmelden</a>' : '<p class="meta">Die Anmeldung ist gerade nicht eingerichtet.</p>'}</div>`;
      return;
    }
    const list = d.tournaments.slice().sort((a, b) => (a.status === 'draft') - (b.status === 'draft') || a.name.localeCompare(b.name, 'de'));
    const mine = list.filter((t) => t.entry || t.team || t.request);
    const rest = list.filter((t) => !(t.entry || t.team || t.request) && t.status === 'draft');
    app.innerHTML = `${head}
      ${d.allowed ? '' : `<div class="card hint-card"><h2>🎟️ Kein Ticket gefunden</h2><p>Für Turniere anmelden können sich nur Teilnehmer mit Ticket für dieses Event.
        Hast du ein Ticket, verknüpfe dich im Discord mit <code>/ich</code> und deinem Ticketcode oder frag die Orga.</p></div>`}
      ${suHelp(d.coins)}
      ${mine.length ? `<h2 class="su-section">Du bist dabei</h2>${mine.map((t) => suCard(t, d.coins)).join('')}` : ''}
      ${d.allowed ? `<h2 class="su-section">${mine.length ? 'Weitere Turniere' : 'Turniere mit offener Anmeldung'}</h2>
        ${rest.length ? rest.map((t) => suCard(t, d.coins)).join('') : '<p class="meta">Gerade gibt es keine weiteren Turniere zum Anmelden.</p>'}` : ''}`;

    const send = async (id, action, body, msg) => {
      try {
        const r = await api('POST', `/tournaments/${encodeURIComponent(id)}/signup/${action}`, body || {});
        toast(r.already ? 'Schon erledigt' : msg);
        render();
      } catch (err) { toast(err.message); }
    };
    const QUESTIONS = {
      leave: 'Wirklich abmelden?',
      'leave-team': 'Team wirklich verlassen?',
      dissolve: 'Team wirklich auflösen? Alle Mitglieder werden abgemeldet und bekommen ihre Coins zurück.',
      remove: 'Diese Person aus dem Team entfernen?',
      decline: 'Anfrage ablehnen?',
    };
    const DONE = { join: '✅ Angemeldet', leave: '👋 Abgemeldet', request: '📨 Anfrage gestellt', cancel: 'Anfrage zurückgezogen', accept: '➕ Aufgenommen',
      decline: 'Abgelehnt', 'leave-team': '👋 Team verlassen', dissolve: 'Team aufgelöst', remove: 'Entfernt' };
    app.querySelectorAll('button[data-su]').forEach((b) => {
      b.onclick = () => {
        const action = b.dataset.su;
        if (QUESTIONS[action] && !confirm(QUESTIONS[action])) return;
        send(b.dataset.t, action, { team: b.dataset.team, person: b.dataset.person }, DONE[action]);
      };
    });
    app.querySelectorAll('form.su-found').forEach((f) => {
      f.onsubmit = (e) => { e.preventDefault(); send(f.dataset.t, 'found', { name: f.elements.name.value.trim() }, '🛡️ Team gegründet – du bist Captain'); };
    });
    app.querySelectorAll('form.su-rename').forEach((f) => {
      f.onsubmit = (e) => { e.preventDefault(); send(f.dataset.t, 'rename', { name: f.elements.name.value.trim() }, 'Team umbenannt'); };
    });
  },
};
