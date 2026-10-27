// 名牌：頂端展示名牌與各類型的名牌板共用的輪廓、圖案擺放與寬度計算。

import { bbox, signedArea } from '../geometry.js';
import { traceMask, simplifyLoop } from '../artwork.js';
import { clampNum, r2 } from './spec.js';

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
export function signPlate({ x0, x1, top, t, tabs, tabL, shape = 'rect', art, mode, margin, minFeature, bandH = 0, topTabUp = 0, artDx = 0, artDy = 0, artScale = 1 }) {
  const W = x1 - x0;
  let ax0 = x0 + margin, ax1 = x1 - margin, ay0 = margin, ay1 = top - margin;
  let upper; // 從右上 (x1, …) 沿上緣走到左上 (x0, …)
  // 圖案放進 box：artScale = 撐滿的幾成，artDx / artDy = 離預設位置（置中；沿圖案外形時貼底）的距離，超出 box 會被擋住
  const fit = (box, alignBottom) => {
    const aw = box[1] - box[0], ah = box[3] - box[2];
    if (!art || aw <= 0 || ah <= 0) return null;
    const scale = clampNum(Number(artScale) || 1, 0.15, 1);
    const s = Math.min(aw, ah / art.aspect) * scale, h = s * art.aspect;
    const roomX = (aw - s) / 2;
    const [minDy, maxDy] = alignBottom ? [0, ah - h] : [-(ah - h) / 2, (ah - h) / 2];
    const dx = clampNum(Number(artDx) || 0, -roomX, roomX), dy = clampNum(Number(artDy) || 0, minDy, maxDy);
    return {
      s, ox: box[0] + roomX + dx, oy: (alignBottom ? box[2] : box[2] + (ah - h) / 2) + dy,
      pos: { dx: r2(dx), dy: r2(dy), scale: r2(scale), minDx: r2(-roomX), maxDx: r2(roomX), minDy: r2(minDy), maxDy: r2(maxDy) },
    };
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
  return { outer, holes, engrave, raster, artRect, artPos: place?.pos || null, islands, tiny };
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
export function nameplateShape(L, opts) {
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
    artDx: opts.artX, artDy: opts.artY, artScale: opts.artScale ?? 1,
  });
  return { ...s, tabs, tabL, height, span };
}

