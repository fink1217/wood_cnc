// 參數化顏料罐木架：產生所有 CNC 零件的 2D 輪廓與 3D 擺放資訊（不依賴 three.js）。
//
// 世界座標 (mm)：X = 寬（左→右）、Y = 高（下→上）、Z = 深（牆面 z=0 往外）。
// 每個模組 = 左右側板 + 背板 + 每列（層板 + 固定孔板）+ 頂板。
// 模組之間：水平延伸用 U 型卡扣（側板上下緣卡槽）+ 螺栓鎖點孔；
//           垂直堆疊用垂直連接板（貼在上下側板內側，螺栓鎖緊）。
// 所有模組都切出延伸槽，日後可隨時再往旁邊或上方擴充。

import { dogbone, rectCW, keyholeCW, bbox, rectsOverlap, signedArea } from './geometry.js';
import { traceMask, simplifyLoop } from './artwork.js';

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
  sideClear: null,
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
  { key: 'sideClear', label: '罐子到側板間距', unit: 'mm', min: 0, max: 60, step: 0.5 },
  { key: 'retainHeight', label: '固定孔板高度', unit: 'mm', min: 0, max: 200, step: 1 },
  { key: 'frontMargin', label: '前緣留邊', unit: 'mm', min: 0, max: 100, step: 1 },
  { key: 'margin', label: '底部與頂蓋邊距', unit: 'mm', min: 0, max: 80, step: 1 },
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
  P.labelsOn = input.labelsOn === true; // 有任何顏料名牌開啟（影響前緣留邊與孔板高度）
  P.labelH = clampNum(Number(input.labelH) || 12, 6, 60); // 顏料名牌高度 = 層板與孔板之間的空隙
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
    const mins = bounds.filter(([kind, limit]) => kind === 'min' && Number.isFinite(limit)).map(([, limit]) => limit);
    fields[key] = { value: v, auto, note, adjusted: !auto && Math.abs(v - manual) > 1e-9, min: mins.length ? r2(Math.max(...mins)) : null };
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

  const minRetainPlate = r2(t + tol + 3);
  // 顏料名牌夾在層板與孔板之間：孔板要抬高到放得下名牌
  const minRetainLabel = raw.labelsOn ? r2(t + raw.labelH + tol) : 0;
  const minRetain = Math.max(minRetainPlate, minRetainLabel);
  const retainWhy = minRetainLabel > minRetainPlate ? `要放得下 ${raw.labelH}mm 高的顏料名牌` : '孔板要高於層板：板厚 + 公差 + 3';
  const retainHeight = resolve('retainHeight', clampNum(Math.round(h * 0.35), minRetain, Math.max(minRetain, h * 0.6)),
    minRetainLabel > clampNum(Math.round(h * 0.35), minRetainPlate, h * 0.6) ? '依顏料名牌高度' : '罐高 × 35%',
    [['max', r1(h * 0.8), '不超過罐高 80%，否則難以取放'], ['min', minRetain, retainWhy]]);
  if (minRetainPlate > h * 0.8) warnings.push(`罐子太矮（${h}mm），以 ${t}mm 板厚很難固定；建議改用較薄板材`);
  else if (minRetain > h * 0.8) warnings.push(`顏料名牌太高：孔板要抬到 ${minRetain}mm，超過罐高 80%，取放會較困難`);

  // 罐頂到上一層底面：至少要能把罐子提起「固定孔板高度」再多 8mm，才好拿；只能往上調
  const liftRoom = 8;
  const minTopGap = r2(retainHeight + liftRoom);
  const topGap = resolve('topGap', minTopGap, `最小值：固定孔板高度 + ${liftRoom}，罐子提得起、好拿`,
    [['min', minTopGap, `至少 ${minTopGap}mm（固定孔板高度 ${retainHeight} + ${liftRoom}），罐子才好拿出來`]]);

  const bolt = Number(raw.bolt.slice(1));
  const boltHole = bolt + 0.5;
  const margin = resolve('margin', Math.max(18, Math.round(t * 1.5 + 10), Math.ceil(14 + boltHole * 1.5)), '依板厚與螺栓',
    [['min', Math.max(14, Math.ceil(t + 6), Math.ceil(12 + boltHole)), '要容納延伸卡扣與連接板螺栓']]);

  // 罐子到側板：要讓出貼在側板內側的垂直連接板與卡扣腳（接縫處仍是完整的罐位）
  const clipLegW = Math.max(6, t);
  const minSide = Math.ceil(Math.max(t, clipLegW) + 3);
  const sideClear = resolve('sideClear', Math.max(canGap, minSide), '讓出連接板與卡扣的位置',
    [['min', minSide, '側板內側要放垂直連接板與卡扣腳']]);

  // 深度需同時放得下罐孔與延伸接頭
  const pitch = D + canGap;
  const baseDepth = 2 * t + canGap / 2 + pitch;
  // 連接板位於前後兩個卡扣之間，至少要放得下兩排螺栓孔
  const needDepth = Math.max(60, Math.ceil(2 * t + 10 + slotW + t + 4 * boltHole + 8));
  const minFrontJoint = Math.max(0, Math.ceil(needDepth - baseDepth));
  // 顏料名牌：孔板前緣要放得下名牌榫槽（罐孔前留 2mm、榫槽、前緣再留 5mm）
  const holeD = D + holeClearance;
  const minFrontLabel = raw.labelsOn ? Math.ceil(holeD / 2 - pitch / 2 + 2 + slotW + 5) : 0;
  const minFront = Math.max(minFrontJoint, minFrontLabel);
  const frontWhy = minFrontLabel > minFrontJoint ? '前緣要放得下顏料名牌的榫槽' : `深度至少 ${needDepth.toFixed(0)}mm 才放得下垂直連接板`;
  const frontMargin = resolve('frontMargin', Math.max(10, minFront),
    minFront <= 10 ? '預設 10mm' : minFrontLabel > minFrontJoint ? '加寬以放顏料名牌' : '加深以容納垂直連接板',
    [['min', minFront, frontWhy]]);

  // 模組大小：自動時限制單一模組約 600mm 以內，並且一定要放得進板材
  const rowPitch = t + h + topGap;
  const usableLong = sheetH - 2 * partGap, usableShort = sheetW - 2 * partGap;
  const colsFor = (len) => Math.floor((len - 2 * t - 2 * sideClear - D) / pitch) + 1;
  const rowsFor = (len) => Math.floor(len / rowPitch); // 模組側板高 = 列數 × 列距（接縫處是完整罐位）
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
    canGap, holeClearance, retainHeight, topGap, sideClear, frontMargin, margin, maxCols, maxRows, labelH: raw.labelH,
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
  const side = P.sideClear; // 最外側罐子到側板內面的距離

  const inset = t; // 背板離牆距離（側板後緣貼牆）
  const zs = inset + t; // 層板後緣
  const holeZ = zs + gap / 2 + pitch / 2;
  const depth = holeZ + pitch / 2 + P.frontMargin;
  const retain = P.retainHeight;

  const rowPitch = t + P.canHeight + P.topGap;
  const e = P.margin;
  const innerW = 2 * side + P.canDia + (cols - 1) * pitch;
  const W = innerW + 2 * t;
  const holeX = range(cols).map((c) => t + side + P.canDia / 2 + c * pitch);
  // 模組側板高度 = 列數 × 列距：最上一列的頭頂空間延伸到上一個模組（或頂蓋）的底層板，
  // 所以上下接縫處仍是完整的罐位，不留白。
  const H = rows * rowPitch;

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

  // 延伸接頭
  const nd = Math.min(e * 0.4, 12); // 卡槽深
  const notchW = t + tol;
  const clipZ = [zs + 3 + notchW / 2, depth - 3 - notchW / 2];
  // 接縫上方的空間：最上一列孔板頂面到側板頂緣（連接板下半與卡扣腳都在這裡，貼著側板、在罐子旁邊）
  const topRoom = rowPitch - e - retain - t;
  const spliceZ = [clipZ[0] + t / 2 + 2, clipZ[1] - t / 2 - 2];
  const spliceMid = (spliceZ[0] + spliceZ[1]) / 2;
  const boltR = P.lockHoleDia / 2;
  const spliceUp = e - 3; // 接縫以上（上一個模組的底部邊距）
  const spliceDown = Math.max(2 * boltR + 6, Math.min(e - 3, topRoom - 2)); // 接縫以下（避開最上一列孔板）
  if (topRoom - 2 < 2 * boltR + 6) warnings.push('罐子太矮或孔板太高：接縫下方放不下垂直連接板的螺栓，請加大罐頂到上層距離');
  const boltDz = Math.max(boltR + 2, Math.min((spliceZ[1] - spliceZ[0]) / 2 - boltR - 3, 15));
  const spliceBoltZ = [spliceMid - boltDz, spliceMid + boltDz];
  const spliceBoltUp = e / 2;
  const spliceBoltDown = Math.max(boltR + 3, Math.min(e / 2, spliceDown - boltR - 2));
  const clipLeg = Math.max(3, Math.min(e - nd - 4, topRoom - nd - 2));
  const clipLegW = Math.max(6, t);

  // 背板側邊榫頭與鎖點孔：每列放在孔板上方的空間；最上一列避開接縫處的連接板
  const spans = shelfY.map((y, r) => {
    const a = holePlateY[r] + t;
    const b = r < rows - 1 ? shelfY[r + 1] : H - spliceDown - 2;
    return [a, Math.max(a + 6, b)];
  });
  const minSpan = Math.min(...spans.map(([a, b]) => b - a));
  const backSideTabL = Math.max(6, Math.min(40, minSpan * 0.5));
  const backSideTabY = spans.map(([a, b]) => (a + b) / 2);
  const backExt = Math.min(e * 0.5, 8);
  const backY0 = e - backExt, backY1 = H - 1;

  // 頂蓋：一片頂板 + 兩片短側板，像沒有罐位的模組一樣疊在最上面（也是頂端名牌的底座）
  const capH = e + t + e;

  const lockZ = (zs + depth) / 2;
  const labelZ = holeZ + holeD / 2 + 2; // 顏料名牌榫槽後緣（罐孔前 2mm）

  return {
    P, raw, fields, warnings, t, tol, K, N, mx, my, cols, rows, gap, pitch, holeD, holeX, side, inset, zs, holeZ, depth,
    retain, rowPitch, e, innerW, W, H, plateDepth, tabL, sideTabs, backTabL, backTabs,
    shelfY, holePlateY, backSideTabL, backSideTabY, backY0, backY1, capH, topRoom,
    mxUnit, myUnit, nd, notchW, clipZ, spliceZ, spliceMid, spliceUp, spliceDown, spliceBoltZ, spliceBoltUp, spliceBoltDown,
    clipLeg, clipLegW, lockZ, labelZ,
    totalW: mx * W, totalH: my * H + capH,
  };
}

// --- 零件模板 -------------------------------------------------------------

function rectNotch(c, w, d) {
  return [[c - w / 2, 0], [c - w / 2, d], [c + w / 2, d], [c + w / 2, 0]];
}

// 側板：2D (u = z 深度, v = y 高度)。上緣 = 最上一列罐子的頭頂空間中段，接上方模組或頂蓋
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
  for (const y0 of [...L.shelfY, ...L.holePlateY]) {
    for (const zc of L.sideTabs) {
      holes.push({ type: 'poly', pts: rectCW(zc - L.tabL / 2 - tol / 2, y0 - tol / 2, zc + L.tabL / 2 + tol / 2, y0 + t + tol / 2) });
    }
  }
  for (const yc of L.backSideTabY) {
    holes.push({ type: 'poly', pts: rectCW(L.inset - tol / 2, yc - L.backSideTabL / 2 - tol / 2, L.inset + t + tol / 2, yc + L.backSideTabL / 2 + tol / 2) });
    holes.push({ type: 'circle', c: [L.lockZ, yc], r: L.P.lockHoleDia / 2 });
  }
  // 垂直連接板螺栓孔：底部邊距一組、上緣下方一組（每片側板都切，方便日後往上延伸）
  for (const z of L.spliceBoltZ) {
    for (const y of [L.spliceBoltUp, H - L.spliceBoltDown]) holes.push({ type: 'circle', c: [z, y], r: L.P.lockHoleDia / 2 });
  }
  return { outer, holes };
}

// 頂蓋側板：只有底部的卡扣槽與連接板螺栓孔，頂板在底部邊距之上
function capSidePanelShape(L) {
  const { t, tol, depth: D, capH, e } = L;
  const notches = [...rectNotch(L.clipZ[0], L.notchW, L.nd), ...rectNotch(L.clipZ[1], L.notchW, L.nd)];
  const outer = [[0, 0], ...notches, [D, 0], [D, capH], [0, capH]];
  const holes = L.sideTabs.map((zc) => ({ type: 'poly', pts: rectCW(zc - L.tabL / 2 - tol / 2, e - tol / 2, zc + L.tabL / 2 + tol / 2, e + t + tol / 2) }));
  for (const z of L.spliceBoltZ) holes.push({ type: 'circle', c: [z, L.spliceBoltUp], r: L.P.lockHoleDia / 2 });
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
  for (const y0 of L.shelfY) {
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

// 垂直連接板：2D (u = z 深度, v = y，以接縫為 0)。接縫以上貼上方側板的底部邊距，以下貼本模組最上一列旁邊
function spliceShape(L) {
  const [z0, z1] = L.spliceZ;
  const holes = [];
  for (const z of L.spliceBoltZ) {
    for (const y of [-L.spliceBoltDown, L.spliceBoltUp]) holes.push({ type: 'circle', c: [z, y], r: L.P.lockHoleDia / 2 });
  }
  return { outer: [[z0, -L.spliceDown], [z1, -L.spliceDown], [z1, L.spliceUp], [z0, L.spliceUp]], holes };
}

// --- 展示名牌 -------------------------------------------------------------

export const NAMEPLATE_MODES = [
  ['laser', '雷射雕刻（點陣）'],
  ['engrave', 'CNC 雕刻（向量輪廓）'],
  ['cut', '鏤空（貫穿切割）'],
];

export const NAMEPLATE_SHAPES = [
  ['rect', '矩形'],
  ['round', '圓角'],
  ['arch', '拱形'],
  ['wave', '波浪'],
  ['silhouette', '沿圖案外形'],
];

const arcPts = (cx, cy, rx, ry, a0, a1, n) => Array.from({ length: n + 1 }, (_, k) => {
  const a = a0 + ((a1 - a0) * k) / n;
  return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
});

/**
 * 名牌類零件的共用產生器（頂端名牌、每種顏料的名牌）。
 * 2D (u = x, v = y)；v = 0 為插入面，榫頭往下 t。輪廓 = 底邊（含榫頭）+ 依造型產生的上緣。
 * art 為 artwork.js 的正規化圖案（寬 1、高 aspect）。
 */
function signPlate({ x0, x1, top, t, tabs, tabL, shape = 'rect', art, mode, margin, minFeature, bandH = 0, topTabUp = 0 }) {
  const W = x1 - x0;
  let ax0 = x0 + margin, ax1 = x1 - margin, ay0 = margin, ay1 = top - margin;
  let upper; // 從右上 (x1, …) 沿上緣走到左上 (x0, …)
  const fit = (box, alignBottom) => {
    const aw = box[1] - box[0], ah = box[3] - box[2];
    if (!art || aw <= 0 || ah <= 0) return null;
    const s = Math.min(aw, ah / art.aspect);
    return { s, ox: box[0] + (aw - s) / 2, oy: alignBottom ? box[2] : box[2] + (ah - s * art.aspect) / 2 };
  };
  let place = null;
  if (shape === 'round') {
    const R = Math.min(top * 0.35, W * 0.2, 30);
    upper = [...arcPts(x1 - R, top - R, R, R, 0, Math.PI / 2, 8), ...arcPts(x0 + R, top - R, R, R, Math.PI / 2, Math.PI, 8)];
    ax0 = x0 + margin + R * 0.3; ax1 = x1 - margin - R * 0.3;
  } else if (shape === 'arch') {
    const A = Math.min(top * 0.45, W * 0.3);
    upper = arcPts((x0 + x1) / 2, top - A, W / 2, A, 0, Math.PI, 32);
    ax0 = x0 + W * 0.1 + margin; ax1 = x1 - W * 0.1 - margin; ay1 = top - A * 0.45 - margin;
  } else if (shape === 'wave') {
    const amp = Math.min(top * 0.15, 10), n = Math.max(2, Math.round(W / 120)), N = 12 * n;
    upper = Array.from({ length: N + 1 }, (_, k) => {
      const x = x1 - (W * k) / N;
      return [x, top - amp / 2 + (amp / 2) * Math.cos((2 * Math.PI * n * (x - x0)) / W)];
    });
    ay1 = top - amp - margin;
  } else if (topTabUp > 0) {
    // 上緣也有榫頭（顏料名牌往上插進孔板）
    upper = [[x1, top]];
    for (const xc of [...tabs].reverse()) upper.push([xc + tabL / 2, top], [xc + tabL / 2, top + topTabUp], [xc - tabL / 2, top + topTabUp], [xc - tabL / 2, top]);
    upper.push([x0, top]);
  } else {
    upper = [[x1, top], [x0, top]];
  }

  if (shape === 'silhouette' && art?.mask) {
    place = fit([ax0, ax1, Math.max(ay0, bandH), ay1], true);
  } else place = fit([ax0, ax1, ay0, ay1], false);

  let outer;
  const bottom = [[x0, 0]];
  for (const xc of tabs) bottom.push([xc - tabL / 2, 0], [xc - tabL / 2, -t], [xc + tabL / 2, -t], [xc + tabL / 2, 0]);
  bottom.push([x1, 0]);
  if (shape === 'silhouette' && art?.mask && place) {
    const sil = silhouetteOutline({ x0, x1, top, art, place, dilate: margin, bandH: Math.max(bandH, t) });
    // sil 由 (x1, 0) 逆時針繞到 (x0, 0)；底邊換成含榫頭的那一條
    outer = [...bottom, ...sil];
  } else {
    outer = [...bottom, ...upper];
  }

  const holes = [], engrave = [];
  let raster = null, artRect = null, islands = 0, tiny = 0;
  if (art && art.loops?.length && place) {
    const { s, ox, oy } = place;
    const loops = art.loops.map((l) => l.map(([px, py]) => [ox + px * s, oy + py * s]));
    artRect = { x: ox, y: oy, w: s, h: s * art.aspect };
    if (mode === 'cut') {
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
    } else {
      engrave.push(...loops);
      if (mode === 'laser') raster = artRect;
    }
  }
  return { outer, holes, engrave, raster, artRect, islands, tiny };
}

/**
 * 「沿圖案外形」：把圖案的天際線（每一欄從底往上填到最高的墨色）往外擴 dilate，
 * 加上底部一條全寬的帶狀區，描出外框後平滑。回傳由 (x1, 0) 繞到 (x0, 0) 的點（不含底邊）。
 */
function silhouetteOutline({ x0, x1, top, art, place, dilate, bandH }) {
  const cols = Math.max(4, Math.round(x1 - x0)), cw = (x1 - x0) / cols; // 約 1mm 一格，左右邊界剛好落在格線
  const rows = Math.max(4, Math.ceil(top));
  const ink = new Uint8Array(cols * rows); // 列由上而下
  const { mask, px } = art;
  const sky = new Int32Array(cols).fill(-1);
  for (let c = 0; c < cols; c++) {
    const u = x0 + (c + 0.5) * cw;
    for (let r = rows - 1; r >= 0; r--) {
      const v = r + 0.5; // r 為由下往上的列號
      const nx = (u - place.ox) / place.s, ny = (v - place.oy) / place.s;
      if (nx < 0 || nx >= 1 || ny < 0 || ny >= art.aspect) continue;
      const X = Math.floor(nx * px.w), Yup = Math.floor(ny * px.w);
      const Y = px.h - 1 - Yup;
      if (X >= 0 && X < px.w && Y >= 0 && Y < px.h && mask[Y * px.w + X]) { sky[c] = r; break; }
    }
  }
  const d = Math.max(1, Math.round(dilate));
  const set = (c, r) => { if (c >= 0 && c < cols && r >= 0 && r < rows) ink[(rows - 1 - r) * cols + c] = 1; };
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < Math.min(rows, Math.ceil(bandH)); r++) set(c, r);
    if (sky[c] < 0) continue;
    // 天際線往外擴：以圓形筆刷沿著這一欄的頂點畫，往下全部填滿
    for (let dc = -d; dc <= d; dc++) {
      const reach = Math.floor(Math.sqrt(d * d - dc * dc));
      const cc = c + dc;
      if (cc < 0 || cc >= cols) continue;
      for (let r = 0; r <= Math.min(rows - 1, sky[c] + reach); r++) set(cc, r);
    }
  }
  const loops = traceMask(ink, cols, rows);
  let best = null, bestArea = 0;
  for (const l of loops) { const a = signedArea(l); if (a > bestArea) { bestArea = a; best = l; } }
  let pts = best.map(([cx, cy]) => [x0 + cx * cw, cy]);
  pts = simplifyLoop(pts, 0.6);
  const fixed = (p) => Math.abs(p[1]) < 1e-6;
  for (let it = 0; it < 2; it++) pts = chaikin(pts, fixed);
  // 從右下角 (x1, 0) 開始，去掉底邊
  const start = pts.findIndex((p) => fixed(p) && Math.abs(p[0] - x1) < 1e-6);
  const rot = [...pts.slice(start), ...pts.slice(0, start)];
  const end = rot.findIndex((p, k) => k > 0 && fixed(p));
  return rot.slice(0, end + 1).filter((p, k, a) => !(fixed(p) && k > 0 && k < a.length - 1));
}

// Chaikin 平滑；fixed 的點保留原位（底邊與榫頭）
function chaikin(pts, fixed) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    if (fixed(p)) out.push(p);
    if (fixed(p) && fixed(q)) continue;
    if (!fixed(p)) out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
    if (!fixed(q)) out.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
  }
  return out;
}

/**
 * 名牌的寬度與位置：一律限制在兩片側板之間。
 * width 空白 = 滿寬；align = 'left' | 'center' | 'right'，offset 為離該基準的距離
 * （靠左：離左側板；置中：離中心，正 = 往右；靠右：離右側板）。拉寬窄時對齊的那一側不動。
 */
export function signSpan(L, { width, align = 'center', offset } = {}, inset = 0, minWidth = 40) {
  const aMin = L.t + L.tol / 2 + inset, aMax = L.W - L.t - L.tol / 2 - inset;
  const full = aMax - aMin;
  const wantW = Number(width);
  const w = width == null || width === '' || !(wantW > 0) ? full : Math.min(full, Math.max(Math.min(minWidth, full), wantW));
  const room = full - w;
  const wantOff = Number(offset) || 0;
  let x0, off, minOffset, maxOffset;
  if (align === 'left' || align === 'right') {
    minOffset = 0; maxOffset = room;
    off = Math.min(room, Math.max(0, wantOff));
    x0 = align === 'left' ? aMin + off : aMax - w - off;
  } else {
    align = 'center';
    minOffset = -room / 2; maxOffset = room / 2;
    off = Math.min(maxOffset, Math.max(minOffset, wantOff));
    x0 = (aMin + aMax) / 2 + off - w / 2;
  }
  return {
    x0, x1: x0 + w, width: r2(w), align, offset: r2(off), minOffset: r2(minOffset), maxOffset: r2(maxOffset), full: r2(full),
    aMin, aMax,
    widthClamped: width != null && width !== '' && Math.abs(w - wantW) > 1e-6,
    offsetClamped: Math.abs(off - wantOff) > 1e-6,
  };
}

/** 頂端名牌：立在頂蓋的頂板上、位於深度中間，兩支榫頭穿過頂板（榫槽跟著名牌位置走） */
function nameplateShape(L, opts) {
  const { t, e } = L;
  const height = Math.min(300, Math.max(20, Number(opts.height) || 60));
  const span = signSpan(L, opts, 0, 60);
  const w = span.x1 - span.x0;
  const tabL = Math.min(30, w / 5);
  const tabs = [0.25, 0.75].map((f) => span.x0 + w * f);
  const s = signPlate({
    x0: span.x0, x1: span.x1, top: e + height, t, tabs, tabL,
    shape: opts.shape, art: opts.art?.loops?.length ? opts.art : null, mode: opts.mode,
    margin: Math.max(4, L.P.bitDia * 2), minFeature: Math.max(1, L.P.bitDia), bandH: Math.min(e, 15),
  });
  return { ...s, tabs, tabL, height, span };
}

/**
 * 顏料名牌：夾在層板與固定孔板之間、罐子前方。
 * 下緣榫頭插進層板、上緣榫頭插進孔板，高度 = 兩板之間的空隙（不會凸出孔板卡到手）。
 */
function labelShape(L, opts, art) {
  const { t, tol } = L;
  const gap = L.retain - t; // 層板頂面到孔板底面
  const height = Math.max(4, gap - tol);
  const span = signSpan(L, opts, 1, 30);
  const w = span.x1 - span.x0;
  const tabL = Math.min(20, w / 6);
  const tabs = [0.2, 0.8].map((f) => span.x0 + w * f);
  const s = signPlate({
    x0: span.x0, x1: span.x1, top: height, t, tabs, tabL, topTabUp: t + tol,
    shape: 'rect', art, mode: opts.mode, margin: Math.max(1, Math.min(1.5, height * 0.12)), minFeature: Math.max(1, L.P.bitDia),
  });
  return { ...s, tabs, tabL, height, span };
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
  const vLocal = L.backY1 - rs - 4; // 背板上緣下方
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
  const capSide = finish(capSidePanelShape(L));
  const holeCircles = L.holeX.map((x) => ({ type: 'circle', c: [x, L.holeZ], r: L.holeD / 2 }));
  const np = options.nameplate?.enabled ? nameplateShape(L, options.nameplate) : null;

  // 每種顏料的名牌（各自開關，大小與位置全部連動）：夾在層板與孔板之間，兩片板都開榫槽
  const lab = options.labels?.enabled ? options.labels : null;
  const labelOn = (kind) => !!lab && kind < L.K && lab.items?.[kind]?.on !== false;
  const labelShapes = new Map();
  if (lab) {
    for (let k = 0; k < L.K; k++) {
      if (!labelOn(k)) continue;
      const item = lab.items?.[k];
      labelShapes.set(k, labelShape(L, lab, item?.art?.loops?.length ? item.art : null));
    }
  }
  const anyLabel = labelShapes.values().next().value;
  const labelSlots = anyLabel ? anyLabel.tabs.map((xc) => ({
    type: 'poly', pts: rectCW(xc - anyLabel.tabL / 2 - L.tol / 2, L.labelZ, xc + anyLabel.tabL / 2 + L.tol / 2, L.labelZ + t + L.tol),
  })) : [];
  const shelf = finish(plateShape(L, true, []));
  const holePlate = finish(plateShape(L, false, holeCircles));
  const shelfLabeled = anyLabel ? finish(plateShape(L, true, labelSlots)) : null;
  const holePlateLabeled = anyLabel ? finish(plateShape(L, false, [...holeCircles, ...labelSlots])) : null;

  const signs = [np, ...labelShapes.values()].filter(Boolean);
  const islands = signs.reduce((n, s) => n + s.islands, 0), tiny = signs.reduce((n, s) => n + s.tiny, 0);
  if (islands) warnings.push(`名牌鏤空：${islands} 個封閉內島（例如「口」「O」的中間）會掉出，已略過`);
  if (tiny) warnings.push(`名牌鏤空：${tiny} 個細節小於銑刀直徑 ${Math.max(1, P.bitDia)}mm，已略過`);
  const nz = L.spliceMid - t / 2; // 頂端名牌位於深度中間（前後卡扣之間）
  const npSlots = np ? np.tabs.map((xc) => ({
    type: 'poly', pts: rectCW(xc - np.tabL / 2 - L.tol / 2, nz - L.tol / 2, xc + np.tabL / 2 + L.tol / 2, nz + t + L.tol / 2),
  })) : [];
  const capPlate = finish(plateShape(L, false, npSlots));
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
    return parts[parts.length - 1];
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
        const kind = (j % L.myUnit) * L.rows + rI;
        const ls = labelShapes.get(kind);
        add(`${tag} 層板${rI + 1}`, 'shelf', ls ? shelfLabeled : shelf, [i, j], [x0, y0 + L.shelfY[rI] + t, 0], X, Z, [0, -0.3, 1]);
        add(`${tag} 孔板${rI + 1}`, 'holeplate', ls ? holePlateLabeled : holePlate, [i, j], [x0, y0 + L.holePlateY[rI] + t, 0], X, Z, [0, 0.3, 1.4]);
        if (ls) {
          const p = add(`${tag} 第${kind + 1}種 名牌`, 'label', { outer: dogbone(ls.outer, r), holes: ls.holes }, [i, j],
            [x0, y0 + L.shelfY[rI] + t, L.labelZ + L.tol / 2], X, Y, [0, 0, 2]);
          Object.assign(p, { engrave: ls.engrave, raster: ls.raster, artRect: ls.artRect, artMode: lab.mode, artKey: `label:${kind}`, labelKind: kind, span: ls.span });
        }
      }
    }
  }

  // 頂蓋：每一欄最上面一組（頂板 + 兩片短側板），也是頂端名牌的底座
  const capY0 = L.my * L.H;
  for (let i = 0; i < L.mx; i++) {
    const x0 = i * L.W, tag = `頂蓋${i + 1}`, mod = [i, L.my];
    add(`${tag} 左側板`, 'capside', capSide, mod, [x0 + t, capY0, 0], Z, Y, [-1, 0.6, 0]);
    add(`${tag} 右側板`, 'capside', capSide, mod, [x0 + L.W, capY0, 0], Z, Y, [1, 0.6, 0]);
    add(`${tag} 頂板`, 'top', capPlate, mod, [x0, capY0 + L.e + t, 0], X, Z, [0, 1, 0.5]);
    if (nameplate) {
      const p = add(`${tag} 展示名牌`, 'nameplate', nameplate, mod, [x0, capY0 + L.e + t, nz], X, Y, [0, 1.6, 0.4]);
      Object.assign(p, { engrave: np.engrave, raster: np.raster, artRect: np.artRect, artMode: options.nameplate.mode, artKey: 'top', span: np.span });
    }
  }

  // 水平延伸卡扣（相鄰模組側板上下緣；頂蓋只有下緣）
  for (let j = 0; j <= L.my; j++) {
    for (let i = 0; i < L.mx - 1; i++) {
      const xj = (i + 1) * L.W, y0 = j * L.H;
      L.clipZ.forEach((zc, k) => {
        if (j < L.my) add(`卡扣 H${i + 1}|${i + 2}-${j + 1} 上${k + 1}`, 'clip', clip, [i, j], [xj - clipRaw.cw / 2, y0 + L.H - clipRaw.hc, zc - t / 2], X, Y, [0, 1.2, 0]);
        add(`卡扣 H${i + 1}|${i + 2}-${j < L.my ? j + 1 : '頂蓋'} 下${k + 1}`, 'clip', clip, [i, j], [xj - clipRaw.cw / 2, y0 + clipRaw.hc, zc + t / 2], X, NY, [0, -1.2, 0]);
      });
    }
  }
  // 垂直連接板：每條上下接縫（含最上層與頂蓋之間），貼在側板內側、罐子旁邊，螺栓鎖緊
  for (let j = 0; j < L.my; j++) {
    for (let i = 0; i < L.mx; i++) {
      const x0 = i * L.W, yj = (j + 1) * L.H;
      const upper = j + 1 < L.my ? j + 2 : '頂蓋';
      add(`連接板 V${i + 1}-${j + 1}|${upper} 左`, 'splice', splice, [i, j], [x0 + 2 * t, yj, 0], Z, Y, [0.8, 0, 1]);
      add(`連接板 V${i + 1}-${j + 1}|${upper} 右`, 'splice', splice, [i, j], [x0 + L.W - t, yj, 0], Z, Y, [-0.8, 0, 1]);
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
            x: i * L.W + L.holeX[c],
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
  const hJoints = (L.mx - 1) * L.my, vJoints = L.mx * L.my;
  const boltLen = (n) => Math.ceil((n * t + P.bolt * 1.5 + 4) / 5) * 5;
  const hardware = [
    { name: `M${P.bolt} 螺栓 × ${boltLen(2)}mm`, use: '水平鎖點（穿過相鄰兩片側板）', qty: hJoints * L.rows },
    { name: `M${P.bolt} 螺栓 × ${boltLen(2)}mm`, use: '垂直連接板（側板 + 連接板，含頂蓋）', qty: vJoints * 2 * 4 },
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
      labelCount: parts.filter((p) => p.kind === 'label').length,
      labelH: anyLabel ? r2(anyLabel.height) : 0,
      nameplateSpan: np ? np.span : null,
      labelSpan: anyLabel ? anyLabel.span : null,
    },
  };
}
