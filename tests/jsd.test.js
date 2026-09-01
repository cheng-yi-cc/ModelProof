import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsd, countsToDist } from '../src/core/jsd.js';

test('identical distributions -> 0', () => {
  assert.equal(jsd({ a: 0.3, b: 0.7 }, { a: 0.3, b: 0.7 }), 0);
});

test('disjoint supports -> 1 bit', () => {
  assert.ok(Math.abs(jsd({ a: 1 }, { b: 1 }) - 1) < 1e-12);
});

test('symmetry and bounds', () => {
  const p = { a: 0.8, b: 0.2 };
  const q = { a: 0.1, c: 0.9 };
  assert.ok(Math.abs(jsd(p, q) - jsd(q, p)) < 1e-12);
  assert.ok(jsd(p, q) >= 0 && jsd(p, q) <= 1);
});

test('known values', () => {
  // JSD([.5,.5] || [0,1]) base-2 = 0.31127812445913283
  assert.ok(Math.abs(jsd({ a: 0.5, b: 0.5 }, { b: 1 }) - 0.31127812445913283) < 1e-12);
});

test('countsToDist normalizes', () => {
  const { dist, n } = countsToDist({ x: 3, y: 1 });
  assert.equal(n, 4);
  assert.equal(dist.x, 0.75);
  assert.equal(countsToDist({}), null);
});
