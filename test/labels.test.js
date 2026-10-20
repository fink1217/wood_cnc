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

test('名牌立在罐子前方、孔板上方，不擋取罐', () => {
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: labels([{ on: true, art }]) });
  const L = r.layout;
  const p = r.parts.find((q) => q.kind === 'label');
  const can = r.cans.find((c) => c.kind === 0);
  assert.ok(p.origin[2] > can.z + can.r, '在罐子前面');
  const holePlateTop = L.holePlateY[0] + L.t;
  assert.ok(Math.abs(p.origin[1] - holePlateTop) < 1e-9, '站在孔板頂面');
  assert.ok(holePlateTop + 18 < L.shelfY[0] + L.rowPitch, '低於上一層');
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
