'use strict';
// Gemeinsamer Modul-Kontext (ctx) für Tests ohne Server: harmlose Standardwerte, einzeln überschreibbar.
// Greift ein Modul auf einen Eintrag zu, den der Test nicht angegeben hat, bricht der Test sofort mit dessen Namen ab,
// statt später irgendwo mit „undefined is not a function“ (siehe docs/adr/0004-ctx-bleibt-werkzeugkasten.md).

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Wie server.js: Text kürzen, Objekte als Eingabe ablehnen
const str = (v, max = 100) => {
  if (v !== null && typeof v === 'object') throw new HttpError(400, 'Textwert erwartet');
  return String(v || '').trim().slice(0, max);
};

const defaults = () => ({
  save() {}, broadcast() {}, HttpError, str,
  send: (res, status, data) => Object.assign(res, { status, data }),
  readBody: async () => ({}), requireAdmin() {}, isAdmin: () => false,
  settings: () => ({ modules: {} }), moduleOn: () => true, eventModuleOn: () => true,
  Discord: { enabled: false, md: String }, discordPost() {}, discordQueue: (fn) => fn(),
  security: { log() {}, rateLimit() {} }, revokeAdminSessions() {}, refreshCommands() {},
  // Optionale Nachbarn: Module prüfen sie mit „if (ctx.catering)“; ohne Angabe gelten sie als nicht vorhanden.
  accounts: undefined, catering: undefined,
});

function testCtx(overrides = {}) {
  return new Proxy({ ...defaults(), ...overrides }, {
    get(target, key) {
      if (key in target || typeof key === 'symbol' || key === 'then') return target[key];
      throw new Error(`ctx.${key} fehlt im Test-Kontext – in testCtx({ ${key}: … }) angeben`);
    },
  });
}

module.exports = { testCtx, HttpError, str };
