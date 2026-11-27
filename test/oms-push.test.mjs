import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../oms.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function orderPushRecipients(');
const end = source.indexOf('\n  async function sendPushToAll(', start);
// Chạy chính bộ lọc production với DB giả, không gửi thông báo thật.
const factory = new Function('db', 'getMktTeam', source.slice(start, end)
  .replace("await import('./users.js')", "{ USERS: [{ user: 'dashboard-admin', role: 'admin' }] }") + '\nreturn orderPushRecipients;');
const users = [
  { username: 'admin', role: 'admin' },
  { username: 'mkt-a', role: 'marketing', ho_ten: 'A' },
  { username: 'mkt-b', role: 'marketing', ho_ten: 'B' },
  { username: 'lead', role: 'marketing', ho_ten: 'Lead' },
  { username: 'sale-a', role: 'sale', ho_ten: 'Sale A' },
  { username: 'sale-b', role: 'sale', ho_ten: 'Sale B' },
  { username: 'kho', role: 'warehouse' },
];
function filter(order) {
  return factory(async sql => sql.includes('FROM oms_orders') ? (order ? [order] : []) : users,
    user => user.ho_ten === 'Lead' ? ['Lead', 'A'] : [user.ho_ten]);
}
test('đơn mới chỉ gửi marketing đúng phạm vi, sale phụ trách và admin', async () => {
  const recipients = await filter({ nv_marketing: 'A', sale_phu_trach: 'Sale A', trang_thai: 'Đơn mới' })(1);
  assert.deepEqual([...recipients].sort(), ['admin', 'dashboard-admin', 'lead', 'mkt-a', 'sale-a']);
});
test('đơn chưa phân công không gửi tới mọi sale; kho chỉ nhận đơn trong phạm vi', async () => {
  assert.deepEqual([...await filter({ nv_marketing: '', sale_phu_trach: '', trang_thai: 'Đơn mới' })(1)].sort(), ['admin', 'dashboard-admin']);
  assert.ok((await filter({ trang_thai: 'Đã chốt' })(1)).has('kho'));
});
test('thiếu đơn hoặc id không phát tán thông báo', async () => {
  assert.equal((await filter(null)(1)).size, 0);
  assert.equal((await filter({})(undefined)).size, 0);
});
test('chi nhánh: sale / kho chi nhánh khác không nhận thông báo đơn', async () => {
  const withCn = [...users, { username: 'sale-a-thang', role: 'sale', ho_ten: 'Sale A', chi_nhanh_id: 2 },
    { username: 'kho-thang', role: 'warehouse', chi_nhanh_id: 2 }];
  const f = order => factory(async sql => sql.includes('FROM oms_orders') ? [order] : withCn, u => [u.ho_ten]);
  const td = await f({ sale_phu_trach: 'Sale A', trang_thai: 'Đã chốt' })(1); // đơn cũ không có cột → HKD TD
  assert.ok(td.has('sale-a') && td.has('kho'));
  assert.ok(!td.has('sale-a-thang') && !td.has('kho-thang'));
  const thang = await f({ sale_phu_trach: 'Sale A', trang_thai: 'Đã chốt', chi_nhanh_id: 2 })(1);
  assert.ok(thang.has('sale-a-thang') && thang.has('kho-thang'));
  assert.ok(!thang.has('sale-a') && !thang.has('kho'));
});
test('chi nhánh: sale được xem mọi chi nhánh / thêm chi nhánh nhận thông báo đơn chi nhánh khác', async () => {
  const withXem = [...users, { username: 'kho-all', role: 'warehouse', chi_nhanh_id: 1, xem_chi_nhanh: '*' },
    { username: 'kho-them', role: 'warehouse', chi_nhanh_id: 1, xem_chi_nhanh: '2' }];
  const f = order => factory(async sql => sql.includes('FROM oms_orders') ? [order] : withXem, u => [u.ho_ten]);
  const r = await f({ trang_thai: 'Đã chốt', chi_nhanh_id: 2 })(1);
  assert.ok(r.has('kho-all') && r.has('kho-them') && !r.has('kho'));
});
