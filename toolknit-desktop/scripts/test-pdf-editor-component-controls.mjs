import assert from 'node:assert/strict';
import { createPdfEditorComponentControls } from '../src/features/pdf-editor/component-controls.js';

function makeElement({ rect = {}, width = 0, height = 0 } = {}) {
  return {
    hidden: false,
    offsetWidth: width,
    offsetHeight: height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    dataset: {},
    children: [],
    listeners: new Map(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, width, height, ...rect }),
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(name, handler) { this.listeners.set(name, handler); },
    querySelector: () => null,
    remove() {}
  };
}

const created = [];
const documentRef = {
  createElement(tag) {
    const element = makeElement();
    element.tagName = tag;
    created.push(element);
    return element;
  },
  createElementNS(_namespace, tag) {
    const element = makeElement();
    element.tagName = tag;
    element.attributes = {};
    element.setAttribute = (name, value) => { element.attributes[name] = String(value); };
    created.push(element);
    return element;
  }
};

const componentMenu = makeElement({ width: 120, height: 32 });
const shapePanel = makeElement({ width: 180, height: 44 });
const canvasStage = makeElement({ width: 640, height: 480 });
const target = makeElement({ rect: { left: 90, top: 100, right: 190, bottom: 140 } });
const shapeFillField = makeElement();
const shapeFillInput = makeElement();
const shapeStrokeInput = makeElement();
const shapeStrokeWidth = makeElement();
const insertedShapes = [{
  id: 'shape-1',
  pageId: 'p1',
  shapeType: 'rect',
  fill: [1, 0.5, 0],
  stroke: [0, 0, 0],
  strokeWidth: 3
}];
let selectedComponent = { type: 'inserted-shape', pageId: 'p1', key: 'shape-1' };
let resizeCall = null;
let updateCount = 0;
let refreshCount = 0;

const controls = createPdfEditorComponentControls({
  componentMenu,
  componentEditBtn: makeElement(),
  shapePanel,
  shapeFillField,
  shapeFillInput,
  shapeStrokeInput,
  shapeStrokeWidth,
  canvasStage,
  documentRef,
  windowRef: { requestAnimationFrame: callback => { callback(); return 1; } },
  getSelectedComponent: () => selectedComponent,
  getComponentMode: () => true,
  hasDocument: () => true,
  componentElement: () => target,
  getInsertedShapes: () => insertedShapes,
  beginComponentResize: (...args) => { resizeCall = args; },
  updateControls: () => { updateCount += 1; },
  refreshCurrentTextLayer: () => { refreshCount += 1; },
  cloneState: value => structuredClone(value),
  t: key => key
});

controls.syncComponentMenu();
assert.equal(componentMenu.hidden, false);
assert.equal(shapePanel.hidden, false);
assert.equal(shapeFillInput.value, '#ff8000');
assert.equal(shapeStrokeWidth.value, '3');
assert.equal(componentMenu.style.left, '198px');

controls.updateSelectedShapeProperty('strokeWidth', 100);
assert.equal(insertedShapes[0].strokeWidth, 80);
assert.equal(selectedComponent.object.strokeWidth, 80);
assert.equal(updateCount, 1);
assert.equal(refreshCount, 1);

const svg = controls.buildShapeSvg(insertedShapes[0], 100, 50, 2);
assert.equal(svg.tagName, 'svg');
assert.equal(svg.children[0].tagName, 'rect');
assert.equal(svg.children[0].attributes['stroke-width'], '160');

const container = makeElement();
controls.appendResizeHandles(container, { type: 'inserted-shape' }, 'p1', insertedShapes[0]);
assert.equal(container.children.length, 8);
container.children[0].listeners.get('pointerdown')({ stopPropagation() {} });
assert.equal(resizeCall[1].key, 'shape-1');
assert.equal(resizeCall[2], 'nw');

selectedComponent = null;
controls.syncComponentMenu();
assert.equal(componentMenu.hidden, true);
assert.equal(shapePanel.hidden, true);

console.log('PDF editor component controls regression checks passed');
