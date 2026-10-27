import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRack, DEFAULTS, deriveLayout } from '../src/types/slant-bottle.js';
import * as can from '../src/types/paint-can.js';
import { autoMounts } from '../src/system/frame.js';
import { layoutParts, toDXF } from '../src/export.js';
import { maskToArtwork } from '../src/artwork.js';
import { bbox } from '../src/geometry.js';

test('預設：39×100 的瓶子、尖嘴朝下 15°、露出 30mm，沒有警告', () => {
  const r = buildRack(DEFAULTS, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.params.tilt, 15);
  assert.equal(r.layout.stickOut, 30);
  assert.equal(r.items.length, DEFAULTS.kinds * DEFAULTS.perKind);
  assert.equal(r.info.capacity, 36);
});

test('瓶底頂在背板前面，瓶身穿過前後孔的中心', () => {
  const L = deriveLayout(DEFAULTS);
  const th = (L.P.tilt * Math.PI) / 180;
  // 瓶底斜面最後面那一點剛好在背板前面
  assert.ok(L.zb - (L.P.bottleDia / 2) * Math.sin(th) >= L.zs - 1e-6);
  // 軸線：前孔條中間平面 → 後孔條中間平面，高度差 = 前後距離 × tan
  const [zb, yb] = L.bottleBase(L.holeY[0]);
  const yAt = (z) => yb - (z - zb) * Math.tan(th);
  assert.ok(Math.abs(yAt(L.zf + L.t / 2) - L.holeY[0]) < 1e-6);
  assert.ok(Math.abs(yAt(L.zr + L.t / 2) - L.rearY[0]) < 1e-6);
  // 孔夠大：斜著穿過板厚也不卡
  const R = (L.P.bottleDia + L.P.holeClearance) / 2;
  assert.ok(L.b >= R / Math.cos(th) + (L.t * Math.tan(th)) / 2 - 1e-6);
});

test('上下兩列的瓶子不會互相碰到，孔之間留得下木料', () => {
  const L = deriveLayout({ ...DEFAULTS, tilt: 30, canGap: 4 });
  const th = (L.P.tilt * Math.PI) / 180;
  assert.ok(L.rowPitch * Math.cos(th) >= L.P.bottleDia);
  assert.ok(L.pitch - L.holeW >= 2 - 1e-6);
  assert.ok(L.frontH - 2 * L.b >= 2 * L.P.web - 1e-6);
});

test('後孔條避開左右鎖點螺栓，也在連接板的高度之下', () => {
  for (const p of [DEFAULTS, { ...DEFAULTS, bottleLen: 160 }, { ...DEFAULTS, thickness: 6, bolt: 'M4' }]) {
    const L = deriveLayout(p);
    const r = L.P.lockHoleDia / 2;
    assert.ok(L.zr + L.t + L.tol / 2 < L.lockZ - r - 2 + 1e-6 || L.zr - L.tol / 2 > L.lockZ + r + 2 - 1e-6, `zr ${L.zr} lockZ ${L.lockZ}`);
    const rearTop = L.rearY[L.rows - 1] + L.rearH / 2;
    assert.ok(rearTop <= L.H - L.spliceDown + 1e-6);
  }
});

test('跟顏料罐架用同一套接合：卡扣、連接板、鎖點的前後位置一樣，同寬就疊得起來', () => {
  const shared = { thickness: 9, tolerance: 0.2, bolt: 'M6', moduleW: 600 };
  const a = can.deriveLayout({ ...can.DEFAULTS, ...shared });
  const b = deriveLayout({ ...DEFAULTS, ...shared });
  for (const k of ['clipZ', 'spliceZ', 'spliceBoltZ', 'lockZ', 'spliceBoltUp', 'notchW', 'nd', 'e', 'inset']) {
    assert.deepEqual(b[k], a[k], k);
  }
  assert.equal(a.W, 600);
  assert.equal(b.W, 600);
});

test('瓶子太短：前孔條往前移到放得下連接板，並說明露出長度', () => {
  const r = buildRack({ ...DEFAULTS, bottleLen: 50 }, []);
  assert.ok(r.layout.sideDepth >= r.params.needDepth - 1e-6);
  assert.ok(r.warnings.some((w) => w.includes('露出長度')));
});

test('開名牌：每一列的前孔條各自刻字，刻在孔的上方', () => {
  const m = new Uint8Array(100);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) m[y * 10 + x] = 1;
  const art = maskToArtwork(m, 10, 10);
  const items = Array.from({ length: 6 }, (_, k) => ({ on: k !== 2, art }));
  const r = buildRack({ ...DEFAULTS, labelsOn: true }, [], { labels: { enabled: true, mode: 'engrave', items } });
  const fronts = r.parts.filter((p) => p.kind === 'front');
  assert.equal(fronts.filter((p) => p.artKey).length, 5);
  const L = r.layout;
  for (const p of fronts.filter((q) => q.artRect)) assert.ok(p.artRect.y >= L.P.web + 2 * L.b - 1e-6);
});

test('零件都放得進板材，DXF 可以匯出；雷射也一樣', () => {
  for (const p of [DEFAULTS, { ...DEFAULTS, machine: 'laser', bit: '0', sheet: '900x600' }, { ...DEFAULTS, kinds: 14, perKind: 12 }]) {
    const r = buildRack(p, [{ id: 1, x: 80, y: 300 }]);
    const lay = layoutParts(r.parts, r.params);
    assert.deepEqual(lay.warnings, []);
    assert.ok(toDXF(lay).includes('CUT_OUTSIDE'));
    for (const part of r.parts) assert.ok(bbox(part.outer).w > 0);
  }
});

test('隨機參數都能產生零件', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 40; k++) {
    const p = {
      ...DEFAULTS, thickness: 3 + rnd() * 15, bottleDia: 15 + rnd() * 60, bottleLen: 40 + rnd() * 160,
      tilt: Math.round(rnd() * 40), kinds: 1 + Math.floor(rnd() * 10), perKind: 1 + Math.floor(rnd() * 10),
    };
    const r = buildRack(p, []);
    assert.ok(r.parts.length > 0);
    assert.ok(Number.isFinite(r.info.width) && Number.isFinite(r.info.height));
  }
});

test('掛點不能在瓶底後面（螺絲頭會被瓶底壓到）；預設掛點都可以用', () => {
  const L = deriveLayout(DEFAULTS);
  const [, yb] = L.bottleBase(L.holeY[1]);
  const r = buildRack(DEFAULTS, [{ id: 1, x: L.holeX[2], y: yb }]);
  assert.equal(r.mounts[0].valid, false);
  assert.match(r.mounts[0].reason, /瓶底/);
  const auto = autoMounts(L).map((m, k) => ({ id: k + 1, ...m }));
  assert.ok(buildRack(DEFAULTS, auto).mounts.every((m) => m.valid));
});
