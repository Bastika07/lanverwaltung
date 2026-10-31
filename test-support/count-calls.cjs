'use strict';
// Nur für Tests (per NODE_OPTIONS=--require im isolierten Server): meldet Spielplanberechnungen und
// Speichervorgänge als Zeilen auf stdout, damit Tests sie über app.logs() zählen können.
const Bracket = require('../public/bracket.js');
const Storage = require('../lib/storage.js');

const compute = Bracket.compute;
Bracket.compute = (...args) => { process.stdout.write('[count] compute\n'); return compute(...args); };

const open = Storage.openStore;
Storage.openStore = (...args) => {
  const store = open(...args);
  const save = store.save.bind(store);
  store.save = (...rest) => { process.stdout.write('[count] save\n'); return save(...rest); };
  return store;
};
