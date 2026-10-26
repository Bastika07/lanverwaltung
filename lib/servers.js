'use strict';
// Gastserver: Teilnehmer mit Ticket melden eigene Server an (Name, Beschreibung, Wunsch nach Reverse-DNS)
// und bekommen sofort die nächste freie IP aus dem Pool des Events und den FQDN <name>.<domain>.
// Die DNS-Einträge trägt die Orga ein – dafür gibt es einen Export als Zonendatei-Zeilen und als CSV.
// Pro Event: event.serverConfig (Domain, IP-Bereich, offen, Höchstzahl) und event.guestServers.

const crypto = require('crypto');

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/; // ein DNS-Label nach RFC 1123
const DOMAIN_RE = /^(?=.{1,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const ipToInt = (ip) => {
  const m = String(ip || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return null;
  return m.slice(1).reduce((n, x) => n * 256 + Number(x), 0);
};
const intToIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

module.exports = function servers(ctx) {
  const { save, broadcast, send, readBody, requireAdmin, isAdmin, HttpError, str } = ctx;
  const ev = () => ctx.event.scoped();
  const changed = () => { save(); broadcast('servers'); };
  const config = (e = ev()) => e.serverConfig;
  const list = (e = ev()) => e.guestServers;

  // Nächste freie IP im Bereich (gesperrte Server behalten ihre IP, gelöschte geben sie frei)
  function nextIp(e) {
    const c = config(e);
    const from = ipToInt(c.ipFrom), to = ipToInt(c.ipTo);
    if (from === null || to === null || to < from) return null;
    const used = new Set(list(e).map((s) => ipToInt(s.ip)));
    for (let n = from; n <= to; n++) if (!used.has(n)) return intToIp(n);
    return null;
  }

  // Wem gehört der Server – Name der verknüpften Person, sonst der Discord-Name des Kontos
  function ownerName(accountId) {
    if (!accountId) return '(Konto gelöscht)';
    const p = ctx.people && ctx.people.personByDiscord(accountId);
    if (p) return p.name;
    const a = ctx.accounts.find(accountId);
    return a ? a.discordName : '';
  }
  const publicView = (s) => ({ id: s.id, name: s.name, fqdn: s.fqdn, ip: s.ip, description: s.description, owner: ownerName(s.accountId), blocked: !!s.blocked });

  function requireMember(req) {
    const a = ctx.accounts.requireUser(req);
    if (!ctx.isMember(req, ev())) throw new HttpError(403, 'Gastserver können nur Teilnehmer mit Ticket anmelden');
    return a;
  }

  // Zonendatei-Zeilen: A-Records für alle, PTR nur auf Wunsch (Reverse-Zone aus der IP abgeleitet)
  function zoneExport(e) {
    const c = config(e);
    const active = list(e).filter((s) => !s.blocked).sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
    const lines = [`; Gastserver – ${e.name} – erzeugt ${new Date().toISOString()}`, '', `; Zone ${c.domain}`];
    for (const s of active) lines.push(`${s.name.padEnd(24)} IN A     ${s.ip}`);
    const ptr = active.filter((s) => s.reverse);
    if (ptr.length) {
      lines.push('', '; Reverse (PTR)');
      for (const s of ptr) {
        const [a, b, cc, d] = s.ip.split('.');
        lines.push(`${`${d}.${cc}.${b}.${a}.in-addr.arpa.`.padEnd(30)} IN PTR   ${s.fqdn}.`);
      }
    }
    return lines.join('\n') + '\n';
  }

  async function routes(req, res, parts, method) {
    if (parts[0] !== 'servers') return false;
    const e = ev();
    let c = config(e);

    // Öffentlich: Liste der aktiven Server und ob man selbst anmelden darf
    if (parts.length === 1 && method === 'GET') {
      const a = ctx.accounts.current(req);
      send(res, 200, {
        event: { id: e.id, name: e.name }, open: c.open, domain: c.domain, maxPerAccount: c.maxPerAccount,
        servers: list(e).filter((s) => !s.blocked).map(publicView).sort((x, y) => x.name.localeCompare(y.name)),
        mine: a ? list(e).filter((s) => s.accountId === a.id).map((s) => ({ ...publicView(s), reverse: s.reverse })) : [],
        loggedIn: !!a, member: !!a && ctx.isMember(req, e), free: !!nextIp(e),
      });
      return true;
    }

    // Anmelden: IP und FQDN sofort
    if (parts.length === 1 && method === 'POST') {
      ctx.security.rateLimit(req, 'guestserver', 30, 10 * 60000); // Anzahl Server begrenzt maxPerAccount
      requireMember(req);
      if (!c.open || ctx.event.isOver(e)) throw new HttpError(400, 'Die Gastserver-Anmeldung ist gerade geschlossen');
      if (!c.domain) throw new HttpError(400, 'Die Orga hat noch keine Domain eingerichtet');
      const b = await readBody(req);
      const a = requireMember(req);
      c = config(e); // Konfiguration kann während des Uploads ersetzt worden sein.
      if (!c.open || ctx.event.isOver(e)) throw new HttpError(400, 'Die Gastserver-Anmeldung ist gerade geschlossen');
      if (!c.domain) throw new HttpError(400, 'Die Orga hat noch keine Domain eingerichtet');
      const name = str(b.name, 63).toLowerCase();
      if (!HOST_RE.test(name)) throw new HttpError(400, 'Servername: nur Kleinbuchstaben, Ziffern und Bindestrich (nicht am Anfang/Ende), höchstens 63 Zeichen');
      const description = str(b.description, 300);
      if (!description) throw new HttpError(400, 'Bitte beschreibe kurz, was auf dem Server läuft');
      if (list(e).some((s) => s.name === name)) throw new HttpError(409, `„${name}.${c.domain}“ ist schon vergeben`);
      if (list(e).filter((s) => s.accountId === a.id).length >= c.maxPerAccount) {
        throw new HttpError(400, `Höchstens ${c.maxPerAccount} Gastserver pro Person`);
      }
      const ip = nextIp(e);
      if (!ip) throw new HttpError(409, 'Es sind keine IP-Adressen mehr frei – bitte bei der Orga melden');
      const s = {
        id: crypto.randomBytes(5).toString('hex'), accountId: a.id, name, fqdn: `${name}.${c.domain}`, ip,
        description, reverse: !!b.reverse, blocked: false, createdAt: new Date().toISOString(),
      };
      list(e).push(s);
      changed();
      ctx.security.log('guestserver_created', req, { name: s.fqdn, ip });
      ctx.tickets.dm(a.id, `🖥️ Dein Gastserver für **${e.name}** ist angemeldet:\nFQDN: \`${s.fqdn}\`\nIP: \`${s.ip}\``
        + (s.reverse ? '\nDer Reverse-Eintrag (PTR) ist vorgemerkt.' : ''));
      send(res, 201, { ...publicView(s), reverse: s.reverse });
      return true;
    }

    // ---------- Admin ----------
    if (parts[1] === 'admin' && method === 'GET') {
      requireAdmin(req);
      send(res, 200, {
        event: { id: e.id, name: e.name }, config: c, free: nextIp(e),
        servers: list(e).map((s) => ({ ...publicView(s), reverse: s.reverse, createdAt: s.createdAt }))
          .sort((x, y) => ipToInt(x.ip) - ipToInt(y.ip)),
      });
      return true;
    }
    if (parts[1] === 'config' && method === 'PUT') {
      requireAdmin(req);
      const b = await readBody(req);
      const domain = str(b.domain, 200).toLowerCase().replace(/\.+$/, '');
      if (domain && !DOMAIN_RE.test(domain)) throw new HttpError(400, 'Ungültige Domain, z. B. gast.lan');
      const from = str(b.ipFrom, 15), to = str(b.ipTo, 15);
      if ((from || to) && (ipToInt(from) === null || ipToInt(to) === null)) throw new HttpError(400, 'Bitte gültige IPv4-Adressen angeben, z. B. 10.10.50.10');
      if (from && to && ipToInt(to) < ipToInt(from)) throw new HttpError(400, 'Das Ende des IP-Bereichs muss nach dem Anfang liegen');
      if (from && to && ipToInt(to) - ipToInt(from) > 65535) throw new HttpError(400, 'Der IP-Bereich ist zu groß (höchstens 65536 Adressen)');
      if (domain !== c.domain && list(e).length) throw new HttpError(400, 'Die Domain lässt sich nicht mehr ändern, solange es Gastserver gibt');
      e.serverConfig = {
        domain, ipFrom: from, ipTo: to, open: !!b.open,
        maxPerAccount: Math.min(Math.max(Math.floor(Number(b.maxPerAccount)) || 1, 1), 20),
      };
      changed();
      send(res, 200, e.serverConfig);
      return true;
    }
    if (parts[1] === 'export.txt' && method === 'GET') {
      requireAdmin(req);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(zoneExport(e));
      return true;
    }
    if (parts[1] === 'export.csv' && method === 'GET') {
      requireAdmin(req);
      const cell = (v) => { let x = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; return /[";\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
      const rows = [['Name', 'FQDN', 'IP', 'Reverse-DNS', 'Gesperrt', 'Betreiber', 'Beschreibung', 'Angemeldet']]
        .concat(list(e).map((s) => [s.name, s.fqdn, s.ip, s.reverse ? 'ja' : '', s.blocked ? 'ja' : '', ownerName(s.accountId), s.description, s.createdAt.slice(0, 16)]));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="gastserver.csv"', 'Cache-Control': 'no-store' });
      res.end('﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n'));
      return true;
    }

    // Einzelner Server: sperren (Admin), löschen (Admin oder Betreiber)
    const s = parts[1] && list(e).find((x) => x.id === parts[1]);
    if (!s) throw new HttpError(404, 'Gastserver nicht gefunden');
    if (parts[2] === 'block' && method === 'POST') {
      requireAdmin(req);
      s.blocked = !!(await readBody(req)).blocked;
      changed();
      send(res, 200, publicView(s));
      return true;
    }
    if (parts.length === 2 && method === 'DELETE') {
      if (!isAdmin(req)) {
        const a = ctx.accounts.requireUser(req);
        if (s.accountId !== a.id) throw new HttpError(403, 'Nicht dein Server');
      }
      e.guestServers = list(e).filter((x) => x !== s);
      changed();
      ctx.security.log('guestserver_deleted', req, { name: s.fqdn });
      send(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  return { routes, zoneExport, nextIp };
};
