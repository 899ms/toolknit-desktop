import assert from 'node:assert/strict';
import { createPdfEditorFocusManager } from '../src/features/pdf-editor/focus.js';

class FakeElement {
  constructor({ visible = true } = {}) {
    this.isConnected = true;
    this.disabled = false;
    this.hidden = false;
    this.focused = 0;
    this.style = visible ? { display: 'block', visibility: 'visible' } : { display: 'none', visibility: 'visible' };
    this.classList = { contains: () => false };
  }

  closest() { return null; }
  focus() { this.focused += 1; }
}

const first = new FakeElement();
const second = new FakeElement();
const root = {
  querySelectorAll(selector) {
    assert.equal(selector.includes('button'), true);
    return [first, second];
  },
  classList: { contains: value => value === 'visible' }
};
const processMask = { classList: { contains: () => false } };
const successOverlay = { classList: { contains: () => false } };
const editModal = { classList: { contains: () => false } };
const windowRef = {
  HTMLElement: FakeElement,
  getComputedStyle: element => element.style,
  requestAnimationFrame(callback) { callback(); }
};
const documentRef = { activeElement: first };
const manager = createPdfEditorFocusManager({
  overlay: root,
  processMask,
  successOverlay,
  editModal,
  documentRef,
  windowRef
});

assert.deepEqual(manager.activeFocusRoots(), [root]);
assert.deepEqual(manager.focusableElements([root]), [first, second]);
manager.restoreFocus(second);
assert.equal(second.focused, 1);

const forward = { key: 'Tab', shiftKey: false, prevented: false, preventDefault() { this.prevented = true; } };
documentRef.activeElement = second;
manager.trapFocus(forward, [root]);
assert.equal(forward.prevented, true);
assert.equal(first.focused, 1);

const backward = { key: 'Tab', shiftKey: true, prevented: false, preventDefault() { this.prevented = true; } };
documentRef.activeElement = first;
manager.trapFocus(backward, [root]);
assert.equal(backward.prevented, true);
assert.equal(second.focused, 2);

console.log('PDF editor focus lifecycle checks passed');
