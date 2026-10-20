import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceMask, simplifyLoop, maskToArtwork } from '../src/artwork.js';
import { signedArea, bbox } from '../src/geometry.js';
import { buildRack, resolveParams, DEFAULTS } from '../src/rack.js';
import { layoutParts, toSVG, toDXF } from '../src/export.js';

// 10×10 點陣：中間一個方框（「口」字）＋ 右下角一個點
function sampleMask() {
  const w = 10, h = 10, m = new Uint8Array(w * h);
  for (let y = 1; y <= 6; y++) for (let x = 1; x <= 6; x++) {
    const border = x === 1 || x === 6 || y === 1 || y === 6;
    if (border) m[y * w + x] = 1;
  }
  m[8 * w + 8] = 1;
  return { m, w, h };
}

test('traceMask：外框逆時針、內孔順時針，墨色在左', () => {
  const { m, w, h } = sampleMask();
  const loops = traceMask(m, w, h);
  assert.equal(loops.length, 3);
  const areas = loops.map(signedArea).sort((a, b) => a - b);
  assert.equal(areas[0], -16); // 方框中間 4×4 的洞
  assert.equal(areas[1], 1); // 右下角的點
  assert.equal(areas[2], 36); // 方框外緣 6×6
});

test('traceMask：對角相接的像素分成兩個簡單迴圈', () => {
  const m = new Uint8Array([1, 0, 0, 1]);
  const loops = traceMask(m, 2, 2);
  assert.equal(loops.length, 2);
  for (const l of loops) assert.equal(signedArea(l), 1);
});

test('simplifyLoop 把階梯狀斜邊簡化', () => {
  const stair = [];
  for (let i = 0; i < 20; i++) stair.push([i, i], [i + 1, i]);
  const loop = [...stair, [20, 20], [0, 20]];
  assert.ok(simplifyLoop(loop, 0.75).length < 10);
});

test('maskToArtwork 正規化成寬 1', () => {
  const { m, w, h } = sampleMask();
  const art = maskToArtwork(m, w, h);
  assert.equal(art.aspect, 1);
  for (const l of art.loops) for (const [x, y] of l) assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1);
});

const art = (() => { const { m, w, h } = sampleMask(); return maskToArtwork(m, w, h); })();
const withPlate = (mode) => buildRack(DEFAULTS, [], { nameplate: { enabled: true, mode, height: 60, art } });

test('名牌只在最上排模組，頂板開出對應的榫槽', () => {
  const r = buildRack({ ...DEFAULTS, racksX: 2, racksY: 2 }, [], { nameplate: { enabled: true, mode: 'engrave', height: 60, art } });
  const plates = r.parts.filter((p) => p.kind === 'nameplate');
  assert.equal(plates.length, r.info.mx);
  assert.ok(plates.every((p) => p.module[1] === r.info.my - 1));
  const top = r.parts.find((p) => p.kind === 'top');
  assert.equal(top.holes.length, 2);
  // 名牌榫頭寬 + 公差 = 頂板榫槽寬
  const plate = plates[0];
  const tabW = bbox(plate.outer.filter(([, y]) => y < -1e-6)).w;
  assert.ok(tabW > 0);
  assert.ok(r.info.nameplateH === 60);
});

test('名牌不開啟時頂板沒有榫槽', () => {
  const r = buildRack(DEFAULTS, []);
  assert.equal(r.parts.find((p) => p.kind === 'top').holes.length, 0);
  assert.equal(r.counts.nameplate, undefined);
});

test('雕刻模式：輪廓放在 engrave，不切穿', () => {
  const r = withPlate('engrave');
  const p = r.parts.find((q) => q.kind === 'nameplate');
  // 方框外緣 + 中間的洞；單一像素的雜點已被濾掉
  assert.equal(p.engrave.length, 2);
  assert.equal(p.holes.length, 0);
  const b = bbox(p.outer);
  for (const l of p.engrave) for (const [x, y] of l) assert.ok(x > b.minX && x < b.maxX && y > 0 && y < b.maxY);
});

test('鏤空模式：外框變成孔、內島略過並警告', () => {
  const r = withPlate('cut');
  const p = r.parts.find((q) => q.kind === 'nameplate');
  // 方框外緣 + 小點（小點 < 銑刀直徑時會被略過）
  assert.ok(p.holes.length >= 1);
  assert.ok(p.holes.every((h) => signedArea(h.pts) < 0), '孔為順時針');
  assert.ok(r.warnings.some((w) => w.includes('內島')));
});

test('雷射模式：SVG 內嵌點陣並保留位置，DXF 有 ENGRAVE 圖層', () => {
  const r = withPlate('laser');
  const lay = layoutParts(r.parts, r.params);
  const svg = toSVG(lay, 'data:image/png;base64,AAAA');
  assert.match(svg, /<image href="data:image\/png;base64,AAAA"[^>]*transform="matrix\(/);
  assert.match(svg, /<g id="engrave"/);
  assert.match(toDXF(lay), /\nENGRAVE\n/);
  // 沒給點陣時不輸出 image
  assert.doesNotMatch(toSVG(lay), /<image/);
});

test('罐頂到上層距離：自動 = 固定孔板高度 + 5，太小會被調高', () => {
  const a = resolveParams(DEFAULTS);
  assert.equal(a.P.topGap, a.P.retainHeight + 5);
  assert.equal(a.fields.topGap.auto, true);
  const b = resolveParams({ ...DEFAULTS, topGap: 3 });
  assert.equal(b.fields.topGap.adjusted, true);
  assert.equal(b.P.topGap, b.P.retainHeight + 2);
  const c = resolveParams({ ...DEFAULTS, topGap: 80 });
  assert.equal(c.P.topGap, 80);
  assert.equal(c.fields.topGap.adjusted, false);
  // 列距 = 板厚 + 罐高 + 罐頂到上層距離
  const r = buildRack({ ...DEFAULTS, topGap: 80 }, []);
  assert.equal(r.info.rowPitch, DEFAULTS.thickness + DEFAULTS.canHeight + 80);
});
