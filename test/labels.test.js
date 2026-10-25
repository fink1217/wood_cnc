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

test('每種顏料各一片名牌，可各自關閉；放罐子的板材完全不動', () => {
  const items = Array.from({ length: DEFAULTS.kinds }, (_, k) => ({ on: k !== 2, art }));
  const off = buildRack(DEFAULTS, []);
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels(items) });
  const ls = r.parts.filter((p) => p.kind === 'label');
  assert.equal(ls.length, (DEFAULTS.kinds - 1) * r.info.mx);
  assert.ok(!ls.some((p) => p.labelKind === 2), '關閉的第 3 種沒有名牌');
  // 層板、孔板與沒開名牌時一模一樣
  for (const kind of ['shelf', 'holeplate']) {
    const a = off.parts.find((p) => p.kind === kind), b = r.parts.find((p) => p.kind === kind);
    assert.deepEqual(b.outer, a.outer, `${kind} 外形不變`);
    assert.equal(b.holes.length, a.holes.length, `${kind} 開孔不變`);
  }
  assert.equal(r.layout.retain, off.layout.retain);
});

test('顏料名牌開啟時側板往前加深，名牌板在層板與孔板前方', () => {
  const off = deriveLayout(DEFAULTS), on = deriveLayout({ ...DEFAULTS, labelsOn: true });
  assert.equal(on.depth, off.depth, '放罐子的板材深度不變');
  assert.ok(on.sideDepth > on.depth, '側板往前加深');
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels([{ on: true, art }]) });
  const p = r.parts.find((q) => q.kind === 'label');
  assert.ok(p.origin[2] > r.layout.depth, '在層板／孔板前方');
  assert.ok(p.origin[2] + r.layout.t <= r.layout.sideDepth, '不凸出側板前緣');
  assert.equal(r.info.depth, r.layout.sideDepth);
});

test('顏料名牌兩端插進左右側板前緣的開口槽，可往前拔出', () => {
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels([{ on: true, art }]) });
  const L = r.layout;
  const p = r.parts.find((q) => q.kind === 'label');
  const b = bbox(p.outer);
  assert.ok(Math.abs(b.minX) < 1e-6 && Math.abs(b.maxX - L.W) < 1e-6, '兩端伸進側板厚度、與外面齊平');
  assert.ok(Math.abs(p.origin[1] - L.shelfY[0]) < 1e-9, '下緣對齊層板底面');
  // 側板前緣（z = sideDepth）在這一列有往內的開口槽，槽底 = 名牌背面
  const side = r.parts.find((q) => q.kind === 'side');
  const atFront = side.outer.filter(([z, y]) => Math.abs(z - L.sideDepth) < 1e-6 && y > L.shelfY[0] - 1 && y < L.shelfY[0] + 30);
  assert.ok(atFront.length >= 2, '槽口在側板前緣');
  assert.ok(side.outer.some(([z, y]) => Math.abs(z - (L.labelZ - L.tol / 2)) < 1e-6 && Math.abs(y - (L.shelfY[0] - L.tol / 2)) < 0.5), '槽底在名牌背面');
});

test('顏料名牌低於孔板時不影響其他零件；高過孔板時罐頂距離自動加大', () => {
  const mk = (labelH) => buildRack({ ...DEFAULTS, labelsOn: true, labelH }, [], { labels: labels([{ on: true, art }]) });
  const base = buildRack(DEFAULTS, []);
  const low = mk(20), high = mk(50), huge = mk(9999);
  const dflt = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels([{ on: true, art }]) });
  assert.equal(dflt.layout.P.topGap, base.layout.P.topGap, '預設名牌不改罐頂距離');
  const L = low.layout;
  assert.equal(low.info.labelH, 20);
  assert.equal(low.layout.P.topGap, base.layout.P.topGap, '名牌頂端低於孔板：罐頂距離不變');
  assert.equal(low.layout.retain, base.layout.retain, '孔板高度一律不變');
  assert.equal(high.layout.retain, base.layout.retain);
  // 名牌 50mm：罐子要提起 50 - 板厚 + 2，再多 8mm 才好拿
  assert.equal(high.layout.P.topGap, 50 - L.t + 2 + 8);
  assert.ok(high.layout.P.topGap > base.layout.P.topGap, '自動抬高');
  assert.match(high.layout.fields.topGap.note, /名牌/);
  assert.equal(huge.info.labelH, L.t + DEFAULTS.canHeight, '最高到罐頂');
  assert.ok(huge.warnings.some((w) => w.includes('罐頂')));
  // 手動把罐頂距離設小也會被拉回
  const manual = resolveParams({ ...DEFAULTS, labelsOn: true, labelH: 50, topGap: 10 });
  assert.equal(manual.P.topGap, 50 - L.t + 2 + 8);
  assert.equal(manual.fields.topGap.adjusted, true);
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

test('顏料名牌全部連動：文字區同寬、同對齊、同位移', () => {
  const items = [{ on: true, art }, { on: true, art }];
  const r = buildRack({ ...DEFAULTS, kinds: 2, labelsOn: true }, [], { labels: { enabled: true, mode: 'engrave', width: 150, align: 'left', offset: 20, items } });
  const ls = r.parts.filter((p) => p.kind === 'label');
  assert.equal(ls.length, 2);
  assert.ok(Math.abs(ls[0].span.x0 - ls[1].span.x0) < 1e-6);
  assert.ok(Math.abs(ls[0].span.x0 - (ls[0].span.aMin + 20)) < 1e-6, '文字區離左側板 20mm');
  for (const p of ls) {
    assert.ok(p.artRect.x >= p.span.x0 - 1e-6 && p.artRect.x + p.artRect.w <= p.span.x1 + 1e-6, '圖案在文字區內');
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

