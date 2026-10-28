import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockOf, analyzeCombo, snapBlock } from '../src/system/combo.js';
import { TYPES } from '../src/types/index.js';

const build = (type, params = {}) => TYPES[type].build({ ...TYPES[type].DEFAULTS, ...params }, []);
const block = (id, type, x, y, params) => blockOf({ id, type, x, y }, build(type, params), TYPES[type].name);

test('同寬的罐架上面疊斜瓶架：接得起來，下面那座的頂蓋拿掉', () => {
  const can = block(1, 'paint-can', 0, 0, { moduleW: 600 });
  const bottle = block(2, 'slant-bottle', 0, can.H, { moduleW: 600, bottleLen: 160 });
  const { results, covered } = analyzeCombo([can, bottle]);
  assert.equal(results.length, 1);
  assert.equal(results[0].relation, 'stack');
  assert.equal(results[0].level, 'ok');
  assert.ok(covered.has(1) && !covered.has(2));
  assert.match(results[0].text, /深度不同/);
});

test('寬度不同疊不起來，並建議把窄的那座調寬', () => {
  const can = block(1, 'paint-can', 0, 0);
  const bottle = block(2, 'slant-bottle', 0, can.H);
  const [r] = analyzeCombo([can, bottle]).results;
  assert.equal(r.level, 'bad');
  const fix = r.fixes.find((f) => f.kind === 'width');
  assert.equal(fix.type, 'slant-bottle');
  assert.equal(fix.moduleW, can.modW);
  // 照建議調寬之後就接得起來
  const fixed = block(2, 'slant-bottle', 0, can.H, { moduleW: fix.moduleW });
  assert.equal(analyzeCombo([can, fixed]).results[0].level, 'ok');
});

test('板厚不同：接合尺寸對不上', () => {
  const can = block(1, 'paint-can', 0, 0, { moduleW: 600 });
  const bottle = block(2, 'slant-bottle', 0, can.H, { moduleW: 600, thickness: 12 });
  const [r] = analyzeCombo([can, bottle]).results;
  assert.equal(r.level, 'bad');
  assert.match(r.text, /板厚/);
});

test('左右並排：下緣對齊時卡得住，沒對齊時提供對齊', () => {
  const can = block(1, 'paint-can', 0, 0);
  const bottle = block(2, 'slant-bottle', can.W, 0);
  const [r] = analyzeCombo([can, bottle]).results;
  assert.equal(r.relation, 'side');
  assert.equal(r.level, 'warn');
  assert.match(r.text, /下緣用卡扣卡住/);
  const off = block(2, 'slant-bottle', can.W, 30);
  const [r2] = analyzeCombo([can, off]).results;
  assert.equal(r2.fixes[0].y, 0);
  // 兩座一樣的罐架並排：上下緣都卡、螺栓也鎖得住
  const twin = block(3, 'paint-can', can.W, 0);
  assert.equal(analyzeCombo([can, twin]).results[0].level, 'ok');
});

test('重疊會被指出來；拖動時靠近會貼到上面或旁邊', () => {
  const can = block(1, 'paint-can', 0, 0);
  const bottle = block(2, 'slant-bottle', 100, 100);
  assert.equal(analyzeCombo([can, bottle]).results[0].relation, 'overlap');
  assert.deepEqual(snapBlock(bottle, [can], 10, can.H + 25), { x: 0, y: can.H });
  assert.deepEqual(snapBlock(bottle, [can], can.W + 20, 15), { x: can.W, y: 0 });
  assert.deepEqual(snapBlock(bottle, [can], 2000, 900), { x: 2000, y: 900 });
});

test('外框範圍：上面有東西的那座不算頂蓋高度', () => {
  const can = block(1, 'paint-can', 0, 0, { moduleW: 600 });
  const bottle = block(2, 'slant-bottle', 0, can.H, { moduleW: 600 });
  const { bounds } = analyzeCombo([can, bottle]);
  assert.equal(bounds.h, can.H + bottle.H + bottle.capH);
  assert.equal(bounds.w, 600);
});
