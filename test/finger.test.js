import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, deriveLayout, resolveParams } from '../src/rack.js';

test('罐子左右預設留 20mm 手指空間，最外側到側板也一樣', () => {
  const L = deriveLayout({ ...DEFAULTS });
  assert.equal(L.gap, 20);
  assert.ok(L.side >= 20);
  assert.equal(L.holeX[1] - L.holeX[0], DEFAULTS.canDia + 20);
});

test('調整手指空間只改寬度，不改深度', () => {
  const a = deriveLayout({ ...DEFAULTS, canGap: 16 });
  const b = deriveLayout({ ...DEFAULTS, canGap: 26 });
  assert.equal(a.depth, b.depth);
  assert.ok(b.pitch > a.pitch);
  assert.equal(b.gap, 26);
});

test('手指空間太窄時提醒，且罐孔之間仍保留木料', () => {
  const r = resolveParams({ ...DEFAULTS, canGap: 4 });
  assert.ok(r.warnings.some((w) => w.includes('手指')));
  assert.ok(r.P.canGap >= r.P.holeClearance + 2);
});
