'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discordSide } = require('../test-support/tournaments.cjs');

const persons = [{ id: 'claimer', name: 'Alice', discordId: '100000000000000001', selfClaimed: true }, { id: 'bob', name: 'Bob', discordId: '100000000000000002' },
  { id: 'carol', name: 'Carol', discordId: '100000000000000003' }, { id: 'dave', name: 'Dave', discordId: '100000000000000004' }];

// Turnierstart über die Discord-Seite: Wer wird in der Ansage angepingt?
function start(tournament, options = {}) {
  const t = { id: 't', name: 'Cup', type: 'ko', status: 'running', order: tournament.participants.map((_, i) => i), results: {}, members: {}, ...tournament };
  const { side, posts } = discordSide({ event: { tournaments: [t] }, persons, ...options });
  side.started(t);
  assert.equal(posts.length, 1);
  return posts[0];
}

test('Erwähnungen: nur namensgleiche, selbst angelegte Person wird nicht angepingt', () => {
  const post = start({ participants: ['Alice', 'Bob'], playerIds: { Alice: null, Bob: 'bob' } });
  assert.deepEqual(post.users, ['100000000000000002']);
  assert.match(post.text, /\*\*Alice\*\* vs \*\*Bob\*\* \(<@100000000000000002>\)/);
  assert.doesNotMatch(post.text, /100000000000000001/);
});

test('Erwähnungen: Teams weiter über ihre Mitglieder, ohne Bindung niemand', () => {
  const post = start({ participants: ['Team Synthetic', 'Alice'], members: { 'Team Synthetic': ['carol', 'dave'] }, playerIds: {} });
  assert.deepEqual(post.users, ['100000000000000003', '100000000000000004']);
  assert.match(post.text, /\*\*Team Synthetic\*\* \(<@100000000000000003> <@100000000000000004>\) vs \*\*Alice\*\*$/m);
  const reserved = start({ participants: ['__proto__', 'Bob'], playerIds: { Bob: 'bob' } });
  assert.deepEqual(reserved.users, ['100000000000000002'], 'reserved name without binding');
});

test('Erwähnungen: ausgeschaltet oder ohne Teilnehmermodul niemand', () => {
  const t = { participants: ['Alice', 'Bob'], playerIds: { Alice: 'claimer', Bob: 'bob' } };
  assert.deepEqual(start(t, { mentionPlayers: false }).users, []);
  assert.deepEqual(start(t, { people: false }).users, []);
});
