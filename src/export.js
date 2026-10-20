// 零件平面排版與輸出 (SVG / DXF / BOM)

import { bbox } from './geometry.js';

/** 將零件 2D 輪廓平移到原點，可選擇旋轉 90° */
export function flatten(part, rotate = false) {
  const rot = rotate ? ([x, y]) => [-y, x] : (p) => p;
  const outer = part.outer.map(rot);
  const holes = part.holes.map((h) => (h.type === 'circle' ? { ...h, c: rot(h.c) } : { ...h, pts: h.pts.map(rot) }));
  const b = bbox(outer);
  const sh = ([x, y]) => [x - b.minX, y - b.minY];
  return {
    outer: outer.map(sh),
    holes: holes.map((h) => (h.type === 'circle' ? { ...h, c: sh(h.c) } : { ...h, pts: h.pts.map(sh) })),
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
    const f = flatten(part, rotate);
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
  return { sheets, warnings, sheetW: W, sheetH: H };
}

const f3 = (v) => (Math.round(v * 1000) / 1000).toString();

export function toSVG(layout) {
  const { sheets, sheetW: W, sheetH: H } = layout;
  const sp = 100;
  const totalW = sheets.length * W + (sheets.length - 1) * sp;
  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}mm" height="${H}mm" viewBox="0 0 ${totalW} ${H}">`);
  out.push(`<g id="sheet" fill="none" stroke="#999" stroke-width="0.5" stroke-dasharray="6 4">`);
  sheets.forEach((_, s) => out.push(`<rect x="${s * (W + sp)}" y="0" width="${W}" height="${H}"/>`));
  out.push(`</g>`);
  const inner = [], outer = [], labels = [];
  sheets.forEach((sheet, s) => {
    const ox = s * (W + sp);
    for (const it of sheet.items) {
      // SVG y 軸向下：翻轉 v
      const tr = ([u, v]) => [ox + it.x + u, H - (it.y + v)];
      const path = (pts) => 'M' + pts.map((p) => tr(p).map(f3).join(' ')).join(' L') + ' Z';
      outer.push(`<path d="${path(it.flat.outer)}"/>`);
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
  out.push(`<g id="cut-inside" fill="none" stroke="#0070f3" stroke-width="0.3">`, ...inner, `</g>`);
  out.push(`<g id="cut-outside" fill="none" stroke="#e5484d" stroke-width="0.3">`, ...outer, `</g>`);
  out.push(`<g id="labels" fill="#888" font-size="6" font-family="sans-serif" text-anchor="middle">`, ...labels, `</g>`);
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
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 4);
  for (const [name, color] of [['CUT_INSIDE', 5], ['CUT_OUTSIDE', 1], ['LABEL', 8], ['SHEET', 9]]) {
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
    poly('SHEET', [[ox, 0], [ox + W, 0], [ox + W, H], [ox, H]]);
    for (const it of sheet.items) {
      const tr = ([u, v]) => [ox + it.x + u, it.y + v];
      for (const h of it.flat.holes) {
        if (h.type === 'circle') {
          const [cx, cy] = tr(h.c);
          g(0, 'CIRCLE'); g(8, 'CUT_INSIDE'); g(10, f3(cx)); g(20, f3(cy)); g(30, 0); g(40, f3(h.r));
        } else poly('CUT_INSIDE', h.pts.map(tr));
      }
      poly('CUT_OUTSIDE', it.flat.outer.map(tr));
      const [lx, ly] = tr([it.flat.w / 2, it.flat.h / 2]);
      g(0, 'TEXT'); g(8, 'LABEL'); g(10, f3(lx)); g(20, f3(ly)); g(30, 0); g(40, 5); g(1, it.part.name);
    }
  });
  g(0, 'ENDSEC'); g(0, 'EOF');
  return L.join('\n') + '\n';
}

const KIND_NAMES = { side: '側板', back: '背板', shelf: '層板', holeplate: '固定孔板', top: '頂板', clip: 'U 型卡扣', key: '雙鳩尾卡榫' };

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
  return '﻿' + rows.map((r) => r.join(',')).join('\n') + '\n';
}

export { KIND_NAMES };
