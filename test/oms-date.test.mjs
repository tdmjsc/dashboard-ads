import test from 'node:test';
import assert from 'node:assert/strict';
import { omsDateBoundary } from '../oms-date.js';

test('Vietnam day includes early morning orders stored on previous UTC date', () => {
  const from = omsDateBoundary('2026-10-20');
  const until = omsDateBoundary('2026-10-20', true);
  assert.equal(from, '2026-10-19 17:00:00');
  assert.equal(until, '2026-10-20 17:00:00');
  const inDay = value => value >= from && value < until;
  assert.equal(inDay('2026-10-19 23:24:48'), true);
  assert.equal(inDay('2026-10-19 16:59:59'), false);
  assert.equal(inDay('2026-10-19 17:00:00'), true);
  assert.equal(inDay('2026-10-20 16:59:59'), true);
  assert.equal(inDay('2026-10-20 17:00:00'), false);
});

test('Vietnam date boundaries cross month and year correctly', () => {
  assert.equal(omsDateBoundary('2027-01-01'), '2026-12-31 17:00:00');
  assert.equal(omsDateBoundary('2026-10-31', true), '2026-10-31 17:00:00');
});
