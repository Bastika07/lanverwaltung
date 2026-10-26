// Gemeinsame Turnierlogik – wird vom Server (Validierung) und vom Browser (Darstellung) genutzt.
// Alles wird deterministisch aus { participants, order, results } berechnet, dadurch
// "wandern" Gewinner automatisch weiter, sobald ein Ergebnis eingetragen wird.
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

  function newMatch(id, round, index) {
    return { id, round, index, a: undefined, b: undefined, score: null, winner: undefined, loser: undefined, status: 'pending' };
  }

  // Seitenwerte: Teilnehmer-Index = bekannt, undefined = steht noch nicht fest, null = Freilos.
  // Freilose werden automatisch aufgelöst: der Gegner kommt kampflos weiter, es gibt keinen Verlierer.
  // Ein Ergebnis zählt nur, wenn es zu den aktuellen Paarungen passt (sonst ist es veraltet).
  function resolve(m, results) {
    if (m.a === null && m.b === null) {
      m.status = 'bye'; m.winner = null; m.loser = null;
    } else if (m.a === null && m.b !== undefined) {
      m.status = 'bye'; m.winner = m.b; m.loser = null;
    } else if (m.b === null && m.a !== undefined) {
      m.status = 'bye'; m.winner = m.a; m.loser = null;
    } else if (m.a !== undefined && m.b !== undefined) {
      m.status = 'ready';
      const r = results[m.id];
      if (!r || r.pa !== m.a || r.pb !== m.b) return m;
      m.score = { a: r.a, b: r.b };
      m.status = 'done';
      if (r.a > r.b) { m.winner = m.a; m.loser = m.b; }
      else if (r.b > r.a) { m.winner = m.b; m.loser = m.a; }
      else m.draw = true;
    }
    return m;
  }

  function startSlots(t) {
    const n = t.order.length;
    const size = Math.max(2, nextPow2(n));
    return { size, slots: seedOrder(size).map((s) => (s <= n ? t.order[s - 1] : null)) };
  }

  // Gewinnerbaum (auch für Single Elimination)
  function buildWinners(slots, size, results) {
    const totalRounds = Math.log2(size);
    const rounds = [];
    for (let r = 0; r < totalRounds; r++) {
      const list = [];
      for (let i = 0; i < size / Math.pow(2, r + 1); i++) {
        const m = newMatch('r' + r + 'm' + i, r, i);
        if (r === 0) { m.a = slots[2 * i]; m.b = slots[2 * i + 1]; }
        else { m.a = rounds[r - 1][2 * i].winner; m.b = rounds[r - 1][2 * i + 1].winner; }
        list.push(resolve(m, results));
      }
      rounds.push(list);
    }
    return rounds;
  }

  const real = (p) => p !== undefined && p !== null;

  // Single Elimination
  function computeKO(t) {
    const { size, slots } = startSlots(t);
    const totalRounds = Math.log2(size);
    const results = t.results || {};
    const rounds = buildWinners(slots, size, results);

    let third = null;
    if (t.thirdPlace && totalRounds >= 2) {
      const semis = rounds[totalRounds - 2];
      third = newMatch('p3', totalRounds - 1, 1);
      third.a = semis[0].loser;
      third.b = semis[1].loser;
      resolve(third, results);
    }

    const final = rounds[totalRounds - 1][0];
    const placements = [];
    if (final.status === 'done') {
      placements.push({ place: 1, p: final.winner }, { place: 2, p: final.loser });
      if (third && third.status === 'done') {
        placements.push({ place: 3, p: third.winner }, { place: 4, p: third.loser });
      } else if (third && real(third.winner)) {
        placements.push({ place: 3, p: third.winner });
      } else if (!third && totalRounds >= 2) {
        for (const s of rounds[totalRounds - 2]) if (real(s.loser)) placements.push({ place: 3, p: s.loser });
      }
    }
    const finished = final.status === 'done' && (!third || third.status !== 'ready');

    return {
      type: 'ko', size, totalRounds,
      roundNames: rounds.map((_, r) => roundName(r, totalRounds)),
      rounds, third, matches: rounds.flat().concat(third ? [third] : []),
      champion: finished ? final.winner : undefined,
      placements: finished ? placements : [],
      finished,
    };
  }

  // Double Elimination: Gewinnerbaum, Verliererbaum, Grand Final (optional mit Reset)
  function computeDE(t) {
    const { size, slots } = startSlots(t);
    const k = Math.log2(size);
    const results = t.results || {};
    const wb = buildWinners(slots, size, results);
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
        list.push(resolve(m, results));
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
    resolve(gf1, results);

    let gf2 = null;
    if (t.gfReset !== false) {
      gf2 = newMatch('gf2', 1, 0);
      if (gf1.status === 'done') {
        if (gf1.winner === gf1.a) gf2.status = 'skip';
        else { gf2.a = gf1.a; gf2.b = gf1.b; resolve(gf2, results); }
      }
    }

    let champion, second;
    if (gf1.status === 'bye') { champion = gf1.winner; }
    else if (gf1.status === 'done' && (!gf2 || gf2.status === 'skip')) { champion = gf1.winner; second = gf1.loser; }
    else if (gf2 && gf2.status === 'done') { champion = gf2.winner; second = gf2.loser; }
    const finished = champion !== undefined;

    const placements = [];
    if (finished) {
      placements.push({ place: 1, p: champion });
      if (real(second)) placements.push({ place: 2, p: second });
      if (lbFinal && real(lbFinal.loser)) placements.push({ place: 3, p: lbFinal.loser });
    }

    const finals = [gf1].concat(gf2 ? [gf2] : []);
    return {
      type: 'de', size, totalRounds: k,
      rounds: wb, roundNames: wbNames,
      losers: lb, loserNames: lbNames,
      finals, finalNames: gf2 ? ['Grand Final', 'Grand Final – Reset'] : ['Grand Final'],
      matches: wb.flat().concat(lb.flat(), finals),
      champion: finished ? champion : undefined,
      placements,
      finished,
    };
  }

  // Jeder gegen jeden (Rundenturnier, Kreis-Methode)
  function computeRR(t) {
    const ids = t.order.slice();
    if (ids.length % 2 === 1) ids.push(null);
    const n = ids.length;
    const results = t.results || {};
    const rounds = [];
    let arr = ids.slice();
    for (let r = 0; r < n - 1; r++) {
      const list = [];
      for (let i = 0; i < n / 2; i++) {
        let a = arr[i], b = arr[n - 1 - i];
        if (a === null || b === null) continue;
        if (r % 2 === 1 && i === 0) { const x = a; a = b; b = x; }
        const m = newMatch('g' + r + 'm' + i, r, list.length);
        m.a = a; m.b = b;
        resolve(m, results);
        list.push(m);
      }
      rounds.push(list);
      arr = [arr[0], arr[n - 1]].concat(arr.slice(1, n - 1));
    }
    const matches = rounds.flat();

    const table = {};
    for (const p of t.order) table[p] = { p, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
    for (const m of matches) {
      if (m.status !== 'done') continue;
      const A = table[m.a], B = table[m.b];
      A.played++; B.played++;
      A.gf += m.score.a; A.ga += m.score.b;
      B.gf += m.score.b; B.ga += m.score.a;
      if (m.draw) { A.d++; B.d++; A.pts += 1; B.pts += 1; }
      else if (m.winner === m.a) { A.w++; B.l++; A.pts += 3; }
      else { B.w++; A.l++; B.pts += 3; }
    }
    const names = t.participants;
    const standings = Object.values(table).sort((x, y) =>
      y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || String(names[x.p]).localeCompare(String(names[y.p])));
    standings.forEach((s, i) => { s.place = i + 1; });

    const finished = matches.length > 0 && matches.every((m) => m.status === 'done');
    return {
      type: 'rr', rounds, matches,
      roundNames: rounds.map((_, r) => 'Spieltag ' + (r + 1)),
      standings, finished,
      champion: finished ? standings[0].p : undefined,
      placements: finished ? standings.slice(0, 3).map((s) => ({ place: s.place, p: s.p })) : [],
    };
  }

  // Rundenname an jedes Spiel hängen (für Listen und Ansagen)
  function addLabels(view) {
    const set = (rounds, names) => rounds.forEach((list, r) => list.forEach((m) => { m.label = names[r]; }));
    set(view.rounds, view.roundNames);
    if (view.third) view.third.label = 'Spiel um Platz 3';
    if (view.type === 'de') {
      set(view.losers, view.loserNames);
      view.finals.forEach((m, i) => { m.label = view.finalNames[i]; });
    }
    return view;
  }

  function compute(t) {
    if (!t.order || t.order.length < 2) return null;
    if (t.type === 'rr') return addLabels(computeRR(t));
    if (t.type === 'de') return addLabels(computeDE(t));
    return addLabels(computeKO(t));
  }

  // Spiele, die jetzt gespielt werden können. Bei "Jeder gegen jeden" nur der aktuelle
  // Spieltag, damit nicht alle Paarungen auf einmal erscheinen.
  function playable(view) {
    if (!view || view.finished) return [];
    if (view.type === 'rr') {
      const current = view.rounds.find((list) => list.some((m) => m.status !== 'done'));
      return current ? current.filter((m) => m.status === 'ready') : [];
    }
    return view.matches.filter((m) => m.status === 'ready');
  }

  return { compute, playable, nextPow2, seedOrder };
});
