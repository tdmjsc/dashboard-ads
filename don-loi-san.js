// don-loi-san.js — BÁO ĐƠN LỖI SHOPEE / TIKTOK TRÊN SANDBOX QUA BOT NHÓM KHO
//
// Sandbox kéo đơn từ Shopee/TikTok về; đơn nào tạo không được thì nằm ở trang
// "Danh sách đơn hàng lỗi TMĐT" (/ecommerce/shopee-don-hang-loi-danh-sach) mà Sandbox không báo ai.
// Mỗi 2 tiếng máy chủ đọc danh sách đó bằng phiên web Sandbox (global.__sandboxAuth trong server.js)
// và nhắn đơn lỗi MỚI vào nhóm kho (global.__khoNotify, telegram-kho.js). Cũng báo khi gian hàng
// bị lỗi token (mất kết nối → Sandbox ngừng kéo đơn của gian hàng đó).
//
//  • Đơn lỗi:   orderlogistic/api/DonHang/CRM_GetOrderCreateError
//               { ecommerceCode: 'SHOPEE'|'TIKTOK', fromDate, toDate, pageInfo, sorts: [] (bắt buộc) }
//               → data[]: id, ecommerceCode, partnerOrderCode, unitConnectId, description, updatedDate
//  • Gian hàng: warehouse/api/UnitConnect/CRM_GetListUnitConnect { ecommerceCode, isErrorToken, keyword }
//  (lấy từ mã JS trang Sandbox 18/10/2026; lúc đó danh sách đơn lỗi trống nên chưa thấy đơn lỗi thật)
//
// Đã báo đơn nào thì nhớ id trong DATA_DIR/don-loi-san.json (ghi qua commit() — nhiều tiến trình,
// xem json-store.js). Tiến trình nào commit đánh dấu được đơn thì tiến trình đó gửi → không báo trùng.
// Gửi Telegram lỗi thì bỏ đánh dấu để lần sau gửi lại.
// Xem tình trạng / chạy ngay: /api/don-loi-san  (?check=1) — chỉ admin.

import path from 'node:path';
import { jsonStore } from './json-store.js';

const API = 'https://api.sandbox.com.vn/';
const SAN = { SHOPEE: 'Shopee', TIKTOK: 'TikTok' };
const EVERY_MS = 2 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 7;          // đọc đơn lỗi cập nhật trong 7 ngày gần nhất
const KEEP_SEEN_DAYS = 30;        // quên id đã báo sau 30 ngày

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const vnTime = iso => {
  const d = new Date(iso); if (isNaN(d)) return String(iso || '');
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
};

export function mountDonLoiSan(app, { DATA_DIR, fetchWithTimeout }) {
  const db = jsonStore(path.join(DATA_DIR, 'don-loi-san.json'),
    () => ({ seen: {}, shopErr: {}, runAt: '', last: null }), { mode: 0o644, tag: 'DONLOI' });

  async function sb(url, body) {
    const auth = global.__sandboxAuth;
    if (!auth || !auth.hasLogin()) throw new Error('Máy chủ chưa có tài khoản Sandbox (SANDBOX_WEB_USER/PASS).');
    const send = async () => {
      if (!auth.cookie()) await auth.login();
      return fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*',
          'Origin': auth.origin, 'Referer': auth.origin + '/', 'Cookie': auth.cookie(),
        },
        body: JSON.stringify(body),
      }, 30000);
    };
    let r = await send();
    if (r.status === 401 || r.status === 403) { await auth.login(); r = await send(); }
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error(`Sandbox HTTP ${r.status}: ${text.slice(0, 200)}`);
    if (!j || j.success === false) throw new Error('Sandbox báo lỗi: ' + ((j && j.message) || text.slice(0, 200)));
    return j;
  }

  const listShops = (ec, isErrorToken) =>
    sb(API + 'warehouse/api/UnitConnect/CRM_GetListUnitConnect', { ecommerceCode: ec, isErrorToken, keyword: '' })
      .then(j => j.data || []);

  async function listErrors(ec) {
    const toDate = new Date(), fromDate = new Date(Date.now() - LOOKBACK_DAYS * 864e5);
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const j = await sb(API + 'orderlogistic/api/DonHang/CRM_GetOrderCreateError', {
        keyword: '', ecommerceCode: ec, unitConnectId: null,
        fromDate: fromDate.toISOString(), toDate: toDate.toISOString(),
        pageInfo: { page, pageSize: 100 }, sorts: [],
      });
      const rows = j.data || [];
      out.push(...rows);
      if (rows.length < 100 || out.length >= (j.totalRecord || 0)) break;
    }
    return out;
  }

  async function check({ force = false } = {}) {
    // Nhiều tiến trình cùng hẹn giờ → chỉ một tiến trình chạy mỗi lượt
    const now = Date.now();
    const { out: go } = db.commit(s => {
      if (!force && s.runAt && now - Date.parse(s.runAt) < EVERY_MS / 2) return false;
      s.runAt = new Date(now).toISOString();
    });
    if (go === false) return { skipped: true };

    const result = { at: new Date().toISOString(), ok: true, donLoi: 0, moi: 0, guiLoi: '', loi: '' };
    try {
      const names = {}, items = [], shopsErr = [];
      for (const ec of Object.keys(SAN)) {
        for (const sh of await listShops(ec, false)) names[sh.id] = sh.connectName || sh.partnerUnitName || '';
        for (const sh of await listShops(ec, true)) shopsErr.push({ id: sh.id, ec, name: sh.connectName || sh.partnerUnitName || '' });
        for (const o of await listErrors(ec)) items.push({ ...o, ecommerceCode: o.ecommerceCode || ec });
      }
      result.donLoi = items.length;

      // Đánh dấu đơn mới + gian hàng mới lỗi token ngay trong commit → tiến trình khác không gửi trùng
      const stamp = new Date().toISOString();
      const { out: fresh } = db.commit(s => {
        const cut = Date.now() - KEEP_SEEN_DAYS * 864e5;
        for (const [id, at] of Object.entries(s.seen)) if (Date.parse(at) < cut) delete s.seen[id];
        const orders = items.filter(o => o.id && !s.seen[o.id]);
        orders.forEach(o => { s.seen[o.id] = stamp; });
        const shops = shopsErr.filter(x => !s.shopErr[x.id]);
        shops.forEach(x => { s.shopErr[x.id] = stamp; });
        // gian hàng hết lỗi token → xoá để lần lỗi sau báo lại
        for (const id of Object.keys(s.shopErr)) if (!shopsErr.some(x => x.id === id)) delete s.shopErr[id];
        return { orders, shops };
      });
      result.moi = fresh.orders.length;

      const lines = [];
      if (fresh.shops.length) {
        lines.push('⚠️ <b>Gian hàng mất kết nối trên Sandbox</b> (không kéo được đơn về):');
        fresh.shops.forEach(x => lines.push(`• ${SAN[x.ec]} — ${esc(x.name)}`));
      }
      if (fresh.orders.length) {
        if (lines.length) lines.push('');
        lines.push(`🚨 <b>${fresh.orders.length} đơn Shopee/TikTok bị lỗi trên Sandbox</b>`);
        for (const o of fresh.orders.slice(0, 30)) {
          const san = SAN[String(o.ecommerceCode).toUpperCase()] || o.ecommerceCode;
          const shop = names[o.unitConnectId] ? ' · ' + esc(names[o.unitConnectId]) : '';
          lines.push(`• <b>${san}</b> <code>${esc(o.partnerOrderCode)}</code>${shop} · ${vnTime(o.updatedDate)}`);
          if (o.description) lines.push('   ↳ ' + esc(String(o.description).slice(0, 300)));
        }
        if (fresh.orders.length > 30) lines.push(`… và ${fresh.orders.length - 30} đơn khác`);
        lines.push('Xem: Sandbox → TMĐT → Danh sách đơn hàng lỗi TMĐT');
      }
      if (lines.length) {
        const r = typeof global.__khoNotify === 'function'
          ? await global.__khoNotify(lines.join('\n')) : { ok: false, error: 'Chưa có bot nhóm kho.' };
        if (!r.ok) {
          result.guiLoi = r.error || 'Không gửi được Telegram';
          // bỏ đánh dấu để lần sau gửi lại
          db.commit(s => {
            fresh.orders.forEach(o => { if (s.seen[o.id] === stamp) delete s.seen[o.id]; });
            fresh.shops.forEach(x => { if (s.shopErr[x.id] === stamp) delete s.shopErr[x.id]; });
          });
        }
      }
    } catch (e) {
      result.ok = false; result.loi = e.message;
      console.error('[DONLOI]', e.message);
    }
    db.commit(s => { s.last = result; });
    return result;
  }

  app.get('/api/don-loi-san', async (req, res) => {
    if (((req.session && req.session.user) || {}).role !== 'admin') return res.status(403).json({ ok: false });
    const ran = req.query.check ? await check({ force: true }) : null;
    const s = db.read();
    res.json({ ok: true, chayNgay: ran, lanCuoi: s.last, daBao: Object.keys(s.seen).length, ganHangLoiToken: s.shopErr });
  });

  setTimeout(() => check().catch(() => {}), 60 * 1000);
  setInterval(() => check().catch(() => {}), EVERY_MS);
  console.log('[DONLOI] theo dõi đơn lỗi Shopee/TikTok mỗi 2 tiếng');
}
