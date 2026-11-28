// MISA meInvoice OpenAPI (developer.misa.vn) — xem docs/misa-meinvoice-api.md.
// Ứng dụng "TDMJSC Internal app": ClientID / ClientSecret của ứng dụng + MST / tài khoản / mật khẩu meInvoice của
// từng hộ kinh doanh (chi nhánh OMS). Module này không đụng DB: oms.js lo cấu hình, hàng đợi, lưu kết quả.

export const MISA_BASE = 'https://developer.misa.vn/apis/itg/meinvoice';

// Bỏ emoji / ký tự ngoài BMP (MISA báo InvalidXMLContainEmoji) và ký tự điều khiển
export const cleanText = (s, max = 400) => String(s ?? '')
  .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, max);

// Ngày hoá đơn = ngày giờ Việt Nam
export const vnDate = (d = new Date()) => new Date(new Date(d).getTime() + 7 * 3600000).toISOString().slice(0, 10);

// Ký hiệu XC25TYY: ký tự 1 = loại (1 GTGT, 2 bán hàng), 2 = C có mã / K không mã, 5 = T thường / M máy tính tiền
export function seriesInfo(series) {
  const s = String(series || '').trim().toUpperCase();
  return {
    loai: s[0] || '', coMa: s[1] === 'C', mayTinhTien: s[4] === 'M',
    // HĐ máy tính tiền ký kiểu 5 (không hiện CKS), còn lại ký HSM (2). SignType 1 (USB token) không hỗ trợ ở luồng này.
    signType: s[4] === 'M' ? 5 : 2,
  };
}

const VAT_PCT = { '0%': 0, '5%': 5, '8%': 8, '10%': 10 };
export function vatPercent(name) {
  if (name in VAT_PCT) return VAT_PCT[name];
  const m = /^KHAC:(\d+(?:\.\d+)?)%$/i.exec(String(name || ''));
  return m ? Number(m[1]) : null; // null = không tính thuế (KCT, KKKNT, KTPVDC…)
}

const r0 = n => Math.round(Number(n) || 0);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Dựng 1 InvoiceData từ đơn OMS.
// Giá OMS là giá bán lẻ đã gồm thuế: thuế suất % thì tách ngược ra tiền trước thuế; KCT / KKKNT… thì không có thuế.
// Dòng hàng: SP (giảm giá → chiết khấu trên dòng) + dòng "Phí vận chuyển" nếu đơn có phí ship thu của khách.
// Tổng thanh toán = tong_tien (đã trừ giảm giá) + phi_ship; đặt cọc không làm đổi giá trị hoá đơn.
export function buildInvoice(o, cfg) {
  const series = String(cfg.series || '').trim();
  const info = seriesInfo(series);
  // Hoá đơn bán hàng (ký hiệu 2…, hộ / cá nhân kinh doanh) không có thuế GTGT → luôn KCT, bỏ qua thuế suất cài đặt.
  // Thuế suất % chỉ áp cho hoá đơn GTGT (ký hiệu 1…) của doanh nghiệp khai thuế GTGT.
  const vatName = info.loai === '2' ? 'KCT' : (cfg.vat || 'KCT');
  const pct = vatPercent(vatName);
  const lines = [];
  const qty = Math.max(1, Number(o.so_luong) || 1);
  const gross = r0((Number(o.gia_ban) || 0) * qty);                    // trước giảm giá, gồm thuế
  const giam = Math.min(gross, Math.max(0, r0(o.giam_gia)));
  const add = (name, q, grossAmt, discGross, unit) => {
    // Tách thuế theo từng dòng (MISA khuyên làm tròn từng phần rồi cộng)
    const k = pct ? 1 + pct / 100 : 1;
    const amount = pct ? r0(grossAmt / k) : grossAmt;                  // thành tiền trước thuế, trước CK
    const disc = pct ? r0(discGross / k) : discGross;
    const net = amount - disc;
    const vat = pct ? (grossAmt - discGross) - net : 0;
    lines.push({
      ItemType: 1, SortOrder: lines.length + 1, LineNumber: lines.length + 1,
      ItemCode: cleanText(o.ma_sp || '', 50) || undefined,
      ItemName: cleanText(name, 500) || 'Hàng hoá', UnitName: unit,
      Quantity: q, UnitPrice: r2(amount / q), AmountOC: amount, Amount: amount,
      DiscountRate: amount ? r2(disc * 100 / amount) : 0, DiscountAmountOC: disc, DiscountAmount: disc,
      AmountWithoutVATOC: net, AmountWithoutVAT: net,
      VATRateName: vatName, VATAmountOC: vat, VATAmount: vat,
    });
  };
  add(o.san_pham || 'Hàng hoá', qty, gross, giam, cfg.unit || 'Cái');
  const ship = Math.max(0, r0(o.phi_ship));
  if (ship) add('Phí vận chuyển', 1, ship, 0, 'Lần');

  const sum = f => lines.reduce((s, l) => s + l[f], 0);
  const sale = sum('AmountOC'), disc = sum('DiscountAmountOC'), net = sum('AmountWithoutVATOC'), vat = sum('VATAmountOC');
  const phone = String(o.sdt || '').replace(/\D/g, '').slice(0, 20);
  return {
    RefID: o.misa_ref_id,
    InvSeries: series,
    InvTemplateNo: info.loai,          // mẫu số = ký tự đầu của ký hiệu (1 GTGT, 2 bán hàng)
    InvDate: cfg.date || vnDate(),
    CurrencyCode: 'VND', ExchangeRate: 1,
    PaymentMethodName: 'TM/CK',
    IsInvoiceSummary: !!cfg.summary,
    IsSendEmail: false,
    BuyerFullName: cleanText(o.ten_kh, 400) || 'Khách lẻ',
    BuyerPhoneNumber: phone || undefined,
    BuyerAddress: cleanText(o.dia_chi_full, 400) || undefined,
    BuyerOrderCode: cleanText(o.ma_don_hang || `OMS${o.id}`, 255),
    TotalSaleAmountOC: sale, TotalSaleAmount: sale,
    TotalDiscountAmountOC: disc, TotalDiscountAmount: disc,
    TotalAmountWithoutVATOC: net, TotalAmountWithoutVAT: net,
    TotalVATAmountOC: vat, TotalVATAmount: vat,
    TotalAmountOC: net + vat, TotalAmount: net + vat,
    OriginalInvoiceDetail: lines,
    TaxRateInfo: [{ VATRateName: vatName, AmountWithoutVATOC: net, VATAmountOC: vat }],
    OptionUserDefined: { MainCurrency: 'VND', QuantityDecimalDigits: '0', UnitPriceOCDecimalDigits: '2', UnitPriceDecimalDigits: '2',
      AmountOCDecimalDigits: '0', AmountDecimalDigits: '0', CoefficientDecimalDigits: '2', ExchangRateDecimalDigits: '0' },
  };
}

// ---- Gọi API ----
// MISA trả lỗi trong JSON (Success / ErrorCode); một số trường là chuỗi JSON lồng → parse khi cần.
const parseMaybe = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return v; } };
const pick = (o, k) => o?.[k] ?? o?.[k[0].toLowerCase() + k.slice(1)] ?? o?.[k[0].toUpperCase() + k.slice(1)];

export class MisaError extends Error {
  constructor(code, desc, extra = {}) { super(`${code || 'Lỗi'}${desc ? ': ' + desc : ''}`); this.code = code || ''; this.desc = desc || ''; Object.assign(this, extra); }
}

async function call(path, { method = 'POST', headers = {}, body, query, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const url = MISA_BASE + path + (query ? '?' + new URLSearchParams(query) : '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetchImpl(url, { method, headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    text = await res.text();
  } catch (e) { throw new MisaError('Network', e.name === 'AbortError' ? 'MISA không phản hồi (quá 30 giây)' : e.message); }
  finally { clearTimeout(t); }
  if (res.status === 429) throw new MisaError('TooManyRequests', 'Quá giới hạn gọi MISA (10 lần / 60 giây), thử lại sau');
  let data; try { data = JSON.parse(text); } catch (e) { throw new MisaError(`HTTP${res.status}`, text.slice(0, 200)); }
  return data;
}

export function misaClient({ clientId, clientSecret, fetchImpl = fetch }) {
  if (!clientId || !clientSecret) throw new MisaError('NoClient', 'Chưa nhập Client ID / Client Secret MISA (tab Cấu hình)');
  const base = { ClientID: clientId };
  const ok = d => pick(d, 'Success') === true;
  const fail = d => new MisaError(pick(d, 'ErrorCode'), pick(d, 'DescriptionErrorCode') || [].concat(pick(d, 'Errors') || []).join('; '));
  return {
    // Lấy token (hạn 14 ngày). Tài khoản bật 2 bước → CustomData có Id, cần /invoice/2fa (OMS chưa hỗ trợ: tắt 2FA cho tài khoản kết nối).
    async token({ taxcode, username, password }) {
      const d = await call('/invoice/token', { headers: { ...base, ClientSecret: clientSecret }, body: { taxcode, username, password }, fetchImpl });
      const tok = pick(d, 'Data');
      if (ok(d) && typeof tok === 'string' && tok) return tok;
      if (ok(d)) throw new MisaError('TwoFactor', 'Tài khoản meInvoice đang bật xác thực 2 bước. Tắt xác thực 2 bước cho tài khoản dùng để kết nối.', { customData: pick(d, 'CustomData') });
      // Lỗi đăng nhập: MISA trả UnAuthorize cho nhiều trường hợp, phân biệt bằng Errors (đã thử 28/11/2026)
      const sub = [].concat(pick(d, 'Errors') || []).join(',');
      if (/UserNotExist/i.test(sub)) throw new MisaError('UserNotExist', 'Tài khoản không có quyền trên mã số thuế này (MISA: "User chưa được phân quyền"). Kiểm tra: ô Tài khoản phải là EMAIL hoặc SĐT dùng để đăng nhập meInvoice (MISA ID), không phải MST; tài khoản đó phải được thêm vào đơn vị có đúng MST trên meInvoice.');
      if (/MisaIdError/i.test(sub)) throw new MisaError('MisaIdError', 'Sai tài khoản hoặc mật khẩu meInvoice (MISA ID).');
      throw fail(d);
    },
    async templates(token, { withCode, year } = {}) {
      const query = { ticket: 'false', year: String(year || new Date().getFullYear()) };
      if (withCode !== undefined) query.invoiceWithCode = String(!!withCode);
      const d = await call('/invoice/templates', { method: 'GET', headers: { ...base, Authorization: `Bearer ${token}` }, query, fetchImpl });
      if (!ok(d)) throw fail(d);
      return [].concat(parseMaybe(pick(d, 'Data')) || []);
    },
    // Phát hành: trả mảng kết quả từng hoá đơn { RefID, TransactionID, InvNo, ErrorCode, DescriptionErrorCode, … }
    async publish(token, signType, invoices) {
      const d = await call('/invoice/publishing', { headers: { ...base, Authorization: `Bearer ${token}` }, body: { SignType: signType, InvoiceData: invoices }, fetchImpl, timeoutMs: 60000 });
      const results = [].concat(parseMaybe(pick(d, 'PublishInvoiceResult')) || []);
      if (!ok(d) && !results.length) throw fail(d);
      return results;
    },
    // Trạng thái theo RefID (inputType 2) hoặc TransactionID (1)
    async status(token, ids, { byRef = true, withCode = false, mayTinhTien = false } = {}) {
      const d = await call('/invoice/status', { headers: { ...base, Authorization: `Bearer ${token}` }, body: ids,
        query: { inputType: byRef ? '2' : '1', invoiceWithCode: String(!!withCode), invoiceCalcu: String(!!mayTinhTien) }, fetchImpl });
      if (!ok(d)) throw fail(d);
      return [].concat(parseMaybe(pick(d, 'Data')) || []);
    },
  };
}

// Lỗi cần lấy token mới rồi gọi lại
export const isTokenError = code => ['UnAuthorize', 'TokenExpiredCode', 'InvalidTokenCode', 'HTTP401'].includes(code);
// Lỗi nên thử lại sau vài giây (số hoá đơn chưa liên tục / trùng do gửi song song / lỗi hệ thống)
export const isRetryError = code => ['InvoiceNumberNotCotinuous', 'InvoiceDuplicated', 'SystemError', 'TooManyRequests', 'Network'].includes(code);
