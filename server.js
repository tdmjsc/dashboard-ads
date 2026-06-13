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
   Tên trong "employees" phải khớp cột "full" (TÊN ĐẦY ĐỦ) trong EMPLOYEES bên dưới.
   Thêm/sửa tài khoản = sửa danh sách này rồi commit lên GitHub (Render tự cập nhật).
   ========================================================================= */
const USERS = [
  { user: 'admin',  pass: 'DOI_MAT_KHAU_NAY', role: 'admin' },

  // Ví dụ trưởng phòng — xem được nhiều nhân viên:
  { user: 'truongphong1', pass: '123456', role: 'viewer', employees: ['Trịnh Đức Phương', 'Nguyễn Thị Trà My', 'Nguyễn Duy Huân'] },

  // Ví dụ nhân viên — chỉ xem chính mình:
  { user: 'phuong', pass: '123456', role: 'viewer', employees: ['Trịnh Đức Phương'] },
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
const SANDBOX_BRANCH = process.env.SANDBOX_BRANCH || null; // null = tất cả chi nhánh
const MKT_PAGE_DELAY_MS = 61 * 1000; // chờ 61s giữa các trang (API giới hạn 60s/endpoint)
const MKT_MAX_PAGES = 30;            // an toàn: tối đa 30 trang (~3000 đơn) mỗi lần

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  try {
    for (let page = 1; page <= MKT_MAX_PAGES; page++) {
      const res = await fetch(`${SANDBOX_BASE}/DonHangLogistic/GetOrderByConditions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SANDBOX_TOKEN}` },
        body: JSON.stringify({
          idChiNhanh: SANDBOX_BRANCH,
          kieuNgay: 'NgayTao',
          tuNgay: `${since}T00:00:00+07:00`,
          denNgay: `${until}T23:59:59+07:00`,
          pageInfo: { page, pageSize: 100 },
          sorts: [],
          isIncludeDetail: true,  // lấy danh sách sản phẩm của đơn
          isHistories: false,
        }),
      });
      const json = await res.json();
      if (!json.success) { MKT.error = json.message || 'API Sandbox báo lỗi (kiểm tra token).'; break; }
      const orders = json.data || [];
      aggregateMarketing(orders, acc);
      MKT.loaded += orders.length;
      const tr = Number(json.totalRecord) || 0;
      MKT.totalRecord = tr || MKT.loaded;
      MKT.rows = Object.values(acc).map(r => {
        const prods = Object.values(r.products).sort((x, y) => y.soDon - x.soDon);
        return {
          name: r.name, soDon: r.data, chot: r.chot, ship: r.ship,
          soSP: prods.reduce((s, p) => s + p.soLuong, 0), // tổng số lượng sản phẩm
          doanhthu: r.doanhthu, products: prods,
        };
      }).sort((a, b) => (b.chot - a.chot) || (b.doanhthu - a.doanhthu)); // điền dần để xem tiến độ
      if (orders.length < 100) break;          // trang chưa đủ 100 -> đã hết dữ liệu
      if (tr && MKT.loaded >= tr) break;        // hoặc đã lấy đủ theo totalRecord
      await sleep(MKT_PAGE_DELAY_MS);           // tôn trọng giới hạn 60s/endpoint
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

// (TẠM — để gỡ lỗi) Xem cấu trúc dữ liệu thật từ Sandbox: mở /api/marketing/sample
//  để biết đúng tên trường sản phẩm + trạng thái giao hàng. Xoá sau khi đã chỉnh xong.
app.get('/api/marketing/sample', async (req, res) => {
  if (!SANDBOX_TOKEN) return res.json({ error: 'Chưa khai SANDBOX_TOKEN' });
  const today = new Date().toISOString().slice(0, 10);
  const since = req.query.since || (today.slice(0, 8) + '01');
  const until = req.query.until || today;
  try {
    const r = await fetch(`${SANDBOX_BASE}/DonHangLogistic/GetOrderByConditions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SANDBOX_TOKEN}` },
      body: JSON.stringify({
        idChiNhanh: SANDBOX_BRANCH, kieuNgay: 'NgayTao',
        tuNgay: `${since}T00:00:00+07:00`, denNgay: `${until}T23:59:59+07:00`,
        pageInfo: { page: 1, pageSize: 20 }, sorts: [],
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
    res.json({
      success: json.success, totalRecord: json.totalRecord, count: orders.length,
      orderKeys: Object.keys(o0),
      statusFields,
      distinctOrderStatusName: [...new Set(orders.map(o => o.orderStatusName).filter(x => x != null && x !== ''))],
      anyDetailsNonEmpty: orders.some(o => Array.isArray(o.details) && o.details.length),
      detailsSampleKeys: withDetails ? Object.keys(withDetails.details[0]) : null,
      detailsSample: withDetails ? withDetails.details.slice(0, 2) : [],
    });
  } catch (e) { res.json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Đang chạy: http://localhost:${PORT}`));
