// =====================================================================
//  misa-hoadon.js — Xuất HOÁ ĐƠN BÁN HÀNG (hộ kinh doanh, không VAT) qua MISA meInvoice
//  Dùng cho OMS: đơn "Ship thành công" → tạo + phát hành hoá đơn (oms.js, issueInvoice).
//
//  API tích hợp meInvoice (CHƯA đối chiếu với tài liệu doc.meinvoice.vn — môi trường dev không vào
//  được; dựng theo cách tích hợp quen thuộc của MISA). Phải chạy thử trên môi trường TEST trước:
//    POST {base}/auth/token        { appid, taxcode, username, password } → { success, data: token }
//    GET  {base}/invoice/templates?invyearfilter=YYYY                    → ký hiệu hoá đơn
//    POST {base}/invoice           { SignType, InvoiceData: [..], PublishInvoiceData: null }
//         → { success, publishInvoiceResult: "[{ RefID, TransactionID, InvNo, ErrorCode }]" }
//  Header sau đăng nhập: Authorization: Bearer <token>, CompanyTaxCode: <MST>.
// =====================================================================
import crypto from 'crypto';

export const misaBase = env => env === 'that'
  ? 'https://api.meinvoice.vn/api/integration'
  : 'https://testapi.meinvoice.vn/api/integration';

/* ---------- Đọc số tiền thành chữ (dòng "Số tiền viết bằng chữ") ---------- */
const SO = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
// full: nhóm đứng sau nhóm lớn hơn → đọc đủ "không trăm", "linh"
function docBaSo(n, full) {
  const h = Math.floor(n / 100), t = Math.floor(n / 10) % 10, u = n % 10, out = [];
  if (full || h) out.push(SO[h], 'trăm');
  if (t === 0) { if (u) out.push(...((full || h) ? ['linh', SO[u]] : [SO[u]])); }
  else if (t === 1) { out.push('mười'); if (u) out.push(u === 5 ? 'lăm' : SO[u]); }
  else { out.push(SO[t], 'mươi'); if (u) out.push(u === 1 ? 'mốt' : u === 5 ? 'lăm' : SO[u]); }
  return out;
}
function docDuoiTy(n, full) {
  const nhom = [[Math.floor(n / 1e6), 'triệu'], [Math.floor(n / 1e3) % 1000, 'nghìn'], [n % 1000, '']];
  const out = [];
  for (const [g, ten] of nhom) {
    if (!g) continue;
    out.push(...docBaSo(g, full || out.length > 0));
    if (ten) out.push(ten);
  }
  return out;
}
function docSoNguyen(n, full = false) {
  if (n >= 1e9) {
    const ty = Math.floor(n / 1e9), rest = n % 1e9;
    return [...docSoNguyen(ty, full), 'tỷ', ...(rest ? docDuoiTy(rest, true) : [])];
  }
  return docDuoiTy(n, full);
}
export function docTienBangChu(amount) {
  const n = Math.round(Math.abs(Number(amount) || 0));
  const s = n ? docSoNguyen(n).join(' ') : 'không';
  return s[0].toUpperCase() + s.slice(1) + ' đồng.';
}

// RefID cố định theo đơn (dạng GUID) → gửi lại cùng đơn thì MISA nhận ra trùng, không ra 2 hoá đơn
export function refIdForOrder(id) {
  const h = crypto.createHash('sha1').update('oms-order-' + id).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/* ---------- Dựng dữ liệu hoá đơn từ đơn OMS ---------- */
// item: { name, code, unit } — tên hàng trên hoá đơn đã chọn sẵn (xem resolveItem trong oms.js)
export function buildInvoice(order, item, { series, date = new Date() }) {
  const qty = Math.max(1, Number(order.so_luong) || 1);
  const amount = Math.round(Number(order.tong_tien) || 0) || Math.round((Number(order.gia_ban) || 0) * qty);
  if (amount <= 0) throw new Error('Đơn chưa có tổng tiền / giá bán');
  if (!item?.name) throw new Error('Chưa có tên hàng để xuất hoá đơn');
  if (!series) throw new Error('Chưa cài ký hiệu hoá đơn MISA');
  const unitPrice = Math.round(amount / qty * 10000) / 10000;
  // Ngày hoá đơn theo giờ Việt Nam
  const invDate = new Date(date.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
  return {
    RefID: refIdForOrder(order.id),
    InvSeries: series,
    InvDate: invDate,
    CurrencyCode: 'VND',
    ExchangeRate: 1,
    PaymentMethodName: 'TM/CK',
    BuyerLegalName: '',
    BuyerFullName: String(order.ten_kh || 'Khách lẻ').trim(),
    BuyerAddress: String(order.dia_chi_full || '').trim(),
    BuyerPhoneNumber: String(order.sdt || '').trim(),
    TotalSaleAmountOC: amount, TotalSaleAmount: amount,
    TotalDiscountAmountOC: 0, TotalDiscountAmount: 0,
    TotalAmountOC: amount, TotalAmount: amount,
    TotalAmountInWords: docTienBangChu(amount),
    OriginalInvoiceDetail: [{
      ItemType: 1, LineNumber: 1, SortOrder: 1,
      ItemCode: item.code || '',
      ItemName: item.name,
      UnitName: item.unit || 'Cái',
      Quantity: qty,
      UnitPrice: unitPrice,
      DiscountRate: 0, DiscountAmountOC: 0, DiscountAmount: 0,
      AmountOC: amount, Amount: amount,
    }],
  };
}

/* ---------- Gọi MISA ---------- */
export class MisaError extends Error {
  // unknown = không biết hoá đơn đã được tạo hay chưa (mất mạng / quá giờ) → không tự gửi lại
  constructor(msg, { unknown = false } = {}) { super(msg); this.unknown = unknown; }
}
const parseMaybe = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const errText = d => [d?.errorCode, d?.descriptionErrorCode, typeof d?.data === 'string' ? d.data : ''].filter(Boolean).join(' — ') || 'MISA báo lỗi';

// cfg: { env, appid, taxcode, username, password, signType }
export function misaClient(cfg, { fetch: f = fetch, cache = {} } = {}) {
  const base = misaBase(cfg.env);
  async function call(method, p, body, { token, unknownOnFail = false } = {}) {
    let r;
    try {
      r = await f(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token, CompanyTaxCode: cfg.taxcode } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(45000),
      });
    } catch (e) { throw new MisaError('Không gọi được MISA: ' + e.message, { unknown: unknownOnFail }); }
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch { throw new MisaError(`MISA trả HTTP ${r.status}: ${text.slice(0, 200)}`, { unknown: unknownOnFail && r.status >= 500 }); }
    if (r.status === 401) { cache.token = null; throw new MisaError('MISA từ chối token (401)'); }
    return d;
  }
  async function token() {
    if (cache.token && cache.at > Date.now() - 6 * 3600e3) return cache.token;
    if (!cfg.appid || !cfg.taxcode || !cfg.username || !cfg.password) throw new MisaError('Chưa cài đủ App ID / MST / tài khoản / mật khẩu MISA');
    const d = await call('POST', '/auth/token', { appid: cfg.appid, taxcode: cfg.taxcode, username: cfg.username, password: cfg.password });
    if (!d?.success || !d.data) throw new MisaError('Đăng nhập MISA lỗi: ' + errText(d));
    Object.assign(cache, { token: d.data, at: Date.now() });
    return d.data;
  }
  return {
    token,
    async templates(year = new Date().getFullYear()) {
      const d = await call('GET', '/invoice/templates?invyearfilter=' + year, null, { token: await token() });
      if (!d?.success) throw new MisaError('Lấy ký hiệu hoá đơn lỗi: ' + errText(d));
      return parseMaybe(d.data) || [];
    },
    // Tạo + phát hành 1 hoá đơn. Trả { transactionId, invNo, raw }
    async publish(invoice) {
      const d = await call('POST', '/invoice', { SignType: Number(cfg.signType) || 2, InvoiceData: [invoice], PublishInvoiceData: null },
        { token: await token(), unknownOnFail: true });
      const res = parseMaybe(d?.publishInvoiceResult ?? d?.createInvoiceResult);
      const row = Array.isArray(res) ? res.find(x => x?.RefID === invoice.RefID) || res[0] : null;
      if (!d?.success || !row || row.ErrorCode) throw new MisaError('MISA không phát hành: ' + (row?.ErrorCode ? [row.ErrorCode, row.DescriptionErrorCode].filter(Boolean).join(' — ') : errText(d)));
      return { transactionId: row.TransactionID || '', invNo: row.InvNo || '', raw: row };
    },
  };
}
