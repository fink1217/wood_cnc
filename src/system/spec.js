// 拼裝規格：所有架子類型共用的參數與接合尺寸。
//
// 世界座標 (mm)：X = 寬（左→右）、Y = 高（下→上）、Z = 深（牆面 z=0 往外）。
// 板厚、公差、加工方式、螺栓、掛牆螺絲、底部邊距屬於整個專案，不屬於某一種架子；
// 卡扣、連接板、鎖點孔的位置都由這裡算出來，不同類型的模組才接得起來。

export const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const r1 = (v) => Math.round(v * 10) / 10;
export const r2 = (v) => Math.round(v * 1000) / 1000;
export const range = (n) => Array.from({ length: n }, (_, i) => i);

// 各類型共用的參數鍵：切換架子類型時會帶過去
export const SHARED_DEFAULTS = {
  thickness: 9,
  tolerance: 0.2,
  machine: 'cnc',
  bit: '3.175',
  sheet: '1220x2440',
  screw: '4',
  bolt: 'M6',
  margin: null,
  bitDia: null,
  kerf: null,
  sheetW: null,
  sheetH: null,
  partGap: null,
  gridSnap: null,
};
export const SHARED_KEYS = Object.keys(SHARED_DEFAULTS);

export const THICKNESS_SPEC = { key: 'thickness', label: '木頭厚度', unit: 'mm', min: 3, max: 30, step: 0.5 };
export const TOLERANCE_SPEC = { key: 'tolerance', label: '組裝公差', unit: 'mm', min: 0, max: 1.5, step: 0.05, hint: '緊 0.1 · 標準 0.2 · 鬆 0.35' };

export const CHOICE_SPEC = [
  { key: 'machine', label: '加工機器', options: [['cnc', 'CNC 雕刻機'], ['laser', '雷射切割機']] },
  { key: 'bit', label: '銑刀', laserLabel: '雷射不需要', options: [['0', '不清角'], ['3.175', '1/8″ (3.175)'], ['6', '6 mm'], ['6.35', '1/4″ (6.35)']] },
  { key: 'sheet', label: 'CNC 板材', options: [['1220x2440', '4×8 尺 (1220×2440)'], ['1220x3050', '4×10 尺 (1220×3050)'], ['915x1830', '3×6 尺 (915×1830)'], ['915x2135', '3×7 尺 (915×2135)'], ['600x900', 'CNC 小板 600×900'], ['600x600', 'CNC 小板 600×600'], ['1300x900', '雷射 1300×900'], ['900x600', '雷射 900×600'], ['600x400', '雷射 600×400']] },
  { key: 'screw', label: '掛牆螺絲', options: [['3.5', '3.5 mm'], ['4', '4 mm'], ['5', '5 mm']] },
  { key: 'bolt', label: '連接螺栓', options: [['M4', 'M4'], ['M5', 'M5'], ['M6', 'M6']] },
];

export const ASSEMBLY_SPEC = [
  { key: 'racksX', label: '水平並排幾架', unit: '架', min: 1, max: 8, step: 1, int: true },
  { key: 'racksY', label: '垂直堆疊幾架', unit: '架', min: 1, max: 8, step: 1, int: true },
];

// 模組寬度的格線：寬度取這個的倍數，不同類型的模組上下疊時側板才對得齊
export const GRID_W = 50;
export const MODULE_W_SPEC = { key: 'moduleW', label: '模組寬度', unit: 'mm', min: 0, max: 2000, step: 50 };

/**
 * 模組寬度：自動 = 需要的寬度往上取到格線；手動可以指定（例如跟另一種架子同寬才疊得起來），太窄會撐回最小值。
 * 多出來的寬度由呼叫端平均分到兩側。
 */
export function snapWidth(need, manual, fields, cap = Infinity) {
  const auto = manual == null;
  const grid = Math.ceil((need - 1e-6) / GRID_W) * GRID_W;
  const fits = grid <= cap + 1e-6; // 取到格線後還放得進板材
  let v = auto ? (fits ? grid : need) : manual;
  let note = auto ? (fits ? `取 ${GRID_W}mm 的倍數，不同架子同寬才疊得起來` : '取到格線會超過板材，用最小寬度') : '';
  if (v < need - 1e-6) { v = need; if (!auto) note = `改成 ${r2(need)}，再窄放不下`; }
  v = r2(v);
  fields.moduleW = { value: v, auto, note, adjusted: !auto && Math.abs(v - manual) > 1e-9, min: r2(need) };
  return v;
}

export const MARGIN_SPEC = { key: 'margin', label: '底部與頂蓋邊距', unit: 'mm', min: 0, max: 80, step: 1 };
export const MAX_COLS_SPEC = (unit) => ({ key: 'maxCols', label: '每模組最多欄', unit, min: 1, max: 40, step: 1, int: true });
export const MAX_ROWS_SPEC = { key: 'maxRows', label: '每模組最多列', unit: '列', min: 1, max: 20, step: 1, int: true };
export const MACHINE_ADVANCED_SPEC = [
  { key: 'bitDia', label: '銑刀直徑', unit: 'mm', min: 0, max: 12.7, step: 0.05 },
  { key: 'kerf', label: '雷射切縫', unit: 'mm', min: 0, max: 1, step: 0.01 },
  { key: 'sheetW', label: '板材寬', unit: 'mm', min: 200, max: 3000, step: 10 },
  { key: 'sheetH', label: '板材長', unit: 'mm', min: 200, max: 5000, step: 10 },
  { key: 'partGap', label: '排版間距', unit: 'mm', min: 0, max: 50, step: 1 },
  { key: 'gridSnap', label: '掛點拖拉吸附', unit: 'mm', min: 0, max: 50, step: 0.5 },
];

/**
 * 清理輸入：基本／組裝欄位夾到合法範圍；選單只接受選項內的值；可自動的欄位 null/空字串 = 自動。
 * spec = { defaults, fixed: [...], choice: [...], auto: [...] }
 */
export function normalizeWith(spec, input = {}) {
  const P = { ...spec.defaults };
  for (const s of spec.fixed) {
    const n = Number(input[s.key]);
    if (input[s.key] !== undefined && input[s.key] !== '' && input[s.key] !== null && Number.isFinite(n)) {
      P[s.key] = clampNum(s.int ? Math.round(n) : n, s.min, s.max);
    }
  }
  for (const s of spec.choice) {
    const v = String(input[s.key] ?? '');
    if (s.options.some(([o]) => o === v)) P[s.key] = v;
  }
  for (const s of spec.auto) {
    const v = input[s.key];
    const n = Number(v);
    P[s.key] = v === null || v === undefined || v === '' || !Number.isFinite(n)
      ? null
      : clampNum(s.int ? Math.round(n) : n, s.min, s.max);
  }
  return P;
}

/**
 * 可自動的欄位：自動值 → 上限 → 下限（下限優先）。
 * 回傳 resolve(key, autoVal, autoWhy, bounds)，結果記在 fields[key]：{ value, auto, note, adjusted, min }。
 */
export function makeResolver(raw, fields) {
  return (key, autoVal, autoWhy, bounds = []) => {
    const manual = raw[key];
    const auto = manual == null;
    let v = auto ? autoVal : manual;
    let note = auto ? autoWhy : '';
    for (const [kind, limit, why] of bounds) {
      if (limit == null || !Number.isFinite(limit)) continue;
      if (kind === 'max' && v > limit + 1e-9) { v = limit; if (!auto) note = `改成 ${r2(v)}，${why}`; }
    }
    for (const [kind, limit, why] of bounds) {
      if (limit == null || !Number.isFinite(limit)) continue;
      if (kind === 'min' && v < limit - 1e-9) { v = limit; if (!auto) note = `改成 ${r2(v)}，${why}`; }
    }
    v = r2(v);
    const mins = bounds.filter(([kind, limit]) => kind === 'min' && Number.isFinite(limit)).map(([, limit]) => limit);
    fields[key] = { value: v, auto, note, adjusted: !auto && Math.abs(v - manual) > 1e-9, min: mins.length ? r2(Math.max(...mins)) : null };
    return v;
  };
}

/** 加工方式、板材、排版間距（各類型共用；最先解析，警告排在最前面） */
export function resolveMachine(raw, resolve, warnings) {
  const t = raw.thickness, tol = raw.tolerance;
  const laser = raw.machine === 'laser';
  // 雷射：刀徑視為 0（內角切得尖，不需狗骨頭）；切縫在匯出時補償
  const bitDia = resolve('bitDia', laser ? 0 : Number(raw.bit), laser ? '雷射切得出尖角，不用清角' : '跟著銑刀選單');
  const kerf = resolve('kerf', laser ? 0.15 : 0, laser ? '一般雷射約 0.15mm，匯出時會補回來' : 'CNC 由 CAM 做刀具補償');
  if (laser && t > 10) warnings.push(`${t}mm 對雷射來說偏厚，CO₂ 雷射切合板一般在 3–9mm，先確認你的機器切得穿`);
  const slotW = t + tol;
  if (bitDia > slotW) warnings.push(`⌀${bitDia} 的銑刀比 ${r2(slotW)}mm 的榫槽還寬，槽銑不出來。換細一點的刀，或用厚一點的板`);
  else if (bitDia > 0 && bitDia / 2 * Math.SQRT2 * 2 > slotW) warnings.push(`⌀${bitDia} 的銑刀對 ${r2(slotW)}mm 的榫槽偏粗，有些內角加不了狗骨頭`);

  const [sw, sh] = raw.sheet.split('x').map(Number);
  const sheetW = resolve('sheetW', Math.min(sw, sh), '跟著板材選單');
  const sheetH = resolve('sheetH', Math.max(sw, sh), '跟著板材選單');
  const partGap = resolve('partGap', laser ? 3 : Math.max(6, Math.ceil(bitDia * 2 + 2)), laser ? '雷射零件間距 3mm' : '銑刀直徑 × 2 + 2',
    [['min', laser ? Math.max(1, kerf * 4) : bitDia + 1, laser ? '太近會燒在一起，至少留 4 倍切縫' : '必須大於銑刀直徑']]);
  return { t, tol, laser, bitDia, kerf, slotW, sheetW, sheetH, partGap };
}

/** 五金與接合：螺栓、底部邊距、掛孔、卡扣腳寬、連接板需要的最小深度 */
export function resolveHardware(raw, resolve) {
  const t = raw.thickness, tol = raw.tolerance;
  const bolt = Number(raw.bolt.slice(1));
  const boltHole = bolt + 0.5;
  const margin = resolve('margin', Math.max(18, Math.round(t * 1.5 + 10), Math.ceil(14 + boltHole * 1.5)), '看板厚和螺栓大小',
    [['min', Math.max(14, Math.ceil(t + 6), Math.ceil(12 + boltHole)), '卡扣和連接板的螺栓在這一段']]);
  const clipLegW = Math.max(6, t);
  // 罐子／瓶子到側板：要讓出貼在側板內側的垂直連接板與卡扣腳
  const minSide = Math.ceil(Math.max(t, clipLegW) + 3);
  // 連接板位於前後兩個卡扣之間，至少要放得下兩排螺栓孔
  const needDepth = Math.max(60, Math.ceil(2 * t + 10 + (t + tol) + t + 4 * boltHole + 8));
  const gridSnap = resolve('gridSnap', 5, '預設 5mm');
  const screw = Number(raw.screw);
  const keyholeHead = r1(screw * 2 + 1.5);
  return {
    bolt, boltHole, margin, clipLegW, minSide, needDepth, gridSnap, screw, keyholeHead,
    shared: {
      thickness: t, tolerance: tol, margin, bolt, lockHoleDia: boltHole, screw,
      keyholeHead, keyholeShank: r1(screw + 0.6), keyholeLen: keyholeHead, gridSnap,
    },
  };
}

/**
 * 接合尺寸：卡扣槽、連接板、鎖點孔的位置。
 * 都從牆面往前量、只跟板厚／公差／螺栓有關（frontZ = 連接板需要的最小深度），所以深淺不同的模組也對得上。
 * topRoom = 模組上緣下方可以放連接板與卡扣腳的高度（各類型自己算）。
 */
export function joints({ t, tol, e, zs, frontZ, boltHole, topRoom, roomFix = '把「罐頂到上層距離」調大一點' }, warnings) {
  const nd = Math.min(e * 0.4, 12); // 卡槽深
  const notchW = t + tol;
  const clipZ = [zs + 3 + notchW / 2, frontZ - 3 - notchW / 2];
  const spliceZ = [clipZ[0] + t / 2 + 2, clipZ[1] - t / 2 - 2];
  const spliceMid = (spliceZ[0] + spliceZ[1]) / 2;
  const boltR = boltHole / 2;
  const spliceUp = e - 3; // 接縫以上（上一個模組的底部邊距）
  const spliceDown = Math.max(2 * boltR + 6, Math.min(e - 3, topRoom - 2)); // 接縫以下（避開最上一列）
  if (topRoom - 2 < 2 * boltR + 6) warnings.push(`接縫下面塞不下連接板的螺栓，${roomFix}`);
  const boltDz = Math.max(boltR + 2, Math.min((spliceZ[1] - spliceZ[0]) / 2 - boltR - 3, 15));
  const spliceBoltZ = [spliceMid - boltDz, spliceMid + boltDz];
  const spliceBoltUp = e / 2;
  const spliceBoltDown = Math.max(boltR + 3, Math.min(e / 2, spliceDown - boltR - 2));
  const clipLeg = Math.max(3, Math.min(e - nd - 4, topRoom - nd - 2));
  const clipLegW = Math.max(6, t);
  const lockZ = (zs + frontZ) / 2;
  return { nd, notchW, clipZ, spliceZ, spliceMid, spliceUp, spliceDown, spliceBoltZ, spliceBoltUp, spliceBoltDown, clipLeg, clipLegW, lockZ };
}
