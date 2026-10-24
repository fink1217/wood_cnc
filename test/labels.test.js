import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskToArtwork } from '../src/artwork.js';
import { signedArea, bbox } from '../src/geometry.js';
import { buildRack, resolveParams, DEFAULTS, NAMEPLATE_SHAPES } from '../src/rack.js';
import { layoutParts, toSVG } from '../src/export.js';

// 20×10 點陣：左邊一個高柱、右邊一個矮方塊（天際線高低不同）
function artMask() {
  const w = 20, h = 10, m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 2; x < 6; x++) m[y * w + x] = 1;
  for (let y = 6; y < h; y++) for (let x = 12; x < 18; x++) m[y * w + x] = 1;
  return maskToArtwork(m, w, h);
}
const art = { ...artMask() };

const labels = (items, mode = 'engrave') => ({ enabled: true, mode, height: 18, items });

test('每種顏料各一片名牌，可各自關閉', () => {
  const items = Array.from({ length: DEFAULTS.kinds }, (_, k) => ({ on: k !== 2, art }));
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels(items) });
  const ls = r.parts.filter((p) => p.kind === 'label');
  assert.equal(ls.length, (DEFAULTS.kinds - 1) * r.info.mx);
  assert.ok(!ls.some((p) => p.labelKind === 2), '關閉的第 3 種沒有名牌');
  // 有名牌的列：孔板多兩個榫槽；關閉的那一列沒有
  const plates = r.parts.filter((p) => p.kind === 'holeplate');
  const slotted = plates.filter((p) => p.holes.some((h) => h.type === 'poly'));
  assert.equal(slotted.length, ls.length);
});

test('顏料名牌開啟時前緣留邊自動加寬，榫槽前後都留得住木料', () => {
  const off = resolveParams(DEFAULTS);
  const on = resolveParams({ ...DEFAULTS, labelsOn: true });
  assert.ok(on.P.frontMargin > off.P.frontMargin);
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels([{ on: true, art }]) });
  const L = r.layout;
  assert.ok(L.labelZ >= L.holeZ + L.holeD / 2 + 2 - 1e-9, '罐孔前留 2mm');
  assert.ok(L.depth - (L.labelZ + L.t + L.tol) >= 5 - 1e-9, '前緣留 5mm');
  // 手動把前緣設太小會被調回
  const tight = resolveParams({ ...DEFAULTS, labelsOn: true, frontMargin: 2 });
  assert.equal(tight.fields.frontMargin.adjusted, true);
  assert.match(tight.fields.frontMargin.note, /顏料名牌/);
});

test('顏料名牌夾在層板與孔板之間、罐子前方，不凸出孔板', () => {
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels([{ on: true, art }]) });
  const L = r.layout;
  const p = r.parts.find((q) => q.kind === 'label');
  const can = r.cans.find((c) => c.kind === 0);
  assert.ok(p.origin[2] > can.z + can.r, '在罐子前面');
  const shelfTop = L.shelfY[0] + L.t, plateBottom = L.holePlateY[0], plateTop = plateBottom + L.t;
  assert.ok(Math.abs(p.origin[1] - shelfTop) < 1e-9, '站在層板頂面');
  const b = bbox(p.outer);
  assert.ok(Math.abs(b.minY + L.t) < 1e-6, '下榫頭穿過層板');
  assert.ok(p.origin[1] + b.maxY <= plateTop + 1e-6, '上榫頭頂多與孔板頂面齊平，不凸出');
  assert.ok(Math.abs(p.origin[1] + b.maxY - plateTop) < 1e-6);
  // 層板與孔板都開了對應的榫槽
  const shelf = r.parts.find((q) => q.kind === 'shelf' && Math.abs(q.origin[1] - shelfTop) < 1e-9);
  const plate = r.parts.find((q) => q.kind === 'holeplate' && Math.abs(q.origin[1] - plateTop) < 1e-9);
  assert.equal(shelf.holes.filter((h) => h.type === 'poly').length, 2);
  assert.equal(plate.holes.filter((h) => h.type === 'poly').length, 2);
});

test('顏料名牌高度連動孔板高度與罐頂距離', () => {
  const a = resolveParams({ ...DEFAULTS, labelsOn: true, labelH: 12 });
  const b = resolveParams({ ...DEFAULTS, labelsOn: true, labelH: 25 });
  assert.ok(b.P.retainHeight >= DEFAULTS.thickness + 25, '孔板抬高');
  assert.ok(b.P.topGap > a.P.topGap, '罐頂距離跟著加大');
  const r = buildRack({ ...DEFAULTS, labelsOn: true, labelH: 25 }, [], { labels: labels([{ on: true, art }]) });
  assert.ok(r.info.labelH >= 25 - 1e-6);
});

test('雷射名牌：每片各自內嵌自己的點陣', () => {
  const items = [{ on: true, art }, { on: true, art }];
  const r = buildRack({ ...DEFAULTS, kinds: 2, labelsOn: true }, [], { labels: labels(items, 'laser') });
  const lay = layoutParts(r.parts, r.params);
  const svg = toSVG(lay, (part) => `data:image/png;base64,${part.artKey.replace(':', '')}`);
  assert.match(svg, /base64,label0/);
  assert.match(svg, /base64,label1/);
});

for (const [shape] of NAMEPLATE_SHAPES) {
  test(`頂端名牌外形「${shape}」：輪廓合法、榫頭保留、圖案在板內`, () => {
    const r = buildRack(DEFAULTS, [], { nameplate: { enabled: true, mode: 'engrave', shape, height: 70, art } });
    const p = r.parts.find((q) => q.kind === 'nameplate');
    assert.ok(signedArea(p.outer) > 0, '逆時針');
    const b = bbox(p.outer);
    assert.ok(Math.abs(b.minY + r.layout.t) < 1e-6, '榫頭往下一個板厚');
    for (const l of p.engrave) for (const [x, y] of l) assert.ok(x >= b.minX && x <= b.maxX && y >= 0 && y <= b.maxY);
  });
}

test('沿圖案外形：上緣跟著圖案高低起伏', () => {
  const r = buildRack(DEFAULTS, [], { nameplate: { enabled: true, mode: 'engrave', shape: 'silhouette', height: 70, art } });
  const p = r.parts.find((q) => q.kind === 'nameplate');
  const plate = r.parts.find((q) => q.kind === 'nameplate');
  const ar = plate.artRect;
  // 高柱（圖案寬的 2..6/20）上方的板高，要比矮方塊（12..18/20）上方高
  const heightOver = (f0, f1) => Math.max(...p.outer
    .filter(([px]) => px >= ar.x + ar.w * f0 && px <= ar.x + ar.w * f1).map(([, y]) => y));
  assert.ok(heightOver(0.1, 0.3) > heightOver(0.6, 0.9) + 5);
  const rect = buildRack(DEFAULTS, [], { nameplate: { enabled: true, mode: 'engrave', shape: 'rect', height: 70, art } });
  assert.ok(bbox(p.outer).w <= bbox(rect.parts.find((q) => q.kind === 'nameplate').outer).w + 1e-6);
});

import { signSpan, deriveLayout } from '../src/rack.js';

test('signSpan：寬度與位移都限制在兩片側板之間', () => {
  const L = deriveLayout(DEFAULTS);
  const full = signSpan(L, {});
  assert.equal(full.maxOffset, 0, '滿寬時不能移');
  const s = signSpan(L, { width: 200, offset: 9999 });
  assert.equal(s.width, 200);
  assert.ok(s.offsetClamped);
  assert.ok(Math.abs(s.x1 - (L.W - L.t - L.tol / 2)) < 1e-6, '推到右側板');
  const left = signSpan(L, { width: 200, offset: -9999 });
  assert.ok(Math.abs(left.x0 - (L.t + L.tol / 2)) < 1e-6, '推到左側板');
  const tiny = signSpan(L, { width: 5 }, 0, 40);
  assert.equal(tiny.width, 40, '最小寬度');
  assert.ok(tiny.widthClamped);
});

test('頂端名牌左右移：頂板榫槽跟著名牌榫頭移動', () => {
  const build = (offset) => buildRack(DEFAULTS, [], { nameplate: { enabled: true, mode: 'engrave', height: 60, width: 200, offset, art } });
  const a = build(0), b = build(50);
  const slotX = (r) => r.parts.find((p) => p.kind === 'top').holes.map((h) => bbox(h.pts).minX);
  const d = slotX(b).map((x, i) => x - slotX(a)[i]);
  for (const v of d) assert.ok(Math.abs(v - 50) < 1e-6);
  const plateX = (r) => bbox(r.parts.find((p) => p.kind === 'nameplate').outer).minX;
  assert.ok(Math.abs(plateX(b) - plateX(a) - 50) < 1e-6);
  assert.equal(b.info.nameplateSpan.offset, 50);
});

test('顏料名牌全部連動：同寬、同對齊、同位移，榫槽一致', () => {
  const items = [{ on: true, art }, { on: true, art }];
  const r = buildRack({ ...DEFAULTS, kinds: 2, labelsOn: true }, [], { labels: { enabled: true, mode: 'engrave', width: 150, align: 'left', offset: 20, items } });
  const ls = r.parts.filter((p) => p.kind === 'label');
  assert.equal(ls.length, 2);
  const x0 = ls.map((p) => bbox(p.outer).minX);
  assert.ok(Math.abs(x0[0] - x0[1]) < 1e-6, '每片位置相同');
  assert.ok(Math.abs(ls[0].span.x0 - (ls[0].span.aMin + 20)) < 1e-6, '離左側板 20mm');
  for (const lab of ls) {
    const plate = r.parts.find((p) => p.kind === 'holeplate' && p.module.join() === lab.module.join() && p.holes.some((h) => h.type === 'poly'));
    const slots = plate.holes.filter((h) => h.type === 'poly').map((h) => { const b = bbox(h.pts); return (b.minX + b.maxX) / 2; });
    const tabs = [0.2, 0.8].map((f) => lab.span.x0 + lab.span.width * f);
    slots.forEach((x, i) => assert.ok(Math.abs(x - tabs[i]) < 1e-6));
  }
});

test('對齊方式：拉寬窄時對齊的那一側不動', () => {
  const L = deriveLayout(DEFAULTS);
  const l1 = signSpan(L, { width: 150, align: 'left', offset: 10 }), l2 = signSpan(L, { width: 250, align: 'left', offset: 10 });
  assert.ok(Math.abs(l1.x0 - l2.x0) < 1e-9);
  const r1 = signSpan(L, { width: 150, align: 'right', offset: 10 }), r2 = signSpan(L, { width: 250, align: 'right', offset: 10 });
  assert.ok(Math.abs(r1.x1 - r2.x1) < 1e-9);
  const c1 = signSpan(L, { width: 150, align: 'center' }), c2 = signSpan(L, { width: 250, align: 'center' });
  assert.ok(Math.abs((c1.x0 + c1.x1) - (c2.x0 + c2.x1)) < 1e-9);
  assert.equal(signSpan(L, { width: 150, align: 'left', offset: -5 }).offset, 0, '靠左不能是負值');
});

