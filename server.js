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
import('./users.js')
  .then(mod => { if (Array.isArray(mod.USERS) && mod.USERS.length) USERS = mod.USERS; })
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
  { code: 'TD1',  short: 'Trường',  full: 'Tạ Quang Trường' },
  { code: 'TD2',  short: 'Phương',  full: 'Trịnh Đức Phương' },
  { code: 'TD3',  short: 'Hiếu',    full: 'Nguyễn Trung Hiếu' },
  { code: 'TD4',  short: 'My',      full: 'Nguyễn Thị Trà My' },
  { code: 'TD5',  short: 'Ánh',     full: 'Lê Thị Ánh' },
  { code: 'TD6',  short: 'Huân',    full: 'Nguyễn Duy Huân' },
  { code: 'TD7',  short: 'Minh',    full: 'Dương Văn Minh' },
  { code: 'TD8',  short: 'Giang',   full: 'Vũ Hà Giang' },
  { code: 'TD9',  short: 'Việt Hà', full: 'Đoàn Việt Hà' },
  { code: 'TD10', short: 'Thuý An', full: 'Vũ Thuý An', aliases: ['Thúy An'] },
  // Nhân viên cũ (chiến dịch cũ chưa có mã) — giữ để vẫn nhận ra, xóa nếu không cần:
  { code: '',     short: 'Thắng',   full: 'Thắng' },
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
  // '513728869887825': 'TK Thời Trang',
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
  req.session.user = { user: u.user, role: u.role, employees: u.employees || [], manager: u.manager || '' };
  res.redirect(u.role === 'product' ? '/products.html' : '/');
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// Từ đây trở xuống yêu cầu đăng nhập
app.use((req, res, next) => {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.redirect('/login');
});

// Cho trang biết người đang đăng nhập là ai (để ẩn/hiện menu, lọc theo người)
app.get('/api/me', (req, res) => {
  const u = req.session.user || {};
  res.json({ user: u.user, role: u.role, manager: u.manager || '', employees: u.employees || [] });
});

// QUYỀN "product": chỉ được vào trang Sản phẩm + API sản phẩm của mình.
// Chặn Dashboard, Marketing và mọi API khác.
app.use((req, res, next) => {
  const me = req.session.user;
  if (me && me.role === 'product') {
    const p = req.path;
    const allowed = ['/products.html', '/logout', '/api/products/report', '/api/me'].includes(p) || p === '/favicon.ico';
    if (!allowed) {
      if (p.startsWith('/api/')) return res.status(403).json({ error: 'Không có quyền truy cập mục này.' });
      return res.redirect('/products.html');
    }
  }
  next();
});

// Bộ nhớ đệm tạm trong RAM: giữ kết quả theo từng khoảng ngày trong vài phút,
// để các lần mở/đăng nhập lại không phải gọi lại Meta -> nhanh hơn nhiều.
const DATA_CACHE = new Map();
const CACHE_MS = 3 * 60 * 1000; // 3 phút

app.get('/api/data', async (req, res) => {
  try {
    const since = req.query.since || '2026-06-01';
    const until = req.query.until || '2026-06-09';
    const days = listDays(since, until);
    const key = since + '|' + until;

    let campaigns;
    const cached = DATA_CACHE.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      campaigns = cached.campaigns;                 // lấy từ đệm -> gần như tức thì
    } else {
      const tasks = [];
      for (const src of SOURCES)
        for (const acc of src.accounts)
          tasks.push(fetchAccount(acc, src.token, days, since, until)); // gọi SONG SONG
      const results = await Promise.allSettled(tasks);
      campaigns = [];
      for (const r of results) if (r.status === 'fulfilled') campaigns.push(...r.value);
      DATA_CACHE.set(key, { at: Date.now(), campaigns });
    }

    // Lọc theo quyền: viewer chỉ thấy nhân viên được phép
    const me = req.session.user;
    let visible = campaigns;
    if (me.role !== 'admin') {
      const allow = new Set(me.employees || []);
      visible = campaigns.filter(c => allow.has(c.employee));
    }
    res.json({ days, campaigns: visible, me: { user: me.user, role: me.role } });
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
//  Mở: /api/marketing/report?since=2026-06-12&until=2026-06-12
app.get('/api/marketing/report', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const since = req.query.since || today;
  const until = req.query.until || since;
  try {
    const rp = await sandboxReport(since, until);
    if (!(rp.json && (rp.json.success ?? rp.json.Success)))
      return res.json({ ok: false, since, until, httpStatus: rp.httpStatus, message: (rp.json && (rp.json.message || rp.json.Message)) || 'Lỗi gọi báo cáo' });
    const m = mapReport(rp.json);
    res.json({ ok: true, ver: 'mkt-2026-06-15-v11-A', since, until, rows: m.rows, total: m.total, lastUpdated: new Date().toISOString() });
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
    if (pc >= 0 && mc >= 0) { pCol = pc; mCol = mc; start = 1; }
    const map = {};
    for (let i = start; i < rows.length; i++) {
      const praw = String(rows[i][pCol] || '').trim();
      const m = String(rows[i][mCol] || '').trim();
      const p = normProd(praw);
      if (p && m) map[p] = { manager: m, productRaw: praw };
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

app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Đang chạy: http://localhost:${PORT}`));
