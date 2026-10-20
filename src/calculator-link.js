// 與板材計算機 (fink1217/plywood-cut-calculator) 連動：
// 把 CNC 板材尺寸、張數、板厚帶過去，讓計算機算出要買幾張原板與怎麼裁。

export const CALCULATOR_URL = 'https://fink1217.github.io/plywood-cut-calculator/';

export function calculatorUrl({ sheetW, sheetH, count, thickness }) {
  const q = new URLSearchParams({
    from: 'wood-cnc',
    mode: 'piece',
    unit: 'mm',
    w: String(sheetW),
    h: String(sheetH),
    n: String(count),
    t: String(thickness),
  });
  return `${CALCULATOR_URL}?${q}`;
}
