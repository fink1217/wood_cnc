// 參數化顏料罐木架：產生所有 CNC 零件的 2D 輪廓與 3D 擺放資訊（不依賴 three.js）。
//
// 世界座標 (mm)：X = 寬（左→右）、Y = 高（下→上）、Z = 深（牆面 z=0 往外）。
// 每個模組 = 左右側板 + 背板 + 每列（層板 + 固定孔板）+ 頂板。
// 模組之間：水平延伸用 U 型卡扣（側板上下緣卡槽）+ 可選螺栓鎖點孔；
//           垂直堆疊用雙鳩尾卡榫（側板上下緣鳩尾槽）。
// 所有模組都切出延伸槽，日後可隨時再往旁邊或上方擴充。

import { dogbone, rectCW, keyholeCW, bbox, rectsOverlap } from './geometry.js';

export const DEFAULTS = {
  thickness: 9,
  tolerance: 0.2,
  canDia: 45,
  canHeight: 55,
  kinds: 6,
  perKind: 8,
  canGap: 6,
  holeClearance: 1.5,
  retainHeight: 22,
  liftClear: 5,
  frontMargin: 10,
  maxCols: 6,
  maxRows: 3,
  margin: 24,
  lockHoles: true,
  lockHoleDia: 6.5,
  keyholeHead: 10,
  keyholeShank: 5,
  keyholeLen: 10,
  dogbone: true,
  bitDia: 3.175,
  sheetW: 1220,
  sheetH: 2440,
  partGap: 10,
  gridSnap: 5,
};

// UI 用的參數描述
export const PARAM_SPEC = [
  { group: '木料與公差', key: 'thickness', label: '木頭厚度', unit: 'mm', min: 3, max: 30, step: 0.5 },
  { group: '木料與公差', key: 'tolerance', label: '組裝公差', unit: 'mm', min: 0, max: 1.5, step: 0.05, hint: '榫槽/卡槽單邊總加寬量' },
  { group: '顏料罐', key: 'canDia', label: '顏料罐直徑', unit: 'mm', min: 10, max: 200, step: 0.5 },
  { group: '顏料罐', key: 'canHeight', label: '顏料罐高度', unit: 'mm', min: 10, max: 300, step: 1 },
  { group: '顏料罐', key: 'kinds', label: '預計放幾種', unit: '種', min: 1, max: 60, step: 1, hint: '每種一列' },
  { group: '顏料罐', key: 'perKind', label: '每種放幾罐', unit: '罐', min: 1, max: 60, step: 1 },
  { group: '顏料罐', key: 'canGap', label: '罐間距', unit: 'mm', min: 2, max: 40, step: 0.5 },
  { group: '顏料罐', key: 'holeClearance', label: '罐孔餘隙', unit: 'mm', min: 0, max: 10, step: 0.1, hint: '孔徑 = 罐徑 + 餘隙' },
  { group: '顏料罐', key: 'retainHeight', label: '固定孔板高度', unit: 'mm', min: 5, max: 200, step: 1, hint: '孔板頂面距層板頂面' },
  { group: '顏料罐', key: 'liftClear', label: '取放餘隙', unit: 'mm', min: 0, max: 50, step: 1 },
  { group: '顏料罐', key: 'frontMargin', label: '前緣留邊', unit: 'mm', min: 0, max: 80, step: 1 },
  { group: '模組與延伸', key: 'maxCols', label: '每模組最多欄', unit: '罐', min: 1, max: 30, step: 1, hint: '超過即水平延伸' },
  { group: '模組與延伸', key: 'maxRows', label: '每模組最多列', unit: '列', min: 1, max: 20, step: 1, hint: '超過即垂直延伸' },
  { group: '模組與延伸', key: 'margin', label: '側板上下邊距', unit: 'mm', min: 14, max: 80, step: 1, hint: '卡扣/卡榫所在區域' },
  { group: '模組與延伸', key: 'lockHoles', label: '螺栓鎖點孔', type: 'bool' },
  { group: '模組與延伸', key: 'lockHoleDia', label: '鎖點孔徑', unit: 'mm', min: 2, max: 12, step: 0.1 },
  { group: '牆面掛孔', key: 'keyholeHead', label: '掛孔大圓徑', unit: 'mm', min: 4, max: 20, step: 0.5 },
  { group: '牆面掛孔', key: 'keyholeShank', label: '掛孔槽寬', unit: 'mm', min: 2, max: 12, step: 0.5 },
  { group: '牆面掛孔', key: 'keyholeLen', label: '掛孔滑移長', unit: 'mm', min: 4, max: 30, step: 0.5 },
  { group: '牆面掛孔', key: 'gridSnap', label: '拖拉吸附', unit: 'mm', min: 0, max: 50, step: 0.5 },
  { group: 'CNC 與板材', key: 'dogbone', label: '狗骨頭清角', type: 'bool' },
  { group: 'CNC 與板材', key: 'bitDia', label: '銑刀直徑', unit: 'mm', min: 0.5, max: 12.7, step: 0.005 },
  { group: 'CNC 與板材', key: 'sheetW', label: '板材寬', unit: 'mm', min: 200, max: 3000, step: 10 },
  { group: 'CNC 與板材', key: 'sheetH', label: '板材長', unit: 'mm', min: 200, max: 5000, step: 10 },
  { group: 'CNC 與板材', key: 'partGap', label: '排版間距', unit: 'mm', min: 2, max: 50, step: 1 },
];

export function normalizeParams(input) {
  const P = { ...DEFAULTS };
  for (const spec of PARAM_SPEC) {
    const v = input?.[spec.key];
    if (spec.type === 'bool') { if (typeof v === 'boolean') P[spec.key] = v; continue; }
    const n = Number(v);
    if (v !== undefined && v !== '' && Number.isFinite(n)) P[spec.key] = Math.min(spec.max, Math.max(spec.min, n));
  }
  for (const k of ['kinds', 'perKind', 'maxCols', 'maxRows']) P[k] = Math.round(P[k]);
  return P;
}

const range = (n) => Array.from({ length: n }, (_, i) => i);

/** 由參數推導出所有尺寸 */
export function deriveLayout(input) {
  const P = normalizeParams(input);
  const warnings = [];
  const t = P.thickness, tol = P.tolerance;
  const K = P.kinds, N = P.perKind;

  const mx = Math.ceil(N / P.maxCols), cols = Math.ceil(N / mx);
  const my = Math.ceil(K / P.maxRows), rows = Math.ceil(K / my);

  const gap = P.canGap;
  const pitch = P.canDia + gap;
  const holeD = P.canDia + P.holeClearance;
  if (pitch - holeD < 2) warnings.push(`罐孔之間木料僅 ${(pitch - holeD).toFixed(1)}mm，請加大罐間距或減少餘隙`);

  const inset = t; // 背板離牆距離（側板後緣貼牆）
  const zs = inset + t; // 層板後緣
  const holeZ = zs + gap / 2 + pitch / 2;
  let depth = holeZ + pitch / 2 + P.frontMargin;
  const minDepth = 60;
  if (depth < minDepth) depth = minDepth;

  let retain = P.retainHeight;
  const minRetain = t + tol + 3;
  if (retain < minRetain) {
    warnings.push(`固定孔板高度至少 ${minRetain.toFixed(1)}mm（板厚 + 公差 + 3），已自動調整`);
    retain = minRetain;
  }
  if (retain > P.canHeight * 0.8) warnings.push('固定孔板高度超過罐高 80%，取放罐子會較困難');

  const rowPitch = t + P.canHeight + retain + P.liftClear;
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
  const keyZ = (clipZ[0] + clipZ[1]) / 2;
  const keyB = Math.min(30, clipZ[1] - clipZ[0] - notchW - 8);
  const keyA = keyB * 0.6;
  if (keyB < 10) warnings.push('深度不足，垂直延伸卡榫過小；請加大前緣留邊');
  const clipLeg = Math.max(4, e - nd - 4);
  if (e - nd - 4 < 4) warnings.push('側板上下邊距太小，卡扣可能碰到頂板/底層板');
  const clipLegW = Math.max(6, t);

  const lockZ = (zs + depth) / 2;

  return {
    P, warnings, t, tol, K, N, mx, my, cols, rows, gap, pitch, holeD, inset, zs, holeZ, depth,
    retain, rowPitch, e, innerW, W, H, plateDepth, tabL, sideTabs, backTabL, backTabs,
    shelfY, holePlateY, topY, backSideTabL, backSideTabY, backY0, backY1,
    nd, notchW, clipZ, keyZ, keyA, keyB, clipLeg, clipLegW, lockZ,
    totalW: mx * W, totalH: my * H,
  };
}

// --- 零件模板 -------------------------------------------------------------

function rectNotch(c, w, d) {
  return [[c - w / 2, 0], [c - w / 2, d], [c + w / 2, d], [c + w / 2, 0]];
}
function dovetailNotch(c, a, b, d) {
  return [[c - a / 2, 0], [c - b / 2, d], [c + b / 2, d], [c + a / 2, 0]];
}

// 側板：2D (u = z 深度, v = y 高度)
function sidePanelShape(L) {
  const { t, tol, depth: D, H } = L;
  const notches = [
    ...rectNotch(L.clipZ[0], L.notchW, L.nd),
    ...dovetailNotch(L.keyZ, L.keyA, L.keyB, L.nd),
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
    if (L.P.lockHoles) holes.push({ type: 'circle', c: [L.lockZ, yc], r: L.P.lockHoleDia / 2 });
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

// 雙鳩尾卡榫：2D 以 (0,0) 為中心，u 沿深度、v 沿高度
function keyShape(L) {
  const kA = L.keyA - L.tol, kB = L.keyB - L.tol, kH = L.nd - L.tol / 2;
  return { outer: [[-kB / 2, -kH], [kB / 2, -kH], [kA / 2, 0], [kB / 2, kH], [-kB / 2, kH], [-kA / 2, 0]], holes: [] };
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

export function buildRack(input, mounts = []) {
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
  const top = finish(plateShape(L, true, []));
  const backBase = backPanelBase(L);
  const clipRaw = clipShape(L);
  const clip = finish(clipRaw);
  const key = finish(keyShape(L));

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
  // 垂直延伸卡榫（上下模組側板之間）
  for (let j = 0; j < L.my - 1; j++) {
    for (let i = 0; i < L.mx; i++) {
      const x0 = i * L.W, yj = (j + 1) * L.H;
      add(`卡榫 V${i + 1}-${j + 1}|${j + 2} 左`, 'key', key, [i, j], [x0 + t, yj, L.keyZ], Z, Y, [-0.6, 0, 1]);
      add(`卡榫 V${i + 1}-${j + 1}|${j + 2} 右`, 'key', key, [i, j], [x0 + L.W, yj, L.keyZ], Z, Y, [0.6, 0, 1]);
    }
  }

  // 罐子位置（視覺化）
  const cans = [];
  for (let j = 0; j < L.my; j++) {
    for (let i = 0; i < L.mx; i++) {
      for (let rI = 0; rI < L.rows; rI++) {
        const kind = j * L.rows + rI;
        if (kind >= L.K) continue;
        for (let c = 0; c < L.cols; c++) {
          const n = i * L.cols + c;
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

  return {
    params: P, layout: L, parts, cans, mounts: mountInfo, warnings, counts,
    info: {
      width: L.totalW, height: L.totalH, depth: L.depth,
      moduleW: L.W, moduleH: L.H, mx: L.mx, my: L.my, cols: L.cols, rows: L.rows,
      capacity, required: L.K * L.N, holeD: L.holeD, rowPitch: L.rowPitch,
    },
  };
}
