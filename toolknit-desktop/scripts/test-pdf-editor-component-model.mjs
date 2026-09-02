import assert from 'node:assert/strict';
import {
  componentElementKey,
  createPdfEditorComponentModel,
  sameComponent,
  sameTextSegmentLayout,
  snapRotationToAxis
} from '../src/features/pdf-editor/component-model.js';

assert.equal(componentElementKey({ type: 'text', key: 'p1:0:0' }), 'p1:0:0');
assert.equal(componentElementKey({ type: 'inserted-image', key: 'img-1' }), 'inserted-image:img-1');
assert.equal(sameComponent(
  { type: 'inserted-shape', pageId: 'p1', key: 'shape-1' },
  { type: 'inserted-shape', pageId: 'p1', key: 'shape-1', object: {} }
), true);
assert.equal(sameComponent(
  { type: 'inserted-shape', pageId: 'p1', key: 'shape-1' },
  { type: 'inserted-shape', pageId: 'p2', key: 'shape-1' }
), false);
assert.equal(snapRotationToAxis(87), 90);
assert.equal(snapRotationToAxis(44), 44);

const segment = {
  text: 'hello',
  baselineX: 100,
  baselineY: 200,
  fontSize: 12,
  rotation: 0,
  bold: false,
  italic: false,
  color: [0, 0, 0],
  box: { x: 100, y: 190, width: 40, height: 14 }
};
assert.equal(sameTextSegmentLayout(segment, structuredClone(segment)), true);
assert.equal(sameTextSegmentLayout(segment, { ...segment, rotation: 1 }), false);

const textEdits = new Map();
const insertedTexts = [{ id: 'text-1', pageId: 'p1', x: 10, y: 20, text: 'inserted', fontSize: 16, rotation: 0 }];
const insertedImages = [{ id: 'img-1', pageId: 'p1', x: 80, y: 80, width: 20, height: 20, rotation: 0 }];
const insertedShapes = [{ id: 'shape-1', pageId: 'p1', x: 140, y: 140, width: 30, height: 30, rotation: 0 }];
const textLinesCache = new Map([[
  'p1',
  { lines: [{ box: { x: 200, y: 200, width: 40, height: 14 }, segments: [segment] }] }
]]);
let selectedComponent = { type: 'inserted-image', pageId: 'p1', key: 'img-1', object: insertedImages[0] };
const changes = [];
const model = createPdfEditorComponentModel({
  getTextEdits: () => textEdits,
  getInsertedTexts: () => insertedTexts,
  getInsertedImages: () => insertedImages,
  getInsertedShapes: () => insertedShapes,
  getTextLinesCache: () => textLinesCache,
  getSelectedComponent: () => selectedComponent,
  setSelectedComponent: value => { selectedComponent = value; },
  onChanged: change => changes.push(change)
});

assert.equal(model.resolveComponentObject({ type: 'inserted-image', key: 'img-1' }), insertedImages[0]);
model.setComponentRotation({ type: 'inserted-image', key: 'img-1' }, 90);
assert.equal(insertedImages[0].rotation, 90);
assert.equal(selectedComponent.object.rotation, 90);

model.updateComponentFromDelta(5, -3, 1.5, selectedComponent);
assert.deepEqual(
  { x: insertedImages[0].x, y: insertedImages[0].y, width: insertedImages[0].width, height: insertedImages[0].height },
  { x: 85, y: 77, width: 30, height: 30 }
);
assert.equal(changes.at(-1).deferRender, false);

const textComponent = { type: 'text', pageId: 'p1', key: 'p1:0:0', lineIndex: 0, segmentIndex: 0, segment };
model.updateComponentFromDelta(10, 5, 2, textComponent, { deferRender: true });
assert.equal(textEdits.get(textComponent.key).segment.fontSize, 24);
assert.equal(textEdits.get(textComponent.key).segment.box.x, 110);
assert.equal(changes.at(-1).deferRender, true);

const snap = model.snapComponentDrag(
  { type: 'inserted-image', pageId: 'p1', key: 'img-1', object: insertedImages[0] },
  30,
  20,
  [{ x: 120, y: 100, width: 30, height: 30 }]
);
assert.equal(snap.dx, 35);
assert.equal(snap.dy, 23);

const targets = model.collectSnapTargets('p1', 'inserted-image', 'img-1');
assert.ok(targets.length >= 3, 'snap targets include text and inserted components');

console.log('PDF editor component model regression checks passed');
