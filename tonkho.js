// =====================================================================
//  MODULE TỒN KHO — tonkho.js
//  Lấy số lượng tồn từ MISA AMIS Hộ kinh doanh (request nội bộ, xem misa-tonkho.js),
//  MISA AMIS Kế toán (ACT Open API) hoặc dán từ Excel,
//  ghép với tốc độ bán từ OMS để tính "số ngày còn đủ bán".
//  Mount vào server.js: mountTonKho(app, { express, DATA_DIR, fetchWithTimeout })
//  Dữ liệu lưu ở DATA_DIR/ton-kho.json (ngoài project, không mất khi deploy).
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import { parsePastedRequest, fetchInventory, tokenExpiry } from './misa-tonkho.js';

// Các trạng thái OMS được tính là "đã bán" khi đo tốc độ bán
const TRANG_THAI_BAN = ['Đã chốt', 'Đang ship', 'Ship thành công'];

const DEFAULT_CONFIG = {
  apiUrl: 'https://actapp.misa.vn',
  appId: '',            // App ID MISA cấp cho đối tác
  accessCode: '',       // Mã kết nối lấy trong AMIS: Tiện ích → Kết nối ứng dụng → Kết nối API
  orgCompanyCode: '',   // Mã định danh công ty phía mình (tự đặt, vd "tdmjsc")
  branchId: '',         // Để trống = tất cả chi nhánh
  autoMinutes: 30,      // Tự đồng bộ mỗi N phút (0 = tắt)
  salesDays: 30,        // Số ngày gần nhất dùng để tính tốc độ bán
  dictItemType: 2,      // data_type của danh mục Vật tư hàng hoá trong get_dictionary
  dictStockType: 3,     // data_type của danh mục Kho trong get_dictionary
  telegramChatId: '',   // Chat ID Telegram nhận cảnh báo sắp hết hàng (để trống = không gửi)
  alertThreshold: 10,   // Cảnh báo khi (tồn MISA − đơn đang đi) nhỏ hơn số này
  transitDays: 120,     // Xét đơn Sandbox tạo trong N ngày gần nhất
};

// Trạng thái giao hàng bên Sandbox (trang Vận đơn) được tính là "đơn đang đi":
// hàng đã rời kho hoặc đã giữ cho đơn nhưng MISA chưa trừ tồn.
export const TRANSIT_STATUS = { 20: 'Đã đăng', 21: 'Đã lấy hàng', 30: 'Đang giao hàng', 33: 'Không giao được' };

// Ghép đơn đang đi (theo tên SP Sandbox) vào từng mã hàng MISA.
// groups: [{ key, name, code, qty }], settings[key].alias = tên bên Sandbox (nhiều tên cách nhau dấu phẩy).
// So khớp CHÍNH XÁC sau khi bỏ dấu/hoa thường để một sản phẩm Sandbox không bị cộng vào hai mã hàng.
export function matchTransit(groups, transitRows, settings = {}) {
  const byName = new Map();
  for (const g of groups) {
    const st = settings[g.key] || {};
    const names = st.alias ? String(st.alias).split(',') : [g.name];
    for (const n of names.map(normName).filter(Boolean)) if (!byName.has(n)) byName.set(n, g.key);
  }
  const out = new Map(); const unmatched = new Map();
  for (const r of transitRows || []) {
    const key = byName.get(normName(r.ten));
    if (!key) {
      const u = unmatched.get(r.ten) || { ten: r.ten, ma: r.ma, qty: 0 };
      u.qty += r.qty; unmatched.set(r.ten, u); continue;
    }
    const t = out.get(key) || { total: 0, by: {} };
    t.total += r.qty; t.by[r.status] = (t.by[r.status] || 0) + r.qty;
    out.set(key, t);
  }
  return { byKey: out, unmatched: [...unmatched.values()].sort((a, b) => b.qty - a.qty) };
}

const tgEsc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtN = n => (Math.round(n) || 0).toLocaleString('vi-VN');

// ---- Bỏ dấu + chữ thường để so khớp tên hàng ----
export function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---- Lấy giá trị đầu tiên có mặt trong object theo danh sách tên field ----
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
}
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v || '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// ---- MISA trả Data dạng chuỗi JSON hoặc object; tìm mảng dữ liệu bên trong ----
export function extractList(data) {
  let d = data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return []; } }
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    for (const k of ['Data', 'data', 'items', 'list', 'Items', 'result']) {
      if (d[k] !== undefined) {
        const inner = extractList(d[k]);
        if (inner.length) return inner;
      }
    }
    const arr = Object.values(d).find(Array.isArray);
    if (arr) return arr;
  }
  return [];
}

// ---- Chuẩn hoá 1 dòng tồn kho từ MISA về cấu trúc chung ----
export function normalizeMisaRow(r, itemDict = {}, stockDict = {}) {
  const itemId = pick(r, ['inventory_item_id', 'item_id']);
  const stockId = pick(r, ['stock_id']);
  const it = itemDict[itemId] || {};
  const st = stockDict[stockId] || {};
  return {
    code: String(pick(r, ['inventory_item_code', 'item_code', 'code']) || it.code || ''),
    name: String(pick(r, ['inventory_item_name', 'item_name', 'name', 'description']) || it.name || ''),
    unit: String(pick(r, ['unit_name', 'unit', 'main_unit_name']) || it.unit || ''),
    stockCode: String(pick(r, ['stock_code']) || st.code || ''),
    stockName: String(pick(r, ['stock_name']) || st.name || ''),
    qty: num(pick(r, ['quantity_balance', 'closing_quantity', 'balance_quantity', 'inventory_quantity', 'quantity', 'qty'])),
    amount: num(pick(r, ['amount_balance', 'closing_amount', 'balance_amount', 'amount'])),
  };
}

export function mountTonKho(app, { express, DATA_DIR, fetchWithTimeout, getInTransit, sendTelegram }) {
  const FILE = path.join(DATA_DIR, 'ton-kho.json');
  let STORE = { config: {}, token: null, hkd: null, snapshot: null, history: [], settings: {}, lastSync: null, transit: null, alerted: {}, authAlertAt: '' };
  try { STORE = { ...STORE, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  const save = () => {
    // File chứa mã kết nối / token đăng nhập MISA → chỉ chủ tài khoản hosting đọc được
    try { fs.writeFileSync(FILE, JSON.stringify(STORE, null, 1), { mode: 0o600 }); fs.chmodSync(FILE, 0o600); }
    catch (e) { console.error('[TONKHO] lưu file lỗi:', e.message); }
  };
  const cfg = () => ({ ...DEFAULT_CONFIG, ...STORE.config });

  const isAdmin = req => req.session?.user?.role === 'admin';
  const guard = (req, res, next) => isAdmin(req) ? next()
    : res.status(403).json({ ok: false, message: 'Chỉ quản trị viên xem được tồn kho.' });
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error('[TONKHO]', e); res.status(500).json({ ok: false, message: e.message }); }
  };

  // ===================== MISA AMIS (ACT Open API) =====================
  async function misaPost(urlPath, body, token) {
    const c = cfg();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-MISA-AccessToken'] = token;
    const resp = await fetchWithTimeout(c.apiUrl.replace(/\/+$/, '') + urlPath,
      { method: 'POST', headers, body: JSON.stringify(body) }, 60000);
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error(`MISA trả về không phải JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`); }
    if (resp.status === 401) { const e = new Error('Token hết hạn'); e.expired = true; throw e; }
    if (json.Success === false || json.success === false) {
      const msg = json.ErrorMessage || json.error_message || json.ErrorCode || 'MISA báo lỗi';
      const e = new Error(String(msg));
      if (/token|expire|unauthor/i.test(String(json.ErrorCode || '') + msg)) e.expired = true;
      throw e;
    }
    return json;
  }

  async function getToken(force = false) {
    const c = cfg();
    if (!c.appId || !c.accessCode || !c.orgCompanyCode)
      throw new Error('Chưa cấu hình đủ App ID, Mã kết nối, Mã công ty.');
    // Token giữ 6 giờ rồi lấy lại cho chắc
    if (!force && STORE.token?.value && Date.now() - STORE.token.at < 6 * 3600 * 1000) return STORE.token.value;
    const json = await misaPost('/api/oauth/actopen/connect', {
      app_id: c.appId, access_code: c.accessCode, org_company_code: c.orgCompanyCode,
    });
    let d = json.Data ?? json.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* bản thân chuỗi là token */ } }
    const token = typeof d === 'string' ? d : (d?.access_token || d?.AccessToken || d?.token || '');
    if (!token) throw new Error('Kết nối MISA thành công nhưng không thấy access_token trong phản hồi.');
    STORE.token = { value: token, at: Date.now() };
    save();
    return token;
  }

  // Gọi 1 hàm actopen, tự lấy lại token 1 lần nếu hết hạn
  async function callActopen(fn, body) {
    let token = await getToken();
    try { return await misaPost(`/apir/sync/actopen/${fn}`, body, token); }
    catch (e) {
      if (!e.expired) throw e;
      token = await getToken(true);
      return misaPost(`/apir/sync/actopen/${fn}`, body, token);
    }
  }

  // Lấy toàn bộ theo trang (skip/take)
  async function fetchAll(fn, extra = {}) {
    const c = cfg();
    const take = 500;
    const all = [];
    for (let skip = 0; skip < 50000; skip += take) {
      const json = await callActopen(fn, {
        app_id: c.appId, org_company_code: c.orgCompanyCode,
        branch_id: c.branchId || null, last_sync_time: null, skip, take, ...extra,
      });
      const list = extractList(json.Data ?? json.data ?? json);
      all.push(...list);
      if (list.length < take) break;
    }
    return all;
  }

  // Danh mục để bổ sung mã/tên khi bảng tồn chỉ trả về id (lỗi thì bỏ qua)
  async function fetchDict(dataType) {
    try {
      const rows = await fetchAll('get_dictionary', { data_type: Number(dataType) });
      const map = {};
      for (const r of rows) {
        const id = pick(r, ['inventory_item_id', 'stock_id', 'id']);
        if (!id) continue;
        map[id] = {
          code: pick(r, ['inventory_item_code', 'stock_code', 'code']),
          name: pick(r, ['inventory_item_name', 'stock_name', 'name']),
          unit: pick(r, ['unit_name']),
        };
      }
      return map;
    } catch (e) {
      console.warn('[TONKHO] get_dictionary', dataType, 'lỗi:', e.message);
      return {};
    }
  }

  function setSnapshot(items, source) {
    const at = new Date().toISOString();
    STORE.snapshot = { at, source, items };
    const totalQty = items.reduce((s, x) => s + x.qty, 0);
    const totalAmount = items.reduce((s, x) => s + x.amount, 0);
    STORE.history = [...(STORE.history || []), { at, source, totalQty, totalAmount, n: items.length }].slice(-200);
  }

  let syncing = null;
  async function syncFromMisa() {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const c = cfg();
        const raw = await fetchAll('get_list_inventory_balance');
        const needDict = raw.some(r => !pick(r, ['inventory_item_name', 'item_name', 'name']));
        const [itemDict, stockDict] = needDict
          ? await Promise.all([fetchDict(c.dictItemType), fetchDict(c.dictStockType)])
          : [{}, {}];
        const items = raw.map(r => normalizeMisaRow(r, itemDict, stockDict))
          .filter(x => x.code || x.name);
        setSnapshot(items, 'misa');
        STORE.lastSync = { at: new Date().toISOString(), ok: true, n: items.length };
        save();
        return STORE.lastSync;
      } catch (e) {
        STORE.lastSync = { at: new Date().toISOString(), ok: false, message: e.message };
        save();
        throw e;
      } finally { syncing = null; }
    })();
    return syncing;
  }

  // ===================== MISA AMIS HỘ KINH DOANH (request nội bộ) =====================
  // STORE.hkd = { url, headers, body, savedAt, savedBy } — do admin dán "Copy as cURL".
  async function syncFromHkd() {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const r = await fetchInventory(STORE.hkd, fetchWithTimeout);
        const items = r.items.filter(x => x.code || x.name);
        setSnapshot(items, 'misa-hkd');
        STORE.lastSync = { at: new Date().toISOString(), ok: true, n: items.length };
        save();
        return STORE.lastSync;
      } catch (e) {
        // kind === 'auth' → phiên MISA hết hạn, cần dán lại request
        STORE.lastSync = { at: new Date().toISOString(), ok: false, message: e.message, kind: e.kind || '' };
        save();
        throw e;
      } finally { syncing = null; }
    })();
    return syncing;
  }
  // Đã dán request Hộ kinh doanh thì ưu tiên nguồn đó, không thì dùng Open API
  const syncNow = () => (STORE.hkd ? syncFromHkd() : syncFromMisa());

  // ===================== ĐƠN ĐANG ĐI (SANDBOX) + CẢNH BÁO TELEGRAM =====================
  let transitRunning = null;
  async function refreshTransit() {
    if (typeof getInTransit !== 'function') return;
    if (transitRunning) return transitRunning;
    transitRunning = (async () => {
      try {
        const rows = await getInTransit(Object.keys(TRANSIT_STATUS).map(Number), cfg().transitDays || 120);
        STORE.transit = { at: new Date().toISOString(), ok: true, rows };
      } catch (e) {
        // Giữ số liệu cũ, chỉ ghi lại lỗi
        STORE.transit = { ...(STORE.transit || { rows: [] }), ok: false, message: e.message, errorAt: new Date().toISOString() };
        console.warn('[TONKHO] đọc đơn đang đi từ Sandbox lỗi:', e.message);
      } finally { save(); transitRunning = null; }
    })();
    return transitRunning;
  }

  // Gộp tồn theo mã hàng (cộng các kho)
  function groupItems() {
    const byKey = new Map();
    for (const it of STORE.snapshot?.items || []) {
      const key = it.code || normName(it.name);
      if (!byKey.has(key)) byKey.set(key, { key, code: it.code, name: it.name, unit: it.unit, qty: 0, amount: 0, stocks: [] });
      const g = byKey.get(key);
      g.qty += it.qty; g.amount += it.amount;
      if (it.stockCode || it.stockName) g.stocks.push({ code: it.stockCode, name: it.stockName, qty: it.qty });
    }
    return [...byKey.values()];
  }

  // Sản phẩm cần cảnh báo: có đơn đang đi và (tồn MISA − đơn đang đi) < ngưỡng
  function lowItems() {
    const th = num(cfg().alertThreshold) || 10;
    const groups = groupItems();
    const { byKey } = matchTransit(groups, STORE.transit?.rows, STORE.settings);
    return groups.map(g => ({ ...g, transit: byKey.get(g.key)?.total || 0 }))
      .map(g => ({ ...g, remain: g.qty - g.transit }))
      .filter(g => g.transit > 0 && g.remain < th);
  }
  const alertLine = g => `• <b>${tgEsc(g.name)}</b> (${tgEsc(g.code)}): tồn MISA ${fmtN(g.qty)}, đơn đang đi ${fmtN(g.transit)} → còn <b>${fmtN(g.remain)}</b>`;

  // Gửi 1 tin cho các sản phẩm MỚI rơi xuống dưới ngưỡng; sản phẩm đã báo thì không báo lại
  // cho tới khi nó lên lại trên ngưỡng rồi tụt xuống lần nữa.
  async function checkAlerts() {
    const c = cfg();
    if (!c.telegramChatId || typeof sendTelegram !== 'function') return;
    if (!STORE.snapshot || !STORE.transit?.rows) return;
    const low = lowItems();
    const lowKeys = new Set(low.map(g => g.key));
    const alerted = STORE.alerted || {};
    for (const k of Object.keys(alerted)) if (!lowKeys.has(k)) delete alerted[k];
    const fresh = low.filter(g => !alerted[g.key]);
    STORE.alerted = alerted;
    if (fresh.length) {
      const th = num(c.alertThreshold) || 10;
      const text = `⚠️ <b>Sắp hết hàng</b> (tồn MISA trừ đơn đang đi còn dưới ${th})\n`
        + fresh.sort((a, b) => a.remain - b.remain).map(alertLine).join('\n')
        + `\n\nTồn MISA lúc ${new Date(STORE.snapshot.at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}.`;
      try {
        const r = await sendTelegram(c.telegramChatId, text);
        if (r && r.ok) { const at = new Date().toISOString(); for (const g of fresh) alerted[g.key] = { at, remain: g.remain }; STORE.lastAlert = { at, ok: true, n: fresh.length }; }
        else STORE.lastAlert = { at: new Date().toISOString(), ok: false, message: (r && r.error) || 'Telegram từ chối tin nhắn' };
      } catch (e) { STORE.lastAlert = { at: new Date().toISOString(), ok: false, message: e.message }; }
    }
    save();
  }

  // Báo 1 lần khi phiên MISA hết hạn (số tồn sẽ đứng yên cho tới khi dán lại request)
  async function alertAuthExpired() {
    const c = cfg();
    if (!c.telegramChatId || typeof sendTelegram !== 'function') return;
    if (STORE.lastSync?.kind !== 'auth') { if (STORE.authAlertAt) { STORE.authAlertAt = ''; save(); } return; }
    if (STORE.authAlertAt) return;
    try {
      const r = await sendTelegram(c.telegramChatId, '🔑 <b>Phiên MISA đã hết hạn</b>\nTrang Tồn kho đang dùng số liệu cũ. Vào Tồn kho → Cấu hình MISA và dán lại request paging_filter.');
      if (r && r.ok) { STORE.authAlertAt = new Date().toISOString(); save(); }
    } catch {}
  }

  // Một vòng đầy đủ: tồn MISA → đơn đang đi → cảnh báo
  async function cycle() {
    try { await syncNow(); } catch {}
    await refreshTransit();
    await alertAuthExpired();
    await checkAlerts();
  }

  // Tự đồng bộ định kỳ (kiểm tra mỗi phút, chạy khi tới hạn)
  setInterval(() => {
    const c = cfg();
    if (!c.autoMinutes) return;
    if (STORE.hkd) { if (STORE.lastSync?.kind === 'auth') return; } // hết phiên: chờ admin dán lại
    else if (!c.appId || !c.accessCode) return;
    const last = STORE.lastSync ? Date.parse(STORE.lastSync.at) : 0;
    if (Date.now() - last < c.autoMinutes * 60 * 1000) return;
    cycle().catch(e => console.warn('[TONKHO] tự đồng bộ lỗi:', e.message));
  }, 60 * 1000).unref?.();
  // Phiên MISA hết hạn thì vòng trên dừng; vẫn cập nhật đơn đang đi + cảnh báo theo số tồn cũ
  setInterval(() => {
    const c = cfg();
    if (!c.autoMinutes || !STORE.snapshot) return;
    const last = Date.parse(STORE.transit?.at || 0) || 0, lastErr = Date.parse(STORE.transit?.errorAt || 0) || 0;
    if (Date.now() - Math.max(last, lastErr) < c.autoMinutes * 60 * 1000) return;
    refreshTransit().then(checkAlerts).catch(() => {});
  }, 60 * 1000).unref?.();

  // ===================== TỐC ĐỘ BÁN TỪ OMS =====================
  async function salesByProduct(days) {
    if (typeof global.__omsSalesByProduct !== 'function') return { ok: false, rows: [] };
    try { return { ok: true, rows: await global.__omsSalesByProduct(days, TRANG_THAI_BAN) }; }
    catch (e) { return { ok: false, rows: [], message: e.message }; }
  }

  // Gộp tồn theo mã hàng (cộng các kho) + ghép số bán OMS
  function buildReport(sales, days) {
    const items = STORE.snapshot?.items || [];
    const settings = STORE.settings || {};
    const byKey = new Map();
    for (const it of items) {
      const key = it.code || normName(it.name);
      if (!byKey.has(key)) byKey.set(key, { key, code: it.code, name: it.name, unit: it.unit, qty: 0, amount: 0, stocks: [] });
      const g = byKey.get(key);
      g.qty += it.qty; g.amount += it.amount;
      if (it.stockCode || it.stockName) g.stocks.push({ code: it.stockCode, name: it.stockName, qty: it.qty });
    }
    const saleRows = sales.map(s => ({ n: normName(s.san_pham), qty: num(s.qty) })).filter(s => s.n);
    const tr = matchTransit([...byKey.values()], STORE.transit?.rows, settings);
    const th = num(cfg().alertThreshold) || 10;
    return [...byKey.values()].map(g => {
      const t = tr.byKey.get(g.key) || { total: 0, by: {} };
      const remain = g.qty - t.total;
      const st = settings[g.key] || {};
      // Tên dùng để so với cột "Sản phẩm" bên OMS: alias do người dùng đặt, mặc định là tên + mã hàng
      const aliases = (st.alias ? String(st.alias).split(',') : [g.name, g.code])
        .map(normName).filter(a => a.length >= 3);
      const sold = saleRows.filter(s => aliases.some(a => s.n === a || s.n.includes(a)))
        .reduce((sum, s) => sum + s.qty, 0);
      const perDay = days > 0 ? sold / days : 0;
      const daysLeft = perDay > 0 ? g.qty / perDay : null;
      const min = num(st.min);
      // Trạng thái theo "còn lại" = tồn MISA − đơn đang đi (Sandbox)
      let level = 'ok';
      if (g.qty <= 0) level = 'het';
      else if ((min && g.qty <= min) || (t.total > 0 && remain < th)) level = 'sap-het';
      return { ...g, alias: st.alias || '', min, sold, perDay, daysLeft, level, transit: t.total, transitBy: t.by, remain };
    });
  }

  // ===================== ROUTES =====================
  const json = express.json({ limit: '5mb' });

  app.get('/api/ton-kho', guard, wrap(async (req, res) => {
    const c = cfg();
    const days = Math.max(1, Math.min(180, Number(req.query.days) || c.salesDays));
    const sales = await salesByProduct(days);
    if (!STORE.transit && !transitRunning) refreshTransit().catch(() => {}); // lần đầu: nạp ngầm
    res.json({
      ok: true,
      snapshot: STORE.snapshot ? { at: STORE.snapshot.at, source: STORE.snapshot.source, n: STORE.snapshot.items.length } : null,
      lastSync: STORE.lastSync, days, omsOk: sales.ok, omsMessage: sales.message || '',
      items: buildReport(sales.rows, days),
      history: STORE.history || [],
      configured: !!STORE.hkd || !!(c.appId && c.accessCode && c.orgCompanyCode),
      // Không bao giờ trả header/token của request đã dán về trình duyệt
      hkd: STORE.hkd ? { savedAt: STORE.hkd.savedAt, savedBy: STORE.hkd.savedBy, tokenExp: tokenExpiry(STORE.hkd.headers) } : null,
      autoMinutes: c.autoMinutes,
      alertThreshold: num(c.alertThreshold) || 10,
      transit: STORE.transit ? { at: STORE.transit.at || '', ok: STORE.transit.ok !== false, message: STORE.transit.message || '' } : null,
      transitStatus: TRANSIT_STATUS,
      unmatched: matchTransit(groupItems(), STORE.transit?.rows, STORE.settings).unmatched,
      alert: { hasChat: !!c.telegramChatId, last: STORE.lastAlert || null, nAlerted: Object.keys(STORE.alerted || {}).length },
    });
  }));

  // Cấu hình: không bao giờ trả mã kết nối đầy đủ về trình duyệt
  app.get('/api/ton-kho/config', guard, (req, res) => {
    const c = cfg();
    const mask = s => s ? s.slice(0, 3) + '•••' + s.slice(-3) : '';
    res.json({ ok: true, config: { ...c, accessCode: mask(c.accessCode), hasAccessCode: !!c.accessCode } });
  });

  app.post('/api/ton-kho/config', guard, json, (req, res) => {
    const b = req.body || {};
    const next = { ...STORE.config };
    for (const k of ['apiUrl', 'appId', 'orgCompanyCode', 'branchId', 'telegramChatId']) if (b[k] !== undefined) next[k] = String(b[k]).trim();
    // Chỉ ghi đè mã kết nối khi người dùng nhập mã mới (không phải chuỗi đã che)
    if (b.accessCode && !String(b.accessCode).includes('•')) next.accessCode = String(b.accessCode).trim();
    if (next.telegramChatId && !/^-?\d{4,20}$/.test(next.telegramChatId))
      return res.json({ ok: false, message: 'Chat ID Telegram phải là một dãy số (có thể có dấu − ở đầu với nhóm).' });
    for (const k of ['autoMinutes', 'salesDays', 'dictItemType', 'dictStockType', 'alertThreshold', 'transitDays'])
      if (b[k] !== undefined && b[k] !== '') next[k] = Math.max(0, Number(b[k]) || 0);
    if (!/^https:\/\/[^/]+\.misa\.vn\/?$/.test(next.apiUrl || DEFAULT_CONFIG.apiUrl))
      return res.json({ ok: false, message: 'API URL phải là tên miền *.misa.vn (https).' });
    STORE.config = next;
    STORE.token = null;
    save();
    res.json({ ok: true });
  });

  app.post('/api/ton-kho/sync', guard, wrap(async (req, res) => {
    let r, err = '';
    try { r = await syncNow(); } catch (e) { err = e.message; }
    await refreshTransit();
    await alertAuthExpired();
    await checkAlerts();
    if (err) return res.json({ ok: false, message: err });
    res.json({ ok: true, ...r });
  }));

  // Gửi thử 1 tin Telegram: danh sách sản phẩm đang dưới ngưỡng (hoặc báo "chưa có")
  app.post('/api/ton-kho/alert-test', guard, wrap(async (req, res) => {
    const c = cfg();
    if (!c.telegramChatId) return res.json({ ok: false, message: 'Chưa nhập Chat ID Telegram.' });
    if (typeof sendTelegram !== 'function') return res.json({ ok: false, message: 'Máy chủ chưa có chức năng gửi Telegram.' });
    await refreshTransit();
    const low = lowItems().sort((a, b) => a.remain - b.remain);
    const th = num(c.alertThreshold) || 10;
    const text = `✅ <b>Tin thử từ trang Tồn kho</b>\n` + (low.length
      ? `Đang có ${low.length} sản phẩm còn dưới ${th}:\n` + low.map(alertLine).join('\n')
      : `Hiện chưa có sản phẩm nào còn dưới ${th}.`);
    const r = await sendTelegram(c.telegramChatId, text);
    res.json(r && r.ok ? { ok: true, n: low.length } : { ok: false, message: 'Telegram báo lỗi: ' + ((r && r.error) || 'không rõ') });
  }));

  // MISA Hộ kinh doanh: dán request "paging_filter" chép từ trình duyệt, lưu rồi đồng bộ thử ngay
  app.post('/api/ton-kho/hkd-config', guard, json, async (req, res) => {
    let parsed;
    try { parsed = parsePastedRequest(req.body?.raw); }
    catch (e) { return res.json({ ok: false, message: e.message }); }
    STORE.hkd = { ...parsed, savedAt: new Date().toISOString(), savedBy: req.session?.user?.user || '' };
    save();
    try { const r = await syncFromHkd(); res.json({ ok: true, n: r.n }); refreshTransit().then(alertAuthExpired).then(checkAlerts).catch(() => {}); }
    catch (e) { res.json({ ok: false, saved: true, message: e.message }); }
  });
  app.post('/api/ton-kho/hkd-config/delete', guard, (req, res) => {
    STORE.hkd = null;
    save();
    res.json({ ok: true });
  });

  // Kiểm tra kết nối + xem vài dòng dữ liệu gốc (để chỉnh lại tên field nếu MISA trả khác)
  app.get('/api/ton-kho/misa-raw', guard, wrap(async (req, res) => {
    const c = cfg();
    await getToken(true);
    const out = { ok: true, token: 'OK' };
    const sample = async (fn, extra) => {
      try {
        const j = await callActopen(fn, { app_id: c.appId, org_company_code: c.orgCompanyCode,
          branch_id: c.branchId || null, last_sync_time: null, skip: 0, take: 3, ...extra });
        return extractList(j.Data ?? j.data ?? j);
      } catch (e) { return { error: e.message }; }
    };
    out.inventory_balance = await sample('get_list_inventory_balance');
    out.dict_item = await sample('get_dictionary', { data_type: Number(c.dictItemType) });
    out.dict_stock = await sample('get_dictionary', { data_type: Number(c.dictStockType) });
    res.json(out);
  }));

  // Phương án dự phòng: dán bảng tồn kho xuất từ MISA (đã chuẩn hoá ở trình duyệt)
  app.post('/api/ton-kho/import', guard, json, (req, res) => {
    const rows = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = rows.slice(0, 20000).map(r => ({
      code: String(r.code || '').trim().slice(0, 100),
      name: String(r.name || '').trim().slice(0, 300),
      unit: String(r.unit || '').trim().slice(0, 50),
      stockCode: String(r.stockCode || '').trim().slice(0, 100),
      stockName: String(r.stockName || '').trim().slice(0, 200),
      qty: num(r.qty), amount: num(r.amount),
    })).filter(x => x.code || x.name);
    if (!items.length) return res.json({ ok: false, message: 'Không có dòng hợp lệ (cần ít nhất Mã hàng hoặc Tên hàng).' });
    setSnapshot(items, 'excel');
    save();
    res.json({ ok: true, n: items.length });
  });

  // Mức tồn tối thiểu + tên sản phẩm bên OMS cho từng mã hàng
  app.post('/api/ton-kho/setting', guard, json, (req, res) => {
    const { key, min, alias } = req.body || {};
    if (!key) return res.json({ ok: false, message: 'Thiếu mã hàng' });
    STORE.settings = STORE.settings || {};
    const s = STORE.settings[key] || {};
    if (min !== undefined) s.min = Math.max(0, num(min));
    if (alias !== undefined) s.alias = String(alias).slice(0, 500);
    STORE.settings[key] = s;
    save();
    res.json({ ok: true });
  });

  console.log('[TONKHO] đã gắn module tồn kho');
}
