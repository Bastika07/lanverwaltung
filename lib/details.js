'use strict';
// Eventdetails: die allgemeinen Infos zu einem Event für Interessierte und Käufer – Beginn, Ende,
// Mindestalter und Ticketarten kommen automatisch aus dem Event, dazu Location, Adresse,
// Teilnehmerzahl, Zuschauereintritt und ein freier Text. (Die Infos vor Ort wie WLAN und Gameserver
// stehen im Modul „Infos“.) Besucher dürfen auch die Details eines kommenden Events abrufen (X-Event).

module.exports = function details(ctx) {
  const { send, readBody, requireAdmin, HttpError, str } = ctx;

  function view(e) {
    const d = e.details;
    return {
      event: { id: e.id, name: e.name, start: e.start, end: e.end, active: e.active },
      details: d,
      minAge: e.sale.minAge || 0,
      tickets: e.ticketTypes.filter((t) => t.active).map((t) => ({ name: t.name, price: t.price, description: t.description })),
      // Weitere Events mit Details (laufend oder kommend) zum Umschalten
      events: ctx.event.all().filter((x) => x === e || (!ctx.event.isOver(x) && ctx.eventModuleOn(x, 'details')))
        .map((x) => ({ id: x.id, name: x.name, start: x.start })),
    };
  }

  async function routes(req, res, parts, method) {
    if (parts[0] !== 'details') return false;
    const e = ctx.event.scoped();
    if (method === 'GET') { send(res, 200, view(e)); return true; }
    if (method === 'PUT') {
      requireAdmin(req);
      const b = await readBody(req);
      const cap = b.capacity === '' || b.capacity == null ? null : Math.floor(Number(b.capacity));
      if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 100000)) throw new HttpError(400, 'Ungültige Teilnehmerzahl');
      e.details = {
        location: str(b.location, 120), address: str(b.address, 300), capacity: cap,
        spectatorFee: str(b.spectatorFee, 120), text: str(b.text, 5000),
      };
      ctx.save(); ctx.broadcast('details');
      send(res, 200, view(e));
      return true;
    }
    return false;
  }

  return { routes };
};
