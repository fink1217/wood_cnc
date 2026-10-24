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

// 層板前緣（z = depth）往內凹的開口槽數：兩片側板之間、從前緣往內走的槽壁
function frontNotchCount(part, L) {
  const pts = part.outer;
  let n = 0;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    const inside = a[0] > L.t + 1 && a[0] < L.W - L.t - 1;
    if (inside && Math.abs(a[1] - L.depth) < 1e-6 && b[1] < L.depth - 1 && Math.abs(a[0] - b[0]) < 1e-6) n++;
  }
  return n;
}

const labels = (items, mode = 'engrave') => ({ enabled: true, mode, height: 18, items });

test('每種顏料各一片名牌，可各自關閉', () => {
  const items = Array.from({ length: DEFAULTS.kinds }, (_, k) => ({ on: k !== 2, art }));
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels(items) });
  const ls = r.parts.filter((p) => p.kind === 'label');
  assert.equal(ls.length, (DEFAULTS.kinds - 1) * r.info.mx);
  assert.ok(!ls.some((p) => p.labelKind === 2), '關閉的第 3 種沒有名牌');
  // 有名牌的列：層板前緣多兩個開口槽；孔板完全不動
  const notched = r.parts.filter((p) => p.kind === 'shelf' && frontNotchCount(p, r.layout) === 2);
  assert.equal(notched.length, ls.length);
  assert.ok(r.parts.filter((p) => p.kind === 'holeplate').every((p) => p.holes.every((h) => h.type === 'circle')), '孔板沒有名牌榫槽');
});

test('顏料名牌開啟時前緣留邊自動加寬，名牌整片收在層板前緣之內', () => {
  const off = resolveParams(DEFAULTS);
  const on = resolveParams({ ...DEFAULTS, labelsOn: true });
  assert.ok(on.P.frontMargin >= off.P.frontMargin);
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels([{ on: true, art }]) });
  const L = r.layout;
  assert.ok(L.labelZ >= L.holeZ + L.holeD / 2 + 2 - 1e-9, '罐孔前留 2mm');
  assert.ok(L.depth - (L.labelZ + L.t + L.tol) >= 0, '名牌不凸出層板前緣');
  const tight = resolveParams({ ...DEFAULTS, labelsOn: true, frontMargin: 0 });
  assert.equal(tight.fields.frontMargin.adjusted, true);
});

test('顏料名牌從正面插進層板前緣、站在孔板下方，可往前拔出', () => {
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels([{ on: true, art }]) });
  const L = r.layout;
  const p = r.parts.find((q) => q.kind === 'label');
  const can = r.cans.find((c) => c.kind === 0);
  assert.ok(p.origin[2] > can.z + can.r, '在罐子前面');
  const shelfTop = L.shelfY[0] + L.t, plateBottom = L.holePlateY[0];
  assert.ok(Math.abs(p.origin[1] - shelfTop) < 1e-9, '站在層板頂面');
  const b = bbox(p.outer);
  assert.ok(Math.abs(b.minY + L.t) < 1e-6, '下緣榫頭穿過層板');
  assert.ok(p.origin[1] + b.maxY < plateBottom, '頂端在孔板下緣之下，不卡手');
  // 層板的開口槽從前緣一路開到名牌背面：往前沒有任何東西擋住
  const shelf = r.parts.find((q) => q.kind === 'shelf' && Math.abs(q.origin[1] - shelfTop) < 1e-9);
  assert.equal(frontNotchCount(shelf, L), 2);
  assert.ok(shelf.outer.some(([x, z]) => Math.abs(z - L.labelZ) < 1e-6 && x > L.t && x < L.W - L.t), '槽底就是名牌的定位面');
});

test('顏料名牌高度只改名牌本身，最高到孔板下緣', () => {
  const base = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: { ...labels([{ on: true, art }]), height: 8 } });
  const tall = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: { ...labels([{ on: true, art }]), height: 999 } });
  assert.equal(base.layout.retain, tall.layout.retain, '孔板高度不變');
  assert.equal(base.layout.P.topGap, tall.layout.P.topGap, '罐頂距離不變');
  assert.equal(base.info.labelH, 8);
  assert.equal(tall.info.labelH, tall.info.labelHMax, '被限制在孔板下緣');
  assert.ok(tall.warnings.some((w) => w.includes('孔板下緣')));
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

test('顏料名牌全部連動：同寬、同對齊、同位移，開口槽一致', () => {
  const items = [{ on: true, art }, { on: true, art }];
  const r = buildRack({ ...DEFAULTS, kinds: 2, labelsOn: true }, [], { labels: { enabled: true, mode: 'engrave', width: 150, align: 'left', offset: 20, items } });
  const ls = r.parts.filter((p) => p.kind === 'label');
  assert.equal(ls.length, 2);
  const x0 = ls.map((p) => bbox(p.outer).minX);
  assert.ok(Math.abs(x0[0] - x0[1]) < 1e-6, '每片位置相同');
  assert.ok(Math.abs(ls[0].span.x0 - (ls[0].span.aMin + 20)) < 1e-6, '離左側板 20mm');
  const shelf = r.parts.find((p) => p.kind === 'shelf' && frontNotchCount(p, r.layout) === 2);
  // 槽底（z = labelZ）上的點依 x 分群，每群的中心就是一個開口槽的中心
  const xs = shelf.outer.filter(([, z]) => Math.abs(z - r.layout.labelZ) < 1e-6).map(([x]) => x).sort((a, b) => a - b);
  const groups = [];
  for (const x of xs) (groups.length && x - groups.at(-1).at(-1) < 25 ? groups.at(-1) : groups[groups.push([]) - 1]).push(x);
  const centers = groups.map((g) => (g[0] + g.at(-1)) / 2);
  const tabs = [0.2, 0.8].map((f) => ls[0].span.x0 + ls[0].span.width * f);
  assert.equal(centers.length, 2);
  centers.forEach((c, i) => assert.ok(Math.abs(c - tabs[i]) < 1e-6, '開口槽中心對準名牌榫頭'));
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

