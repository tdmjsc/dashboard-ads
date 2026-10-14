// telegram-all.js — BOT "CHAT ALL" CHO NHÓM TELEGRAM (giống @All của Zalo / Facebook)
//
// Thêm bot vào nhóm bất kỳ. Ai gõ tin có "@all" hoặc lệnh /all → bot trả lời bằng tin
// nhắc tên (mention) mọi thành viên, nên ai cũng nhận thông báo kể cả khi đã tắt chuông nhóm.
//
//  • Token bot đặt trong .env:  TELEGRAM_ALL_BOT_TOKEN=<token BotFather cấp>
//    (tách riêng với bot lương / bot kho).
//  • Telegram KHÔNG cho bot lấy danh sách thành viên nhóm → bot tự ghi nhớ người đã nhắn
//    trong nhóm, người mới vào nhóm, và (nếu bot là admin) người vào/rời nhóm.
//    Muốn bot thấy mọi tin nhắn (và "@all" không có dấu /) phải TẮT chế độ riêng tư:
//    BotFather → /setprivacy → chọn bot → Disable (rồi xoá bot khỏi nhóm, thêm lại), hoặc cho bot làm admin.
//  • Nhận tin qua webhook: máy chủ tự gọi setWebhook tới <TG_ALL_PUBLIC_URL>/tg-all/webhook
//    (mặc định https://ads.tdmjsc.com), kiểm tra header secret_token.
//  • Thành viên lưu ở DATA_DIR/tg-all.json. Xem tình trạng: GET /api/tg-all (admin).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TG_MAX = 4000;          // Telegram giới hạn 4096 ký tự / tin
const MENTION_PER_MSG = 5;    // Telegram chỉ báo cho vài người được nhắc đầu tiên trong 1 tin → chia nhỏ
const COOLDOWN_MS = 30 * 1000; // mỗi nhóm gọi @all tối đa 1 lần / 30 giây (chống spam)

export function mountTgAll(app, { express, DATA_DIR, fetchWithTimeout, token = process.env.TELEGRAM_ALL_BOT_TOKEN || '' }) {
  const FILE = path.join(DATA_DIR, 'tg-all.json');
  // { chats: { [chatId]: { title, members: { [userId]: { name, username, at } } } } }
  let STORE = { chats: {} };
  try { STORE = { chats: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(FILE, JSON.stringify(STORE)); }
      catch (e) { console.error('[TGALL] lưu file lỗi:', e.message); }
    }, 2000);
  };
  const SECRET = token ? crypto.createHash('sha256').update('tg-all:' + token).digest('hex').slice(0, 48) : '';
  const lastCall = {};   // chatId → thời điểm gọi @all gần nhất
  let me = null;         // thông tin bot (getMe)

  async function tg(method, body) {
    if (!token) return { ok: false, description: 'Chưa khai TELEGRAM_ALL_BOT_TOKEN trên máy chủ.' };
    try {
      const r = await fetchWithTimeout(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      return await r.json().catch(() => ({ ok: false, description: 'Telegram trả về dữ liệu lạ (HTTP ' + r.status + ')' }));
    } catch (e) {
      // Không để lộ token (nằm trong URL) qua thông báo lỗi
      return { ok: false, description: 'Không kết nối được tới Telegram.' };
    }
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nameOf = u => [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || (u.username ? '@' + u.username : 'Thành viên');
  const chatOf = c => {
    const id = String(c.id);
    if (!STORE.chats[id]) STORE.chats[id] = { title: '', members: {} };
    if (c.title) STORE.chats[id].title = c.title;
    return STORE.chats[id];
  };
  function remember(chat, u) {
    if (!u || u.is_bot) return;
    const m = chatOf(chat).members, id = String(u.id), name = nameOf(u), username = u.username || '';
    const old = m[id];
    if (old && old.name === name && old.username === username && Date.now() - Date.parse(old.at) < 864e5) return;
    m[id] = { name, username, at: new Date().toISOString() };
    save();
  }
  function forget(chat, u) {
    const c = STORE.chats[String(chat.id)];
    if (c && u && c.members[String(u.id)]) { delete c.members[String(u.id)]; save(); }
  }

  // "@all" ở bất kỳ đâu trong tin, hoặc lệnh /all (kể cả /all@tenbot)
  function isCallAll(text) {
    if (!text) return false;
    if (/(^|[\s(])@all(?![\p{L}\p{N}_])/iu.test(text)) return true;
    const m = text.match(/^\/all(?:@(\w+))?(?:\s|$)/i);
    return !!m && (!m[1] || !me || m[1].toLowerCase() === String(me.username || '').toLowerCase());
  }

  async function callAll(msg) {
    const chatId = String(msg.chat.id);
    const now = Date.now();
    if (now - (lastCall[chatId] || 0) < COOLDOWN_MS) return;
    lastCall[chatId] = now;
    const members = Object.entries((STORE.chats[chatId] || {}).members || {})
      .filter(([id]) => id !== String(msg.from && msg.from.id));
    const reply = { reply_to_message_id: msg.message_id, allow_sending_without_reply: true };
    if (!members.length) {
      await tg('sendMessage', { chat_id: chatId, ...reply, text: 'Bot chưa biết thành viên nào khác trong nhóm. Mỗi người cần nhắn ít nhất 1 tin trong nhóm sau khi thêm bot'
        + (me && me.can_read_all_group_messages === false ? ' (bot đang bật chế độ riêng tư: tắt ở BotFather → /setprivacy, hoặc cho bot làm admin).' : '.') });
      return;
    }
    const tags = members.map(([id, m]) => `<a href="tg://user?id=${id}">${esc(m.name)}</a>`);
    for (let i = 0; i < tags.length; i += MENTION_PER_MSG) {
      let text = (i === 0 ? '📢 ' : '') + tags.slice(i, i + MENTION_PER_MSG).join(', ');
      if (text.length > TG_MAX) text = text.slice(0, TG_MAX);
      const j = await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true, ...(i === 0 ? reply : {}), text });
      if (!j.ok) { console.error('[TGALL] gửi tin lỗi:', j.description); break; }
    }
  }

  async function onUpdate(u) {
    const msg = u.message || u.edited_message;
    if (msg && msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
      // Nhóm được nâng lên siêu nhóm → Telegram đổi Chat ID: chuyển danh sách sang id mới
      if (msg.migrate_to_chat_id) {
        const oldId = String(msg.chat.id), newId = String(msg.migrate_to_chat_id);
        if (STORE.chats[oldId]) { STORE.chats[newId] = STORE.chats[oldId]; delete STORE.chats[oldId]; save(); }
        return;
      }
      remember(msg.chat, msg.from);
      for (const m of msg.new_chat_members || []) remember(msg.chat, m);
      if (msg.left_chat_member) forget(msg.chat, msg.left_chat_member);
      if (u.message && isCallAll(msg.text || msg.caption)) await callAll(msg);
      return;
    }
    // Bot là admin thì nhận được cả người vào/rời nhóm
    if (u.chat_member) {
      const { chat, new_chat_member: n } = u.chat_member;
      if (['member', 'administrator', 'creator', 'restricted'].includes(n.status)) remember(chat, n.user);
      else if (['left', 'kicked'].includes(n.status)) forget(chat, n.user);
      return;
    }
    // Bot bị xoá khỏi nhóm → bỏ danh sách nhóm đó
    if (u.my_chat_member) {
      const { chat, new_chat_member: n } = u.my_chat_member;
      if (['left', 'kicked'].includes(n.status) && STORE.chats[String(chat.id)]) { delete STORE.chats[String(chat.id)]; save(); }
      else if (chat.title) { chatOf(chat); save(); }
    }
  }

  // Webhook Telegram gọi tới (đã loại trừ khỏi middleware đăng nhập trong server.js)
  app.post('/tg-all/webhook', express.json({ limit: '1mb' }), (req, res) => {
    if (!SECRET || req.get('x-telegram-bot-api-secret-token') !== SECRET) return res.sendStatus(403);
    res.sendStatus(200);   // trả lời ngay, xử lý sau để Telegram không gửi lại
    onUpdate(req.body || {}).catch(e => console.error('[TGALL] xử lý tin lỗi:', e.message));
  });

  // Tình trạng bot + các nhóm đã biết (admin)
  app.get('/api/tg-all', async (req, res) => {
    if (((req.session && req.session.user) || {}).role !== 'admin') return res.status(403).json({ ok: false });
    const info = token ? await tg('getWebhookInfo') : null;
    res.json({
      ok: !!token, bot: me && { username: me.username, docMoiTinNhom: me.can_read_all_group_messages },
      webhook: info && info.result && { url: info.result.url, choXuLy: info.result.pending_update_count, loiCuoi: info.result.last_error_message || '' },
      nhom: Object.entries(STORE.chats).map(([id, c]) => ({ id, ten: c.title, soNguoi: Object.keys(c.members).length, nguoi: Object.values(c.members).map(m => m.name) })),
    });
  });

  if (!token) { console.log('[TGALL] chưa khai TELEGRAM_ALL_BOT_TOKEN → tắt bot chat all'); return; }
  (async () => {
    const g = await tg('getMe');
    if (g.ok) me = g.result;
    const url = (process.env.TG_ALL_PUBLIC_URL || 'https://ads.tdmjsc.com').replace(/\/+$/, '') + '/tg-all/webhook';
    const w = await tg('setWebhook', { url, secret_token: SECRET, allowed_updates: ['message', 'edited_message', 'chat_member', 'my_chat_member'] });
    console.log('[TGALL] bot', me ? '@' + me.username : '?', '— webhook', w.ok ? 'OK' : 'lỗi: ' + w.description);
  })().catch(e => console.error('[TGALL] khởi động lỗi:', e.message));
}
