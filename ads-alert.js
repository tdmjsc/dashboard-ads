// ads-alert.js — BOT TELEGRAM CẢNH BÁO CHIẾN DỊCH ĐẮT + TẮT/BẬT/ĐỔI NGÂN SÁCH NGAY TRÊN TELEGRAM
//
//  • Token bot riêng trong .env:  TELEGRAM_ADS_ALERT_BOT_TOKEN=<token BotFather cấp>. Không có token thì tắt.
//  • Mỗi tài khoản đăng nhập tự kết nối Telegram ở trang /ads-alert.html (nút mở bot với mã 1 lần
//    → bot nhận /start <mã> → ghi chat của người đó). NV nhận camp của mình (gồm team nếu là lead),
//    admin nhận mọi camp (tắt được trong cài đặt).
//  • "Đắt" = chi tiêu hôm nay > ngưỡng CP/kết quả × max(kết quả, 1). Kết quả = đơn về OMS (như cột Kết quả
//    trang Ads); camp tin nhắn chưa có đơn OMS thì dùng kết quả Meta. Mỗi camp báo 1 lần / ngày, báo lại khi
//    tiêu thêm ≥ 1 lần ngưỡng mà vẫn đắt.
//  • Nút trên tin: Tắt / Bật camp, −/+ x% ngân sách, nhập ngân sách mới, xem số mới nhất. Trước mỗi thao tác
//    máy chủ đọc lại camp từ Meta và kiểm tra người bấm có quyền với camp đó (theo tên NV trong tên camp).
//    Ghi lên Meta cần token có quyền ads_management (xem /api/ads-alert?perm=1).
//  • Nhận tin qua webhook /tg-ads/webhook (loại trừ khỏi middleware đăng nhập, kiểm tra secret_token).
//  • Dữ liệu ở DATA_DIR/ads-alert.json theo cách nhiều tiến trình (json-store.js). Lượt kiểm tra được "giành"
//    qua commit (lastRun) nên nhiều tiến trình không cùng gọi Meta / không báo trùng.

import path from 'node:path';
import crypto from 'node:crypto';
import { jsonStore } from './json-store.js';

const TG_MAX = 4000;
const LOG_MAX = 200;
const CFG_DEFAULT = {
  on: false,          // bật kiểm tra tự động
  cprMax: 150000,     // ngưỡng CP / kết quả (đ)
  everyMin: 30,       // kiểm tra mỗi … phút
  fromHour: 8,        // chỉ kiểm tra trong khung giờ VN [fromHour, toHour)
  toHour: 23,
  step: 20,           // nút −/+ đổi ngân sách …%
  maxBudget: 20000000, // chặn nhập nhầm (thừa số 0): ngân sách/ngày tối đa đặt qua bot
  adminAll: true,     // admin nhận cảnh báo mọi camp
};

const fmt = n => Math.round(Number(n) || 0).toLocaleString('vi-VN');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const vnNow = () => new Date(Date.now() + 7 * 3600e3);
const vnDay = () => vnNow().toISOString().slice(0, 10);
const hhmm = () => vnNow().toISOString().slice(11, 16);

export function mountAdsAlert(app, {
  express, DATA_DIR, fetchWithTimeout,
  getCampaigns,        // (since, until) → campaigns của trang Ads (cache RAM 3 phút)
  fbGet, fbPost,       // Graph API: đọc / ghi
  tokenForAcc,         // acc → token Meta quản lý tài khoản đó
  employeesOfLogin,    // tên đăng nhập → { role, employees } (gồm team của lead)
  detectEmployee,      // tên camp → tên NV
  accountName = acc => acc, // id TK quảng cáo → tên BM
  token = process.env.TELEGRAM_ADS_ALERT_BOT_TOKEN || '',
}) {
  const FILE = path.join(DATA_DIR, 'ads-alert.json');
  const db = jsonStore(FILE, () => ({ cfg: { ...CFG_DEFAULT }, links: {}, codes: {}, sent: {}, pending: {}, lastRun: null, log: [] }), { tag: 'ADSALERT' });
  let STORE = db.read();
  const reload = () => { STORE = db.read(); STORE.cfg = { ...CFG_DEFAULT, ...STORE.cfg }; };
  const commit = fn => { const r = db.commit(fn); STORE = r.s; STORE.cfg = { ...CFG_DEFAULT, ...STORE.cfg }; return r.out; };
  reload();
  const SECRET = token ? crypto.createHash('sha256').update('tg-ads:' + token).digest('hex').slice(0, 48) : '';
  let me = null;

  async function tg(method, body) {
    if (!token) return { ok: false, description: 'Chưa khai TELEGRAM_ADS_ALERT_BOT_TOKEN trên máy chủ.' };
    try {
      const r = await fetchWithTimeout(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      return await r.json().catch(() => ({ ok: false, description: 'Telegram trả về dữ liệu lạ (HTTP ' + r.status + ')' }));
    } catch (e) {
      return { ok: false, description: 'Không kết nối được tới Telegram.' }; // không để lộ token trong URL
    }
  }
  const say = (chatId, text, extra = {}) => tg('sendMessage', {
    chat_id: chatId, text: text.length > TG_MAX ? text.slice(0, TG_MAX - 1) + '…' : text,
    parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
  });
  const addLog = e => commit(s => { s.log = [{ at: new Date().toISOString(), ...e }, ...(s.log || [])].slice(0, LOG_MAX); });

  /* ---------- Số liệu hôm nay ---------- */
  // Kết quả = đơn OMS (như cột Kết quả trang Ads); camp tin nhắn chưa có đơn OMS → kết quả Meta.
  async function omsToday(day) {
    if (typeof global.__omsAdStats !== 'function') return null;
    try {
      const st = await global.__omsAdStats(day, day);
      if (!st) return null;
      const by = {};
      for (const r of st.rows) if (r.fb_campaign_id) by[r.fb_campaign_id] = (by[r.fb_campaign_id] || 0) + r.don;
      return by;
    } catch (e) { console.error('[ADSALERT] đọc OMS lỗi:', e.message); return null; }
  }
  function statOf(c, oms) {
    const spend = (c.daily || []).reduce((t, d) => t + (d.spent || 0), 0);
    const meta = (c.daily || []).reduce((t, d) => t + (d.results || 0), 0);
    const don = oms ? (oms[String(c.id)] || 0) : 0;
    const useOms = !!oms && (don > 0 || c.obj !== 'tin nhắn');
    const res = useOms ? don : meta;
    const label = useOms ? 'đơn OMS' : (c.obj || 'kết quả') + ' (Meta)';
    return { spend, res, label, cpr: res ? spend / res : null };
  }
  const isExpensive = (st, cfg) => cfg.cprMax > 0 && st.spend > cfg.cprMax * Math.max(st.res, 1);

  function alertText(c, st, cfg, head = '⚠️ <b>Camp đang đắt</b>') {
    const budget = c.budget ? `${fmt(c.budget)} đ/ngày` : 'chưa rõ';
    return `${head}\n<b>${esc(c.name)}</b>\n`
      + `NV: ${esc(c.employee)} · ${esc(c.accName || c.acc)}\n`
      + `Hôm nay (đến ${hhmm()}): chi <b>${fmt(st.spend)} đ</b> · <b>${st.res}</b> ${esc(st.label)}\n`
      + `CP/kết quả: <b>${st.cpr == null ? 'chưa có kết quả' : fmt(st.cpr) + ' đ'}</b> (ngưỡng ${fmt(cfg.cprMax)} đ)\n`
      + `Ngân sách: ${budget} · ${c.on ? '🟢 đang chạy' : '⚪️ đang tắt'}`;
  }
  function keyboard(acc, camp, on, step) {
    const d = a => `a|${a}|${acc}|${camp}`;
    return { inline_keyboard: [
      [on ? { text: '⏸ Tắt camp', callback_data: d('off') } : { text: '▶️ Bật camp', callback_data: d('on') },
        { text: '🔄 Số mới nhất', callback_data: d('ref') }],
      [{ text: `➖ ${step}% NS`, callback_data: d('dn') }, { text: `➕ ${step}% NS`, callback_data: d('up') },
        { text: '✏️ Nhập NS', callback_data: d('set') }],
    ] };
  }

  // Ai nhận cảnh báo của camp c: NV có camp (gồm lead của team), admin nếu adminAll
  function recipients(c, cfg) {
    const out = [];
    for (const [login, l] of Object.entries(STORE.links || {})) {
      const who = employeesOfLogin(login);
      if (!who || !l.chatId) continue;
      if (who.role === 'admin' ? cfg.adminAll : (who.employees || []).includes(c.employee)) out.push(l.chatId);
    }
    return out;
  }

  /* ---------- Kiểm tra ---------- */
  // send=false: chỉ tính (xem trước), không gửi, không đánh dấu
  async function check({ send = true } = {}) {
    reload();
    const cfg = STORE.cfg;
    const day = vnDay();
    const [camps, oms] = await Promise.all([getCampaigns(day, day), omsToday(day)]);
    const list = [];
    for (const c of camps || []) {
      if (!c.on) continue;
      const st = statOf(c, oms);
      if (!isExpensive(st, cfg)) continue;
      list.push({ c, st });
    }
    if (!send) return { day, oms: !!oms, list: list.map(({ c, st }) => ({ id: c.id, ten: c.name, nv: c.employee, ...st, nguoiNhan: recipients(c, cfg).length })) };

    let n = 0;
    for (const { c, st } of list) {
      const id = String(c.id);
      // Đánh dấu trước khi gửi (nhiều tiến trình không báo trùng). Báo lại khi tiêu thêm ≥ 1 ngưỡng mà vẫn đắt.
      const go = commit(s => {
        const today = (s.sent[day] ||= {});
        const prev = today[id];
        if (prev && st.spend < prev.spend + cfg.cprMax) return false;
        today[id] = { at: new Date().toISOString(), spend: st.spend, res: st.res };
        for (const d of Object.keys(s.sent)) if (d < day) delete s.sent[d];
      });
      if (go === false) continue;
      const to = recipients(c, cfg);
      for (const chatId of to) {
        const j = await say(chatId, alertText(c, st, cfg), { reply_markup: keyboard(c.acc, id, c.on, cfg.step) });
        if (!j.ok) addLog({ who: 'bot', camp: id, ten: c.name, viec: 'gửi cảnh báo', ok: false, loi: j.description || 'Telegram từ chối' });
        else n++;
      }
    }
    return { day, oms: !!oms, dat: list.length, daGui: n };
  }

  async function tick() {
    reload();
    const cfg = STORE.cfg;
    if (!token || !cfg.on) return;
    const h = vnNow().getUTCHours();
    if (h < cfg.fromHour || h >= cfg.toHour) return;
    const every = Math.max(10, Number(cfg.everyMin) || 30) * 60e3;
    // Giành lượt: chỉ 1 tiến trình chạy mỗi lượt
    const claimed = commit(s => {
      if (s.lastRun && Date.now() - Date.parse(s.lastRun.at) < every - 30e3) return false;
      s.lastRun = { at: new Date().toISOString(), pid: process.pid };
    });
    if (claimed === false) return;
    let r;
    try { r = await check(); } catch (e) { r = { loi: e.message }; }
    commit(s => { s.lastRun = { ...(s.lastRun || {}), xong: new Date().toISOString(), ...r }; });
  }
  setInterval(() => tick().catch(e => console.error('[ADSALERT] lỗi:', e.message)), 60e3).unref?.();

  /* ---------- Thao tác trên Meta từ nút bấm ---------- */
  const userOfTg = tgId => Object.entries(STORE.links || {}).find(([, l]) => String(l.tgId) === String(tgId));
  const metaMsg = e => /ads_management|\(#200\)|permission/i.test(e.message || '')
    ? 'Token Meta chưa có quyền ads_management (sửa chiến dịch). Báo admin tạo lại token.'
    : (e.message || 'Lỗi Meta');

  // Đọc camp từ Meta + kiểm tra quyền người bấm. Trả { camp, tk, who } hoặc ném lỗi dễ hiểu.
  async function loadCamp(tgId, acc, campId) {
    reload();
    const link = userOfTg(tgId);
    if (!link) throw new Error('Telegram này chưa kết nối tài khoản dashboard (trang Cảnh báo Telegram).');
    const who = employeesOfLogin(link[0]);
    if (!who) throw new Error('Tài khoản dashboard không còn tồn tại.');
    const tk = tokenForAcc(acc);
    if (!tk) throw new Error('Không có token cho tài khoản quảng cáo này.');
    const camp = await fbGet(campId, { fields: 'id,name,account_id,effective_status,daily_budget,lifetime_budget' }, tk);
    if (String(camp.account_id) !== String(acc)) throw new Error('Camp không thuộc tài khoản quảng cáo này.');
    const nv = detectEmployee(camp.name || '');
    if (who.role !== 'admin' && !(who.employees || []).includes(nv)) throw new Error('Bạn không có quyền với camp này.');
    return { camp, tk, who: link[0] };
  }

  // Ngân sách: camp dùng ngân sách chiến dịch (CBO) thì sửa camp; không thì sửa các nhóm đang chạy có ngân sách ngày.
  async function budgetTargets(camp, tk) {
    if (camp.lifetime_budget && Number(camp.lifetime_budget) > 0) throw new Error('Camp dùng ngân sách trọn đời — đổi trên Ads Manager.');
    if (camp.daily_budget && Number(camp.daily_budget) > 0) return [{ id: camp.id, name: 'camp', budget: Number(camp.daily_budget) }];
    const r = await fbGet(`${camp.id}/adsets`, { fields: 'id,name,daily_budget,lifetime_budget,effective_status', limit: 200 }, tk);
    const sets = (r.data || []).filter(a => a.effective_status === 'ACTIVE' && Number(a.daily_budget) > 0);
    if (!sets.length) throw new Error('Không tìm thấy nhóm đang chạy có ngân sách ngày.');
    return sets.map(a => ({ id: a.id, name: a.name, budget: Number(a.daily_budget) }));
  }
  async function setBudgets(targets, newOf, tk, maxBudget) {
    const plan = targets.map(t => ({ ...t, moi: Math.max(1000, Math.round(newOf(t.budget) / 1000) * 1000) }));
    const over = plan.find(p => p.moi > maxBudget);
    if (over) throw new Error(`Ngân sách mới ${fmt(over.moi)} đ vượt mức tối đa ${fmt(maxBudget)} đ cho phép qua bot.`);
    const done = [];
    for (const p of plan) {
      await fbPost(p.id, { daily_budget: String(p.moi) }, tk);
      done.push(`${p.name === 'camp' ? 'Camp' : 'Nhóm ' + esc(p.name)}: ${fmt(p.budget)} → <b>${fmt(p.moi)} đ</b>`);
    }
    return done.join('\n');
  }

  async function campStatus(acc, campId) {
    const day = vnDay();
    const [camps, oms] = await Promise.all([getCampaigns(day, day), omsToday(day)]);
    const c = (camps || []).find(x => String(x.id) === String(campId) && String(x.acc) === String(acc));
    return c ? { c, st: statOf(c, oms) } : null;
  }

  async function onCallback(cq) {
    const [, act, acc, campId] = String(cq.data || '').split('|');
    const chatId = cq.message && cq.message.chat.id;
    const answer = text => tg('answerCallbackQuery', { callback_query_id: cq.id, text: String(text).slice(0, 190), show_alert: text.length > 60 });
    if (!/^\d+$/.test(acc || '') || !/^\d+$/.test(campId || '')) return answer('Nút không hợp lệ.');
    let ctx;
    try { ctx = await loadCamp(cq.from.id, acc, campId); }
    catch (e) { return answer(metaMsg(e)); }
    const { camp, tk, who } = ctx;
    const cfg = STORE.cfg;
    const reply = (text, extra) => say(chatId, text, { reply_to_message_id: cq.message.message_id, allow_sending_without_reply: true, ...extra });
    const log = (viec, ok, loi) => addLog({ who, camp: campId, ten: camp.name, viec, ok, loi });
    try {
      if (act === 'off' || act === 'on') {
        await fbPost(campId, { status: act === 'off' ? 'PAUSED' : 'ACTIVE' }, tk);
        const txt = act === 'off' ? '⏸ Đã TẮT camp' : '▶️ Đã BẬT camp';
        log(txt.slice(2), true);
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: keyboard(acc, campId, act === 'on', cfg.step) });
        await answer(txt);
        await reply(`${txt} <b>${esc(camp.name)}</b>\n(${esc(who)} lúc ${hhmm()})`);
      } else if (act === 'dn' || act === 'up') {
        const k = 1 + (act === 'up' ? 1 : -1) * cfg.step / 100;
        const done = await setBudgets(await budgetTargets(camp, tk), b => b * k, tk, cfg.maxBudget);
        log(`Ngân sách ${act === 'up' ? '+' : '−'}${cfg.step}%`, true);
        await answer('Đã đổi ngân sách');
        await reply(`💰 Đổi ngân sách <b>${esc(camp.name)}</b> (${act === 'up' ? '+' : '−'}${cfg.step}%):\n${done}\n(${esc(who)} lúc ${hhmm()})`);
      } else if (act === 'set') {
        const targets = await budgetTargets(camp, tk);
        if (targets.length > 1) return answer(`Camp có ${targets.length} nhóm đang chạy với ngân sách riêng — dùng nút −/+ % hoặc đổi trên Ads Manager.`);
        commit(s => { s.pending[String(chatId)] = { acc, camp: campId, exp: Date.now() + 10 * 60e3 }; });
        await answer('Gõ ngân sách mới');
        await reply(`✏️ Gõ ngân sách/ngày mới cho <b>${esc(camp.name)}</b> (hiện ${fmt(targets[0].budget)} đ), vd <code>500000</code> hoặc <code>500k</code>. Hết hạn sau 10 phút.`,
          { reply_markup: { force_reply: true, selective: true } });
      } else if (act === 'ref') {
        await answer('Đang lấy số mới…');
        const s = await campStatus(acc, campId);
        if (!s) return reply(`Hôm nay chưa có số liệu chi tiêu cho <b>${esc(camp.name)}</b>.`);
        s.c.on = camp.effective_status === 'ACTIVE';
        await reply(alertText(s.c, s.st, cfg, '🔄 <b>Số mới nhất</b>'), { reply_markup: keyboard(acc, campId, s.c.on, cfg.step) });
      } else return answer('Nút không hợp lệ.');
    } catch (e) {
      log(act, false, metaMsg(e));
      await answer(metaMsg(e));
    }
  }

  // "500000", "500.000", "500k", "1,2tr" → số đồng
  function parseMoney(t) {
    const m = String(t || '').trim().toLowerCase().replace(/\s+/g, '').match(/^(\d+(?:[.,]\d+)*)(k|tr|triệu|m)?đ?$/);
    if (!m) return null;
    let s = m[1];
    if (m[2]) s = s.replace(',', '.');                 // 1,5tr = 1.5 triệu
    else s = s.replace(/[.,]/g, '');                   // 500.000 = 500000
    const v = Number(s) * (m[2] === 'k' ? 1e3 : m[2] ? 1e6 : 1);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  }

  async function onMessage(msg) {
    if (!msg.chat || msg.chat.type !== 'private') return;
    const chatId = String(msg.chat.id);
    const text = String(msg.text || '').trim();
    const start = text.match(/^\/start(?:\s+([A-Za-z0-9_-]{8,64}))?$/);
    if (start) {
      if (!start[1]) return say(chatId, 'Chào bạn! Để nhận cảnh báo camp đắt, mở dashboard → <b>🔔 Cảnh báo Telegram</b> → bấm <b>Kết nối Telegram</b>.');
      const code = start[1], now = Date.now();
      const tgName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || '';
      const login = commit(s => {
        const c = s.codes[code];
        for (const [k, v] of Object.entries(s.codes)) if (v.exp < now) delete s.codes[k];
        if (!c || c.exp < now) return false;
        delete s.codes[code];
        for (const [k, l] of Object.entries(s.links)) if (String(l.tgId) === String(msg.from.id)) delete s.links[k]; // 1 Telegram ↔ 1 tài khoản
        s.links[c.user] = { chatId, tgId: String(msg.from.id), tgName, username: msg.from.username || '', at: new Date().toISOString() };
        return c.user;
      });
      if (login === false) return say(chatId, 'Mã kết nối sai hoặc đã hết hạn. Mở lại trang Cảnh báo Telegram và bấm Kết nối lần nữa.');
      return say(chatId, `✅ Đã kết nối với tài khoản dashboard <b>${esc(login)}</b>. Bot sẽ báo khi camp của bạn đắt hơn ngưỡng ${fmt(STORE.cfg.cprMax)} đ/kết quả.`);
    }
    if (text === '/huy') {
      const had = commit(s => { const k = Object.keys(s.links).find(k => String(s.links[k].tgId) === String(msg.from.id)); if (!k) return false; delete s.links[k]; return k; });
      return say(chatId, had === false ? 'Telegram này chưa kết nối tài khoản nào.' : 'Đã huỷ kết nối. Bot sẽ không báo nữa.');
    }
    // Trả lời ngân sách mới sau khi bấm ✏️
    reload();
    const p = STORE.pending[chatId];
    if (!p) return;
    if (p.exp < Date.now()) { commit(s => { delete s.pending[chatId]; }); return say(chatId, 'Đã quá 10 phút — bấm ✏️ Nhập NS lại nhé.'); }
    const v = parseMoney(text);
    if (!v) return say(chatId, 'Không đọc được số tiền. Gõ vd <code>500000</code> hoặc <code>500k</code>.');
    commit(s => { delete s.pending[chatId]; });
    let ctx;
    try {
      ctx = await loadCamp(msg.from.id, p.acc, p.camp);
      const targets = await budgetTargets(ctx.camp, ctx.tk);
      if (targets.length > 1) throw new Error('Camp có nhiều nhóm với ngân sách riêng — dùng nút −/+ %.');
      const done = await setBudgets(targets, () => v, ctx.tk, STORE.cfg.maxBudget);
      addLog({ who: ctx.who, camp: p.camp, ten: ctx.camp.name, viec: `Đặt ngân sách ${fmt(v)} đ`, ok: true });
      return say(chatId, `💰 <b>${esc(ctx.camp.name)}</b>\n${done}\n(${esc(ctx.who)} lúc ${hhmm()})`);
    } catch (e) {
      addLog({ who: ctx ? ctx.who : String(msg.from.id), camp: p.camp, ten: ctx ? ctx.camp.name : '', viec: 'Đặt ngân sách', ok: false, loi: metaMsg(e) });
      return say(chatId, '❌ ' + esc(metaMsg(e)));
    }
  }

  // Webhook Telegram (đã loại trừ khỏi middleware đăng nhập trong server.js)
  app.post('/tg-ads/webhook', express.json({ limit: '1mb' }), (req, res) => {
    if (!SECRET || req.get('x-telegram-bot-api-secret-token') !== SECRET) return res.sendStatus(403);
    res.sendStatus(200);
    const u = req.body || {};
    const job = u.callback_query ? onCallback(u.callback_query) : u.message ? onMessage(u.message) : null;
    if (job) job.catch(e => console.error('[ADSALERT] xử lý tin lỗi:', e.message));
  });

  /* ---------- API cho trang /ads-alert.html ---------- */
  const user = req => (req.session && req.session.user) || {};
  const isAdmin = req => user(req).role === 'admin';

  app.get('/api/ads-alert/me', (req, res) => {
    reload();
    const l = STORE.links[user(req).user];
    res.json({ ok: true, bat: !!token, bot: me && me.username, admin: isAdmin(req), daKetNoi: !!l, tgName: l ? (l.tgName || l.username) : '', cprMax: STORE.cfg.cprMax, tuDong: STORE.cfg.on });
  });
  app.post('/api/ads-alert/link', (req, res) => {
    if (!token || !me) return res.json({ ok: false, error: 'Bot cảnh báo chưa bật trên máy chủ.' });
    const code = crypto.randomBytes(12).toString('hex');
    const login = user(req).user;
    commit(s => { s.codes[code] = { user: login, exp: Date.now() + 15 * 60e3 }; });
    res.json({ ok: true, url: `https://t.me/${me.username}?start=${code}` });
  });
  app.post('/api/ads-alert/unlink', (req, res) => {
    const login = user(req).user;
    commit(s => { if (!s.links[login]) return false; delete s.links[login]; });
    res.json({ ok: true });
  });

  // Admin: cài đặt, người đã kết nối, lượt chạy gần nhất, nhật ký; ?perm=1 kiểm tra quyền token Meta
  app.get('/api/ads-alert', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false });
    reload();
    const out = {
      ok: true, bat: !!token, bot: me && me.username, cfg: STORE.cfg, lastRun: STORE.lastRun, log: STORE.log,
      links: Object.entries(STORE.links).map(([login, l]) => {
        const w = employeesOfLogin(login);
        return { login, tgName: l.tgName || l.username, at: l.at, role: w && w.role, nv: w ? w.employees : [] };
      }),
    };
    if (req.query.perm === '1') out.perm = await tokenPerms();
    res.json(out);
  });
  app.post('/api/ads-alert/cfg', express.json(), (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false });
    const b = req.body || {};
    const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : undefined; };
    const patch = {
      on: typeof b.on === 'boolean' ? b.on : undefined,
      adminAll: typeof b.adminAll === 'boolean' ? b.adminAll : undefined,
      cprMax: num(b.cprMax, 0, 1e9), everyMin: num(b.everyMin, 10, 720),
      fromHour: num(b.fromHour, 0, 23), toHour: num(b.toHour, 1, 24),
      step: num(b.step, 5, 100), maxBudget: num(b.maxBudget, 10000, 1e10),
    };
    commit(s => { s.cfg = { ...CFG_DEFAULT, ...s.cfg }; for (const [k, v] of Object.entries(patch)) if (v !== undefined) s.cfg[k] = v; });
    res.json({ ok: true, cfg: STORE.cfg });
  });
  // Xem trước camp đang đắt (không gửi). ?send=1: kiểm tra + gửi ngay (bỏ qua giờ / lượt).
  app.get('/api/ads-alert/check', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false });
    try { res.json({ ok: true, ...(await check({ send: req.query.send === '1' })) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Quyền của từng token Meta: cần ads_management để tắt/bật/đổi ngân sách. Kèm tên biến .env, tên tự đặt
  // (TOKEN_n_NAME), chủ token trên Facebook và tên BM của các TK quảng cáo để biết token nào là của BM nào.
  async function tokenPerms() {
    const out = [];
    for (const { token: tk, accounts, key, label } of tokenForAcc.sources()) {
      const row = { bien: key, ten: label, taiKhoan: accounts.map(a => `${accountName(a)} (${a})`) };
      try {
        const [owner, r] = await Promise.all([
          fbGet('me', { fields: 'id,name' }, tk).catch(() => ({})),
          fbGet('me/permissions', {}, tk),
        ]);
        const granted = (r.data || []).filter(p => p.status === 'granted').map(p => p.permission);
        out.push({ ...row, chu: owner.name || '', adsManagement: granted.includes('ads_management'), quyen: granted });
      } catch (e) { out.push({ ...row, loi: e.message }); }
    }
    return out;
  }

  if (!token) { console.log('[ADSALERT] chưa khai TELEGRAM_ADS_ALERT_BOT_TOKEN → tắt bot cảnh báo camp'); return; }
  (async () => {
    const g = await tg('getMe');
    if (g.ok) me = g.result;
    const url = (process.env.TG_ADS_PUBLIC_URL || 'https://ads.tdmjsc.com').replace(/\/+$/, '') + '/tg-ads/webhook';
    const w = await tg('setWebhook', { url, secret_token: SECRET, allowed_updates: ['message', 'callback_query'] });
    console.log('[ADSALERT] bot', me ? '@' + me.username : '?', '— webhook', w.ok ? 'OK' : 'lỗi: ' + w.description);
  })().catch(e => console.error('[ADSALERT] khởi động lỗi:', e.message));
}
