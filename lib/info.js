'use strict';
// Info-Bereich: WLAN, Gameserver, Spieleliste, Hausregeln und freier Text.

module.exports = function info(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, HttpError, str } = ctx;
  db.info = db.info || { wifi: { ssid: '', password: '', note: '' }, servers: [], games: [], rules: '', extra: '' };

  const list = (v, max, fn) => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) throw new HttpError(400, 'Liste erwartet');
    if (v.length > max) throw new HttpError(400, `Höchstens ${max} Einträge`);
    return v.map(fn).filter((x) => x.name);
  };

  async function routes(req, res, parts, method) {
    if (parts[0] !== 'info') return false;
    if (method === 'GET') { send(res, 200, { ...db.info, packlist: db.info.packlist || '' }); return true; }
    if (method === 'PUT') {
      requireAdmin(req);
      const b = await readBody(req);
      requireAdmin(req);
      if (b.packlist !== undefined && (typeof b.packlist !== 'string' || b.packlist.length > 10000)) {
        throw new HttpError(400, 'Pack-/Mitbringliste muss Text mit höchstens 10000 Zeichen sein');
      }
      // Erst alles prüfen, dann übernehmen: eine abgelehnte Anfrage ändert nichts.
      const wifi = b.wifi ? { ssid: str(b.wifi.ssid, 64), password: str(b.wifi.password, 128), note: str(b.wifi.note, 300) } : undefined;
      const servers = list(b.servers, 50, (s) => ({
        name: str(s.name, 80), game: str(s.game, 80), address: str(s.address, 200), password: str(s.password, 128), note: str(s.note, 300),
      }));
      const games = list(b.games, 100, (g) => {
        const link = str(g.link, 300);
        if (link && !/^https?:\/\//i.test(link)) throw new HttpError(400, `Link bei „${str(g.name, 80)}“ muss mit http:// oder https:// beginnen`);
        return { name: str(g.name, 80), note: str(g.note, 300), link };
      });
      const rules = b.rules !== undefined ? str(b.rules, 5000) : undefined;
      const extra = b.extra !== undefined ? str(b.extra, 5000) : undefined;
      const i = db.info;
      if (wifi) i.wifi = wifi;
      if (servers) i.servers = servers;
      if (games) i.games = games;
      if (rules !== undefined) i.rules = rules;
      if (extra !== undefined) i.extra = extra;
      if (b.packlist !== undefined) i.packlist = b.packlist;
      save(); broadcast('info');
      send(res, 200, i);
      return true;
    }
    return false;
  }

  return { routes };
};
