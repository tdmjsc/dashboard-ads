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
