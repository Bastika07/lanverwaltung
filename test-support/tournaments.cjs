'use strict';
// Turniermodul und Discord-Seite ohne Server und ohne Discord: synthetisches Event, zählendes save,
// aufzeichnender notifier bzw. aufzeichnendes discordPost.
const Tournaments = require('../lib/tournaments.js');
const TournamentDiscord = require('../lib/tournament-discord.js');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Wie server.js: jede Speicherung erhöht die Revision und macht zwischengespeicherte Ansichten ungültig.
function tournamentModule({ db = { persons: [] }, event = { id: 'e', tournaments: [] }, notifier } = {}) {
  let revision = 0;
  const saves = [], broadcasts = [], notes = [];
  const recorder = new Proxy({}, { get: (_, name) => (...args) => { notes.push([name, ...args]); } });
  const str = (v, max = 100) => String(v || '').trim().slice(0, max);
  const tournaments = Tournaments({ db, HttpError, str, notifier: notifier || recorder, revision: () => revision,
    save: () => { saves.push(revision); revision++; }, broadcast: (...args) => broadcasts.push(args) });
  return { tournaments, of: tournaments.of(event), event, db, saves, broadcasts, notes, HttpError };
}

// Discord-Seite mit festem laufendem Event; posts zeichnet Ansagen samt angepingter Discord-IDs auf.
function discordSide({ event, persons = [], Discord = { enabled: false }, mentionPlayers = true, people = true, publicUrl = '' } = {}) {
  const posts = [], saves = [], broadcasts = [];
  const byId = (id) => persons.find((p) => p.id === id);
  const side = TournamentDiscord({
    Discord: { md: String, ...Discord }, settings: () => ({ mentionPlayers }), moduleOn: (k) => k !== 'people' || people,
    people: () => ({ byId }), events: () => ({ all: () => [event], activeEvent: () => event }),
    discordPost: (text, onResult, kind, users) => posts.push({ text, kind, users }),
    save: () => saves.push(1), broadcast: (...args) => broadcasts.push(args), publicUrl,
  });
  return { side, posts, saves, broadcasts };
}

module.exports = { tournamentModule, discordSide, HttpError };
