// server.js — Backend nối dashboard với Meta Marketing API
// HỖ TRỢ NHIỀU DOANH NGHIỆP (TOKEN_1, TOKEN_2, ...) + NHẬN DIỆN TÊN NHÂN VIÊN
// Yêu cầu Node.js 18 trở lên. Chạy: npm install → npm start → mở http://localhost:3000

import express from 'express';
import session from 'express-session';
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const V = process.env.META_API_VERSION || 'v23.0';
const BASE = `https://graph.facebook.com/${V}`;

/* =========================================================================
   TÀI KHOẢN ĐĂNG NHẬP  ← BẠN QUẢN LÝ PHẦN NÀY
   Mỗi tài khoản gồm: user (tên đăng nhập), pass (mật khẩu), role, và employees.
     role 'admin'  → xem TẤT CẢ + là chủ hệ thống.
     role 'viewer' → CHỈ xem các nhân viên ghi trong "employees".
   → Trưởng phòng: role 'viewer', employees liệt kê các nhân viên bạn cho phép xem.
   → Nhân viên thường: role 'viewer', employees chỉ gồm đúng tên của họ.
   Tên trong "employees" phải khớp tên trong danh sách EMPLOYEES bên dưới.
   Thêm/sửa tài khoản = sửa danh sách này rồi commit lên GitHub (Render tự cập nhật).
   ========================================================================= */
const USERS = [
  { user: 'tdmjsc',  pass: 'Tdmjsc@0611', role: 'admin' },

  // Ví dụ trưởng phòng — xem được nhiều nhân viên:
  { user: 'mkt.phuong', pass: 'Phuong@45678', role: 'viewer', employees: ['Phương','Việt Hà','Huân','Thúy An'] },

  // Ví dụ nhân viên — chỉ xem chính mình:
  { user: 'mkt.truong', pass: 'Truong@1234', role: 'viewer', employees: ['Trường','My','Minh','Ánh'] },
];

/* =========================================================================
   DANH SÁCH NHÂN VIÊN  ← BẠN ĐIỀN PHẦN NÀY
   Điền tên tất cả nhân viên chạy quảng cáo. Hệ thống sẽ tìm tên này
   XUẤT HIỆN trong tên chiến dịch, dù viết kiểu nào:
     "Phương- Balo..."   "29/3 Phương"   "Huân Máy cho cá ăn"  → đều nhận ra.
   - Tên có dấu hay không đều khớp (Phương = Phuong).
   - Nếu hai người tên gần giống nhau, ghi đầy đủ hơn (vd "Việt Hà").
   ========================================================================= */
const EMPLOYEES = [
  'Phương',
  'Trường',
  'Thúy An',
  'My',
  'Huân',
  'Ánh',
  'Việt Hà',
  'Giang',
  'Hiếu',
  'Thắng',
  'Minh',
];

/* Nhận diện nhân viên: tách tên chiến dịch thành các "chữ" riêng, rồi tìm xem
   tên nhân viên có xuất hiện trọn vẹn như một (hoặc vài) chữ liền nhau không.
   - KHỚP CÓ DẤU: "Mỹ" sẽ KHÔNG bị tính thành "My"; "hiệu" không thành "Hiếu".
   - Tên 2 chữ như "Thúy An", "Việt Hà" được ưu tiên khớp trước.
   - Lưu ý: nhân viên phải viết đúng dấu tên mình trong tên chiến dịch.
     Nếu viết sai/thiếu dấu, chiến dịch đó sẽ rơi vào nhóm "Chưa xác định"
     để bạn nhìn thấy và sửa. */
function detectEmployee(name) {
  const tokens = (name || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(t => t.toLowerCase());
  const sorted = [...EMPLOYEES].sort(
    (a, b) => b.trim().split(/\s+/).length - a.trim().split(/\s+/).length || b.length - a.length
  );
  for (const e of sorted) {
    const words = e.toLowerCase().trim().split(/\s+/);
    for (let i = 0; i + words.length <= tokens.length; i++) {
      let ok = true;
      for (let j = 0; j < words.length; j++) {
        if (tokens[i + j] !== words[j]) { ok = false; break; }
      }
      if (ok) return e;
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
app.use(session({
  secret: process.env.SESSION_SECRET || 'doi-thanh-mot-chuoi-bi-mat-ngau-nhien',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 ngày
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
  req.session.user = { user: u.user, role: u.role, employees: u.employees || [] };
  res.redirect('/');
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// Từ đây trở xuống yêu cầu đăng nhập
app.use((req, res, next) => {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.redirect('/login');
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

app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Đang chạy: http://localhost:${PORT}`));
