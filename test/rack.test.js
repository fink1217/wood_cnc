import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dogbone, keyholeCW, rectCW, signedArea, bbox } from '../src/geometry.js';
import { buildRack, deriveLayout, autoMounts, validateMount, resolveParams, DEFAULTS } from '../src/rack.js';
import { layoutParts, toSVG, toDXF, toBOM } from '../src/export.js';

const GRID = { ...DEFAULTS, maxCols: 6, maxRows: 3 }; // 2×2 模組

test('dogbone 在矩形孔的四個角加入清角弧', () => {
  const hole = rectCW(0, 0, 10, 20);
  const out = dogbone(hole, 1.5);
  assert.ok(out.length > 4 * 10);
  // 清角弧必須通過原本的角點附近（圓心距角點 = r）
  for (const [cx, cy] of [[0, 0], [0, 20], [10, 20], [10, 0]]) {
    const near = Math.min(...out.map(([x, y]) => Math.hypot(x - cx, y - cy)));
    assert.ok(near < 0.6, `corner ${cx},${cy} not cleared (${near})`);
  }
  assert.ok(signedArea(out) < 0, '孔維持順時針');
});

test('外輪廓凸角不加狗骨頭', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(dogbone(sq, 1.5).length, 4);
});

test('鑰匙孔為順時針且尺寸正確', () => {
  const k = keyholeCW(0, 0, 5, 2.5, 10);
  assert.ok(signedArea(k) < 0);
  const b = bbox(k);
  assert.ok(Math.abs(b.minY + 5) < 0.1 && Math.abs(b.maxY - 12.5) < 0.1);
  assert.ok(Math.abs(b.w - 10) < 0.1);
});

test('2×2 模組：格數與容量', () => {
  const L = deriveLayout(GRID);
  assert.equal(L.mx, 2);
  assert.equal(L.my, 2);
  const r = buildRack(GRID, autoMounts(L).map((m, i) => ({ ...m, id: i + 1 })));
  assert.deepEqual(r.warnings, []);
  assert.ok(r.info.capacity >= r.info.required);
  assert.equal(r.counts.side, 8);
  assert.equal(r.counts.capside, 4, '每欄一組頂蓋');
  assert.equal(r.counts.clip, 2 * 4 + 2, '1 條垂直接縫 × 2 列 × 上下 2 + 頂蓋下緣 2');
  assert.equal(r.counts.splice, 2 * 2 * 2, '每欄 2 條接縫（含頂蓋）× 左右');
  assert.equal(r.cans.length, GRID.kinds * GRID.perKind);
  assert.ok(r.mounts.every((m) => m.valid));
  const keyholes = r.parts.flatMap((p) => p.holes).filter((h) => h.mount != null);
  assert.equal(keyholes.length, r.mounts.length);
});

test('上下接縫處仍是完整罐位：列距在整個高度上一致', () => {
  const r = buildRack({ ...DEFAULTS, racksY: 2 }, []);
  const L = r.layout;
  const shelves = r.parts.filter((p) => p.kind === 'shelf' && p.module[0] === 0).map((p) => p.origin[1]).sort((a, b) => a - b);
  for (let k = 1; k < shelves.length; k++) assert.ok(Math.abs(shelves[k] - shelves[k - 1] - L.rowPitch) < 1e-6, `第 ${k} 個間距`);
  // 最上一列的天花板 = 頂蓋頂板底面
  const cap = r.parts.find((p) => p.kind === 'top');
  assert.ok(Math.abs(cap.origin[1] - L.t - (shelves.at(-1) + L.rowPitch - L.t)) < 1e-6);
});

test('接縫處的連接板與卡扣腳都在罐子旁邊，不擋罐位', () => {
  const r = buildRack({ ...DEFAULTS, racksX: 2, racksY: 2 }, []);
  const L = r.layout;
  const can = r.cans.reduce((a, c) => (c.x < a.x ? c : a));
  const canLeft = can.x - can.r;
  assert.ok(canLeft - L.t >= L.t + 1, '最左邊的罐子與側板內面之間放得下連接板');
  assert.ok(canLeft - L.t >= L.clipLegW + 1, '也放得下卡扣腳');
  // 接縫下方的連接板與卡扣腳都在最上一列孔板之上
  assert.ok(L.H - L.spliceDown > L.holePlateY.at(-1) + L.t);
  assert.ok(L.H - L.nd - L.clipLeg > L.holePlateY.at(-1) + L.t);
});

test('所有孔都在零件外框內', () => {
  const r = buildRack(DEFAULTS, []);
  for (const p of r.parts) {
    for (const h of p.holes) {
      const hb = h.type === 'circle'
        ? { minX: h.c[0] - h.r, maxX: h.c[0] + h.r, minY: h.c[1] - h.r, maxY: h.c[1] + h.r }
        : bbox(h.pts);
      assert.ok(hb.minX > p.bounds.minX && hb.maxX < p.bounds.maxX && hb.minY > p.bounds.minY && hb.maxY < p.bounds.maxY, `${p.name} 孔超出外框`);
    }
  }
});

test('榫頭寬度 + 公差 = 榫槽寬度', () => {
  const P = { ...DEFAULTS, bit: '0', tolerance: 0.3 };
  const r = buildRack(P, []);
  const L = r.layout;
  const side = r.parts.find((p) => p.kind === 'side');
  const slot = bbox(side.holes[0].pts);
  assert.ok(Math.abs(slot.w - (L.tabL + 0.3)) < 1e-6);
  assert.ok(Math.abs(slot.h - (L.t + 0.3)) < 1e-6);
});

test('掛點落在側板或榫槽上時判定無效', () => {
  const L = deriveLayout(DEFAULTS);
  assert.equal(validateMount(L, 2, 200).valid, false);
  assert.equal(validateMount(L, L.backTabs[0], L.shelfY[1] + 5).valid, false);
  assert.equal(validateMount(L, -10, 10).valid, false);
});

test('單一模組：沒有卡扣，只有與頂蓋之間的連接板', () => {
  const r = buildRack({ ...DEFAULTS, kinds: 2, perKind: 3 }, []);
  assert.equal(r.info.mx, 1);
  assert.equal(r.info.my, 1);
  assert.equal(r.counts.clip, undefined);
  assert.equal(r.counts.splice, 2);
  assert.equal(r.counts.capside, 2);
});

test('匯出 SVG / DXF / BOM', () => {
  const r = buildRack(GRID, autoMounts(deriveLayout(GRID)).map((m, i) => ({ ...m, id: i + 1 })));
  const lay = layoutParts(r.parts, r.params);
  assert.equal(lay.sheets.reduce((n, s) => n + s.items.length, 0), r.parts.length);
  for (const s of lay.sheets) {
    for (const it of s.items) {
      assert.ok(it.x >= 0 && it.y >= 0 && it.x + it.flat.w <= r.params.sheetW && it.y + it.flat.h <= r.params.sheetH);
    }
  }
  const svg = toSVG(lay);
  assert.match(svg, /^<\?xml/);
  assert.equal((svg.match(/<path/g) || []).length > r.parts.length, true);
  const dxf = toDXF(lay);
  assert.match(dxf, /EOF\n$/);
  assert.equal((dxf.match(/\nPOLYLINE\n/g) || []).length > r.parts.length, true);
  assert.match(toBOM(r), /側板,8/);
});

test('ZIP 打包可被 unzip 讀取', async () => {
  const { makeZip } = await import('../src/export.js');
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const file = path.join(dir, 'a.zip');
  fs.writeFileSync(file, makeZip([{ name: '側板.dxf', data: '0\nEOF\n' }, { name: 'b.txt', data: 'hello' }]));
  try {
    const out = execFileSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(), z.namelist())', file]).toString();
    assert.match(out, /None/);
    assert.match(out, /側板\.dxf/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('進階參數預設全部自動，且會隨基本參數連動', () => {
  const a = resolveParams(DEFAULTS);
  assert.ok(Object.values(a.fields).every((f) => f.auto));
  const b = resolveParams({ ...DEFAULTS, canHeight: 120 });
  assert.ok(b.P.retainHeight > a.P.retainHeight, '孔板高度跟隨罐高');
  const c = resolveParams({ ...DEFAULTS, thickness: 18 });
  assert.ok(c.P.margin > a.P.margin, '邊距跟隨板厚');
  assert.ok(c.P.retainHeight >= 18 + 0.2 + 3);
});

test('衝突的手動值會被調整並附上原因', () => {
  const r = resolveParams({ ...DEFAULTS, retainHeight: 2, canGap: 0, partGap: 1 });
  assert.equal(r.fields.retainHeight.adjusted, true);
  assert.equal(r.P.retainHeight, 9 + 0.2 + 3);
  assert.match(r.fields.retainHeight.note, /改成/);
  assert.ok(r.P.canGap >= r.P.holeClearance + 2);
  assert.ok(r.P.partGap > r.P.bitDia);
});

test('模組自動限制在板材內', () => {
  const r = buildRack({ ...DEFAULTS, perKind: 40, kinds: 20, sheet: '600x600' }, []);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.info.moduleW <= 600 && r.info.moduleH <= 600);
  const lay = layoutParts(r.parts, r.params);
  assert.deepEqual(lay.warnings, []);
});

test('手動欄數過大時被限制在板材寬度內', () => {
  const r = resolveParams({ ...DEFAULTS, sheet: '600x600', maxCols: 40 });
  assert.equal(r.fields.maxCols.adjusted, true);
  assert.ok(r.P.maxCols < 40);
});

test('隨機參數組合都能產生零件且無例外', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 200; k++) {
    const input = {
      thickness: 3 + rnd() * 25, tolerance: rnd() * 1, canDia: 10 + rnd() * 150, canHeight: 15 + rnd() * 200,
      kinds: 1 + Math.floor(rnd() * 15), perKind: 1 + Math.floor(rnd() * 15),
      bit: ['0', '3.175', '6', '6.35'][k % 4], sheet: ['1220x2440', '910x1820', '600x900', '600x600'][k % 4],
    };
    const r = buildRack(input, autoMounts(deriveLayout(input)).map((m, i) => ({ ...m, id: i + 1 })));
    assert.ok(r.parts.length > 0);
    assert.ok(r.info.capacity >= r.info.required);
    for (const p of r.parts) assert.ok(p.outer.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), p.name);
  }
});

test('多架組裝：模組、連接件、罐數與五金都跟著倍增', () => {
  const one = buildRack(DEFAULTS, []);
  const many = buildRack({ ...DEFAULTS, racksX: 3, racksY: 2 }, []);
  assert.equal(many.info.mx, one.info.mx * 3);
  assert.equal(many.info.my, one.info.my * 2);
  assert.equal(many.cans.length, one.cans.length * 6);
  assert.equal(many.counts.clip, (3 - 1) * 2 * 4 + (3 - 1) * 2);
  assert.equal(many.counts.splice, 3 * 2 * 2);
  const bolts = many.info.hardware.filter((h) => h.name.includes('螺栓')).reduce((n, h) => n + h.qty, 0);
  assert.equal(bolts, (3 - 1) * 2 * many.info.rows + 3 * 2 * 8);
});

test('垂直連接板螺栓孔與上下模組側板的孔對齊', () => {
  const r = buildRack({ ...DEFAULTS, racksY: 2 }, []);
  const world = (p, [u, v]) => p.origin.map((o, k) => o + u * p.U[k] + v * p.V[k]);
  const splice = r.parts.find((p) => p.kind === 'splice');
  const sides = r.parts.filter((p) => p.kind === 'side');
  for (const h of splice.holes) {
    const w = world(splice, h.c);
    const match = sides.some((sd) => sd.holes.some((sh) => {
      if (sh.type !== 'circle') return false;
      const q = world(sd, sh.c);
      return Math.abs(q[1] - w[1]) < 1e-6 && Math.abs(q[2] - w[2]) < 1e-6 && Math.abs(Math.abs(q[0] - w[0]) - r.layout.t) < 1e-6;
    }));
    assert.ok(match, `連接板孔 ${w} 沒有對到側板孔`);
  }
});

test('連接板不碰到卡扣腳與背板', () => {
  const L = deriveLayout(DEFAULTS);
  assert.ok(L.spliceZ[0] > L.clipZ[0] + L.t / 2, '在後卡扣之前');
  assert.ok(L.spliceZ[1] < L.clipZ[1] - L.t / 2, '在前卡扣之後');
  assert.ok(L.spliceZ[0] > 2 * L.t, '在背板前方');
});

test('板材計算機連結帶入尺寸、張數、板厚', async () => {
  const { calculatorUrl } = await import('../src/calculator-link.js');
  const u = new URL(calculatorUrl({ sheetW: 600, sheetH: 900, count: 3, thickness: 9 }));
  assert.equal(u.searchParams.get('mode'), 'piece');
  assert.equal(u.searchParams.get('w'), '600');
  assert.equal(u.searchParams.get('n'), '3');
  assert.equal(u.searchParams.get('t'), '9');
});
