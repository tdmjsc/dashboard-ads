import fs from 'node:fs';
// =====================================================================
//  MODULE QUẢN LÝ ĐƠN HÀNG THÁI LAN  —  thailand.js
//  Thiết kế AN TOÀN TUYỆT ĐỐI: nếu phần này lỗi, KHÔNG làm sập app chính.
//  - Kết nối MySQL kiểu LAZY (chỉ kết nối khi có request, không chặn khởi động)
//  - Mọi thứ bọc try/catch, lỗi DB chỉ trả JSON lỗi cho route /thailand
//  - Export 1 hàm mountThailand(app, deps) để server.js gọi trong try/catch
// =====================================================================

// Trạng thái đơn hợp lệ
const TRANG_THAI = ['Mới về', 'Đã xác nhận', 'Đang giao', 'Thành công', 'Huỷ', 'Hoàn hàng'];

// ---- Tách Số lượng + Giá từ combo (chuỗi tiếng Thái) ----
// Quy tắc theo bảng người dùng cung cấp. Nếu không khớp mẫu nào → trả 0.
function parseCombo(message) {
  const s = String(message == null ? '' : message);
  // Tìm "X กล่อง" để biết số hộp mua (combo)
  const mBox = s.match(/(\d+)\s*กล่อง/);
  const boxes = mBox ? parseInt(mBox[1], 10) : 0;
  // Tìm giá: số đứng trước "THB" (có thể có dấu phẩy ngăn nghìn)
  const mPrice = s.match(/([\d,]+)\s*THB/);
  const gia = mPrice ? parseInt(mPrice[1].replace(/,/g, ''), 10) : 0;

  // Số lượng gel thực nhận theo bảng (mua 3 tặng 1 = 4, mua 4 tặng 1 = 5, mua 5 tặng 1 = 6)
  let soLuong = boxes;
  if (boxes >= 3) soLuong = boxes + 1; // combo 3/4/5 đều tặng thêm 1
  return { soLuong: soLuong || 0, gia: gia || 0, boxes: boxes || 0 };
}

// ---- Tạo bảng nếu chưa có (chạy lazy, an toàn) ----
async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS th_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ngay_ve DATE,
      ho_ten VARCHAR(255),
      sdt VARCHAR(50),
      dia_chi TEXT,
      combo TEXT,
      so_luong INT DEFAULT 0,
      gia_thb INT DEFAULT 0,
      nhan_vien VARCHAR(120) DEFAULT '',
      trang_thai VARCHAR(40) DEFAULT 'Mới về',
      ghi_chu TEXT,
      ma_kh VARCHAR(60) DEFAULT '',
      ma_mau VARCHAR(80) DEFAULT '',
      da_day TINYINT DEFAULT 0,
      ngay_day DATETIME NULL,
      INDEX idx_ngay (ngay_ve),
      INDEX idx_nv (nhan_vien),
      INDEX idx_tt (trang_thai)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // Tự thêm cột nếu bảng cũ chưa có (bỏ qua lỗi nếu cột đã tồn tại)
  for (const col of [
    "ma_kh VARCHAR(60) DEFAULT ''",
    "ma_mau VARCHAR(80) DEFAULT ''",
    "da_day TINYINT DEFAULT 0",
    "ngay_day DATETIME NULL",
  ]) {
    try { await pool.query(`ALTER TABLE th_orders ADD COLUMN ${col}`); } catch (e) {}
  }
}

// =====================================================================
//  mountThailand(app, { mysql, requireLogin })
//   - app: express app
//   - mysql: module 'mysql2/promise' (truyền từ server.js sau khi import động)
//   - requireLogin: middleware đăng nhập của dashboard (tái dùng phiên admin)
// =====================================================================
export function mountThailand(app, { mysql, requireLogin, express }) {
  let pool = null;
  let tableReady = false;

  // ===== Cấu hình ĐẨY ĐƠN SANG HẬU CẦN (tdffm.com) — qua biến môi trường =====
  //   TDFFM_URL    = https://tdffm.com/api/v1/webhook/landingpage
  //   TDFFM_KEY    = x-public-key bên hậu cần cấp
  //   TDFFM_MA_KH  = mã khách hàng cố định (THA284)
  //   TDFFM_MA_MAU = mã mẫu mã mặc định (THA284-GEL)
  //   TDFFM_DS_MAU = danh sách mã mẫu cho dropdown, phân cách dấu phẩy (vd THA284-GEL,THA284-CREAM)
  const TDFFM_URL = process.env.TDFFM_URL || 'https://tdffm.com/api/v1/webhook/landingpage';
  const TDFFM_KEY = process.env.TDFFM_KEY || '';
  const TDFFM_MA_KH = process.env.TDFFM_MA_KH || 'THA284';
  const TDFFM_MA_MAU = process.env.TDFFM_MA_MAU || 'THA284-GEL';
  const TDFFM_DS_MAU = (process.env.TDFFM_DS_MAU || TDFFM_MA_MAU).split(',').map(s => s.trim()).filter(Boolean);

  // Lazy: chỉ tạo pool khi cần, KHÔNG chạy lúc khởi động
  function getPool() {
    if (pool) return pool;
    const host = process.env.TH_DB_HOST || 'localhost';
    const user = process.env.TH_DB_USER || '';
    const password = process.env.TH_DB_PASS || '';
    const database = process.env.TH_DB_NAME || '';
    if (!user || !database) throw new Error('Chưa cấu hình biến môi trường TH_DB_* cho Thailand');
    pool = mysql.createPool({
      host, user, password, database,
      waitForConnections: true, connectionLimit: 5, queueLimit: 0,
      charset: 'utf8mb4',
    });
    return pool;
  }

  // Đảm bảo có pool + bảng, gọi đầu mỗi request DB
  async function db() {
    const p = getPool();
    if (!tableReady) { await ensureTable(p); tableReady = true; }
    return p;
  }

  // Middleware bắt lỗi async gọn gàng
  const wrap = fn => (req, res) => fn(req, res).catch(err => {
    console.error('[thailand] lỗi:', err.message);
    res.status(500).json({ ok: false, message: 'Lỗi máy chủ Thailand: ' + err.message });
  });

  // ---- Auth riêng cho Thailand (đơn giản, dùng session admin của dashboard) ----
  // Nếu đã đăng nhập dashboard với role admin → cho vào luôn.
  function thaiAuth(req, res, next) {
    const u = req.session && req.session.user;
    if (u && u.role === 'admin') return next();
    // Cho phép đăng nhập riêng bằng TH_ADMIN_USER/PASS qua session.thAuth
    if (req.session && req.session.thAuth) return next();
    // Chưa đăng nhập
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, message: 'Cần đăng nhập' });
    return res.redirect('/thailand/login');
  }

  // ====================== WEBHOOK NHẬN ĐƠN TỪ LADIPAGE ======================
  // POST /thailand/webhook  — KHÔNG cần đăng nhập (Ladipage gọi tự động)
  // Nhận CẢ JSON lẫn form-urlencoded. Ghi log mọi request để chẩn đoán.
  // Hai middleware parse riêng biệt, gắn tuần tự (an toàn hơn spread mảng)
  const jsonParser = express.json({ limit: '1mb' });
  const formParser = express.urlencoded({ extended: true, limit: '1mb' });
  // Lấy giá trị từ nhiều khả năng key
  function pick(obj, keys) {
    for (const k of keys) {
      if (obj && obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
    }
    return '';
  }
  app.post('/thailand/webhook', jsonParser, formParser, wrap(async (req, res) => {
    // Ghi log raw để xem Ladipage gửi gì (xem qua /thailand/api/webhook-log)
    try {
      const logLine = JSON.stringify({ at: new Date().toISOString(), body: req.body, query: req.query }) + '\n';
      const logFile = (process.env.DATA_DIR || '.') + '/thailand-webhook.log';
      fs.appendFileSync(logFile, logLine);
    } catch (e) {}

    // Bóc dữ liệu — thử cả cấp ngoài và cấp lồng (.data, .form, .fields)
    let b = req.body || {};
    if (b.data && typeof b.data === 'object') b = { ...b, ...b.data };
    if (b.form && typeof b.form === 'object') b = { ...b, ...b.form };
    if (b.fields && typeof b.fields === 'object') b = { ...b, ...b.fields };

    const name = pick(b, ['name', 'ho_ten', 'fullname', 'full_name', 'ten', 'Name']);
    const phone = pick(b, ['phone', 'sdt', 'tel', 'mobile', 'Phone', 'phone_number']);
    const address = pick(b, ['address', 'dia_chi', 'diachi', 'Address', 'add']);
    const message = pick(b, ['combo', 'message', 'form_item11', 'note', 'content', 'Message', 'product']);
    const nhanVien = pick(b, ['user', 'nhan_vien', 'marketing', 'form_item12', 'ref', 'staff', 'sale', 'utm_source']);
    // Link landing page nguồn (để biết đơn từ trang nào) — lưu vào ghi_chu
    const nguon = pick(b, ['url_page', 'link', 'page_url']);

    if (!name && !phone) return res.json({ ok: false, message: 'Thiếu tên và SĐT', received: b });

    const { soLuong, gia } = parseCombo(message);
    const p = await db();
    const today = new Date().toISOString().slice(0, 10);
    await p.query(
      `INSERT INTO th_orders (ngay_ve, ho_ten, sdt, dia_chi, combo, so_luong, gia_thb, nhan_vien, trang_thai, ghi_chu)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Mới về', ?)`,
      [today, name, phone, address, message, soLuong, gia, nhanVien, nguon]
    );
    res.json({ ok: true, message: 'Đã nhận đơn', parsed: { soLuong, gia } });
  }));

  // Xem log webhook (admin) — để chẩn đoán Ladipage gửi gì
  app.get('/thailand/api/webhook-log', thaiAuth, (req, res) => {
    try {
      const logFile = (process.env.DATA_DIR || '.') + '/thailand-webhook.log';
      const data = fs.readFileSync(logFile, 'utf8');
      const lines = data.trim().split('\n').slice(-20).map(l => { try { return JSON.parse(l); } catch { return l; } });
      res.json({ ok: true, count: lines.length, logs: lines });
    } catch (e) {
      res.json({ ok: true, count: 0, logs: [], message: 'Chưa có log nào (Ladipage chưa gọi webhook lần nào)' });
    }
  });

  // ====================== ĐĂNG NHẬP RIÊNG CHO THAILAND ======================
  app.get('/thailand/login', (req, res) => {
    res.type('html').send(loginHtml());
  });
  app.post('/thailand/login', express.urlencoded({ extended: true }), (req, res) => {
    const { user, pass } = req.body || {};
    const okUser = process.env.TH_ADMIN_USER || 'admin';
    const okPass = process.env.TH_ADMIN_PASS || '';
    if (user === okUser && pass === okPass && okPass) {
      req.session.thAuth = true;
      // Lưu session XONG rồi mới chuyển trang (tránh mất phiên do redirect quá sớm)
      return req.session.save(() => res.redirect('/thailand'));
    }
    res.type('html').send(loginHtml('Sai tài khoản hoặc mật khẩu'));
  });
  app.get('/thailand/logout', (req, res) => {
    if (req.session) req.session.thAuth = false;
    res.redirect('/thailand/login');
  });

  // ====================== API DỮ LIỆU (cần đăng nhập) ======================
  // Danh sách đơn + lọc + tìm kiếm
  app.get('/thailand/api/orders', thaiAuth, wrap(async (req, res) => {
    const p = await db();
    const { tu, den, nv, tt, q } = req.query;
    const where = [], args = [];
    if (tu) { where.push('ngay_ve >= ?'); args.push(tu); }
    if (den) { where.push('ngay_ve <= ?'); args.push(den); }
    if (nv) { where.push('nhan_vien = ?'); args.push(nv); }
    if (tt) { where.push('trang_thai = ?'); args.push(tt); }
    if (q) { where.push('(ho_ten LIKE ? OR sdt LIKE ? OR dia_chi LIKE ?)'); const like = '%' + q + '%'; args.push(like, like, like); }
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await p.query(`SELECT * FROM th_orders ${wsql} ORDER BY id DESC LIMIT 2000`, args);
    // Danh sách nhân viên (để lọc)
    const [nvRows] = await p.query(`SELECT DISTINCT nhan_vien FROM th_orders WHERE nhan_vien <> '' ORDER BY nhan_vien`);
    res.json({ ok: true, orders: rows, nhanViens: nvRows.map(r => r.nhan_vien), trangThais: TRANG_THAI, dsMau: TDFFM_DS_MAU, maMauDefault: TDFFM_MA_MAU });
  }));

  // Cập nhật 1 đơn (trạng thái, nhân viên, hoặc sửa thông tin)
  app.post('/thailand/api/order/update', thaiAuth, express.json(), wrap(async (req, res) => {
    const { id, field, value } = req.body || {};
    if (!id || !field) return res.json({ ok: false, message: 'Thiếu id hoặc field' });
    const allowed = ['trang_thai', 'nhan_vien', 'ho_ten', 'sdt', 'dia_chi', 'so_luong', 'gia_thb', 'ghi_chu', 'ngay_ve'];
    if (!allowed.includes(field)) return res.json({ ok: false, message: 'Field không hợp lệ' });
    if (field === 'trang_thai' && !TRANG_THAI.includes(value)) return res.json({ ok: false, message: 'Trạng thái không hợp lệ' });
    const p = await db();
    await p.query(`UPDATE th_orders SET ${field} = ? WHERE id = ?`, [value, id]);
    res.json({ ok: true });
  }));

  // Thêm đơn thủ công
  app.post('/thailand/api/order/add', thaiAuth, express.json(), wrap(async (req, res) => {
    const b = req.body || {};
    const { soLuong, gia } = parseCombo(b.combo || '');
    const p = await db();
    await p.query(
      `INSERT INTO th_orders (ngay_ve, ho_ten, sdt, dia_chi, combo, so_luong, gia_thb, nhan_vien, trang_thai)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.ngay_ve || new Date().toISOString().slice(0, 10), b.ho_ten || '', b.sdt || '', b.dia_chi || '',
       b.combo || '', b.so_luong || soLuong, b.gia_thb || gia, b.nhan_vien || '', b.trang_thai || 'Mới về']
    );
    res.json({ ok: true });
  }));

  // Xoá đơn
  app.post('/thailand/api/order/delete', thaiAuth, express.json(), wrap(async (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.json({ ok: false, message: 'Thiếu id' });
    const p = await db();
    await p.query(`DELETE FROM th_orders WHERE id = ?`, [id]);
    res.json({ ok: true });
  }));

  // ====================== ĐẨY ĐƠN SANG HẬU CẦN (tdffm.com) ======================
  function yyyymmdd(d) {
    const x = d || new Date();
    const vn = new Date(x.getTime() + 7 * 3600 * 1000);
    return vn.toISOString().slice(0, 10).replace(/-/g, '');
  }

  // Đẩy 1 hoặc nhiều đơn (theo danh sách id) sang hậu cần
  app.post('/thailand/api/push', thaiAuth, express.json(), wrap(async (req, res) => {
    if (!TDFFM_KEY) return res.json({ ok: false, message: 'Chưa cấu hình TDFFM_KEY trên máy chủ' });
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.json({ ok: false, message: 'Chưa chọn đơn nào' });

    const p = await db();
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await p.query(`SELECT * FROM th_orders WHERE id IN (${placeholders})`, ids);
    if (!rows.length) return res.json({ ok: false, message: 'Không tìm thấy đơn' });

    // Tạo payload đúng định dạng bên hậu cần yêu cầu (key trùng tên cột Google Sheet)
    const exportData = rows.map(o => ({
      '*Mã khách hàng': TDFFM_MA_KH,
      '*Tên khách hàng': o.ho_ten || '',
      '*SĐT khách hàng': o.sdt || '',
      '*Địa chỉ giao hàng': o.dia_chi || '',
      '*Tiền COD': o.gia_thb || 0,
      '*Mã mẫu mã': o.ma_mau || TDFFM_MA_MAU,
      '*Số lượng': o.so_luong || 0,
      '*Cần sale bán hàng': 'NEED_SALE',
      'Ghi chú': o.ghi_chu || '',
      'Hình thức thanh toán': 'COD',
    }));

    let result;
    try {
      const resp = await fetch(TDFFM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-public-key': TDFFM_KEY },
        body: JSON.stringify({ createDate: yyyymmdd(), exportData }),
      });
      result = await resp.json().catch(() => ({}));
    } catch (e) {
      return res.json({ ok: false, message: 'Lỗi gọi API hậu cần: ' + e.message });
    }

    if (result && result.errors) {
      return res.json({ ok: false, message: 'Hậu cần báo lỗi: ' + JSON.stringify(result.errors) });
    }

    // Đánh dấu các đơn đã đẩy
    await p.query(`UPDATE th_orders SET da_day = 1, ngay_day = NOW() WHERE id IN (${placeholders})`, ids);
    res.json({ ok: true, count: rows.length, message: 'Đã đẩy ' + rows.length + ' đơn sang hậu cần' });
  }));

  // Thống kê doanh thu theo nhân viên
  app.get('/thailand/api/stats', thaiAuth, wrap(async (req, res) => {
    const p = await db();
    const { tu, den } = req.query;
    const where = [], args = [];
    if (tu) { where.push('ngay_ve >= ?'); args.push(tu); }
    if (den) { where.push('ngay_ve <= ?'); args.push(den); }
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await p.query(`
      SELECT nhan_vien,
        COUNT(*) AS so_don,
        SUM(CASE WHEN trang_thai='Thành công' THEN 1 ELSE 0 END) AS don_thanh_cong,
        SUM(CASE WHEN trang_thai='Thành công' THEN gia_thb ELSE 0 END) AS doanh_thu_thb,
        SUM(so_luong) AS tong_sl
      FROM th_orders ${wsql}
      GROUP BY nhan_vien ORDER BY doanh_thu_thb DESC`, args);
    res.json({ ok: true, stats: rows });
  }));

  // Xuất CSV
  app.get('/thailand/api/export', thaiAuth, wrap(async (req, res) => {
    const p = await db();
    const [rows] = await p.query(`SELECT * FROM th_orders ORDER BY id DESC LIMIT 10000`);
    const head = ['ID', 'Ngày về', 'Họ tên', 'SĐT', 'Địa chỉ', 'Combo', 'Số lượng', 'Giá THB', 'Nhân viên', 'Trạng thái', 'Ghi chú'];
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    let csv = '\uFEFF' + head.map(esc).join(',') + '\n';
    for (const r of rows) {
      csv += [r.id, r.ngay_ve, r.ho_ten, r.sdt, r.dia_chi, r.combo, r.so_luong, r.gia_thb, r.nhan_vien, r.trang_thai, r.ghi_chu].map(esc).join(',') + '\n';
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="don-thailand.csv"');
    res.send(csv);
  }));

  // ====================== TRANG QUẢN LÝ (HTML) ======================
  app.get('/thailand', thaiAuth, (req, res) => {
    res.type('html').send(pageHtml());
  });

  console.log('[thailand] Đã gắn module quản lý đơn Thái Lan tại /thailand');
}

// ---- HTML trang đăng nhập ----
function loginHtml(err) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Đăng nhập — Đơn Thái Lan</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#0B1322;color:#E7EEF8;display:grid;place-items:center;height:100vh;}
.box{background:#101B2E;padding:32px;border-radius:16px;width:320px;border:1px solid rgba(255,255,255,.08);}
h1{font-size:18px;margin:0 0 18px;}input{width:100%;padding:11px;margin-bottom:12px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#fff;font-size:14px;box-sizing:border-box;}
button{width:100%;padding:12px;border:none;border-radius:9px;background:#3D5AFE;color:#fff;font-size:14px;font-weight:600;cursor:pointer;}
.err{color:#ff9b8a;font-size:13px;margin-bottom:12px;}</style></head>
<body><form class="box" method="POST" action="/thailand/login">
<h1>🇹🇭 Đơn hàng Thái Lan</h1>
${err ? `<div class="err">${err}</div>` : ''}
<input name="user" placeholder="Tài khoản" autofocus>
<input name="pass" type="password" placeholder="Mật khẩu">
<button type="submit">Đăng nhập</button>
</form></body></html>`;
}

// ---- HTML trang quản lý chính ----
function pageHtml() {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quản lý đơn Thái Lan</title>
<style>
*{box-sizing:border-box;}body{margin:0;font-family:system-ui,sans-serif;background:#0B1322;color:#E7EEF8;}
header{background:#10192B;border-bottom:1px solid rgba(255,255,255,.07);padding:14px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
h1{font-size:17px;margin:0;flex:1;}
.btn{font-size:13px;font-weight:600;color:#fff;background:#3D5AFE;border:none;padding:8px 14px;border-radius:9px;cursor:pointer;}
.btn.g{background:#7BE3B5;color:#0B1322;}.btn.ghost{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);}
.link{color:#C4D0E2;font-size:13px;text-decoration:none;border:1px solid rgba(255,255,255,.14);padding:7px 12px;border-radius:9px;}
main{padding:16px;max-width:1400px;margin:0 auto;}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center;}
.filters input,.filters select{font-size:13px;color:#fff;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);padding:8px 10px;border-radius:8px;color-scheme:dark;}
.tabs{display:flex;gap:8px;margin-bottom:14px;}
.tab{padding:8px 14px;border-radius:9px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);cursor:pointer;font-size:13px;}
.tab.on{background:#3D5AFE;border-color:#3D5AFE;}
.wrap{overflow-x:auto;border-radius:12px;}
table{width:100%;border-collapse:collapse;background:#101B2E;min-width:1100px;}
th,td{padding:10px 12px;text-align:left;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05);white-space:nowrap;}
th{background:#16233A;color:#9FB0C8;font-size:11.5px;text-transform:uppercase;}
td.num{text-align:right;font-variant-numeric:tabular-nums;}
select.st,input.ed{font-size:12.5px;color:#fff;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:4px 6px;color-scheme:dark;}
input.ed{width:100px;}.st-moi{color:#9DB2FF;}.st-tc{color:#7BE3B5;}.st-huy{color:#ff9b8a;}
.muted{color:#6B7C97;}.empty{padding:36px;text-align:center;color:#6B7C97;}
.stat-card{display:inline-block;background:#101B2E;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:14px 18px;margin:0 10px 10px 0;}
.stat-card .nv{font-size:13px;color:#9DB2FF;font-weight:600;}.stat-card .big{font-size:20px;font-weight:700;color:#7BE3B5;margin-top:4px;}
.stat-card .sub{font-size:11px;color:#9FB0C8;margin-top:2px;}
.del{color:#ff9b8a;cursor:pointer;font-size:16px;}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:flex-start;justify-content:center;z-index:100;overflow-y:auto;padding:40px 16px;}
.modal-bg.show{display:flex;}
.modal{background:#101B2E;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:24px;width:480px;max-width:100%;}
.modal h2{margin:0 0 18px;font-size:18px;}
.modal label{display:block;font-size:12px;color:#9FB0C8;margin:12px 0 5px;font-weight:600;}
.modal input,.modal select,.modal textarea{width:100%;font-family:inherit;font-size:14px;color:#fff;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:10px 12px;box-sizing:border-box;color-scheme:dark;}
.modal textarea{min-height:70px;resize:vertical;}
.modal .row{display:flex;gap:10px;}
.modal .row>div{flex:1;}
.modal-actions{display:flex;gap:10px;margin-top:20px;}
.modal-actions button{flex:1;padding:12px;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;}
.modal-actions .save{background:#7BE3B5;color:#0B1322;}
.modal-actions .cancel{background:rgba(255,255,255,.08);color:#E7EEF8;border:1px solid rgba(255,255,255,.14);}
.hint{font-size:11px;color:#6B7C97;margin-top:4px;}

</style></head>
<body>
<header>
  <h1>🇹🇭 Quản lý đơn Thái Lan</h1>
  <button class="btn g" id="addBtn">+ Thêm đơn</button>
  <button class="btn" id="pushBtn" style="background:#FF9F45;color:#0B1322;">🚚 Đẩy sang hậu cần</button>
  <a class="link" href="/thailand/api/export">⬇ Xuất CSV</a>
  <a class="link" href="/">← Dashboard</a>
  <a class="link" href="/thailand/logout">Đăng xuất</a>
</header>
<main>
  <div class="tabs">
    <div class="tab on" data-tab="orders" id="tabOrders">📋 Danh sách đơn</div>
    <div class="tab" data-tab="stats" id="tabStats">📊 Thống kê doanh thu</div>
  </div>

  <div id="ordersView">
    <div class="filters">
      <input type="date" id="fTu"><span class="muted">→</span><input type="date" id="fDen">
      <select id="fNv"><option value="">Mọi nhân viên</option></select>
      <select id="fTt"><option value="">Mọi trạng thái</option></select>
      <input id="fQ" placeholder="Tìm tên/SĐT/địa chỉ…">
      <button class="btn" id="fBtn">Lọc</button>
      <button class="btn ghost" id="fReset">Xoá lọc</button>
    </div>
    <div class="wrap"><div id="tbl"></div></div>
  </div>

  <div id="statsView" style="display:none;">
    <div class="filters">
      <input type="date" id="sTu"><span class="muted">→</span><input type="date" id="sDen">
      <button class="btn" id="sBtn">Xem</button>
    </div>
    <div id="statsBox"></div>
  </div>

  <div class="modal-bg" id="addModal">
    <div class="modal">
      <h2>+ Thêm đơn mới</h2>
      <label>Họ tên khách</label>
      <input id="m_ten" placeholder="Tên khách hàng">
      <label>Số điện thoại</label>
      <input id="m_sdt" placeholder="SĐT">
      <label>Địa chỉ</label>
      <textarea id="m_diachi" placeholder="Địa chỉ giao hàng"></textarea>
      <label>Combo (chuỗi tiếng Thái — tự tách SL + giá)</label>
      <textarea id="m_combo" placeholder="VD: คอมโบ 2 กล่อง: 549 THB..."></textarea>
      <div class="hint">Hoặc nhập tay SL + giá bên dưới (nếu để trống sẽ tự tách từ combo)</div>
      <div class="row">
        <div><label>Số lượng</label><input id="m_sl" inputmode="numeric" placeholder="tự tách"></div>
        <div><label>Giá THB</label><input id="m_gia" inputmode="numeric" placeholder="tự tách"></div>
      </div>
      <label>Nhân viên marketing</label>
      <input id="m_nv" placeholder="Tên nhân viên">
      <div class="modal-actions">
        <button class="cancel" id="m_cancel">Huỷ</button>
        <button class="save" id="m_save">Lưu đơn</button>
      </div>
    </div>
  </div>
</main>

<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const thb=n=>(Number(n)||0).toLocaleString('en-US');
let TT=[], NV=[], DSMAU=[], MAU_DEFAULT='';

function tabSwitch(t){
  $('tabOrders').classList.toggle('on',t==='orders');
  $('tabStats').classList.toggle('on',t==='stats');
  $('ordersView').style.display=t==='orders'?'':'none';
  $('statsView').style.display=t==='stats'?'':'none';
  if(t==='stats') loadStats();
}
$('tabOrders').onclick=()=>tabSwitch('orders');
$('tabStats').onclick=()=>tabSwitch('stats');

async function loadOrders(){
  const qs=new URLSearchParams();
  if($('fTu').value)qs.set('tu',$('fTu').value);
  if($('fDen').value)qs.set('den',$('fDen').value);
  if($('fNv').value)qs.set('nv',$('fNv').value);
  if($('fTt').value)qs.set('tt',$('fTt').value);
  if($('fQ').value)qs.set('q',$('fQ').value);
  $('tbl').innerHTML='<div class="empty">Đang tải…</div>';
  try{
    const r=await fetch('/thailand/api/orders?'+qs.toString());
    if(r.status===401){location.href='/thailand/login';return;}
    const d=await r.json();
    if(!d.ok){$('tbl').innerHTML='<div class="empty">'+esc(d.message)+'</div>';return;}
    TT=d.trangThais; NV=d.nhanViens; DSMAU=d.dsMau||[]; MAU_DEFAULT=d.maMauDefault||'';
    // fill selects
    if($('fNv').options.length<=1) NV.forEach(n=>$('fNv').insertAdjacentHTML('beforeend','<option>'+esc(n)+'</option>'));
    if($('fTt').options.length<=1) TT.forEach(t=>$('fTt').insertAdjacentHTML('beforeend','<option>'+esc(t)+'</option>'));
    render(d.orders);
  }catch(e){$('tbl').innerHTML='<div class="empty">Lỗi tải dữ liệu</div>';}
}

function stCls(t){return t==='Thành công'?'st-tc':t==='Huỷ'||t==='Hoàn hàng'?'st-huy':t==='Mới về'?'st-moi':'';}

function mauSelect(o){
  const cur=o.ma_mau||MAU_DEFAULT;
  // Đảm bảo mã hiện tại có trong danh sách (nếu là mã cũ chưa có trong env)
  const list=[...new Set([cur, ...DSMAU].filter(Boolean))];
  const opts=list.map(m=>'<option'+(m===cur?' selected':'')+'>'+esc(m)+'</option>').join('');
  return '<select class="st" style="min-width:120px" onchange="upd('+o.id+',\'ma_mau\',this.value)">'+opts+'</select>';
}
function render(orders){
  if(!orders.length){$('tbl').innerHTML='<div class="empty">Chưa có đơn nào.</div>';return;}
  let h='<table><thead><tr><th>Ngày về</th><th>Họ tên</th><th>SĐT</th><th>Địa chỉ</th><th>Combo</th><th class="num">SL</th><th class="num">Giá THB</th><th>Nhân viên</th><th>Trạng thái</th><th></th></tr></thead><tbody>';
  orders.forEach(o=>{
    const ttOpts=TT.map(t=>'<option'+(t===o.trang_thai?' selected':'')+'>'+esc(t)+'</option>').join('');
    h+='<tr>'
      +'<td>'+esc((o.ngay_ve||'').slice(0,10))+'</td>'
      +'<td>'+esc(o.ho_ten)+'</td>'
      +'<td>'+esc(o.sdt)+'</td>'
      +'<td class="muted">'+esc(o.dia_chi)+'</td>'
      +'<td class="muted" style="max-width:200px;white-space:normal;font-size:11px;">'+esc(o.combo)+'</td>'
      +'<td class="num">'+esc(o.so_luong)+'</td>'
      +'<td class="num">'+thb(o.gia_thb)+'</td>'
      +'<td><input class="ed" value="'+esc(o.nhan_vien||'')+'" onchange="upd('+o.id+',\\'nhan_vien\\',this.value)"></td>'
      +'<td><select class="st '+stCls(o.trang_thai)+'" onchange="upd('+o.id+',\\'trang_thai\\',this.value)">'+ttOpts+'</select></td>'
      +'<td><span class="del" onclick="del('+o.id+')">✕</span></td>'
      +'</tr>';
  });
  h+='</tbody></table>';
  $('tbl').innerHTML=h;
}

async function upd(id,field,value){
  try{await fetch('/thailand/api/order/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,field,value})});}catch(e){}
}
async function del(id){
  if(!confirm('Xoá đơn này?'))return;
  try{await fetch('/thailand/api/order/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});loadOrders();}catch(e){}
}

function openAddModal(){
  ['m_ten','m_sdt','m_diachi','m_combo','m_sl','m_gia','m_nv'].forEach(id=>$(id).value='');
  $('addModal').classList.add('show');
  $('m_ten').focus();
}
function closeAddModal(){ $('addModal').classList.remove('show'); }
$('addBtn').onclick=openAddModal;
$('pushBtn').onclick=pushSelected;
$('m_cancel').onclick=closeAddModal;
// Bấm ra ngoài modal KHÔNG đóng (tránh mất dữ liệu khi lỡ tay) — chỉ đóng bằng nút
$('m_save').onclick=async()=>{
  const ho_ten=$('m_ten').value.trim();
  if(!ho_ten && !$('m_sdt').value.trim()){ alert('Cần ít nhất Tên hoặc SĐT'); return; }
  const body={
    ho_ten, sdt:$('m_sdt').value.trim(), dia_chi:$('m_diachi').value.trim(),
    combo:$('m_combo').value.trim(), nhan_vien:$('m_nv').value.trim()
  };
  const sl=parseInt(($('m_sl').value||'').replace(/[^\d]/g,''),10);
  const gia=parseInt(($('m_gia').value||'').replace(/[^\d]/g,''),10);
  if(sl>0) body.so_luong=sl;
  if(gia>0) body.gia_thb=gia;
  try{
    await fetch('/thailand/api/order/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    closeAddModal(); loadOrders();
  }catch(e){ alert('Lỗi thêm đơn'); }
};

$('fBtn').onclick=loadOrders;
$('fReset').onclick=()=>{['fTu','fDen','fNv','fTt','fQ'].forEach(id=>$(id).value='');loadOrders();};

async function loadStats(){
  const qs=new URLSearchParams();
  if($('sTu').value)qs.set('tu',$('sTu').value);
  if($('sDen').value)qs.set('den',$('sDen').value);
  $('statsBox').innerHTML='<div class="empty">Đang tải…</div>';
  try{
    const r=await fetch('/thailand/api/stats?'+qs.toString());
    const d=await r.json();
    if(!d.ok){$('statsBox').innerHTML='<div class="empty">'+esc(d.message)+'</div>';return;}
    if(!d.stats.length){$('statsBox').innerHTML='<div class="empty">Chưa có dữ liệu.</div>';return;}
    let h='';
    d.stats.forEach(s=>{
      h+='<div class="stat-card"><div class="nv">'+esc(s.nhan_vien||'(chưa gán)')+'</div>'
        +'<div class="big">'+thb(s.doanh_thu_thb)+' THB</div>'
        +'<div class="sub">'+s.so_don+' đơn · '+s.don_thanh_cong+' thành công · '+(s.tong_sl||0)+' sp</div></div>';
    });
    $('statsBox').innerHTML=h;
  }catch(e){$('statsBox').innerHTML='<div class="empty">Lỗi tải dữ liệu</div>';}
}
$('sBtn').onclick=loadStats;

loadOrders();
</script>
</body></html>`;
}
