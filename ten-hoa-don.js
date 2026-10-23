// =====================================================================
//  TÊN XUẤT HOÁ ĐƠN THEO LÔ — ten-hoa-don.js
//  Một sản phẩm trên Sandbox (vd "Máy đo nồng độ cồn") nhập từ nhiều nhà cung cấp,
//  mỗi nhà cung cấp ghi tên hơi khác (B, C…) và MISA theo dõi tồn riêng từng tên.
//  Module giữ một HÀNG ĐỢI tên xuất hoá đơn cho sản phẩm đó: đang xuất theo tên B,
//  khi B hết số lượng được xuất thì tự đổi ô "Tên xuất hoá đơn" của sản phẩm trên
//  Sandbox sang C (rồi D…), và nhắn nhóm kho qua Telegram.
//
//  Số lượng còn được xuất của mỗi tên:
//   • Mặc định = tồn MISA của mã hàng ghép với tên đó (hoá đơn xuất ra trừ tồn MISA).
//   • Hoặc nhập tay: "còn X tính từ lúc lưu". Khi đó lượng đã xuất = tồn MISA lúc lưu − tồn MISA
//     hiện tại (nếu có ghép mã MISA); không ghép mã MISA thì số nhập tay đứng yên đến khi sửa.
//
//  Đổi tên trên Sandbox: Sandbox không có API công khai cho việc này, nên admin chép
//  request "Lưu" của form Cập nhật sản phẩm (Copy as cURL) và dán vào trang
//  /ten-hoa-don.html. Máy chủ gửi lại đúng request đó, chỉ thay ô tên xuất hoá đơn.
//  Nếu dán thêm request lấy chi tiết sản phẩm (lúc mở form), máy chủ lấy dữ liệu mới
//  nhất trước khi lưu để không ghi đè giá/tên… vừa sửa trên Sandbox.
//
//  Lưu ở DATA_DIR/ten-hoa-don.json (chứa cookie Sandbox → quyền 600).
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import { parseRawRequest } from './misa-tonkho.js';

const DROP_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding', 'priority']);
const MAX_HISTORY = 100;

export function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isSet = v => v !== null && v !== undefined && v !== '';

/* ---------- Đường dẫn trong JSON: "data.tenXuatHoaDon", "items.0.ten" ---------- */
export function getPath(obj, p) {
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function setPath(obj, p, val) {
  const ks = String(p).split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') throw new Error(`Không có trường "${ks.slice(0, i + 1).join('.')}" trong dữ liệu sản phẩm.`);
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = val;
  return obj;
}

// Tìm các trường có vẻ là "Tên xuất hoá đơn" trong body request Lưu sản phẩm
export function findInvoiceFields(obj) {
  const out = [];
  const walk = (o, pre, depth) => {
    if (!o || typeof o !== 'object' || depth > 5) return;
    for (const [k, v] of Object.entries(o)) {
      const p = pre ? `${pre}.${k}` : k;
      if (typeof v === 'string' || v === null) {
        if (/hoa_?don|hoadon|invoice|xuat_?hd/i.test(k)) out.push({ path: p, value: v ?? '' });
      } else walk(v, p, depth + 1);
    }
  };
  walk(obj, '', 0);
  // Ưu tiên trường có chữ "ten"/"name" (tên xuất HĐ) hơn mã/ngày/cờ hoá đơn
  const score = f => (/ten|name/i.test(f.path.split('.').pop()) ? 0 : 1) + (/ma|code|id|ngay|date|is/i.test(f.path.split('.').pop()) ? 2 : 0);
  return out.sort((a, b) => score(a) - score(b));
}

// Kiểm tra + chuẩn hoá request Sandbox dán vào. kind: 'save' (bắt buộc có body JSON) | 'detail'
export function parseSandboxRequest(raw, kind) {
  const req = parseRawRequest(raw);
  let u;
  try { u = new URL(req.url); } catch { throw new Error('Không tìm thấy địa chỉ request.'); }
  // Chỉ cho gọi tới máy chủ Sandbox — tránh bị lợi dụng gọi địa chỉ khác
  if (u.protocol !== 'https:' || !(u.hostname === 'sandbox.com.vn' || u.hostname.endsWith('.sandbox.com.vn')))
    throw new Error('Request phải gửi tới tên miền sandbox.com.vn (https).');
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP_HEADERS.has(k) && !k.startsWith(':')) headers[k] = v;
  let body = null;
  if (req.body) {
    try { body = JSON.parse(req.body); } catch { throw new Error('Phần dữ liệu gửi đi (body) không phải JSON.'); }
  }
  const method = req.method || (req.body ? 'POST' : 'GET');
  if (kind === 'save') {
    if (!body || typeof body !== 'object') throw new Error('Request Lưu sản phẩm phải có dữ liệu sản phẩm (body). Hãy chép request được gửi khi bấm nút "Lưu".');
    if (method === 'GET') throw new Error('Đây là request đọc (GET), không phải request Lưu.');
  }
  if (body) headers['content-type'] = 'application/json';
  return { url: u.href, method, headers, body };
}

/* ---------- Hàng đợi tên: tính số còn được xuất ---------- */
// stock: Map normKey → qty (tồn MISA cộng các kho). entry: { ten, misaKey, soLuong, baseline }
export function remainingOf(entry, stock, isActive) {
  const misaQty = entry.misaKey && stock.has(entry.misaKey) ? stock.get(entry.misaKey) : null;
  // Đếm theo hoá đơn điện tử Sandbox (entry.hd do máy chủ cập nhật cho tên đang dùng): thay cách trừ theo tồn MISA
  if (isActive && entry.hd && isSet(entry.soLuong)) {
    if (typeof entry.hd.qty !== 'number') return { remaining: null, misaQty, used: 0, source: 'hd' }; // chưa đếm được → không tự đổi
    return { remaining: num(entry.soLuong) - entry.hd.qty, misaQty, used: entry.hd.qty, source: 'hd' };
  }
  if (isSet(entry.soLuong)) {
    // Nhập tay "còn X tính từ lúc lưu"; trừ phần tồn MISA đã giảm kể từ lúc đó
    const used = isActive && misaQty !== null && isSet(entry.baseline) ? Math.max(0, num(entry.baseline) - misaQty) : 0;
    return { remaining: num(entry.soLuong) - used, misaQty, used, source: 'tay' };
  }
  if (misaQty !== null) return { remaining: misaQty, misaQty, used: 0, source: 'misa' };
  return { remaining: null, misaQty: null, used: 0, source: 'chua-co' }; // chưa biết số lượng → không tự đổi
}

// Quyết định có đổi tên không. Trả về { action: 'giu' | 'doi' | 'het', next? }
export function decide(rule, stock) {
  const q = rule.queue || [];
  if (!q.length) return { action: 'giu' };
  const idx = Math.min(Math.max(0, rule.activeIdx || 0), q.length - 1);
  const cur = remainingOf(q[idx], stock, true);
  const buffer = num(rule.buffer);
  if (cur.remaining === null || cur.remaining > buffer) return { action: 'giu' };
  // Tên kế tiếp còn hàng: ưu tiên các tên sau tên hiện tại, rồi quay lại đầu danh sách
  const order = [...q.keys()].slice(idx + 1).concat([...q.keys()].slice(0, idx));
  for (const j of order) {
    const r = remainingOf(q[j], stock, false);
    if (r.remaining === null || r.remaining > buffer) return { action: 'doi', next: j };
  }
  return { action: 'het' };
}

export function mountTenHoaDon(app, { json, guard, wrap, DATA_DIR, fetchWithTimeout, getStockItems, notify }) {
  const FILE = path.join(DATA_DIR, 'ten-hoa-don.json');
  // Máy chủ (Passenger) có thể chạy nhiều tiến trình cùng lúc, mỗi tiến trình một bản STORE trong bộ nhớ.
  // Từng mất dữ liệu (10/2026): tiến trình giữ bản cũ ghi đè cả file, xoá các sản phẩm vừa thêm ở tiến trình khác.
  // Vì vậy: đọc lại file trước mỗi việc (reload) và mọi lần ghi đi qua commit(): đọc file mới nhất → sửa → ghi
  // ngay (đồng bộ, không await ở giữa). Việc gọi mạng lâu thì làm trước, rồi commit phần kết quả theo id.
  // Bản sao mỗi giờ (giữ 72 bản) ở DATA_DIR/ten-hoa-don.bak/ — giống salary-manual.json.bak: dữ liệu ở
  // DATA_DIR không nằm trong backup hằng ngày của Hostinger, mất là không lấy lại được.
  const BAK_DIR = path.join(DATA_DIR, 'ten-hoa-don.bak');
  function snapshot() {
    try {
      if (!fs.existsSync(FILE)) return;
      const name = path.join(BAK_DIR, new Date().toISOString().slice(0, 13) + '.json');
      if (fs.existsSync(name)) return;
      fs.mkdirSync(BAK_DIR, { recursive: true, mode: 0o700 });
      fs.copyFileSync(FILE, name); fs.chmodSync(name, 0o600);
      const old = fs.readdirSync(BAK_DIR).filter(f => f.endsWith('.json')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 72))) fs.unlinkSync(path.join(BAK_DIR, f));
    } catch (e) { console.warn('[TENHD] sao lưu lỗi:', e.message); }
  }
  // Khởi động: file chính mất / hỏng → khôi phục từ bản sao mới nhất đọc được
  (() => {
    try { JSON.parse(fs.readFileSync(FILE, 'utf8')); return; } catch (e) { if (e.code === 'ENOENT' && !fs.existsSync(BAK_DIR)) return; }
    try {
      for (const f of fs.readdirSync(BAK_DIR).filter(f => f.endsWith('.json')).sort().reverse()) {
        try { JSON.parse(fs.readFileSync(path.join(BAK_DIR, f), 'utf8')); fs.copyFileSync(path.join(BAK_DIR, f), FILE); console.log('[TENHD] khôi phục từ bản sao', f); return; } catch {}
      }
    } catch {}
  })();
  const readStore = () => { try { return { rules: [], ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { rules: [] }; } };
  let STORE = readStore();
  const reload = () => { STORE = readStore(); };
  function commit(fn) {
    snapshot();
    const s = readStore();
    const out = fn(s);
    try {
      const tmp = FILE + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, FILE); // ghi file tạm rồi đổi tên: không để file dở dang
    } catch (e) { console.error('[TENHD] lưu file lỗi:', e.message); }
    STORE = s;
    return out;
  }
  const tgEsc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const findRule = id => STORE.rules.find(r => r.id === id);
  const findIn = (s, id) => s.rules.find(r => r.id === id);

  // Tồn MISA hiện tại gộp theo mã hàng (cùng khoá với trang Tồn kho)
  function stockMap() {
    const m = new Map(), info = new Map();
    for (const it of getStockItems()) {
      const key = it.code || normName(it.name);
      m.set(key, (m.get(key) || 0) + num(it.qty));
      if (!info.has(key)) info.set(key, { key, code: it.code, name: it.name, unit: it.unit });
    }
    return { m, info };
  }

  /* ---------- Gọi Sandbox ---------- */
  async function sandboxFetch(req, body) {
    const auth = global.__sandboxAuth;
    const send = async () => {
      const headers = { ...req.headers };
      // Có tài khoản Sandbox trên máy chủ thì dùng phiên của máy chủ (cookie dán vào sẽ hết hạn)
      if (auth && auth.hasLogin()) {
        if (!auth.cookie()) await auth.login();
        headers.cookie = auth.cookie();
      }
      return fetchWithTimeout(req.url, { method: req.method, headers, body: body ? JSON.stringify(body) : undefined }, 30000);
    };
    // Lỗi mạng (Sandbox ngắt kết nối giữa chừng: "terminated", ECONNRESET, quá giờ) → thử lại tối đa 2 lần.
    // Chỉ thử lại lỗi mạng, không thử lại lỗi HTTP. Lưu sản phẩm gửi lại cùng dữ liệu nên gửi 2 lần vẫn đúng.
    let r, text;
    for (let lan = 0; ; lan++) {
      try {
        r = await send();
        if ((r.status === 401 || r.status === 403) && auth && auth.hasLogin()) { await auth.login(); r = await send(); }
        text = await r.text();
        break;
      } catch (e) {
        if (lan >= 2) throw new Error(`Mất kết nối tới Sandbox sau 3 lần thử (${e.message}).`);
        console.warn('[TENHD] lỗi mạng, thử lại:', req.url, e.message);
        await new Promise(ok => setTimeout(ok, 2000 * (lan + 1)));
      }
    }
    let j = null; try { j = JSON.parse(text); } catch {}
    if (r.status === 401 || r.status === 403)
      throw new Error(`Sandbox từ chối (HTTP ${r.status}) — phiên đăng nhập trong request đã hết hạn, hãy dán lại request.`);
    if (!r.ok) throw new Error(`Sandbox báo lỗi HTTP ${r.status}: ${text.slice(0, 200)}`);
    if (j && (j.success === false || j.Success === false))
      throw new Error('Sandbox báo lỗi: ' + (j.message || j.Message || JSON.stringify(j).slice(0, 200)));
    return j;
  }

  // Sản phẩm trong response request chi tiết. Sandbox không có API chi tiết khi mở form: form lấy
  // dữ liệu từ request tìm kiếm (SanPham/TimTheoDieuKienSPCha) nên response có thể là danh sách →
  // chọn object có cùng id/mã với body Lưu.
  function pickProduct(j, target) {
    const idKeys = Object.keys(target).filter(k => /^(id|ma\w*|code)$/i.test(k) && isSet(target[k]) && typeof target[k] !== 'object');
    const cands = [];
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 4) return;
      if (Array.isArray(o)) { o.forEach(x => walk(x, depth + 1)); return; }
      cands.push(o);
      for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
    };
    walk(j, 0);
    const match = o => idKeys.length && idKeys.every(k => k in o) && idKeys.every(k => String(o[k]) === String(target[k]));
    const found = cands.find(match);
    if (found) return found;
    if (idKeys.length) throw new Error(`Request chi tiết không có sản phẩm ${idKeys.map(k => `${k}=${target[k]}`).join(', ')}.`);
    return j && typeof j.data === 'object' && !Array.isArray(j.data) ? j.data : j;
  }

  // Dữ liệu sản phẩm mới nhất (nếu có request chi tiết) để không ghi đè sửa đổi khác trên Sandbox
  async function latestBody(rule) {
    const base = JSON.parse(JSON.stringify(rule.save.body));
    if (!rule.detail) return base;
    const target = rule.save.wrapKey ? base[rule.save.wrapKey] : base;
    const fresh = pickProduct(await sandboxFetch(rule.detail, rule.detail.body), target);
    if (!fresh || typeof fresh !== 'object') throw new Error('Request chi tiết sản phẩm không trả về dữ liệu sản phẩm.');
    // Lấy giá trị mới cho mọi trường có trong body Lưu (giữ nguyên cấu trúc body Lưu)
    for (const k of Object.keys(target)) if (k in fresh) target[k] = fresh[k];
    return base;
  }

  /* ---------- Gọi thẳng API Sandbox theo mã sản phẩm (cần SANDBOX_WEB_USER/PASS) ----------
     Đã đối chiếu với form Cập nhật sản phẩm thật (10/2026):
       tìm:  POST warehouse/api/SanPham/TimTheoDieuKienSPCha  { keyword: mã } → data[] có id, ma, tenXuatHoaDon
       đọc:  POST warehouse/api/SanPham/SanPhamInit { id } → data.data (mọi ô của form)
       lưu:  POST warehouse/api/SanPham/CapNhatThongTin  body = buildSaveBody(data.data)
     buildSaveBody dựng lại body y hệt form gửi (đã so khớp từng trường với một lần Lưu thật). */
  const SB_API = 'https://api.sandbox.com.vn/warehouse/api/SanPham/';
  const apiMode = rule => !!(rule.maSP && global.__sandboxAuth?.hasLogin());
  function sbPost(endpoint, body) {
    const origin = global.__sandboxAuth?.origin || 'https://tdmjsc.sandbox.com.vn';
    return sandboxFetch({ url: /^https:/.test(endpoint) ? endpoint : SB_API + endpoint, method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*', origin, referer: origin + '/' } }, body);
  }
  async function searchProducts(keyword) {
    const j = await sbPost('TimTheoDieuKienSPCha', { pageInfo: { page: 1, pageSize: 20 }, sorts: [], keyword, ListIdNhomSanPham: [],
      ListIdNhanSanPham: null, ListIdDmThuongHieu: null, ListIdDmXuatXu: null, ListIdDmMauSac: null, Model: null, ListIdNhaCungCap: null,
      SuDung: null, XemTatCaChiNhanh: true });
    return Array.isArray(j?.data) ? j.data : [];
  }
  async function findProduct(ma) {
    const p = (await searchProducts(ma)).find(x => String(x.ma).trim().toLowerCase() === String(ma).trim().toLowerCase());
    if (!p) throw new Error(`Không tìm thấy sản phẩm mã "${ma}" trên Sandbox.`);
    return p;
  }
  async function productInit(id) {
    const j = await sbPost('SanPhamInit', { id });
    const p = j?.data?.data;
    if (!p || typeof p !== 'object' || p.id !== id) throw new Error('Sandbox không trả về dữ liệu sản phẩm (SanPhamInit).');
    return p;
  }
  function buildSaveBody(p) {
    // Sản phẩm có biến thể con / thành phần: form xử lý thêm các danh sách này → không tự gửi để tránh ghi sai
    if ((p.listSanPhamThuocTinh || []).length || p.isSanPhamCauThanh)
      throw new Error('Sản phẩm có thuộc tính con hoặc là sản phẩm cấu thành — chưa hỗ trợ tự đổi tên, hãy đổi tay trên Sandbox.');
    const b = { ...p };
    for (const k of ['idNganhNghe', 'isHienThiDatLich', 'listIdChiNhanh', 'listSanPhamImei']) delete b[k];
    b.listIdNhanSanPham = p.listIdNhanSanPham ?? null;
    b.listIdNhanSanPhamFE = p.listIdNhanSanPham ? String(p.listIdNhanSanPham).split(',').map(s => s.trim()).filter(Boolean) : [];
    b.listSanPhamThuocTinh = [];
    b.ListIdChiNhanh = p.listIdChiNhanh || [];
    b.ListSanPhamCauThanh = [];
    return b;
  }
  // Lưu sản phẩm với tên ten (ten === undefined: giữ nguyên tên). Sau khi lưu đọc lại: mọi trường khác
  // phải giữ nguyên, không thì ghi lại dữ liệu cũ và báo lỗi.
  async function pushNameApi(rule, ten) {
    const { id } = await findProduct(rule.maSP);
    const before = await productInit(id);
    const body = buildSaveBody(before);
    if (ten !== undefined) body.tenXuatHoaDon = ten;
    await sbPost('CapNhatThongTin', body);
    const after = await productInit(id);
    const skip = new Set(['tenXuatHoaDon', 'ngayCapNhat', 'nguoiCapNhat', 'nguoiCapNhatUserName']);
    const changed = Object.keys(before).filter(k => !skip.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changed.length) {
      try { await sbPost('CapNhatThongTin', buildSaveBody(before)); } catch {}
      throw new Error(`Sandbox đổi thêm trường ngoài tên xuất HĐ (${changed.join(', ')}) — đã thử ghi lại dữ liệu cũ, kiểm tra sản phẩm trên Sandbox.`);
    }
    const want = ten === undefined ? before.tenXuatHoaDon : ten;
    if (String(after.tenXuatHoaDon ?? '').trim() !== String(want ?? '').trim())
      throw new Error(`Đã gửi nhưng Sandbox vẫn ghi tên "${after.tenXuatHoaDon}".`);
    return { before: before.tenXuatHoaDon ?? '', after: after.tenXuatHoaDon ?? '' };
  }

  /* ---------- Số lượng đã xuất hoá đơn dưới tên đang dùng (hoá đơn điện tử Sandbox) ----------
     HĐ: POST invoice/api/Invoice/TimHoaDonDienTuTheoDieuKien (phiên web máy chủ) → maDonHang, idDonHang,
     actionCode (1 = phát hành), ngayTao (giờ VN). HĐ không có dòng hàng nên lấy dòng hàng của đơn theo mã
     đơn (orderlogistic GetChiTietDonByMa, cùng phiên web), lưu cache theo mã đơn.
     Chỉ đếm HĐ phát hành (actionCode 1) — HĐ thay thế/điều chỉnh/huỷ không trừ lại. */
  const INV_SEARCH = 'https://api.sandbox.com.vn/invoice/api/Invoice/TimHoaDonDienTuTheoDieuKien';
  const hdOn = rule => apiMode(rule);
  const vnDay = t => new Date(Date.parse(t) + 7 * 3600e3).toISOString().slice(0, 10);
  const dayOfCode = code => { const m = /^[A-Z]+(\d{2})(\d{2})(\d{2})/.exec(String(code || '')); return m ? `20${m[1]}-${m[2]}-${m[3]}` : ''; };

  async function invoicesSince(sinceISO) {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const j = await sbPost(INV_SEARCH, { pageInfo: { page, pageSize: 100 }, sorts: [], keyword: null, actionType: null, typeDonHang: null,
        typeInvoice: null, trangThaiGuiSMS: null, trangThaiGuiZNS: null, idDonHang: null,
        tuNgay: `${vnDay(sinceISO)}T00:00:00`, denNgay: `${vnDay(new Date().toISOString())}T23:59:59`, status_Nhap: null, isNhap: null });
      const data = Array.isArray(j?.data) ? j.data : [];
      out.push(...data);
      if (!data.length || out.length >= Number(j.totalRecord || 0)) break;
    }
    const since = Date.parse(sinceISO);
    const seen = new Set();
    return out.filter(h => {
      if (h.isDelete || Number(h.actionCode) !== 1) return false;
      if (Date.parse(String(h.ngayTao).slice(0, 23) + '+07:00') < since) return false;
      const k = h.maDonHang || h.idDonHang;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  // Dòng sản phẩm của một đơn: web API của Sandbox (phiên máy chủ), giống nút xem đơn theo mã trên web.
  // (API đối tác GetOrderByConditions lọc theo ngày data về, không tìm được đơn theo mã, và bị giới hạn
  //  ~1 lần gọi / 30–60 giây nên không dùng.) Chưa chắc tên trường dòng hàng → nhận mọi mảng object có
  //  số lượng + mã/tên/id sản phẩm: [mã, SL, tên, idSanPham].
  const ORDER_BY_CODE = 'https://api.sandbox.com.vn/orderlogistic/api/DonHangLogistic/GetChiTietDonByMa';
  const QTY_KEYS = ['soLuong', 'quantity', 'soLuongSanPham', 'sl', 'soLuongBan'];
  const pickStr = (o, ks) => { for (const k of ks) if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim(); return ''; };
  function linesOf(data) {
    // Đã xác nhận với đơn thật (12/10/2026): dòng hàng ở donHangLogisticSanPhamDtos (maSanPham, soLuong,
    // tenSanPham, idSanPham). Chỉ đọc mảng này khi có, để không đếm đôi với sanPhamLogisticDtos.
    // Combo (donHangLogisticComboDtos): soLuong = số combo; sản phẩm trong combo ở comBoSpaKhachHangChiTietDtos,
    // soLan = số lượng sản phẩm đó trong 1 combo (form Sandbox gán soLuong = soLan) → SL = số combo × soLan.
    if (Array.isArray(data?.donHangLogisticSanPhamDtos)) {
      // [mã, SL, tên, idSanPham, tên combo, idSanPhamCha]. idSanPham ở đơn là id con (khác id sản phẩm gốc),
      // idSanPhamCha mới là id sản phẩm gốc.
      const lines = data.donHangLogisticSanPhamDtos.map(x => [String(x.maSanPham || '').trim(), num(x.soLuong),
        String(x.tenSanPham || '').trim(), String(x.idSanPham || ''), '', String(x.idSanPhamCha || '')]);
      for (const cb of data.donHangLogisticComboDtos || []) {
        const n = num(cb.soLuong);
        for (const x of cb.comBoSpaKhachHangChiTietDtos || cb.comboLogisticChiTietDtos || []) {
          const per = typeof x.soLan === 'number' ? x.soLan : num(x.soLuong);
          // Dòng trong combo (đơn thật 12/10/2026): không có mã SP, chỉ có ten + idSanPham (id con)
          lines.push([pickStr(x, ['maSanPham', 'maSp', 'ma']), n * per, pickStr(x, ['tenSanPham', 'tenSp', 'ten']),
            pickStr(x, ['idSanPham']), cb.tenComboSpa || 'combo', pickStr(x, ['idSanPhamCha'])]);
        }
      }
      return lines;
    }
    const lines = [];
    const walk = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 4) return;
      if (Array.isArray(v)) {
        for (const x of v) {
          if (x && typeof x === 'object' && !Array.isArray(x)) {
            const qk = QTY_KEYS.find(k => typeof x[k] === 'number');
            const code = pickStr(x, ['maSanPham', 'maSp', 'maSP', 'itemCode', 'ma', 'code']);
            const name = pickStr(x, ['tenSanPham', 'tenSp', 'tenSP', 'itemName', 'ten', 'name']);
            const idsp = pickStr(x, ['idSanPham', 'idSanPhamCha', 'productId', 'itemId']);
            if (qk && (code || name || idsp)) lines.push([code, num(x[qk]), name, idsp]);
          }
          walk(x, depth + 1);
        }
        return;
      }
      for (const x of Object.values(v)) if (x && typeof x === 'object') walk(x, depth + 1);
    };
    walk(data, 0);
    return lines;
  }
  // id sản phẩm dùng trong đơn hàng. Sản phẩm có thuộc tính: TimTheoDieuKienSPCha trả id "cha", còn đơn
  // (kể cả dòng trong combo, vốn không có mã SP) dùng id do SanPham/TimTheoDieuKien trả về. Đã đối chiếu
  // 12/10/2026: máy đo cha a0bf1fa0… / trong đơn b182e29b…; gel cha 567a4a7a… / trong combo 7df0d80b….
  // TimTheoDieuKien bắt buộc truyền nhóm sản phẩm và tìm theo tên (gõ mã không ra) → tìm theo tên, lọc đúng mã.
  async function branchProductIds(r) {
    const g = await sbPost('https://api.sandbox.com.vn/warehouse/api/DMNhomSanPham/LayTatCaKemSoLuong?xemTatCaChiNhanh=true');
    const groups = (Array.isArray(g?.data) ? g.data : []).map(x => x.id).filter(Boolean);
    const ten = r.tenSP || (await findProduct(r.maSP)).tenSp;
    const j = await sbPost('TimTheoDieuKien', { pageInfo: { page: 1, pageSize: 50 }, sorts: [], keyword: ten, ListIdNhomSanPham: groups,
      ListIdNhanSanPham: null, ListIdDmThuongHieu: null, ListIdDmXuatXu: null, ListIdDmMauSac: null, Model: null,
      ListIdNhaCungCap: null, SuDung: null, XemTatCaChiNhanh: true });
    const ma = String(r.maSP).trim().toLowerCase();
    return (Array.isArray(j?.data) ? j.data : []).filter(x => String(x.ma || '').trim().toLowerCase() === ma && x.id).map(x => x.id);
  }

  // Dòng hàng của các đơn: cache = STORE.orders (mã đơn → dòng hàng). Trả về { itemsOf, fetched } — fetched là
  // các đơn vừa đọc, để commit gộp vào file.
  async function orderItems(invoices) {
    // Cache cũ (lấy từ API đối tác) có thể sai khoá → bỏ khi đổi sang API web
    const cache = STORE.ordersV === 2 ? { ...(STORE.orders || {}) } : {};
    const fetched = {};
    const key = h => h.maDonHang || h.idDonHang;
    const need = [...new Set(invoices.filter(h => h.maDonHang && !cache[key(h)]).map(key))];
    // Gọi 4 đơn song song; đơn lỗi thì để lần sau
    for (let i = 0; i < need.length; i += 4) {
      await Promise.all(need.slice(i, i + 4).map(async ma => {
        try { const j = await sbPost(ORDER_BY_CODE, { MaDon: ma }); if (j?.data) cache[ma] = fetched[ma] = linesOf(j.data); }
        catch (e) { console.warn('[TENHD] đọc đơn', ma, e.message); }
      }));
    }
    return { itemsOf: h => cache[key(h)] || null, cache, fetched };
  }
  function mergeOrders(s, fetched) {
    if (s.ordersV !== 2) { s.orders = {}; s.ordersV = 2; delete s.orderDays; }
    s.orders = { ...(s.orders || {}), ...fetched };
    // Bỏ cache đơn cũ hơn 120 ngày
    const cut = new Date(Date.now() - 120 * 86400e3).toISOString().slice(0, 10);
    for (const k of Object.keys(s.orders)) { const d = dayOfCode(k); if (d && d < cut) delete s.orders[k]; }
  }

  // Cập nhật entry.hd = { qty, soHD, thieu, from, at, err } cho tên đang dùng của các sản phẩm có mã SP.
  // Làm trên bản sao, xong mới commit theo id sản phẩm (chỉ khi tên đang dùng vẫn như lúc bắt đầu đếm).
  async function refreshInvoiced() {
    reload();
    const rules = JSON.parse(JSON.stringify(STORE.rules.filter(r => hdOn(r) && r.queue?.length)));
    if (!rules.length) return;
    for (const r of rules) {
      const q = r.queue[r.activeIdx || 0]; if (!q.activatedAt) q.activatedAt = new Date().toISOString();
      if (!r.sbId) try { r.sbId = (await findProduct(r.maSP)).id; } catch {} // id sản phẩm để khớp dòng hàng
      // id sản phẩm dùng trong đơn (dòng combo chỉ có id này), tra lại mỗi 6 giờ hoặc khi chưa có
      if (r.sbId && (!r.sbBranchIds?.length || !r.sbBranchAt || Date.now() - Date.parse(r.sbBranchAt) > 6 * 3600e3))
        try { r.sbBranchIds = await branchProductIds(r); r.sbBranchAt = new Date().toISOString(); } catch (e) { console.warn('[TENHD] SP chi nhánh', e.message); }
    }
    // Ghi kết quả của từng sản phẩm vào file mới nhất
    const apply = fetched => commit(s => {
      if (fetched) mergeOrders(s, fetched);
      for (const r of rules) {
        const t = findIn(s, r.id); if (!t?.queue?.length) continue;
        const q = r.queue[r.activeIdx || 0], tq = t.queue[t.activeIdx || 0];
        Object.assign(t, { sbId: r.sbId, sbBranchIds: r.sbBranchIds, sbBranchAt: r.sbBranchAt, sbIds: r.sbIds });
        if (!tq || tq.ten !== q.ten) continue; // tên đang dùng đã đổi trong lúc đếm → bỏ kết quả cũ
        if (!tq.activatedAt) tq.activatedAt = q.activatedAt;
        tq.hd = q.hd;
      }
    });
    const from = rules.map(r => r.queue[r.activeIdx || 0].activatedAt).sort()[0];
    let invs, itemsOf, cache, fetched;
    try { invs = await invoicesSince(from); ({ itemsOf, cache, fetched } = await orderItems(invs)); }
    catch (e) {
      for (const r of rules) { const q = r.queue[r.activeIdx || 0]; q.hd = { ...(q.hd || { qty: null }), err: e.message, at: new Date().toISOString() }; }
      apply(null); return;
    }
    for (const r of rules) {
      const q = r.queue[r.activeIdx || 0], since = Date.parse(q.activatedAt), ma = String(r.maSP).trim().toLowerCase();
      const tenSP = normName(r.tenSP);
      // Dòng hàng của SP này: đúng mã SP, id gốc (idSanPhamCha / id), id con đã học, hoặc đúng tên sản phẩm gốc.
      // Dòng trong combo không có mã SP → nhận qua id con, học từ các dòng bán lẻ đã khớp mã SP / id gốc.
      const direct = ([c, , , idsp, , idCha]) => String(c).toLowerCase() === ma
        || (!!r.sbId && (idCha === r.sbId || idsp === r.sbId));
      const ids = new Set([...(r.sbIds || []), ...(r.sbBranchIds || [])]);
      for (const items of Object.values(cache)) for (const l of items || []) if (l[3] && direct(l)) ids.add(l[3]);
      r.sbIds = [...ids].filter(x => !(r.sbBranchIds || []).includes(x)).slice(0, 50);
      const isMine = l => direct(l) || (!!l[3] && ids.has(l[3])) || (!!l[2] && normName(l[2]) === tenSP);
      let qty = 0, soHD = 0, thieu = 0;
      const don = [], thieuDon = [];
      for (const h of invs) {
        if (Date.parse(String(h.ngayTao).slice(0, 23) + '+07:00') < since) continue;
        const items = itemsOf(h);
        if (!items) { thieu++; if (thieuDon.length < 10) thieuDon.push(h.maDonHang || (h.invNo ? `HĐ số ${h.invNo} (không có mã đơn)` : '(không có mã đơn)')); continue; }
        const n = items.filter(isMine).reduce((s, [, x]) => s + x, 0);
        if (n) { qty += n; soHD++; if (don.length < 30) don.push({ ma: h.maDonHang, sl: n }); }
      }
      q.hd = { qty, soHD, thieu, don, thieuDon, from: q.activatedAt, at: new Date().toISOString(), err: '' };
    }
    apply(fetched);
  }

  async function pushName(rule, ten) {
    if (apiMode(rule)) return pushNameApi(rule, ten);
    if (!rule.save) throw new Error('Chưa nhập mã sản phẩm Sandbox (hoặc dán request Lưu sản phẩm).');
    if (!rule.save.field) throw new Error('Chưa chọn trường "Tên xuất hoá đơn" trong request.');
    const body = await latestBody(rule);
    setPath(body, rule.save.field, ten);
    await sandboxFetch(rule.save, body);
    // Kiểm tra lại nếu có request chi tiết
    if (rule.detail) {
      const fresh = pickProduct(await sandboxFetch(rule.detail, rule.detail.body), rule.save.wrapKey ? body[rule.save.wrapKey] : body);
      const fld = rule.save.wrapKey ? rule.save.field.slice(rule.save.wrapKey.length + 1) : rule.save.field;
      const got = getPath(fresh, fld);
      if (got !== undefined && String(got).trim() !== String(ten).trim())
        throw new Error(`Đã gửi nhưng Sandbox vẫn ghi tên "${got}".`);
    }
  }

  function addHistory(rule, h) {
    rule.history = [{ at: new Date().toISOString(), ...h }, ...(rule.history || [])].slice(0, MAX_HISTORY);
  }

  // Kích hoạt tên thứ idx: đẩy sang Sandbox rồi mới ghi nhận (đẩy lỗi thì giữ tên cũ)
  async function activate(ruleId, idx, by, reason) {
    reload();
    const rule0 = findRule(ruleId);
    const ten = rule0?.queue?.[idx]?.ten;
    if (!ten) throw new Error('Không tìm thấy sản phẩm hoặc tên xuất hoá đơn.');
    await pushName(rule0, ten);
    const { m } = stockMap();
    commit(s => {
      const rule = findIn(s, ruleId); if (!rule) return;
      const i = rule.queue.findIndex(x => x.ten === ten); if (i < 0) return;
      const q = rule.queue[i];
      const from = rule.queue[rule.activeIdx || 0]?.ten || '';
      // Tên cũ nhập tay: chốt lại số còn thực tế, để lần sau quay lại không tính lại từ đầu
      const prev = rule.queue[rule.activeIdx || 0];
      if (prev && prev !== q && isSet(prev.soLuong)) {
        const rem = remainingOf(prev, m, true).remaining;
        if (rem !== null) prev.soLuong = Math.max(0, rem);
        prev.baseline = null;
      }
      if (prev && prev !== q) delete prev.hd;
      // Tên mới: đếm hoá đơn từ lúc này
      if (hdOn(rule)) q.hd = { qty: 0, soHD: 0, thieu: 0, from: new Date().toISOString(), at: new Date().toISOString(), err: '' };
      q.baseline = q.misaKey && m.has(q.misaKey) ? m.get(q.misaKey) : null;
      q.activatedAt = new Date().toISOString();
      rule.activeIdx = i;
      rule.lastError = ''; rule.errorAlertAt = ''; rule.hetAlertAt = '';
      addHistory(rule, { from, to: q.ten, by, reason, ok: true });
    });
  }

  /* ---------- Kiểm tra tự động sau mỗi lần cập nhật tồn ---------- */
  let checking = null;
  function checkAll() {
    if (checking) return checking;
    checking = (async () => {
      await refreshInvoiced().catch(e => console.warn('[TENHD] đếm hoá đơn lỗi:', e.message));
      const { m } = stockMap();
      reload();
      for (const id of STORE.rules.map(r => r.id)) {
        reload(); // mỗi sản phẩm đọc lại file: tiến trình khác có thể vừa sửa / xoá
        const rule = findRule(id);
        if (!rule || !rule.auto || !rule.queue?.length) continue;
        const d = decide(rule, m);
        const patch = fn => commit(s => { const t = findIn(s, id); if (t) fn(t); });
        if (d.action === 'doi') {
          const cur = rule.queue[rule.activeIdx || 0], nxt = rule.queue[d.next];
          const curRem = remainingOf(cur, m, true), curSL = num(cur.soLuong); // activate() sẽ sửa cur.soLuong
          try {
            await activate(id, d.next, 'tự động', `"${cur.ten}" hết số lượng được xuất`);
            await notify(`🧾 Sản phẩm <b>${tgEsc(rule.tenSP)}</b>: xuất hoá đơn dưới tên "<b>${tgEsc(cur.ten)}</b>" `
              + `${curRem.remaining > 0 ? `còn ${curRem.remaining}` : curRem.remaining < 0 ? `đã xuất vượt ${-curRem.remaining}` : 'về 0'}, đã tự chuyển tên xuất hoá đơn sang "<b>${tgEsc(nxt.ten)}</b>".`
              + (curRem.source === 'hd' ? `\n(Đã xuất HĐ dưới tên "${tgEsc(cur.ten)}": ${curRem.used}/${curSL})` : ''));
          } catch (e) {
            // Báo lỗi tối đa 6 giờ/lần để không spam nhóm
            let alerted = false;
            if (!rule.errorAlertAt || Date.now() - Date.parse(rule.errorAlertAt) > 6 * 3600e3) {
              const r = await notify(`⚠️ <b>Không đổi được tên xuất hoá đơn</b>\nSản phẩm: <b>${tgEsc(rule.tenSP)}</b>\n`
                + `"${tgEsc(cur.ten)}" đã hết nhưng chưa đổi được sang "${tgEsc(nxt.ten)}": ${tgEsc(e.message)}\nVào trang Tên xuất hoá đơn để xử lý.`);
              alerted = !!(r && r.ok);
            }
            patch(t => {
              // Cùng một lỗi lặp lại mỗi lần đồng bộ thì chỉ ghi lịch sử 1 lần
              if (t.lastError !== e.message) addHistory(t, { from: cur.ten, to: nxt.ten, by: 'tự động', ok: false, message: e.message });
              t.lastError = e.message; t.lastErrorAt = new Date().toISOString();
              if (alerted) t.errorAlertAt = new Date().toISOString();
            });
          }
        } else if (d.action === 'het' && !rule.hetAlertAt) {
          const r = await notify(`⛔ <b>Hết tên xuất hoá đơn</b>\nSản phẩm: <b>${tgEsc(rule.tenSP)}</b>: mọi tên trong danh sách đều đã hết số lượng được xuất. Cần nhập thêm hàng hoặc thêm tên mới.`);
          if (r && r.ok) patch(t => { t.hetAlertAt = new Date().toISOString(); });
        } else if (d.action === 'giu' && rule.hetAlertAt) patch(t => { t.hetAlertAt = ''; });
      }
    })().catch(e => console.warn('[TENHD] kiểm tra lỗi:', e.message)).finally(() => { checking = null; });
    return checking;
  }

  /* ---------- Dữ liệu trả về trình duyệt (không có header/cookie) ---------- */
  function view(rule, m) {
    const d = decide(rule, m);
    return {
      id: rule.id, tenSP: rule.tenSP, maSP: rule.maSP || '', apiMode: apiMode(rule), auto: !!rule.auto, buffer: num(rule.buffer), activeIdx: rule.activeIdx || 0,
      queue: rule.queue.map((q, i) => ({ ten: q.ten, misaKey: q.misaKey || '', soLuong: isSet(q.soLuong) ? num(q.soLuong) : null,
        activatedAt: i === (rule.activeIdx || 0) ? q.activatedAt || '' : '', hd: i === (rule.activeIdx || 0) ? q.hd || null : null,
        ...remainingOf(q, m, i === (rule.activeIdx || 0)) })),
      hdOn: hdOn(rule),
      decision: d.action,
      save: rule.save ? { url: rule.save.url, method: rule.save.method, field: rule.save.field, fields: rule.save.fields || [],
        currentValue: rule.save.field ? getPath(rule.save.body, rule.save.field) ?? '' : '', savedAt: rule.save.savedAt } : null,
      detail: rule.detail ? { url: rule.detail.url, savedAt: rule.detail.savedAt } : null,
      lastError: rule.lastError || '', lastErrorAt: rule.lastErrorAt || '',
      history: (rule.history || []).slice(0, 30),
    };
  }

  /* ---------- ROUTES (chỉ admin, nằm dưới /api/ton-kho nên đã có chặn quyền ở server.js) ---------- */
  app.get('/api/ton-kho/hd', guard, (req, res) => {
    reload();
    const { m, info } = stockMap();
    res.json({
      ok: true, rules: STORE.rules.map(r => view(r, m)),
      misaItems: [...info.values()].map(x => ({ ...x, qty: m.get(x.key) })).sort((a, b) => a.name.localeCompare(b.name, 'vi')),
      sandboxLogin: !!global.__sandboxAuth?.hasLogin(),
    });
  });

  // Tạo / sửa: { id?, tenSP, maSP, auto, buffer, queue:[{ten, misaKey, soLuong}] }
  app.post('/api/ton-kho/hd/save', guard, json, wrap(async (req, res) => {
    const b = req.body || {};
    const maSP = String(b.maSP || '').trim().slice(0, 100);
    let tenSP = String(b.tenSP || '').trim().slice(0, 300);
    // Có mã SP → lấy tên sản phẩm gốc và tên xuất HĐ hiện tại từ Sandbox
    let sb = null;
    if (maSP && global.__sandboxAuth?.hasLogin()) {
      try { sb = await findProduct(maSP); tenSP = String(sb.tenSp || tenSP).slice(0, 300); }
      catch (e) { return res.json({ ok: false, message: e.message }); }
    }
    if (!tenSP) return res.json({ ok: false, message: 'Nhập mã hoặc tên sản phẩm trên Sandbox.' });
    const queueIn = Array.isArray(b.queue) ? b.queue.slice(0, 50) : [];
    const queue = queueIn.map(q => ({ ten: String(q.ten || '').trim().slice(0, 300), misaKey: String(q.misaKey || '').slice(0, 300),
      soLuong: isSet(q.soLuong) ? Math.max(0, num(q.soLuong)) : null })).filter(q => q.ten);
    if (!queue.length) return res.json({ ok: false, message: 'Cần ít nhất một tên xuất hoá đơn.' });
    if (new Set(queue.map(q => normName(q.ten))).size !== queue.length) return res.json({ ok: false, message: 'Có tên xuất hoá đơn bị trùng.' });

    const { m } = stockMap();
    const rule = commit(s => {
      let rule = b.id ? findIn(s, b.id) : null;
      if (b.id && !rule) return null;
      if (!rule) {
        rule = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), queue: [], activeIdx: 0, history: [] };
        s.rules.push(rule);
      }
      // Giữ mốc (tồn MISA lúc lưu) của các tên cũ; tên nào đổi số lượng tay thì lấy lại mốc từ bây giờ
      const old = new Map(rule.queue.map(q => [normName(q.ten), q]));
      const activeTen = normName(rule.queue[rule.activeIdx || 0]?.ten || '');
      rule.queue = queue.map(q => {
        const o = old.get(normName(q.ten));
        const changed = !o || o.soLuong !== q.soLuong || o.misaKey !== q.misaKey;
        return { ...q, baseline: changed ? (q.misaKey && m.has(q.misaKey) ? m.get(q.misaKey) : null) : o.baseline,
          activatedAt: o?.activatedAt || '', ...(o?.hd ? { hd: o.hd } : {}) };
      });
      const ai = rule.queue.findIndex(q => normName(q.ten) === activeTen);
      rule.activeIdx = ai >= 0 ? ai : 0;
      rule.tenSP = tenSP;
      rule.maSP = maSP;
      rule.auto = b.auto !== false;
      rule.buffer = Math.max(0, num(b.buffer));
      return rule;
    });
    if (!rule) return res.json({ ok: false, message: 'Không tìm thấy sản phẩm.' });
    checkAll();
    const active = rule.queue[rule.activeIdx].ten;
    res.json({ ok: true, id: rule.id, warning: sb && normName(sb.tenXuatHoaDon) !== normName(active)
      ? `Tên xuất HĐ trên Sandbox đang là "${sb.tenXuatHoaDon || '(trống)'}", khác tên đang dùng "${active}".` : '' });
  }));

  app.post('/api/ton-kho/hd/delete', guard, json, (req, res) => {
    commit(s => { s.rules = s.rules.filter(r => r.id !== req.body?.id); });
    res.json({ ok: true });
  });

  // Dán request Sandbox: { id, kind: 'save'|'detail', raw }  — hoặc chọn trường: { id, field }
  app.post('/api/ton-kho/hd/request', guard, json, (req, res) => res.json(commit(s => {
    const rule = findIn(s, req.body?.id);
    if (!rule) return { ok: false, message: 'Không tìm thấy sản phẩm.' };
    const { kind, raw, field } = req.body;
    if (field !== undefined && !raw) {
      if (!rule.save) return { ok: false, message: 'Chưa dán request Lưu.' };
      if (getPath(rule.save.body, field) === undefined) return { ok: false, message: `Không có trường "${field}" trong request.` };
      rule.save.field = String(field);
      rule.save.wrapKey = rule.save.field.includes('.') ? rule.save.field.split('.')[0] : '';
      return { ok: true };
    }
    let r;
    try { r = parseSandboxRequest(raw, kind === 'detail' ? 'detail' : 'save'); }
    catch (e) { return { ok: false, message: e.message }; }
    r.savedAt = new Date().toISOString();
    if (kind === 'detail') { rule.detail = r; return { ok: true }; }
    r.fields = findInvoiceFields(r.body).map(f => f.path);
    r.field = r.fields[0] || '';
    r.wrapKey = r.field.includes('.') ? r.field.split('.')[0] : '';
    rule.save = r;
    return { ok: true, fields: r.fields, field: r.field,
      message: r.field ? '' : 'Không tự tìm thấy trường tên xuất hoá đơn — hãy nhập tên trường.' };
  })));

  app.post('/api/ton-kho/hd/request/delete', guard, json, (req, res) => res.json(commit(s => {
    const rule = findIn(s, req.body?.id);
    if (!rule) return { ok: false, message: 'Không tìm thấy sản phẩm.' };
    if (req.body.kind === 'detail') rule.detail = null; else rule.save = null;
    return { ok: true };
  })));

  // Đổi tay sang tên thứ idx (đẩy sang Sandbox ngay)
  app.post('/api/ton-kho/hd/activate', guard, json, wrap(async (req, res) => {
    reload();
    const rule = findRule(req.body?.id);
    const idx = Number(req.body?.idx);
    if (!rule || !(idx >= 0 && idx < rule.queue.length)) return res.json({ ok: false, message: 'Dữ liệu không hợp lệ.' });
    try { await activate(rule.id, idx, req.session?.user?.user || 'admin', 'đổi tay'); }
    catch (e) {
      commit(s => { const t = findIn(s, rule.id); if (t) addHistory(t, { from: rule.queue[rule.activeIdx || 0]?.ten, to: rule.queue[idx].ten, by: req.session?.user?.user, ok: false, message: e.message }); });
      return res.json({ ok: false, message: e.message });
    }
    res.json({ ok: true });
  }));

  // Chẩn đoán đếm hoá đơn cho một đơn (chỉ đọc): /api/ton-kho/hd/debug-don?ma=DHLOG…
  // Cho biết hoá đơn của đơn, đơn tìm được qua API đối tác (chỉ các trường mã), dòng hàng, và có khớp mã SP không.
  app.get('/api/ton-kho/hd/debug-don', guard, wrap(async (req, res) => {
    const ma = String(req.query.ma || '').trim();
    if (!ma) return res.json({ ok: false, message: 'Thêm ?ma=<mã đơn DHLOG…>' });
    reload();
    const out = { ma, ngayTrongMa: dayOfCode(ma) };
    try {
      const today = new Date().toISOString();
      const j = await sbPost(INV_SEARCH, { pageInfo: { page: 1, pageSize: 20 }, sorts: [], keyword: ma, actionType: null, typeDonHang: null,
        typeInvoice: null, trangThaiGuiSMS: null, trangThaiGuiZNS: null, idDonHang: null,
        tuNgay: `${vnDay(new Date(Date.now() - 90 * 86400e3).toISOString())}T00:00:00`, denNgay: `${vnDay(today)}T23:59:59`, status_Nhap: null, isNhap: null });
      out.hoaDon = (j?.data || []).map(h => ({ maDonHang: h.maDonHang, idDonHang: h.idDonHang, actionCode: h.actionCode, isDelete: h.isDelete,
        ngayTao: h.ngayTao, invNo: h.invNo, tongSoLuongSanPham: h.tongSoLuongSanPham }));
    } catch (e) { out.loiHoaDon = e.message; }
    out.trongCache = STORE.orders?.[ma] || null;
    // &sp=<mã SP>: id gốc + id theo chi nhánh của một sản phẩm (kể cả SP chưa có trên trang) để so với idSanPham trong đơn
    if (req.query.sp) try {
      const p = await findProduct(String(req.query.sp));
      out.thuSP = { ma: p.ma, ten: p.tenSp, id: p.id, idTrongDon: await branchProductIds({ sbId: p.id, maSP: p.ma, tenSP: p.tenSp }) };
    } catch (e) { out.thuSP = { loi: e.message }; }
    try {
      const j = await sbPost(ORDER_BY_CODE, { MaDon: ma });
      const d = j?.data;
      // Chỉ trả tên trường (không trả giá trị) để không lộ thông tin khách; dòng hàng thì trả mã/SL/tên SP
      const arrays = [];
      const walk = (v, p, depth) => {
        if (!v || typeof v !== 'object' || depth > 4) return;
        if (Array.isArray(v)) { if (v[0] && typeof v[0] === 'object') arrays.push({ path: p, len: v.length, keys: Object.keys(v[0]) }); v.forEach(x => walk(x, p + '[]', depth + 1)); return; }
        for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k, depth + 1);
      };
      walk(d, '', 0);
      out.donWeb = d ? { truong: Object.keys(d), mang: arrays,
        combo: (d.donHangLogisticComboDtos || []).map(cb => ({ ten: cb.tenComboSpa, soLuong: cb.soLuong,
          sanPham: (cb.comBoSpaKhachHangChiTietDtos || cb.comboLogisticChiTietDtos || []).map(x => ({ truong: Object.keys(x), ma: x.maSanPham, ten: x.tenSanPham, soLan: x.soLan, soLuong: x.soLuong })) })),
        dongHang: linesOf(d).map(([c, sl, ten, idsp, combo, idCha]) => ({ ma: c, sl, ten, idSanPham: idsp, idSanPhamCha: idCha,
          ...(combo ? { combo } : {}),
          // Sản phẩm trên trang nhận dòng này (theo mã, id gốc, id con đã học)
          khopVoi: STORE.rules.filter(r => (c && c.toLowerCase() === String(r.maSP).toLowerCase())
            || (r.sbId && (idCha === r.sbId || idsp === r.sbId)) || (idsp && [...(r.sbIds || []), ...(r.sbBranchIds || [])].includes(idsp))).map(r => r.tenSP) })) } : null;
    } catch (e) { out.loiDon = e.message; }
    out.sanPham = STORE.rules.map(r => ({ tenSP: r.tenSP, maSP: r.maSP, dangDung: r.queue[r.activeIdx || 0]?.ten,
      sbId: r.sbId, idTrongDon: r.sbBranchIds, idConDaHoc: r.sbIds, batDauDem: r.queue[r.activeIdx || 0]?.activatedAt, hd: r.queue[r.activeIdx || 0]?.hd }));
    res.json({ ok: true, ...out });
  }));

  // Tìm sản phẩm trên Sandbox theo tên hoặc mã (chỉ đọc) — gợi ý cho ô tên sản phẩm
  app.post('/api/ton-kho/hd/search', guard, json, wrap(async (req, res) => {
    const q = String(req.body?.q || '').trim().slice(0, 200);
    if (q.length < 2) return res.json({ ok: true, items: [] });
    if (!global.__sandboxAuth?.hasLogin()) return res.json({ ok: false, message: 'Máy chủ chưa có tài khoản Sandbox.' });
    try {
      const items = (await searchProducts(q)).map(p => ({ ma: p.ma, tenSP: p.tenSp, tenXuatHoaDon: p.tenXuatHoaDon || '' }));
      res.json({ ok: true, items });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  }));

  // Xem sản phẩm trên Sandbox theo mã (chỉ đọc): kiểm tra mã đúng và tên xuất HĐ đang ghi
  app.post('/api/ton-kho/hd/lookup', guard, json, wrap(async (req, res) => {
    const ma = String(req.body?.maSP || '').trim();
    if (!ma) return res.json({ ok: false, message: 'Nhập mã sản phẩm Sandbox.' });
    if (!global.__sandboxAuth?.hasLogin()) return res.json({ ok: false, message: 'Máy chủ chưa có tài khoản Sandbox (SANDBOX_WEB_USER/PASS).' });
    try {
      const p = await findProduct(ma);
      res.json({ ok: true, ma: p.ma, tenSP: p.tenSp, tenXuatHoaDon: p.tenXuatHoaDon || '', giaBan: p.giaBan });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  }));

  // Gửi thử: gửi lại dữ liệu sản phẩm y nguyên (tên đang ghi trên Sandbox, không phải tên trong
  // hàng đợi) để kiểm tra request còn chạy mà không đổi gì
  app.post('/api/ton-kho/hd/test', guard, json, wrap(async (req, res) => {
    reload();
    const rule = findRule(req.body?.id);
    if (!rule) return res.json({ ok: false, message: 'Không tìm thấy sản phẩm.' });
    let ten;
    if (apiMode(rule)) {
      try { ten = (await pushNameApi(rule)).after; }
      catch (e) { return res.json({ ok: false, message: e.message }); }
    } else try {
      if (!rule.save?.field) return res.json({ ok: false, message: 'Chưa nhập mã sản phẩm Sandbox (hoặc dán request Lưu).' });
      const body = await latestBody(rule);
      ten = getPath(body, rule.save.field);
      await sandboxFetch(rule.save, body);
    } catch (e) { return res.json({ ok: false, message: e.message }); }
    commit(s => { const t = findIn(s, rule.id); if (t) t.lastError = ''; });
    const active = rule.queue[rule.activeIdx || 0]?.ten;
    res.json({ ok: true, ten, active,
      warning: active && normName(ten) !== normName(active)
        ? `Tên trên Sandbox ("${ten}") khác tên đang dùng trong danh sách ("${active}"). Chưa đổi gì — hãy sửa danh sách cho khớp.` : '' });
  }));

  app.post('/api/ton-kho/hd/check', guard, wrap(async (req, res) => {
    await checkAll();
    res.json({ ok: true });
  }));

  // Hoá đơn được phát hành suốt ngày (không theo lịch đồng bộ MISA) → tự đếm và kiểm tra mỗi 20 phút
  setInterval(() => { reload(); if (STORE.rules.some(hdOn)) checkAll(); }, 20 * 60e3).unref?.();

  return { checkAll };
}
