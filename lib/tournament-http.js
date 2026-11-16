'use strict';
// HTTP-Seite der Turniere: /api/tournaments… Übersetzt Anfragen in Operationen des Turniermoduls (lib/tournaments.js);
// geprüft und geändert wird dort, hier nur Zugang grob vorab (keine Arbeit für Unbefugte) und die Antwortform.

const Bracket = require('../public/bracket.js');

// deps: tournaments (lib/tournaments.js), HttpError, str, http: send, readBody, isAdmin(req), account(req),
// requireUser(req), rateLimit(req, …), event(), personFor(account) (Person des Kontos, legt sie bei Bedarf an),
// personOf(account) (nur nachsehen, legt nichts an)
module.exports = function tournamentHttp({ tournaments, HttpError, str, http }) {
  // Aktionen der Selbstverwaltung im Web. who.me darf die eigene Person anlegen, who.existing sieht nur nach.
  const SIGNUP_ACTIONS = {
    join: (ops, t, who) => ops.join(who.me, t),
    leave: (ops, t, who) => ops.leave(who.existing, t),
    found: (ops, t, who, body) => ops.foundTeam(who.me, t, str(body.name, Bracket.NAME_MAX)),
    request: (ops, t, who, body) => ops.requestJoin(who.me, t, str(body.team, Bracket.NAME_MAX)),
    cancel: (ops, t, who) => ops.cancelRequest(who.me, t),
    accept: (ops, t, who, body) => ops.answerRequest(who.me, t, who.person(body), true),
    decline: (ops, t, who, body) => ops.answerRequest(who.me, t, who.person(body), false),
    'leave-team': (ops, t, who) => ops.leaveTeam(who.me, t),
    dissolve: (ops, t, who) => ops.dissolveTeam(who.me, t),
    rename: (ops, t, who, body) => ops.renameTeam(who.me, t, str(body.name, Bracket.NAME_MAX)),
    remove: (ops, t, who, body) => ops.removeMember(who.me, t, who.person(body)),
  };
  // Antwort ohne Personenobjekte (keine Discord-IDs oder Notizen nach außen)
  const signupResult = (r = {}) => ({ ok: true, team: typeof r.team === 'string' ? r.team : undefined,
    notSignedUp: r.notSignedUp || undefined, notInTeam: r.notInTeam || undefined, dissolved: r.dissolved || undefined, already: r.already || undefined });
  // Übersetzt Anfragen in Operationen. Vor dem Lesen des Bodys wird grob geprüft (keine Arbeit für Unbefugte),
  // danach prüft die Operation mit dem dann aktuellen Akteur vollständig.
  async function routes(req, res, parts, method) {
    if (parts[0] !== 'tournaments') return false;
    const reply = (status, data) => { http.send(res, status, data); return true; };
    const actor = () => { const a = http.account(req); return { admin: http.isAdmin(req), discordId: a ? a.id : null }; };
    const adminFirst = () => { if (!http.isAdmin(req)) throw new HttpError(401, 'Admin-Login erforderlich'); };
    const ops = tournaments.of(http.event());

    // Webseite „Meine Turniere“: Übersicht für das angemeldete Konto (ohne Login nur der Hinweis)
    if (parts[1] === 'signup' && parts.length === 2 && method === 'GET') {
      const a = http.account(req);
      if (!a) return reply(200, { loggedIn: false, coins: ops.coins(null) });
      return reply(200, { loggedIn: true, ...ops.signupView({ discordId: a.id }) });
    }
    if (parts.length === 1) {
      if (method === 'GET') return reply(200, ops.overview(actor()));
      if (method === 'POST') { adminFirst(); const body = await http.readBody(req); return reply(201, ops.create(actor(), body)); }
      throw new HttpError(404, 'Turnier nicht gefunden');
    }
    const t = http.event().tournaments.find((x) => x.id === parts[1]);
    if (!t) throw new HttpError(404, 'Turnier nicht gefunden');

    if (parts.length === 2) {
      if (method === 'GET') return reply(200, ops.show(actor(), t));
      if (method === 'PUT') { adminFirst(); const body = await http.readBody(req); return reply(200, ops.update(actor(), t, body)); }
      if (method === 'DELETE') { adminFirst(); ops.remove(actor(), t); return reply(200, { ok: true }); }
    }
    if (method === 'POST' && parts.length === 3) {
      const action = parts[2];
      if (action === 'disqualify') {
        if (!tournaments.canManage(actor(), t)) throw new HttpError(403, 'Nur Orga oder Turnierleitung');
        const body = await http.readBody(req);
        ops.disqualify(actor(), t, body.index, body.on);
        return reply(200, ops.present(actor(), t));
      }
      if (['start', 'duplicate', 'discord', 'reset', 'draw-teams'].includes(action)) {
        adminFirst();
        if (action === 'duplicate') return reply(201, ops.duplicate(actor(), t));
        if (action === 'discord') return reply(200, await ops.syncDiscord(actor(), t));
        if (action === 'reset') return reply(200, ops.reset(actor(), t));
        const body = await http.readBody(req);
        return reply(200, action === 'start' ? ops.start(actor(), t, body) : ops.drawTeams(actor(), t, body));
      }
    }

    // Selbstverwaltung im Web: /api/tournaments/:id/signup/<aktion> (nur angemeldete Konten, gleiche Regeln wie Discord)
    if (parts[2] === 'signup' && parts.length === 4 && method === 'POST') {
      const action = parts[3];
      if (!Object.hasOwn(SIGNUP_ACTIONS, action)) throw new HttpError(404, 'Nicht gefunden');
      http.rateLimit(req, 'signup', 40, 60000);
      http.requireUser(req);
      const body = await http.readBody(req);
      const a = http.requireUser(req); // nach dem Lesen erneut: Sitzung kann inzwischen beendet sein
      const who = {
        me: { discordId: a.id, person: () => http.personFor(a) },
        existing: { discordId: a.id, person: () => http.personOf(a) },
        person: (b) => (typeof b.person === 'string' ? b.person.slice(0, 40) : ''), // Personen-ID aus dem Body
      };
      const result = SIGNUP_ACTIONS[action](ops, t, who, body);
      return reply(200, { ...signupResult(result || undefined), view: ops.signupView({ discordId: a.id }) });
    }
    // Orga: Teams auch im laufenden Turnier bearbeiten
    if (parts[2] === 'team-admin' && parts.length === 3 && method === 'POST') {
      adminFirst();
      const body = await http.readBody(req);
      return reply(200, ops.teamAdmin(actor(), t, body));
    }

    // /api/tournaments/:id/matches/:mid[/confirm|/dispute|/forfeit|/playing]
    if (parts[2] === 'matches' && parts[3] && parts.length <= 5) {
      // Methode und Zugang vor der Spielplanberechnung prüfen, damit anonyme oder unzulässige Anfragen
      // keine vollständige Berechnung auslösen.
      const action = parts[4] || '';
      if (!['', 'confirm', 'dispute', 'forfeit', 'playing'].includes(action)) throw new HttpError(404, 'Nicht gefunden');
      if (action ? method !== 'POST' : (method !== 'POST' && method !== 'DELETE')) throw new HttpError(405, 'Methode nicht erlaubt');
      if (!http.isAdmin(req)) { http.rateLimit(req, 'result', 30, 60000); http.requireUser(req); }
      if ((method === 'DELETE' || action === 'forfeit') && !tournaments.canManage(actor(), t)) throw new HttpError(401, 'Nur Orga oder Turnierleitung');
      // Erst den vollständigen Body abwarten, danach den aktuellen Zustand atomar prüfen/ändern.
      const body = method === 'POST' ? await http.readBody(req) : null;
      const me = actor();
      if (method === 'DELETE') ops.clearResult(me, t, parts[3]);
      else if (action === 'playing') ops.setPlaying(me, t, parts[3], body.on);
      else if (action === 'forfeit') ops.forfeit(me, t, parts[3], body.side);
      else if (action === 'confirm') ops.confirmResult(me, t, parts[3]);
      else if (action === 'dispute') ops.disputeResult(me, t, parts[3]);
      else ops.reportResult(me, t, parts[3], { a: body.a, b: body.b });
      return reply(200, ops.present(actor(), t));
    }
    throw new HttpError(404, 'Nicht gefunden');
  }

  return { routes };
};
