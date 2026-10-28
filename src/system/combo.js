// 組合擺放：把不同類型的架子放在同一面牆上，判斷彼此接不接得起來。
// 只用各架子的外框尺寸與拼裝規格，不重新產生零件，所以任何類型都適用。
//
// block = { id, name, x, y, W, H, capH, D, modW, mx, minModW, t, bolt, e }
//   x, y：左下角在牆上的位置；W：總寬；H：模組部分的高度（不含頂蓋）；D：深度；
//   modW：單一模組寬；minModW：這種設計最窄可以到多少（調「模組寬度」時的下限）

const EPS = 0.5;
const overlap1 = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
const fmt = (v) => String(Math.round(v * 10) / 10);

/** 由架子（assemble 的結果）與擺放位置做出 block */
export function blockOf(item, rack, name) {
  const L = rack.layout;
  return {
    id: item.id, type: item.type, name, x: item.x, y: item.y,
    W: L.totalW, H: L.my * L.H, capH: L.capH, D: L.sideDepth,
    modW: L.W, mx: L.mx, minModW: L.fields.moduleW?.min ?? L.W,
    t: L.t, bolt: L.P.bolt, e: L.e,
  };
}

/** 拖動時吸附：靠近其他架子的上面、下面、左邊、右邊時貼齊並對齊邊緣 */
export function snapBlock(b, others, x, y, tol = 40) {
  let best = null;
  const consider = (cx, cy) => {
    const d = Math.hypot(cx - x, cy - y);
    if (d <= tol && (!best || d < best.d)) best = { x: cx, y: cy, d };
  };
  for (const o of others) {
    consider(o.x, o.y + o.H); // 疊在上面（左邊對齊）
    consider(o.x + o.W - b.W, o.y + o.H); // 疊在上面（右邊對齊）
    consider(o.x, o.y - b.H); // 放在下面
    consider(o.x + o.W, o.y); // 右邊（下緣對齊）
    consider(o.x - b.W, o.y); // 左邊
  }
  if (!best && Math.abs(y) <= tol) best = { x, y: 0 };
  const out = best ? { x: best.x, y: best.y } : { x, y };
  out.y = Math.max(0, out.y);
  return out;
}

/**
 * 判斷每一對相鄰架子的關係：
 *   stack：上下疊（a 在 b 上面）、side：左右並排（a 在 b 右邊）、overlap：重疊
 * 每一條結果 { a, b, relation, level: 'ok' | 'warn' | 'bad', text, fixes: [...] }
 * fixes：{ label, kind: 'width', type, moduleW } 或 { label, kind: 'move', id, x, y }
 */
export function analyzeCombo(blocks) {
  const results = [];
  const covered = new Set(); // 上面有東西：頂蓋拿掉，改用連接板接上面那座
  for (const a of blocks) {
    for (const b of blocks) {
      if (a === b) continue;
      const ox = overlap1(a.x, a.x + a.W, b.x, b.x + b.W);
      const oy = overlap1(a.y, a.y + a.H, b.y, b.y + b.H);
      if (ox > EPS && oy > EPS) {
        if (a.id < b.id) results.push({ a, b, relation: 'overlap', level: 'bad', text: `${a.name} 跟 ${b.name} 重疊了，拖開一點`, fixes: [] });
        continue;
      }
      if (Math.abs(a.y - (b.y + b.H)) < EPS && ox > EPS) {
        covered.add(b.id);
        results.push(stackResult(a, b));
      } else if (Math.abs(a.x - (b.x + b.W)) < EPS && oy > EPS) {
        results.push(sideResult(a, b));
      }
    }
  }
  return { results, covered, bounds: boundsOf(blocks, covered) };
}

function sharedMismatch(a, b) {
  const diff = [];
  if (Math.abs(a.t - b.t) > 1e-6) diff.push(`板厚 ${fmt(b.t)} / ${fmt(a.t)}mm`);
  if (a.bolt !== b.bolt) diff.push(`螺栓 M${b.bolt} / M${a.bolt}`);
  if (Math.abs(a.e - b.e) > 1e-6) diff.push(`底部邊距 ${fmt(b.e)} / ${fmt(a.e)}mm`);
  return diff;
}

function stackResult(a, b) {
  const head = `${a.name} 疊在 ${b.name} 上面`;
  const diff = sharedMismatch(a, b);
  if (diff.length) {
    return { a, b, relation: 'stack', level: 'bad', text: `${head}：${diff.join('、')} 不一樣，接合點對不上。兩種用同樣的板厚、螺栓和邊距才接得起來`, fixes: [] };
  }
  const fixes = [];
  if (Math.abs(a.W - b.W) > EPS || Math.abs(a.modW - b.modW) > EPS) {
    // 寬度不同：模組數一樣時，把比較窄的那座調寬到跟另一座一樣
    if (a.mx === b.mx) {
      const target = Math.max(a.modW, b.modW);
      const narrow = a.modW < b.modW ? a : b;
      if (target >= narrow.minModW - 1e-6) fixes.push({ label: `把${narrow.name}的模組寬度改成 ${fmt(target)}mm`, kind: 'width', type: narrow.type, moduleW: target });
    }
    const text = a.mx === b.mx
      ? `${head}：寬度不同（下面 ${fmt(b.W)}、上面 ${fmt(a.W)}mm），側板對不齊，連接板鎖不上`
      : `${head}：模組數不同（下面 ${b.mx} 個、上面 ${a.mx} 個並排），中間的側板對不齊，只能各自掛牆`;
    return { a, b, relation: 'stack', level: 'bad', text, fixes };
  }
  if (Math.abs(a.x - b.x) > EPS) {
    return {
      a, b, relation: 'stack', level: 'warn', text: `${head}：同寬，但左右差了 ${fmt(Math.abs(a.x - b.x))}mm，對齊才鎖得起來`,
      fixes: [{ label: '對齊', kind: 'move', id: a.id, x: b.x, y: a.y }],
    };
  }
  const depth = Math.abs(a.D - b.D) >= 3 ? `。深度不同（${fmt(b.D)} / ${fmt(a.D)}mm），接合點都從牆面量，照樣對得上，只是前面會差 ${fmt(Math.abs(a.D - b.D))}mm` : '';
  return {
    a, b, relation: 'stack', level: 'ok',
    text: `${head}：同寬 ${fmt(a.W)}mm，每個模組左右各用一片連接板鎖住，下面那座的頂蓋拿掉${depth}`, fixes: [],
  };
}

function sideResult(a, b) {
  const head = `${a.name} 放在 ${b.name} 右邊`;
  const diff = sharedMismatch(a, b);
  if (diff.length) {
    return { a, b, relation: 'side', level: 'bad', text: `${head}：${diff.join('、')} 不一樣，卡扣卡不進去，兩座各自掛牆`, fixes: [] };
  }
  if (Math.abs(a.y - b.y) > EPS) {
    return {
      a, b, relation: 'side', level: 'warn', text: `${head}：下緣差了 ${fmt(Math.abs(a.y - b.y))}mm，卡扣用不上，兩座各自掛牆`,
      fixes: [{ label: '對齊下緣', kind: 'move', id: a.id, x: a.x, y: b.y }],
    };
  }
  if (Math.abs(a.H - b.H) < EPS && a.type === b.type) {
    return { a, b, relation: 'side', level: 'ok', text: `${head}：上下緣都用 U 型卡扣卡住，每一列再用螺栓鎖住兩片側板`, fixes: [] };
  }
  const top = Math.abs(a.H - b.H) < EPS ? '上緣也卡得住' : `高度不同（${fmt(b.H)} / ${fmt(a.H)}mm），上緣卡不到`;
  return {
    a, b, relation: 'side', level: 'warn',
    text: `${head}：下緣用卡扣卡住，${top}；兩種架子的鎖點孔位置不同，鎖不在一起，兩座都要各自掛牆`, fixes: [],
  };
}

function boundsOf(blocks, covered) {
  if (!blocks.length) return { x0: 0, y0: 0, w: 0, h: 0, d: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, d = 0;
  for (const b of blocks) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.W); y1 = Math.max(y1, b.y + b.H + (covered.has(b.id) ? 0 : b.capH));
    d = Math.max(d, b.D);
  }
  return { x0, y0, w: x1 - x0, h: y1 - y0, d };
}
