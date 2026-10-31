'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { electionSteps, wonMaps } = require('../lib/tmt.js');

const modes = (steps) => steps.map((s) => s.map.mode + (s.map.who ? ':' + s.map.who.slice(-1) : '') + (s.side ? '/' + s.side.mode : ''));

test('TMT2 map election: BO1 bans down to one map and decides sides by knife', () => {
  assert.deepEqual(modes(electionSteps(7, 'bo1')), ['BAN:A', 'BAN:B', 'BAN:A', 'BAN:B', 'BAN:A', 'BAN:B', 'RANDOM_PICK/KNIFE']);
  assert.deepEqual(modes(electionSteps(1, 'bo1')), ['RANDOM_PICK/KNIFE']);
});

test('TMT2 map election: BO3 and BO5 alternate picks, the opponent picks the side', () => {
  assert.deepEqual(modes(electionSteps(7, 'bo3')), ['BAN:A', 'BAN:B', 'PICK:A/PICK', 'PICK:B/PICK', 'BAN:A', 'BAN:B', 'RANDOM_PICK/KNIFE']);
  const bo3 = electionSteps(7, 'bo3');
  assert.equal(bo3[2].side.who, 'TEAM_B');
  assert.equal(bo3[3].side.who, 'TEAM_A');
  assert.deepEqual(modes(electionSteps(5, 'bo5')), ['PICK:A/PICK', 'PICK:B/PICK', 'PICK:A/PICK', 'PICK:B/PICK', 'RANDOM_PICK/KNIFE']);
  for (const [n, f] of [[7, 'bo1'], [5, 'bo3'], [9, 'bo5']]) assert.equal(electionSteps(n, f).length, n, 'every map is banned or played exactly once');
});

test('TMT2 map election: too small pools and unknown formats are rejected', () => {
  assert.throws(() => electionSteps(2, 'bo3'), /mindestens 3 Maps/);
  assert.throws(() => electionSteps(7, 'bo2'), /Unbekanntes Format/);
});

test('TMT2 map score: only finished maps with a winner count', () => {
  assert.deepEqual(wonMaps([{ a: 13, b: 7, done: true }, { a: 5, b: 13, done: true }, { a: 9, b: 3, done: false }, { a: 12, b: 12, done: true }]), { a: 1, b: 1 });
});
