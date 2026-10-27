// 架子類型：斜放長漆瓶架。瓶子尖嘴朝前、往下斜，瓶底頂在背板上。
// 每一列 = 一條前孔條（從正面插進側板的開口槽，可拔出重切）+ 一條後孔條（榫頭穿過側板）。
// 孔切成橢圓：斜著穿過板子的圓柱，在垂直的板面上是上下較長的橢圓，再加上板厚造成的位移。
// 名牌刻在前孔條的孔上方（尖嘴往下斜，刻在孔下方會被瓶子擋住）。
// 外框、接合、頂蓋與掛點由 system/frame.js 依拼裝規格產生，可以跟其他類型的模組疊在一起。

import { rectCW } from '../geometry.js';
import {
  clampNum, r2, range, SHARED_DEFAULTS, THICKNESS_SPEC, TOLERANCE_SPEC, CHOICE_SPEC, ASSEMBLY_SPEC,
  MARGIN_SPEC, MAX_COLS_SPEC, MAX_ROWS_SPEC, MACHINE_ADVANCED_SPEC, MODULE_W_SPEC,
  normalizeWith, makeResolver, resolveMachine, resolveHardware, joints, snapWidth,
} from '../system/spec.js';
import { assemble } from '../system/frame.js';
import { signPlate, signSpan } from '../system/signs.js';

export const DEFAULTS = {
  ...SHARED_DEFAULTS,
  bottleDia: 39,
  bottleLen: 100,
  kinds: 6,
  perKind: 6,
  racksX: 1,
  racksY: 1,
  tilt: null,
  canGap: null,
  stickOut: null,
  holeClearance: null,
  web: null,
  labelBand: null,
  sideClear: null,
  maxCols: null,
  maxRows: null,
  moduleW: null,
};

export const BASIC_SPEC = [
  THICKNESS_SPEC,
  TOLERANCE_SPEC,
  { key: 'bottleDia', label: '瓶子外徑', unit: 'mm', min: 10, max: 120, step: 0.5 },
  { key: 'bottleLen', label: '瓶子全長', unit: 'mm', min: 30, max: 300, step: 1, hint: '含尖嘴' },
  { key: 'kinds', label: '預計放幾種', unit: '種', min: 1, max: 60, step: 1, int: true },
  { key: 'perKind', label: '每種放幾瓶', unit: '瓶', min: 1, max: 60, step: 1, int: true },
];

export { CHOICE_SPEC, ASSEMBLY_SPEC };

export const LINKED_BASIC_SPEC = [
  { key: 'tilt', label: '尖嘴朝下傾斜', unit: '°', min: 0, max: 40, step: 1 },
  { key: 'canGap', label: '瓶子左右手指空間', unit: 'mm', min: 0, max: 60, step: 1 },
  { key: 'stickOut', label: '瓶子露出長度', unit: 'mm', min: 0, max: 200, step: 1 },
];

export const ADVANCED_SPEC = [
  { key: 'holeClearance', label: '瓶孔餘隙', unit: 'mm', min: 0, max: 10, step: 0.1 },
  { key: 'web', label: '孔上下留的木料', unit: 'mm', min: 2, max: 40, step: 0.5 },
  { key: 'labelBand', label: '名牌刻字高度', unit: 'mm', min: 4, max: 60, step: 1 },
  { key: 'sideClear', label: '瓶子到側板間距', unit: 'mm', min: 0, max: 60, step: 0.5 },
  MARGIN_SPEC,
  MAX_COLS_SPEC('瓶'),
  MAX_ROWS_SPEC,
  MODULE_W_SPEC,
  ...MACHINE_ADVANCED_SPEC,
];

const NORMALIZE = {
  defaults: DEFAULTS,
  fixed: [...BASIC_SPEC, ...ASSEMBLY_SPEC],
  choice: CHOICE_SPEC,
  auto: [...LINKED_BASIC_SPEC, ...ADVANCED_SPEC],
};

export function normalizeParams(input = {}) {
  const P = normalizeWith(NORMALIZE, input);
  P.labelsOn = input.labelsOn === true; // 刻名牌：前孔條在孔上方多一條刻字區
  return P;
}

const TOP_ROOM = 16; // 模組上緣下方留給連接板下半與卡扣腳的高度

export function resolveParams(input = {}) {
  const raw = normalizeParams(input);
  const fields = {};
  const warnings = [];
  const resolve = makeResolver(raw, fields);

  const D = raw.bottleDia, Lb = raw.bottleLen;
  const { t, bitDia, kerf, sheetW, sheetH, partGap } = resolveMachine(raw, resolve, warnings);

  const tilt = resolve('tilt', 15, '尖嘴朝下一點，顏料會停在尖嘴那頭', [['max', 40, '再斜瓶子會滑出來']]);
  const holeClearance = resolve('holeClearance', clampNum(Math.round(D * 0.03 * 2) / 2, 1, 3), '瓶徑 × 3%');
  const canGap = resolve('canGap', 10, '瓶子是捏露出來的那段拿，不用留到一根手指寬',
    [['min', holeClearance + 2, '孔跟孔之間至少要剩 2mm 木頭']]);
  const stickOut = resolve('stickOut', Math.round(Lb * 0.3), '全長的三成露在外面，捏得到瓶肩',
    [['max', Math.round(Lb * 0.6), '露太多瓶子會往前翻'], ['min', 0, '']]);
  const web = resolve('web', Math.max(5, Math.ceil(t * 0.6)), '孔上下各留一點木料，前孔條才不會斷');
  const labelBand = raw.labelsOn ? resolve('labelBand', 12, '孔上方刻字的高度') : resolve('labelBand', 12, '開啟顏料名牌時才用到');

  const hw = resolveHardware(raw, resolve);
  const sideClear = resolve('sideClear', Math.max(canGap, hw.minSide + 4), '側板內側要放連接板、卡扣腳和鎖點的螺帽',
    [['min', hw.minSide, '再小就放不下連接板和卡扣腳']]);

  // 一列的高度：孔（橢圓）上下各一段木料，開名牌時孔上方再加刻字區
  const th = (tilt * Math.PI) / 180;
  const R = (D + holeClearance) / 2;
  const bHalf = R / Math.cos(th) + (t * Math.tan(th)) / 2;
  const pitchY = 2 * web + 2 * bHalf + (raw.labelsOn ? labelBand : 0) + 1;
  const pitch = D + canGap;
  const usableLong = sheetH - 2 * partGap, usableShort = sheetW - 2 * partGap;
  const colsFor = (len) => Math.floor((len - 2 * t - 2 * sideClear - D) / pitch) + 1;
  const rowsFor = (len) => Math.floor((len - hw.margin - TOP_ROOM - D * Math.tan(th)) / pitchY);
  const capCols = Math.max(1, colsFor(usableLong));
  const capRows = Math.max(1, rowsFor(usableLong));
  if (colsFor(usableLong) < 1 || rowsFor(usableLong) < 1) warnings.push('板材太小，一格瓶位都排不下');
  const maxCols = resolve('maxCols', Math.max(1, Math.min(raw.perKind, colsFor(Math.min(600, usableShort)))), '模組寬約 600mm 內',
    [['max', capCols, '模組不能比板材寬']]);
  const maxRows = resolve('maxRows', Math.max(1, Math.min(raw.kinds, rowsFor(Math.min(600, usableLong)))), '模組高約 600mm 內',
    [['max', capRows, '模組不能比板材長']]);

  const P = {
    ...hw.shared,
    bottleDia: D, bottleLen: Lb, kinds: raw.kinds, perKind: raw.perKind,
    tilt, canGap, stickOut, holeClearance, web, labelBand, sideClear, maxCols, maxRows, labelsOn: raw.labelsOn,
    needDepth: hw.needDepth, pitchY, bHalf,
    racksX: raw.racksX, racksY: raw.racksY,
    machine: raw.machine, kerf, dogbone: bitDia > 0, bitDia, sheetW, sheetH, partGap,
  };
  return { P, raw, fields, warnings };
}

/** 斜孔條：u = x、v = y（條底為 0）；左右榫頭穿過側板，榫頭在條高的中段 */
function stripShape(L, h, tab0, tab1, holes) {
  const { t, W } = L;
  return {
    outer: [[t, 0], [W - t, 0], [W - t, tab0], [W, tab0], [W, tab1], [W - t, tab1], [W - t, h], [t, h], [t, tab1], [0, tab1], [0, tab0], [t, tab0]],
    holes,
  };
}

/** 橢圓孔（順時針，材料在左） */
function ellipseCW(cx, cy, a, b, n = 48) {
  return Array.from({ length: n }, (_, k) => {
    const ang = (-2 * Math.PI * k) / n;
    return [cx + a * Math.cos(ang), cy + b * Math.sin(ang)];
  });
}

export function deriveLayout(input) {
  const { P, raw, fields, warnings } = resolveParams(input);
  const t = P.thickness, tol = P.tolerance;
  const K = P.kinds, N = P.perKind;
  const D = P.bottleDia, Lb = P.bottleLen;
  const th = (P.tilt * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th), tan = Math.tan(th);

  const mxUnit = Math.ceil(N / P.maxCols), cols = Math.ceil(N / mxUnit);
  const myUnit = Math.ceil(K / P.maxRows), rows = Math.ceil(K / myUnit);
  const mx = mxUnit * P.racksX, my = myUnit * P.racksY;

  const gap = P.canGap, pitch = D + gap;
  const holeW = D + P.holeClearance;
  const a = holeW / 2, b = P.bHalf; // 孔的半寬、半高
  const needW = 2 * P.sideClear + D + (cols - 1) * pitch + 2 * t;
  const W = snapWidth(needW, raw.moduleW, fields, P.sheetH - 2 * P.partGap);
  const side = P.sideClear + (W - needW) / 2;
  const holeX = range(cols).map((c) => t + side + D / 2 + c * pitch);

  // 深度（側視）：瓶底中心 zb 讓瓶底斜面剛好頂到背板前面；前孔條前面 = 瓶子露出的起點
  const inset = t, zs = inset + t;
  const zb = zs + 1 + (D / 2) * sin;
  let zf = zb + (Lb - P.stickOut) * cos - t; // 前孔條後面
  const sideDepthFor = (z) => z + t + tol + 1;
  if (sideDepthFor(zf) < P.needDepth) {
    // 瓶子太短：前孔條往前移，深度至少要放得下連接板
    zf = P.needDepth - t - tol - 1;
    warnings.push(`瓶子比較短，為了放連接板，露出長度變成 ${r2(Math.max(0, Lb - (zf + t - zb) / cos))}mm`);
  }
  const sideDepth = sideDepthFor(zf);
  const stickOut = r2(Math.max(0, Lb - (zf + t - zb) / cos));

  const e = P.margin;
  const J0 = joints({ t, tol, e, zs, frontZ: P.needDepth, boltHole: P.lockHoleDia, topRoom: TOP_ROOM, roomFix: '' }, []);
  // 後孔條：靠近瓶底撐住瓶身；避開左右鎖點螺栓的位置
  const rBolt = P.lockHoleDia / 2;
  const zrMin = zb + (D / 2) * sin + 2;
  const zrMax = zf - t - 12;
  let zr = clampNum(zb + (D / 2) * sin + 0.25 * (zf - zb), zrMin, zrMax);
  const hitsLock = (z) => z - tol / 2 < J0.lockZ + rBolt + 2 && z + t + tol / 2 > J0.lockZ - rBolt - 2;
  if (hitsLock(zr)) {
    const behind = J0.lockZ - rBolt - 2 - t - tol / 2 - 0.5, front = J0.lockZ + rBolt + 2 + tol / 2 + 0.5;
    const options = [behind, front].filter((z) => z >= zrMin - 1e-6 && z <= zrMax + 1e-6);
    zr = options.length ? options.sort((p, q) => Math.abs(p - zr) - Math.abs(q - zr))[0] : zr;
  }
  if (zrMax < zrMin) warnings.push('瓶子太短，前後孔條擠在一起，瓶子會晃；把露出長度調小一點');
  const lift = (zf - zr) * tan; // 後孔比前孔高多少（往後越高）

  // 每一列：前孔條（條底 rowY）孔在下、刻字區在上；後孔條跟著瓶子往後抬高
  const pitchY = P.pitchY;
  const band = P.labelsOn ? P.labelBand : 0;
  const frontH = pitchY - 1;
  const rowY = range(rows).map((i) => e + i * pitchY);
  const holeY = rowY.map((y) => y + P.web + b); // 前孔中心
  const rearY = holeY.map((y) => y + lift); // 後孔中心
  const rearH = 2 * (P.web + b);
  const frontTab = [frontH * 0.2, frontH * 0.8];
  const rearTab = [rearH * 0.2, rearH * 0.8];
  const H = Math.max(e + rows * pitchY, rearY[rows - 1] + b + P.web) + TOP_ROOM;
  const topRoom = H - (rearY[rows - 1] + b + P.web);
  const J = joints({ t, tol, e, zs, frontZ: P.needDepth, boltHole: P.lockHoleDia, topRoom, roomFix: '把模組加高一點' }, warnings);

  // 背板左右榫頭與鎖點孔：每列一組，在前孔中心的高度
  const backSideTabL = Math.max(6, Math.min(30, pitchY * 0.4));
  const backSideTabY = holeY;
  const backExt = Math.min(e * 0.5, 8);
  const backY0 = e - backExt, backY1 = H - 1;
  const capH = e + t + e;
  const capDepth = zf + t;
  const capTabL = Math.min(30, (capDepth - zs) / 4);
  const capTabs = [0.25, 0.75].map((f) => zs + (capDepth - zs) * f);

  // 瓶子在每一列的位置（視覺化與測試用）：瓶底中心、方向
  const bottleBase = (yHole) => {
    const zc = zf + t / 2; // 前孔條中間的平面
    return [zb, yHole + (zc - zb) * tan];
  };

  return {
    P, raw, fields, warnings, t, tol, K, N, mx, my, cols, rows, gap, pitch, holeD: holeW, holeW, holeX, side, inset, zs,
    zb, zf, zr, lift, a, b, band, frontH, rearH, frontTab, rearTab, rowY, holeY, rearY, stickOut, bottleBase,
    depth: capDepth, rowPitch: pitchY, e, W, H, mxUnit, myUnit, topRoom,
    backSideTabL, backSideTabY, backY0, backY1, backSlots: [], capH, capDepth, capTabs, capTabL,
    ...J, sideDepth, labelZ: zf,
    totalW: mx * W, totalH: my * H + capH,
  };
}

export const slantBottle = {
  id: 'slant-bottle',
  name: '斜放長漆瓶架',
  summary: '尖嘴瓶斜插在孔裡，尖嘴朝前微微往下，名牌刻在每一列的孔上方。',
  itemNoun: '瓶',
  DEFAULTS, BASIC_SPEC, LINKED_BASIC_SPEC, ADVANCED_SPEC, CHOICE_SPEC, ASSEMBLY_SPEC,
  normalizeParams, resolveParams,
  derive: deriveLayout,

  // 側板上後孔條的榫槽（前孔條走前緣的開口槽）
  sideSlots(L) {
    const { t, tol } = L;
    return L.rearY.map((yc) => {
      const y0 = yc - L.rearH / 2;
      return { type: 'poly', pts: rectCW(L.zr - tol / 2, y0 + L.rearTab[0] - tol / 2, L.zr + t + tol / 2, y0 + L.rearTab[1] + tol / 2) };
    });
  },

  prepare(L, options, finish) {
    const t = L.t;
    const frontNotches = L.rowY.map((y) => ({ y0: y + L.frontTab[0], y1: y + L.frontTab[1], z: L.zf }));
    const frontHoles = (vc) => L.holeX.map((x) => ({ type: 'poly', pts: ellipseCW(x, vc, L.a, L.b) }));
    const rear = finish(stripShape(L, L.rearH, L.rearTab[0], L.rearTab[1], frontHoles(L.rearH / 2)));
    // 前孔條：孔在下、刻字區在上；開名牌時每一種各自刻
    const lab = options.labels?.enabled && L.P.labelsOn ? options.labels : null;
    const vHole = L.P.web + L.b;
    const plain = finish(stripShape(L, L.frontH, L.frontTab[0], L.frontTab[1], frontHoles(vHole)));
    const labeled = new Map();
    if (lab) {
      for (let k = 0; k < L.K; k++) {
        if (lab.items?.[k]?.on === false) continue;
        const art = lab.items?.[k]?.art?.loops?.length ? lab.items[k].art : null;
        const span = signSpan(L, lab, 1, 30);
        const y0 = vHole + L.b + L.P.web * 0.5;
        const s = signPlate({
          x0: span.x0, x1: span.x1, top: L.band, t, tabs: [], tabL: 0, shape: 'rect', art, mode: lab.mode,
          margin: 1.5, minFeature: Math.max(1, L.P.bitDia),
        });
        // signPlate 以刻字區底為 0，移到孔的上方
        const shift = (pts) => pts.map(([x, y]) => [x, y + y0]);
        const strip = finish(stripShape(L, L.frontH, L.frontTab[0], L.frontTab[1], frontHoles(vHole)));
        strip.holes.push(...s.holes.map((h) => ({ ...h, pts: shift(h.pts) })));
        labeled.set(k, {
          shape: strip, span, height: L.band, islands: s.islands, tiny: s.tiny,
          engrave: s.engrave.map(shift), artRect: s.artRect && { ...s.artRect, y: s.artRect.y + y0 },
          raster: s.raster && { ...s.raster, y: s.raster.y + y0 },
        });
      }
    }
    return { frontNotches, rear, plain, labeled, lab, signs: [...labeled.values()] };
  },

  moduleParts(L, ctx, add, i, j, tag, x0, y0) {
    const X = [1, 0, 0], Y = [0, 1, 0];
    for (let rI = 0; rI < L.rows; rI++) {
      const kind = (j % L.myUnit) * L.rows + rI;
      const ls = kind < L.K ? ctx.labeled.get(kind) : null;
      const p = add(`${tag} 前孔條${rI + 1}`, 'front', ls ? ls.shape : ctx.plain, [i, j], [x0, y0 + L.rowY[rI], L.zf], X, Y, [0, 0, 2.2]);
      if (ls) Object.assign(p, { engrave: ls.engrave, raster: ls.raster, artRect: ls.artRect, artMode: ctx.lab.mode, artKey: `label:${kind}`, labelKind: kind, span: ls.span });
      add(`${tag} 後孔條${rI + 1}`, 'rear', ctx.rear, [i, j], [x0, y0 + L.rearY[rI] - L.rearH / 2, L.zr], X, Y, [0, 0.4, 1.2]);
    }
  },

  // 瓶子：瓶底中心、朝外往下的方向、半徑、全長
  items(L) {
    const P = L.P;
    const th = (P.tilt * Math.PI) / 180;
    const dir = [0, -Math.sin(th), Math.cos(th)];
    const out = [];
    for (let j = 0; j < L.my; j++) {
      for (let i = 0; i < L.mx; i++) {
        for (let rI = 0; rI < L.rows; rI++) {
          const kind = (j % L.myUnit) * L.rows + rI;
          if (kind >= L.K) continue;
          const [zb, yb] = L.bottleBase(L.holeY[rI]);
          for (let c = 0; c < L.cols; c++) {
            const n = (i % L.mxUnit) * L.cols + c;
            if (n >= L.N) continue;
            out.push({ shape: 'bottle', kind, module: [i, j], x: i * L.W + L.holeX[c], y: j * L.H + yb, z: zb, dir, r: P.bottleDia / 2, len: P.bottleLen });
          }
        }
      }
    }
    return out;
  },

  info(L, ctx, parts) {
    const P = L.P;
    const any = ctx.labeled.values().next().value;
    return {
      cols: L.cols, rows: L.rows,
      capacity: L.mx * L.cols * L.my * L.rows, required: L.K * L.N * P.racksX * P.racksY, holeD: L.holeW, rowPitch: L.rowPitch,
      stickOut: L.stickOut, tilt: P.tilt,
      labelCount: parts.filter((p) => p.kind === 'front' && p.artKey).length,
      labelH: any ? r2(any.height) : 0, labelHMax: 0, labelSpan: any ? any.span : null,
    };
  },
};

export function buildRack(input, mounts = [], options = {}) {
  return assemble(slantBottle, input, mounts, options);
}

