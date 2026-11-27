import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXemCn, normXemCn } from '../oms.js';

test('quyền xem chi nhánh: chỉ chính / thêm / mọi chi nhánh', () => {
  assert.deepEqual(parseXemCn(1, ''), [1]);
  assert.deepEqual(parseXemCn(0, null), [1]); // tài khoản cũ → HKD TD
  assert.deepEqual(parseXemCn(2, '1'), [2, 1]);
  assert.deepEqual(parseXemCn(1, '1,3, x'), [1, 3]);
  assert.equal(parseXemCn(2, '*'), null);
});
test('chuẩn hoá quyền xem gửi lên', () => {
  assert.equal(normXemCn(''), '');
  assert.equal(normXemCn(undefined), '');
  assert.equal(normXemCn('*'), '*');
  assert.equal(normXemCn([3, 2, 2]), '2,3');
  assert.equal(normXemCn('2, 1'), '1,2');
  assert.equal(normXemCn('1;DROP'), null);
  assert.equal(normXemCn([0]), null);
});

import { normPhone } from '../oms.js';
test('chuẩn hoá SĐT để báo trùng số / khách cũ', () => {
  assert.equal(normPhone('0334 556 644'), '0334556644');
  assert.equal(normPhone('+84334556644'), '0334556644');
  assert.equal(normPhone('84334556644'), '0334556644');
  assert.equal(normPhone('334556644'), '0334556644');
  assert.equal(normPhone('abc'), '');
  assert.equal(normPhone(null), '');
});
