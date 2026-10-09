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
  let STORE = { rules: [] };
  try { STORE = { ...STORE, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  const save = () => {
    try { fs.writeFileSync(FILE, JSON.stringify(STORE, null, 1), { mode: 0o600 }); fs.chmodSync(FILE, 0o600); }
    catch (e) { console.error('[TENHD] lưu file lỗi:', e.message); }
  };
  const tgEsc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const findRule = id => STORE.rules.find(r => r.id === id);

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
    let r = await send();
    if ((r.status === 401 || r.status === 403) && auth && auth.hasLogin()) { await auth.login(); r = await send(); }
    const text = await r.text();
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
    return sandboxFetch({ url: SB_API + endpoint, method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*', origin, referer: origin + '/' } }, body);
  }
  async function findProduct(ma) {
    const j = await sbPost('TimTheoDieuKienSPCha', { pageInfo: { page: 1, pageSize: 20 }, sorts: [], keyword: ma, ListIdNhomSanPham: [],
      ListIdNhanSanPham: null, ListIdDmThuongHieu: null, ListIdDmXuatXu: null, ListIdDmMauSac: null, Model: null, ListIdNhaCungCap: null,
      SuDung: null, XemTatCaChiNhanh: true });
    const p = (Array.isArray(j?.data) ? j.data : []).find(x => String(x.ma).trim().toLowerCase() === String(ma).trim().toLowerCase());
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
  async function activate(rule, idx, by, reason) {
    const q = rule.queue[idx];
    const from = rule.queue[rule.activeIdx || 0]?.ten || '';
    await pushName(rule, q.ten);
    const { m } = stockMap();
    // Tên cũ nhập tay: chốt lại số còn thực tế, để lần sau quay lại không tính lại từ đầu
    const prev = rule.queue[rule.activeIdx || 0];
    if (prev && prev !== q && isSet(prev.soLuong)) {
      prev.soLuong = Math.max(0, remainingOf(prev, m, true).remaining);
      prev.baseline = null;
    }
    q.baseline = q.misaKey && m.has(q.misaKey) ? m.get(q.misaKey) : null;
    q.activatedAt = new Date().toISOString();
    rule.activeIdx = idx;
    rule.lastError = ''; rule.errorAlertAt = ''; rule.hetAlertAt = '';
    addHistory(rule, { from, to: q.ten, by, reason, ok: true });
    save();
  }

  /* ---------- Kiểm tra tự động sau mỗi lần cập nhật tồn ---------- */
  let checking = null;
  function checkAll() {
    if (checking) return checking;
    checking = (async () => {
      const { m } = stockMap();
      for (const rule of STORE.rules) {
        if (!rule.auto || !rule.queue?.length) continue;
        const d = decide(rule, m);
        if (d.action === 'doi') {
          const cur = rule.queue[rule.activeIdx || 0], nxt = rule.queue[d.next];
          try {
            await activate(rule, d.next, 'tự động', `"${cur.ten}" hết số lượng được xuất`);
            await notify(`🧾 <b>Đã đổi tên xuất hoá đơn</b>\nSản phẩm: <b>${tgEsc(rule.tenSP)}</b>\n`
              + `"${tgEsc(cur.ten)}" đã hết số lượng → nay xuất theo <b>${tgEsc(nxt.ten)}</b>.`);
          } catch (e) {
            // Cùng một lỗi lặp lại mỗi lần đồng bộ thì chỉ ghi lịch sử 1 lần
            if (rule.lastError !== e.message) addHistory(rule, { from: cur.ten, to: nxt.ten, by: 'tự động', ok: false, message: e.message });
            rule.lastError = e.message; rule.lastErrorAt = new Date().toISOString();
            // Báo lỗi tối đa 6 giờ/lần để không spam nhóm
            if (!rule.errorAlertAt || Date.now() - Date.parse(rule.errorAlertAt) > 6 * 3600e3) {
              const r = await notify(`⚠️ <b>Không đổi được tên xuất hoá đơn</b>\nSản phẩm: <b>${tgEsc(rule.tenSP)}</b>\n`
                + `"${tgEsc(cur.ten)}" đã hết nhưng chưa đổi được sang "${tgEsc(nxt.ten)}": ${tgEsc(e.message)}\nVào trang Tên xuất hoá đơn để xử lý.`);
              if (r && r.ok) rule.errorAlertAt = new Date().toISOString();
            }
            save();
          }
        } else if (d.action === 'het' && !rule.hetAlertAt) {
          const r = await notify(`⛔ <b>Hết tên xuất hoá đơn</b>\nSản phẩm: <b>${tgEsc(rule.tenSP)}</b>: mọi tên trong danh sách đều đã hết số lượng được xuất. Cần nhập thêm hàng hoặc thêm tên mới.`);
          if (r && r.ok) { rule.hetAlertAt = new Date().toISOString(); save(); }
        } else if (d.action === 'giu' && rule.hetAlertAt) { rule.hetAlertAt = ''; save(); }
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
        activatedAt: i === (rule.activeIdx || 0) ? q.activatedAt || '' : '', ...remainingOf(q, m, i === (rule.activeIdx || 0)) })),
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

    let rule = b.id ? findRule(b.id) : null;
    if (b.id && !rule) return res.json({ ok: false, message: 'Không tìm thấy sản phẩm.' });
    const { m } = stockMap();
    if (!rule) {
      rule = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), queue: [], activeIdx: 0, history: [] };
      STORE.rules.push(rule);
    }
    // Giữ mốc (tồn MISA lúc lưu) của các tên cũ; tên nào đổi số lượng tay thì lấy lại mốc từ bây giờ
    const old = new Map(rule.queue.map(q => [normName(q.ten), q]));
    const activeTen = normName(rule.queue[rule.activeIdx || 0]?.ten || '');
    rule.queue = queue.map(q => {
      const o = old.get(normName(q.ten));
      const changed = !o || o.soLuong !== q.soLuong || o.misaKey !== q.misaKey;
      return { ...q, baseline: changed ? (q.misaKey && m.has(q.misaKey) ? m.get(q.misaKey) : null) : o.baseline,
        activatedAt: o?.activatedAt || '' };
    });
    const ai = rule.queue.findIndex(q => normName(q.ten) === activeTen);
    rule.activeIdx = ai >= 0 ? ai : 0;
    rule.tenSP = tenSP;
    rule.maSP = maSP;
    rule.auto = b.auto !== false;
    rule.buffer = Math.max(0, num(b.buffer));
    save();
    checkAll();
    const active = rule.queue[rule.activeIdx].ten;
    res.json({ ok: true, id: rule.id, warning: sb && normName(sb.tenXuatHoaDon) !== normName(active)
      ? `Tên xuất HĐ trên Sandbox đang là "${sb.tenXuatHoaDon || '(trống)'}", khác tên đang dùng "${active}".` : '' });
  }));

  app.post('/api/ton-kho/hd/delete', guard, json, (req, res) => {
    STORE.rules = STORE.rules.filter(r => r.id !== req.body?.id);
    save();
    res.json({ ok: true });
  });

  // Dán request Sandbox: { id, kind: 'save'|'detail', raw }  — hoặc chọn trường: { id, field }
  app.post('/api/ton-kho/hd/request', guard, json, (req, res) => {
    const rule = findRule(req.body?.id);
    if (!rule) return res.json({ ok: false, message: 'Không tìm thấy sản phẩm.' });
    const { kind, raw, field } = req.body;
    if (field !== undefined && !raw) {
      if (!rule.save) return res.json({ ok: false, message: 'Chưa dán request Lưu.' });
      if (getPath(rule.save.body, field) === undefined) return res.json({ ok: false, message: `Không có trường "${field}" trong request.` });
      rule.save.field = String(field);
      rule.save.wrapKey = rule.save.field.includes('.') ? rule.save.field.split('.')[0] : '';
      save();
      return res.json({ ok: true });
    }
    let r;
    try { r = parseSandboxRequest(raw, kind === 'detail' ? 'detail' : 'save'); }
    catch (e) { return res.json({ ok: false, message: e.message }); }
    r.savedAt = new Date().toISOString();
    if (kind === 'detail') { rule.detail = r; save(); return res.json({ ok: true }); }
    r.fields = findInvoiceFields(r.body).map(f => f.path);
    r.field = r.fields[0] || '';
    r.wrapKey = r.field.includes('.') ? r.field.split('.')[0] : '';
    rule.save = r;
    save();
    res.json({ ok: true, fields: r.fields, field: r.field,
      message: r.field ? '' : 'Không tự tìm thấy trường tên xuất hoá đơn — hãy nhập tên trường.' });
  });

  app.post('/api/ton-kho/hd/request/delete', guard, json, (req, res) => {
    const rule = findRule(req.body?.id);
    if (!rule) return res.json({ ok: false, message: 'Không tìm thấy sản phẩm.' });
    if (req.body.kind === 'detail') rule.detail = null; else rule.save = null;
    save();
    res.json({ ok: true });
  });

  // Đổi tay sang tên thứ idx (đẩy sang Sandbox ngay)
  app.post('/api/ton-kho/hd/activate', guard, json, wrap(async (req, res) => {
    const rule = findRule(req.body?.id);
    const idx = Number(req.body?.idx);
    if (!rule || !(idx >= 0 && idx < rule.queue.length)) return res.json({ ok: false, message: 'Dữ liệu không hợp lệ.' });
    try { await activate(rule, idx, req.session?.user?.user || 'admin', 'đổi tay'); }
    catch (e) {
      addHistory(rule, { from: rule.queue[rule.activeIdx || 0]?.ten, to: rule.queue[idx].ten, by: req.session?.user?.user, ok: false, message: e.message });
      save();
      return res.json({ ok: false, message: e.message });
    }
    res.json({ ok: true });
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
    rule.lastError = '';
    save();
    const active = rule.queue[rule.activeIdx || 0]?.ten;
    res.json({ ok: true, ten, active,
      warning: active && normName(ten) !== normName(active)
        ? `Tên trên Sandbox ("${ten}") khác tên đang dùng trong danh sách ("${active}"). Chưa đổi gì — hãy sửa danh sách cho khớp.` : '' });
  }));

  app.post('/api/ton-kho/hd/check', guard, wrap(async (req, res) => {
    await checkAll();
    res.json({ ok: true });
  }));

  return { checkAll };
}
