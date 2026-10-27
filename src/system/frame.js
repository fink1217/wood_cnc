// 共用骨架：側板、背板、頂蓋、U 型卡扣、垂直連接板、牆面掛點，以及把模組排成多欄多層的組裝。
// 各架子類型只負責模組「裡面」的零件（層板、孔板、斜孔板…），外框與接合都在這裡照拼裝規格產生。
//
// 類型的 derive() 要提供的版面 L（除了 spec.joints() 算出的接合尺寸）：
//   P, t, tol, e, W, H, mx, my, inset, zs, sideDepth, capDepth, capTabs, capTabL,
//   backSideTabY, backSideTabL, backY0, backY1, backSlots, capH, totalW, totalH, warnings
// 類型物件要提供：derive(input)、prepare(L, options, finish, r)、moduleParts(L, ctx, add, i, j)、
//   sideSlots(L)、items(L)、info(L, ctx, parts)

import { dogbone, rectCW, keyholeCW, bbox, rectsOverlap } from '../geometry.js';
import { nameplateShape } from './signs.js';

export function rectNotch(c, w, d) {
  return [[c - w / 2, 0], [c - w / 2, d], [c + w / 2, d], [c + w / 2, 0]];
}

/**
 * 側板：2D (u = z 深度, v = y 高度)。上下緣有卡扣槽；typeSlots 是類型零件的榫槽；
 * frontNotches = [{ y0, y1, z }]：從前緣往內的開口槽（名牌板從正面滑進來）。
 */
export function sidePanelShape(L, typeSlots, frontNotches = []) {
  const { tol, sideDepth: D, H } = L;
  const notches = [
    ...rectNotch(L.clipZ[0], L.notchW, L.nd),
    ...rectNotch(L.clipZ[1], L.notchW, L.nd),
  ];
  const bottom = notches.map(([s, d]) => [s, d]);
  const top = notches.map(([s, d]) => [s, H - d]).reverse();
  const front = [];
  for (const n of frontNotches) front.push([D, n.y0 - tol / 2], [n.z - tol / 2, n.y0 - tol / 2], [n.z - tol / 2, n.y1 + tol / 2], [D, n.y1 + tol / 2]);
  const outer = [[0, 0], ...bottom, [D, 0], ...front, [D, H], ...top, [0, H]];

  const holes = [...typeSlots];
  for (const yc of L.backSideTabY) {
    holes.push({ type: 'poly', pts: rectCW(L.inset - tol / 2, yc - L.backSideTabL / 2 - tol / 2, L.inset + L.t + tol / 2, yc + L.backSideTabL / 2 + tol / 2) });
    holes.push({ type: 'circle', c: [L.lockZ, yc], r: L.P.lockHoleDia / 2 });
  }
  // 垂直連接板螺栓孔：底部邊距一組、上緣下方一組（每片側板都切，方便日後往上延伸）
  for (const z of L.spliceBoltZ) {
    for (const y of [L.spliceBoltUp, H - L.spliceBoltDown]) holes.push({ type: 'circle', c: [z, y], r: L.P.lockHoleDia / 2 });
  }
  return { outer, holes };
}

/** 板子在兩片側板之間、左右各有榫頭穿過側板。2D (u = x, v = z)，深度範圍 z0..z1 */
export function plateBetweenSides({ t, W, z0, z1, tabs, tabL, backTabs = [], backTabL = 0 }, withBackTabs, holes, frontNotches = []) {
  const pts = [[t, z0]];
  if (withBackTabs) {
    for (const xc of backTabs) {
      pts.push([xc - backTabL / 2, z0], [xc - backTabL / 2, z0 - t], [xc + backTabL / 2, z0 - t], [xc + backTabL / 2, z0]);
    }
  }
  pts.push([W - t, z0]);
  for (const zc of tabs) pts.push([W - t, zc - tabL / 2], [W, zc - tabL / 2], [W, zc + tabL / 2], [W - t, zc + tabL / 2]);
  pts.push([W - t, z1]);
  for (const n of [...frontNotches].sort((a, b) => b.x0 - a.x0)) pts.push([n.x1, z1], [n.x1, n.z0], [n.x0, n.z0], [n.x0, z1]);
  pts.push([t, z1]);
  for (const zc of [...tabs].reverse()) pts.push([t, zc + tabL / 2], [0, zc + tabL / 2], [0, zc - tabL / 2], [t, zc - tabL / 2]);
  return { outer: pts, holes };
}

// 頂蓋側板：只有底部的卡扣槽與連接板螺栓孔，頂板在底部邊距之上
function capSidePanelShape(L) {
  const { t, tol, sideDepth: D, capH, e } = L;
  const notches = [...rectNotch(L.clipZ[0], L.notchW, L.nd), ...rectNotch(L.clipZ[1], L.notchW, L.nd)];
  const outer = [[0, 0], ...notches, [D, 0], [D, capH], [0, capH]];
  const holes = L.capTabs.map((zc) => ({ type: 'poly', pts: rectCW(zc - L.capTabL / 2 - tol / 2, e - tol / 2, zc + L.capTabL / 2 + tol / 2, e + t + tol / 2) }));
  for (const z of L.spliceBoltZ) holes.push({ type: 'circle', c: [z, L.spliceBoltUp], r: L.P.lockHoleDia / 2 });
  return { outer, holes };
}

// 背板：2D (u = x, v = y)。左右榫頭插進側板；backSlots 是類型零件插進背板的槽
export function backPanelBase(L) {
  const { t, W, backY0, backY1 } = L;
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
  return { outer: pts, slots: L.backSlots };
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
  for (const s of L.backSlots) {
    if (rectsOverlap(kb, bbox(s), pad)) return { ...result, valid: false, reason: '與層板榫槽重疊' };
  }
  // 類型自己的禁區（例如瓶底頂著背板的位置）：螺絲頭在掛點那一點，半徑約 R
  const head = { minX: u - R, maxX: u + R, minY: v - R, maxY: v + R };
  for (const k of L.mountKeepout || []) {
    if (rectsOverlap(head, k, pad)) return { ...result, valid: false, reason: k.reason };
  }
  return result;
}

/** 預設掛點：每個模組背板上緣下方左右各一 */
export function autoMounts(L) {
  const out = [];
  const R = L.P.keyholeHead / 2;
  const rs = Math.min(L.P.keyholeShank / 2, R * 0.95);
  const vLocal = L.backY1 - rs - 4;
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

/** 依類型產生整座架子：每個模組的骨架 + 類型零件、頂蓋與頂端名牌、卡扣、連接板、五金與摘要 */
export function assemble(type, input, mounts = [], options = {}) {
  const L = type.derive(input);
  const P = L.P;
  const warnings = [...L.warnings];
  const r = P.dogbone ? P.bitDia / 2 : 0;
  const finish = (shape) => ({
    outer: dogbone(shape.outer, r),
    holes: shape.holes.map((h) => (h.type === 'poly' ? { ...h, pts: dogbone(h.pts, r) } : h)),
  });

  const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1], NY = [0, -1, 0];
  const t = L.t;

  const ctx = type.prepare(L, options, finish, r);
  const side = finish(sidePanelShape(L, type.sideSlots(L), ctx.frontNotches || []));
  const capSide = finish(capSidePanelShape(L));
  const np = options.nameplate?.enabled ? nameplateShape(L, options.nameplate) : null;

  const signs = [np, ...(ctx.signs || [])].filter(Boolean);
  const islands = signs.reduce((n, s) => n + s.islands, 0), tiny = signs.reduce((n, s) => n + s.tiny, 0);
  if (islands) warnings.push(`鏤空時「口」「O」這種字中間會掉出來，有 ${islands} 處沒切（內島）`);
  if (tiny) warnings.push(`有 ${tiny} 處比 ${Math.max(1, P.bitDia)}mm 的刀還細，鏤空時沒切`);
  const nz = L.spliceMid - t / 2; // 頂端名牌位於深度中間（前後卡扣之間）
  const npSlots = np ? np.tabs.map((xc) => ({
    type: 'poly', pts: rectCW(xc - np.tabL / 2 - L.tol / 2, nz - L.tol / 2, xc + np.tabL / 2 + L.tol / 2, nz + t + L.tol / 2),
  })) : [];
  const capPlate = finish(plateBetweenSides({ t, W: L.W, z0: L.zs, z1: L.capDepth, tabs: L.capTabs, tabL: L.capTabL }, false, npSlots));
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

      type.moduleParts(L, ctx, add, i, j, tag, x0, y0);
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
      Object.assign(p, { engrave: np.engrave, raster: np.raster, artRect: np.artRect, artMode: options.nameplate.mode, artKey: 'top', span: np.span, artPos: np.artPos });
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
  // 垂直連接板：每條上下接縫（含最上層與頂蓋之間），貼在側板內側，螺栓鎖緊
  for (let j = 0; j < L.my; j++) {
    for (let i = 0; i < L.mx; i++) {
      const x0 = i * L.W, yj = (j + 1) * L.H;
      const upper = j + 1 < L.my ? j + 2 : '頂蓋';
      add(`連接板 V${i + 1}-${j + 1}|${upper} 左`, 'splice', splice, [i, j], [x0 + 2 * t, yj, 0], Z, Y, [0.8, 0, 1]);
      add(`連接板 V${i + 1}-${j + 1}|${upper} 右`, 'splice', splice, [i, j], [x0 + L.W - t, yj, 0], Z, Y, [-0.8, 0, 1]);
    }
  }

  const items = type.items(L);
  for (const p of parts) p.bounds = bbox(p.outer);

  const counts = {};
  for (const p of parts) counts[p.kind] = (counts[p.kind] || 0) + 1;
  const hJoints = (L.mx - 1) * L.my, vJoints = L.mx * L.my;
  const locks = hJoints * L.backSideTabY.length;
  const boltLen = (n) => Math.ceil((n * t + P.bolt * 1.5 + 4) / 5) * 5;
  const hardware = [
    { name: `M${P.bolt} 螺栓 × ${boltLen(2)}mm`, use: '鎖住左右相鄰的兩片側板', qty: locks },
    { name: `M${P.bolt} 螺栓 × ${boltLen(2)}mm`, use: '上下模組的連接板（頂蓋也算）', qty: vJoints * 2 * 4 },
    { name: `M${P.bolt} 螺帽 + 墊片`, use: '一支螺栓配一組', qty: locks + vJoints * 8 },
    { name: `${P.screw}mm 木螺絲`, use: '掛牆用，螺絲頭留在牆外約 2 個板厚', qty: mountInfo.filter((m) => m.valid).length },
  ].filter((h) => h.qty > 0);

  return {
    type: type.id, params: P, layout: L, parts, items, cans: items, mounts: mountInfo, warnings, counts,
    info: {
      width: L.totalW, height: L.totalH, depth: L.sideDepth,
      moduleW: L.W, moduleH: L.H, mx: L.mx, my: L.my,
      racksX: P.racksX, racksY: P.racksY, hJoints, vJoints, hardware,
      nameplateH: np ? np.height : 0,
      nameplateSpan: np ? np.span : null,
      ...type.info(L, ctx, parts),
    },
  };
}

