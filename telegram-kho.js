// telegram-kho.js — BOT TELEGRAM NHÓM KHO
//
// Một bot Telegram riêng, được thêm vào nhóm nhân viên kho, để máy chủ tự nhắn
// thông báo vào nhóm. Cấu hình ở trang /ton-kho.html → "🤖 Bot nhóm kho".
//
//  • Token bot đặt trong .env:  TELEGRAM_KHO_BOT_TOKEN=<token BotFather cấp>
//    (không lưu trong file dữ liệu, không bao giờ gửi về trình duyệt).
//  • Nhóm nhận tin lưu ở DATA_DIR/kho-bot.json (chỉ có Chat ID + tên nhóm).
//  • Phần khác của máy chủ gửi tin bằng:  await global.__khoNotify('<nội dung HTML>')
//    → trả về { ok, error }. Không ném lỗi, nên gọi ở đâu cũng an toàn.

import fs from 'node:fs';
import path from 'node:path';

const TG_MAX = 4000; // Telegram giới hạn 4096 ký tự / tin

export function mountKhoBot(app, { express, DATA_DIR, fetchWithTimeout, token = process.env.TELEGRAM_KHO_BOT_TOKEN || '' }) {
  const FILE = path.join(DATA_DIR, 'kho-bot.json');
  let STORE = { chatId: '', chatTitle: '', savedAt: '', savedBy: '', lastSend: null };
  try { STORE = { ...STORE, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  const save = () => {
    try { fs.writeFileSync(FILE, JSON.stringify(STORE, null, 1)); }
    catch (e) { console.error('[KHOBOT] lưu file lỗi:', e.message); }
  };

  async function tg(method, body) {
    if (!token) return { ok: false, description: 'Chưa khai TELEGRAM_KHO_BOT_TOKEN trên máy chủ.' };
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

  // Gửi 1 tin vào nhóm kho. html=true: nội dung dùng thẻ HTML của Telegram (<b>, <i>…).
  async function send(text, { html = true } = {}) {
    text = String(text || '').trim();
    if (!text) return { ok: false, error: 'Tin nhắn trống.' };
    if (!STORE.chatId) return { ok: false, error: 'Chưa chọn nhóm kho.' };
    if (text.length > TG_MAX) text = text.slice(0, TG_MAX - 1) + '…';
    const body = { chat_id: STORE.chatId, text, disable_web_page_preview: true };
    if (html) body.parse_mode = 'HTML';
    let j = await tg('sendMessage', body);
    // Nhóm được nâng lên "siêu nhóm" thì Telegram đổi Chat ID → tự cập nhật và gửi lại
    const moved = j && j.parameters && j.parameters.migrate_to_chat_id;
    if (!j.ok && moved) {
      STORE.chatId = String(moved);
      j = await tg('sendMessage', { ...body, chat_id: STORE.chatId });
    }
    STORE.lastSend = { at: new Date().toISOString(), ok: !!j.ok, error: j.ok ? '' : (j.description || 'Telegram từ chối tin nhắn') };
    save();
    return { ok: !!j.ok, error: STORE.lastSend.error };
  }
  global.__khoNotify = text => send(text, { html: true }).catch(e => ({ ok: false, error: e.message }));

  let botInfo = null; // { username, name } — hỏi Telegram 1 lần rồi nhớ
  async function getBot() {
    if (botInfo || !token) return botInfo;
    const j = await tg('getMe');
    if (j.ok && j.result) botInfo = { username: j.result.username || '', name: j.result.first_name || '' };
    return botInfo;
  }

  const isAdmin = req => req.session?.user?.role === 'admin';
  const guard = (req, res, next) => isAdmin(req) ? next()
    : res.status(403).json({ ok: false, message: 'Chỉ quản trị viên.' });
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error('[KHOBOT]', e.message); res.status(500).json({ ok: false, message: 'Lỗi máy chủ.' }); }
  };
  const json = express.json({ limit: '100kb' });

  const view = async () => ({
    ok: true, hasToken: !!token, bot: await getBot(),
    group: STORE.chatId ? { id: STORE.chatId, title: STORE.chatTitle, savedAt: STORE.savedAt } : null,
    lastSend: STORE.lastSend,
  });

  app.get('/api/ton-kho/bot', guard, wrap(async (req, res) => res.json(await view())));

  // Các nhóm bot đang được thêm vào (đọc từ những cập nhật gần đây của bot)
  app.get('/api/ton-kho/bot/groups', guard, wrap(async (req, res) => {
    const j = await tg('getUpdates', { timeout: 0, allowed_updates: ['message', 'my_chat_member'] });
    if (!j.ok) return res.json({ ok: false, message: j.description || 'Telegram báo lỗi.' });
    const groups = new Map();
    for (const u of j.result || []) {
      const chat = (u.message || u.my_chat_member || {}).chat;
      if (!chat || !['group', 'supergroup'].includes(chat.type)) continue;
      const left = u.my_chat_member && ['left', 'kicked'].includes(u.my_chat_member.new_chat_member?.status);
      if (left) groups.delete(String(chat.id)); else groups.set(String(chat.id), { id: String(chat.id), title: chat.title || '(không tên)' });
    }
    res.json({ ok: true, groups: [...groups.values()] });
  }));

  // Chọn nhóm nhận tin
  app.post('/api/ton-kho/bot/group', guard, json, wrap(async (req, res) => {
    const id = String(req.body?.id ?? '').trim();
    if (id === '') { STORE.chatId = ''; STORE.chatTitle = ''; save(); return res.json(await view()); }
    if (!/^-?\d{4,20}$/.test(id)) return res.json({ ok: false, message: 'Chat ID nhóm phải là một dãy số.' });
    // Hỏi Telegram để chắc bot đang ở trong nhóm và lấy đúng tên nhóm
    const j = await tg('getChat', { chat_id: id });
    if (!j.ok) return res.json({ ok: false, message: 'Bot không thấy nhóm này: ' + (j.description || 'kiểm tra đã thêm bot vào nhóm chưa') });
    STORE.chatId = id; STORE.chatTitle = j.result?.title || String(req.body?.title || '').slice(0, 200);
    STORE.savedAt = new Date().toISOString(); STORE.savedBy = req.session?.user?.user || '';
    save();
    res.json(await view());
  }));

  // Gửi tin vào nhóm (tin thử hoặc tin tự soạn) — nội dung gửi dạng chữ thường, không diễn giải HTML
  app.post('/api/ton-kho/bot/send', guard, json, wrap(async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.json({ ok: false, message: 'Chưa nhập nội dung.' });
    const r = await send(text, { html: false });
    res.json({ ...(await view()), ok: r.ok, message: r.ok ? 'Đã gửi vào nhóm.' : 'Không gửi được: ' + r.error });
  }));

  console.log('[KHOBOT] đã gắn bot nhóm kho' + (token ? '' : ' (chưa có TELEGRAM_KHO_BOT_TOKEN)'));
  return { send };
}
