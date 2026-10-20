// 參數化顏料罐木架：產生所有 CNC 零件的 2D 輪廓與 3D 擺放資訊（不依賴 three.js）。
//
// 世界座標 (mm)：X = 寬（左→右）、Y = 高（下→上）、Z = 深（牆面 z=0 往外）。
// 每個模組 = 左右側板 + 背板 + 每列（層板 + 固定孔板）+ 頂板。
// 模組之間：水平延伸用 U 型卡扣（側板上下緣卡槽）+ 螺栓鎖點孔；
//           垂直堆疊用垂直連接板（貼在上下側板內側，螺栓鎖緊）。
// 所有模組都切出延伸槽，日後可隨時再往旁邊或上方擴充。

import { dogbone, rectCW, keyholeCW, bbox, rectsOverlap } from './geometry.js';

// 參數分三層：
//   基本（6 個數字）→ 加工與五金（4 個下拉選單）→ 進階（預設全部「自動」，依前兩層連動計算）。
// 進階欄位值為 null 代表自動；使用者輸入值若與其他參數衝突，會被自動調整並附上原因。

export const DEFAULTS = {
  thickness: 9,
  tolerance: 0.2,
  canDia: 45,
  canHeight: 55,
  kinds: 6,
  perKind: 8,
  bit: '3.175',
  sheet: '1220x2440',
  screw: '4',
  bolt: 'M6',
  racksX: 1,
  racksY: 1,
  canGap: null,
  holeClearance: null,
  retainHeight: null,
  topGap: null,
  frontMargin: null,
  margin: null,
  maxCols: null,
  maxRows: null,
  bitDia: null,
  sheetW: null,
  sheetH: null,
  partGap: null,
  gridSnap: null,
};

export const BASIC_SPEC = [
  { key: 'thickness', label: '木頭厚度', unit: 'mm', min: 3, max: 30, step: 0.5 },
  { key: 'tolerance', label: '組裝公差', unit: 'mm', min: 0, max: 1.5, step: 0.05, hint: '緊 0.1 · 標準 0.2 · 鬆 0.35' },
  { key: 'canDia', label: '顏料罐直徑', unit: 'mm', min: 10, max: 200, step: 0.5 },
  { key: 'canHeight', label: '顏料罐高度', unit: 'mm', min: 10, max: 300, step: 1 },
  { key: 'kinds', label: '預計放幾種', unit: '種', min: 1, max: 60, step: 1, int: true },
  { key: 'perKind', label: '每種放幾罐', unit: '罐', min: 1, max: 60, step: 1, int: true },
];

export const CHOICE_SPEC = [
  { key: 'bit', label: '銑刀', options: [['0', '不清角'], ['3.175', '1/8″ (3.175)'], ['6', '6 mm'], ['6.35', '1/4″ (6.35)']] },
  { key: 'sheet', label: 'CNC 板材', options: [['1220x2440', '4×8 尺 (1220×2440)'], ['1220x3050', '4×10 尺 (1220×3050)'], ['915x1830', '3×6 尺 (915×1830)'], ['915x2135', '3×7 尺 (915×2135)'], ['600x900', 'CNC 小板 600×900'], ['600x600', 'CNC 小板 600×600']] },
  { key: 'screw', label: '掛牆螺絲', options: [['3.5', '3.5 mm'], ['4', '4 mm'], ['5', '5 mm']] },
  { key: 'bolt', label: '連接螺栓', options: [['M4', 'M4'], ['M5', 'M5'], ['M6', 'M6']] },
];

// 放在基本區、但可自動連動的欄位（空白 = 自動）
export const LINKED_BASIC_SPEC = [
  { key: 'topGap', label: '罐頂到上層距離', unit: 'mm', min: 0, max: 300, step: 1 },
];

export const ASSEMBLY_SPEC = [
  { key: 'racksX', label: '水平並排幾架', unit: '架', min: 1, max: 8, step: 1, int: true },
  { key: 'racksY', label: '垂直堆疊幾架', unit: '架', min: 1, max: 8, step: 1, int: true },
];

export const ADVANCED_SPEC = [
  { key: 'canGap', label: '罐間距', unit: 'mm', min: 0, max: 40, step: 0.5 },
  { key: 'holeClearance', label: '罐孔餘隙', unit: 'mm', min: 0, max: 10, step: 0.1 },
  { key: 'retainHeight', label: '固定孔板高度', unit: 'mm', min: 0, max: 200, step: 1 },
  { key: 'frontMargin', label: '前緣留邊', unit: 'mm', min: 0, max: 100, step: 1 },
  { key: 'margin', label: '側板上下邊距', unit: 'mm', min: 0, max: 80, step: 1 },
  { key: 'maxCols', label: '每模組最多欄', unit: '罐', min: 1, max: 40, step: 1, int: true },
  { key: 'maxRows', label: '每模組最多列', unit: '列', min: 1, max: 20, step: 1, int: true },
  { key: 'bitDia', label: '銑刀直徑', unit: 'mm', min: 0, max: 12.7, step: 0.05 },
  { key: 'sheetW', label: '板材寬', unit: 'mm', min: 200, max: 3000, step: 10 },
  { key: 'sheetH', label: '板材長', unit: 'mm', min: 200, max: 5000, step: 10 },
  { key: 'partGap', label: '排版間距', unit: 'mm', min: 0, max: 50, step: 1 },
  { key: 'gridSnap', label: '掛點拖拉吸附', unit: 'mm', min: 0, max: 50, step: 0.5 },
];

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 1000) / 1000;

/** 清理輸入：基本欄位夾到合法範圍；進階欄位 null/空字串 = 自動 */
export function normalizeParams(input = {}) {
  const P = { ...DEFAULTS };
  for (const spec of [...BASIC_SPEC, ...ASSEMBLY_SPEC]) {
    const n = Number(input[spec.key]);
    if (input[spec.key] !== undefined && input[spec.key] !== '' && input[spec.key] !== null && Number.isFinite(n)) {
      P[spec.key] = clampNum(spec.int ? Math.round(n) : n, spec.min, spec.max);
    }
  }
  for (const spec of CHOICE_SPEC) {
    const v = String(input[spec.key] ?? '');
    if (spec.options.some(([o]) => o === v)) P[spec.key] = v;
  }
  for (const spec of [...LINKED_BASIC_SPEC, ...ADVANCED_SPEC]) {
    const v = input[spec.key];
    const n = Number(v);
    P[spec.key] = v === null || v === undefined || v === '' || !Number.isFinite(n)
      ? null
      : clampNum(spec.int ? Math.round(n) : n, spec.min, spec.max);
  }
  return P;
}

/**
 * 解析並連動所有參數。
 * 回傳 P（供幾何使用的完整數值）、fields（每個進階欄位的實際值、是否自動、說明）、warnings。
 */
export function resolveParams(input = {}) {
  const raw = normalizeParams(input);
  const fields = {};
  const warnings = [];

  // 依序決定每個進階值：自動值 → 下限 → 上限（下限優先）
  const resolve = (key, autoVal, autoWhy, bounds = []) => {
    const manual = raw[key];
    const auto = manual == null;
    let v = auto ? autoVal : manual;
    let note = auto ? autoWhy : '';
    for (const [kind, limit, why] of bounds) {
      if (limit == null || !Number.isFinite(limit)) continue;
      if (kind === 'max' && v > limit + 1e-9) { v = limit; if (!auto) note = `已調為 ${r2(v)}：${why}`; }
    }
    for (const [kind, limit, why] of bounds) {
      if (limit == null || !Number.isFinite(limit)) continue;
      if (kind === 'min' && v < limit - 1e-9) { v = limit; if (!auto) note = `已調為 ${r2(v)}：${why}`; }
    }
    v = r2(v);
    fields[key] = { value: v, auto, note, adjusted: !auto && Math.abs(v - manual) > 1e-9 };
    return v;
  };

  const t = raw.thickness, tol = raw.tolerance, D = raw.canDia, h = raw.canHeight;

  const bitDia = resolve('bitDia', Number(raw.bit), '依銑刀選擇');
  const slotW = t + tol;
  if (bitDia > slotW) warnings.push(`銑刀 ⌀${bitDia} 比榫槽寬 ${r2(slotW)}mm 還粗，榫槽無法加工；請換細刀或加厚板材`);
  else if (bitDia > 0 && bitDia / 2 * Math.SQRT2 * 2 > slotW) warnings.push(`銑刀 ⌀${bitDia} 對 ${r2(slotW)}mm 榫槽太粗，部分內角無法加狗骨頭`);

  const [sw, sh] = raw.sheet.split('x').map(Number);
  const sheetW = resolve('sheetW', Math.min(sw, sh), '依板材選擇');
  const sheetH = resolve('sheetH', Math.max(sw, sh), '依板材選擇');
  const partGap = resolve('partGap', Math.max(6, Math.ceil(bitDia * 2 + 2)), '銑刀直徑 × 2 + 2', [['min', bitDia + 1, '必須大於銑刀直徑']]);

  const holeClearance = resolve('holeClearance', clampNum(Math.round(D * 0.03 * 2) / 2, 1, 3), '罐徑 × 3%');
  const canGap = resolve('canGap', Math.max(6, Math.ceil(holeClearance + 4), Math.ceil(t * 0.6)), '依餘隙與板厚',
    [['min', holeClearance + 2, '罐孔之間至少要留 2mm 木料']]);

  const minRetain = r2(t + tol + 3);
  const retainHeight = resolve('retainHeight', clampNum(Math.round(h * 0.35), minRetain, h * 0.6), '罐高 × 35%',
    [['max', r1(h * 0.8), '不超過罐高 80%，否則難以取放'], ['min', minRetain, '孔板要高於層板：板厚 + 公差 + 3']]);
  if (minRetain > h * 0.8) warnings.push(`罐子太矮（${h}mm），以 ${t}mm 板厚很難固定；建議改用較薄板材`);

  // 罐頂到上一層底面：取罐時要先把罐子提起「固定孔板高度」才拿得出來
  const topGap = resolve('topGap', retainHeight + 5, '固定孔板高度 + 5，剛好能提起取出',
    [['min', r2(retainHeight + 2), `要比固定孔板高度 ${retainHeight}mm 多 2mm，罐子才提得出來`]]);

  const bolt = Number(raw.bolt.slice(1));
  const boltHole = bolt + 0.5;
  const margin = resolve('margin', Math.max(18, Math.round(t * 1.5 + 10), Math.ceil(14 + boltHole * 1.5)), '依板厚與螺栓',
    [['min', Math.max(14, Math.ceil(t + 6), Math.ceil(12 + boltHole)), '要容納延伸卡扣與連接板螺栓']]);

  // 深度需同時放得下罐孔與延伸接頭
  const pitch = D + canGap;
  const baseDepth = 2 * t + canGap / 2 + pitch;
  // 連接板位於前後兩個卡扣之間，至少要放得下兩排螺栓孔
  const needDepth = Math.max(60, Math.ceil(2 * t + 10 + slotW + t + 4 * boltHole + 8));
  const minFront = Math.max(0, Math.ceil(needDepth - baseDepth));
  const frontMargin = resolve('frontMargin', Math.max(10, minFront), minFront > 10 ? '加深以容納垂直連接板' : '預設 10mm',
    [['min', minFront, `深度至少 ${needDepth.toFixed(0)}mm 才放得下垂直連接板`]]);

  // 模組大小：自動時限制單一模組約 600mm 以內，並且一定要放得進板材
  const rowPitch = t + h + topGap;
  const usableLong = sheetH - 2 * partGap, usableShort = sheetW - 2 * partGap;
  const colsFor = (len) => Math.floor((len - 2 * t - canGap) / pitch);
  const rowsFor = (len) => Math.floor((len - 2 * margin - t) / rowPitch);
  const capCols = Math.max(1, colsFor(usableLong));
  const capRows = Math.max(1, rowsFor(usableLong));
  if (colsFor(usableLong) < 1 || rowsFor(usableLong) < 1) warnings.push('板材太小，連單一罐位的模組都放不下');
  const maxCols = resolve('maxCols', Math.max(1, Math.min(raw.perKind, colsFor(Math.min(600, usableShort)))), '模組寬約 600mm 內',
    [['max', capCols, '模組不能比板材寬']]);
  const maxRows = resolve('maxRows', Math.max(1, Math.min(raw.kinds, rowsFor(Math.min(600, usableLong)))), '模組高約 600mm 內',
    [['max', capRows, '模組不能比板材長']]);

  const gridSnap = resolve('gridSnap', 5, '預設 5mm');

  const screw = Number(raw.screw);
  const keyholeHead = r1(screw * 2 + 1.5);

  const P = {
    thickness: t, tolerance: tol, canDia: D, canHeight: h, kinds: raw.kinds, perKind: raw.perKind,
    canGap, holeClearance, retainHeight, topGap, frontMargin, margin, maxCols, maxRows,
    racksX: raw.racksX, racksY: raw.racksY, bolt, lockHoleDia: boltHole, screw,
    keyholeHead, keyholeShank: r1(screw + 0.6), keyholeLen: keyholeHead,
    dogbone: bitDia > 0, bitDia, sheetW, sheetH, partGap, gridSnap,
  };
  return { P, raw, fields, warnings };
}

const range = (n) => Array.from({ length: n }, (_, i) => i);

/** 由參數推導出所有尺寸 */
export function deriveLayout(input) {
  const { P, raw, fields, warnings } = resolveParams(input);
  const t = P.thickness, tol = P.tolerance;
  const K = P.kinds, N = P.perKind;

  const mxUnit = Math.ceil(N / P.maxCols), cols = Math.ceil(N / mxUnit);
  const myUnit = Math.ceil(K / P.maxRows), rows = Math.ceil(K / myUnit);
  // 多架組裝：整組設計重複並排／堆疊
  const mx = mxUnit * P.racksX, my = myUnit * P.racksY;

  const gap = P.canGap;
  const pitch = P.canDia + gap;
  const holeD = P.canDia + P.holeClearance;

  const inset = t; // 背板離牆距離（側板後緣貼牆）
  const zs = inset + t; // 層板後緣
  const holeZ = zs + gap / 2 + pitch / 2;
  const depth = holeZ + pitch / 2 + P.frontMargin;
  const retain = P.retainHeight;

  const rowPitch = t + P.canHeight + P.topGap;
  const e = P.margin;
  const innerW = cols * pitch + gap;
  const W = innerW + 2 * t;
  const H = e + rows * rowPitch + t + e;

  // 層板 → 側板 榫頭
  const plateDepth = depth - zs;
  const nT = plateDepth > 150 ? 3 : 2;
  const tabL = Math.min(30, plateDepth / (2 * nT));
  const sideTabs = range(nT).map((k) => zs + (plateDepth * (k + 0.5)) / nT);

  // 層板 → 背板 榫頭
  const nB = innerW > 120 ? Math.max(2, Math.round(innerW / 160)) : 1;
  const backTabL = Math.min(30, innerW / (2 * nB + 1));
  const backTabs = range(nB).map((k) => t + (innerW * (k + 0.5)) / nB);

  const shelfY = range(rows).map((i) => e + i * rowPitch); // 層板底面（模組內）
  const holePlateY = shelfY.map((y) => y + retain); // 孔板底面 = 層板頂 + retain - t
  const topY = e + rows * rowPitch;
  const openSpan = rowPitch - t - retain;
  const backSideTabL = Math.min(40, openSpan * 0.5);
  const backSideTabY = shelfY.map((y) => y + t + retain + openSpan / 2);
  const backExt = Math.min(e * 0.5, 8);
  const backY0 = e - backExt, backY1 = H - e + backExt;

  // 延伸接頭
  const nd = Math.min(e * 0.4, 12); // 卡槽深
  const notchW = t + tol;
  const clipZ = [zs + 3 + notchW / 2, depth - 3 - notchW / 2];
  // 垂直連接板：貼在上下兩模組側板內側，介於前後卡扣之間，每個模組各 2 支螺栓
  const spliceZ = [clipZ[0] + t / 2 + 2, clipZ[1] - t / 2 - 2];
  const spliceMid = (spliceZ[0] + spliceZ[1]) / 2;
  const spliceHalfH = e - 3;
  const boltR = P.lockHoleDia / 2;
  const boltDz = Math.max(boltR + 2, Math.min((spliceZ[1] - spliceZ[0]) / 2 - boltR - 3, 15));
  const spliceBoltZ = [spliceMid - boltDz, spliceMid + boltDz];
  const spliceBoltY = e / 2; // 距接縫
  const clipLeg = Math.max(4, e - nd - 4);
  const clipLegW = Math.max(6, t);

  const lockZ = (zs + depth) / 2;

  return {
    P, raw, fields, warnings, t, tol, K, N, mx, my, cols, rows, gap, pitch, holeD, inset, zs, holeZ, depth,
    retain, rowPitch, e, innerW, W, H, plateDepth, tabL, sideTabs, backTabL, backTabs,
    shelfY, holePlateY, topY, backSideTabL, backSideTabY, backY0, backY1,
    mxUnit, myUnit, nd, notchW, clipZ, spliceZ, spliceMid, spliceHalfH, spliceBoltZ, spliceBoltY, clipLeg, clipLegW, lockZ,
    totalW: mx * W, totalH: my * H,
  };
}

// --- 零件模板 -------------------------------------------------------------

function rectNotch(c, w, d) {
  return [[c - w / 2, 0], [c - w / 2, d], [c + w / 2, d], [c + w / 2, 0]];
}

// 側板：2D (u = z 深度, v = y 高度)
function sidePanelShape(L) {
  const { t, tol, depth: D, H } = L;
  const notches = [
    ...rectNotch(L.clipZ[0], L.notchW, L.nd),
    ...rectNotch(L.clipZ[1], L.notchW, L.nd),
  ];
  const bottom = notches.map(([s, d]) => [s, d]);
  const top = notches.map(([s, d]) => [s, H - d]).reverse();
  const outer = [[0, 0], ...bottom, [D, 0], [D, H], ...top, [0, H]];

  const holes = [];
  const plateYs = [...L.shelfY, ...L.holePlateY, L.topY];
  for (const y0 of plateYs) {
    for (const zc of L.sideTabs) {
      holes.push({ type: 'poly', pts: rectCW(zc - L.tabL / 2 - tol / 2, y0 - tol / 2, zc + L.tabL / 2 + tol / 2, y0 + t + tol / 2) });
    }
  }
  for (const yc of L.backSideTabY) {
    holes.push({ type: 'poly', pts: rectCW(L.inset - tol / 2, yc - L.backSideTabL / 2 - tol / 2, L.inset + t + tol / 2, yc + L.backSideTabL / 2 + tol / 2) });
    holes.push({ type: 'circle', c: [L.lockZ, yc], r: L.P.lockHoleDia / 2 });
  }
  // 上下邊距的垂直連接板螺栓孔（每片側板都切，方便日後往上延伸）
  for (const z of L.spliceBoltZ) {
    for (const y of [L.spliceBoltY, H - L.spliceBoltY]) holes.push({ type: 'circle', c: [z, y], r: L.P.lockHoleDia / 2 });
  }
  return { outer, holes };
}

// 層板 / 孔板 / 頂板：2D (u = x, v = z)
function plateShape(L, withBackTabs, circleHoles) {
  const { t, W, zs, depth, sideTabs, tabL, backTabs, backTabL } = L;
  const pts = [[t, zs]];
  if (withBackTabs) {
    for (const xc of backTabs) {
      pts.push([xc - backTabL / 2, zs], [xc - backTabL / 2, zs - t], [xc + backTabL / 2, zs - t], [xc + backTabL / 2, zs]);
    }
  }
  pts.push([W - t, zs]);
  for (const zc of sideTabs) pts.push([W - t, zc - tabL / 2], [W, zc - tabL / 2], [W, zc + tabL / 2], [W - t, zc + tabL / 2]);
  pts.push([W - t, depth], [t, depth]);
  for (const zc of [...sideTabs].reverse()) pts.push([t, zc + tabL / 2], [0, zc + tabL / 2], [0, zc - tabL / 2], [t, zc - tabL / 2]);
  return { outer: pts, holes: circleHoles };
}

// 背板：2D (u = x, v = y)
function backPanelBase(L) {
  const { t, tol, W, backY0, backY1 } = L;
  const pts = [[t, backY0], [W - t, backY0]];
  for (const yc of L.backSideTabY) {
    const h = L.backSideTabL / 2;
    pts.push([W - t, yc - h], [W, yc - h], [W, yc + h], [W - t, yc + h]);
  }
  pts.push([W - t, backY1], [t, backY1]);
  for (const yc of [...L.backSideTabY].reverse()) {
    const h = L.backSideTabL / 2;
    pts.push([t, yc + h], [0, yc + h], [0, yc - h], [t, yc - h]);
  }
  const slots = [];
  for (const y0 of [...L.shelfY, L.topY]) {
    for (const xc of L.backTabs) {
      slots.push(rectCW(xc - L.backTabL / 2 - tol / 2, y0 - tol / 2, xc + L.backTabL / 2 + tol / 2, y0 + t + tol / 2));
    }
  }
  return { outer: pts, slots };
}

// U 型卡扣：2D (u = x, v = y)，開口朝 v=0
function clipShape(L) {
  const { t, tol, clipLegW: lw, nd, clipLeg: hs } = L;
  const sw = 2 * t + tol;
  const cw = 2 * lw + sw, hc = nd + hs;
  return {
    outer: [[0, 0], [lw, 0], [lw, hs], [lw + sw, hs], [lw + sw, 0], [cw, 0], [cw, hc], [0, hc]],
    holes: [], cw, hc,
  };
}

// 垂直連接板：2D (u = z 深度, v = y，以接縫為 0)
function spliceShape(L) {
  const [z0, z1] = L.spliceZ, h = L.spliceHalfH;
  const holes = [];
  for (const z of L.spliceBoltZ) {
    for (const y of [-L.spliceBoltY, L.spliceBoltY]) holes.push({ type: 'circle', c: [z, y], r: L.P.lockHoleDia / 2 });
  }
  return { outer: [[z0, -h], [z1, -h], [z1, h], [z0, h]], holes };
}

// --- 展示名牌 -------------------------------------------------------------

export const NAMEPLATE_MODES = [
  ['laser', '雷射雕刻（點陣）'],
  ['engrave', 'CNC 雕刻（向量輪廓）'],
  ['cut', '鏤空（貫穿切割）'],
];

/**
 * 名牌：立在頂板上、位於深度中間，兩支榫頭穿過頂板。
 * 2D (u = x, v = y，v = 0 為頂板頂面)。art 為 artwork.js 的正規化圖案（寬 1、高 aspect）。
 */
function nameplateShape(L, opts) {
  const { t, tol, W, innerW, e } = L;
  const height = Math.min(300, Math.max(20, Number(opts.height) || 60));
  const x0 = t + tol / 2, x1 = W - t - tol / 2, top = e + height;
  const tabL = Math.min(30, innerW / 5);
  const tabs = [0.25, 0.75].map((f) => t + innerW * f);
  const outer = [[x0, 0]];
  for (const xc of tabs) outer.push([xc - tabL / 2, 0], [xc - tabL / 2, -t], [xc + tabL / 2, -t], [xc + tabL / 2, 0]);
  outer.push([x1, 0], [x1, top], [x0, top]);

  const warnings = [];
  const holes = [], engrave = [];
  let raster = null, artRect = null;
  const art = opts.art;
  if (art && art.loops?.length) {
    const m = Math.max(4, L.P.bitDia * 2);
    const aw = x1 - x0 - 2 * m, ah = top - 2 * m;
    const s = Math.min(aw, ah / art.aspect);
    const ox = x0 + m + (aw - s) / 2, oy = m + (ah - s * art.aspect) / 2;
    const loops = art.loops.map((l) => l.map(([px, py]) => [ox + px * s, oy + py * s]));
    artRect = { x: ox, y: oy, w: s, h: s * art.aspect };
    if (opts.mode === 'cut') {
      let islands = 0, tiny = 0;
      const minFeature = Math.max(1, L.P.bitDia);
      for (const l of loops) {
        const b = bbox(l);
        let area = 0;
        for (let k = 0; k < l.length; k++) {
          const [ax, ay] = l[k], [bx, by] = l[(k + 1) % l.length];
          area += ax * by - bx * ay;
        }
        if (area < 0) { islands++; continue; } // 字中間的島會掉出，不切
        if (Math.min(b.w, b.h) < minFeature) { tiny++; continue; }
        holes.push({ type: 'poly', pts: l.slice().reverse(), art: true });
      }
      if (islands) warnings.push(`名牌鏤空：${islands} 個封閉內島（例如「口」「O」的中間）會掉出，已略過`);
      if (tiny) warnings.push(`名牌鏤空：${tiny} 個細節小於銑刀直徑 ${minFeature}mm，已略過`);
    } else {
      engrave.push(...loops);
      if (opts.mode === 'laser') raster = artRect;
    }
  }
  return { outer, holes, engrave, raster, artRect, tabs, tabL, height, warnings };
}

// --- 牆面掛點 -------------------------------------------------------------

/** 掛點 (x, y) 為世界座標的螺絲掛住位置（鑰匙孔窄槽頂端）。 */
export function validateMount(L, x, y) {
  const P = L.P;
  const i = Math.min(L.mx - 1, Math.max(0, Math.floor(x / L.W)));
  const j = Math.min(L.my - 1, Math.max(0, Math.floor(y / L.H)));
  const u = x - i * L.W, v = y - j * L.H;
  const R = P.keyholeHead / 2, rs = Math.min(P.keyholeShank / 2, R * 0.95);
  const len = Math.max(P.keyholeLen, Math.sqrt(Math.max(R * R - rs * rs, 0)) + 0.5);
  const cy = v - len;
  const kb = { minX: u - R, maxX: u + R, minY: cy - R, maxY: v + rs };
  const result = { module: [i, j], local: [u, cy], valid: true, reason: '' };
  if (x < 0 || x > L.totalW || y < 0 || y > L.totalH) return { ...result, valid: false, reason: '超出木架範圍' };
  const pad = 2;
  if (kb.minX < L.t + pad || kb.maxX > L.W - L.t - pad) return { ...result, valid: false, reason: '太靠近側板' };
  if (kb.minY < L.backY0 + pad || kb.maxY > L.backY1 - pad) return { ...result, valid: false, reason: '超出背板上下緣' };
  const { slots } = backPanelBase(L);
  for (const s of slots) {
    if (rectsOverlap(kb, bbox(s), pad)) return { ...result, valid: false, reason: '與層板榫槽重疊' };
  }
  return result;
}

/** 預設掛點：每個模組頂板下方左右各一 */
export function autoMounts(L) {
  const out = [];
  const R = L.P.keyholeHead / 2;
  const rs = Math.min(L.P.keyholeShank / 2, R * 0.95);
  const vLocal = L.topY - L.tol / 2 - rs - 6;
  for (let j = 0; j < L.my; j++) {
    for (let i = 0; i < L.mx; i++) {
      for (const f of [0.25, 0.75]) {
        out.push({ x: round1(i * L.W + L.W * f), y: round1(j * L.H + vLocal) });
      }
    }
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;

// --- 組裝 -----------------------------------------------------------------

export function buildRack(input, mounts = [], options = {}) {
  const L = deriveLayout(input);
  const P = L.P;
  const warnings = [...L.warnings];
  const r = P.dogbone ? P.bitDia / 2 : 0;
  const finish = (shape) => ({
    outer: dogbone(shape.outer, r),
    holes: shape.holes.map((h) => (h.type === 'poly' ? { ...h, pts: dogbone(h.pts, r) } : h)),
  });

  const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1], NY = [0, -1, 0];
  const t = L.t;

  const side = finish(sidePanelShape(L));
  const holeCircles = range(L.cols).map((c) => ({
    type: 'circle', c: [t + L.gap / 2 + L.pitch / 2 + c * L.pitch, L.holeZ], r: L.holeD / 2,
  }));
  const shelf = finish(plateShape(L, true, []));
  const holePlate = finish(plateShape(L, false, holeCircles));
  const np = options.nameplate?.enabled ? nameplateShape(L, options.nameplate) : null;
  if (np) warnings.push(...np.warnings);
  const nz = L.spliceMid - t / 2; // 名牌位於深度中間（前後卡扣之間）
  const npSlots = np ? np.tabs.map((xc) => ({
    type: 'poly', pts: rectCW(xc - np.tabL / 2 - L.tol / 2, nz - L.tol / 2, xc + np.tabL / 2 + L.tol / 2, nz + t + L.tol / 2),
  })) : [];
  const top = finish(plateShape(L, true, npSlots));
  const nameplate = np ? { outer: dogbone(np.outer, r), holes: np.holes } : null;
  const backBase = backPanelBase(L);
  const clipRaw = clipShape(L);
  const clip = finish(clipRaw);
  const splice = finish(spliceShape(L));

  const mountInfo = mounts.map((m) => ({ ...m, ...validateMount(L, m.x, m.y) }));
  for (const m of mountInfo) if (!m.valid) warnings.push(`掛點 #${m.id ?? '?'}：${m.reason}，不會切出掛孔`);

  const parts = [];
  let seq = 0;
  const add = (name, kind, shape, mod, origin, U, V, explode) => {
    parts.push({ id: `p${seq++}`, name, kind, module: mod, outer: shape.outer, holes: shape.holes, t, origin, U, V, explode });
  };

  for (let j = 0; j < L.my; j++) {
    for (let i = 0; i < L.mx; i++) {
      const x0 = i * L.W, y0 = j * L.H;
      const tag = `M${i + 1}-${j + 1}`;
      add(`${tag} 左側板`, 'side', side, [i, j], [x0 + t, y0, 0], Z, Y, [-1, 0, 0]);
      add(`${tag} 右側板`, 'side', side, [i, j], [x0 + L.W, y0, 0], Z, Y, [1, 0, 0]);

      const keyholes = mountInfo
        .filter((m) => m.valid && m.module[0] === i && m.module[1] === j)
        .map((m) => ({ type: 'poly', pts: keyholeCW(m.local[0], m.local[1], P.keyholeHead / 2, P.keyholeShank / 2, P.keyholeLen), mount: m.id }));
      const back = finish({ outer: backBase.outer, holes: backBase.slots.map((pts) => ({ type: 'poly', pts })) });
      back.holes.push(...keyholes);
      add(`${tag} 背板`, 'back', back, [i, j], [x0, y0, L.inset], X, Y, [0, 0, -1]);

      for (let rI = 0; rI < L.rows; rI++) {
        add(`${tag} 層板${rI + 1}`, 'shelf', shelf, [i, j], [x0, y0 + L.shelfY[rI] + t, 0], X, Z, [0, -0.3, 1]);
        add(`${tag} 孔板${rI + 1}`, 'holeplate', holePlate, [i, j], [x0, y0 + L.holePlateY[rI] + t, 0], X, Z, [0, 0.3, 1.4]);
      }
      add(`${tag} 頂板`, 'top', top, [i, j], [x0, y0 + L.topY + t, 0], X, Z, [0, 1, 0.5]);
      if (nameplate && j === L.my - 1) {
        add(`${tag} 展示名牌`, 'nameplate', nameplate, [i, j], [x0, y0 + L.topY + t, nz], X, Y, [0, 1.6, 0.4]);
        const p = parts[parts.length - 1];
        p.engrave = np.engrave;
        p.raster = np.raster;
        p.artRect = np.artRect;
        p.artMode = options.nameplate.mode;
      }
    }
  }

  // 水平延伸卡扣（相鄰模組側板上下緣）
  for (let j = 0; j < L.my; j++) {
    for (let i = 0; i < L.mx - 1; i++) {
      const xj = (i + 1) * L.W, y0 = j * L.H;
      L.clipZ.forEach((zc, k) => {
        add(`卡扣 H${i + 1}|${i + 2}-${j + 1} 上${k + 1}`, 'clip', clip, [i, j], [xj - clipRaw.cw / 2, y0 + L.H - clipRaw.hc, zc - t / 2], X, Y, [0, 1.2, 0]);
        add(`卡扣 H${i + 1}|${i + 2}-${j + 1} 下${k + 1}`, 'clip', clip, [i, j], [xj - clipRaw.cw / 2, y0 + clipRaw.hc, zc + t / 2], X, NY, [0, -1.2, 0]);
      });
    }
  }
  // 垂直連接板（貼在上下模組側板內側，螺栓鎖緊）
  for (let j = 0; j < L.my - 1; j++) {
    for (let i = 0; i < L.mx; i++) {
      const x0 = i * L.W, yj = (j + 1) * L.H;
      add(`連接板 V${i + 1}-${j + 1}|${j + 2} 左`, 'splice', splice, [i, j], [x0 + 2 * t, yj, 0], Z, Y, [0.8, 0, 1]);
      add(`連接板 V${i + 1}-${j + 1}|${j + 2} 右`, 'splice', splice, [i, j], [x0 + L.W - t, yj, 0], Z, Y, [-0.8, 0, 1]);
    }
  }

  // 罐子位置（視覺化）
  const cans = [];
  for (let j = 0; j < L.my; j++) {
    for (let i = 0; i < L.mx; i++) {
      for (let rI = 0; rI < L.rows; rI++) {
        const kind = (j % L.myUnit) * L.rows + rI; // 每一架各自放滿所有種類
        if (kind >= L.K) continue;
        for (let c = 0; c < L.cols; c++) {
          const n = (i % L.mxUnit) * L.cols + c;
          if (n >= L.N) continue;
          cans.push({
            kind, module: [i, j],
            x: i * L.W + t + L.gap / 2 + L.pitch / 2 + c * L.pitch,
            y: j * L.H + L.shelfY[rI] + t,
            z: L.holeZ, r: P.canDia / 2, h: P.canHeight,
          });
        }
      }
    }
  }

  for (const p of parts) p.bounds = bbox(p.outer);

  const counts = {};
  for (const p of parts) counts[p.kind] = (counts[p.kind] || 0) + 1;
  const capacity = L.mx * L.cols * L.my * L.rows;
  const hJoints = (L.mx - 1) * L.my, vJoints = L.mx * (L.my - 1);
  const boltLen = (n) => Math.ceil((n * t + P.bolt * 1.5 + 4) / 5) * 5;
  const hardware = [
    { name: `M${P.bolt} 螺栓 × ${boltLen(2)}mm`, use: '水平鎖點（穿過相鄰兩片側板）', qty: hJoints * L.rows },
    { name: `M${P.bolt} 螺栓 × ${boltLen(2)}mm`, use: '垂直連接板（側板 + 連接板）', qty: vJoints * 2 * 4 },
    { name: `M${P.bolt} 螺帽 + 墊片`, use: '每支螺栓一組', qty: hJoints * L.rows + vJoints * 8 },
    { name: `${P.screw}mm 木螺絲`, use: '牆面掛點（螺絲頭需凸出牆面約 2 個板厚）', qty: mountInfo.filter((m) => m.valid).length },
  ].filter((h) => h.qty > 0);

  return {
    params: P, layout: L, parts, cans, mounts: mountInfo, warnings, counts,
    info: {
      width: L.totalW, height: L.totalH, depth: L.depth,
      moduleW: L.W, moduleH: L.H, mx: L.mx, my: L.my, cols: L.cols, rows: L.rows,
      capacity, required: L.K * L.N * P.racksX * P.racksY, holeD: L.holeD, rowPitch: L.rowPitch,
      racksX: P.racksX, racksY: P.racksY, hJoints, vJoints, hardware,
      nameplateH: np ? np.height : 0,
    },
  };
}
