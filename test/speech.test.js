'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../public');
const load = (context, file) => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);

// Browser-Attrappe mit Sprachausgabe: merkt sich, was vorgelesen würde
function browser(extra = {}) {
  const spoken = [];
  const context = vm.createContext({
    liveHandlers: [], startHooks: [], adminViews: {}, views: {}, state: { settings: {} }, location: { hash: '#/beamer' },
    document: { body: { classList: { contains: () => true } }, getElementById: () => null },
    addEventListener() {},
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { speak: (u) => spoken.push(u), getVoices: () => [{ lang: 'en-US', name: 'en' }, { lang: 'de-DE', name: 'Katja' }] },
    ...extra,
  });
  context.window = context;
  return { context, spoken };
}

test('Sprachausgabe: erst nach dem Klick, ohne Emoji, mit deutscher Stimme', () => {
  const { context, spoken } = browser();
  load(context, 'announce.js');
  context.speak('Vor dem Klick');
  assert.equal(spoken.length, 0, 'Browser erlauben Sprachausgabe erst nach einem Klick');
  context.unlockAudio();
  spoken.length = 0; // leere Freigabe-Ansage
  context.speak('🍕 Das Essen ist da! ❤️ 👨‍👩‍👧');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, 'Das Essen ist da!');
  assert.equal(spoken[0].lang, 'de-DE');
  assert.equal(spoken[0].voice.name, 'Katja');
  context.speak('🎮');
  assert.equal(spoken.length, 1, 'nur Emoji: nichts vorlesen');
});

test('Beamer: liest bei einer Durchsage nur den Text vor', async () => {
  const el = () => ({ hidden: true, innerHTML: '', querySelector: () => ({}) });
  const elements = { banner: el(), overlay: el() };
  const { context, spoken } = browser({ on: () => true, esc: (s) => s, setTimeout, clearTimeout, sessionStorage: { getItem: () => null, setItem() {} } });
  context.document.getElementById = (id) => elements[id];
  load(context, 'announce.js');
  context.unlockAudio();
  spoken.length = 0;
  context.state.settings.speakAnnouncements = true;
  vm.runInContext('Announce.lastGongId = ""; Announce.active = { id: "a1", text: "🍕 Pizza ist da!", by: "Dr. Orga", gong: false, at: new Date().toISOString() }; showAnnouncement();', context);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(spoken.map((u) => u.text), ['Pizza ist da!']);
});

test('Beamer: liest nur neu anstehende Spiele vor, viele auf einmal zusammengefasst', () => {
  const said = [];
  const { context } = browser({ speak: (s) => said.push(s), pname: (t, i) => t.participants[i] });
  load(context, 'beamer.js');
  const t = { id: 'cup', name: 'Cup', participants: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Fox', 'Golf', 'Hotel', 'India', 'Juliett'] };
  const match = (id, a, b) => ({ t, m: { id, label: 'Viertelfinale', a, b } });
  context.state.settings.speakMatches = true;

  context.speakNewMatches([match('m1', 0, 1)]);
  assert.deepEqual(said, [], 'erstes Laden liest nichts vor');
  context.speakNewMatches([match('m1', 0, 1), match('m2', 2, 3)]);
  assert.deepEqual(said, ['Cup, Viertelfinale: Charlie gegen Delta. Ihr seid dran.']);
  context.speakNewMatches([match('m2', 2, 3)]);
  assert.equal(said.length, 1, 'beendetes Spiel löst nichts aus');

  context.speakNewMatches([match('m3', 4, 5), match('m4', 6, 7), match('m5', 8, 9), match('m6', 0, 2)]);
  assert.equal(said.at(-1), '4 neue Spiele sind dran. Bitte auf den Beamer schauen.');

  context.state.settings.speakMatches = false;
  context.speakNewMatches([match('m7', 1, 3)]);
  assert.equal(said.length, 2, 'ausgeschaltet: still');
});

test('/announce: Option „vorlesen“ schaltet Discord-TTS ein, Standard aus', async () => {
  const created = [];
  const commands = require('../lib/commands.js')({
    Discord: {}, settings: () => ({ announceRole: '' }), people: {}, schedule: {}, tournaments: {},
    announcements: { create: (o) => { created.push(o); return { at: new Date().toISOString(), until: null }; } },
    moduleOn: () => true, mayViewDiscord: () => true,
  });
  const def = commands.commands().find((d) => d.name === 'announce');
  assert.deepEqual(def.options.map((o) => [o.name, o.type, !!o.required]), [['nachricht', 3, true], ['vorlesen', 5, false]]);
  const run = commands.find('announce').run;
  const call = (opts) => run({ member: { permissions: '8', roles: [] }, user: { id: '1', name: 'Orga' }, opts });
  await call({ nachricht: 'Pizza', vorlesen: true });
  await call({ nachricht: 'Pizza' });
  assert.deepEqual(created.map((o) => o.tts), [true, false]);
});
