// Thử kết nối MISA meInvoice bằng TÀI KHOẢN KIỂM THỬ (không ảnh hưởng hoá đơn thật).
// Đọc từ .env (đã gitignore): MISA_CLIENT_ID, MISA_CLIENT_SECRET, MISA_TEST_TAXCODE, MISA_TEST_USER, MISA_TEST_PASS
// (tài khoản kiểm thử ở developer.misa.vn → Quản lý ứng dụng → TDMJSC Internal app → Hóa đơn điện tử → Môi trường kiểm thử).
//   node scripts/misa-thu.mjs            → lấy token + danh sách ký hiệu + xem dữ liệu hoá đơn sẽ gửi
//   node scripts/misa-thu.mjs --phat-hanh → phát hành thử 1 hoá đơn trên tài khoản kiểm thử
// Không in token / secret.
import fs from 'node:fs';
import crypto from 'node:crypto';
// Đọc .env (không cần thư viện dotenv)
try {
  for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (e) {}
import { misaClient, buildInvoice, seriesInfo } from '../misa-invoice.js';

const need = ['MISA_CLIENT_ID', 'MISA_CLIENT_SECRET', 'MISA_TEST_TAXCODE', 'MISA_TEST_USER', 'MISA_TEST_PASS'].filter(k => !process.env[k]);
if (need.length) { console.error('Thiếu trong .env:', need.join(', ')); process.exit(1); }

const c = misaClient({ clientId: process.env.MISA_CLIENT_ID, clientSecret: process.env.MISA_CLIENT_SECRET });
const tok = await c.token({ taxcode: process.env.MISA_TEST_TAXCODE, username: process.env.MISA_TEST_USER, password: process.env.MISA_TEST_PASS });
console.log('✅ Lấy token được (độ dài', tok.length, ')');

const tpls = [];
for (const withCode of [false, true]) {
  try { for (const t of await c.templates(tok, { withCode })) if (!tpls.some(x => x.InvSeries === t.InvSeries)) tpls.push(t); }
  catch (e) { console.log('templates withCode=' + withCode, '→', e.message); }
}
console.log('Ký hiệu:', tpls.map(t => `${t.InvSeries}${t.Inactive ? '(ngừng)' : ''}${t.IsSendSummary ? '(bảng TH)' : ''} ${t.TemplateName || ''}`).join(' | ') || '(không có)');
// --ky-hieu=2C26TYY để chọn ký hiệu; mặc định ký hiệu hoá đơn bán hàng đầu tiên
const want = (process.argv.find(a => a.startsWith('--ky-hieu=')) || '').split('=')[1];
const pickT = (want && tpls.find(t => t.InvSeries === want)) || tpls.find(t => !t.Inactive && t.InvSeries?.[0] === '2') || tpls.find(t => !t.Inactive);
if (!pickT) process.exit(0);

const info = seriesInfo(pickT.InvSeries);
const vat = process.env.MISA_TEST_VAT || (pickT.InvSeries[0] === '1' ? '8%' : 'KCT');
const order = { id: 1, misa_ref_id: crypto.randomUUID(), ten_kh: 'Khách thử OMS', sdt: '0900000000', dia_chi_full: 'Hà Nội',
  san_pham: 'Sản phẩm thử', so_luong: 2, gia_ban: 125000, giam_gia: 10000, phi_ship: 30000, tong_tien: 240000, ma_don_hang: 'OMSTEST' };
const inv = buildInvoice(order, { series: pickT.InvSeries, vat, summary: !!pickT.IsSendSummary });
console.log('Ký hiệu dùng thử:', pickT.InvSeries, '· SignType', info.signType, '· thuế', vat);
if (!process.argv.includes('--phat-hanh')) { console.log(JSON.stringify(inv, null, 2)); process.exit(0); }

const res = await c.publish(tok, info.signType, [inv]);
console.log('Kết quả phát hành:', JSON.stringify(res, null, 2));
const tran = res[0]?.TransactionID;
if (tran) {
  await new Promise(r => setTimeout(r, 4000));
  try { console.log('Trạng thái:', JSON.stringify(await c.status(tok, [tran], { byRef: false, withCode: info.coMa, mayTinhTien: info.mayTinhTien }), null, 2)); }
  catch (e) { console.log('Tra trạng thái lỗi:', e.message); }
}
