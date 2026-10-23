import test from 'node:test';
import assert from 'node:assert/strict';
import { docTienBangChu, buildInvoice, refIdForOrder, misaClient } from '../misa-hoadon.js';

test('đọc số tiền bằng chữ', () => {
  const cases = {
    0: 'Không đồng.', 15: 'Mười lăm đồng.', 21: 'Hai mươi mốt đồng.', 105: 'Một trăm linh năm đồng.',
    1001: 'Một nghìn không trăm linh một đồng.', 1010: 'Một nghìn không trăm mười đồng.',
    125000: 'Một trăm hai mươi lăm nghìn đồng.', 1005000: 'Một triệu không trăm linh năm nghìn đồng.',
    1000005: 'Một triệu không trăm linh năm đồng.', 4900000: 'Bốn triệu chín trăm nghìn đồng.',
    1000000000: 'Một tỷ đồng.', 2015000000: 'Hai tỷ không trăm mười lăm triệu đồng.',
    1000000000000: 'Một nghìn tỷ đồng.', 350000: 'Ba trăm năm mươi nghìn đồng.',
  };
  for (const [n, s] of Object.entries(cases)) assert.equal(docTienBangChu(Number(n)), s, n);
});

test('dựng hoá đơn bán hàng từ đơn OMS', () => {
  const inv = buildInvoice({ id: 7, ten_kh: 'Nguyễn A', sdt: '0901', dia_chi_full: 'HN', so_luong: 2, gia_ban: 350000, tong_tien: 690000 },
    { name: 'Gel lô B', code: 'SP01', unit: 'Hộp' }, { series: '2C26THK', date: new Date('2026-10-22T20:00:00Z') });
  assert.equal(inv.InvDate, '2026-10-23'); // giờ VN
  assert.equal(inv.RefID, refIdForOrder(7));
  assert.equal(inv.TotalAmountOC, 690000);
  const l = inv.OriginalInvoiceDetail[0];
  assert.deepEqual([l.ItemName, l.ItemCode, l.UnitName, l.Quantity, l.UnitPrice, l.Amount], ['Gel lô B', 'SP01', 'Hộp', 2, 345000, 690000]);
  assert.ok(!('VATRateName' in l));
  assert.throws(() => buildInvoice({ id: 1, tong_tien: 0 }, { name: 'x' }, { series: 'a' }));
  assert.throws(() => buildInvoice({ id: 1, tong_tien: 5 }, { name: 'x' }, { series: '' }));
});

test('client: đăng nhập rồi phát hành, lỗi mạng khi gửi = không rõ kết quả', async () => {
  const calls = [];
  const ok = (d) => ({ status: 200, text: async () => JSON.stringify(d) });
  const fake = async (url, o) => {
    calls.push([o.method, url.replace(/^https:\/\/[^/]+\/api\/integration/, ''), o.headers.Authorization || '']);
    if (url.endsWith('/auth/token')) return ok({ success: true, data: 'TK' });
    return ok({ success: true, publishInvoiceResult: JSON.stringify([{ RefID: 'R1', TransactionID: 'T1', InvNo: '00000012' }]) });
  };
  const c = misaClient({ env: 'test', appid: 'a', taxcode: 'm', username: 'u', password: 'p' }, { fetch: fake });
  const r = await c.publish({ RefID: 'R1' });
  assert.deepEqual([r.transactionId, r.invNo], ['T1', '00000012']);
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [['POST', '/auth/token'], ['POST', '/invoice']]);
  assert.equal(calls[1][2], 'Bearer TK');

  const broken = misaClient({ env: 'test', appid: 'a', taxcode: 'm', username: 'u', password: 'p' },
    { fetch: async url => { if (url.endsWith('/auth/token')) return ok({ success: true, data: 'TK' }); throw new Error('timeout'); } });
  await assert.rejects(broken.publish({ RefID: 'R1' }), e => e.unknown === true);

  const refused = misaClient({ env: 'test', appid: 'a', taxcode: 'm', username: 'u', password: 'p' },
    { fetch: async url => url.endsWith('/auth/token') ? ok({ success: true, data: 'TK' })
      : ok({ success: true, publishInvoiceResult: JSON.stringify([{ RefID: 'R1', ErrorCode: 'InvalidInvSeries' }]) }) });
  await assert.rejects(refused.publish({ RefID: 'R1' }), e => !e.unknown && /InvalidInvSeries/.test(e.message));
});
