// 2D 幾何工具：所有輪廓皆為封閉多邊形 [[x, y], ...]（不重複首點）。
// 方向約定：「材料在左側」——外輪廓逆時針 (CCW)、內孔順時針 (CW)。

export const EPS = 1e-7;
const TAU = Math.PI * 2;

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function ensureOrientation(pts, ccw = true) {
  const isCcw = signedArea(pts) > 0;
  return isCcw === ccw ? pts : pts.slice().reverse();
}

// 移除重複點與共線點
export function cleanPolygon(pts) {
  let out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > EPS) out.push(p);
  }
  if (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= EPS) out.pop();
  }
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      if (Math.abs(cross) < EPS && dot > 0) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * 在內角（材料角度 > 180°，即材料在左側時的右轉頂點）加入狗骨頭 (dogbone) 讓圓銑刀能清角。
 * 圓心沿角平分線往切除區偏移 r，使銑刀圓剛好通過原頂點。
 * @param pts 材料在左側方向的多邊形
 * @param r 銑刀半徑
 * @param minTurnDeg 轉角小於此值不處理（避免對弧線取樣點或緩角處理）
 */
export function dogbone(pts, r, minTurnDeg = 70, segs = 10) {
  pts = cleanPolygon(pts);
  if (!(r > 0)) return pts;
  const n = pts.length;
  const minTurn = (minTurnDeg * Math.PI) / 180;
  const out = [];
  for (let i = 0; i < n; i++) {
    const A = pts[(i - 1 + n) % n], P = pts[i], B = pts[(i + 1) % n];
    let ax = P[0] - A[0], ay = P[1] - A[1];
    let bx = B[0] - P[0], by = B[1] - P[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    ax /= la; ay /= la; bx /= lb; by /= lb;
    const cross = ax * by - ay * bx;
    const turn = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by)));
    if (cross >= 0 || turn < minTurn) { out.push(P); continue; }
    let wx = bx - ax, wy = by - ay;
    const lw = Math.hypot(wx, wy);
    wx /= lw; wy /= lw;
    const C = [P[0] + wx * r, P[1] + wy * r];
    const s1 = -2 * r * (ax * wx + ay * wy);
    const s2 = 2 * r * (bx * wx + by * wy);
    // 邊太短時放不下狗骨頭，保留原角
    if (s1 > la / 2 + EPS || s2 > lb / 2 + EPS) { out.push(P); continue; }
    const Q1 = [P[0] - ax * s1, P[1] - ay * s1];
    const Q2 = [P[0] + bx * s2, P[1] + by * s2];
    const a1 = Math.atan2(Q1[1] - C[1], Q1[0] - C[0]);
    const a2 = Math.atan2(Q2[1] - C[1], Q2[0] - C[0]);
    const ap = Math.atan2(P[1] - C[1], P[0] - C[0]);
    const norm = (x) => ((x % TAU) + TAU) % TAU;
    const dccw = norm(a2 - a1);
    const sweep = norm(ap - a1) < dccw ? dccw : dccw - TAU;
    out.push(Q1);
    for (let k = 1; k < segs; k++) {
      const ang = a1 + (sweep * k) / segs;
      out.push([C[0] + r * Math.cos(ang), C[1] + r * Math.sin(ang)]);
    }
    out.push(Q2);
  }
  return out;
}

// 矩形孔（順時針，材料在左）
export function rectCW(x0, y0, x1, y1) {
  return [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
}

/**
 * 鑰匙孔（掛孔）：下方大圓讓螺絲頭穿過，往上延伸窄槽供掛住。
 * (cx, cy) 為大圓圓心；掛點（螺絲最終位置）在 (cx, cy + len)。回傳順時針。
 */
export function keyholeCW(cx, cy, headR, shankR, len, segs = 32) {
  const rs = Math.min(shankR, headR * 0.95);
  const dy = Math.sqrt(Math.max(headR * headR - rs * rs, 0));
  len = Math.max(len, dy + 0.5);
  const yj = cy + dy;
  const pts = [[cx + rs, yj], [cx + rs, cy + len]];
  const half = Math.max(4, Math.round(segs / 2));
  for (let k = 1; k < half; k++) {
    const ang = (Math.PI * k) / half;
    pts.push([cx + rs * Math.cos(ang), cy + len + rs * Math.sin(ang)]);
  }
  pts.push([cx - rs, cy + len], [cx - rs, yj]);
  const aStart = Math.atan2(dy, -rs);
  const aEnd = Math.atan2(dy, rs) + TAU;
  for (let k = 1; k < segs; k++) {
    const ang = aStart + ((aEnd - aStart) * k) / segs;
    pts.push([cx + headR * Math.cos(ang), cy + headR * Math.sin(ang)]);
  }
  return pts.reverse();
}

export function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function rectsOverlap(a, b, pad = 0) {
  return a.minX < b.maxX + pad && b.minX < a.maxX + pad && a.minY < b.maxY + pad && b.minY < a.maxY + pad;
}

/**
 * 把輪廓往「切除那一側」偏移 d（雷射切縫補償）。
 * 輪廓須為材料在左側：外框逆時針會往外長、內孔順時針會往內縮。
 * 尖角用斜接，過尖時限制長度避免長出尖刺。
 */
export function offsetContour(pts, d) {
  pts = cleanPolygon(pts);
  if (!(Math.abs(d) > 0) || pts.length < 3) return pts;
  const n = pts.length;
  const normals = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    normals.push([(y2 - y1) / len, -(x2 - x1) / len]); // 行進方向的右側 = 切除側
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = normals[(i - 1 + n) % n], b = normals[i];
    const [px, py] = pts[i];
    let mx = a[0] + b[0], my = a[1] + b[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { out.push([px + b[0] * d, py + b[1] * d]); continue; }
    mx /= ml; my /= ml;
    // 斜接長度 = d / cos(半角)，限制在 4d 以內
    const cosHalf = Math.max(0.25, mx * b[0] + my * b[1]);
    const k = d / cosHalf;
    out.push([px + mx * k, py + my * k]);
  }
  return out;
}
