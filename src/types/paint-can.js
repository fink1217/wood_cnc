// 架子類型：顏料罐架。罐子直立，每一列 = 層板 + 固定孔板，可選每種顏料一片從正面插入的名牌板。
// 外框、接合、頂蓋與掛點由 system/frame.js 依拼裝規格產生。

import { rectCW, dogbone } from '../geometry.js';
import {
  clampNum, r1, r2, range, SHARED_DEFAULTS, THICKNESS_SPEC, TOLERANCE_SPEC, CHOICE_SPEC, ASSEMBLY_SPEC,
  MARGIN_SPEC, MAX_COLS_SPEC, MAX_ROWS_SPEC, MACHINE_ADVANCED_SPEC,
  normalizeWith, makeResolver, resolveMachine, resolveHardware, joints,
} from '../system/spec.js';
import { plateBetweenSides, assemble } from '../system/frame.js';
import { signPlate, signSpan } from '../system/signs.js';

export const DEFAULTS = {
  ...SHARED_DEFAULTS,
  canDia: 45,
  canHeight: 55,
  kinds: 6,
  perKind: 8,
  racksX: 1,
  racksY: 1,
  canGap: null,
  holeClearance: null,
  retainHeight: null,
  topGap: null,
  sideClear: null,
  frontMargin: null,
  maxCols: null,
  maxRows: null,
};

export const BASIC_SPEC = [
  THICKNESS_SPEC,
  TOLERANCE_SPEC,
  { key: 'canDia', label: '顏料罐直徑', unit: 'mm', min: 10, max: 200, step: 0.5 },
  { key: 'canHeight', label: '顏料罐高度', unit: 'mm', min: 10, max: 300, step: 1 },
  { key: 'kinds', label: '預計放幾種', unit: '種', min: 1, max: 60, step: 1, int: true },
  { key: 'perKind', label: '每種放幾罐', unit: '罐', min: 1, max: 60, step: 1, int: true },
];

export { CHOICE_SPEC, ASSEMBLY_SPEC };

// 放在基本區、但可自動連動的欄位（空白 = 自動）
export const LINKED_BASIC_SPEC = [
  { key: 'canGap', label: '罐子左右手指空間', unit: 'mm', min: 0, max: 60, step: 1 },
  { key: 'topGap', label: '罐頂到上層距離', unit: 'mm', min: 0, max: 300, step: 1 },
];

export const ADVANCED_SPEC = [
  { key: 'holeClearance', label: '罐孔餘隙', unit: 'mm', min: 0, max: 10, step: 0.1 },
  { key: 'sideClear', label: '罐子到側板間距', unit: 'mm', min: 0, max: 60, step: 0.5 },
  { key: 'retainHeight', label: '固定孔板高度', unit: 'mm', min: 0, max: 200, step: 1 },
  { key: 'frontMargin', label: '前緣留邊', unit: 'mm', min: 0, max: 100, step: 1 },
  MARGIN_SPEC,
  MAX_COLS_SPEC('罐'),
  MAX_ROWS_SPEC,
  ...MACHINE_ADVANCED_SPEC,
];

const NORMALIZE = {
  defaults: DEFAULTS,
  fixed: [...BASIC_SPEC, ...ASSEMBLY_SPEC],
  choice: CHOICE_SPEC,
  auto: [...LINKED_BASIC_SPEC, ...ADVANCED_SPEC],
};

/** 清理輸入：基本欄位夾到合法範圍；進階欄位 null/空字串 = 自動 */
export function normalizeParams(input = {}) {
  const P = normalizeWith(NORMALIZE, input);
  P.labelsOn = input.labelsOn === true; // 顏料名牌開啟：側板往前加深，前緣開名牌插槽
  // 顏料名牌高度（從層板底面算起；空白 = 蓋住層板與孔板前緣）：高過孔板時會連動罐頂距離
  P.labelH = P.labelsOn && Number(input.labelH) > 0 ? Number(input.labelH) : null;
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
  const resolve = makeResolver(raw, fields);

  const D = raw.canDia, h = raw.canHeight;
  const { t, tol, bitDia, kerf, sheetW, sheetH, partGap } = resolveMachine(raw, resolve, warnings);

  const holeClearance = resolve('holeClearance', clampNum(Math.round(D * 0.03 * 2) / 2, 1, 3), '罐徑 × 3%');
  // 罐子左右的間隙＝手指伸進去捏住罐子的空間（最外側罐子到側板也一樣）；只影響寬度，不影響深度
  const FINGER = 20;
  const canGap = resolve('canGap', FINGER, `${FINGER}mm 大約一根手指寬，罐子兩邊都捏得到`,
    [['min', holeClearance + 2, '孔跟孔之間至少要剩 2mm 木頭']]);
  if (canGap < 14) warnings.push(`罐子之間只有 ${canGap}mm，手指可能塞不進去，建議 18mm 以上`);
  // 罐孔前後的木料（深度方向），與手指空間無關
  const depthGap = Math.max(6, Math.ceil(holeClearance + 4), Math.ceil(t * 0.6));

  const minRetain = r2(t + tol + 3);
  const retainHeight = resolve('retainHeight', clampNum(Math.round(h * 0.35), minRetain, h * 0.6), '罐高 × 35%',
    [['max', r1(h * 0.8), '超過罐高 80% 就不好拿了'], ['min', minRetain, '孔板至少要比層板高出板厚 + 公差 + 3mm']]);
  if (minRetain > h * 0.8) warnings.push(`${h}mm 的罐子太矮，${t}mm 的板很難卡住，換薄一點的板比較好`);

  // 顏料名牌板：預設蓋住層板與孔板前緣（頂端比孔板低 2mm，不影響取罐）；最高到罐頂（再高只會遮住罐子）
  const labelH = raw.labelsOn ? r2(clampNum(raw.labelH ?? t + retainHeight - 2, 6, t + h)) : 0;
  if (raw.labelsOn && raw.labelH > t + h + 1e-6) warnings.push(`顏料名牌最高只到罐頂（${r2(t + h)}mm），再高就擋住罐子了`);
  // 取罐要提起的高度：先越過孔板；名牌高過孔板時，還要越過名牌才拿得出來
  const labelLift = raw.labelsOn ? labelH - t + 2 : 0; // 名牌頂端距層板頂面 + 2mm
  const lift = Math.max(retainHeight, labelLift);
  // 罐頂到上一層底面：至少要能把罐子提起上述高度再多 8mm，才好拿；只能往上調
  const liftRoom = 8;
  const minTopGap = r2(lift + liftRoom);
  const byLabel = labelLift > retainHeight;
  const topGap = resolve('topGap', minTopGap,
    byLabel ? `名牌比孔板高，罐子要先提過名牌，所以自動加高了` : `罐子提過孔板後再多 ${liftRoom}mm，比較好拿`,
    [['min', minTopGap, byLabel
      ? `至少 ${minTopGap}mm，不然罐子提不過名牌`
      : `至少 ${minTopGap}mm，不然罐子提不出孔板`]]);

  const hw = resolveHardware(raw, resolve);

  // 罐子到側板：要讓出貼在側板內側的垂直連接板與卡扣腳（接縫處仍是完整的罐位）
  const sideClear = resolve('sideClear', Math.max(canGap, hw.minSide), '側板內側要放連接板和卡扣',
    [['min', hw.minSide, '再小就放不下連接板和卡扣腳']]);

  // 深度需同時放得下罐孔與延伸接頭
  const pitch = D + canGap;
  const baseDepth = 2 * t + 1.5 * depthGap + D;
  const needDepth = hw.needDepth;
  const minFront = Math.max(0, Math.ceil(needDepth - baseDepth));
  const frontMargin = resolve('frontMargin', Math.max(10, minFront), minFront <= 10 ? '預設 10mm' : '加深一點，放連接板用',
    [['min', minFront, `深度不到 ${needDepth.toFixed(0)}mm 放不下連接板`]]);

  // 模組大小：自動時限制單一模組約 600mm 以內，並且一定要放得進板材
  const rowPitch = t + h + topGap;
  const usableLong = sheetH - 2 * partGap, usableShort = sheetW - 2 * partGap;
  const colsFor = (len) => Math.floor((len - 2 * t - 2 * sideClear - D) / pitch) + 1;
  const rowsFor = (len) => Math.floor(len / rowPitch); // 模組側板高 = 列數 × 列距（接縫處是完整罐位）
  const capCols = Math.max(1, colsFor(usableLong));
  const capRows = Math.max(1, rowsFor(usableLong));
  if (colsFor(usableLong) < 1 || rowsFor(usableLong) < 1) warnings.push('板材太小，一格罐位都排不下');
  const maxCols = resolve('maxCols', Math.max(1, Math.min(raw.perKind, colsFor(Math.min(600, usableShort)))), '模組寬約 600mm 內',
    [['max', capCols, '模組不能比板材寬']]);
  const maxRows = resolve('maxRows', Math.max(1, Math.min(raw.kinds, rowsFor(Math.min(600, usableLong)))), '模組高約 600mm 內',
    [['max', capRows, '模組不能比板材長']]);

  const P = {
    ...hw.shared,
    canDia: D, canHeight: h, kinds: raw.kinds, perKind: raw.perKind,
    canGap, depthGap, holeClearance, retainHeight, topGap, sideClear, frontMargin, maxCols, maxRows, labelsOn: raw.labelsOn, labelH,
    racksX: raw.racksX, racksY: raw.racksY,
    machine: raw.machine, kerf, dogbone: bitDia > 0, bitDia, sheetW, sheetH, partGap,
  };
  return { P, raw, fields, warnings };
}

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
  const dg = P.depthGap; // 罐孔前後留的木料（左右的手指空間不會讓木架變深）
  const holeZ = zs + dg + P.canDia / 2;
  const depth = holeZ + P.canDia / 2 + dg / 2 + P.frontMargin;
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

  // 接縫上方的空間：最上一列孔板頂面到側板頂緣（連接板下半與卡扣腳都在這裡，貼著側板、在罐子旁邊）
  const topRoom = rowPitch - e - retain - t;
  const J = joints({ t, tol, e, zs, frontZ: depth, boltHole: P.lockHoleDia, topRoom }, warnings);

  // 背板側邊榫頭與鎖點孔：每列放在孔板上方的空間；最上一列避開接縫處的連接板
  const spans = shelfY.map((y, r) => {
    const a = holePlateY[r] + t;
    const b = r < rows - 1 ? shelfY[r + 1] : H - J.spliceDown - 2;
    return [a, Math.max(a + 6, b)];
  });
  const minSpan = Math.min(...spans.map(([a, b]) => b - a));
  const backSideTabL = Math.max(6, Math.min(40, minSpan * 0.5));
  const backSideTabY = spans.map(([a, b]) => (a + b) / 2);
  const backExt = Math.min(e * 0.5, 8);
  const backY0 = e - backExt, backY1 = H - 1;
  const backSlots = [];
  for (const y0 of shelfY) {
    for (const xc of backTabs) {
      backSlots.push(rectCW(xc - backTabL / 2 - tol / 2, y0 - tol / 2, xc + backTabL / 2 + tol / 2, y0 + t + tol / 2));
    }
  }

  // 頂蓋：一片頂板 + 兩片短側板，像沒有罐位的模組一樣疊在最上面（也是頂端名牌的底座）
  const capH = e + t + e;

  // 顏料名牌板：在層板、孔板前方 1mm，兩端插進左右側板前緣的開口槽（側板因此往前加深）
  const labelZ = depth + 1;
  const sideDepth = P.labelsOn ? labelZ + t + tol + 1 : depth;

  return {
    P, raw, fields, warnings, t, tol, K, N, mx, my, cols, rows, gap, pitch, holeD, holeX, side, inset, zs, holeZ, depth,
    retain, rowPitch, e, innerW, W, H, plateDepth, tabL, sideTabs, backTabL, backTabs,
    shelfY, holePlateY, backSideTabL, backSideTabY, backY0, backY1, backSlots, capH, topRoom,
    mxUnit, myUnit, ...J, labelZ, sideDepth,
    capDepth: depth, capTabs: sideTabs, capTabL: tabL,
    totalW: mx * W, totalH: my * H + capH,
  };
}

// 層板 / 孔板：2D (u = x, v = z)
function plateShape(L, withBackTabs, circleHoles, frontNotches = []) {
  return plateBetweenSides({ t: L.t, W: L.W, z0: L.zs, z1: L.depth, tabs: L.sideTabs, tabL: L.tabL, backTabs: L.backTabs, backTabL: L.backTabL },
    withBackTabs, circleHoles, frontNotches);
}

/**
 * 顏料名牌板：獨立於放罐子的板材，位在層板與孔板前方，下緣對齊層板底面。
 * 兩端榫頭插進左右側板前緣的開口槽，從正面滑進去、推到底定位，隨時可往前拔出。
 * 高度自由（最高到罐頂），文字區用寬度／對齊／位移決定。
 */
function labelShape(L, opts, art) {
  const { t, tol, W } = L;
  const maxH = L.t + L.P.canHeight; // 最高到罐頂
  const height = L.P.labelH || r2(t + L.retain - 2); // 已在參數解析時連動罐頂距離
  const tabH = Math.min(height, 25);
  const x0 = t + tol / 2, x1 = W - t - tol / 2;
  // 兩端榫頭伸進側板厚度（與側板外面齊平）
  const outer = [[0, 0], [W, 0], [W, tabH], [x1, tabH], [x1, height], [x0, height], [x0, tabH], [0, tabH]];
  const span = signSpan(L, opts, 1, 30);
  const s = signPlate({
    x0: span.x0, x1: span.x1, top: height, t, tabs: [], tabL: 0,
    shape: 'rect', art, mode: opts.mode, margin: Math.max(1.5, Math.min(3, height * 0.12)), minFeature: Math.max(1, L.P.bitDia),
  });
  return { ...s, outer, height, maxH, tabH, span };
}

export const paintCan = {
  id: 'paint-can',
  name: '顏料罐架',
  summary: '罐子直立插在孔裡，每一列一種顏色，名牌從正面插在側板上。',
  itemNoun: '罐',
  DEFAULTS, BASIC_SPEC, LINKED_BASIC_SPEC, ADVANCED_SPEC, CHOICE_SPEC, ASSEMBLY_SPEC,
  normalizeParams, resolveParams,
  derive: deriveLayout,

  // 側板上層板與孔板的榫槽
  sideSlots(L) {
    const { t, tol } = L;
    const holes = [];
    for (const y0 of [...L.shelfY, ...L.holePlateY]) {
      for (const zc of L.sideTabs) {
        holes.push({ type: 'poly', pts: rectCW(zc - L.tabL / 2 - tol / 2, y0 - tol / 2, zc + L.tabL / 2 + tol / 2, y0 + t + tol / 2) });
      }
    }
    return holes;
  },

  prepare(L, options, finish) {
    const P = L.P, t = L.t;
    const frontNotches = options.labels?.enabled && P.labelsOn
      ? L.shelfY.map((y) => ({ y0: y, y1: y + Math.min(25, P.labelH || t + L.retain - 2), z: L.labelZ }))
      : [];
    const holeCircles = L.holeX.map((x) => ({ type: 'circle', c: [x, L.holeZ], r: L.holeD / 2 }));
    // 每種顏料的名牌（各自開關，大小與位置全部連動）
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
    return {
      frontNotches, lab, labelShapes,
      signs: [...labelShapes.values()],
      shelf: finish(plateShape(L, true, [])),
      holePlate: finish(plateShape(L, false, holeCircles)),
    };
  },

  moduleParts(L, ctx, add, i, j, tag, x0, y0) {
    const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
    const { t } = L;
    const r = L.P.dogbone ? L.P.bitDia / 2 : 0;
    for (let rI = 0; rI < L.rows; rI++) {
      const kind = (j % L.myUnit) * L.rows + rI;
      const ls = ctx.labelShapes.get(kind);
      add(`${tag} 層板${rI + 1}`, 'shelf', ctx.shelf, [i, j], [x0, y0 + L.shelfY[rI] + t, 0], X, Z, [0, -0.3, 1]);
      add(`${tag} 孔板${rI + 1}`, 'holeplate', ctx.holePlate, [i, j], [x0, y0 + L.holePlateY[rI] + t, 0], X, Z, [0, 0.3, 1.4]);
      if (ls) {
        const p = add(`${tag} 第${kind + 1}種 名牌`, 'label', { outer: dogbone(ls.outer, r), holes: ls.holes }, [i, j],
          [x0, y0 + L.shelfY[rI], L.labelZ], X, Y, [0, 0, 2.5]);
        Object.assign(p, { engrave: ls.engrave, raster: ls.raster, artRect: ls.artRect, artMode: ctx.lab.mode, artKey: `label:${kind}`, labelKind: kind, span: ls.span });
      }
    }
  },

  // 罐子位置（視覺化）
  items(L) {
    const P = L.P, t = L.t;
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
    return cans;
  },

  info(L, ctx, parts) {
    const anyLabel = ctx.labelShapes.values().next().value;
    const P = L.P;
    return {
      cols: L.cols, rows: L.rows,
      capacity: L.mx * L.cols * L.my * L.rows, required: L.K * L.N * P.racksX * P.racksY, holeD: L.holeD, rowPitch: L.rowPitch,
      labelCount: parts.filter((p) => p.kind === 'label').length,
      labelH: anyLabel ? r2(anyLabel.height) : 0,
      labelHMax: r2(L.t + P.canHeight),
      labelSpan: anyLabel ? anyLabel.span : null,
    };
  },
};


export function buildRack(input, mounts = [], options = {}) {
  return assemble(paintCan, input, mounts, options);
}
