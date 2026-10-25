// 零件平面排版與輸出 (SVG / DXF / BOM)

import { bbox, offsetContour, ensureOrientation } from './geometry.js';

/**
 * 將零件 2D 輪廓平移到原點，可選擇旋轉 90°。
 * kerf > 0（雷射）：外框往外、孔往內各偏移半個切縫，切出來才是設計尺寸。
 */
export function flatten(part, rotate = false, kerf = 0) {
  const rot = rotate ? ([x, y]) => [-y, x] : (p) => p;
  const k = kerf / 2;
  let outer = part.outer.map(rot);
  let holes = part.holes.map((h) => (h.type === 'circle' ? { ...h, c: rot(h.c) } : { ...h, pts: h.pts.map(rot) }));
  if (k > 0) {
    outer = offsetContour(ensureOrientation(outer, true), k);
    holes = holes.map((h) => (h.type === 'circle'
      ? { ...h, r: Math.max(0.05, h.r - k) }
      : { ...h, pts: offsetContour(ensureOrientation(h.pts, false), k) }));
  }
  const b = bbox(outer);
  const sh = ([x, y]) => [x - b.minX, y - b.minY];
  const map = (p) => sh(rot(p));
  // 雷射點陣：以影像左上、右上、左下三個角記錄（旋轉後仍可還原成仿射矩陣）
  const r = part.raster;
  const raster = r ? { tl: map([r.x, r.y + r.h]), tr: map([r.x + r.w, r.y + r.h]), bl: map([r.x, r.y]) } : null;
  return {
    outer: outer.map(sh),
    holes: holes.map((h) => (h.type === 'circle' ? { ...h, c: sh(h.c) } : { ...h, pts: h.pts.map(sh) })),
    engrave: (part.engrave || []).map((l) => l.map(map)),
    raster,
    w: b.w, h: b.h,
  };
}

/** 簡易貨架式排版（依高度排序，逐列放置；放不下就換新板材） */
export function layoutParts(parts, P) {
  const W = P.sheetW, H = P.sheetH, g = P.partGap;
  const warnings = [];
  const items = parts.map((part) => {
    const b = part.bounds;
    // 長邊水平；若放不下則改直放
    let rotate = b.h > b.w;
    if (Math.max(b.w, b.h) > W - 2 * g) rotate = b.w > b.h;
    const f = flatten(part, rotate, P.kerf || 0);
    if (f.w > W - 2 * g || f.h > H - 2 * g) warnings.push(`${part.name} 尺寸 ${f.w.toFixed(0)}×${f.h.toFixed(0)} 超過板材`);
    return { part, flat: f, rotate };
  });
  items.sort((a, b) => b.flat.h - a.flat.h || b.flat.w - a.flat.w);

  const sheets = [];
  let sheet = null, x = g, y = g, rowH = 0;
  const newSheet = () => { sheet = { items: [] }; sheets.push(sheet); x = g; y = g; rowH = 0; };
  newSheet();
  for (const it of items) {
    if (x + it.flat.w > W - g && x > g) { x = g; y += rowH + g; rowH = 0; }
    if (y + it.flat.h > H - g && y > g) newSheet();
    sheet.items.push({ ...it, x, y });
    x += it.flat.w + g;
    rowH = Math.max(rowH, it.flat.h);
  }
  return { sheets, warnings, sheetW: W, sheetH: H, laser: P.machine === 'laser', kerf: P.kerf || 0 };
}

const f3 = (v) => (Math.round(v * 1000) / 1000).toString();

/**
 * @param rasterHref 名牌雷射點陣圖：data URL 字串（所有名牌共用），或 (part) => data URL | null
 */
export function toSVG(layout, rasterHref = null) {
  const { sheets, sheetW: W, sheetH: H } = layout;
  const hrefFor = typeof rasterHref === 'function' ? rasterHref : () => rasterHref;
  const sp = 100;
  const totalW = sheets.length * W + (sheets.length - 1) * sp;
  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}mm" height="${H}mm" viewBox="0 0 ${totalW} ${H}">`);
  // 雷射：板材框與文字不輸出（雷射軟體會把所有線都當成要切的路徑）
  if (!layout.laser) {
    out.push(`<g id="sheet" fill="none" stroke="#999" stroke-width="0.5" stroke-dasharray="6 4">`);
    sheets.forEach((_, s) => out.push(`<rect x="${s * (W + sp)}" y="0" width="${W}" height="${H}"/>`));
    out.push(`</g>`);
  }
  const inner = [], outer = [], labels = [], engrave = [], rasters = [];
  sheets.forEach((sheet, s) => {
    const ox = s * (W + sp);
    for (const it of sheet.items) {
      // SVG y 軸向下：翻轉 v
      const tr = ([u, v]) => [ox + it.x + u, H - (it.y + v)];
      const path = (pts) => 'M' + pts.map((p) => tr(p).map(f3).join(' ')).join(' L') + ' Z';
      outer.push(`<path d="${path(it.flat.outer)}"/>`);
      for (const l of it.flat.engrave || []) engrave.push(`<path d="${path(l)}"/>`);
      const href = it.flat.raster ? hrefFor(it.part) : null;
      if (href) {
        // 單位影像 (0..1) → 板材座標的仿射矩陣
        const p0 = tr(it.flat.raster.tl), p1 = tr(it.flat.raster.tr), p2 = tr(it.flat.raster.bl);
        const m = [p1[0] - p0[0], p1[1] - p0[1], p2[0] - p0[0], p2[1] - p0[1], p0[0], p0[1]].map(f3).join(' ');
        rasters.push(`<image href="${href}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="matrix(${m})"/>`);
      }
      for (const h of it.flat.holes) {
        if (h.type === 'circle') {
          const [cx, cy] = tr(h.c);
          inner.push(`<circle cx="${f3(cx)}" cy="${f3(cy)}" r="${f3(h.r)}"/>`);
        } else inner.push(`<path d="${path(h.pts)}"/>`);
      }
      const [lx, ly] = tr([it.flat.w / 2, it.flat.h / 2]);
      labels.push(`<text x="${f3(lx)}" y="${f3(ly)}">${escapeXml(it.part.name)}</text>`);
    }
  });
  // 雷射：髮絲線＋純色（LightBurn 等軟體依顏色分圖層：先雕刻、再切內孔、最後切外框）
  const sw = layout.laser ? 0.01 : null;
  const color = layout.laser ? { engrave: '#000000', inside: '#0000ff', outside: '#ff0000' } : { engrave: '#2f9e6b', inside: '#0070f3', outside: '#e5484d' };
  if (rasters.length) out.push(`<g id="engrave-raster">`, ...rasters, `</g>`);
  if (engrave.length) out.push(`<g id="engrave" fill="none" stroke="${color.engrave}" stroke-width="${sw ?? 0.2}">`, ...engrave, `</g>`);
  out.push(`<g id="cut-inside" fill="none" stroke="${color.inside}" stroke-width="${sw ?? 0.3}">`, ...inner, `</g>`);
  out.push(`<g id="cut-outside" fill="none" stroke="${color.outside}" stroke-width="${sw ?? 0.3}">`, ...outer, `</g>`);
  if (!layout.laser) out.push(`<g id="labels" fill="#888" font-size="6" font-family="sans-serif" text-anchor="middle">`, ...labels, `</g>`);
  out.push(`</svg>`);
  return out.join('\n');
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

/** DXF R12（POLYLINE / CIRCLE / TEXT），單位 mm */
export function toDXF(layout) {
  const { sheets, sheetW: W, sheetH: H } = layout;
  const sp = 100;
  const L = [];
  const g = (code, val) => L.push(String(code), String(val));
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 5);
  for (const [name, color] of [['ENGRAVE', 3], ['CUT_INSIDE', 5], ['CUT_OUTSIDE', 1], ['LABEL', 8], ['SHEET', 9]]) {
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const poly = (layer, pts) => {
    g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, 1);
    for (const [x, y] of pts) { g(0, 'VERTEX'); g(8, layer); g(10, f3(x)); g(20, f3(y)); g(30, 0); }
    g(0, 'SEQEND'); g(8, layer);
  };
  sheets.forEach((sheet, s) => {
    const ox = s * (W + sp);
    if (!layout.laser) poly('SHEET', [[ox, 0], [ox + W, 0], [ox + W, H], [ox, H]]);
    for (const it of sheet.items) {
      const tr = ([u, v]) => [ox + it.x + u, it.y + v];
      for (const l of it.flat.engrave || []) poly('ENGRAVE', l.map(tr));
      for (const h of it.flat.holes) {
        if (h.type === 'circle') {
          const [cx, cy] = tr(h.c);
          g(0, 'CIRCLE'); g(8, 'CUT_INSIDE'); g(10, f3(cx)); g(20, f3(cy)); g(30, 0); g(40, f3(h.r));
        } else poly('CUT_INSIDE', h.pts.map(tr));
      }
      poly('CUT_OUTSIDE', it.flat.outer.map(tr));
      const [lx, ly] = tr([it.flat.w / 2, it.flat.h / 2]);
      if (!layout.laser) { g(0, 'TEXT'); g(8, 'LABEL'); g(10, f3(lx)); g(20, f3(ly)); g(30, 0); g(40, 5); g(1, it.part.name); }
    }
  });
  g(0, 'ENDSEC'); g(0, 'EOF');
  return L.join('\n') + '\n';
}

const KIND_NAMES = { side: '側板', back: '背板', shelf: '層板', holeplate: '固定孔板', top: '頂蓋頂板', capside: '頂蓋側板', clip: 'U 型卡扣', splice: '垂直連接板', nameplate: '展示名牌', label: '顏料名牌' };

export function toBOM(rack) {
  const groups = new Map();
  for (const p of rack.parts) {
    const k = p.kind + (p.kind === 'back' ? `:${p.holes.filter((h) => h.mount != null).length}` : '');
    const g = groups.get(k) || { kind: p.kind, w: p.bounds.w, h: p.bounds.h, t: p.t, qty: 0, keyholes: p.kind === 'back' ? p.holes.filter((h) => h.mount != null).length : 0 };
    g.qty++;
    groups.set(k, g);
  }
  const rows = [['零件', '數量', '長(mm)', '寬(mm)', '厚(mm)', '備註']];
  for (const g of groups.values()) {
    rows.push([KIND_NAMES[g.kind] || g.kind, g.qty, g.w.toFixed(1), g.h.toFixed(1), g.t, g.kind === 'back' ? `掛孔 ${g.keyholes} 個` : '']);
  }
  for (const h of rack.info.hardware || []) rows.push([h.name, h.qty, '', '', '', h.use]);
  return '\ufeff' + rows.map((r) => r.join(',')).join('\n') + '\n';
}

export { KIND_NAMES };

// --- 不壓縮 ZIP（store），用於一次打包所有輸出檔 ---------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param files [{name, data: string | Uint8Array}] → Uint8Array */
export function makeZip(files, date = new Date()) {
  const enc = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // UTF-8 檔名
    head.setUint16(8, 0, true);
    head.setUint16(10, dosTime, true);
    head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true);
    chunks.push(new Uint8Array(head.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}
