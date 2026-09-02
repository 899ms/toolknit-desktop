import assert from 'node:assert/strict';
import { createPdfEditorHistory } from '../src/features/pdf-editor/history.js';

let state = { value: 0 };
let refreshes = 0;
const applied = [];

const history = createPdfEditorHistory({
  capture: () => ({ value: state.value }),
  apply: snapshot => {
    state = { ...snapshot };
    applied.push(state.value);
  },
  equals: (left, right) => left?.value === right?.value,
  hasDocument: () => true,
  onChange: () => { refreshes += 1; },
  limit: 3
});

const initial = history.reset();
assert.deepEqual(initial, { value: 0 });
assert.equal(history.length, 1);
assert.equal(history.firstSnapshot().value, 0);
assert.equal(history.canUndo(), false);
assert.equal(history.canRedo(), false);

state.value = 1;
assert.equal(history.commit(), true);
state.value = 2;
assert.equal(history.commit(), true);
assert.equal(history.length, 3);
assert.equal(history.canUndo(), true);

state.value = 3;
history.commit();
assert.equal(history.length, 3, 'history must remain bounded');
assert.equal(history.firstSnapshot().value, 1, 'oldest snapshot must be evicted first');

assert.equal(history.undo(), true);
assert.equal(state.value, 2);
assert.deepEqual(applied, [2]);
assert.equal(history.redo(), true);
assert.equal(state.value, 3);
assert.deepEqual(applied, [2, 3]);

const beforeLockedCommit = history.length;
history.withLock(() => {
  state.value = 99;
  assert.equal(history.commit(), false);
});
assert.equal(history.length, beforeLockedCommit);
assert.equal(history.hasUnsavedChanges({ value: 3 }), true);
assert.equal(history.hasUnsavedChanges({ value: 99 }), false);

history.clear();
assert.equal(history.length, 0);
assert.equal(history.current, null);
assert.ok(refreshes >= 6);

console.log('PDF editor history lifecycle checks passed');
