// Gemeinsame Turnierlogik – wird vom Server (Validierung) und vom Browser (Darstellung) genutzt.
// Alles wird deterministisch aus { participants, order, results } berechnet, dadurch
// "wandern" Gewinner automatisch weiter, sobald ein Ergebnis eingetragen wird.
// Dazu kommen Disqualifikationen (disqualified), offene Meldungen (pending) und laufende Spiele (playing).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bracket = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function nextPow2(n) {
    let s = 1;
    while (s < n) s *= 2;
    return s;
  }

  // Klassische Setzreihenfolge (1 vs 16, 8 vs 9, ...), damit Freilose an die Topgesetzten gehen.
  function seedOrder(size) {
    let order = [1];
    while (order.length < size) {
      const len = order.length * 2;
      const next = [];
      for (const s of order) next.push(s, len + 1 - s);
      order = next;
    }
    return order;
  }

  function roundName(round, totalRounds) {
    const fromEnd = totalRounds - round;
    if (fromEnd === 1) return 'Finale';
    if (fromEnd === 2) return 'Halbfinale';
    if (fromEnd === 3) return 'Viertelfinale';
    if (fromEnd === 4) return 'Achtelfinale';
    return 'Runde ' + (round + 1);
  }

  const GROUP_NAMES = 'ABCDEFGHIJKLMNOP';

  function newMatch(id, round, index) {
    return { id, round, index, a: undefined, b: undefined, score: null, winner: undefined, loser: undefined, status: 'pending' };
  }

  // Zustand, gegen den Spiele aufgelöst werden
  function context(t) {
    return {
      results: t.results || {}, pending: t.pending || {}, playing: t.playing || {},
      dq: new Set((t.disqualified || []).filter(Number.isInteger)),
    };
  }
  const fits = (x, m) => !!x && x.pa === m.a && x.pb === m.b;

  // Seitenwerte: Teilnehmer-Index = bekannt, undefined = steht noch nicht fest, null = Freilos.
  // Freilose werden automatisch aufgelöst: der Gegner kommt kampflos weiter, es gibt keinen Verlierer.
  // Ein Ergebnis zählt nur, wenn es zu den aktuellen Paarungen passt (sonst ist es veraltet).
  // Kampflos (wo = Seite, die verliert): von der Orga gewertet oder weil ein Teilnehmer disqualifiziert ist.
  function resolve(m, ctx) {
    if (m.a === null && m.b === null) {
      m.status = 'bye'; m.winner = null; m.loser = null;
    } else if (m.a === null && m.b !== undefined) {
      m.status = 'bye'; m.winner = m.b; m.loser = null;
    } else if (m.b === null && m.a !== undefined) {
      m.status = 'bye'; m.winner = m.a; m.loser = null;
    } else if (m.a !== undefined && m.b !== undefined) {
      m.status = 'ready';
      const r = ctx.results[m.id];
      const dqA = ctx.dq.has(m.a), dqB = ctx.dq.has(m.b);
      if (fits(r, m)) {
        m.status = 'done';
        if (Array.isArray(r.maps)) m.maps = r.maps; // Rundenstände je Map (aus TMT2)
        if (r.wo === 'a' || r.wo === 'b') return forfeit(m, r.wo, false);
        m.score = { a: r.a, b: r.b };
        if (r.a > r.b) { m.winner = m.a; m.loser = m.b; }
        else if (r.b > r.a) { m.winner = m.b; m.loser = m.a; }
        else m.draw = true;
      } else if (dqA && dqB) {
        m.status = 'done'; m.wo = 'both'; m.dq = true; m.winner = null; m.loser = null;
      } else if (dqA || dqB) {
        m.status = 'done';
        forfeit(m, dqA ? 'a' : 'b', true);
      } else {
        const p = ctx.pending[m.id];
        if (fits(p, m)) m.pending = { a: p.a, b: p.b, by: p.by, at: p.at, disputed: !!p.disputed };
        const g = ctx.playing[m.id];
        if (fits(g, m)) { m.playing = true; m.playingSince = g.at; }
      }
    }
    return m;
  }

  function forfeit(m, side, dq) {
    m.wo = side; m.dq = dq;
    m.winner = side === 'a' ? m.b : m.a;
    m.loser = side === 'a' ? m.a : m.b;
    return m;
  }

  function startSlots(t) {
    const n = t.order.length;
    const size = Math.max(2, nextPow2(n));
    return { size, slots: seedOrder(size).map((s) => (s <= n ? t.order[s - 1] : null)) };
  }

  // Gewinnerbaum (auch für Single Elimination). hints: Platzhaltertexte für die erste Runde (Gruppenphase).
  function buildWinners(slots, size, ctx, prefix = '', hints = []) {
    const totalRounds = Math.log2(size);
    const rounds = [];
    for (let r = 0; r < totalRounds; r++) {
      const list = [];
      for (let i = 0; i < size / Math.pow(2, r + 1); i++) {
        const m = newMatch(prefix + 'r' + r + 'm' + i, r, i);
        if (r === 0) { m.a = slots[2 * i]; m.b = slots[2 * i + 1]; m.hintA = hints[2 * i]; m.hintB = hints[2 * i + 1]; }
        else { m.a = rounds[r - 1][2 * i].winner; m.b = rounds[r - 1][2 * i + 1].winner; }
        list.push(resolve(m, ctx));
      }
      rounds.push(list);
    }
    return rounds;
  }

  const real = (p) => p !== undefined && p !== null;

  // Single Elimination. opts: vorgegebene Startplätze (Gruppenphase) mit Präfix für die Spiel-IDs.
  function computeKO(t, opts = {}) {
    const { size, slots } = opts.slots ? opts : startSlots(t);
    const prefix = opts.prefix || '';
    const totalRounds = Math.log2(size);
    const ctx = context(t);
    const rounds = buildWinners(slots, size, ctx, prefix, opts.hints);

    let third = null;
    if (t.thirdPlace && totalRounds >= 2) {
      const semis = rounds[totalRounds - 2];
      third = newMatch(prefix + 'p3', totalRounds - 1, 1);
      third.a = semis[0].loser;
      third.b = semis[1].loser;
      resolve(third, ctx);
    }

    const final = rounds[totalRounds - 1][0];
    const placements = [];
    if (final.status === 'done' && real(final.winner)) {
      placements.push({ place: 1, p: final.winner });
      if (real(final.loser)) placements.push({ place: 2, p: final.loser });
      if (third && third.status === 'done') {
        if (real(third.winner)) placements.push({ place: 3, p: third.winner });
        if (real(third.loser)) placements.push({ place: 4, p: third.loser });
      } else if (third && real(third.winner)) {
        placements.push({ place: 3, p: third.winner });
      } else if (!third && totalRounds >= 2) {
        for (const s of rounds[totalRounds - 2]) if (real(s.loser)) placements.push({ place: 3, p: s.loser });
      }
    }
    const decided = (final.status === 'done' || final.status === 'bye') && final.winner !== undefined;
    const finished = decided && (!third || third.status !== 'ready');

    // Vollständiger Endstand: Wer in Runde r ausscheidet, teilt sich Platz size/2^(r+1)+1
    const ranking = [];
    if (finished) {
      const placed = new Set(placements.map((x) => x.p));
      ranking.push(...placements);
      for (let r = totalRounds - 2; r >= 0; r--) {
        for (const m of rounds[r]) {
          if (real(m.loser) && !placed.has(m.loser)) { ranking.push({ place: size / Math.pow(2, r + 1) + 1, p: m.loser }); placed.add(m.loser); }
        }
      }
    }

    return {
      type: 'ko', size, totalRounds,
      roundNames: rounds.map((_, r) => roundName(r, totalRounds)),
      rounds, third, matches: rounds.flat().concat(third ? [third] : []),
      champion: finished && real(final.winner) ? final.winner : undefined,
      placements: finished ? placements : [],
      ranking,
      finished,
    };
  }

  // Double Elimination: Gewinnerbaum, Verliererbaum, Grand Final (optional mit Reset)
  function computeDE(t) {
    const { size, slots } = startSlots(t);
    const k = Math.log2(size);
    const ctx = context(t);
    const wb = buildWinners(slots, size, ctx);
    const wbNames = wb.map((_, r) => (r === k - 1 ? 'Finale Gewinnerrunde' : 'Gewinnerrunde ' + (r + 1)));

    // Verliererbaum: 2(k-1) Runden. Gerade Runden spielen Verliererbaum-Gewinner gegeneinander,
    // ungerade Runden nehmen die Verlierer der nächsten Gewinnerrunde auf.
    const lb = [];
    const lbRounds = 2 * (k - 1);
    for (let r = 0; r < lbRounds; r++) {
      const list = [];
      const count = size / Math.pow(2, Math.floor(r / 2) + 2);
      for (let i = 0; i < count; i++) {
        const m = newMatch('l' + r + 'm' + i, r, i);
        if (r === 0) {
          m.a = wb[0][2 * i].loser; m.b = wb[0][2 * i + 1].loser;
          m.hintA = 'Verlierer ' + wbNames[0] + ' #' + (2 * i + 1);
          m.hintB = 'Verlierer ' + wbNames[0] + ' #' + (2 * i + 2);
        } else if (r % 2 === 1) {
          const j = (r + 1) / 2; // aufnehmende Gewinnerrunde
          // abwechselnd gespiegelt, damit sich Paarungen nicht sofort wiederholen
          const wi = j % 2 === 1 ? count - 1 - i : i;
          m.a = lb[r - 1][i].winner;
          m.b = wb[j][wi].loser;
          m.hintB = 'Verlierer ' + wbNames[j] + (wb[j].length > 1 ? ' #' + (wi + 1) : '');
        } else {
          m.a = lb[r - 1][2 * i].winner; m.b = lb[r - 1][2 * i + 1].winner;
        }
        list.push(resolve(m, ctx));
      }
      lb.push(list);
    }
    const lbNames = lb.map((_, r) => (r === lbRounds - 1 ? 'Finale Verliererrunde' : 'Verliererrunde ' + (r + 1)));

    const wbFinal = wb[k - 1][0];
    const lbFinal = lbRounds ? lb[lbRounds - 1][0] : null;
    const gf1 = newMatch('gf1', 0, 0);
    gf1.a = wbFinal.winner;
    gf1.b = lbFinal ? lbFinal.winner : wbFinal.loser;
    gf1.hintA = 'Sieger Gewinnerrunde';
    gf1.hintB = 'Sieger Verliererrunde';
    resolve(gf1, ctx);

    let gf2 = null;
    if (t.gfReset !== false) {
      gf2 = newMatch('gf2', 1, 0);
      if (gf1.status === 'done') {
        if (gf1.winner === gf1.a || gf1.wo) gf2.status = 'skip'; // kampflos: keine zweite Chance
        else { gf2.a = gf1.a; gf2.b = gf1.b; resolve(gf2, ctx); }
      }
    }

    let champion, second;
    if (gf1.status === 'bye') { champion = gf1.winner; }
    else if (gf1.status === 'done' && (!gf2 || gf2.status === 'skip')) { champion = gf1.winner; second = gf1.loser; }
    else if (gf2 && gf2.status === 'done') { champion = gf2.winner; second = gf2.loser; }
    const finished = champion !== undefined;

    const placements = [];
    if (finished && real(champion)) {
      placements.push({ place: 1, p: champion });
      if (real(second)) placements.push({ place: 2, p: second });
      if (lbFinal && real(lbFinal.loser)) placements.push({ place: 3, p: lbFinal.loser });
    }
    // Endstand: Ausgeschiedene im Verliererbaum, spätere Runden zuerst
    const ranking = [];
    if (finished) {
      const placed = new Set(placements.map((x) => x.p));
      ranking.push(...placements);
      let place = 3 + (lbFinal ? 1 : 0);
      for (let r = lbRounds - 2; r >= 0; r--) {
        for (const m of lb[r]) if (real(m.loser) && !placed.has(m.loser)) { ranking.push({ place, p: m.loser }); placed.add(m.loser); }
        place += lb[r].length;
      }
    }

    const finals = [gf1].concat(gf2 ? [gf2] : []);
    return {
      type: 'de', size, totalRounds: k,
      rounds: wb, roundNames: wbNames,
      losers: lb, loserNames: lbNames,
      finals, finalNames: gf2 ? ['Grand Final', 'Grand Final – Reset'] : ['Grand Final'],
      matches: wb.flat().concat(lb.flat(), finals),
      champion: finished && real(champion) ? champion : undefined,
      placements, ranking,
      finished,
    };
  }

  // Jeder gegen jeden (Rundenturnier, Kreis-Methode). prefix: Spiel-IDs einer Gruppe.
  function computeRR(t, prefix = '') {
    const ids = t.order.slice();
    if (ids.length % 2 === 1) ids.push(null);
    const n = ids.length;
    const ctx = context(t);
    const rounds = [];
    let arr = ids.slice();
    for (let r = 0; r < n - 1; r++) {
      const list = [];
      for (let i = 0; i < n / 2; i++) {
        let a = arr[i], b = arr[n - 1 - i];
        if (a === null || b === null) continue;
        if (r % 2 === 1 && i === 0) { const x = a; a = b; b = x; }
        const m = newMatch(prefix + 'g' + r + 'm' + i, r, list.length);
        m.a = a; m.b = b;
        resolve(m, ctx);
        list.push(m);
      }
      rounds.push(list);
      arr = [arr[0], arr[n - 1]].concat(arr.slice(1, n - 1));
    }
    const matches = rounds.flat();

    const table = {};
    for (const p of t.order) table[p] = { p, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, dq: ctx.dq.has(p) };
    for (const m of matches) {
      if (m.status !== 'done' || m.wo === 'both') continue;
      const A = table[m.a], B = table[m.b];
      A.played++; B.played++;
      if (m.score) {
        A.gf += m.score.a; A.ga += m.score.b;
        B.gf += m.score.b; B.ga += m.score.a;
      }
      if (m.draw) { A.d++; B.d++; A.pts += 1; B.pts += 1; }
      else if (m.winner === m.a) { A.w++; B.l++; A.pts += 3; }
      else { B.w++; A.l++; B.pts += 3; }
    }
    const names = t.participants;
    const standings = Object.values(table).sort((x, y) =>
      x.dq - y.dq || y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || String(names[x.p]).localeCompare(String(names[y.p])));
    standings.forEach((s, i) => { s.place = i + 1; });

    const finished = matches.every((m) => m.status === 'done') && (matches.length > 0 || t.order.length === 1);
    return {
      type: 'rr', rounds, matches,
      roundNames: rounds.map((_, r) => 'Spieltag ' + (r + 1)),
      standings, finished,
      champion: finished ? standings[0].p : undefined,
      placements: finished ? standings.slice(0, 3).map((s) => ({ place: s.place, p: s.p })) : [],
      ranking: finished ? standings.map((s) => ({ place: s.place, p: s.p })) : [],
    };
  }

  // Gruppenphase und K.-o.-Runde. t.groups = { count, advance }.
  // Verteilung nach Setzliste im Schlangenmuster (A B C D D C B A …), damit jede Gruppe gleich stark ist.
  function groupSplit(order, count) {
    const groups = Array.from({ length: count }, () => []);
    order.forEach((p, i) => {
      const row = Math.floor(i / count), col = i % count;
      groups[row % 2 === 0 ? col : count - 1 - col].push(p);
    });
    return groups;
  }

  // Setzplätze der K.-o.-Runde: Gruppenerste 1…G. Bei zwei Weiterkommenden trifft der Erste einer Gruppe
  // auf den Zweiten der Gruppe, die eine halbe Runde weiter liegt (Gruppenzweiter landet in der anderen Baumhälfte).
  function qualifierSeeds(count, advance) {
    const seeds = [];
    for (let g = 0; g < count; g++) seeds[g] = { g, place: 0 };
    if (advance === 2) {
      for (let s = 1; s <= count; s++) seeds[2 * count - s] = { g: (s - 1 + Math.floor(count / 2)) % count, place: 1 };
    } else {
      for (let place = 1; place < advance; place++) {
        for (let i = 0; i < count; i++) seeds[place * count + i] = { g: place % 2 ? count - 1 - i : i, place };
      }
    }
    return seeds;
  }

  function computeGroups(t) {
    const n = t.order.length;
    const cfg = t.groups || {};
    const count = Math.min(Math.max(Math.floor(cfg.count) || 2, 1), Math.max(1, Math.floor(n / 2)), GROUP_NAMES.length);
    const parts = groupSplit(t.order, count);
    const advance = Math.min(Math.max(Math.floor(cfg.advance) || 2, 1), Math.min(...parts.map((p) => p.length)));
    const groups = parts.map((ids, g) => {
      const v = computeRR({ ...t, order: ids }, 'G' + g);
      v.name = 'Gruppe ' + GROUP_NAMES[g];
      v.advance = advance;
      return v;
    });

    const seeds = qualifierSeeds(count, advance);
    const q = seeds.length;
    const size = Math.max(2, nextPow2(q));
    const order = seedOrder(size);
    const slots = [], hints = [];
    for (const s of order) {
      if (s > q) { slots.push(null); hints.push(undefined); continue; }
      const { g, place } = seeds[s - 1];
      slots.push(groups[g].finished ? groups[g].standings[place].p : undefined);
      hints.push((place + 1) + '. ' + groups[g].name);
    }
    const ko = computeKO(t, { size, slots, hints, prefix: 'k' });

    // Endstand: K.-o.-Runde, danach die Ausgeschiedenen der Gruppen (nach Gruppenplatz, Punkten, Differenz)
    let ranking = [];
    if (ko.finished) {
      ranking = ko.ranking.slice();
      const out = groups.flatMap((gv) => gv.standings.slice(advance)).sort((x, y) =>
        x.place - y.place || y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
      out.forEach((s, i) => ranking.push({ place: q + 1 + i, p: s.p }));
    }

    return {
      type: 'groups', groups, ko, advance,
      // Für Darstellung und Spiele-Listen wie ein K.-o.-Baum
      rounds: ko.rounds, roundNames: ko.roundNames, third: ko.third, totalRounds: ko.totalRounds, size: ko.size,
      matches: groups.flatMap((gv) => gv.matches).concat(ko.matches),
      champion: ko.champion, placements: ko.placements, ranking,
      finished: ko.finished,
    };
  }

  // Rundenname und Rundenschlüssel an jedes Spiel hängen (für Listen, Ansagen und Rundenzeiten)
  function addLabels(view) {
    const list = [];
    const set = (rounds, names, key, pre = '') => rounds.forEach((ms, r) => {
      if (!list.some((x) => x.key === key + r)) list.push({ key: key + r, label: names[r] });
      ms.forEach((m) => { m.label = pre + names[r]; m.roundKey = key + r; });
    });
    if (view.type === 'groups') {
      view.groups.forEach((g) => g.rounds.forEach((ms, r) => ms.forEach((m) => { m.label = g.name + ' · ' + g.roundNames[r]; m.roundKey = 'gd' + r; })));
      const days = Math.max(0, ...view.groups.map((g) => g.rounds.length));
      for (let r = 0; r < days; r++) list.push({ key: 'gd' + r, label: 'Gruppen · Spieltag ' + (r + 1) });
      set(view.rounds, view.roundNames, 'kr');
    } else set(view.rounds, view.roundNames, view.type === 'rr' ? 'g' : view.type === 'de' ? 'w' : 'r');
    if (view.third) { view.third.label = 'Spiel um Platz 3'; view.third.roundKey = view.type === 'groups' ? 'kp3' : 'p3'; list.push({ key: view.third.roundKey, label: 'Spiel um Platz 3' }); }
    if (view.type === 'de') {
      set(view.losers, view.loserNames, 'l');
      view.finals.forEach((m, i) => { m.label = view.finalNames[i]; m.roundKey = 'gf' + (i + 1); list.push({ key: m.roundKey, label: m.label }); });
    }
    view.roundList = list;
    return view;
  }

  function compute(t) {
    if (!t.order || t.order.length < 2) return null;
    if (t.type === 'rr') return addLabels(computeRR(t));
    if (t.type === 'de') return addLabels(computeDE(t));
    if (t.type === 'groups') return addLabels(computeGroups(t));
    return addLabels(computeKO(t));
  }

  // Aktueller Spieltag eines Rundenturniers
  const currentDay = (rr) => {
    const current = rr.rounds.find((list) => list.some((m) => m.status !== 'done'));
    return current ? current.filter((m) => m.status === 'ready') : [];
  };

  // Spiele, die jetzt gespielt werden können. Bei "Jeder gegen jeden" nur der aktuelle
  // Spieltag, damit nicht alle Paarungen auf einmal erscheinen.
  function playable(view) {
    if (!view || view.finished) return [];
    if (view.type === 'rr') return currentDay(view);
    if (view.type === 'groups') return view.groups.flatMap(currentDay).concat(view.ko.matches.filter((m) => m.status === 'ready'));
    return view.matches.filter((m) => m.status === 'ready');
  }

  return { compute, playable, nextPow2, seedOrder, groupSplit, GROUP_NAMES };
});
