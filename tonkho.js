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
import { parsePastedRequest, fetchInventory, tokenExpiry, renewSession } from './misa-tonkho.js';

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
  hkdAutoRenew: false,  // Tự đăng nhập lại MISA khi token hết hạn. CHỈ bật khi tài khoản MISA dành riêng cho máy chủ:
                        // MISA chỉ cho 1 máy đăng nhập mỗi tài khoản, máy chủ đăng nhập lại sẽ làm người đang dùng bị thoát.
  alertThreshold: 10,   // Nhắn Telegram nhóm kho khi tồn MISA của một mã hàng xuống dưới số này
  dictItemType: 2,      // data_type của danh mục Vật tư hàng hoá trong get_dictionary
  dictStockType: 3,     // data_type của danh mục Kho trong get_dictionary
};

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

export function mountTonKho(app, { express, DATA_DIR, fetchWithTimeout }) {
  const FILE = path.join(DATA_DIR, 'ton-kho.json');
  let STORE = { config: {}, token: null, hkd: null, snapshot: null, history: [], settings: {}, lastSync: null, alerted: {}, lastAlert: null, authAlertAt: '' };
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

  // ===================== CẢNH BÁO TỒN THẤP QUA TELEGRAM (bot nhóm kho) =====================
  // Quy tắc: tồn MISA của một mã hàng (cộng các kho) DƯỚI ngưỡng chung (mặc định 10) thì nhắn
  // vào nhóm kho. Mã hàng có "Tồn tối thiểu" riêng thì báo khi tồn ≤ mức đó.
  // Mỗi mã chỉ báo 1 lần; tồn lên lại trên ngưỡng rồi tụt xuống mới báo lần nữa.
  const notify = text => (typeof global.__khoNotify === 'function'
    ? global.__khoNotify(text) : Promise.resolve({ ok: false, error: 'Chưa có bot nhóm kho.' }));
  const alertTh = () => num(cfg().alertThreshold) || 10;
  const isLow = (qty, min, th) => (min ? qty <= min : qty < th);
  const tgEsc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const fmtN = n => (Math.round(n * 100) / 100).toLocaleString('vi-VN');
  const vnTime = iso => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

  function lowItems() {
    const th = alertTh(), settings = STORE.settings || {}, byKey = new Map();
    for (const it of STORE.snapshot?.items || []) {
      const key = it.code || normName(it.name);
      if (!byKey.has(key)) byKey.set(key, { key, code: it.code, name: it.name, unit: it.unit, qty: 0 });
      byKey.get(key).qty += it.qty;
    }
    return [...byKey.values()].map(g => ({ ...g, min: num((settings[g.key] || {}).min) }))
      .filter(g => isLow(g.qty, g.min, th)).sort((a, b) => a.qty - b.qty);
  }
  function alertText(title, list) {
    const MAX = 40;
    const lines = list.slice(0, MAX).map(g => `• <b>${tgEsc(g.name)}</b>${g.code ? ' (' + tgEsc(g.code) + ')' : ''}: `
      + (g.qty <= 0 ? '<b>hết hàng</b>' : `còn <b>${fmtN(g.qty)}</b> ${tgEsc(g.unit)}`) + (g.min ? ` (mức tối thiểu ${fmtN(g.min)})` : ''));
    if (list.length > MAX) lines.push(`… và ${list.length - MAX} mã hàng khác`);
    return `${title}\n${lines.join('\n')}\n\nTồn MISA lúc ${vnTime(STORE.snapshot.at)}.`;
  }
  let alerting = null;
  async function checkLowStock() {
    if (alerting) return alerting;
    // .finally chạy sau khi đã gán `alerting`, kể cả khi thân hàm không chờ gì (không có mã mới để báo)
    alerting = (async () => {
      {
        if (!STORE.snapshot) return;
        const low = lowItems(), lowKeys = new Set(low.map(g => g.key));
        const alerted = STORE.alerted || {};
        for (const k of Object.keys(alerted)) if (!lowKeys.has(k)) delete alerted[k];
        STORE.alerted = alerted;
        const fresh = low.filter(g => !alerted[g.key]);
        if (fresh.length) {
          const r = await notify(alertText(`⚠️ <b>Tồn kho thấp</b> (dưới ${alertTh()})`, fresh));
          const at = new Date().toISOString();
          // Gửi không được (chưa chọn nhóm, lỗi mạng…) thì KHÔNG đánh dấu → lần đồng bộ sau thử lại
          if (r && r.ok) { for (const g of fresh) alerted[g.key] = { at, qty: g.qty }; STORE.lastAlert = { at, ok: true, n: fresh.length }; }
          else STORE.lastAlert = { at, ok: false, message: (r && r.error) || 'Không gửi được Telegram' };
        }
        save();
      }
    })().finally(() => { alerting = null; });
    return alerting;
  }
  // Số tồn vừa đổi (đồng bộ MISA hoặc nhập Excel): xoá cờ hết phiên và kiểm tra tồn thấp, chạy ngầm
  function afterSnapshot() {
    if (STORE.authAlertAt) { STORE.authAlertAt = ''; save(); }
    checkLowStock().catch(e => console.warn('[TONKHO] cảnh báo tồn thấp lỗi:', e.message));
  }
  // Phiên MISA hết hạn thì số tồn đứng yên và cảnh báo ngừng hoạt động → báo 1 lần
  async function alertAuthExpired() {
    if (STORE.lastSync?.kind !== 'auth' || STORE.authAlertAt) return;
    const r = await notify('🔑 <b>Phiên MISA đã hết hạn</b>\nSố tồn kho đang đứng yên nên cảnh báo tồn thấp tạm ngừng. Quản trị viên vào Tồn kho → Cấu hình MISA và dán lại request paging_filter.');
    if (r && r.ok) { STORE.authAlertAt = new Date().toISOString(); save(); }
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
        afterSnapshot();
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
        let r;
        try { r = await fetchInventory(STORE.hkd, fetchWithTimeout); }
        catch (e) {
          // Token hết hạn (khoảng 12 giờ/lần): tự xin token mới bằng phiên AMIS rồi thử lại 1 lần
          if (e.kind !== 'auth' || !cfg().hkdAutoRenew) throw e;
          await renewHkd();
          r = await fetchInventory(STORE.hkd, fetchWithTimeout);
        }
        const items = r.items.filter(x => x.code || x.name);
        setSnapshot(items, 'misa-hkd');
        STORE.lastSync = { at: new Date().toISOString(), ok: true, n: items.length };
        save();
        afterSnapshot();
        return STORE.lastSync;
      } catch (e) {
        // kind === 'auth' → cả token lẫn phiên AMIS đều hết, cần dán lại request
        STORE.lastSync = { at: new Date().toISOString(), ok: false, message: e.message, kind: e.kind || '' };
        save();
        alertAuthExpired().catch(() => {});
        throw e;
      } finally { syncing = null; }
    })();
    return syncing;
  }
  // Xin token MISA mới và lưu lại (kèm cookie đã được MISA nối dài). Ném lỗi kind='auth' nếu không được.
  async function renewHkd() {
    try {
      STORE.hkd = await renewSession(STORE.hkd, fetchWithTimeout);
      STORE.hkd.lastRenewError = '';
      save();
      console.log('[TONKHO] đã tự gia hạn phiên MISA (lần ' + STORE.hkd.renewCount + ')');
    } catch (e) {
      STORE.hkd.lastRenewError = e.message; STORE.hkd.lastRenewErrorAt = new Date().toISOString();
      save();
      throw e;
    }
  }
  // Đã dán request Hộ kinh doanh thì ưu tiên nguồn đó, không thì dùng Open API
  const syncNow = () => (STORE.hkd ? syncFromHkd() : syncFromMisa());

  // Tự đồng bộ định kỳ (kiểm tra mỗi phút, chạy khi tới hạn)
  setInterval(() => {
    const c = cfg();
    if (!c.autoMinutes) return;
    if (STORE.hkd) { if (STORE.lastSync?.kind === 'auth') return; } // hết phiên: chờ admin dán lại
    else if (!c.appId || !c.accessCode) return;
    const last = STORE.lastSync ? Date.parse(STORE.lastSync.at) : 0;
    if (Date.now() - last < c.autoMinutes * 60 * 1000) return;
    syncNow().catch(e => console.warn('[TONKHO] tự đồng bộ lỗi:', e.message));
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
    const th = alertTh();
    return [...byKey.values()].map(g => {
      const st = settings[g.key] || {};
      // Tên dùng để so với cột "Sản phẩm" bên OMS: alias do người dùng đặt, mặc định là tên + mã hàng
      const aliases = (st.alias ? String(st.alias).split(',') : [g.name, g.code])
        .map(normName).filter(a => a.length >= 3);
      const sold = saleRows.filter(s => aliases.some(a => s.n === a || s.n.includes(a)))
        .reduce((sum, s) => sum + s.qty, 0);
      const perDay = days > 0 ? sold / days : 0;
      const daysLeft = perDay > 0 ? g.qty / perDay : null;
      const min = num(st.min);
      let level = 'ok';
      if (g.qty <= 0) level = 'het';
      else if (isLow(g.qty, min, th) || (daysLeft !== null && daysLeft < 7)) level = 'sap-het';
      else if (daysLeft !== null && daysLeft < 14) level = 'theo-doi';
      else if (perDay === 0) level = 'khong-ban';
      return { ...g, alias: st.alias || '', min, sold, perDay, daysLeft, level };
    });
  }

  // ===================== ROUTES =====================
  const json = express.json({ limit: '5mb' });

  app.get('/api/ton-kho', guard, wrap(async (req, res) => {
    const c = cfg();
    const days = Math.max(1, Math.min(180, Number(req.query.days) || c.salesDays));
    const sales = await salesByProduct(days);
    res.json({
      ok: true,
      snapshot: STORE.snapshot ? { at: STORE.snapshot.at, source: STORE.snapshot.source, n: STORE.snapshot.items.length } : null,
      lastSync: STORE.lastSync, days, omsOk: sales.ok, omsMessage: sales.message || '',
      items: buildReport(sales.rows, days),
      history: STORE.history || [],
      configured: !!STORE.hkd || !!(c.appId && c.accessCode && c.orgCompanyCode),
      // Không bao giờ trả header/token của request đã dán về trình duyệt
      hkd: STORE.hkd ? { savedAt: STORE.hkd.savedAt, savedBy: STORE.hkd.savedBy, tokenExp: STORE.hkd.tokenExpAt || tokenExpiry(STORE.hkd.headers),
        renewedAt: STORE.hkd.renewedAt || '', renewCount: STORE.hkd.renewCount || 0, lastRenewError: STORE.hkd.lastRenewError || '' } : null,
      hkdAutoRenew: !!c.hkdAutoRenew,
      autoMinutes: c.autoMinutes,
      alert: { threshold: alertTh(), nLow: lowItems().length, last: STORE.lastAlert || null },
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
    for (const k of ['apiUrl', 'appId', 'orgCompanyCode', 'branchId']) if (b[k] !== undefined) next[k] = String(b[k]).trim();
    // Chỉ ghi đè mã kết nối khi người dùng nhập mã mới (không phải chuỗi đã che)
    if (b.accessCode && !String(b.accessCode).includes('•')) next.accessCode = String(b.accessCode).trim();
    for (const k of ['autoMinutes', 'salesDays', 'dictItemType', 'dictStockType'])
      if (b[k] !== undefined && b[k] !== '') next[k] = Math.max(0, Number(b[k]) || 0);
    if (!/^https:\/\/[^/]+\.misa\.vn\/?$/.test(next.apiUrl || DEFAULT_CONFIG.apiUrl))
      return res.json({ ok: false, message: 'API URL phải là tên miền *.misa.vn (https).' });
    STORE.config = next;
    STORE.token = null;
    save();
    res.json({ ok: true });
  });

  app.post('/api/ton-kho/sync', guard, wrap(async (req, res) => {
    const r = await syncNow();
    res.json({ ok: true, ...r });
  }));

  // MISA Hộ kinh doanh: dán request "paging_filter" chép từ trình duyệt, lưu rồi đồng bộ thử ngay
  app.post('/api/ton-kho/hkd-config', guard, json, async (req, res) => {
    let parsed;
    try { parsed = parsePastedRequest(req.body?.raw); }
    catch (e) { return res.json({ ok: false, message: e.message }); }
    STORE.hkd = { ...parsed, savedAt: new Date().toISOString(), savedBy: req.session?.user?.user || '' };
    save();
    try { const r = await syncFromHkd(); res.json({ ok: true, n: r.n }); }
    catch (e) { res.json({ ok: false, saved: true, message: e.message }); }
  });
  // Bật/tắt tự gia hạn phiên (mặc định tắt — xem DEFAULT_CONFIG.hkdAutoRenew)
  app.post('/api/ton-kho/hkd-auto-renew', guard, json, (req, res) => {
    STORE.config = { ...STORE.config, hkdAutoRenew: req.body?.on === true };
    save();
    res.json({ ok: true, on: STORE.config.hkdAutoRenew });
  });
  // Thử tự gia hạn phiên ngay (để biết cơ chế có chạy với tài khoản này không), rồi đồng bộ lại
  app.post('/api/ton-kho/hkd-renew', guard, async (req, res) => {
    if (!STORE.hkd) return res.json({ ok: false, message: 'Chưa kết nối MISA Hộ kinh doanh.' });
    try { await renewHkd(); } catch (e) { return res.json({ ok: false, message: e.message }); }
    try { const r = await syncFromHkd(); res.json({ ok: true, n: r.n }); }
    catch (e) { res.json({ ok: false, renewed: true, message: 'Đã lấy được token mới nhưng đồng bộ lỗi: ' + e.message }); }
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

  // Ngưỡng cảnh báo tồn thấp
  app.post('/api/ton-kho/alert-config', guard, json, (req, res) => {
    const th = Math.floor(Number(req.body?.alertThreshold));
    if (!(th >= 1 && th <= 1000000)) return res.json({ ok: false, message: 'Ngưỡng phải là số nguyên từ 1 trở lên.' });
    STORE.config = { ...STORE.config, alertThreshold: th };
    save();
    afterSnapshot(); // ngưỡng đổi → xét lại ngay
    res.json({ ok: true, threshold: th });
  });
  // Nhắn ngay toàn bộ danh sách mã hàng đang dưới ngưỡng (kể cả mã đã báo) — dùng để thử / xem lại
  app.post('/api/ton-kho/alert-now', guard, wrap(async (req, res) => {
    if (!STORE.snapshot) return res.json({ ok: false, message: 'Chưa có số liệu tồn kho.' });
    const low = lowItems(), th = alertTh();
    const r = await notify(low.length ? alertText(`📋 <b>Danh sách tồn kho thấp</b> (dưới ${th}): ${low.length} mã`, low)
      : `✅ Hiện không có mã hàng nào tồn dưới ${th}. Tồn MISA lúc ${vnTime(STORE.snapshot.at)}.`);
    res.json(r && r.ok ? { ok: true, n: low.length } : { ok: false, message: 'Không gửi được: ' + ((r && r.error) || 'không rõ') });
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
    afterSnapshot();
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
