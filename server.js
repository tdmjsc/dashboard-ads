// server.js — Backend nối dashboard với Meta Marketing API
// HỖ TRỢ NHIỀU DOANH NGHIỆP (TOKEN_1, TOKEN_2, ...) + NHẬN DIỆN TÊN NHÂN VIÊN
// Yêu cầu Node.js 18 trở lên. Chạy: npm install → npm start → mở http://localhost:3000

import express from 'express';
import session from 'express-session';
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Thư mục lưu dữ liệu NGOÀI project (không bị mất khi deploy). Khai báo SỚM
// vì nhiều phần bên dưới dùng tới. __dirname = .../ads.tdmjsc.com/nodejs
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const V = process.env.META_API_VERSION || 'v23.0';
const BASE = `https://graph.facebook.com/${V}`;

/* =========================================================================
   TÀI KHOẢN ĐĂNG NHẬP
   Danh sách tài khoản nằm ở FILE RIÊNG ./users.js do BẠN tự quản lý.
   → Cập nhật server.js sẽ KHÔNG ghi đè tài khoản của bạn nữa.
   → Bạn tự điền mật khẩu trong users.js (không cần gửi cho ai).
   Nếu chưa có file users.js, hệ thống dùng tạm 1 tài khoản admin mặc định.
   ========================================================================= */
let USERS = [{ user: 'admin', pass: 'DOI_MAT_KHAU_NAY', role: 'admin' }];
let TELEGRAM_CHAT_IDS = {};
import('./users.js')
  .then(mod => {
    if (Array.isArray(mod.USERS) && mod.USERS.length) USERS = mod.USERS;
    if (mod.TELEGRAM_CHAT_IDS) TELEGRAM_CHAT_IDS = mod.TELEGRAM_CHAT_IDS;
  })
  .catch(() => console.log('Chưa tìm thấy users.js — đang dùng tài khoản admin mặc định.'));

/* =========================================================================
   DANH SÁCH NHÂN VIÊN  ← BẠN ĐIỀN PHẦN NÀY
   Điền tên tất cả nhân viên chạy quảng cáo. Hệ thống sẽ tìm tên này
   XUẤT HIỆN trong tên chiến dịch, dù viết kiểu nào:
     "Phương- Balo..."   "29/3 Phương"   "Huân Máy cho cá ăn"  → đều nhận ra.
   - Tên có dấu hay không đều khớp (Phương = Phuong).
   - Nếu hai người tên gần giống nhau, ghi đầy đủ hơn (vd "Việt Hà").
   ========================================================================= */
const EMPLOYEES = [
  // { code: mã đứng đầu tên chiến dịch, short: tên ngắn (chiến dịch cũ), full: tên hiển thị (giống Sandbox) }
  // bhxh: số tiền BHXH mặc định hàng tháng (điền 0 nếu không có)
  { code: 'TD1',  short: 'Trường',  full: 'Tạ Quang Trường',   bhxh: 598500 },
  { code: 'TD2',  short: 'Phương',  full: 'Trịnh Đức Phương',  bhxh: 598500 },
  { code: 'TD3',  short: 'Hiếu',    full: 'Nguyễn Trung Hiếu', bhxh: 577500 },
  { code: 'TD4',  short: 'My',      full: 'Nguyễn Thị Trà My', bhxh: 577500 },
  { code: 'TD5',  short: 'Ánh',     full: 'Lê Thị Ánh',        bhxh: 577500 },
  { code: 'TD6',  short: 'Huân',    full: 'Nguyễn Duy Huân',   bhxh: 0 },
  { code: 'TD7',  short: 'Minh',    full: 'Dương Văn Minh',    bhxh: 577500 },
  { code: 'TD8',  short: 'Giang',   full: 'Vũ Hà Giang',       bhxh: 577500 },
  { code: 'TD9',  short: 'Việt Hà', full: 'Đoàn Việt Hà',      bhxh: 577500 },
  { code: 'TD10', short: 'Thuý An', full: 'Vũ Thuý An', aliases: ['Thúy An'], bhxh: 0 },
  // Nhân viên cũ (chiến dịch cũ chưa có mã) — giữ để vẫn nhận ra, xóa nếu không cần:
  { code: '',     short: 'Thắng',   full: 'Thắng', bhxh: 0 },
];

/* Nhận diện nhân viên: tách tên chiến dịch thành các "chữ" riêng, rồi tìm xem
   tên nhân viên có xuất hiện trọn vẹn như một (hoặc vài) chữ liền nhau không.
   - KHỚP CÓ DẤU: "Mỹ" sẽ KHÔNG bị tính thành "My"; "hiệu" không thành "Hiếu".
   - Tên 2 chữ như "Thúy An", "Việt Hà" được ưu tiên khớp trước.
   - Lưu ý: nhân viên phải viết đúng dấu tên mình trong tên chiến dịch.
     Nếu viết sai/thiếu dấu, chiến dịch đó sẽ rơi vào nhóm "Chưa xác định"
     để bạn nhìn thấy và sửa. */
function detectEmployee(name) {
  const raw = (name || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  // 1) Ưu tiên MÃ ở token ĐẦU TIÊN, vd "TD1-Trường-..." (chiến dịch từ T6 trở đi)
  if (raw.length) {
    const code = raw[0].toUpperCase();
    const byCode = EMPLOYEES.find(e => e.code && e.code.toUpperCase() === code);
    if (byCode) return byCode.full;
  }

  // 2) Không có mã -> nhận diện theo TÊN NGẮN như cũ (khớp CÓ DẤU, ưu tiên tên nhiều chữ)
  const tokens = raw.map(t => t.toLowerCase());
  const candidates = [];
  for (const e of EMPLOYEES) {
    for (const nm of [e.short, ...(e.aliases || [])]) {
      if (nm) candidates.push({ words: nm.toLowerCase().trim().split(/\s+/), full: e.full });
    }
  }
  candidates.sort((a, b) => b.words.length - a.words.length);
  for (const c of candidates) {
    const w = c.words;
    for (let i = 0; i + w.length <= tokens.length; i++) {
      let ok = true;
      for (let j = 0; j < w.length; j++) {
        if (tokens[i + j] !== w[j]) { ok = false; break; }
      }
      if (ok) return c.full;
    }
  }
  return 'Chưa xác định';
}

/* ---------- Đọc danh sách doanh nghiệp từ .env ---------- */
const SOURCES = [];
let n = 1;
while (process.env[`TOKEN_${n}`]) {
  SOURCES.push({
    token: process.env[`TOKEN_${n}`],
    accounts: (process.env[`ACCOUNTS_${n}`] || '').split(',').map(s => s.trim()).filter(Boolean),
  });
  n++;
}
if (SOURCES.length === 0 && process.env.META_ACCESS_TOKEN) {
  SOURCES.push({
    token: process.env.META_ACCESS_TOKEN,
    accounts: (process.env.AD_ACCOUNT_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  });
}

const ACCOUNT_NAMES = {
  // Tên hiển thị cho từng tài khoản quảng cáo: 'ID': 'Tên'
  // (sửa tên bên phải dấu : nếu cần, GIỮ nguyên ID bên trái)
  '513728869887825': 'BM TD2.11',
  '635675708897994': 'BM TD2.22',
  '1297945788377836': 'BM 3.1',
  '3313861842124068': 'BM 3.2',
  '1343265570424604': 'BM 3.3',
  '932875756194538': 'BM 1.1',
  '1257974532611757': 'BM 1.2',
  '1460178049143518': 'BM 1.3',
  '927174399921442': 'BM 1.4',
  '4353143571590707': 'BM 1.5',
};

const RESULT_RULES = [
  { match: o => /MESSAGE|ENGAGEMENT/.test(o), label: 'tin nhắn',
    types: ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection'] },
  { match: o => /SALES|CONVERSION/.test(o),  label: 'đơn hàng',
    types: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'] },
  { match: o => /LEAD/.test(o),              label: 'lead',
    types: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'] },
  { match: () => true,                        label: 'kết quả',
    types: ['link_click', 'landing_page_view'] },
];
function countResults(actions = [], objective = '') {
  const rule = RESULT_RULES.find(r => r.match(objective)) || RESULT_RULES[RESULT_RULES.length - 1];
  for (const t of rule.types) {
    const hit = actions.find(a => a.action_type === t);
    if (hit) return { value: Number(hit.value) || 0, label: rule.label };
  }
  return { value: 0, label: rule.label };
}

async function fb(endpoint, params, token) {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params || {}))
    url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`Meta API: ${json.error.message}`);
  return json;
}
async function fbAll(endpoint, params, token) {
  let data = await fb(endpoint, params, token);
  let out = data.data || [];
  while (data.paging && data.paging.next) {
    const res = await fetch(data.paging.next);
    data = await res.json();
    if (data.error) throw new Error(`Meta API: ${data.error.message}`);
    out = out.concat(data.data || []);
  }
  return out;
}

function listDays(since, until) {
  const days = [];
  for (let d = new Date(since); d <= new Date(until); d.setDate(d.getDate() + 1))
    days.push(d.toISOString().slice(0, 10));
  return days;
}

async function fetchAccount(acc, token, days, since, until) {
  const accName = ACCOUNT_NAMES[acc] || `TK ${acc}`;
  const camps = await fbAll(`act_${acc}/campaigns`, {
    fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,objective',
    limit: 500,
  }, token);

  const byId = {};
  for (const c of camps) {
    byId[c.id] = {
      acc, accName,
      id: c.id,
      name: c.name,
      employee: detectEmployee(c.name),
      on: c.effective_status === 'ACTIVE',
      objective: c.objective || '',
      budget: Number(c.daily_budget || c.lifetime_budget || 0),
      daily: days.map(() => ({ spent: 0, results: 0 })),
      obj: 'kết quả',
      link: null,
      adsets: [],
    };
  }

  // Ba nhóm truy vấn dưới đây độc lập nhau -> chạy SONG SONG cho nhanh.
  await Promise.all([

    // (1) Chi tiêu + kết quả theo từng ngày (cấp chiến dịch)
    (async () => {
      try {
        const insights = await fbAll(`act_${acc}/insights`, {
          level: 'campaign',
          fields: 'campaign_id,spend,actions,date_start',
          time_range: { since, until },
          time_increment: 1,
          limit: 1000,
        }, token);
        for (const row of insights) {
          const camp = byId[row.campaign_id];
          if (!camp) continue;
          const idx = days.indexOf(row.date_start);
          if (idx < 0) continue;
          const r = countResults(row.actions, camp.objective);
          camp.daily[idx] = { spent: Number(row.spend || 0), results: r.value };
          camp.obj = r.label;
        }
      } catch (e) { /* bỏ qua, các số liệu khác vẫn hiển thị */ }
    })(),

    // (2) Link bài quảng cáo (cấp ad), ưu tiên ad đang chạy
    (async () => {
      try {
        const ads = await fbAll(`act_${acc}/ads`, {
          fields: 'campaign_id,effective_status,preview_shareable_link,creative{effective_object_story_id}',
          limit: 500,
        }, token);
        const chosen = {};
        for (const ad of ads) {
          const cid = ad.campaign_id;
          if (!cid || !byId[cid]) continue;
          const link = (ad.creative && ad.creative.effective_object_story_id
                  ? `https://www.facebook.com/${ad.creative.effective_object_story_id}` : null)
            || ad.preview_shareable_link
            || null;
          if (!link) continue;
          const active = ad.effective_status === 'ACTIVE';
          if (!chosen[cid] || (active && !chosen[cid].active)) chosen[cid] = { link, active };
        }
        for (const cid in chosen) byId[cid].link = chosen[cid].link;
      } catch (e) { /* bỏ qua link nếu lỗi */ }
    })(),

    // (3) Nhóm quảng cáo (ad set): ngân sách + chi tiêu từng nhóm
    (async () => {
      try {
        const [adsets, asInsights] = await Promise.all([
          fbAll(`act_${acc}/adsets`, {
            fields: 'id,name,campaign_id,daily_budget,lifetime_budget,effective_status',
            limit: 500,
          }, token),
          fbAll(`act_${acc}/insights`, {
            level: 'adset',
            fields: 'adset_id,spend,actions',
            time_range: { since, until },
            limit: 1000,
          }, token),
        ]);
        const asById = {};
        for (const a of adsets) {
          if (!byId[a.campaign_id]) continue;
          asById[a.id] = {
            campaign_id: a.campaign_id,
            name: a.name,
            budget: Number(a.daily_budget || a.lifetime_budget || 0),
            on: a.effective_status === 'ACTIVE',
            spent: 0, results: 0,
          };
        }
        for (const row of asInsights) {
          const as = asById[row.adset_id];
          if (!as) continue;
          const objective = byId[as.campaign_id] ? byId[as.campaign_id].objective : '';
          as.spent = Number(row.spend || 0);
          as.results = countResults(row.actions, objective).value;
        }
        const budgetSum = {};
        for (const id in asById) {
          const as = asById[id];
          const camp = byId[as.campaign_id];
          if (!camp) continue;
          camp.adsets.push({ name: as.name, budget: as.budget, spent: as.spent, results: as.results, on: as.on });
          if (as.on) budgetSum[as.campaign_id] = (budgetSum[as.campaign_id] || 0) + as.budget;
        }
        for (const cid in budgetSum) {
          if (byId[cid] && !byId[cid].budget) byId[cid].budget = budgetSum[cid];
        }
      } catch (e) { /* bỏ qua nhóm nếu lỗi */ }
    })(),

  ]);

  return Object.values(byId);
}

/* ---------- Đăng nhập ---------- */
app.set('trust proxy', 1);
// Lưu phiên đăng nhập ra FILE để KHÔNG bị đăng xuất khi máy chủ khởi động lại
const SESS_FILE = path.join(__dirname, 'sessions.json');
class FileSessionStore extends session.Store {
  constructor() {
    super();
    this.sessions = {};
    try { this.sessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch { this.sessions = {}; }
  }
  _save() { try { fs.writeFileSync(SESS_FILE, JSON.stringify(this.sessions)); } catch {} }
  get(sid, cb) { try { const s = this.sessions[sid]; cb(null, s ? JSON.parse(s) : null); } catch (e) { cb(e); } }
  set(sid, sess, cb) { this.sessions[sid] = JSON.stringify(sess); this._save(); if (cb) cb(null); }
  destroy(sid, cb) { delete this.sessions[sid]; this._save(); if (cb) cb(null); }
  touch(sid, sess, cb) { this.sessions[sid] = JSON.stringify(sess); this._save(); if (cb) cb(null); }
}

app.use(session({
  store: new FileSessionStore(),
  secret: process.env.SESSION_SECRET || 'doi-thanh-mot-chuoi-bi-mat-ngau-nhien',
  resave: false,
  saveUninitialized: false,
  // KHÔNG đặt maxAge -> cookie phiên: chỉ đăng xuất khi ĐÓNG trình duyệt,
  //  và vì phiên lưu ra file nên Redeploy/Restart không làm đăng xuất nữa.
  cookie: { httpOnly: true, sameSite: 'lax' },
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function loginPage(error) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Đăng nhập — Check ADS TDMJSC</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#10192B;color:#fff;display:grid;place-items:center;min-height:100vh;}
  .box{background:#1C2A42;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:30px 28px;width:320px;max-width:90vw;}
  h1{font-size:18px;margin:0 0 4px;} p{color:#9FB0C8;font-size:13px;margin:0 0 20px;}
  label{display:block;font-size:13px;color:#C4D0E2;margin:14px 0 6px;}
  input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;border:1px solid rgba(255,255,255,.15);background:#10192B;color:#fff;font-size:14px;outline:none;}
  input:focus{border-color:#0E8C76;}
  button{width:100%;margin-top:20px;padding:12px;border:none;border-radius:9px;background:#0E8C76;color:#fff;font-size:15px;font-weight:600;cursor:pointer;}
  .err{background:#3a1d1d;color:#ffb4a8;font-size:13px;padding:9px 11px;border-radius:8px;margin-top:14px;}
</style></head><body>
<form class="box" method="POST" action="/login">
  <h1>Check ADS TDMJSC</h1><p>Đăng nhập để xem báo cáo</p>
  <label>Tên đăng nhập</label><input name="user" autocomplete="username" required>
  <label>Mật khẩu</label><input name="pass" type="password" autocomplete="current-password" required>
  ${error ? '<div class="err">Sai tên đăng nhập hoặc mật khẩu.</div>' : ''}
  <button type="submit">Đăng nhập</button>
</form></body></html>`;
}

app.get('/login', (req, res) => res.send(loginPage(req.query.error)));
app.post('/login', (req, res) => {
  const { user, pass } = req.body;
  const u = USERS.find(x => x.user === user && x.pass === pass);
  if (!u) return res.redirect('/login?error=1');
  req.session.user = { user: u.user, role: u.role, employees: u.employees || [], manager: u.manager || '', salaryName: u.salaryName || '' };
  res.redirect(u.role === 'product' ? '/products.html' : (u.role === 'staff' ? '/my-salary.html' : '/'));
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ===================================================================
//  GẮN MODULE THÁI LAN (an toàn — lỗi ở đây KHÔNG làm sập app chính)
//  Đặt TRƯỚC middleware bắt buộc đăng nhập để webhook Ladipage gọi được.
//  Import động mysql2 + module thailand, bọc try/catch toàn bộ.
// ===================================================================
(async () => {
  try {
    const [{ mountThailand }, mysqlMod] = await Promise.all([
      import('./thailand.js'),
      import('mysql2/promise'),
    ]);
    const mysql = mysqlMod.default || mysqlMod;
    mountThailand(app, { mysql, express, getCampaigns, QC_TAX: Number(process.env.QC_TAX || 0.11),
      exposeCounter: (fn) => { global.__thaiOrderCounts = fn; } });
  } catch (e) {
    console.error('[thailand] KHÔNG gắn được module (app chính vẫn chạy bình thường):', e.message);
  }
})();


// Từ đây trở xuống yêu cầu đăng nhập
app.use((req, res, next) => {
  // BỎ QUA mọi đường dẫn /thailand — module Thailand TỰ LO auth riêng (webhook + login riêng)
  // (mountThailand chạy async nên route /thailand đăng ký SAU middleware này → phải loại trừ ở đây)
  if (req.path === '/thailand' || req.path.startsWith('/thailand/')) return next();
  if (req.path === '/telegram/webhook') return next(); // Telegram gọi webhook không có session
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.redirect('/login');
});

// Cho trang biết người đang đăng nhập là ai (để ẩn/hiện menu, lọc theo người)
app.get('/api/me', (req, res) => {
  const u = req.session.user || {};
  // Tên hiển thị: ưu tiên salaryName, rồi manager, rồi người đầu trong employees, cuối cùng là username
  const displayName = u.salaryName || u.manager || (u.employees && u.employees[0]) || u.user || '';
  res.json({ user: u.user, role: u.role, manager: u.manager || '', employees: u.employees || [], salaryName: u.salaryName || '', displayName });
});

// QUYỀN "product": chỉ được vào trang Sản phẩm + API sản phẩm của mình.
// Chặn Dashboard, Marketing và mọi API khác.
app.use((req, res, next) => {
  const me = req.session.user;
  if (me && me.role === 'product') {
    const p = req.path;
    const allowed = ['/products.html', '/my-salary.html', '/logout', '/api/products/report', '/api/me', '/api/my-salary/months', '/api/my-salary/detail'].includes(p) || p === '/favicon.ico';
    if (!allowed) {
      if (p.startsWith('/api/')) return res.status(403).json({ error: 'Không có quyền truy cập mục này.' });
      return res.redirect('/products.html');
    }
  }
  // QUYỀN "staff": chỉ xem lương của mình (my-salary.html)
  if (me && me.role === 'staff') {
    const p = req.path;
    const allowed = ['/my-salary.html', '/logout', '/api/me', '/api/my-salary/months', '/api/my-salary/detail'].includes(p) || p === '/favicon.ico';
    if (!allowed) {
      if (p.startsWith('/api/')) return res.status(403).json({ error: 'Không có quyền truy cập mục này.' });
      return res.redirect('/my-salary.html');
    }
  }
  // Marketing (viewer): chỉ Dashboard + Marketing, KHÔNG vào trang Sản phẩm
  if (me && me.role === 'viewer') {
    const p = req.path;
    if (p === '/products.html' || p.startsWith('/api/products')) {
      if (p.startsWith('/api/')) return res.status(403).json({ error: 'Không có quyền truy cập mục này.' });
      return res.redirect('/');
    }
  }
  // Trang Lương: chỉ admin
  if (me && me.role !== 'admin') {
    const p = req.path;
    if (p === '/salary.html' || p.startsWith('/api/salary')) {
      if (p.startsWith('/api/')) return res.status(403).json({ error: 'Chỉ quản trị viên xem được mục Lương.' });
      return res.redirect('/');
    }
  }
  next();
});

// Bộ nhớ đệm tạm trong RAM: giữ kết quả theo từng khoảng ngày trong vài phút,
// để các lần mở/đăng nhập lại không phải gọi lại Meta -> nhanh hơn nhiều.
const DATA_CACHE = new Map();
const CACHE_MS = 3 * 60 * 1000; // 3 phút

// ===== CACHE VĨNH VIỄN cho các khoảng ngày ĐÃ QUA (chi tiêu Meta cố định) =====
// Lưu file trong DATA_DIR. Chỉ cache khi until < hôm nay (dữ liệu không còn đổi).
const META_CACHE_FILE = path.join(DATA_DIR, 'meta-cache.json');
let META_CACHE = {};
try { META_CACHE = JSON.parse(fs.readFileSync(META_CACHE_FILE, 'utf8')); } catch { META_CACHE = {}; }
let metaCacheSaveTimer = null;
function saveMetaCache() {
  // Gộp nhiều lần ghi trong 2 giây thành 1 lần để đỡ ghi đĩa liên tục
  clearTimeout(metaCacheSaveTimer);
  metaCacheSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(META_CACHE_FILE, JSON.stringify(META_CACHE)); } catch (e) {}
  }, 2000);
}
// Khoảng [since, until] đã hoàn toàn nằm trong quá khứ chưa? (until < hôm nay theo giờ VN)
function isPastRange(until) {
  const today = new Date();
  // Giờ VN = UTC+7
  const vnNow = new Date(today.getTime() + 7 * 3600 * 1000);
  const todayStr = vnNow.toISOString().slice(0, 10);
  return until < todayStr; // until trước hôm nay → cố định
}

// Nạp 1 tài khoản, tự thử lại nếu lỗi (token nặng/timeout thỉnh thoảng rớt)
async function fetchAccountRetry(acc, token, days, since, until, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fetchAccount(acc, token, days, since, until); }
    catch (e) { lastErr = e; await sleep(800); }
  }
  throw lastErr;
}
// Nạp toàn bộ campaign (mọi tài khoản). CHỈ lưu đệm khi nạp ĐỦ tất cả tài khoản,
// để tránh lưu nhầm dữ liệu thiếu (gây dashboard/lương về 0).
async function getCampaigns(since, until) {
  const days = listDays(since, until);
  const key = since + '|' + until;
  const past = isPastRange(until);

  // (1) Khoảng đã qua: nếu có trong cache file → trả luôn, KHÔNG gọi API Facebook
  if (past && META_CACHE[key] && Array.isArray(META_CACHE[key].campaigns)) {
    return META_CACHE[key].campaigns;
  }

  // (2) Cache RAM ngắn hạn (3 phút) cho khoảng có hôm nay
  const cached = DATA_CACHE.get(key);
  if (cached && cached.complete && Date.now() - cached.at < CACHE_MS) return cached.campaigns;

  // (3) Gọi API Facebook
  const tasks = [];
  for (const src of SOURCES)
    for (const acc of src.accounts)
      tasks.push(fetchAccountRetry(acc, src.token, days, since, until));
  const results = await Promise.allSettled(tasks);
  const campaigns = [];
  let failed = 0;
  for (const r of results) { if (r.status === 'fulfilled') campaigns.push(...r.value); else failed++; }

  if (failed === 0) {
    DATA_CACHE.set(key, { at: Date.now(), campaigns, complete: true });
    // Khoảng đã qua + lấy đủ tất cả tài khoản → LƯU VĨNH VIỄN (chi tiêu không đổi nữa)
    if (past) {
      META_CACHE[key] = { at: new Date().toISOString(), campaigns };
      saveMetaCache();
    }
  }
  return campaigns; // thiếu tài khoản -> trả tạm, KHÔNG lưu, lần sau nạp lại
}

app.get('/api/data', async (req, res) => {
  try {
    const since = req.query.since || '2026-06-01';
    const until = req.query.until || '2026-06-09';
    const days = listDays(since, until);
    const campaigns = await getCampaigns(since, until);

    // Lọc theo quyền: viewer chỉ thấy nhân viên được phép
    const me = req.session.user;
    let visible = campaigns;
    if (me.role !== 'admin') {
      const allow = new Set(me.employees || []);
      visible = campaigns.filter(c => allow.has(c.employee));
    }
    res.json({ days, campaigns: visible, me: { user: me.user, role: me.role, displayName: me.salaryName || me.manager || (me.employees && me.employees[0]) || me.user || '' } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================================================================
   MARKETING — lấy từ API Sandbox (trang quản lý đơn hàng)
   Xem ĐƠN / DOANH THU theo từng nhân viên marketing.
   - Cần biến môi trường SANDBOX_TOKEN (sinh trong trang quản trị Sandbox:
     {domain}/caidat/he-thong → tab "Cài đặt API truy vấn data").
   - API giới hạn 60 GIÂY/LẦN mỗi endpoint → phải tải NGẦM, có bộ nhớ đệm.
   - Mỗi request lọc tối đa 1 THÁNG, mỗi trang tối đa 100 bản ghi.
   ========================================================================= */
const SANDBOX_BASE = process.env.SANDBOX_BASE || 'https://api.sandbox.com.vn/partner/api';
const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || '';
// Chi nhánh: mặc định null = (chi nhánh duy nhất của bạn). Có thể khai
//  SANDBOX_BRANCH = '<mã chi nhánh>' nếu sau này cần lọc riêng.
const _branchEnv = process.env.SANDBOX_BRANCH;
const SANDBOX_BRANCH = (_branchEnv && _branchEnv !== 'null') ? _branchEnv : null;
const MKT_PAGE_DELAY_MS = 62 * 1000; // chờ 62s giữa các trang (API giới hạn ~60s/lần)
const MKT_MAX_PAGES = 40;            // tối đa 40 trang/lần (mỗi trang ~60s)

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Cộng 1 ngày (YYYY-MM-DD) -> dùng cho denNgay để lấy trọn ngày cuối
const addDay = s => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

// Trạng thái + kết quả marketing (giữ trong RAM, không chặn request)
const MKT = { fetching: false, lastUpdated: null, since: null, until: null,
              rows: [], totalRecord: 0, loaded: 0, error: null };

// Đơn "đã giao thành công" — dựa vào MÃ trạng thái giao vận (orderStatusId).
//  Theo dữ liệu thật: 31 = Đã giao hàng, 32 = Đã giao + đã đối soát.
//  Nếu muốn tính thêm/bớt trạng thái, sửa danh sách SHIP_OK_STATUS dưới đây.
const SHIP_OK_STATUS = ['31', '32'];
function isShippedOK(o) {
  return SHIP_OK_STATUS.includes(String(o.orderStatusId));
}

/* ============================ HƯỚNG A ============================
   Đăng nhập web Sandbox bằng tài khoản (lưu ở biến môi trường) để gọi
   API BÁO CÁO "lead theo nhân sự" — chính xác theo NGÀY TẠO, 1 lần gọi.
   Cần khai trên máy chủ:
     SANDBOX_WEB_USER = <tài khoản web>
     SANDBOX_WEB_PASS = <mật khẩu web>
   (Mã chi nhánh đã điền sẵn; đổi qua SANDBOX_CHINHANH nếu cần.)
   ================================================================= */
const SANDBOX_WEB_USER  = process.env.SANDBOX_WEB_USER || '';
const SANDBOX_WEB_PASS  = process.env.SANDBOX_WEB_PASS || '';
const SANDBOX_AUTH_BASE = process.env.SANDBOX_AUTH_BASE || 'https://api.sandbox.com.vn/auth/';
const SANDBOX_REPORT_URL = process.env.SANDBOX_REPORT_URL
  || 'https://api.sandbox.com.vn/report/api/report/ReportLeadByNhanSuMktSearch';
const SANDBOX_CHINHANH  = process.env.SANDBOX_CHINHANH || 'f13cc0dc-28f0-4d17-b7aa-4f190fe6c4ae';
// Mã thiết bị (lấy từ cookie prodevice_id của trình duyệt bạn) — để server "giống" thiết bị quen.
const SANDBOX_DEVICE_ID = process.env.SANDBOX_DEVICE_ID || '2bfd88c7-ea01-482e-8be8-4ad20373d911';
// Tên miền của bạn — server gửi kèm để Sandbox biết bạn thuộc tổ chức nào (như ô "tên miền" lúc đăng nhập).
const SANDBOX_ORIGIN = (process.env.SANDBOX_ORIGIN || 'https://tdmjsc.sandbox.com.vn').replace(/\/+$/, '');

let sandboxCookie = '';        // chuỗi Cookie sau khi đăng nhập web
let sandboxLoginAt = null;

// Mã hoá một chuỗi (userName hoặc password) y hệt web Sandbox:
//  1) sinh khoá 16 ký tự, 2) AES-128-ECB/Pkcs7 -> base64,
//  3) chèn khoá ngay sau CHỮ SỐ ĐẦU TIÊN trong chuỗi base64 (server tự tách ra).
function sandboxEncrypt(text) {
  const key = crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, 'x').slice(0, 16).padEnd(16, 'x');
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null); // Pkcs7 mặc định
  const b64 = cipher.update(text, 'utf8', 'base64') + cipher.final('base64');
  let f = -1;
  for (let i = 0; i < b64.length; i++) { const c = b64[i]; if (c >= '0' && c <= '9') { f = i + 1; break; } }
  if (f === -1) return key + b64; // không có chữ số -> theo đúng hành vi substring của web
  return b64.slice(0, f) + key + b64.slice(f);
}

// Đăng nhập web -> lấy cookie phiên. KHÔNG log mật khẩu.
async function sandboxLogin() {
  if (!SANDBOX_WEB_USER || !SANDBOX_WEB_PASS)
    throw new Error('Chưa khai SANDBOX_WEB_USER / SANDBOX_WEB_PASS trên máy chủ.');
  const r = await fetch(SANDBOX_AUTH_BASE + 'api/Authen/login-encrypt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*',
      'Origin': SANDBOX_ORIGIN, 'Referer': SANDBOX_ORIGIN + '/',
      'Cookie': `prodevice_id=${SANDBOX_DEVICE_ID}`,
    },
    body: JSON.stringify({
      userName: sandboxEncrypt(SANDBOX_WEB_USER),
      password: sandboxEncrypt(SANDBOX_WEB_PASS),
      deviceId: SANDBOX_DEVICE_ID,
      captcha: '',
    }),
  });
  let setCookies = [];
  try { setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : []; } catch (e) {}
  if (!setCookies || !setCookies.length) { const sc = r.headers.get('set-cookie'); if (sc) setCookies = [sc]; }
  const jar = { prodevice_id: SANDBOX_DEVICE_ID };
  for (const c of setCookies) { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  sandboxCookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  let body = null; try { body = await r.json(); } catch (e) {}
  sandboxLoginAt = new Date().toISOString();
  return {
    httpStatus: r.status, coGanCookie: Object.keys(jar).length > 1, soCookie: Object.keys(jar).length - 1,
    success: body ? (body.success ?? body.Success) : undefined,
    message: body ? (body.message || body.Message) : undefined,
  };
}

// Gọi API báo cáo cho khoảng ngày [since, until] (YYYY-MM-DD). Tự đăng nhập lại nếu phiên hết hạn.
async function sandboxReport(since, until) {
  const tuNgay = `${since}T00:00:00.000+07:00`;
  const denNgay = `${until}T23:59:59.998+07:00`;
  const payload = {
    pageInfo: { page: 1, pageSize: 1000 }, sorts: [],
    kieuXem: 4, loaiNhanVien: 1, isChietKhau: true, isVat: true,
    date: [tuNgay, denNgay], tuNgay, denNgay,
    idChiNhanh: SANDBOX_CHINHANH, kieuNgay: 'NgayTao',
    typeViewDetail: null, idPhongBanSale: null, idNhomNhanVienSale: null, idUserSale: null,
    idPhongBanMkts: null, idNhomNhanVienMkts: null, idUserMkts: null,
  };
  const call = () => fetch(SANDBOX_REPORT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*',
      'Origin': SANDBOX_ORIGIN, 'Referer': SANDBOX_ORIGIN + '/',
      'Cookie': sandboxCookie,
    },
    body: JSON.stringify(payload),
  });
  if (!sandboxCookie) await sandboxLogin();
  let r = await call();
  if (r.status === 401 || r.status === 403) { await sandboxLogin(); r = await call(); }
  const j = await r.json().catch(() => ({ success: false, message: 'Phản hồi không hợp lệ' }));
  return { httpStatus: r.status, json: j };
}

// Chuyển dữ liệu báo cáo -> dạng bảng cho dashboard
function mapReport(j) {
  const d = (j && j.data) || {};
  const rows = (d.reportLeadByNhanSuMktDtos || []).map(r => ({
    name: (r.ten || '').trim(), contact: r.soContact, chot: r.soDonChot,
    tyLe: r.tyLeChotDon, soSP: r.soLuongSanPham, doanhthu: r.doanhSo,
    nganSach: r.nganSach, giaContact: r.giaContact,
  }));
  const t = d.reportLeadByNhanSuMktTotalDto || {};
  const total = {
    contact: t.tongSoContact, chot: t.tongSoDonHang, soSP: t.tongSanPham,
    tyLe: t.tongTyLeChot, doanhthu: t.tongDoanhSo,
    nganSach: t.tongNganSach, giaContact: t.giaContact,
  };
  return { rows, total };
}

function aggregateMarketing(orders, acc) {
  for (const o of orders) {
    const key = ((o.marketingDisplayName || o.marketingUserName || '').trim()) || '(không rõ)';
    if (!acc[key]) acc[key] = { name: key, data: 0, chot: 0, ship: 0, doanhthu: 0, products: {} };
    const a = acc[key];
    a.data += 1;                                    // số đơn
    if (String(o.orderConfirmId) === '1') {         // 1 = đã chốt đơn
      a.chot += 1;                                  // đơn chốt thành công
      a.doanhthu += Number(o.totalPrice || 0);      // tiền đơn cuối
    }
    if (isShippedOK(o)) a.ship += 1;                // đơn ship thành công
    // Gom sản phẩm của đơn (cần isIncludeDetail = true)
    const items = Array.isArray(o.details) ? o.details : [];
    const seen = new Set();
    for (const d of items) {
      const ten = ((d.itemName || d.tenSanPham || d.productName || d.name || '') + '').trim();
      if (!ten) continue;
      if (!a.products[ten]) a.products[ten] = { ten, soDon: 0, soLuong: 0 };
      a.products[ten].soLuong += Number(d.quantity || d.soLuong || 0);
      if (!seen.has(ten)) { a.products[ten].soDon += 1; seen.add(ten); } // số đơn chứa SP này
    }
  }
}

async function refreshMarketing(since, until) {
  if (MKT.fetching) return;
  if (!SANDBOX_TOKEN) { MKT.error = 'Chưa khai SANDBOX_TOKEN trên máy chủ.'; return; }
  MKT.fetching = true; MKT.error = null; MKT.since = since; MKT.until = until;
  MKT.rows = []; MKT.loaded = 0; MKT.totalRecord = 0;
  const acc = {};
  const seenOrders = new Set(); // mã đơn đã tính -> chống đếm trùng khi API trả lại trang cũ
  let rateRetries = 0;
  try {
    for (let page = 1; page <= MKT_MAX_PAGES; page++) {
      const res = await fetch(`${SANDBOX_BASE}/DonHangLogistic/GetOrderByConditions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SANDBOX_TOKEN}` },
        body: JSON.stringify({
          idChiNhanh: SANDBOX_BRANCH,
          kieuNgay: 'NgayTao',
          tuNgay: since,            // ngày-trơn YYYY-MM-DD (API chỉ lọc đúng với kiểu này)
          denNgay: addDay(until),   // +1 ngày để lấy trọn ngày cuối
          pageInfo: { page, pageSize: 100 },
          sorts: [],
          isIncludeDetail: true,  // lấy danh sách sản phẩm của đơn
          isHistories: false,
        }),
      });
      const json = await res.json().catch(() => ({ success: false, message: 'Phản hồi không hợp lệ từ Sandbox' }));
      if (!json.success) {
        const msg = String(json.message || json.Message || '');
        // Bị giới hạn tốc độ ("cần chờ Ns ...") -> đợi đúng số giây báo rồi thử lại trang này
        if (/chờ|cần chờ|call api|giây|rate|quá nhanh/i.test(msg) && rateRetries < 8) {
          const m = msg.match(/(\d+)\s*s/);
          const waitMs = (m ? Number(m[1]) + 3 : 62) * 1000;
          rateRetries++; await sleep(waitMs); page--; continue;
        }
        MKT.error = msg || 'API Sandbox báo lỗi (kiểm tra token).'; break;
      }
      rateRetries = 0;
      const orders = json.data || [];
      // Lọc: chỉ đơn MỚI (chống trùng) VÀ đúng khoảng ngày theo createTime (chốt chặn phía mình)
      let newSeen = 0;
      const fresh = [];
      for (const o of orders) {
        const id = String(o.orderId || o.orderNumber || o.orderCode || '');
        if (!id || seenOrders.has(id)) continue;
        seenOrders.add(id); newSeen++;
        const d = (o.createTime || '').slice(0, 10);
        if (d && (d < since || d > until)) continue; // ngoài khoảng ngày -> không tính
        fresh.push(o);
      }
      aggregateMarketing(fresh, acc);
      MKT.loaded = seenOrders.size;
      MKT.totalRecord = seenOrders.size;
      MKT.rows = Object.values(acc).map(r => {
        const prods = Object.values(r.products).sort((x, y) => y.soDon - x.soDon);
        return {
          name: r.name, soDon: r.data, chot: r.chot, ship: r.ship,
          soSP: prods.reduce((s, p) => s + p.soLuong, 0), // tổng số lượng sản phẩm
          doanhthu: r.doanhthu, products: prods,
        };
      }).sort((a, b) => (b.chot - a.chot) || (b.doanhthu - a.doanhthu)); // điền dần để xem tiến độ
      if (orders.length < 100) break;   // trang chưa đủ 100 -> server đã hết dữ liệu
      if (newSeen === 0) break;         // không còn đơn mới -> dừng (tránh lặp vô tận)
      await sleep(MKT_PAGE_DELAY_MS);    // tôn trọng giới hạn tốc độ API (~60s)
    }
    MKT.lastUpdated = new Date().toISOString();
  } catch (e) {
    MKT.error = e.message;
  } finally {
    MKT.fetching = false;
  }
}

app.get('/api/marketing', (req, res) => {
  res.json({
    ver: 'mkt-2026-06-15-v11', // hướng A: đăng nhập web + API báo cáo
    fetching: MKT.fetching, lastUpdated: MKT.lastUpdated,
    since: MKT.since, until: MKT.until,
    rows: MKT.rows, totalRecord: MKT.totalRecord, loaded: MKT.loaded,
    error: MKT.error, hasToken: !!SANDBOX_TOKEN,
  });
});

app.post('/api/marketing/refresh', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const since = (req.body && req.body.since) || (today.slice(0, 8) + '01');
  const until = (req.body && req.body.until) || today;
  if (MKT.fetching) return res.json({ started: false, message: 'Đang cập nhật, vui lòng đợi.' });
  refreshMarketing(since, until); // chạy NGẦM, không await
  res.json({ started: true, since, until });
});

// (HƯỚNG A) Kiểm tra đăng nhập web + thử lấy báo cáo 1 ngày. KHÔNG lộ mật khẩu.
//  Mở: /api/marketing/login-test?day=2026-06-12
app.get('/api/marketing/login-test', async (req, res) => {
  const day = req.query.day || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (!SANDBOX_WEB_USER || !SANDBOX_WEB_PASS)
    return res.json({ ok: false, buoc: 'cauHinh', message: 'Chưa khai SANDBOX_WEB_USER / SANDBOX_WEB_PASS trên máy chủ.' });
  try {
    const login = await sandboxLogin();
    let report = null, total = null;
    if (login.coGanCookie) {
      const rp = await sandboxReport(day, day);
      report = { httpStatus: rp.httpStatus, success: rp.json && (rp.json.success ?? rp.json.Success), message: rp.json && (rp.json.message || rp.json.Message) };
      const m = mapReport(rp.json); total = m.total; report.soNhanVien = m.rows.length;
    }
    res.json({ ok: !!(login.coGanCookie && total && total.contact != null), day, dangNhap: login, baoCao: report, tong: total });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// (HƯỚNG A) Lấy báo cáo lead theo nhân sự cho khoảng ngày (mặc định hôm qua).
//  Gộp chi tiêu thực từ Meta API vào cột "chiTieu" và tính lại "giaContact".
//  Mở: /api/marketing/report?since=2026-06-12&until=2026-06-12
app.get('/api/marketing/report', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const since = req.query.since || today;
  const until = req.query.until || since;
  try {
    // Chạy song song: Sandbox report + Meta spend + đơn Thái
    const [rp, metaSpend, thaiCounts] = await Promise.all([
      sandboxReport(since, until),
      (async () => {
        try {
          // Tổng hợp chi tiêu Meta theo nhân viên (dùng lại getCampaigns đã có)
          const campaigns = await getCampaigns(since, until);
          const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
          const spend = {};
          for (const c of campaigns) {
            const emp = norm(c.employee || '');
            if (!emp || emp === 'chưa xác định') continue;
            const s = (c.daily || []).reduce((t, d) => t + (Number(d.spent) || 0), 0);
            spend[emp] = (spend[emp] || 0) + s;
          }
          return spend;
        } catch (e) {
          return {}; // nếu Meta lỗi vẫn trả Sandbox bình thường
        }
      })(),
      (async () => {
        try { return (typeof global.__thaiOrderCounts === 'function') ? await global.__thaiOrderCounts(since, until) : {}; }
        catch (e) { return {}; }
      })(),
    ]);

    if (!(rp.json && (rp.json.success ?? rp.json.Success)))
      return res.json({ ok: false, since, until, httpStatus: rp.httpStatus, message: (rp.json && (rp.json.message || rp.json.Message)) || 'Lỗi gọi báo cáo' });

    const m = mapReport(rp.json);
    const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

    // Gắn chi tiêu Meta vào từng dòng, tính lại giaContact
    let rows = m.rows.map(r => {
      // Dùng chung QC_TAX với module lương (mặc định 11%, cấu hình qua .env)
      const TAX = 1 + QC_TAX;
      const chiTieu = Math.round((metaSpend[norm(r.name)] || 0) * TAX);
      const giaContact = (chiTieu > 0 && r.contact > 0) ? Math.round(chiTieu / r.contact) : 0;
      const donThai = thaiCounts[norm(r.name)] || 0;
      const tongDon = (Number(r.contact) || 0) + donThai;  // TỔNG ĐƠN = số contact + đơn Thái
      const cpa = (chiTieu > 0 && tongDon > 0) ? Math.round(chiTieu / tongDon) : 0;  // CPA = chi tiêu / (contact + đơn Thái)
      return { ...r, chiTieu, giaContact, donThai, tongDon, cpa };
    });

    // Lọc theo quyền
    const me = req.session.user || {};
    if (me.role !== 'admin') {
      const allow = new Set((me.employees || []).map(norm));
      rows = rows.filter(r => allow.has(norm(r.name)));
    }

    // Tính lại Tổng
    const s = rows.reduce((a, r) => ({
      contact:  a.contact  + (+r.contact  || 0),
      chot:     a.chot     + (+r.chot     || 0),
      soSP:     a.soSP     + (+r.soSP     || 0),
      doanhthu: a.doanhthu + (+r.doanhthu || 0),
      chiTieu:  a.chiTieu  + (+r.chiTieu  || 0),
      donThai:  a.donThai  + (+r.donThai  || 0),
    }), { contact: 0, chot: 0, soSP: 0, doanhthu: 0, chiTieu: 0, donThai: 0 });

    const total = {
      contact:    s.contact,
      chot:       s.chot,
      soSP:       s.soSP,
      doanhthu:   s.doanhthu,
      chiTieu:    s.chiTieu,
      donThai:    s.donThai,
      tongDon:    s.contact + s.donThai,
      tyLe:       s.contact ? (s.chot / s.contact * 100) : 0,
      giaContact: s.contact ? Math.round(s.chiTieu / s.contact) : 0,
      cpa:        (s.contact + s.donThai) ? Math.round(s.chiTieu / (s.contact + s.donThai)) : 0,
    };

    rows.sort((a, b) => (b.doanhthu || 0) - (a.doanhthu || 0));
    res.json({ ok: true, ver: 'mkt-2026-06-23-v13', since, until, rows, total, lastUpdated: new Date().toISOString() });
  } catch (e) {
    res.json({ ok: false, since, until, message: e.message });
  }
});

// (TẠM — để gỡ lỗi) Xem cấu trúc dữ liệu thật từ Sandbox: mở /api/marketing/sample
//  để biết đúng tên trường sản phẩm + trạng thái giao hàng. Xoá sau khi đã chỉnh xong.
app.get('/api/marketing/sample', async (req, res) => {
  if (!SANDBOX_TOKEN) return res.json({ error: 'Chưa khai SANDBOX_TOKEN' });
  const today = new Date().toISOString().slice(0, 10);
  const since = req.query.since || (today.slice(0, 8) + '01');
  const until = req.query.until || today;
  // Thử các kiểu gửi ngày khác nhau để tìm đúng định dạng API chấp nhận:
  //  ?fmt=iso (mặc định) | dateonly | dateplus | notz | utc ;  ?kieu=NgayTao (mặc định)
  const fmt = req.query.fmt || 'iso';
  const kieuNgay = req.query.kieu || 'NgayTao';
  const pi = Number(req.query.pi) || 1;
  const addDay = s => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const tuNgay = (fmt === 'dateonly' || fmt === 'dateplus') ? since
    : fmt === 'notz' ? `${since}T00:00:00`
    : fmt === 'utc' ? `${since}T00:00:00.000Z`
    : `${since}T00:00:00+07:00`;
  const denNgay = fmt === 'dateplus' ? addDay(until)
    : fmt === 'dateonly' ? until
    : fmt === 'notz' ? `${until}T23:59:59`
    : fmt === 'utc' ? `${until}T23:59:59.999Z`
    : `${until}T23:59:59+07:00`;
  try {
    const r = await fetch(`${SANDBOX_BASE}/DonHangLogistic/GetOrderByConditions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SANDBOX_TOKEN}` },
      body: JSON.stringify({
        idChiNhanh: SANDBOX_BRANCH, kieuNgay,
        tuNgay, denNgay,
        pageInfo: { page: pi, pageSize: 100 }, sorts: [],
        isIncludeDetail: true, isHistories: true,
      }),
    });
    const json = await r.json();
    const orders = json.data || [];
    const o0 = orders[0] || {};
    const statusRe = /status|giao|ship|deliver|trangthai|confirm/i;
    const statusFields = {};
    for (const k of Object.keys(o0)) if (statusRe.test(k)) statusFields[k] = o0[k];
    const withDetails = orders.find(o => Array.isArray(o.details) && o.details.length);
    const dOnly = t => (t ? String(t).slice(0, 10) : null);
    const createDates = orders.map(o => dOnly(o.createTime));
    const outOfRange = createDates.filter(d => d && (d < since || d > until)).length;
    res.json({
      success: json.success, errMsg: json.message || json.Message || null,
      totalRecord: json.totalRecord, count: orders.length,
      triedFmt: fmt, triedKieu: kieuNgay, sentTuNgay: tuNgay, sentDenNgay: denNgay,
      askedRange: [since, until],
      outOfRangeCount: outOfRange,                 // > 0 => bộ lọc ngày KHÔNG ăn
      distinctCreateDates: [...new Set(createDates)].sort(),
      createTimeSample: orders.slice(0, 20).map(o => o.createTime),
      dateFieldsSample: orders.slice(0, 12).map(o => ({
        create: o.createTime, recv: o.timeSaleReceivingData,
        confirm: o.orderConfirmDate, submit: o.timeOrderSubmit, update: o.updateTime,
      })),
      orderKeys: Object.keys(o0),
      statusFields,
      anyDetailsNonEmpty: orders.some(o => Array.isArray(o.details) && o.details.length),
      detailsSampleKeys: withDetails ? Object.keys(withDetails.details[0]) : null,
      detailsSample: withDetails ? withDetails.details.slice(0, 2) : [],
    });
  } catch (e) { res.json({ error: e.message }); }
});

// (TẠM — tự dò) Thử lần lượt các kiểu ngày để biết kiểu nào API lọc theo NGÀY TẠO.
//  Mở /api/marketing/kieu-test?day=2026-06-12 để BẮT ĐẦU (chạy ngầm ~5-6 phút),
//  rồi mở lại chính link đó mỗi ~1 phút để xem kết quả điền dần. Xoá sau khi xong.
const KIEU_TEST = { running: false, day: null, startedAt: null, finishedAt: null, results: [], note: '' };
const KIEU_LIST = ['NgayTao', 'SaleNgayNhanData', 'DonHangNgayChot', 'NgayDangDon', 'NgayCapNhat'];

async function runKieuTest(day) {
  KIEU_TEST.running = true; KIEU_TEST.day = day;
  KIEU_TEST.startedAt = new Date().toISOString(); KIEU_TEST.finishedAt = null;
  KIEU_TEST.results = []; KIEU_TEST.note = '';
  const tuNgay = `${day}T00:00:00+07:00`;
  const denNgay = `${day}T23:59:59+07:00`;
  const dOnly = t => (t ? String(t).slice(0, 10) : null);
  try {
    for (const kieu of KIEU_LIST) {
      let attempt = 0, done = false;
      while (!done && attempt < 6) {
        attempt++;
        const r = await fetch(`${SANDBOX_BASE}/DonHangLogistic/GetOrderByConditions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SANDBOX_TOKEN}` },
          body: JSON.stringify({
            idChiNhanh: SANDBOX_BRANCH, kieuNgay: kieu,
            tuNgay, denNgay, pageInfo: { page: 1, pageSize: 100 }, sorts: [],
            isIncludeDetail: false, isHistories: false,
          }),
        });
        const json = await r.json().catch(() => ({ success: false, message: 'Phản hồi không hợp lệ' }));
        if (!json.success) {
          const msg = String(json.message || json.Message || '');
          if (/chờ|cần chờ|call api|giây|rate|quá nhanh/i.test(msg) && attempt < 6) {
            const m = msg.match(/(\d+)\s*s/);
            await sleep(((m ? Number(m[1]) : 60) + 3) * 1000); continue;
          }
          KIEU_TEST.results.push({ kieu, error: msg || 'lỗi', count: 0 });
          done = true; break;
        }
        const orders = json.data || [];
        const inRange = field => orders.filter(o => dOnly(o[field]) === day).length;
        KIEU_TEST.results.push({
          kieu, count: orders.length,
          createOnDay: inRange('createTime'),       // ngày tạo = đúng ngày?
          recvOnDay: inRange('timeSaleReceivingData'),
          confirmOnDay: inRange('orderConfirmDate'),
          submitOnDay: inRange('timeOrderSubmit'),
          updateOnDay: inRange('updateTime'),
          createSample: orders.slice(0, 3).map(o => o.createTime),
        });
        done = true;
      }
      await sleep(63 * 1000); // tôn trọng giới hạn ~60s/lần gọi
    }
  } catch (e) {
    KIEU_TEST.note = 'Lỗi: ' + e.message;
  } finally {
    KIEU_TEST.running = false; KIEU_TEST.finishedAt = new Date().toISOString();
  }
}

app.get('/api/marketing/kieu-test', (req, res) => {
  if (!SANDBOX_TOKEN) return res.json({ error: 'Chưa khai SANDBOX_TOKEN' });
  const day = req.query.day || '2026-06-12';
  if (!KIEU_TEST.running && (req.query.restart === '1' || KIEU_TEST.results.length === 0 || KIEU_TEST.day !== day)) {
    runKieuTest(day); // chạy ngầm, không await
  }
  res.json({
    huongDan: 'Mỗi kiểu cách nhau ~63s. Mở lại link này mỗi ~1 phút để xem kết quả điền dần. '
      + 'Kiểu nào có createOnDay gần bằng count chính là kiểu lọc theo NGÀY TẠO (đúng cái cần dùng).',
    running: KIEU_TEST.running, day: KIEU_TEST.day,
    startedAt: KIEU_TEST.startedAt, finishedAt: KIEU_TEST.finishedAt,
    daThu: KIEU_TEST.results.length + '/' + KIEU_LIST.length,
    results: KIEU_TEST.results, note: KIEU_TEST.note,
  });
});

/* ===================== TRANG SẢN PHẨM =====================
   - Người quản lý sản phẩm: đồng bộ từ Google Sheet (publish ra CSV).
       Khai SHEET_CSV_URL = link CSV của sheet.
   - Số contact + số đơn chốt theo sản phẩm: từ báo cáo Sandbox "MKT theo SP".
       (Dùng chung phiên đăng nhập web đã có. Nếu URL báo cáo khác, đặt SANDBOX_PRODUCT_REPORT_URL.)
   ========================================================== */
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || '';
const SANDBOX_PRODUCT_REPORT_URL = process.env.SANDBOX_PRODUCT_REPORT_URL
  || 'https://api.sandbox.com.vn/report/api/Report/BaoCaoMktTheoSanPham';

const normProd = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

// CSV/TSV parser nhỏ — tự nhận dấu phân tách (phẩy, tab, hoặc chấm phẩy)
function parseCSV(text) {
  const firstLine = (text.split(/\r?\n/)[0] || '');
  const n = ch => (firstLine.split(ch).length - 1);
  let delim = ',';
  if (n('\t') > n(delim)) delim = '\t';
  if (n(';') > n(delim)) delim = ';';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* bỏ */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

let OWNERS = {}, OWNERS_AT = 0; const OWNERS_TTL = 5 * 60 * 1000;
async function loadOwners(force) {
  if (!SHEET_CSV_URL) return OWNERS;
  if (!force && Object.keys(OWNERS).length && Date.now() - OWNERS_AT < OWNERS_TTL) return OWNERS;
  try {
    const r = await fetch(SHEET_CSV_URL, { redirect: 'follow' });
    const text = await r.text();
    const rows = parseCSV(text).filter(rw => rw.some(c => String(c).trim() !== ''));
    if (!rows.length) return OWNERS;
    let pCol = 0, mCol = 1, start = 0;
    const hdr = rows[0].map(h => String(h).trim().toLowerCase());
    const find = keys => hdr.findIndex(h => keys.some(k => h.includes(k)));
    const pc = find(['sản phẩm', 'san pham', 'sanpham', 'product', 'tên sp', 'ten sp']);
    const mc = find(['quản lý', 'quan ly', 'phụ trách', 'phu trach', 'nhân viên', 'nhan vien', 'người', 'nguoi']);
    let gc = find(['giá nhập', 'gia nhap', 'gianhap', 'giá vốn', 'gia von']);
    let dc = find(['ngày đăng', 'ngay dang', 'ngaydang', 'ngày tạo', 'ngay tao', 'ngày lên', 'ngay len']);
    if (pc >= 0 && mc >= 0) { pCol = pc; mCol = mc; start = 1; }
    if (gc < 0 && start === 1) gc = 3; // mặc định cột D = giá nhập
    if (dc < 0 && start === 1) dc = 4; // mặc định cột E = ngày đăng
    const toNum = v => { const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; };
    // Parse ngày DD/MM/YYYY hoặc DD-MM-YYYY -> 'YYYY-MM-DD' (null nếu trống/sai)
    const parseDate = v => {
      const s = String(v == null ? '' : v).trim();
      if (!s) return null;
      const mm = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
      if (!mm) return null;
      let d = mm[1], mo = mm[2], y = mm[3];
      y = y.length === 2 ? '20' + y : y;
      const dt = new Date(+y, +mo - 1, +d);
      return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
    };
    const map = {};
    for (let i = start; i < rows.length; i++) {
      const praw = String(rows[i][pCol] || '').trim();
      const m = String(rows[i][mCol] || '').trim();
      const giaNhap = gc >= 0 ? toNum(rows[i][gc]) : 0;
      const ngayDang = dc >= 0 ? parseDate(rows[i][dc]) : null;
      const p = normProd(praw);
      if (p && (m || giaNhap)) map[p] = { manager: m, productRaw: praw, giaNhap, ngayDang };
    }
    if (Object.keys(map).length) { OWNERS = map; OWNERS_AT = Date.now(); }
  } catch (e) { /* giữ bản cũ nếu lỗi */ }
  return OWNERS;
}

// Gọi báo cáo sản phẩm (dùng phiên đăng nhập web của máy chủ)
async function sandboxProductReport(since, until) {
  const tuNgay = `${since}T00:00:00+07:00`, denNgay = `${until}T23:59:59+07:00`;
  const payload = {
    strIdNguonDuLieu: null, kieuNgay: 'NgayTao', tuNgay, denNgay,
    idNhomSanPham: null, idSanPhamCha: null, idSanPham: null, unitCode: null,
    tiTrongChiaTinhTheo: 0, isChietKhau: true, isVat: true,
    idChiNhanh: SANDBOX_CHINHANH, typeViewDetail: null,
    idPhongBanSale: null, idNhomNhanVienSale: null, idUserSale: null,
    idPhongBanMkts: null, idNhomNhanVienMkts: null, idUserMkts: null,
    date: [tuNgay, denNgay], khoId: null,
    pageInfo: { page: 1, pageSize: 1000 }, sorts: [],
  };
  const call = url => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'Origin': SANDBOX_ORIGIN, 'Referer': SANDBOX_ORIGIN + '/', 'Cookie': sandboxCookie },
    body: JSON.stringify(payload),
  });
  if (!sandboxCookie) await sandboxLogin();
  let r = await call(SANDBOX_PRODUCT_REPORT_URL);
  if (r.status === 401 || r.status === 403) { await sandboxLogin(); r = await call(SANDBOX_PRODUCT_REPORT_URL); }
  const j = await r.json().catch(() => ({ success: false, message: 'Phản hồi không hợp lệ' }));
  return { httpStatus: r.status, json: j };
}

// Chuyển dữ liệu báo cáo sản phẩm -> bảng, ghép người quản lý từ Google Sheet
function mapProductReport(j, owners) {
  const d = (j && j.data) || {};
  // báo cáo trả về nhiều lưới; lấy lưới theo sản phẩm
  let arr = Array.isArray(d.productGridTable) ? d.productGridTable
          : Array.isArray(d.mainGridTable) ? d.mainGridTable : null;
  if (!Array.isArray(arr)) { for (const k of Object.keys(d)) { if (Array.isArray(d[k]) && d[k].length) { arr = d[k]; break; } } }
  arr = arr || [];
  const pick = (o, keys) => { for (const k of keys) if (o[k] != null) return o[k]; return null; };
  return arr.map(o => {
    const name = pick(o, ['tenSanPham', 'tenSp', 'sanPham', 'itemName', 'productName', 'ten', 'name']) || '';
    const contact = +pick(o, ['soLuongContact', 'soLuongContactThucTe', 'soContact', 'contact', 'tongSoContact', 'soLuongContactPercent']) || 0;
    const chot = +pick(o, ['soLuongChotDon', 'soLuongChotDonThucTe', 'soDonChot', 'soDonHang', 'donChot', 'soDon', 'chot', 'tongSoDonHang']) || 0;
    const own = owners[normProd(name)];
    return { product: String(name).trim(), manager: own ? own.manager : '', contact, chot };
  });
}

// Soi cấu trúc báo cáo sản phẩm (từ máy chủ). Mở:
//  /api/products/probe?since=2026-06-01&until=2026-06-17
// Trả về tên các lưới + tên cột + 1 dòng mẫu để chốt cột contact/đơn chốt.
app.get('/api/products/probe', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const since = req.query.since || today, until = req.query.until || since;
  try {
    const rp = await sandboxProductReport(since, until);
    const d = (rp.json && rp.json.data) || {};
    const grids = {};
    for (const k of Object.keys(d)) {
      const v = d[k];
      if (Array.isArray(v)) grids[k] = { n: v.length, keys: v.length ? Object.keys(v[0]) : [], firstRow: v[0] || null };
      else if (v && typeof v === 'object') grids[k] = { obj: true, keys: Object.keys(v), value: v };
    }
    res.json({ httpStatus: rp.httpStatus, success: rp.json && (rp.json.success ?? rp.json.Success), message: rp.json && (rp.json.message || rp.json.Message), dataKeys: Object.keys(d), grids });
  } catch (e) { res.json({ error: e.message }); }
});

// Kiểm tra Google Sheet đọc được không. Mở /api/products/owners
app.get('/api/products/owners', async (req, res) => {
  if (!SHEET_CSV_URL) return res.json({ ok: false, message: 'Chưa khai SHEET_CSV_URL trên máy chủ.' });
  try {
    const r = await fetch(SHEET_CSV_URL, { redirect: 'follow' });
    const text = await r.text();
    const rows = parseCSV(text).filter(rw => rw.some(c => String(c).trim() !== ''));
    const o = await loadOwners(true);
    const sample = Object.values(o).slice(0, 8).map(x => ({ sanPham: x.productRaw, quanLy: x.manager }));
    res.json({
      ok: Object.keys(o).length > 0,
      soSanPham: Object.keys(o).length,
      tieuDe: rows[0] || [],
      soCot: (rows[0] || []).length,
      sample,
    });
  } catch (e) { res.json({ ok: false, message: e.message }); }
});

// Báo cáo sản phẩm cho trang Sản phẩm
app.get('/api/products/report', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const since = req.query.since || today;
  const until = req.query.until || since;
  try {
    const owners = await loadOwners(false);
    const rp = await sandboxProductReport(since, until);
    if (!(rp.json && (rp.json.success ?? rp.json.Success)))
      return res.json({ ok: false, since, until, httpStatus: rp.httpStatus, message: (rp.json && (rp.json.message || rp.json.Message)) || 'Lỗi gọi báo cáo sản phẩm. Kiểm tra SANDBOX_PRODUCT_REPORT_URL bằng /api/products/probe' });
    let rows = mapProductReport(rp.json, owners);
    let managers = [...new Set(Object.values(owners).map(o => o.manager))].sort();
    // Quyền "product": chỉ thấy sản phẩm do chính mình quản lý
    const me = req.session.user || {};
    if (me.role === 'product') {
      const mine = normProd(me.manager || '');
      rows = rows.filter(r => normProd(r.manager) === mine && mine);
      managers = me.manager ? [me.manager] : [];
    }
    res.json({ ok: true, ver: 'prod-2026-06-15-v2', since, until, rows, managers, me: { role: me.role, manager: me.manager || '' }, ownersCount: Object.keys(owners).length, lastUpdated: new Date().toISOString() });
  } catch (e) { res.json({ ok: false, since, until, message: e.message }); }
});

/* ===================== TÍNH LƯƠNG PHÁT TRIỂN SẢN PHẨM =====================
   Hoa hồng theo người Quản Lý SP (cột C Google Sheet):
   - SP mới (đăng <= 2 tháng tính đến cuối tháng lương): 1.0% × (Doanh thu − Giá vốn)
   - SP cũ  (đăng >  2 tháng):                          0.7% × (Doanh thu − Giá vốn)
   - SP không có Ngày Đăng: KHÔNG tính lương
   Doanh thu = doanhSo từ Sandbox (theo SP)
   Giá vốn   = soLuongSanPham (ship thành công) × giá nhập (cột D Sheet)
   ========================================================================== */
const HH_SP_MOI = Number(process.env.HH_SP_MOI || 0.01);   // 1%
const HH_SP_CU  = Number(process.env.HH_SP_CU  || 0.007);  // 0.7%

// BHXH mặc định cho nhân viên phát triển SP (theo tên Quản Lý trong Sheet)
const PTSP_BHXH = {
  'Đào Trung Kiên':    630000,
  'Nguyễn Huyền Trang': 577500,
};

// Dữ liệu nhập tay cho lương PTSP (thưởng/phạt) — lưu theo tháng, trong DATA_DIR
const PTSP_MANUAL_FILE = path.join(DATA_DIR, 'salary-product-manual.json');
let PTSP_MANUAL = {};
try { PTSP_MANUAL = JSON.parse(fs.readFileSync(PTSP_MANUAL_FILE, 'utf8')); } catch { PTSP_MANUAL = {}; }
function savePtspManual() { try { fs.writeFileSync(PTSP_MANUAL_FILE, JSON.stringify(PTSP_MANUAL)); } catch (e) {} }

// API lấy/lưu dữ liệu tay cho lương PTSP
// Bỏ dấu tiếng Việt (để gộp key cũ "dao trung kien" với key mới "đào trung kiên")
function stripVN(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim().replace(/\s+/g, ' ');
}
app.get('/api/salary-product/manual', (req, res) => {
  const month = req.query.month || '';
  const raw = PTSP_MANUAL[month] || {};
  const data = {};
  // GỘP dữ liệu theo tên bỏ dấu — gom cả key cũ (không dấu) và mới (có dấu)
  const byStrip = {};
  for (const [k, v] of Object.entries(raw)) {
    const sk = stripVN(k);
    if (!byStrip[sk]) byStrip[sk] = {};
    // Gộp: ưu tiên giá trị khác 0 / có dữ liệu
    const merged = byStrip[sk];
    for (const [field, val] of Object.entries(v)) {
      if (field === 'channels') {
        merged.channels = merged.channels || {};
        for (const [ch, cv] of Object.entries(val || {})) {
          merged.channels[ch] = { ...(merged.channels[ch] || {}), ...cv };
        }
      } else if (val != null && (merged[field] == null || merged[field] === 0)) {
        merged[field] = val;
      }
    }
  }
  // Đưa dữ liệu đã gộp vào key CHUẨN (normProd = có dấu) theo tên trong PTSP_BHXH
  for (const name of Object.keys(PTSP_BHXH)) {
    const sk = stripVN(name);
    const k = normProd(name);
    if (byStrip[sk]) { data[k] = { ...byStrip[sk], name }; delete byStrip[sk]; }
  }
  // Các key còn lại (người không có trong PTSP_BHXH) giữ nguyên theo normProd
  for (const [sk, v] of Object.entries(byStrip)) {
    data[v.name ? normProd(v.name) : sk] = v;
  }
  // Điền BHXH mặc định
  for (const [name, bhxh] of Object.entries(PTSP_BHXH)) {
    const k = normProd(name);
    if (!data[k]) data[k] = { name, thuongSP: 0, thuongThang: 0, phat: 0, bhxh };
    else if (!data[k].bhxh) data[k].bhxh = bhxh;
  }
  res.json({ month, data });
});

app.post('/api/salary-product/manual', express.json(), (req, res) => {
  const { month, key, field, value, channel, metric } = req.body || {};
  if (!month || !key) return res.json({ ok: false, message: 'Thiếu tham số' });
  if (!PTSP_MANUAL[month]) PTSP_MANUAL[month] = {};
  // DỌN KEY TRÙNG: nếu tồn tại key cũ không dấu khác key hiện tại nhưng cùng tên bỏ dấu,
  // gộp dữ liệu cũ vào key chuẩn rồi xoá key cũ (tránh phân mảnh dữ liệu)
  const stripKey = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase().trim().replace(/\s+/g,' ');
  const targetStrip = stripKey(key);
  for (const ek of Object.keys(PTSP_MANUAL[month])) {
    if (ek !== key && stripKey(ek) === targetStrip) {
      const oldRec = PTSP_MANUAL[month][ek];
      if (!PTSP_MANUAL[month][key]) PTSP_MANUAL[month][key] = {};
      // Gộp field cũ vào key mới (không ghi đè field mới đã có giá trị)
      for (const [f, vv] of Object.entries(oldRec)) {
        if (f === 'channels') {
          PTSP_MANUAL[month][key].channels = PTSP_MANUAL[month][key].channels || {};
          for (const [ch, cv] of Object.entries(vv || {}))
            PTSP_MANUAL[month][key].channels[ch] = { ...(PTSP_MANUAL[month][key].channels[ch]||{}), ...cv };
        } else if (PTSP_MANUAL[month][key][f] == null || PTSP_MANUAL[month][key][f] === 0) {
          PTSP_MANUAL[month][key][f] = vv;
        }
      }
      delete PTSP_MANUAL[month][ek];
    }
  }
  if (!PTSP_MANUAL[month][key]) PTSP_MANUAL[month][key] = {};
  const num = parseInt(String(value == null ? '' : value).replace(/[^\d]/g, ''), 10) || 0;
  if (channel && metric) {
    // Lưu kênh nhập tay: channels.thailan.dt / channels.thailan.gv ...
    if (!PTSP_MANUAL[month][key].channels) PTSP_MANUAL[month][key].channels = {};
    if (!PTSP_MANUAL[month][key].channels[channel]) PTSP_MANUAL[month][key].channels[channel] = {};
    PTSP_MANUAL[month][key].channels[channel][metric] = num;
  } else if (field) {
    PTSP_MANUAL[month][key][field] = num;
  } else {
    return res.json({ ok: false, message: 'Thiếu field hoặc channel/metric' });
  }
  savePtspManual();
  res.json({ ok: true });
});

// Các kênh nhập tay cho PTSP và tỷ lệ hoa hồng cố định 0.7%
const PTSP_CHANNELS = ['thailan', 'pushsale', 'shopee'];
const HH_KENH_KHAC = Number(process.env.HH_KENH_KHAC || 0.007);  // 0.7%
const PHI_SHIP_DON_PTSP = Number(process.env.PHI_SHIP_DON || 30000);  // phí ship mỗi đơn

app.get('/api/salary-product/report', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const since = req.query.since || today;
  const until = req.query.until || since;
  try {
    const owners = await loadOwners(false);
    const rp = await sandboxProductReport(since, until);
    if (!(rp.json && (rp.json.success ?? rp.json.Success)))
      return res.json({ ok: false, since, until, httpStatus: rp.httpStatus, message: (rp.json && (rp.json.message || rp.json.Message)) || 'Lỗi gọi báo cáo sản phẩm' });

    // Lấy lưới sản phẩm chi tiết (có doanhSo + soLuongSanPham)
    const d = (rp.json && rp.json.data) || {};
    const arr = Array.isArray(d.productGridTable) ? d.productGridTable : [];
    const pick = (o, keys) => { for (const k of keys) if (o[k] != null) return o[k]; return null; };

    // Mốc phân loại mới/cũ: cuối tháng của "until"
    const endOfMonth = new Date(until.slice(0, 7) + '-01');
    endOfMonth.setMonth(endOfMonth.getMonth() + 1);
    endOfMonth.setDate(0); // ngày cuối tháng
    // 2 tháng trước cuối tháng → mốc; đăng SAU mốc = mới, TRƯỚC = cũ
    const twoMonthsAgo = new Date(endOfMonth);
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    const products = arr.map(o => {
      const name = String(pick(o, ['tenSanPham', 'tenSp', 'sanPham', 'name']) || '').trim();
      const doanhThu = +pick(o, ['doanhSo', 'doanhThu', 'tongDoanhSo']) || 0;
      const soLuongSP = +pick(o, ['soLuongSanPham', 'soLuongSP', 'soLuong']) || 0;
      const soDon = +pick(o, ['soLuongChotDon', 'soLuongChotDonThucTe', 'soDonChot', 'soDonHang', 'soDon']) || 0;
      const own = owners[normProd(name)];
      const manager = own ? own.manager : '';
      const giaNhap = own ? (own.giaNhap || 0) : 0;
      const ngayDang = own ? own.ngayDang : null;
      const giaVon = soLuongSP * giaNhap;
      const phiShip = soDon * PHI_SHIP_DON_PTSP;  // phí ship = số đơn × 30.000
      const loiNhuan = doanhThu - giaVon - phiShip;

      // Phân loại mới/cũ theo ngày đăng
      let loai = 'khong-tinh'; // mặc định: không có ngày đăng → không tính
      let tyLe = 0;
      if (ngayDang) {
        const dt = new Date(ngayDang);
        // đăng <= 2 tháng (sau hoặc bằng mốc twoMonthsAgo) = mới
        loai = (dt >= twoMonthsAgo) ? 'moi' : 'cu';
        tyLe = (loai === 'moi') ? HH_SP_MOI : HH_SP_CU;
      }
      const hoaHong = Math.round(loiNhuan * tyLe);

      return { product: name, manager, doanhThu, soLuongSP, soDon, giaNhap, giaVon, phiShip, loiNhuan, ngayDang, loai, tyLe, hoaHong };
    }).filter(p => p.product);

    // Quyền: tài khoản "product" chỉ thấy SP của mình
    const me = req.session.user || {};
    let visible = products;
    if (me.role === 'product') {
      const mine = normProd(me.manager || '');
      visible = products.filter(p => normProd(p.manager) === mine && mine);
    }

    // Tổng hợp hoa hồng theo người Quản Lý
    const byManager = {};
    for (const p of visible) {
      const mgr = p.manager || '(chưa gán)';
      if (!byManager[mgr]) byManager[mgr] = { manager: mgr, soSP: 0, soSPmoi: 0, soSPcu: 0, soDon: 0, soLuongSP: 0, doanhThu: 0, giaVon: 0, phiShip: 0, loiNhuan: 0, hoaHong: 0 };
      const m = byManager[mgr];
      m.soSP++;
      if (p.loai === 'moi') m.soSPmoi++;
      else if (p.loai === 'cu') m.soSPcu++;
      m.soDon += p.soDon;
      m.soLuongSP += p.soLuongSP;
      m.doanhThu += p.doanhThu;
      m.giaVon += p.giaVon;
      m.phiShip += p.phiShip;
      m.loiNhuan += p.loiNhuan;
      m.hoaHong += p.hoaHong;
    }

    // Gắn BHXH mặc định + tính HH kênh khác (Thái Lan, Pushsale, Shopee × 0.7%)
    const monthKey = (since || '').slice(0, 7);
    const manualMonth = PTSP_MANUAL[monthKey] || {};
    for (const m of Object.values(byManager)) {
      m.bhxh = PTSP_BHXH[m.manager] || 0;
      // Lấy channels nhập tay của người này
      const rec = manualMonth[normProd(m.manager)] || {};
      const ch = rec.channels || {};
      let dtKhac = 0, gvKhac = 0, shipKhac = 0;
      m.channels = {};
      for (const cid of PTSP_CHANNELS) {
        const dt = Number((ch[cid] || {}).dt) || 0;
        const gv = Number((ch[cid] || {}).gv) || 0;
        const ship = Number((ch[cid] || {}).ship) || 0;
        m.channels[cid] = { dt, gv, ship };
        dtKhac += dt; gvKhac += gv; shipKhac += ship;
      }
      m.dtKhac = dtKhac;
      m.gvKhac = gvKhac;
      m.shipKhac = shipKhac;
      // Hoa hồng kênh khác = (DT - GV - Phí ship) × 0.7%
      m.hoaHongKhac = Math.round((dtKhac - gvKhac - shipKhac) * HH_KENH_KHAC);
      // Tổng hoa hồng = HH Sandbox (đã có) + HH kênh khác
      m.hoaHongSandbox = m.hoaHong;
      m.hoaHong = m.hoaHong + m.hoaHongKhac;
      // Cộng doanh thu/giá vốn/phí ship kênh khác vào tổng hiển thị
      m.doanhThuTong = m.doanhThu + dtKhac;
      m.giaVonTong = m.giaVon + gvKhac;
      m.phiShipTong = (m.phiShip || 0) + shipKhac;
    }
    const managers = Object.values(byManager).sort((a, b) => b.hoaHong - a.hoaHong);
    const total = managers.reduce((s, m) => ({
      soSP: s.soSP + m.soSP, soDon: s.soDon + m.soDon, soLuongSP: s.soLuongSP + m.soLuongSP,
      doanhThu: s.doanhThu + m.doanhThu, giaVon: s.giaVon + m.giaVon, phiShip: s.phiShip + m.phiShip,
      loiNhuan: s.loiNhuan + m.loiNhuan, hoaHong: s.hoaHong + m.hoaHong,
    }), { soSP: 0, soDon: 0, soLuongSP: 0, doanhThu: 0, giaVon: 0, phiShip: 0, loiNhuan: 0, hoaHong: 0 });

    // Cập nhật total gồm cả kênh khác
    total.dtKhac = managers.reduce((s, m) => s + (m.dtKhac || 0), 0);
    total.gvKhac = managers.reduce((s, m) => s + (m.gvKhac || 0), 0);
    total.shipKhac = managers.reduce((s, m) => s + (m.shipKhac || 0), 0);
    total.hoaHongKhac = managers.reduce((s, m) => s + (m.hoaHongKhac || 0), 0);
    total.doanhThu += total.dtKhac;
    total.giaVon += total.gvKhac;
    total.phiShip = (total.phiShip || 0) + total.shipKhac;

    res.json({
      ok: true, since, until,
      tyLeMoi: HH_SP_MOI, tyLeCu: HH_SP_CU, tyLeKhac: HH_KENH_KHAC,
      channels: PTSP_CHANNELS,
      mocPhanLoai: twoMonthsAgo.toISOString().slice(0, 10),
      managers, products: visible, total,
      ownersCount: Object.keys(owners).length,
      me: { role: me.role, manager: me.manager || '' },
      lastUpdated: new Date().toISOString(),
    });
  } catch (e) { res.json({ ok: false, since, until, message: e.message }); }
});

/* ===================== TÍNH LƯƠNG MARKETING =====================
   Lương = (Doanh thu − Chi phí QC − Giá vốn − Phí ship) × 2%
   - Doanh thu = doanh số (Đã giao hàng) + doanh số (Đã thanh toán)
   - Chi phí QC = chi tiêu Meta theo từng nhân viên
   - Giá vốn   = Σ(số lượng SP × giá nhập — cột D Google Sheet)
   - Phí ship  = (số đơn đã giao + đã thanh toán) × 30.000
   Tham số trạng thái của báo cáo tìm bằng /api/salary/probe, rồi khai:
     SALARY_STATUS_PARAM (mặc định loaiDoanhSo), SALARY_VAL_GIAO, SALARY_VAL_TT
   ================================================================ */
const LUONG_TY_LE = Number(process.env.LUONG_TY_LE || 0.02);
const PHI_SHIP_DON = Number(process.env.PHI_SHIP_DON || 30000);
const QC_TAX = Number(process.env.QC_TAX || 0.11);   // 11% thuế VAT cộng vào chi phí quảng cáo
// Chỉ hiện nhân viên trong danh sách EMPLOYEES + "Admin"; tên khác (vd khách lẻ) bị ẩn.
const SALARY_ALLOW = new Set([...EMPLOYEES.map(e => normProd(e.full)), normProd('Admin')]);
const SALARY_STATUS_PARAM = process.env.SALARY_STATUS_PARAM || 'giaoHangTrangThaiMa';
const SALARY_VAL_GIAO = process.env.SALARY_VAL_GIAO || '31';  // 31 = Đã giao hàng
const SALARY_VAL_TT = process.env.SALARY_VAL_TT || '32';      // 32 = Đã thanh toán
const castVal = v => (v !== '' && !isNaN(+v)) ? +v : v;

// Báo cáo lead theo nhân sự + tham số lọc thêm (vd trạng thái giao/thanh toán)
async function sandboxReportEx(since, until, extra) {
  const tuNgay = `${since}T00:00:00.000+07:00`, denNgay = `${until}T23:59:59.998+07:00`;
  const payload = {
    pageInfo: { page: 1, pageSize: 1000 }, sorts: [],
    kieuXem: 4, loaiNhanVien: 1, isChietKhau: true, isVat: true,
    date: [tuNgay, denNgay], tuNgay, denNgay,
    idChiNhanh: SANDBOX_CHINHANH, kieuNgay: 'NgayTao',
    typeViewDetail: null, idPhongBanSale: null, idNhomNhanVienSale: null, idUserSale: null,
    idPhongBanMkts: null, idNhomNhanVienMkts: null, idUserMkts: null, ...(extra || {}),
  };
  const call = () => fetch(SANDBOX_REPORT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'Origin': SANDBOX_ORIGIN, 'Referer': SANDBOX_ORIGIN + '/', 'Cookie': sandboxCookie }, body: JSON.stringify(payload) });
  if (!sandboxCookie) await sandboxLogin();
  let r = await call();
  if (r.status === 401 || r.status === 403) { await sandboxLogin(); r = await call(); }
  return r.json().catch(() => ({ success: false }));
}
function reportRowsEx(j) {
  const d = (j && j.data) || {};
  return (d.reportLeadByNhanSuMktDtos || []).map(r => ({
    name: (r.ten || '').trim(), id: r.marketingUserId,
    doanhthu: +r.doanhSo || 0,
    soDon: +(r.soDonHang ?? r.soDonChot ?? 0) || 0,
    soSP: +r.soLuongSanPham || 0,
  }));
}

// Số lượng từng SP theo 1 nhân viên marketing (có thể kèm lọc trạng thái) — để tính giá vốn
async function productQtyByUser(since, until, marketingUserId, extra) {
  const tuNgay = `${since}T00:00:00+07:00`, denNgay = `${until}T23:59:59+07:00`;
  const payload = { strIdNguonDuLieu: null, kieuNgay: 'NgayTao', tuNgay, denNgay, idNhomSanPham: null, idSanPhamCha: null, idSanPham: null, unitCode: null, tiTrongChiaTinhTheo: 0, isChietKhau: true, isVat: true, idChiNhanh: SANDBOX_CHINHANH, typeViewDetail: null, idPhongBanSale: null, idNhomNhanVienSale: null, idUserSale: null, idPhongBanMkts: null, idNhomNhanVienMkts: null, idUserMkts: marketingUserId ? [marketingUserId] : null, date: [tuNgay, denNgay], khoId: null, pageInfo: { page: 1, pageSize: 1000 }, sorts: [], ...(extra || {}) };
  const r = await fetch(SANDBOX_PRODUCT_REPORT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'Origin': SANDBOX_ORIGIN, 'Referer': SANDBOX_ORIGIN + '/', 'Cookie': sandboxCookie }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  const d = (j && j.data) || {};
  const arr = Array.isArray(d.productGridTable) ? d.productGridTable : [];
  return arr.map(o => ({ ten: (o.tenSanPham || '').trim(), soLuong: +o.soLuongSanPham || 0 }));
}

// Gọi báo cáo sản phẩm + tham số lọc thêm; trả tổng doanh số & số lượng
async function productReportEx(since, until, extra) {
  const tuNgay = `${since}T00:00:00+07:00`, denNgay = `${until}T23:59:59+07:00`;
  const payload = { strIdNguonDuLieu: null, kieuNgay: 'NgayTao', tuNgay, denNgay, idNhomSanPham: null, idSanPhamCha: null, idSanPham: null, unitCode: null, tiTrongChiaTinhTheo: 0, isChietKhau: true, isVat: true, idChiNhanh: SANDBOX_CHINHANH, typeViewDetail: null, idPhongBanSale: null, idNhomNhanVienSale: null, idUserSale: null, idPhongBanMkts: null, idNhomNhanVienMkts: null, idUserMkts: null, date: [tuNgay, denNgay], khoId: null, pageInfo: { page: 1, pageSize: 1000 }, sorts: [], ...(extra || {}) };
  const call = () => fetch(SANDBOX_PRODUCT_REPORT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'Origin': SANDBOX_ORIGIN, 'Referer': SANDBOX_ORIGIN + '/', 'Cookie': sandboxCookie }, body: JSON.stringify(payload) });
  if (!sandboxCookie) await sandboxLogin();
  let r = await call();
  if (r.status === 401 || r.status === 403) { await sandboxLogin(); r = await call(); }
  const j = await r.json().catch(() => ({}));
  const d = (j && j.data) || {};
  const arr = Array.isArray(d.productGridTable) ? d.productGridTable : [];
  return { doanhSo: arr.reduce((s, o) => s + (+o.doanhSo || 0), 0), qty: arr.reduce((s, o) => s + (+o.soLuongSanPham || 0), 0), soDong: arr.length };
}

// Chi tiêu Meta theo từng nhân viên (dùng chung getCampaigns: có thử lại + đệm an toàn)
async function metaSpendByEmployee(since, until) {
  const campaigns = await getCampaigns(since, until);
  const spend = {};
  for (const c of campaigns) {
    const k = normProd(c.employee || '');
    spend[k] = (spend[k] || 0) + (c.daily || []).reduce((a, d) => a + (d && d.spent ? +d.spent : 0), 0);
  }
  return spend;
}

// Tìm tham số trạng thái: /api/salary/probe?param=loaiDoanhSo&vals=1,2,3,4
app.get('/api/salary/probe', async (req, res) => {
  const since = req.query.since || '2026-05-01', until = req.query.until || '2026-05-31';
  const param = req.query.param || 'loaiDoanhSo';
  const vals = String(req.query.vals || '1,2,3,4').split(',').map(s => s.trim()).filter(Boolean);
  try {
    if (!sandboxCookie) await sandboxLogin();
    const out = [];
    for (const v of vals) {
      const rows = reportRowsEx(await sandboxReportEx(since, until, { [param]: castVal(v) }));
      out.push({ value: v, tongDoanhThu: rows.reduce((s, r) => s + r.doanhthu, 0), soNhanVien: rows.length });
    }
    res.json({ since, until, param, ketqua: out, goiY: 'Tìm value cho tổng = 653897000 (đã giao) và 730168200 (đã thanh toán)' });
  } catch (e) { res.json({ error: e.message }); }
});

// Dò trạng thái trên BÁO CÁO SẢN PHẨM:
//   /api/products/probe-status?names=trangThaiGiaoHang,trangThai&vals=31,32,1,2,3&arr=1
// arr=1 -> gửi giá trị dạng mảng [v]; báo cáo SP có lọc trạng thái nên 1 trong số này
// sẽ cho tongDoanhSo ≈ 653.897.000 (đã giao) hoặc 730.168.200 (đã thanh toán).
app.get('/api/products/probe-status', async (req, res) => {
  const since = req.query.since || '2026-05-01', until = req.query.until || '2026-05-31';
  const names = String(req.query.names || 'trangThaiGiaoHang,trangThaiDonHang,trangThai,idTrangThai,loaiTrangThai').split(',').map(s => s.trim()).filter(Boolean);
  const vals = String(req.query.vals || '31').split(',').map(s => s.trim()).filter(Boolean);
  const arr = req.query.arr === '1';
  try {
    if (!sandboxCookie) await sandboxLogin();
    const base = await productReportEx(since, until, {});
    const out = [];
    for (const nm of names) {
      for (const v of vals) {
        const val = castVal(v);
        const t = await productReportEx(since, until, { [nm]: arr ? [val] : val });
        out.push({ param: nm, value: v, tongDoanhSo: t.doanhSo, khacBase: t.doanhSo !== base.doanhSo });
      }
    }
    res.json({ since, until, dangMang: arr, base: base.doanhSo, ketqua: out, goiY: 'param/value nào có tongDoanhSo ≈ 653897000 (đã giao) / 730168200 (đã thanh toán) là đúng' });
  } catch (e) { res.json({ error: e.message }); }
});

// Dữ liệu MẪU tháng 5/2026 — lấy từ báo cáo "lead theo nhân sự" lọc Đã giao + Đã
// thanh toán (đã gộp 2 trạng thái). Dùng khi chưa cấu hình SALARY_VAL_GIAO/TT, để
// xem ngay bảng lương tháng 5. doanhthu = doanh số gộp; soDon, soSP = gộp 2 trạng thái.
const SALARY_SAMPLE = {
  '2026-05': {
    'Trịnh Đức Phương':  { doanhthu: 554333000, soDon: 937, soSP: 1734 },
    'Nguyễn Thị Trà My': { doanhthu: 151416000, soDon: 243, soSP: 465 },
    'Tạ Quang Trường':   { doanhthu: 147853000, soDon: 299, soSP: 846 },
    'Vũ Hà Giang':       { doanhthu: 127568200, soDon: 211, soSP: 766 },
    'Lê Thị Ánh':        { doanhthu: 105231000, soDon: 232, soSP: 320 },
    'Đoàn Việt Hà':      { doanhthu: 98935000,  soDon: 206, soSP: 269 },
    'Nguyễn Duy Huân':   { doanhthu: 72695000,  soDon: 137, soSP: 273 },
    'Nguyễn Trung Hiếu': { doanhthu: 65165000,  soDon: 137, soSP: 381 },
    'Dương Văn Minh':    { doanhthu: 55029000,  soDon: 79,  soSP: 139 },
  },
};

// Bảng lương: /api/salary/report?since=2026-05-01&until=2026-05-31
app.get('/api/salary/report', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const since = req.query.since || today, until = req.query.until || since;
  const useConfig = !!(SALARY_VAL_GIAO && SALARY_VAL_TT);
  const sample = SALARY_SAMPLE[since.slice(0, 7)];
  if (!useConfig && !sample)
    return res.json({ ok: false, since, until, message: 'Hiện chỉ có sẵn dữ liệu mẫu tháng 5/2026. Để xem tự động các tháng khác: lấy 2 giá trị trạng thái qua /api/salary/probe rồi khai SALARY_VAL_GIAO, SALARY_VAL_TT trên máy chủ.' });
  try {
    if (!sandboxCookie) await sandboxLogin();   // đăng nhập 1 lần trước khi gọi song song
    const p = SALARY_STATUS_PARAM;
    const map = {};
    const add = arr => { for (const r of arr) { if (!r.name) continue; const k = normProd(r.name); if (!map[k]) map[k] = { name: r.name, id: r.id, doanhthu: 0, soDon: 0, soSP: 0 }; map[k].doanhthu += r.doanhthu; map[k].soDon += r.soDon; map[k].soSP += r.soSP; if (r.id) map[k].id = r.id; } };

    let meta;
    if (useConfig) {
      // Lấy doanh thu thật theo 2 trạng thái (đã giao + đã thanh toán)
      const [giaoJ, ttJ, m] = await Promise.all([
        sandboxReportEx(since, until, { [p]: castVal(SALARY_VAL_GIAO) }),
        sandboxReportEx(since, until, { [p]: castVal(SALARY_VAL_TT) }),
        metaSpendByEmployee(since, until),
      ]);
      meta = m; add(reportRowsEx(giaoJ)); add(reportRowsEx(ttJ));
    } else {
      // Dùng dữ liệu mẫu; lấy marketingUserId từ báo cáo mặc định (để tính giá vốn)
      const [baseJ, m] = await Promise.all([
        sandboxReportEx(since, until, {}),
        metaSpendByEmployee(since, until),
      ]);
      meta = m;
      const idByName = {}; for (const r of reportRowsEx(baseJ)) idByName[normProd(r.name)] = r.id;
      for (const name in sample) { const s = sample[name], k = normProd(name); map[k] = { name, id: idByName[k] || null, doanhthu: s.doanhthu, soDon: s.soDon, soSP: s.soSP }; }
    }

    const owners = await loadOwners(false);
    const priceOf = ten => { const o = owners[normProd(ten)]; return o ? (o.giaNhap || 0) : 0; };
    const emps = Object.values(map).filter(e => SALARY_ALLOW.has(normProd(e.name)));
    // Giá vốn CHÍNH XÁC: số lượng từng SP theo đúng trạng thái (giao + thanh toán) × giá nhập
    const giaoVal = castVal(SALARY_VAL_GIAO), ttVal = castVal(SALARY_VAL_TT);
    const tasks = [];
    for (const e of emps) {
      tasks.push(e.id ? productQtyByUser(since, until, e.id, { [p]: giaoVal }) : Promise.resolve([]));
      tasks.push(e.id ? productQtyByUser(since, until, e.id, { [p]: ttVal }) : Promise.resolve([]));
    }
    const lists = await Promise.all(tasks);

    // ── Cấu hình Team Lead ────────────────────────────────────────────
    // Hoa hồng leader = ½ × tổng lương 2% của nhân viên trong nhóm
    // (KHÔNG tính lương của chính team lead)
    const TEAM_LEAD = {
      'Trịnh Đức Phương': ['Đoàn Việt Hà', 'Nguyễn Duy Huân', 'Vũ Thuý An'],
      'Tạ Quang Trường':  ['Nguyễn Thị Trà My', 'Dương Văn Minh', 'Lê Thị Ánh'],
    };

    // Tính lương 2% từng người trước, lưu vào luongByName
    const luongByName = {};
    const rows = emps.map((e, i) => {
      let giaVon = 0;
      for (const pr of lists[i * 2]) giaVon += pr.soLuong * priceOf(pr.ten);
      for (const pr of lists[i * 2 + 1]) giaVon += pr.soLuong * priceOf(pr.ten);
      giaVon = Math.round(giaVon);
      const chiPhiQC = Math.round((meta[normProd(e.name)] || 0) * (1 + QC_TAX));
      const phiShip = e.soDon * PHI_SHIP_DON;
      const luong = Math.round((e.doanhthu - chiPhiQC - giaVon - phiShip) * LUONG_TY_LE);
      luongByName[e.name] = luong;
      return { name: e.name, doanhthu: e.doanhthu, chiPhiQC, giaVon, phiShip, soDon: e.soDon, soSP: e.soSP, luong, hoaHongLeader: 0 };
    });

    // Gắn hoa hồng leader = ½ × tổng lương 2% của nhân viên trong nhóm
    for (const row of rows) {
      const members = TEAM_LEAD[row.name];
      if (!members) continue;
      const tongLuong = members.reduce((s, name) => s + (luongByName[name] || 0), 0);
      row.hoaHongLeader = Math.round(tongLuong / 2);
    }

    // ── Thưởng DTT (tự động theo bảng bậc thang) ────────────────────
    // DTT = Doanh thu - Giá vốn - Phí ship (KHÔNG trừ chi phí QC)
    // Bậc thang: mỗi 90tr từ 150tr → +1tr lương cứng, sau 690tr mỗi 90tr thêm +1tr
    const DTT_BRACKETS = [
      { min: 150e6, max: 240e6, bonus: 1e6 },
      { min: 240e6, max: 330e6, bonus: 2e6 },
      { min: 330e6, max: 420e6, bonus: 3e6 },
      { min: 420e6, max: 510e6, bonus: 4e6 },
      { min: 510e6, max: 600e6, bonus: 5e6 },
      { min: 600e6, max: 690e6, bonus: 6e6 },
    ];
    const DTT_BASE = 690e6, DTT_STEP = 90e6, DTT_BONUS_STEP = 1e6, DTT_START_BONUS = 6e6;

    function tinhThuongDTT(dtt) {
      if (dtt < 150e6) return 0;
      for (const b of DTT_BRACKETS) {
        if (dtt >= b.min && dtt <= b.max) return b.bonus;
      }
      if (dtt > DTT_BASE) {
        const extra = Math.floor((dtt - DTT_BASE) / DTT_STEP);
        return DTT_START_BONUS + (extra + 1) * DTT_BONUS_STEP;
      }
      return 0;
    }

    for (const row of rows) {
      const dtt = row.doanhthu - row.giaVon - row.phiShip;
      row.dtt = Math.round(dtt);
      row.thuongDTT = tinhThuongDTT(dtt);
    }

    // ── Thưởng Top 1 (tự động — người có lương 2% cao nhất) ──────────
    // Chỉ 1 người, thưởng = ½ × lương 2% của chính họ (chỉ khi lương > 0)
    const posRows = rows.filter(r => r.luong > 0);
    if (posRows.length > 0) {
      posRows.sort((a, b) => b.luong - a.luong);
      const top1 = posRows[0];
      // Kiểm tra không có người nào bằng điểm (nếu bằng thì không ai được)
      const isUnique = posRows.length === 1 || posRows[0].luong !== posRows[1].luong;
      if (isUnique) top1.thuongTop1 = Math.round(top1.luong / 2);
    }

    rows.sort((a, b) => b.luong - a.luong);
    const roster = EMPLOYEES.filter(e => e.code).map(e => e.full).concat('Admin');
    res.json({ ok: true, since, until, nguon: useConfig ? 'live' : 'mau-t5', tyLe: LUONG_TY_LE, phiShipDon: PHI_SHIP_DON, roster, rows, teamLead: TEAM_LEAD, lastUpdated: new Date().toISOString() });
  } catch (e) { res.json({ ok: false, since, until, message: e.message }); }
});

// Chẩn đoán chi phí QC: /api/salary/debug?since=2026-05-01&until=2026-05-31
// Cho biết từng tài khoản Meta còn chạy không, chi tiêu bao nhiêu, tên nhân viên ra sao,
// và tên trong báo cáo Sandbox -> để soi vì sao Chi phí QC = 0.
app.get('/api/salary/debug', async (req, res) => {
  const since = req.query.since || '2026-05-01', until = req.query.until || '2026-05-31';
  const days = listDays(since, until);
  const taiKhoan = [];
  for (const src of SOURCES) {
    for (const acc of src.accounts) {
      try {
        const camps = await fetchAccount(acc, src.token, days, since, until);
        const spendOf = c => (c.daily || []).reduce((a, d) => a + (+d.spent || 0), 0);
        const emp = {};
        for (const c of camps) { const e = c.employee || '(không nhận ra)'; emp[e] = Math.round((emp[e] || 0) + spendOf(c)); }
        taiKhoan.push({ acc, ok: true, soCampaign: camps.length, tongChiTieu: Math.round(camps.reduce((t, c) => t + spendOf(c), 0)), theoNhanVien: emp });
      } catch (e) { taiKhoan.push({ acc, ok: false, loi: e.message }); }
    }
  }
  let tenTrongBaoCao = [];
  try { if (!sandboxCookie) await sandboxLogin(); tenTrongBaoCao = reportRowsEx(await sandboxReportEx(since, until, { [SALARY_STATUS_PARAM]: castVal(SALARY_VAL_GIAO) })).map(r => r.name); } catch (e) {}
  res.json({ since, until, soNguonToken: SOURCES.length, taiKhoan, tenTrongBaoCao });
});

// ===== Dữ liệu NHẬP TAY cho bảng lương (lưu theo tháng + nhân viên) =====
// Cấu trúc: { name, channels:{ thailan:{dt,qc,gv,ship}, pushsale:{...}, san:{...} },
//            luongCung, thuong, phat, bhxh }
//
// QUAN TRỌNG: Dữ liệu lưu ở thư mục NGOÀI project (DATA_DIR) để KHÔNG bị mất
// khi deploy/ghi đè thư mục nodejs. __dirname = .../ads.tdmjsc.com/nodejs
// nên ../../../data = /home/u422036594/data. Có thể đổi qua .env DATA_DIR.
const MANUAL_FILE = path.join(DATA_DIR, 'salary-manual.json');
const OLD_MANUAL_FILE = path.join(__dirname, 'salary-manual.json');

let SALARY_MANUAL = {};
try {
  // Ưu tiên đọc dữ liệu từ DATA_DIR (chỗ an toàn)
  SALARY_MANUAL = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
} catch {
  // Lần đầu chưa có ở DATA_DIR: thử lấy từ file cũ trong project rồi copy sang
  try {
    SALARY_MANUAL = JSON.parse(fs.readFileSync(OLD_MANUAL_FILE, 'utf8'));
    fs.writeFileSync(MANUAL_FILE, JSON.stringify(SALARY_MANUAL));
  } catch { SALARY_MANUAL = {}; }
}
function saveManual() { try { fs.writeFileSync(MANUAL_FILE, JSON.stringify(SALARY_MANUAL)); } catch (e) {} }
const SALARY_CHANNELS = ['thailan', 'pushsale', 'san'];
const CH_METRICS = ['dt', 'qc', 'gv', 'ship'];
const numClean = v => { const n = Math.round(Number(String(v == null ? 0 : v).replace(/[^\d-]/g, '')) || 0); return isFinite(n) ? n : 0; };

// Lấy dữ liệu tay theo tháng: /api/salary/manual?month=YYYY-MM
app.get('/api/salary/manual', (req, res) => {
  const month = req.query.month || '';
  const raw = SALARY_MANUAL[month] || {};
  // Điền BHXH mặc định từ EMPLOYEES cho từng nhân viên chưa có hoặc = 0
  const data = {};
  for (const [k, v] of Object.entries(raw)) {
    const empDef = EMPLOYEES.find(e => normProd(e.full) === k);
    const bhxhDefault = empDef ? (empDef.bhxh || 0) : 0;
    data[k] = { ...v, bhxh: (v.bhxh != null && v.bhxh !== 0) ? v.bhxh : bhxhDefault };
  }
  // Thêm BHXH mặc định cho nhân viên chưa có record trong tháng này
  for (const emp of EMPLOYEES) {
    if (!emp.bhxh) continue;
    const k = normProd(emp.full);
    if (!data[k]) data[k] = { name: emp.full, channels: {}, luongCung: 0, thuong: 0, phat: 0, bhxh: emp.bhxh };
    else if (!data[k].bhxh) data[k].bhxh = emp.bhxh;
  }
  res.json({ month, channels: SALARY_CHANNELS, data });
});
// Lưu 1 nhân viên
app.post('/api/salary/manual', (req, res) => {
  const { month, name, values } = req.body || {};
  if (!month || !name) return res.status(400).json({ ok: false, message: 'Thiếu tháng/tên' });
  const k = normProd(name);
  if (!SALARY_MANUAL[month]) SALARY_MANUAL[month] = {};
  const v = values || {};
  // Điền BHXH mặc định từ EMPLOYEES nếu tháng này chưa có giá trị
  const empDef = EMPLOYEES.find(e => normProd(e.full) === normProd(name));
  const bhxhDefault = empDef ? (empDef.bhxh || 0) : 0;
  const out = { name, channels: {}, luongCung: numClean(v.luongCung), thuong: numClean(v.thuong), thuongNgayTuan: numClean(v.thuongNgayTuan), phat: numClean(v.phat), bhxh: v.bhxh != null ? numClean(v.bhxh) : bhxhDefault };
  for (const ch of SALARY_CHANNELS) {
    out.channels[ch] = {};
    const src = (v.channels && v.channels[ch]) || {};
    for (const m of CH_METRICS) out.channels[ch][m] = numClean(src[m]);
  }
  SALARY_MANUAL[month][k] = out;
  saveManual();
  res.json({ ok: true });
});

/* ===================== CÔNG KHAI LƯƠNG QUA TELEGRAM =====================
   - Gửi bảng lương riêng cho từng nhân viên qua Telegram.
   - Điều kiện: lương tháng X chỉ gửi được SAU ngày 10 tháng X+1.
   - Cần TELEGRAM_BOT_TOKEN trong .env và Chat ID trong users.js.
   ====================================================================== */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// Lưu lịch sử công khai (tháng nào đã gửi) trong DATA_DIR
const PUBLISH_FILE = path.join(DATA_DIR, 'salary-published.json');
let PUBLISHED = {};
try { PUBLISHED = JSON.parse(fs.readFileSync(PUBLISH_FILE, 'utf8')); } catch { PUBLISHED = {}; }
function savePublished() { try { fs.writeFileSync(PUBLISH_FILE, JSON.stringify(PUBLISHED)); } catch (e) {} }

// Snapshot bảng lương đã chốt — lưu để nhân viên xem mà KHÔNG cần tính lại
const SNAPSHOT_FILE = path.join(DATA_DIR, 'salary-snapshots.json');
let SNAPSHOTS = {};
try { SNAPSHOTS = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch { SNAPSHOTS = {}; }
function saveSnapshots() { try { fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(SNAPSHOTS)); } catch (e) {} }

// Kiểm tra đã qua ngày 10 của tháng SAU tháng lương chưa
function canPublish(monthStr) {
  // monthStr = 'YYYY-MM' (tháng lương)
  const [y, m] = monthStr.split('-').map(Number);
  // Mốc: ngày 10 của tháng kế tiếp
  const unlock = new Date(y, m, 10); // m vì Date month 0-based → m = tháng kế tiếp
  const now = new Date();
  return now >= unlock;
}

// Gửi 1 tin nhắn Telegram
async function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Chưa cấu hình TELEGRAM_BOT_TOKEN');
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok, error: j.description };
}

const fmtVnd = n => (Math.round(Number(n) || 0)).toLocaleString('vi-VN');

/* ===================== TELEGRAM BOT MENU (Mini App) =====================
   - Bot trả lời /start hoặc /menu bằng bàn phím nút (Reply Keyboard) luôn
     dính dưới ô nhắn tin.
   - Khi nhấn 1 nút, bot gửi lại 1 tin nhắn kèm nút Inline mở thẳng trang
     tương ứng dưới dạng Telegram Web App (mở trong khung Telegram).
   - Cần đăng ký Webhook 1 lần để Telegram gọi /telegram/webhook khi có
     tin nhắn mới (xem hướng dẫn cuối file).
   ====================================================================== */
const TG_BASE_URL = process.env.TG_BASE_URL || 'https://ads.tdmjsc.com';

// Danh sách trang hiển thị trong menu: { nhãn nút : đường dẫn trang }
const TG_MENU_PAGES = {
  '📊 Dashboard':      '/index.html',
  '📣 Marketing':       '/marketing.html',
  '📦 Sản phẩm':        '/products.html',
  '💰 Lương':           '/salary.html',
  '🧮 Lương PTSP':      '/salary-product.html',
  '🧾 Lương của tôi':   '/my-salary.html',
  '🇹🇭 Đơn Thái Lan':   '/thailand',
};

// Sắp xếp nút thành lưới 2 cột cho gọn
function buildReplyKeyboard() {
  const labels = Object.keys(TG_MENU_PAGES);
  const rows = [];
  for (let i = 0; i < labels.length; i += 2) rows.push(labels.slice(i, i + 2));
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

// Gửi tin nhắn kèm Reply Keyboard (menu luôn dính dưới ô nhắn tin)
async function tgSendMenu(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text || 'Chọn mục bạn muốn xem 👇',
      reply_markup: buildReplyKeyboard(),
    }),
  }).catch(() => {});
}

// Gửi tin nhắn kèm 1 nút Inline mở Web App (mở thẳng trang trong khung Telegram)
async function tgSendOpenPage(chatId, label, path) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const fullUrl = TG_BASE_URL.replace(/\/$/, '') + path;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `Mở ${label.replace(/^\S+\s/, '')}:`,
      reply_markup: {
        inline_keyboard: [[{ text: '👉 Mở ngay', web_app: { url: fullUrl } }]],
      },
    }),
  }).catch(() => {});
}

// Webhook nhận tin nhắn từ Telegram. Đặt TRƯỚC middleware bắt buộc đăng nhập.
app.post('/telegram/webhook', express.json(), async (req, res) => {
  res.sendStatus(200); // trả ngay cho Telegram, xử lý sau (tránh timeout/retry)
  try {
    const msg = req.body && req.body.message;
    if (!msg || !msg.chat || !msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (text === '/start' || text === '/menu') {
      await tgSendMenu(chatId, '👋 Chào bạn! Chọn mục bạn muốn xem bên dưới.');
      return;
    }

    // Nếu text khớp 1 trong các nhãn nút menu → gửi link mở trang đó
    if (TG_MENU_PAGES[text]) {
      await tgSendOpenPage(chatId, text, TG_MENU_PAGES[text]);
      return;
    }

    // Tin nhắn không nhận diện được → gợi ý gõ /menu
    await tgSendMenu(chatId, 'Không hiểu lệnh này 🙂 Chọn mục bên dưới hoặc gõ /menu.');
  } catch (e) {
    console.error('[telegram webhook] lỗi:', e.message);
  }
});

// Soạn nội dung lương Marketing cho 1 nhân viên
function buildMktMessage(row, monthStr, extra) {
  const e = extra || {};
  const thuc = (row.luong || 0) + (e.hoaHongLeader || 0) + (e.luongCung || 0) + (e.thuong || 0) - (e.phat || 0) - (e.bhxh || 0);
  let t = `<b>💰 BẢNG LƯƠNG THÁNG ${monthStr}</b>\n`;
  t += `Nhân viên: <b>${row.name}</b>\n`;
  t += `━━━━━━━━━━━━━━\n`;
  t += `Doanh thu: <b>${fmtVnd(row.doanhthu)}</b> đ\n`;
  t += `Chi phí QC: ${fmtVnd(row.chiPhiQC)} đ\n`;
  t += `Giá vốn: ${fmtVnd(row.giaVon)} đ\n`;
  t += `Phí ship: ${fmtVnd(row.phiShip)} đ\n`;
  t += `━━━━━━━━━━━━━━\n`;
  t += `Lương 2%: <b>${fmtVnd(row.luong)}</b> đ\n`;
  if (e.hoaHongLeader) t += `Hoa hồng Leader: ${fmtVnd(e.hoaHongLeader)} đ\n`;
  if (e.luongCung) t += `Lương cứng: ${fmtVnd(e.luongCung)} đ\n`;
  if (e.thuong) t += `Thưởng: ${fmtVnd(e.thuong)} đ\n`;
  if (e.phat) t += `Phạt: -${fmtVnd(e.phat)} đ\n`;
  if (e.bhxh) t += `BHXH: -${fmtVnd(e.bhxh)} đ\n`;
  t += `━━━━━━━━━━━━━━\n`;
  t += `<b>💵 THỰC NHẬN: ${fmtVnd(thuc)} đ</b>`;
  return t;
}

// API công khai lương Marketing: nhận danh sách rows đã tính từ client
app.post('/api/salary/publish', express.json({ limit: '2mb' }), async (req, res) => {
  const me = req.session.user || {};
  if (me.role !== 'admin') return res.status(403).json({ ok: false, message: 'Chỉ admin được công khai lương' });
  const { month, rows } = req.body || {};
  if (!month || !Array.isArray(rows)) return res.json({ ok: false, message: 'Thiếu dữ liệu' });
  if (!canPublish(month)) {
    const [y, m] = month.split('-').map(Number);
    return res.json({ ok: false, message: `Chưa đến hạn công khai. Lương tháng ${month} chỉ gửi được từ ngày 10/${m + 1}/${y} trở đi.` });
  }
  // Lưu snapshot để nhân viên xem trên web (KHÔNG gửi Telegram)
  SNAPSHOTS['mkt-' + month] = { at: new Date().toISOString(), month, type: 'mkt', rows };
  saveSnapshots();
  PUBLISHED['mkt-' + month] = { at: new Date().toISOString(), count: rows.length };
  savePublished();
  res.json({ ok: true, count: rows.length });
});

// Soạn nội dung lương PTSP cho 1 người
function buildPtspMessage(row, monthStr) {
  const thuc = (row.hoaHong || 0) + (row.luongCung || 0) + (row.thuong || 0) - (row.phat || 0) - (row.bhxh || 0);
  let t = `<b>💼 BẢNG LƯƠNG PTSP THÁNG ${monthStr}</b>\n`;
  t += `Nhân viên: <b>${row.manager}</b>\n`;
  t += `━━━━━━━━━━━━━━\n`;
  t += `Số SP: ${fmtVnd(row.soSP)} (mới ${fmtVnd(row.soSPmoi)}, cũ ${fmtVnd(row.soSPcu)})\n`;
  t += `Đơn ship: ${fmtVnd(row.soDon)} · SL: ${fmtVnd(row.soLuongSP)}\n`;
  t += `Doanh thu: <b>${fmtVnd(row.doanhThu)}</b> đ\n`;
  t += `Giá vốn: ${fmtVnd(row.giaVon)} đ\n`;
  t += `━━━━━━━━━━━━━━\n`;
  t += `Hoa hồng: <b>${fmtVnd(row.hoaHong)}</b> đ\n`;
  if (row.luongCung) t += `Lương cứng: ${fmtVnd(row.luongCung)} đ\n`;
  if (row.thuong) t += `Thưởng: ${fmtVnd(row.thuong)} đ\n`;
  if (row.phat) t += `Phạt: -${fmtVnd(row.phat)} đ\n`;
  if (row.bhxh) t += `BHXH: -${fmtVnd(row.bhxh)} đ\n`;
  t += `━━━━━━━━━━━━━━\n`;
  t += `<b>💵 THỰC NHẬN: ${fmtVnd(thuc)} đ</b>`;
  return t;
}

// API công khai lương PTSP
app.post('/api/salary-product/publish', express.json({ limit: '2mb' }), async (req, res) => {
  const me = req.session.user || {};
  if (me.role !== 'admin') return res.status(403).json({ ok: false, message: 'Chỉ admin được công khai lương' });
  const { month, rows } = req.body || {};
  if (!month || !Array.isArray(rows)) return res.json({ ok: false, message: 'Thiếu dữ liệu' });
  if (!canPublish(month)) {
    const [y, m] = month.split('-').map(Number);
    return res.json({ ok: false, message: `Chưa đến hạn công khai. Lương tháng ${month} chỉ gửi được từ ngày 10/${m + 1}/${y} trở đi.` });
  }
  // Lưu snapshot để nhân viên xem trên web (KHÔNG gửi Telegram)
  SNAPSHOTS['ptsp-' + month] = { at: new Date().toISOString(), month, type: 'ptsp', rows };
  saveSnapshots();
  PUBLISHED['ptsp-' + month] = { at: new Date().toISOString(), count: rows.length };
  savePublished();
  res.json({ ok: true, count: rows.length });
});

/* ===== API CHO NHÂN VIÊN XEM LƯƠNG ĐÃ CÔNG KHAI (từ snapshot) ===== */
// Trả về danh sách tháng đã công khai mà nhân viên này có dữ liệu
app.get('/api/my-salary/months', (req, res) => {
  const me = req.session.user || {};
  // salaryName = tên để xem LƯƠNG (chỉ của chính mình). Nếu không có thì fallback.
  const myNames = me.salaryName ? [me.salaryName]
    : (me.role === 'product' && me.manager ? [me.manager]
    : (me.employees && me.employees.length ? [me.employees[0]] : []));
  const months = [];
  for (const [key, snap] of Object.entries(SNAPSHOTS)) {
    const isMine = (snap.rows || []).some(r => {
      const n = r.name || r.manager;
      return myNames.includes(n);
    });
    if (isMine) months.push({ key, month: snap.month, type: snap.type, at: snap.at });
  }
  months.sort((a, b) => b.month.localeCompare(a.month));
  res.json({ ok: true, months, myNames });
});

// Trả về bảng lương của chính nhân viên trong 1 tháng đã công khai
app.get('/api/my-salary/detail', (req, res) => {
  const me = req.session.user || {};
  const key = req.query.key || '';
  const snap = SNAPSHOTS[key];
  if (!snap) return res.json({ ok: false, message: 'Chưa có bảng lương công khai cho tháng này' });
  const myNames = me.salaryName ? [me.salaryName]
    : (me.role === 'product' && me.manager ? [me.manager]
    : (me.employees && me.employees.length ? [me.employees[0]] : []));
  // Admin xem được tất cả; nhân viên chỉ thấy dòng của mình
  let rows = snap.rows || [];
  if (me.role !== 'admin') {
    rows = rows.filter(r => myNames.includes(r.name || r.manager));
  }
  res.json({ ok: true, month: snap.month, type: snap.type, at: snap.at, rows });
});

// Xem trạng thái cache Meta (admin) — biết đã cache những khoảng nào
app.get('/api/meta-cache/status', (req, res) => {
  const me = req.session.user || {};
  if (me.role !== 'admin') return res.status(403).json({ error: 'Chỉ admin' });
  const list = Object.entries(META_CACHE).map(([key, v]) => ({
    range: key, at: v.at, soChienDich: (v.campaigns || []).length,
  })).sort((a, b) => b.range.localeCompare(a.range));
  res.json({ ok: true, soKhoang: list.length, list });
});

// Xoá cache 1 khoảng hoặc tất cả (admin) — khi muốn lấy lại số liệu mới từ Facebook
app.post('/api/meta-cache/clear', express.json(), (req, res) => {
  const me = req.session.user || {};
  if (me.role !== 'admin') return res.status(403).json({ error: 'Chỉ admin' });
  const { range } = req.body || {};
  if (range === 'all') { META_CACHE = {}; }
  else if (range && META_CACHE[range]) { delete META_CACHE[range]; }
  else return res.json({ ok: false, message: 'Không tìm thấy khoảng cần xoá' });
  saveMetaCache();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Đang chạy: http://localhost:${PORT}`));
