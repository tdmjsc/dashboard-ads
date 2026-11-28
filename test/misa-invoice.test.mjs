import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoice, seriesInfo, vatPercent, cleanText, misaClient, MISA_BASE } from '../misa-invoice.js';

const order = { id: 7, misa_ref_id: 'ref-1', ten_kh: 'Chị Lan 😊', sdt: '0912 345 678', dia_chi_full: 'Hà Nội',
  san_pham: 'Gel đuổi chuột', so_luong: 4, gia_ban: 125000, giam_gia: 50000, phi_ship: 30000, tong_tien: 450000 };

test('ký hiệu: loại, có mã, máy tính tiền, kiểu ký', () => {
  assert.deepEqual(seriesInfo('2C25TYY'), { loai: '2', coMa: true, mayTinhTien: false, signType: 2 });
  assert.equal(seriesInfo('1C25MAB').signType, 5);
  assert.equal(seriesInfo('2K25TAA').coMa, false);
});

test('thuế suất', () => {
  assert.equal(vatPercent('8%'), 8);
  assert.equal(vatPercent('KHAC:3.5%'), 3.5);
  assert.equal(vatPercent('KCT'), null);
});

test('bỏ emoji khỏi tên (MISA báo InvalidXMLContainEmoji)', () => {
  assert.equal(cleanText('Chị Lan 😊 ❤️'), 'Chị Lan');
});

test('hoá đơn không thuế (KCT): giảm giá = chiết khấu dòng, phí ship là dòng riêng, tổng = tong_tien + phí ship', () => {
  const inv = buildInvoice(order, { series: '2C25TYY', vat: 'KCT', date: '2026-11-27' });
  assert.equal(inv.RefID, 'ref-1');
  assert.equal(inv.InvTemplateNo, '2');
  assert.equal(inv.BuyerFullName, 'Chị Lan');
  assert.equal(inv.BuyerPhoneNumber, '0912345678');
  assert.equal(inv.OriginalInvoiceDetail.length, 2);
  const [sp, ship] = inv.OriginalInvoiceDetail;
  assert.equal(sp.AmountOC, 500000);
  assert.equal(sp.DiscountAmountOC, 50000);
  assert.equal(sp.AmountWithoutVATOC, 450000);
  assert.equal(sp.VATAmountOC, 0);
  assert.equal(ship.ItemName, 'Phí vận chuyển');
  assert.equal(ship.AmountWithoutVATOC, 30000);
  assert.equal(inv.TotalSaleAmountOC, 530000);
  assert.equal(inv.TotalDiscountAmountOC, 50000);
  assert.equal(inv.TotalAmountOC, 480000);
  assert.equal(inv.TotalAmountOC, order.tong_tien + order.phi_ship);
});

test('hoá đơn có thuế 8%: giá bán lẻ đã gồm thuế, tách ngược, tổng thanh toán không đổi', () => {
  const inv = buildInvoice({ ...order, phi_ship: 0 }, { series: '1C25TYY', vat: '8%' });
  const l = inv.OriginalInvoiceDetail[0];
  assert.equal(l.AmountWithoutVATOC + l.VATAmountOC, 450000);
  assert.equal(inv.TotalAmountOC, 450000);
  assert.equal(inv.TaxRateInfo[0].VATRateName, '8%');
  assert.equal(inv.TotalAmountWithoutVATOC + inv.TotalVATAmountOC, inv.TotalAmountOC);
});

// fetch giả: ghi lại request, trả phản hồi theo đường dẫn
function fakeFetch(handlers) {
  const calls = [];
  const f = async (url, opt) => {
    calls.push({ url, opt, body: opt.body ? JSON.parse(opt.body) : undefined });
    const path = url.replace(MISA_BASE, '').split('?')[0];
    const out = handlers[path](calls.at(-1));
    return { status: out.status || 200, text: async () => JSON.stringify(out.body ?? out) };
  };
  f.calls = calls;
  return f;
}

test('client: token gửi ClientID/ClientSecret + MST/tài khoản; phát hành parse publishInvoiceResult dạng chuỗi', async () => {
  const f = fakeFetch({
    '/invoice/token': () => ({ Success: true, Data: 'TOKEN1' }),
    '/invoice/publishing': () => ({ success: true, publishInvoiceResult: JSON.stringify([{ RefID: 'ref-1', TransactionID: 'TX1', InvNo: '00000012', ErrorCode: null }]) }),
  });
  const c = misaClient({ clientId: 'CID', clientSecret: 'SEC', fetchImpl: f });
  const tok = await c.token({ taxcode: '0101', username: 'u', password: 'p' });
  assert.equal(tok, 'TOKEN1');
  assert.equal(f.calls[0].opt.headers.ClientID, 'CID');
  assert.equal(f.calls[0].opt.headers.ClientSecret, 'SEC');
  assert.deepEqual(f.calls[0].body, { taxcode: '0101', username: 'u', password: 'p' });
  const res = await c.publish(tok, 2, [{ RefID: 'ref-1' }]);
  assert.equal(res[0].InvNo, '00000012');
  assert.equal(f.calls[1].opt.headers.Authorization, 'Bearer TOKEN1');
  assert.equal(f.calls[1].opt.headers.ClientSecret, undefined); // secret chỉ gửi khi lấy token
  assert.equal(f.calls[1].body.SignType, 2);
});

test('client: lỗi MISA → MisaError có mã; 429 → TooManyRequests', async () => {
  const f = fakeFetch({
    '/invoice/token': () => ({ Success: false, ErrorCode: 'InvalidTaxCode', DescriptionErrorCode: 'MST sai' }),
    '/invoice/templates': () => ({ status: 429, body: {} }),
  });
  const c = misaClient({ clientId: 'C', clientSecret: 'S', fetchImpl: f });
  await assert.rejects(c.token({ taxcode: 'x', username: 'u', password: 'p' }), e => e.code === 'InvalidTaxCode');
  await assert.rejects(c.templates('T'), e => e.code === 'TooManyRequests');
  assert.throws(() => misaClient({ clientId: '', clientSecret: '' }), e => e.code === 'NoClient');
});
