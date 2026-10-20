// 名牌圖案：把圖片或文字轉成黑白點陣，再描成向量輪廓供 CNC / 雷射使用。
// traceMask / simplifyLoop 為純函式（Node 可測）；其餘需要瀏覽器 canvas。

import { signedArea } from './geometry.js';

/**
 * 沿像素邊界描出墨色區域的輪廓。
 * @param mask Uint8Array，長度 w*h，1 = 墨色；列由上而下
 * @returns 封閉迴圈陣列，座標為像素單位、y 軸向上（原點在左下）；
 *          墨色在左側：外框逆時針、內孔順時針
 */
export function traceMask(mask, w, h) {
  const ink = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  // 有向邊：起點 key → [終點, 方向]
  const edges = new Map();
  const key = (x, y) => y * (w + 1) + x;
  const addEdge = (x0, y0, x1, y1) => {
    const k = key(x0, y0);
    const list = edges.get(k) || [];
    list.push([x1, y1]);
    edges.set(k, list);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink(x, y)) continue;
      // 轉成 y 向上：像素 (x, y) 佔 [x, x+1] × [Y0, Y0+1]
      const Y0 = h - 1 - y, Y1 = Y0 + 1;
      if (!ink(x, y + 1)) addEdge(x, Y0, x + 1, Y0); // 下
      if (!ink(x + 1, y)) addEdge(x + 1, Y0, x + 1, Y1); // 右
      if (!ink(x, y - 1)) addEdge(x + 1, Y1, x, Y1); // 上
      if (!ink(x - 1, y)) addEdge(x, Y1, x, Y0); // 左
    }
  }
  const loops = [];
  const take = (k, prevDir) => {
    const list = edges.get(k);
    if (!list || !list.length) return null;
    let idx = 0;
    if (list.length > 1 && prevDir) {
      // 對角相接的像素：墨色在左，優先左轉，讓兩塊墨色分成兩個簡單迴圈
      const [px, py] = prevDir;
      const sx = k % (w + 1), sy = Math.floor(k / (w + 1));
      idx = list.findIndex(([ex, ey]) => {
        const dx = ex - sx, dy = ey - sy;
        return px * dy - py * dx > 0;
      });
      if (idx < 0) idx = 0;
    }
    const [e] = list.splice(idx, 1);
    if (!list.length) edges.delete(k);
    return e;
  };
  for (const startKey of [...edges.keys()]) {
    while (edges.has(startKey)) {
      const sx = startKey % (w + 1), sy = Math.floor(startKey / (w + 1));
      const pts = [[sx, sy]];
      let k = startKey, prev = null, cx = sx, cy = sy;
      for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
        const next = take(k, prev);
        if (!next) break;
        prev = [next[0] - cx, next[1] - cy];
        [cx, cy] = next;
        k = key(cx, cy);
        if (k === startKey) break;
        pts.push([cx, cy]);
      }
      if (pts.length >= 4) loops.push(removeCollinear(pts));
    }
  }
  return loops;
}

function removeCollinear(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross !== 0) out.push(b);
  }
  return out;
}

/** Ramer–Douglas–Peucker 簡化封閉迴圈 */
export function simplifyLoop(pts, eps) {
  if (pts.length < 5) return pts;
  // 從最遠的兩點切開成兩條開放折線分別簡化
  let far = 0, best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = rdp(pts.slice(0, far + 1), eps);
  const b = rdp([...pts.slice(far), pts[0]], eps);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : pts;
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
  let idx = 0, maxD = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - x0) * dy - (pts[i][1] - y0) * dx) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

/**
 * 點陣 → 正規化向量圖案（寬 = 1，高 = aspect），供 rack.js 縮放到名牌上。
 */
export function maskToArtwork(mask, w, h) {
  const loops = traceMask(mask, w, h)
    .map((l) => simplifyLoop(l, 0.75))
    .filter((l) => l.length >= 3 && Math.abs(signedArea(l)) >= 2);
  return {
    aspect: h / w,
    loops: loops.map((l) => l.map(([x, y]) => [x / w, y / w])),
    mask, // 「沿圖案外形」需要原始點陣
    px: { w, h },
  };
}

// --- 瀏覽器端 ---------------------------------------------------------------

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('無法讀取這張圖片'));
    img.src = src;
  });
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** 把文字畫成圖（白底黑字）；sizePx 越大，雷射點陣越清楚 */
export function textCanvas(text, sizePx = 640) {
  const font = `700 ${sizePx}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = font;
  const lines = String(text || ' ').split('\n');
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width), 10);
  const lineH = Math.round(sizePx * 1.16);
  c.width = Math.ceil(width + 40);
  c.height = lineH * lines.length + 20;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000';
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, c.width / 2, 10 + lineH * (i + 0.5)));
  return c;
}

/**
 * 影像 → 黑白遮罩。亮度低於門檻（0–255）為墨色；invert 反轉。
 * 透明像素視為背景。輸出 canvas 為黑白預覽（也用於雷射點陣）。
 */
export function rasterize(source, { threshold = 128, invert = false, maxPx = 480 } = {}) {
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  const s = Math.min(1, maxPx / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let on = lum < threshold;
    if (invert) on = !on;
    mask[i] = on ? 1 : 0;
    const v = on ? 0 : 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { mask, w, h, canvas: c };
}

/** 裁掉四周空白，讓圖案填滿名牌 */
export function cropMask({ mask, w, h, canvas }) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return { mask, w, h, canvas, empty: true };
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const m = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) m[y * cw + x] = mask[(y + y0) * w + x + x0];
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  c.getContext('2d').drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
  return { mask: m, w: cw, h: ch, canvas: c, empty: false };
}
