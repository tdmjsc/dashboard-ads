// ads-alert.js — BOT TELEGRAM CẢNH BÁO CHIẾN DỊCH ĐẮT + TẮT/BẬT/ĐỔI NGÂN SÁCH NGAY TRÊN TELEGRAM
//
//  • Token bot riêng trong .env:  TELEGRAM_ADS_ALERT_BOT_TOKEN=<token BotFather cấp>. Không có token thì tắt.
//  • Mỗi tài khoản đăng nhập tự kết nối Telegram ở trang /ads-alert.html (nút mở bot với mã 1 lần
//    → bot nhận /start <mã> → ghi chat của người đó). NV nhận camp của mình (gồm team nếu là lead),
//    admin nhận mọi camp (tắt được trong cài đặt).
//  • Kết quả = đơn về OMS (như cột Kết quả trang Ads); camp tin nhắn chưa có đơn OMS thì dùng kết quả Meta.
//    Camp có từ 2 nhóm quảng cáo thì xét và báo riêng từng nhóm (người dùng chọn 3/11/2026); camp / nhóm đã tắt
//    thì không báo. Luật báo (người dùng đặt 3/11/2026, số liệu hôm nay, `decide`):
//      - 0–1 đơn: tiêu ≥ cprMax (150k) → "có dấu hiệu bị đắt"; tiêu ≥ offAt (200k) → "đề nghị tắt". Mỗi mức 1 lần/ngày.
//      - ≥ 2 đơn: CPA trung bình > cprMax → báo, tin có nút chọn mức báo lại (cpaNext); chưa chọn thì mức kế tiếp.
//      - > 2 đơn: so với lần kiểm tra trước (mốc `base`, chỉ dời khi có đơn mới / đã báo), CPA của đơn mới phát sinh
//        > cprMax → báo; < lowCpa (80k) → nhắc tăng ngân sách (tối đa 1 lần / lowEveryMin phút). Tiêu thêm > cprMax
//        mà chưa ra đơn mới cũng báo.
//  • Nút trên tin: Tắt / Bật camp (hoặc nhóm), −/+ x% ngân sách (nhóm dùng ngân sách chiến dịch CBO thì đổi
//    ngân sách chiến dịch), nhập ngân sách mới, xem số mới nhất. Trước mỗi thao tác máy chủ đọc lại từ Meta và kiểm tra người bấm có quyền với camp đó (theo tên NV trong tên camp).
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
  cprMax: 150000,     // ngưỡng đắt: CP / đơn (đ)
  offAt: 200000,      // 0–1 đơn mà tiêu tới mức này → đề nghị tắt
  lowCpa: 80000,      // CPA đơn mới phát sinh dưới mức này → nhắc tăng ngân sách (0 = tắt)
  lowEveryMin: 120,   // nhắc tăng ngân sách tối đa 1 lần / … phút / nhóm
  reAlert: [180000, 200000, 250000, 300000], // nút "báo lại khi CPA vượt …"
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
  // Trả { c: {campaign_id: đơn}, s: {adset_id: đơn} } hoặc null khi không đọc được OMS.
  async function omsToday(day) {
    if (typeof global.__omsAdStats !== 'function') return null;
    try {
      const st = await global.__omsAdStats(day, day);
      if (!st) return null;
      const by = { c: {}, s: {} };
      for (const r of st.rows) {
        if (r.fb_campaign_id) by.c[r.fb_campaign_id] = (by.c[r.fb_campaign_id] || 0) + r.don;
        if (r.fb_adset_id) by.s[r.fb_adset_id] = (by.s[r.fb_adset_id] || 0) + r.don;
      }
      return by;
    } catch (e) { console.error('[ADSALERT] đọc OMS lỗi:', e.message); return null; }
  }
  function statOf(spend, meta, don, obj, hasOms) {
    const useOms = hasOms && (don > 0 || obj !== 'tin nhắn');
    const res = useOms ? don : meta;
    const label = useOms ? 'đơn OMS' : (obj || 'kết quả') + ' (Meta)';
    return { spend, res, label, cpr: res ? spend / res : null };
  }
  // "Đơn vị" được xét + báo: cả camp (k='c') hoặc 1 nhóm quảng cáo (k='s')
  const baseOf = c => ({ acc: String(c.acc), accName: c.accName, employee: c.employee, campName: c.name });
  function campUnit(c, oms) {
    const spend = (c.daily || []).reduce((t, d) => t + (d.spent || 0), 0);
    const meta = (c.daily || []).reduce((t, d) => t + (d.results || 0), 0);
    return { ...baseOf(c), k: 'c', id: String(c.id), name: c.name, on: !!c.on, budget: c.budget || 0,
      st: statOf(spend, meta, oms ? (oms.c[String(c.id)] || 0) : 0, c.obj, !!oms) };
  }
  // Nhóm không có ngân sách riêng = ngân sách ở chiến dịch (CBO)
  function setUnit(c, a, oms) {
    return { ...baseOf(c), k: 's', id: String(a.id), name: a.name, on: !!(c.on && a.on), budget: a.budget || 0, cbo: a.budget ? 0 : (c.budget || 0),
      st: statOf(a.spent || 0, a.results || 0, oms ? (oms.s[String(a.id)] || 0) : 0, c.obj, !!oms) };
  }
  // Camp có từ 2 nhóm → xét từng nhóm; 1 nhóm → xét cả camp
  const unitsOf = (c, oms) => (c.adsets || []).length >= 2 ? c.adsets.map(a => setUnit(c, a, oms)) : [campUnit(c, oms)];
  const kindName = k => k === 's' ? 'nhóm' : 'camp';

  /* ---------- Luật báo ----------
     e = trạng thái hôm nay của 1 camp / nhóm (s.sent[day][id]), sửa trực tiếp:
       lv1/lv2: đã báo mức "dấu hiệu đắt" / "đề nghị tắt" (0–1 đơn); cpaNext: mức CPA trung bình sẽ báo
       (chưa có = cprMax, 0 = không báo lại hôm nay); base: mốc { spend, res, at } để tính CPA đơn mới;
       lowAt: lần nhắc tăng ngân sách gần nhất.
     Trả các lý do cần báo: { lv: 3 đề nghị tắt | 2 đắt | 1 rẻ, kind, text }. */
  // Mức báo lại kế tiếp: mức đầu tiên trong cfg.reAlert lớn hơn CPA hiện tại; không có thì CPA × 1,2
  const nextLevels = (cpa, cfg) => {
    const opts = (cfg.reAlert || []).map(Number).filter(v => v > cpa).sort((a, b) => a - b);
    return opts.length ? opts : [Math.ceil(cpa * 1.2 / 10000) * 10000];
  };
  function decide(e, u, cfg, now) {
    const { spend, res } = u.st;
    const T = Number(cfg.cprMax) || 0, nm = kindName(u.k), R = [];
    const per = (s, r) => `${fmt(s / r)} đ/đơn`;
    if (res <= 1) {
      const noi = res ? 'mới ra 1 đơn' : 'chưa ra đơn';
      if (cfg.offAt > 0 && spend >= cfg.offAt && !e.lv2) {
        e.lv2 = e.lv1 = true;
        R.push({ lv: 3, kind: 'off', text: `Đã tiêu ${fmt(spend)} đ mà ${noi} → <b>đề nghị tắt ${nm}</b>` });
      } else if (T > 0 && spend >= T && !e.lv1) {
        e.lv1 = true;
        R.push({ lv: 2, kind: 'warn', text: `Đã tiêu ${fmt(spend)} đ mà ${noi} → ${nm} có dấu hiệu bị đắt` });
      }
    } else {
      const cpa = spend / res, thr = e.cpaNext == null ? T : e.cpaNext;
      if (thr > 0 && cpa > thr) {
        e.cpaNext = nextLevels(cpa, cfg)[0];
        R.push({ lv: 2, kind: 'cpa', cpa, text: `CPA trung bình ${per(spend, res)} vượt ${fmt(thr)} đ` });
      }
    }
    // CPA của đơn mới phát sinh so với mốc lần kiểm tra trước (nhóm đã có trên 2 đơn)
    const b = e.base;
    const since = b && `từ ${b.at}`;
    if (!b || res < b.res || spend < b.spend) e.base = { spend, res, at: hhmm() };
    else {
      const dS = spend - b.spend, dR = res - b.res;
      if (dR > 0) {
        if (b.res > 2 && T > 0 && dS / dR > T)
          R.push({ lv: 2, kind: 'new', text: `Đơn mới ${since}: tiêu thêm ${fmt(dS)} đ ra ${dR} đơn → <b>${per(dS, dR)}</b> (vượt ${fmt(T)} đ)` });
        else if (b.res > 2 && cfg.lowCpa > 0 && dS / dR < cfg.lowCpa && (!e.lowAt || now - e.lowAt >= cfg.lowEveryMin * 60e3)) {
          e.lowAt = now;
          R.push({ lv: 1, kind: 'low', text: `Đơn mới ${since}: tiêu thêm ${fmt(dS)} đ ra ${dR} đơn → <b>${per(dS, dR)}</b> (dưới ${fmt(cfg.lowCpa)} đ) → nên tăng ngân sách` });
        }
        e.base = { spend, res, at: hhmm() };
      } else if (T > 0 && dS > T) {
        if (b.res > 2) R.push({ lv: 2, kind: 'new', text: `${since[0].toUpperCase() + since.slice(1)}: tiêu thêm ${fmt(dS)} đ chưa ra đơn mới` });
        e.base = { spend, res, at: hhmm() };
      }
    }
    return R;
  }
  function headOf(R, k) {
    const nm = kindName(k), Nm = nm[0].toUpperCase() + nm.slice(1);
    const lv = Math.max(...R.map(r => r.lv));
    if (lv >= 3) return `🛑 <b>Đề nghị TẮT ${nm}</b>`;
    if (lv === 2) return R.every(r => r.kind === 'warn') ? `⚠️ <b>${Nm} có dấu hiệu bị đắt</b>` : `⚠️ <b>${Nm} đang đắt</b>`;
    return `💡 <b>${Nm} đang rẻ — nên tăng ngân sách</b>`;
  }

  function alertText(u, cfg, head, R = []) {
    const st = u.st;
    const budget = u.budget ? `${fmt(u.budget)} đ/ngày` : u.cbo ? `theo chiến dịch (CBO) ${fmt(u.cbo)} đ/ngày` : 'chưa rõ';
    return `${head}\n<b>${esc(u.name)}</b>\n`
      + (u.k === 's' ? `Chiến dịch: ${esc(u.campName)}\n` : '')
      + `NV: ${esc(u.employee)} · ${esc(u.accName || u.acc)}\n`
      + R.map(r => '• ' + r.text + '\n').join('')
      + `Hôm nay (đến ${hhmm()}): chi <b>${fmt(st.spend)} đ</b> · <b>${st.res}</b> ${esc(st.label)}`
      + ` · CPA <b>${st.cpr == null ? '—' : fmt(st.cpr) + ' đ'}</b>\n`
      + `Ngân sách: ${budget} · ${u.on ? '🟢 đang chạy' : '⚪️ đang tắt'}`;
  }
  // callback_data: a|<việc>|<c|s>|<acc>|<id>[|<giá trị>]. levels: các mức cho nút "báo lại khi CPA vượt …"
  function keyboard(k, acc, id, on, step, levels) {
    const d = (a, v) => `a|${a}|${k}|${acc}|${id}` + (v == null ? '' : '|' + v);
    const nm = kindName(k);
    const rows = [
      [on ? { text: `⏸ Tắt ${nm}`, callback_data: d('off') } : { text: `▶️ Bật ${nm}`, callback_data: d('on') },
        { text: '🔄 Số mới nhất', callback_data: d('ref') }],
      [{ text: `➖ ${step}% NS`, callback_data: d('dn') }, { text: `➕ ${step}% NS`, callback_data: d('up') },
        { text: '✏️ Nhập NS', callback_data: d('set') }],
    ];
    if (levels && levels.length) rows.push(
      levels.slice(0, 3).map(v => ({ text: `🔔 CPA > ${Math.round(v / 1000)}k`, callback_data: d('rn', v) }))
        .concat({ text: '🔕 Không báo lại', callback_data: d('rn', 0) }));
    return { inline_keyboard: rows };
  }

  // Ai nhận cảnh báo: NV có camp (gồm lead của team), admin nếu adminAll
  function recipients(u, cfg) {
    const out = [];
    for (const [login, l] of Object.entries(STORE.links || {})) {
      const who = employeesOfLogin(login);
      if (!who || !l.chatId) continue;
      if (who.role === 'admin' ? cfg.adminAll : (who.employees || []).includes(u.employee)) out.push(l.chatId);
    }
    return out;
  }

  /* ---------- Kiểm tra ---------- */
  // send=false: chỉ tính trên bản sao trạng thái (xem trước), không gửi, không lưu. Camp / nhóm đã tắt thì bỏ qua.
  async function check({ send = true } = {}) {
    reload();
    const cfg = STORE.cfg;
    const day = vnDay(), now = Date.now();
    const [camps, oms] = await Promise.all([getCampaigns(day, day), omsToday(day)]);
    const units = [];
    for (const c of camps || []) if (c.on) for (const u of unitsOf(c, oms)) if (u.on) units.push(u);
    // Quyết định cho mọi camp / nhóm trong 1 lần commit (đọc trạng thái mới nhất → đánh dấu → ghi) để nhiều
    // tiến trình không báo trùng; gửi Telegram sau.
    const run = s => {
      const today = (s.sent[day] ||= {});
      for (const d of Object.keys(s.sent)) if (d < day) delete s.sent[d];
      return units.map(u => { const e = (today[u.id] ||= {}); return { u, R: decide(e, u, cfg, now) }; }).filter(x => x.R.length);
    };
    if (!send) {
      const list = run(JSON.parse(JSON.stringify({ sent: STORE.sent || {} })));
      return { day, oms: !!oms, list: list.map(({ u, R }) => ({ id: u.id, loai: kindName(u.k), ten: u.name, camp: u.campName, nv: u.employee,
        ...u.st, lyDo: R.map(r => r.text.replace(/<[^>]+>/g, '')), nguoiNhan: recipients(u, cfg).length })) };
    }
    const list = commit(run);
    let n = 0;
    for (const { u, R } of list) {
      const cpaR = R.find(r => r.kind === 'cpa');
      const kb = keyboard(u.k, u.acc, u.id, u.on, cfg.step, cpaR && nextLevels(cpaR.cpa, cfg));
      for (const chatId of recipients(u, cfg)) {
        const j = await say(chatId, alertText(u, cfg, headOf(R, u.k), R), { reply_markup: kb });
        if (!j.ok) addLog({ who: 'bot', camp: u.id, ten: u.name, viec: 'gửi cảnh báo', ok: false, loi: j.description || 'Telegram từ chối' });
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

  // Đọc camp / nhóm từ Meta + kiểm tra quyền người bấm (theo tên NV trong tên camp).
  // Trả { obj, k, campName, tk, who } hoặc ném lỗi dễ hiểu.
  async function loadObj(tgId, k, acc, id) {
    reload();
    const link = userOfTg(tgId);
    if (!link) throw new Error('Telegram này chưa kết nối tài khoản dashboard (trang Cảnh báo Telegram).');
    const who = employeesOfLogin(link[0]);
    if (!who) throw new Error('Tài khoản dashboard không còn tồn tại.');
    const tk = tokenForAcc(acc);
    if (!tk) throw new Error('Không có token cho tài khoản quảng cáo này.');
    const fields = 'id,name,account_id,effective_status,daily_budget,lifetime_budget'
      + (k === 's' ? ',campaign{id,name,daily_budget,lifetime_budget}' : '');
    const obj = await fbGet(id, { fields }, tk);
    if (String(obj.account_id) !== String(acc)) throw new Error('Không thuộc tài khoản quảng cáo này.');
    const campName = k === 's' ? ((obj.campaign || {}).name || '') : obj.name;
    const nv = detectEmployee(campName || '');
    if (who.role !== 'admin' && !(who.employees || []).includes(nv)) throw new Error(`Bạn không có quyền với ${kindName(k)} này.`);
    return { obj, k, campName, tk, who: link[0] };
  }

  // Ngân sách cần sửa:
  //  • nhóm: ngân sách ngày của nhóm; nhóm không có ngân sách riêng (CBO) → ngân sách chiến dịch
  //  • camp: ngân sách chiến dịch (CBO); không có thì các nhóm đang chạy có ngân sách ngày
  async function budgetTargets({ obj, k, tk }) {
    const lifetime = o => o && Number(o.lifetime_budget) > 0;
    const daily = o => o && Number(o.daily_budget) > 0;
    if (k === 's') {
      if (lifetime(obj)) throw new Error('Nhóm dùng ngân sách trọn đời — đổi trên Ads Manager.');
      if (daily(obj)) return [{ id: obj.id, label: 'Nhóm ' + esc(obj.name), budget: Number(obj.daily_budget) }];
      const c = obj.campaign;
      if (lifetime(c)) throw new Error('Chiến dịch dùng ngân sách trọn đời — đổi trên Ads Manager.');
      if (daily(c)) return [{ id: c.id, label: 'Chiến dịch (CBO, chung mọi nhóm)', budget: Number(c.daily_budget) }];
      throw new Error('Không tìm thấy ngân sách ngày của nhóm / chiến dịch.');
    }
    if (lifetime(obj)) throw new Error('Camp dùng ngân sách trọn đời — đổi trên Ads Manager.');
    if (daily(obj)) return [{ id: obj.id, label: 'Camp', budget: Number(obj.daily_budget) }];
    const r = await fbGet(`${obj.id}/adsets`, { fields: 'id,name,daily_budget,lifetime_budget,effective_status', limit: 200 }, tk);
    const sets = (r.data || []).filter(a => a.effective_status === 'ACTIVE' && daily(a));
    if (!sets.length) throw new Error('Không tìm thấy nhóm đang chạy có ngân sách ngày.');
    return sets.map(a => ({ id: a.id, label: 'Nhóm ' + esc(a.name), budget: Number(a.daily_budget) }));
  }
  async function setBudgets(targets, newOf, tk, maxBudget) {
    const plan = targets.map(t => ({ ...t, moi: Math.max(1000, Math.round(newOf(t.budget) / 1000) * 1000) }));
    const over = plan.find(p => p.moi > maxBudget);
    if (over) throw new Error(`Ngân sách mới ${fmt(over.moi)} đ vượt mức tối đa ${fmt(maxBudget)} đ cho phép qua bot.`);
    const done = [];
    for (const p of plan) {
      await fbPost(p.id, { daily_budget: String(p.moi) }, tk);
      done.push(`${p.label}: ${fmt(p.budget)} → <b>${fmt(p.moi)} đ</b>`);
    }
    return done.join('\n');
  }

  // Số hôm nay của 1 camp / nhóm (cho nút 🔄)
  async function unitStatus(k, acc, id) {
    const day = vnDay();
    const [camps, oms] = await Promise.all([getCampaigns(day, day), omsToday(day)]);
    for (const c of camps || []) {
      if (String(c.acc) !== String(acc)) continue;
      if (k === 'c' && String(c.id) === String(id)) return campUnit(c, oms);
      const a = k === 's' && (c.adsets || []).find(x => String(x.id) === String(id));
      if (a) return setUnit(c, a, oms);
    }
    return null;
  }

  async function onCallback(cq) {
    const parts = String(cq.data || '').split('|');
    if (parts.length === 4) parts.splice(2, 0, 'c');   // nút của tin cũ (trước khi báo theo nhóm): a|việc|acc|camp
    const [, act, k, acc, id, val] = parts;
    const chatId = cq.message && cq.message.chat.id;
    const answer = text => tg('answerCallbackQuery', { callback_query_id: cq.id, text: String(text).slice(0, 190), show_alert: text.length > 60 });
    if (!['c', 's'].includes(k) || !/^\d+$/.test(acc || '') || !/^\d+$/.test(id || '')) return answer('Nút không hợp lệ.');
    let ctx;
    try { ctx = await loadObj(cq.from.id, k, acc, id); }
    catch (e) { return answer(metaMsg(e)); }
    const { obj, tk, who, campName } = ctx;
    const nm = kindName(k);
    const title = `<b>${esc(obj.name)}</b>` + (k === 's' ? ` (chiến dịch ${esc(campName)})` : '');
    const cfg = STORE.cfg;
    const reply = (text, extra) => say(chatId, text, { reply_to_message_id: cq.message.message_id, allow_sending_without_reply: true, ...extra });
    const log = (viec, ok, loi) => addLog({ who, camp: id, ten: (k === 's' ? 'Nhóm ' : '') + obj.name, viec, ok, loi });
    try {
      if (act === 'rn') {
        // Chọn mức CPA trung bình để báo lại (áp cho mọi người nhận camp / nhóm này, hôm nay)
        const v = Number(val);
        if (!Number.isFinite(v) || v < 0) return answer('Nút không hợp lệ.');
        commit(s => { ((s.sent[vnDay()] ||= {})[id] ||= {}).cpaNext = v; });
        const txt = v ? `🔔 Sẽ báo lại khi CPA trung bình vượt ${fmt(v)} đ` : '🔕 Hôm nay không báo lại CPA trung bình';
        log(txt.slice(2), true);
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: keyboard(k, acc, id, obj.effective_status === 'ACTIVE', cfg.step) });
        await answer(txt);
        await reply(`${txt} — ${title}\n(${esc(who)} lúc ${hhmm()})`);
      } else if (act === 'off' || act === 'on') {
        await fbPost(id, { status: act === 'off' ? 'PAUSED' : 'ACTIVE' }, tk);
        const txt = act === 'off' ? `⏸ Đã TẮT ${nm}` : `▶️ Đã BẬT ${nm}`;
        log(txt.slice(2), true);
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: keyboard(k, acc, id, act === 'on', cfg.step) });
        await answer(txt);
        await reply(`${txt} ${title}\n(${esc(who)} lúc ${hhmm()})`);
      } else if (act === 'dn' || act === 'up') {
        const f = 1 + (act === 'up' ? 1 : -1) * cfg.step / 100;
        const done = await setBudgets(await budgetTargets(ctx), b => b * f, tk, cfg.maxBudget);
        log(`Ngân sách ${act === 'up' ? '+' : '−'}${cfg.step}%`, true);
        await answer('Đã đổi ngân sách');
        await reply(`💰 Đổi ngân sách ${title} (${act === 'up' ? '+' : '−'}${cfg.step}%):\n${done}\n(${esc(who)} lúc ${hhmm()})`);
      } else if (act === 'set') {
        const targets = await budgetTargets(ctx);
        if (targets.length > 1) return answer(`Camp có ${targets.length} nhóm đang chạy với ngân sách riêng — dùng nút −/+ % hoặc đổi trên Ads Manager.`);
        commit(s => { s.pending[String(chatId)] = { k, acc, id, exp: Date.now() + 10 * 60e3 }; });
        await answer('Gõ ngân sách mới');
        await reply(`✏️ Gõ ngân sách/ngày mới cho ${title}\n${targets[0].label}, hiện ${fmt(targets[0].budget)} đ. Vd <code>500000</code> hoặc <code>500k</code>. Hết hạn sau 10 phút.`,
          { reply_markup: { force_reply: true, selective: true } });
      } else if (act === 'ref') {
        await answer('Đang lấy số mới…');
        const u = await unitStatus(k, acc, id);
        if (!u) return reply(`Hôm nay chưa có số liệu chi tiêu cho ${title}.`);
        u.on = obj.effective_status === 'ACTIVE';
        await reply(alertText(u, cfg, '🔄 <b>Số mới nhất</b>'), { reply_markup: keyboard(k, acc, id, u.on, cfg.step) });
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
    const k = p.k || 'c', id = p.id || p.camp;
    let ctx;
    try {
      ctx = await loadObj(msg.from.id, k, p.acc, id);
      const targets = await budgetTargets(ctx);
      if (targets.length > 1) throw new Error('Camp có nhiều nhóm với ngân sách riêng — dùng nút −/+ %.');
      const done = await setBudgets(targets, () => v, ctx.tk, STORE.cfg.maxBudget);
      addLog({ who: ctx.who, camp: id, ten: (k === 's' ? 'Nhóm ' : '') + ctx.obj.name, viec: `Đặt ngân sách ${fmt(v)} đ`, ok: true });
      return say(chatId, `💰 <b>${esc(ctx.obj.name)}</b>\n${done}\n(${esc(ctx.who)} lúc ${hhmm()})`);
    } catch (e) {
      addLog({ who: ctx ? ctx.who : String(msg.from.id), camp: id, ten: ctx ? ctx.obj.name : '', viec: 'Đặt ngân sách', ok: false, loi: metaMsg(e) });
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
      offAt: num(b.offAt, 0, 1e9), lowCpa: num(b.lowCpa, 0, 1e9), lowEveryMin: num(b.lowEveryMin, 10, 1440),
      reAlert: Array.isArray(b.reAlert) ? [...new Set(b.reAlert.map(Number).filter(v => Number.isFinite(v) && v > 0).map(Math.round))].sort((x, y) => x - y).slice(0, 6) : undefined,
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
