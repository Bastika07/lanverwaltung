'use strict';
// Discord-Seite der Turniere: Voice-Kanäle, Ansagen und Erwähnungen gebundener Spieler.
// Das Turniermodul (lib/tournaments.js) meldet nur, was passiert ist; hier wird entschieden, was Discord davon sieht.

const Bracket = require('../public/bracket.js');
const { isFinished } = require('./tournaments.js');

const TYPE_NAMES = { ko: 'Single Elimination', de: 'Double Elimination', rr: 'Jeder gegen jeden', groups: 'Gruppenphase mit K.-o.-Runde' };
// Turniernamen sind Nutzerdaten: im Log keine Zeilenumbrüche, damit niemand Logzeilen vortäuschen kann
const oneLine = (v) => String(v).replace(/[\u2028\u2029]/g, ' ').replace(/\n|\r/g, ' ');

// deps: Discord, settings, moduleOn, people() und events() (spät verdrahtete Module), discordPost, save, broadcast, publicUrl
module.exports = function tournamentDiscord({ Discord, settings, moduleOn, people, events, discordPost, save, broadcast, publicUrl = '' }) {
  // Turniere aller Events; Discord-Kanäle und -Ansagen gibt es nur für das laufende Event
  const allTournaments = () => (events() ? events().all().flatMap((e) => e.tournaments) : []);
  const inActiveEvent = (t) => { const e = events() && events().activeEvent(); return !!e && e.tournaments.includes(t); };

  // Aufgaben pro Turnier nacheinander im Hintergrund ausführen; Fehler blockieren das Turnier nicht.
  const queues = new Map();
  function task(t, fn) {
    if (!Discord.enabled) return Promise.resolve();
    t.discordStatus = { state: 'pending' };
    const prev = queues.get(t.id) || Promise.resolve();
    const p = prev.then(async () => {
      try {
        await fn();
        t.discordStatus = { state: 'ok', at: new Date().toISOString() };
      } catch (err) {
        console.error('Discord (%s): %s', oneLine(t.name), oneLine(err.message));
        t.discordStatus = { state: 'error', error: err.message, at: new Date().toISOString() };
      }
      if (allTournaments().includes(t)) { save(); broadcast('tournament', t.id); }
    });
    queues.set(t.id, p);
    p.finally(() => { if (queues.get(t.id) === p) queues.delete(t.id); });
    return p;
  }

  // Kanäle gibt es nur während des Events und solange das Turnier nicht beendet ist.
  // Wird bei Ausführung ausgewertet, damit immer der aktuelle Stand zählt.
  const wantsChannels = (t) => t.discordEnabled !== false && !isFinished(t) && inActiveEvent(t);
  const sync = (t, renames) => task(t, () => (wantsChannels(t) ? Discord.sync(t, renames) : Discord.remove(t)));

  // Nach Ergebnisänderungen: Kanäle löschen bzw. wiederherstellen, wenn sich "beendet" ändert.
  function afterResult(t, wasFinished) {
    if (t.discordEnabled === false) return;
    if (wasFinished !== isFinished(t)) sync(t);
  }

  // ---------- Ansagen ----------
  function announce(t, lines) {
    if (t.discordEnabled === false || !lines.length || !inActiveEvent(t)) return;
    discordPost(lines.join('\n'), (error) => {
      if ((t.announceError || null) === error) return;
      t.announceError = error;
      save();
      if (allTournaments().includes(t)) broadcast('tournament', t.id);
    }, 'tournaments', t.participants.flatMap((_, i) => playerIds(t, i))); // nur Spieler dieses Turniers anpingen
  }

  // Discord-IDs der Spieler eines Teilnehmers (Team-Mitglieder bzw. die gebundene Person, nie über den Namen)
  function playerIds(t, idx) {
    if (!settings().mentionPlayers || !people() || !moduleOn('people')) return [];
    const name = t.participants[idx];
    const team = t.members && Object.hasOwn(t.members, name) ? t.members[name] : null;
    const bound = t.playerIds && Object.hasOwn(t.playerIds, name) ? t.playerIds[name] : null;
    const ids = team || (bound ? [bound] : []);
    return ids.map((id) => people().byId(id)).filter(Boolean).map((p) => p.discordId).filter(Boolean);
  }

  function pings(t, idx) {
    const list = playerIds(t, idx).map((id) => `<@${id}>`);
    return list.length ? ` (${list.join(' ')})` : '';
  }

  const who = (t, p) => Discord.md(t.participants[p]);
  const tLink = (t) => (publicUrl ? `<${publicUrl}/#/t/${t.id}>` : '');
  const pairLine = (t, m) => `${Discord.md(m.label)}: **${who(t, m.a)}**${pings(t, m.a)} vs **${who(t, m.b)}**${pings(t, m.b)}`;
  const matchLine = (t, m) => `⚔️ ${pairLine(t, m)}`;
  const matchKey = (m) => `${m.id}:${m.a}:${m.b}`;
  const head = (t) => `**${Discord.md(t.name)}** –`;

  function resultLine(t, m) {
    const a = who(t, m.a), b = who(t, m.b);
    if (m.wo === 'both') return `${a} und ${b} sind disqualifiziert`;
    if (m.wo) return `**${who(t, m.winner)}** gewinnt kampflos gegen ${who(t, m.loser)}${m.dq ? ' (disqualifiziert)' : ''}`;
    return `${m.winner === m.a ? `**${a}**` : a} ${m.score.a} : ${m.score.b} ${m.winner === m.b ? `**${b}**` : b}`;
  }

  function podiumLines(t, view) {
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    return view.placements.filter((p) => medals[p.place]).map((p) => `${medals[p.place]} ${who(t, p.p)}`);
  }

  // Neu spielbare Begegnungen nach einer Änderung (before: Ansicht davor)
  function nextLines(t, before, after) {
    const seen = new Set(Bracket.playable(before).map(matchKey));
    const next = Bracket.playable(after).filter((x) => !seen.has(matchKey(x)));
    return next.length ? ['Als Nächstes:', ...next.map((x) => matchLine(t, x))] : [];
  }

  function announceStart(t) {
    const view = Bracket.compute(t);
    const next = Bracket.playable(view);
    announce(t, [
      `🏁 **${Discord.md(t.name)}** startet! (${TYPE_NAMES[t.type]}, ${t.participants.length} Teilnehmer)`,
      ...(next.length ? ['Jetzt spielen:', ...next.map((m) => matchLine(t, m))] : []),
      tLink(t),
    ].filter(Boolean));
  }

  // before: Ansicht vor der Änderung, matchId: das eingetragene/geänderte Spiel
  function announceResult(t, before, matchId, correction) {
    const after = Bracket.compute(t);
    const m = after.matches.find((x) => x.id === matchId);
    if (!m || m.status !== 'done') return;
    const lines = [`${head(t)} ${correction ? '✏️ Korrektur' : '✅ Ergebnis'} ${Discord.md(m.label)}: ${resultLine(t, m)}`];
    if (after.finished && (!before.finished || before.champion !== after.champion)) {
      lines.push(`🏆 **${who(t, after.champion)}** gewinnt ${Discord.md(t.name)}!${before.finished ? ' (nach Korrektur)' : ''}`, ...podiumLines(t, after), tLink(t));
    } else if (!after.finished) lines.push(...nextLines(t, before, after));
    announce(t, lines.filter(Boolean));
  }

  // Was im Turnier passiert ist (Aufrufer: lib/tournaments.js, bis Schritt 3 auch die Turnierrouten in server.js)
  return {
    // Turnier angelegt oder geändert: Kanäle abgleichen (renames: alter -> neuer Eintragsname)
    changed(t, renames) { if (t.discordEnabled !== false || t.discord) sync(t, renames); },
    removed(t) { if (t.discord) task(t, () => Discord.remove(t)); },
    started: announceStart,
    reset(t, wasFinished) { afterResult(t, wasFinished); },
    resultReported(t, { before, matchId, correction, wasFinished }) {
      afterResult(t, wasFinished);
      announceResult(t, before, matchId, correction);
    },
    resultCleared(t, m, wasFinished) {
      afterResult(t, wasFinished);
      announce(t, [`${head(t)} ↩️ Ergebnis zurückgenommen: ${Discord.md(m.label)}: ${who(t, m.a)} vs ${who(t, m.b)}`]);
    },
    // Meldung wartet auf die Gegenseite (other: Index der Gegenseite)
    resultPending(t, m, { a, b, other }) {
      announce(t, [`${head(t)} 📝 ${Discord.md(m.label)}: ${who(t, m.a)} ${a} : ${b} ${who(t, m.b)} gemeldet. **${who(t, other)}**${pings(t, other)} bitte bestätigen (sonst gilt es in ${t.confirmMinutes || 10} Minuten).`]);
    },
    // Gegenseite bestreitet (counter: abweichende eigene Meldung, falls vorhanden)
    resultDisputed(t, m, pend, counter) {
      announce(t, [counter
        ? `${head(t)} ⚠️ Ergebnis strittig: ${Discord.md(m.label)}: ${who(t, m.a)} vs ${who(t, m.b)} (${pend.a}:${pend.b} oder ${counter.a}:${counter.b}) – die Turnierleitung entscheidet.`
        : `${head(t)} ⚠️ Ergebnis bestritten: ${Discord.md(m.label)}: ${who(t, m.a)} vs ${who(t, m.b)} – die Turnierleitung entscheidet.`]);
    },
    disqualified(t, { index, on, before, wasFinished }) {
      afterResult(t, wasFinished);
      const after = Bracket.compute(t);
      const lines = [`${head(t)} ${on ? '🟥 Disqualifiziert' : '↩️ Disqualifikation aufgehoben'}: **${who(t, index)}**`];
      if (after.finished && !before.finished && after.champion !== undefined) lines.push(`🏆 **${who(t, after.champion)}** gewinnt ${Discord.md(t.name)}!`, ...podiumLines(t, after));
      else if (!after.finished) lines.push(...nextLines(t, before, after));
      announce(t, lines);
    },
    // TMT2 hat einen Server für das Spiel
    serverReady(t, m, server) {
      announce(t, [`🎮 **${Discord.md(t.name)}** – ${pairLine(t, m)}`, server ? `Server bereit: \`connect ${server}\`` : 'Server in TMT2 bereit']);
    },
    // Von Hand abgleichen (Admin): wartet auf Discord
    sync: (t) => sync(t),
    // Event beginnt/endet: Voice-Kanäle aller Turniere anlegen bzw. entfernen
    syncAll() { for (const t of allTournaments()) if (wantsChannels(t) || t.discord) sync(t); },
    // Beim Start: Kanäle beendeter Turniere bzw. außerhalb des Events entfernen
    cleanup() { for (const t of allTournaments()) if (t.discord && !wantsChannels(t)) sync(t); },
  };
};
