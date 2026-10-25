import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offsetContour, rectCW, bbox, signedArea } from '../src/geometry.js';
import { buildRack, resolveParams, DEFAULTS } from '../src/rack.js';
import { layoutParts, flatten, toSVG, toDXF } from '../src/export.js';

const LASER = { ...DEFAULTS, machine: 'laser', thickness: 6, sheet: '900x600' };

test('offsetContour：外框往外長、內孔往內縮', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const o = bbox(offsetContour(sq, 0.1));
  assert.ok(Math.abs(o.w - 10.2) < 1e-9 && Math.abs(o.minX + 0.1) < 1e-9);
  const h = bbox(offsetContour(rectCW(0, 0, 10, 10), 0.1));
  assert.ok(Math.abs(h.w - 9.8) < 1e-9 && Math.abs(h.minX - 0.1) < 1e-9);
  assert.ok(signedArea(offsetContour(sq, 0.1)) > 0, '方向不變');
});

test('雷射：不加狗骨頭、預設切縫與零件間距', () => {
  const r = resolveParams(LASER);
  assert.equal(r.P.machine, 'laser');
  assert.equal(r.P.bitDia, 0);
  assert.equal(r.P.dogbone, false);
  assert.equal(r.P.kerf, 0.15);
  assert.equal(r.P.partGap, 3);
  const cnc = buildRack(DEFAULTS, []), las = buildRack(LASER, []);
  // CNC 的榫槽四角有狗骨頭弧（點數多）；雷射是乾淨的矩形
  const slot = (rack) => rack.parts.find((p) => p.kind === 'side').holes.find((h) => h.type === 'poly').pts.length;
  assert.equal(slot(las), 4);
  assert.ok(slot(cnc) > 4);
});

test('雷射切縫補償：外框外擴、孔與圓孔內縮各半個切縫', () => {
  const r = buildRack(LASER, []);
  const part = r.parts.find((p) => p.kind === 'holeplate');
  const raw = flatten(part, false, 0), comp = flatten(part, false, 0.2);
  assert.ok(Math.abs(comp.w - raw.w - 0.2) < 1e-6, '外框寬多一個切縫');
  const c0 = raw.holes.find((h) => h.type === 'circle'), c1 = comp.holes.find((h) => h.type === 'circle');
  assert.ok(Math.abs(c0.r - c1.r - 0.1) < 1e-9, '圓孔半徑少半個切縫');
  const side = r.parts.find((p) => p.kind === 'side');
  const s0 = bbox(flatten(side, false, 0).holes.find((h) => h.type === 'poly').pts);
  const s1 = bbox(flatten(side, false, 0.2).holes.find((h) => h.type === 'poly').pts);
  assert.ok(Math.abs(s0.w - s1.w - 0.2) < 1e-6, '榫槽寬少一個切縫');
});

test('雷射 SVG / DXF：只有切割與雕刻路徑，沒有板材框與文字', () => {
  const r = buildRack(LASER, []);
  const lay = layoutParts(r.parts, r.params);
  assert.equal(lay.laser, true);
  const svg = toSVG(lay);
  assert.doesNotMatch(svg, /id="sheet"/);
  assert.doesNotMatch(svg, /<text/);
  assert.match(svg, /stroke="#ff0000" stroke-width="0.01"/);
  assert.match(svg, /stroke="#0000ff"/);
  const dxf = toDXF(lay);
  assert.doesNotMatch(dxf, /\nTEXT\n/);
  assert.doesNotMatch(dxf, /\n8\nSHEET\n/);
  // CNC 版仍保留
  const cnc = layoutParts(buildRack(DEFAULTS, []).parts, resolveParams(DEFAULTS).P);
  assert.match(toSVG(cnc), /id="sheet"/);
});

test('雷射板材偏厚時提醒', () => {
  assert.ok(buildRack({ ...LASER, thickness: 12 }, []).warnings.some((w) => w.includes('雷射')));
  assert.ok(!buildRack(LASER, []).warnings.some((w) => w.includes('雷射')));
});
