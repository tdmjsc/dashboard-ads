import fs from 'node:fs';
// =====================================================================
//  MODULE QUẢN LÝ ĐƠN HÀNG THÁI LAN  —  thailand.js
//  Thiết kế AN TOÀN TUYỆT ĐỐI: nếu phần này lỗi, KHÔNG làm sập app chính.
//  - Kết nối MySQL kiểu LAZY (chỉ kết nối khi có request, không chặn khởi động)
//  - Mọi thứ bọc try/catch, lỗi DB chỉ trả JSON lỗi cho route /thailand
//  - Export 1 hàm mountThailand(app, deps) để server.js gọi trong try/catch
// =====================================================================

// Trạng thái đơn hợp lệ
const TRANG_THAI = [
  'Mới về', 'Chưa xử lý', 'Đã xác nhận', 'Sale xác nhận', 'Chờ hàng', 'Đang xử lý',
  'Đã đóng gói', 'Có vấn đề', 'Từ chối', 'Đang giao', 'Đã giao', 'Giao thành công',
  'Giao thất bại', 'Đang hoàn', 'Hoàn hàng', 'Đã hoàn', 'Hoàn tất', 'Thành công', 'Huỷ',
];

// ---- Tách Số lượng + Giá từ combo (chuỗi tiếng Thái) ----
// Quy tắc theo bảng người dùng cung cấp. Nếu không khớp mẫu nào → trả 0.
function parseCombo(message) {
  const s = String(message == null ? '' : message);
  // Tìm "X กล่อง" để biết số hộp mua (combo)
  const mBox = s.match(/(\d+)\s*กล่อง/);
  const boxes = mBox ? parseInt(mBox[1], 10) : 0;
  // Tìm TẤT CẢ số đứng trước "THB" rồi CỘNG lại (tiền hàng + phí ship)
  // VD "549 THB + ค่าส่ง 49 THB" → 549 + 49 = 598
  let gia = 0;
  const all = s.match(/([\d,]+)\s*THB/g);
  if (all) {
    for (const m of all) {
      const n = parseInt(m.replace(/[^\d]/g, ''), 10);
      if (!isNaN(n)) gia += n;
    }
  }

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
    "tdffm_uid VARCHAR(120) DEFAULT ''",
    "tdffm_sync_at DATETIME NULL",
    "ma_sp VARCHAR(100) DEFAULT ''",
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
export function mountThailand(app, { mysql, requireLogin, express, getCampaigns, QC_TAX, loadOwners, normProd, detectEmployee, exposeCounter }) {
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
  const TDFFM_PRIVATE_KEY = process.env.TDFFM_PRIVATE_KEY || TDFFM_KEY; // dùng cùng key nếu không cấu hình riêng
  const TDFFM_BASE_URL = 'https://tdffm.com/api/v1/public';
  const TDFFM_MA_KH = process.env.TDFFM_MA_KH || 'THA284';
  // ===== Đăng nhập nội bộ TDFFM (để đồng bộ trạng thái đơn qua API web) =====
  //   TDFFM_USER     = tên đăng nhập tdffm.com (vd THA284) — cũng chấp nhận TDFFM_EMAIL
  //   TDFFM_PASSWORD = mật khẩu đăng nhập tdffm.com
  const TDFFM_USER = process.env.TDFFM_USER || process.env.TDFFM_EMAIL || '';
  const TDFFM_PASSWORD = process.env.TDFFM_PASSWORD || '';
  const TDFFM_INTERNAL_BASE = 'https://tdffm.com/api/v1';
  // Chỉ đồng bộ đơn tạo từ ngày này trở đi (YYYY-MM-DD). Mặc định 01/06/2026.
  const TDFFM_SYNC_FROM = process.env.TDFFM_SYNC_FROM || '2026-06-01';
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
    if (!tableReady) {
      await ensureTable(p);
      // Điền ma_mau mặc định cho đơn cũ chưa có
      try { await p.query(`UPDATE th_orders SET ma_mau = ? WHERE ma_mau = '' OR ma_mau IS NULL`, [TDFFM_MA_MAU]); } catch {}
      tableReady = true;
    }
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
    // Nhân viên đã đăng nhập dashboard chính cũng được vào (sẽ bị lọc theo tên)
    if (u && u.user) return next();
    // Cho phép đăng nhập riêng bằng TH_ADMIN_USER/PASS qua session.thAuth
    if (req.session && req.session.thAuth) return next();
    // Chưa đăng nhập
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, message: 'Cần đăng nhập' });
    return res.redirect('/thailand/login');
  }
  // Xác định quyền: admin (xem tất cả + đẩy đơn) hay nhân viên (chỉ xem đơn của mình)
  function thaiWho(req) {
    const u = (req.session && req.session.user) || {};
    // Admin: role admin HOẶC đăng nhập riêng bằng TH_ADMIN (thAuth)
    const isAdmin = u.role === 'admin' || (req.session && req.session.thAuth) || false;
    // Tên nhân viên để lọc đơn (ưu tiên salaryName, rồi manager, rồi tên đầu trong employees)
    const myName = u.salaryName || u.manager || (u.employees && u.employees[0]) || '';
    return { isAdmin, myName };
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
    const today = todayVN();
    await p.query(
      `INSERT INTO th_orders (ngay_ve, ho_ten, sdt, dia_chi, combo, so_luong, gia_thb, nhan_vien, trang_thai, ghi_chu, ma_mau)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Mới về', ?, ?)`,
      [today, name, phone, address, message, soLuong, gia, nhanVien, nguon, TDFFM_MA_MAU]
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
    const { isAdmin, myName } = thaiWho(req);
    const { tu, den, nv, tt, q, day } = req.query;
    const where = [], args = [];
    if (tu) { where.push('ngay_ve >= ?'); args.push(tu); }
    if (den) { where.push('ngay_ve <= ?'); args.push(den); }
    // Nhân viên: CHỈ xem đơn của chính mình (theo tên). Admin: xem tất cả + lọc tuỳ chọn.
    if (!isAdmin) {
      where.push('nhan_vien = ?'); args.push(myName || '\u0000'); // nếu không có tên → không thấy đơn nào
    } else if (nv) {
      where.push('nhan_vien = ?'); args.push(nv);
    }
    if (tt) { where.push('trang_thai = ?'); args.push(tt); }
    if (day === 'done') { where.push('da_day = 1'); }
    else if (day === 'pending') { where.push('(da_day = 0 OR da_day IS NULL)'); }
    if (q) { where.push('(ho_ten LIKE ? OR sdt LIKE ? OR dia_chi LIKE ?)'); const like = '%' + q + '%'; args.push(like, like, like); }
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await p.query(`SELECT * FROM th_orders ${wsql} ORDER BY id DESC LIMIT 2000`, args);
    // Danh sách nhân viên (chỉ admin cần, để lọc)
    let nhanViens = [];
    if (isAdmin) {
      const [nvRows] = await p.query(`SELECT DISTINCT nhan_vien FROM th_orders WHERE nhan_vien <> '' ORDER BY nhan_vien`);
      nhanViens = nvRows.map(r => r.nhan_vien);
    }
    res.json({ ok: true, orders: rows, nhanViens, trangThais: TRANG_THAI, dsMau: TDFFM_DS_MAU, maMauDefault: TDFFM_MA_MAU, isAdmin, myName });
  }));

  // Cập nhật 1 đơn (trạng thái, nhân viên, hoặc sửa thông tin)
  app.post('/thailand/api/order/update', thaiAuth, express.json(), wrap(async (req, res) => {
    const { id, field, value } = req.body || {};
    if (!id || !field) return res.json({ ok: false, message: 'Thiếu id hoặc field' });
    const allowed = ['trang_thai', 'nhan_vien', 'ho_ten', 'sdt', 'dia_chi', 'so_luong', 'gia_thb', 'ghi_chu', 'ngay_ve', 'ma_mau', 'ma_kh'];
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
      [b.ngay_ve || todayVN(), b.ho_ten || '', b.sdt || '', b.dia_chi || '',
       b.combo || '', b.so_luong || soLuong, b.gia_thb || gia, b.nhan_vien || '', b.trang_thai || 'Mới về']
    );
    res.json({ ok: true });
  }));

  // Xoá đơn
  app.post('/thailand/api/order/delete', thaiAuth, express.json(), wrap(async (req, res) => {
    const { isAdmin } = thaiWho(req);
    if (!isAdmin) return res.status(403).json({ ok: false, message: 'Chỉ quản trị viên mới được xoá đơn' });
    const { id } = req.body || {};
    if (!id) return res.json({ ok: false, message: 'Thiếu id' });
    const p = await db();
    await p.query(`DELETE FROM th_orders WHERE id = ?`, [id]);
    res.json({ ok: true });
  }));

  // Ngày hôm nay theo giờ Việt Nam (UTC+7), dạng YYYY-MM-DD
  function todayVN() {
    return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // ====================== ĐẨY ĐƠN SANG HẬU CẦN (tdffm.com) ======================
  function yyyymmdd(d) {
    const x = d || new Date();
    const vn = new Date(x.getTime() + 7 * 3600 * 1000);
    return vn.toISOString().slice(0, 10).replace(/-/g, '');
  }

  // Đẩy 1 hoặc nhiều đơn (theo danh sách id) sang hậu cần
  app.post('/thailand/api/push', thaiAuth, express.json(), wrap(async (req, res) => {
    const { isAdmin } = thaiWho(req);
    if (!isAdmin) return res.json({ ok: false, message: 'Chỉ quản trị viên mới được đẩy đơn sang hậu cần' });
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
      '*Tên khách hàng ': o.ho_ten || '',
      '*SĐT khách hàng ': o.sdt || '',
      '*Địa chỉ giao hàng ': o.dia_chi || '',
      '*Tiền COD': Number(o.gia_thb) || 0,
      '*Mã mẫu mã': o.ma_mau || TDFFM_MA_MAU,
      '*Số lượng ': Number(o.so_luong) || 0,
      '*Cần sale bán hàng': 'NEED_SALE',
      'Ghi chú': '',
      'Hình thức thanh toán': 'COD',
      'Tiền cọc từ khách ': '',
      'Tỉnh thành': '',
      'Quận huyện': '',
      'Phường xã': '',
      'Mã bưu chính': '',
      'Sale khách hàng': '',
      'Nguồn data': '',
      'Marketing': o.nhan_vien || '',
      'Sale chốt đơn': '',
      '': '',
    }));

    const payloadObj = { createDate: yyyymmdd(), exportData };
    // Ghi log payload để chẩn đoán (xem qua /thailand/api/push-log)
    try {
      const logFile = (process.env.DATA_DIR || '.') + '/thailand-push.log';
      fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), sent: payloadObj }) + '\n');
    } catch (e) {}

    let result, rawResp = '';
    try {
      const resp = await fetch(TDFFM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-public-key': TDFFM_KEY },
        body: JSON.stringify(payloadObj),
      });
      rawResp = await resp.text();
      try { result = JSON.parse(rawResp); } catch { result = {}; }
      // Ghi cả phản hồi
      try {
        const logFile = (process.env.DATA_DIR || '.') + '/thailand-push.log';
        fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), response: rawResp }) + '\n');
      } catch (e) {}
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

  // Xem log đẩy đơn (admin) — chẩn đoán payload gửi đi + phản hồi
  app.get('/thailand/api/push-log', thaiAuth, (req, res) => {
    try {
      const logFile = (process.env.DATA_DIR || '.') + '/thailand-push.log';
      const data = fs.readFileSync(logFile, 'utf8');
      const lines = data.trim().split('\n').slice(-6).map(l => { try { return JSON.parse(l); } catch { return l; } });
      res.json({ ok: true, logs: lines });
    } catch (e) {
      res.json({ ok: true, logs: [], message: 'Chưa có log' });
    }
  });

  // Thống kê doanh thu theo nhân viên
  app.get('/thailand/api/stats', thaiAuth, wrap(async (req, res) => {
    const p = await db();
    const { isAdmin, myName } = thaiWho(req);
    const { tu, den } = req.query;
    const where = [], args = [];
    if (tu) { where.push('ngay_ve >= ?'); args.push(tu); }
    if (den) { where.push('ngay_ve <= ?'); args.push(den); }
    // Nhân viên: chỉ thống kê đơn của mình
    if (!isAdmin) { where.push('nhan_vien = ?'); args.push(myName || '\u0000'); }
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

  // ====== Đếm số đơn Thái Lan theo nhân viên (cho trang Marketing chính server.js gọi) ======
  // Đếm tất cả đơn phát sinh trong kỳ, chỉ trừ đơn Huỷ.
  async function countThaiOrdersByEmployee(since, until) {
    const p = await db();
    const [rows] = await p.query(
      `SELECT nhan_vien, COUNT(*) AS so_don
       FROM th_orders
       WHERE ngay_ve >= ? AND ngay_ve <= ?
         AND trang_thai NOT IN ('Huỷ','CANCEL')
       GROUP BY nhan_vien`,
      [since, until]
    );
    const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
    const out = {};
    for (const r of rows) {
      const key = norm(r.nhan_vien || '');
      if (!key) continue;
      out[key] = (out[key] || 0) + (Number(r.so_don) || 0);
    }
    return out;
  }
  if (typeof exposeCounter === 'function') {
    exposeCounter(countThaiOrdersByEmployee);
  }

  // ====== MARKETING THÁI LAN: chi tiêu QC (chiến dịch có "Thái Lan") + số đơn/doanh thu từ th_orders ======
  app.get('/thailand/api/mkt-report', thaiAuth, wrap(async (req, res) => {
    const { isAdmin, myName } = thaiWho(req);
    const today = todayVN();
    const since = req.query.since || today;
    const until = req.query.until || since;
    const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

    // (A) Chi tiêu QC Meta — lọc chiến dịch có chữ "thái lan" / "thailand" trong tên
    const spend = {}; // { tênNV: tổng chi tiêu }
    try {
      if (typeof getCampaigns === 'function') {
        const campaigns = await getCampaigns(since, until);
        for (const c of campaigns) {
          const ten = norm(c.name);
          if (!ten.includes('thái lan') && !ten.includes('thai lan') && !ten.includes('thailand')) continue;
          const emp = c.employee || '';
          if (!emp || norm(emp) === 'chưa xác định') continue;
          const s = (c.daily || []).reduce((t, d) => t + (Number(d.spent) || 0), 0);
          spend[emp] = (spend[emp] || 0) + s;
        }
      }
    } catch (e) {}
    const TAX = 1 + (typeof QC_TAX === 'number' ? QC_TAX : 0.11);

    // (B) Số đơn + doanh thu từ th_orders, gom theo nhân viên (trong khoảng ngày)
    const p = await db();
    const [orderRows] = await p.query(`
      SELECT nhan_vien,
        COUNT(*) AS so_don,
        SUM(so_luong) AS tong_sl,
        SUM(gia_thb) AS doanh_thu
      FROM th_orders
      WHERE ngay_ve >= ? AND ngay_ve <= ?
        AND trang_thai NOT IN ('Huỷ','CANCEL')
      GROUP BY nhan_vien`, [since, until]);

    // Gộp 2 nguồn theo tên nhân viên
    const map = {}; // tênNV -> dòng
    function ensure(name) {
      const key = norm(name);
      if (!map[key]) map[key] = { name: name || '(không tên)', chiTieu: 0, soDon: 0, doanhThu: 0, tongSL: 0 };
      return map[key];
    }
    for (const [emp, sp] of Object.entries(spend)) {
      ensure(emp).chiTieu += Math.round(sp * TAX);
    }
    for (const r of orderRows) {
      const row = ensure(r.nhan_vien || '');
      row.soDon += Number(r.so_don) || 0;
      row.doanhThu += Number(r.doanh_thu) || 0;
      row.tongSL += Number(r.tong_sl) || 0;
    }

    let rows = Object.values(map);
    // Lọc theo quyền: nhân viên chỉ thấy mình
    if (!isAdmin) rows = rows.filter(r => norm(r.name) === norm(myName));

    // Tính giá đơn (chi tiêu / số đơn) cho mỗi người
    rows.forEach(r => { r.giaDon = r.soDon > 0 ? Math.round(r.chiTieu / r.soDon) : 0; });
    rows.sort((a, b) => (b.doanhThu || 0) - (a.doanhThu || 0));

    // Tổng
    const total = rows.reduce((a, r) => ({
      chiTieu: a.chiTieu + r.chiTieu, soDon: a.soDon + r.soDon,
      doanhThu: a.doanhThu + r.doanhThu, tongSL: a.tongSL + r.tongSL,
    }), { chiTieu: 0, soDon: 0, doanhThu: 0, tongSL: 0 });
    total.giaDon = total.soDon > 0 ? Math.round(total.chiTieu / total.soDon) : 0;

    res.json({ ok: true, since, until, rows, total, isAdmin, lastUpdated: new Date().toISOString() });
  }));

  // Xuất CSV
  app.get('/thailand/api/export', thaiAuth, wrap(async (req, res) => {
    const { isAdmin } = thaiWho(req);
    // Chỉ admin được xuất CSV
    if (!isAdmin) return res.status(403).send('Chỉ quản trị viên mới được xuất CSV');
    const p = await db();
    const [rows] = await p.query(`SELECT * FROM th_orders ORDER BY id DESC LIMIT 10000`);
    const head = ['ID', 'Ngày về', 'Họ tên', 'SĐT', 'Địa chỉ', 'Combo', 'Số lượng', 'Giá THB', 'Nhân viên', 'Trạng thái', 'Ghi chú'];
    // Dùng dấu chấm phẩy (;) — Excel tiếng Việt tự tách thành từng cột
    const SEP = ';';
    const esc = v => {
      let s = String(v == null ? '' : v);
      // SĐT giữ nguyên dạng text (tránh Excel cắt số 0 đầu) bằng cách bọc nháy
      s = s.replace(/"/g, '""');
      return '"' + s + '"';
    };
    let csv = '\uFEFF' + head.map(esc).join(SEP) + '\n';
    for (const r of rows) {
      csv += [r.id, (r.ngay_ve||'').toString().slice(0,10), r.ho_ten, r.sdt, r.dia_chi, r.combo, r.so_luong, r.gia_thb, r.nhan_vien, r.trang_thai, r.ghi_chu].map(esc).join(SEP) + '\n';
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="don-thailand.csv"');
    res.send(csv);
  }));

  // ====================== THỐNG KÊ LƯƠNG THÁI LAN ======================
  // GET /thailand/api/salary-report?month=2026-06
  // Trả: danh sách NV với đơn giao thành công, doanh thu THB, số đơn, số SP, giá vốn, ngân sách QC
  app.get('/thailand/api/salary-report', thaiAuth, wrap(async (req, res) => {
    const { isAdmin } = thaiWho(req);
    if (!isAdmin) return res.status(403).json({ ok: false, message: 'Chỉ admin' });
    const month = req.query.month || todayVN().slice(0, 7);
    const since = month + '-01';
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const until = month + '-' + String(lastDay).padStart(2, '0');

    const p = await db();

    // Song song: lấy đơn + giá vốn Sheet + ngân sách Meta
    const [ordersResult, owners, campaigns] = await Promise.all([
      p.query(
        `SELECT id, nhan_vien, gia_thb, so_luong, combo, trang_thai, ma_mau
         FROM th_orders
         WHERE ngay_ve >= ? AND ngay_ve <= ?
           AND trang_thai IN ('Giao thành công', 'Thành công', 'Hoàn tất')
         ORDER BY nhan_vien`, [since, until]),
      (async () => { try { return typeof loadOwners === 'function' ? await loadOwners(true) : {}; } catch { return {}; } })(),
      (async () => { try { return typeof getCampaigns === 'function' ? await getCampaigns(since, until) : []; } catch { return []; } })(),
    ]);
    const orders = ordersResult[0];

    // ── Ngân sách Meta: lọc campaign chứa "thailan" hoặc "thái lan", gom theo NV ──
    const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
    const TAX = 1 + (QC_TAX || 0.11);
    const adSpend = {};
    for (const c of campaigns) {
      const cName = norm(c.name || '');
      if (!cName.includes('thailan')) continue; // chỉ lọc chiến dịch có từ "thailan"
      const emp = norm(typeof detectEmployee === 'function' ? detectEmployee(c.name) : (c.employee || ''));
      if (!emp || emp === 'chưa xác định') continue;
      const s = (c.daily || []).reduce((t, d) => t + (Number(d.spent) || 0), 0);
      adSpend[emp] = (adSpend[emp] || 0) + s;
    }

    // ── Build bảng tra mã SP → product từ Sheet (maSPThai → owner entry) ──
    const codeToOwner = {};
    for (const [ownerKey, own] of Object.entries(owners)) {
      if (own.maSPThai) codeToOwner[own.maSPThai] = { ...own, normKey: ownerKey };
    }

    // ── Gom theo nhân viên ──
    const map = {};
    for (const o of orders) {
      const key = norm(o.nhan_vien || '(không tên)');
      if (!map[key]) map[key] = { name: o.nhan_vien || '(không tên)', doanhThuThb: 0, soDon: 0, soSP: 0, products: {} };
      map[key].doanhThuThb += Number(o.gia_thb) || 0;
      map[key].soDon += 1;
      const qty = Number(o.so_luong) || 0;
      map[key].soSP += qty;

      // Tên SP: dùng ma_mau (mã mẫu, VD THA284-GEL) → tra sản phẩm trong Sheet
      // Nếu ma_mau trống → dùng mã mặc định TDFFM_MA_MAU
      const rawMau = String(o.ma_mau || '').trim() || TDFFM_MA_MAU;
      const codes = rawMau.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      let spName = '';
      let spOwner = null;
      if (codes.length) {
        const code = codes[0];
        spOwner = codeToOwner[code] || null;
        spName = spOwner ? spOwner.productRaw : code;
      }
      if (spName) {
        const spKey = norm(spName);
        if (!map[key].products[spKey]) map[key].products[spKey] = { name: spName, soLuong: 0, giaThai: spOwner ? (spOwner.giaThai || 0) : 0 };
        map[key].products[spKey].soLuong += qty;
      }
    }

    // ── Tính giá vốn từ Sheet (Giá Thái × số lượng) ──
    const rows = Object.values(map).sort((a, b) => b.doanhThuThb - a.doanhThuThb);
    for (const r of rows) {
      let giaVonThb = 0;
      const prodList = [];
      for (const [spKey, prod] of Object.entries(r.products)) {
        const gia = prod.giaThai || 0;
        prod.giaVon = gia * prod.soLuong;
        giaVonThb += prod.giaVon;
        prodList.push({ name: prod.name, soLuong: prod.soLuong, giaThai: gia, giaVon: prod.giaVon });
      }
      r.giaVonThb = giaVonThb;
      r.productDetails = prodList;
      delete r.products;

      // Gắn ngân sách QC
      // adSpend key = tên đầy đủ từ detectEmployee (VD "tạ quang trường")
      // empNorm = tên từ đơn hàng, có thể ngắn (VD "trường") hoặc đầy đủ
      const empNorm = norm(r.name);
      let spend = adSpend[empNorm] || 0;
      if (!spend) {
        for (const [adKey, val] of Object.entries(adSpend)) {
          if (adKey && (adKey.includes(empNorm) || empNorm.includes(adKey))) { spend = val; break; }
        }
      }
      r.nganSach = Math.round(spend * TAX);
    }

    const total = rows.reduce((a, r) => ({
      doanhThuThb: a.doanhThuThb + r.doanhThuThb,
      soDon: a.soDon + r.soDon,
      soSP: a.soSP + r.soSP,
      giaVonThb: a.giaVonThb + r.giaVonThb,
      nganSach: a.nganSach + r.nganSach,
    }), { doanhThuThb: 0, soDon: 0, soSP: 0, giaVonThb: 0, nganSach: 0 });

    res.json({ ok: true, month, since, until, rows, total, lastUpdated: new Date().toISOString() });
  }));

  // GET /thailand/api/salary-report?month=... — force reload Sheet
  // (đã có ở trên, sửa loadOwners(true) để lấy data mới nhất từ Sheet)

  // POST /thailand/api/salary-sync — đồng bộ DT + GV Thái vào bảng lương Marketing
  app.post('/thailand/api/salary-sync', thaiAuth, express.json(), wrap(async (req, res) => {
    const { isAdmin } = thaiWho(req);
    if (!isAdmin) return res.status(403).json({ ok: false });
    const { month, rows, rate } = req.body || {};
    if (!month || !Array.isArray(rows)) return res.json({ ok: false, message: 'Thiếu dữ liệu' });

    // Ghi vào SALARY_MANUAL[month][employee].channels.thailan
    const SALARY_MANUAL = global.__SALARY_MANUAL;
    if (!SALARY_MANUAL) return res.json({ ok: false, message: 'Chưa khởi tạo SALARY_MANUAL' });
    if (!SALARY_MANUAL[month]) SALARY_MANUAL[month] = {};
    const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
    let count = 0;
    for (const r of rows) {
      const key = norm(r.name);
      if (!key) continue;
      if (!SALARY_MANUAL[month][key]) SALARY_MANUAL[month][key] = { name: r.name, channels: {}, luongCung: 0, thuong: 0, phat: 0, bhxh: 0 };
      if (!SALARY_MANUAL[month][key].channels) SALARY_MANUAL[month][key].channels = {};
      SALARY_MANUAL[month][key].channels.thailan = {
        dt: Math.round(r.dtVnd || 0),
        qc: 0,
        gv: Math.round(r.gvVnd || 0),
        ship: 0,
      };
      count++;
    }
    // Lưu file
    if (typeof global.__saveManual === 'function') global.__saveManual();
    res.json({ ok: true, month, count, message: `Đã đồng bộ ${count} nhân viên vào lương Marketing` });
  }));

  // POST /thailand/api/salary-publish — công khai để nhân viên xem
  app.post('/thailand/api/salary-publish', thaiAuth, express.json(), wrap(async (req, res) => {
    const { isAdmin } = thaiWho(req);
    if (!isAdmin) return res.status(403).json({ ok: false });
    const { month, rows } = req.body || {};
    if (!month || !Array.isArray(rows)) return res.json({ ok: false, message: 'Thiếu dữ liệu' });
    // Lưu vào file published-thai-salary.json trong DATA_DIR
    const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
    const filePath = path.join(DATA_DIR, 'published-thai-salary.json');
    let published = {};
    try { published = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
    published[month] = { rows, publishedAt: new Date().toISOString() };
    try { fs.writeFileSync(filePath, JSON.stringify(published)); } catch {}
    res.json({ ok: true, month, count: rows.length, message: `Đã công khai lương Thái tháng ${month}` });
  }));

  // GET /thailand/api/my-thai-salary?month=... — nhân viên xem lương Thái của mình
  app.get('/thailand/api/my-thai-salary', thaiAuth, wrap(async (req, res) => {
    const month = req.query.month;
    if (!month) return res.json({ ok: false, message: 'Thiếu tháng' });
    const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
    const filePath = path.join(DATA_DIR, 'published-thai-salary.json');
    let published = {};
    try { published = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
    const data = published[month];
    if (!data) return res.json({ ok: false, message: 'Chưa công khai tháng này' });
    // Lọc: nhân viên chỉ thấy dòng của mình
    const { isAdmin } = thaiWho(req);
    const me = req.session.user || {};
    const myName = (me.salaryName || me.manager || (me.employees && me.employees[0]) || '').trim().toLowerCase();
    const rows = isAdmin ? data.rows : data.rows.filter(r => (r.name || '').trim().toLowerCase() === myName);
    res.json({ ok: true, month, rows, publishedAt: data.publishedAt });
  }));

  // GET /thailand/api/published-months — danh sách tháng đã công khai
  app.get('/thailand/api/published-months', thaiAuth, wrap(async (req, res) => {
    const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
    const filePath = path.join(DATA_DIR, 'published-thai-salary.json');
    let published = {};
    try { published = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
    res.json({ ok: true, months: Object.keys(published).sort().reverse() });
  }));

  // Trang lương Thái Lan (HTML) — admin xem đầy đủ, nhân viên xem hạn chế
  app.get('/thailand/salary', thaiAuth, (req, res) => {
    const { isAdmin } = thaiWho(req);
    res.type('html').send(salaryThailandHtml(isAdmin));
  });

  // ====================== TRANG QUẢN LÝ (HTML) ======================
  app.get('/thailand', thaiAuth, (req, res) => {
    res.type('html').send(pageHtml());
  });

  // ====================== ĐỒNG BỘ TRẠNG THÁI TỪ HẬU CẦN (TDFFM) ======================
  // Import crypto để tạo HMAC signature
  let cryptoMod = null;
  async function getCrypto() {
    if (!cryptoMod) cryptoMod = await import('node:crypto');
    return cryptoMod;
  }

  // ===== ĐĂNG NHẬP NỘI BỘ TDFFM (lấy cookie/token để gọi API web) =====
  // Lưu phiên đăng nhập trong bộ nhớ, tự đăng nhập lại khi hết hạn
  let tdffmSession = { cookie: '', token: '', at: 0 };

  async function tdffmLogin() {
    const resp = await fetch(`${TDFFM_INTERNAL_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ email: TDFFM_USER, password: TDFFM_PASSWORD }),
    });
    // Đọc Set-Cookie (Node 18+ fetch: getSetCookie)
    let cookie = '';
    try {
      const sc = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
      cookie = sc.map(c => c.split(';')[0]).join('; ');
    } catch (e) {}
    let body = {};
    try { body = await resp.json(); } catch (e) {}
    // Tìm token trong body (phòng trường hợp dùng bearer thay vì cookie)
    const token = (body && (body.accessToken || (body.data && (body.data.accessToken || body.data.token)) || body.token)) || '';
    tdffmSession = { cookie, token, at: Date.now() };
    const ok = resp.status >= 200 && resp.status < 400 && (!!cookie || !!token);
    if (!ok) console.log('[thailand-sync] Login TDFFM thất bại:', resp.status, JSON.stringify(body).slice(0, 200));
    return { ok, status: resp.status };
  }

  // Đảm bảo có phiên đăng nhập hợp lệ (đăng nhập lại nếu quá 30 phút)
  async function tdffmEnsureAuth() {
    const expired = Date.now() - tdffmSession.at > 30 * 60 * 1000;
    if ((!tdffmSession.cookie && !tdffmSession.token) || expired) {
      await tdffmLogin();
    }
  }

  // Gọi POST orders/list (API nội bộ, xác thực bằng cookie/token)
  async function tdffmListOrders(page, limit, extraFilters) {
    await tdffmEnsureAuth();
    const headers = { 'content-type': 'application/json', 'accept': 'application/json' };
    if (tdffmSession.cookie) headers['Cookie'] = tdffmSession.cookie;
    if (tdffmSession.token) headers['Authorization'] = 'Bearer ' + tdffmSession.token;
    const filters = { customerCode: TDFFM_MA_KH, country: 'THAILAND', ...(extraFilters || {}) };
    const doFetch = () => fetch(`${TDFFM_INTERNAL_BASE}/orders/list`, {
      method: 'POST', headers,
      body: JSON.stringify({ page, limit, filters }),
    });
    let resp = await doFetch();
    // Nếu 401/403 (phiên hết hạn) → đăng nhập lại 1 lần rồi thử lại
    if (resp.status === 401 || resp.status === 403) {
      await tdffmLogin();
      if (tdffmSession.cookie) headers['Cookie'] = tdffmSession.cookie;
      if (tdffmSession.token) headers['Authorization'] = 'Bearer ' + tdffmSession.token;
      resp = await doFetch();
    }
    return resp.json();
  }

  // Map trạng thái TDFFM (tiếng Anh) → nhãn tiếng Việt
  // orderStatus = trạng thái kho; shippingOrderStatus = trạng thái giao hàng
  const TDFFM_STATUS_MAP = {
    DRAFT: 'Chưa xử lý',
    SALE_CONFIRM: 'Sale xác nhận',
    WAITING_GOODS: 'Chờ hàng',
    IS_BEING_PROCESSED: 'Đang xử lý',
    PACKAGED: 'Đã đóng gói',
    HAVE_ISSUE: 'Có vấn đề',
    REJECT: 'Từ chối',
    CANCEL: 'Huỷ',
    SHIPPING: 'Đang giao',
    DELIVERED: 'Đã giao',
    DELIVERED_SUCCESS: 'Giao thành công',
    RETURNING: 'Đang hoàn',
    RETURNED: 'Hoàn hàng',
    COMPLETED: 'Hoàn tất',
  };
  const SHIPPING_STATUS_MAP = {
    SUCCESS: 'Giao thành công',
    RETURNED: 'Đã hoàn',
    RETURNING: 'Đang hoàn',
    SHIPPING: 'Đang giao',
    DELIVERED: 'Đã giao',
    FAILED: 'Giao thất bại',
  };
  function mapTdffmStatus(orderStatus, shippingOrderStatus) {
    // Ưu tiên shippingOrderStatus nếu có (trạng thái giao hàng chính xác hơn)
    if (shippingOrderStatus && SHIPPING_STATUS_MAP[shippingOrderStatus]) {
      return SHIPPING_STATUS_MAP[shippingOrderStatus];
    }
    return TDFFM_STATUS_MAP[orderStatus] || orderStatus || '';
  }

  // Log sync (lưu file để xem sau)
  const SYNC_LOG_FILE = (process.env.DATA_DIR || '.') + '/thailand-sync.log';
  let lastSyncResult = null;

  function writeSyncLog(entry) {
    try { fs.appendFileSync(SYNC_LOG_FILE, JSON.stringify(entry) + '\n'); } catch (e) {}
  }

  // Chuẩn hoá SĐT: bỏ prefix +66 (Thái) hoặc +84 (VN), chỉ giữ số
  function normPhone(s) {
    let p = String(s || '').replace(/\D/g, '');
    if (p.startsWith('66') && p.length >= 10) p = p.slice(2);
    if (p.startsWith('84') && p.length >= 11) p = p.slice(2);
    if (p.startsWith('0')) p = p.slice(1);
    return p;
  }

  // Hàm đồng bộ chính: lấy đơn từ TDFFM, match SĐT, cập nhật trang_thai
  async function syncFromTdffm() {
    if (!TDFFM_USER || !TDFFM_PASSWORD) {
      const msg = 'Bỏ qua sync: chưa cấu hình TDFFM_USER / TDFFM_PASSWORD';
      console.log('[thailand-sync]', msg);
      lastSyncResult = { ok: false, message: msg, at: new Date().toISOString() };
      return;
    }
    const startAt = new Date().toISOString();
    console.log('[thailand-sync] Bắt đầu đồng bộ trạng thái từ TDFFM...');

    try {
      const p = await db();

      // Lấy đơn từ TDFFM qua API nội bộ orders/list (phân trang)
      // Đơn sắp xếp mới nhất trước → lọc giữ đơn tạo >= TDFFM_SYNC_FROM, dừng sớm khi gặp đơn cũ hơn
      // Chỉ đồng bộ đơn 2 tháng gần nhất (tránh đọc lại toàn bộ khi data lớn)
      const syncFrom = new Date();
      syncFrom.setMonth(syncFrom.getMonth() - 2);
      syncFrom.setDate(1);
      const fromTime = syncFrom.getTime();
      const fromStr = syncFrom.toISOString().slice(0, 10);
      const allTdffmOrders = [];
      let page = 1;
      const LIMIT = 100;
      let stop = false;
      while (page <= 50 && !stop) {
        const data = await tdffmListOrders(page, LIMIT);
        const inner = data && data.data ? data.data : null;
        const orders = inner && Array.isArray(inner.data) ? inner.data : [];
        if (page === 1) {
          console.log('[thailand-sync] TDFFM orders/list: total =', inner ? inner.total : '?',
            ', lọc từ', fromStr);
        }
        for (const o of orders) {
          const t = new Date(o.createdAt).getTime();
          if (isNaN(t) || t >= fromTime) {
            allTdffmOrders.push(o);
          } else {
            stop = true;
          }
        }
        if (!inner || !inner.hasNextPage || orders.length === 0) break;
        page++;
      }

      if (!allTdffmOrders.length) {
        const msg = 'TDFFM trả về 0 đơn (kiểm tra email/mật khẩu đăng nhập)';
        console.log('[thailand-sync]', msg);
        lastSyncResult = { ok: false, message: msg, at: startAt, finishedAt: new Date().toISOString() };
        writeSyncLog(lastSyncResult);
        return;
      }

      // Build map: normPhone → mảng tất cả đơn (để match chính xác theo uid hoặc ngày)
      const tdffmByUid = new Map();   // uid → { status, rawStatus, phone, createdAt }
      const tdffmByPhone = new Map(); // phone → [{ uid, status, rawStatus, createdAt }]
      for (const o of allTdffmOrders) {
        const phone = normPhone(o.buyerPhone || '');
        // Lấy mã SP từ TDFFM products array (ví dụ: "THA284-GEL")
        let maSP = '';
        if (Array.isArray(o.products) && o.products.length) {
          maSP = o.products.map(p => p.code || p.productCode || p.sku || '').filter(Boolean).join(',');
        }
        const entry = {
          uid: o.orderUID || '', status: mapTdffmStatus(o.orderStatus, o.shippingOrderStatus),
          rawStatus: o.orderStatus, rawShippingStatus: o.shippingOrderStatus || '',
          createdAt: o.createdAt || '', phone, maSP,
        };
        if (entry.uid) tdffmByUid.set(entry.uid, entry);
        if (phone) {
          if (!tdffmByPhone.has(phone)) tdffmByPhone.set(phone, []);
          tdffmByPhone.get(phone).push(entry);
        }
      }

      // Chỉ lấy đơn CHƯA hoàn tất — đơn đã "Giao thành công" / "Đã hoàn" không cần sync lại
      const FINAL_STATUSES = ['Giao thành công', 'Đã hoàn', 'Hoàn tất', 'Thành công'];
      const placeholders = FINAL_STATUSES.map(() => '?').join(',');
      const [dbOrders] = await p.query(
        `SELECT id, sdt, trang_thai, tdffm_uid, ngay_ve, ma_sp FROM th_orders
         WHERE sdt IS NOT NULL AND sdt <> ''
         AND trang_thai NOT IN (${placeholders})`,
        FINAL_STATUSES
      );

      let updated = 0, notFound = 0;
      const now = new Date();

      for (const row of dbOrders) {
        let match = null;

        // Ưu tiên 1: match bằng tdffm_uid (chính xác nhất)
        if (row.tdffm_uid && tdffmByUid.has(row.tdffm_uid)) {
          match = tdffmByUid.get(row.tdffm_uid);
        } else {
          // Ưu tiên 2: match bằng SĐT + ngày gần nhất
          const phone = normPhone(row.sdt || '');
          if (!phone) { notFound++; continue; }
          const candidates = tdffmByPhone.get(phone);
          if (!candidates || !candidates.length) { notFound++; continue; }

          if (candidates.length === 1) {
            // Chỉ có 1 đơn cho SĐT này → dùng luôn
            match = candidates[0];
          } else {
            // Nhiều đơn cùng SĐT → chọn đơn có ngày tạo gần nhất với ngay_ve
            const dbDate = new Date(row.ngay_ve).getTime();
            let bestDist = Infinity;
            for (const c of candidates) {
              const cDate = new Date(c.createdAt).getTime();
              const dist = Math.abs(cDate - dbDate);
              if (dist < bestDist) { bestDist = dist; match = c; }
            }
          }
        }

        if (!match || !match.status) { notFound++; continue; }

        if (match.status !== row.trang_thai) {
          await p.query(
            `UPDATE th_orders SET trang_thai = ?, tdffm_uid = ?, tdffm_sync_at = ?, ma_sp = COALESCE(NULLIF(?, ''), ma_sp) WHERE id = ?`,
            [match.status, match.uid || '', now, match.maSP || '', row.id]
          );
          updated++;
        } else if (!row.tdffm_uid && match.uid) {
          // Lưu uid + mã SP nếu chưa có
          await p.query(
            `UPDATE th_orders SET tdffm_uid = ?, tdffm_sync_at = ?, ma_sp = COALESCE(NULLIF(?, ''), ma_sp) WHERE id = ?`,
            [match.uid, now, match.maSP || '', row.id]
          );
        } else if (match.maSP && !row.ma_sp) {
          // Chỉ cập nhật mã SP nếu chưa có
          await p.query(`UPDATE th_orders SET ma_sp = ? WHERE id = ? AND (ma_sp = '' OR ma_sp IS NULL)`, [match.maSP, row.id]);
        }
      }

      // (Các nhãn trạng thái đã được khai báo cố định trong TRANG_THAI nên không cần thêm động)

      // Debug: thống kê trạng thái TDFFM thực tế + trạng thái DB hiện tại
      const tdffmStatusCount = {};
      const tdffmShippingCount = {};
      for (const o of allTdffmOrders) {
        const s = o.orderStatus || '(trống)';
        tdffmStatusCount[s] = (tdffmStatusCount[s] || 0) + 1;
        const ss = o.shippingOrderStatus || '(trống)';
        tdffmShippingCount[ss] = (tdffmShippingCount[ss] || 0) + 1;
      }
      const dbStatusCount = {};
      for (const row of dbOrders) {
        const s = row.trang_thai || '(trống)';
        dbStatusCount[s] = (dbStatusCount[s] || 0) + 1;
      }
      // Lấy 1 đơn PACKAGED mẫu: liệt kê TẤT CẢ field để xem có field giao hàng khác không
      const sampleOrder = allTdffmOrders.find(o => o.orderStatus === 'PACKAGED');
      const sampleFields = sampleOrder ? Object.keys(sampleOrder) : [];
      // Lấy mẫu products array để biết field name
      const sampleProducts = sampleOrder && Array.isArray(sampleOrder.products) && sampleOrder.products.length
        ? sampleOrder.products.slice(0, 2).map(p => {
            const out = {}; for (const [k,v] of Object.entries(p)) { if (typeof v !== 'object' || v === null) out[k] = v; } return out;
          })
        : [];
      // Lấy các giá trị có chứa từ "deliver/ship/status/complete/success" trong tên field
      const sampleDeliveryHints = {};
      if (sampleOrder) {
        for (const [k, v] of Object.entries(sampleOrder)) {
          if (/deliv|ship|status|complet|success|track|giao|hoan/i.test(k) || /deliv|ship|complet|success/i.test(String(v))) {
            sampleDeliveryHints[k] = v;
          }
        }
      }

      const result = {
        ok: true, at: startAt, finishedAt: new Date().toISOString(),
        tdffmOrders: allTdffmOrders.length, dbOrders: dbOrders.length,
        updated, notFound,
        tdffmStatusCount, tdffmShippingCount, dbStatusCount,
        sampleFields, sampleDeliveryHints, sampleProducts,
        message: `Đồng bộ thành công: ${updated} đơn cập nhật trạng thái`,
      };
      lastSyncResult = result;
      writeSyncLog(result);
      console.log('[thailand-sync]', result.message,
        `(${allTdffmOrders.length} đơn từ TDFFM, ${dbOrders.length} đơn DB cần check)`);
    } catch (e) {
      const result = { ok: false, at: startAt, finishedAt: new Date().toISOString(), message: 'Lỗi: ' + e.message };
      lastSyncResult = result;
      writeSyncLog(result);
      console.error('[thailand-sync] Lỗi đồng bộ:', e.message);
    }
  }

  // ---- CRON: chạy mỗi ngày lúc 6:00 sáng giờ VN (UTC+7 = 23:00 UTC) ----
  function scheduleDailySync() {
    function msToNext6amVN() {
      const now = new Date();
      // Tính thời điểm 23:00 UTC hôm nay (= 06:00 VN)
      const next = new Date(now);
      next.setUTCHours(23, 0, 0, 0);
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      return next.getTime() - now.getTime();
    }
    function loop() {
      const ms = msToNext6amVN();
      console.log(`[thailand-sync] Sync tiếp theo sau ${(ms/3600000).toFixed(1)} giờ (6:00 VN)`);
      setTimeout(() => { syncFromTdffm().finally(() => loop()); }, ms);
    }
    loop();
  }
  scheduleDailySync();

  // ---- Route xem trạng thái sync (admin) ----
  app.get('/thailand/api/sync-status', thaiAuth, wrap(async (req, res) => {
    const { isAdmin } = thaiWho(req);
    if (!isAdmin) return res.status(403).json({ ok: false, message: 'Chỉ admin' });
    let logs = [];
    try {
      const raw = fs.readFileSync(SYNC_LOG_FILE, 'utf8');
      logs = raw.trim().split('\n').slice(-5).map(l => { try { return JSON.parse(l); } catch { return l; } });
    } catch (e) {}
    res.json({ ok: true, last: lastSyncResult, logs });
  }));

  // ---- Route trigger sync thủ công ngay lập tức (admin) ----
  app.post('/thailand/api/sync-now', thaiAuth, express.json(), wrap(async (req, res) => {
    const { isAdmin } = thaiWho(req);
    if (!isAdmin) return res.status(403).json({ ok: false, message: 'Chỉ admin' });
    syncFromTdffm().catch(e => console.error('[thailand-sync] lỗi manual:', e.message));
    res.json({ ok: true, message: 'Đang đồng bộ, kiểm tra /thailand/api/sync-status sau vài giây' });
  }));

  console.log('[thailand] Đã gắn module quản lý đơn Thái Lan tại /thailand');
}

// ---- HTML trang lương Thái Lan ----
function salaryThailandHtml(isAdmin) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lương Thái Lan — TDMJSC</title>
<style>
*{box-sizing:border-box;}
body{margin:0;font-family:'Inter',system-ui,sans-serif;background:#0B1322;color:#E7EEF8;}
header{background:#10192B;border-bottom:1px solid rgba(255,255,255,.07);padding:14px 18px;}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
h1{font-size:17px;margin:0;white-space:nowrap;}
.sub{color:#9FB0C8;font-size:12px;margin:2px 0 0;font-weight:400;}
select.pick,input.pick{font-family:inherit;font-size:13px;color:#fff;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);padding:8px 10px;border-radius:9px;outline:none;color-scheme:dark;}
input.pick{width:110px;text-align:right;}
.link{color:#C4D0E2;font-size:13px;text-decoration:none;border:1px solid rgba(255,255,255,.14);padding:7px 12px;border-radius:9px;white-space:nowrap;}
.link:hover{background:rgba(255,255,255,.08);color:#fff;}
.btn{font-family:inherit;font-size:13px;font-weight:600;color:#fff;border:none;padding:8px 14px;border-radius:9px;cursor:pointer;white-space:nowrap;}
.btn:disabled{opacity:.5;cursor:not-allowed;}
.btn-sync{background:#0E8C76;} .btn-sync:hover{background:#0a7363;}
.btn-pub{background:#3D5AFE;} .btn-pub:hover{background:#2f49d6;}
label.cfg{font-size:12px;color:#9FB0C8;display:flex;align-items:center;gap:5px;white-space:nowrap;}
main{padding:18px;max-width:1400px;margin:0 auto;}
.status{font-size:13px;color:#9FB0C8;margin:4px 0 12px;min-height:18px;}
.status .err{color:#ff9b8a;} .status .ok{color:#7BE3B5;}
.wrap{overflow-x:auto;border-radius:12px;}
table{width:100%;border-collapse:collapse;background:#101B2E;border-radius:12px;overflow:hidden;min-width:800px;}
th,td{padding:10px 12px;text-align:left;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05);white-space:nowrap;}
th{background:#16233A;color:#9FB0C8;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em;}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;}
.l2{color:#7BE3B5;font-weight:700;}
.thuc{color:#ffc56b;font-weight:800;}
.neg{color:#ff9b8a;}
.qc{color:#9DB2FF;}
.muted{color:#6B7C97;}
.empty{padding:40px;text-align:center;color:#6B7C97;}
.total-row td{background:#16233A;font-weight:700;border-top:2px solid rgba(255,255,255,.12);}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;}
.card{background:#101B2E;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 18px;flex:1;min-width:140px;}
.card .lbl{font-size:11px;color:#9FB0C8;text-transform:uppercase;letter-spacing:.03em;}
.card .val{font-size:22px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums;}
.exp{cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#9FB0C8;width:22px;height:22px;border-radius:5px;font-size:13px;margin-right:6px;vertical-align:middle;}
.exp:hover{background:rgba(61,90,254,.2);color:#fff;}
.detail td{background:#0D1626;font-size:12px;}
.detail table{min-width:0;background:transparent;} .detail table td{border:none;padding:3px 8px;}
</style></head><body>
<header>
  <div class="top">
    <div style="flex:1;min-width:140px;">
      <h1>🇹🇭 ${isAdmin ? 'Lương Thái Lan' : 'Kết quả Thái Lan'}</h1>
      <p class="sub">Doanh thu đơn giao thành công</p>
    </div>
    <select class="pick" id="month"></select>
    <label class="cfg">Tỷ giá: <input class="pick" id="rate" type="text" value="780"></label>
    ${isAdmin ? '<label class="cfg">Phí HC %: <input class="pick" id="fee" type="text" value="15" style="width:60px;"></label>' : ''}
    ${isAdmin ? '<button class="btn btn-sync" id="syncBtn" onclick="doSync()">🔄 Đồng bộ lương MKT</button>' : ''}
    ${isAdmin ? '<button class="btn btn-pub" id="pubBtn" onclick="doPublish()">📤 Công khai</button>' : ''}
    <a href="/thailand" class="link">← Đơn hàng</a>
    <a href="/" class="link">Dashboard</a>
  </div>
</header>
<main>
  <div class="status" id="status">Đang tải…</div>
  <div class="cards" id="cards"></div>
  <div class="wrap"><div id="content"><div class="empty">Đang tải…</div></div></div>
</main>
<script>
var IS_ADMIN=${isAdmin ? 'true' : 'false'};
var $=function(id){return document.getElementById(id);};
var vnd=function(n){return Math.round(Number(n)||0).toLocaleString('vi-VN');};
var thb=function(n){return(Number(n)||0).toLocaleString('th-TH');};
var DATA=null, expanded={};

(function initMonths(){
  var sel=$('month'), now=new Date();
  for(var i=0;i<12;i++){
    var d=new Date(now.getFullYear(),now.getMonth()-i,1);
    var ym=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    sel.innerHTML+='<option value="'+ym+'">Tháng '+(d.getMonth()+1)+'/'+d.getFullYear()+'</option>';
  }
})();

function getRate(){return parseFloat($('rate').value)||0;}
function getFee(){var el=$('fee');return el?parseFloat(el.value)||0:15;}

function load(){
  expanded={};
  var month=$('month').value;
  $('status').innerHTML='Đang tải…';
  $('content').innerHTML='<div class="empty">Đang tải…</div>';
  if(IS_ADMIN){
    fetch('/thailand/api/salary-report?month='+month).then(function(r){return r.json();}).then(function(d){
      if(!d.ok){$('status').innerHTML='<span class="err">'+(d.message||'Lỗi')+'</span>';return;}
      DATA=d; render();
    }).catch(function(e){$('status').innerHTML='<span class="err">Lỗi: '+e.message+'</span>';});
  } else {
    fetch('/thailand/api/my-thai-salary?month='+month).then(function(r){return r.json();}).then(function(d){
      if(!d.ok){$('status').innerHTML='<span class="err">'+(d.message||'Chưa công khai')+'</span>';return;}
      DATA={rows:d.rows,total:null,month:d.month||month,lastUpdated:d.publishedAt};
      render();
    }).catch(function(e){$('status').innerHTML='<span class="err">Lỗi: '+e.message+'</span>';});
  }
}

function render(){
  if(!DATA||!DATA.rows||!DATA.rows.length){$('content').innerHTML='<div class="empty">Không có dữ liệu</div>';$('cards').innerHTML='';return;}
  var rate=getRate(), feePct=getFee()/100, rows=DATA.rows;

  // Cards
  if(IS_ADMIN&&DATA.total){
    var t=DATA.total;
    var dtThbNet=Math.round(t.doanhThuThb*(1-feePct));
    var dtVnd=Math.round(dtThbNet*rate);
    var gvVnd=t.giaVonThb||0;
    $('cards').innerHTML=
      '<div class="card"><div class="lbl">Thực thu THB (-'+getFee()+'%)</div><div class="val l2">'+thb(dtThbNet)+' ฿</div></div>'+
      '<div class="card"><div class="lbl">Doanh thu</div><div class="val thuc">'+vnd(dtVnd)+' ₫</div></div>'+
      '<div class="card"><div class="lbl">Giá vốn</div><div class="val neg">'+vnd(gvVnd)+' ₫</div></div>'+
      '<div class="card"><div class="lbl">Ngân sách QC</div><div class="val qc">'+vnd(t.nganSach||0)+' ₫</div></div>'+
      '<div class="card"><div class="lbl">Đơn / SP</div><div class="val">'+t.soDon+' · '+t.soSP+'</div></div>';
  } else { $('cards').innerHTML=''; }

  // Table
  var h='<table><thead><tr><th>Nhân viên</th><th class="num">Thực thu THB</th><th class="num">Doanh thu</th>';
  if(IS_ADMIN) h+='<th class="num">Giá vốn</th>';
  h+='<th class="num">Ngân sách QC</th><th class="num">Số đơn</th><th class="num">Số SP</th></tr></thead><tbody>';
  var totNet=0,totVnd=0,totGvVnd=0,totQC=0,totDon=0,totSP=0;
  for(var i=0;i<rows.length;i++){
    var r=rows[i];
    var dtGoc=r.doanhThuThb||0;
    var net=Math.round(dtGoc*(1-feePct));
    var vndd=Math.round(net*rate);
    var gvV=r.giaVonThb||0;
    var qc=r.nganSach||0;
    var hasProd=IS_ADMIN&&r.productDetails&&r.productDetails.length>0;
    var isOpen=expanded[i];
    totNet+=net; totVnd+=vndd; totGvVnd+=gvV; totQC+=qc; totDon+=(r.soDon||0); totSP+=(r.soSP||0);
    h+='<tr><td>'+(hasProd?'<button class="exp" onclick="tg('+i+')">'+(isOpen?'\\u2212':'+')+' </button>':'')+
      '<b>'+esc(r.name)+'</b></td>'+
      '<td class="num l2">'+thb(net)+' ฿</td>'+
      '<td class="num thuc">'+vnd(vndd)+' ₫</td>';
    if(IS_ADMIN) h+='<td class="num">'+(gvV?vnd(gvV)+' ₫':'–')+'</td>';
    h+='<td class="num qc">'+(qc?vnd(qc)+' ₫':'–')+'</td>'+
      '<td class="num">'+(r.soDon||0)+'</td><td class="num">'+(r.soSP||0)+'</td></tr>';
    if(isOpen&&hasProd){
      h+='<tr class="detail"><td colspan="'+(IS_ADMIN?7:6)+'"><div class="muted" style="font-size:11px;margin-bottom:4px;">Chi tiết sản phẩm:</div><table><tbody>';
      for(var j=0;j<r.productDetails.length;j++){
        var p=r.productDetails[j];
        var pGvV=p.giaVon||0;
        h+='<tr><td>'+esc(p.name)+'</td><td class="num muted">SL '+p.soLuong+'</td>'+
          '<td class="num muted">Giá Thái '+(p.giaThai?thb(p.giaThai)+' ฿':'chưa có')+'</td>'+
          '<td class="num">'+(pGvV?vnd(pGvV)+' ₫':'–')+'</td></tr>';
      }
      h+='</tbody></table></td></tr>';
    }
  }
  h+='<tr class="total-row"><td>Tổng ('+rows.length+')</td>'+
    '<td class="num l2">'+thb(totNet)+' ฿</td><td class="num thuc">'+vnd(totVnd)+' ₫</td>';
  if(IS_ADMIN) h+='<td class="num">'+vnd(totGvVnd)+' ₫</td>';
  h+='<td class="num qc">'+vnd(totQC)+' ₫</td><td class="num">'+totDon+'</td><td class="num">'+totSP+'</td></tr>';
  h+='</tbody></table>';
  $('content').innerHTML=h;
  $('status').innerHTML='<span class="ok">✓ Tháng '+(DATA.month||'')+' · '+(DATA.lastUpdated||'').replace('T',' ').slice(0,19)+'</span>';
}

function tg(i){expanded[i]=!expanded[i];render();}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}

function doSync(){
  if(!DATA||!DATA.rows)return alert('Chưa có dữ liệu');
  if(!confirm('Đồng bộ doanh thu + giá vốn Thái vào bảng lương Marketing tháng '+$('month').value+'?'))return;
  var rate=getRate(),feePct=getFee()/100;
  var rows=DATA.rows.map(function(r){
    var net=Math.round((r.doanhThuThb||0)*(1-feePct));
    return{name:r.name,dtVnd:Math.round(net*rate),gvVnd:r.giaVonThb||0};
  });
  $('syncBtn').disabled=true;$('syncBtn').textContent='Đang đồng bộ…';
  fetch('/thailand/api/salary-sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({month:$('month').value,rows:rows,rate:rate})})
    .then(function(r){return r.json();}).then(function(d){
      alert(d.ok?'✅ '+d.message:'❌ '+(d.message||'Lỗi'));
    }).catch(function(e){alert('❌ '+e.message);})
    .finally(function(){$('syncBtn').disabled=false;$('syncBtn').textContent='🔄 Đồng bộ lương MKT';});
}

function doPublish(){
  if(!DATA||!DATA.rows)return alert('Chưa có dữ liệu');
  if(!confirm('Công khai kết quả Thái Lan tháng '+$('month').value+' cho nhân viên xem?'))return;
  var feePct=getFee()/100;
  var rows=DATA.rows.map(function(r){
    var net=Math.round((r.doanhThuThb||0)*(1-feePct));
    return{name:r.name,doanhThuThb:r.doanhThuThb,thucThuThb:net,nganSach:r.nganSach||0,soDon:r.soDon||0,soSP:r.soSP||0};
  });
  $('pubBtn').disabled=true;$('pubBtn').textContent='Đang gửi…';
  fetch('/thailand/api/salary-publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({month:$('month').value,rows:rows})})
    .then(function(r){return r.json();}).then(function(d){
      alert(d.ok?'✅ '+d.message:'❌ '+(d.message||'Lỗi'));
    }).catch(function(e){alert('❌ '+e.message);})
    .finally(function(){$('pubBtn').disabled=false;$('pubBtn').textContent='📤 Công khai';});
}

$('month').addEventListener('change',load);
$('rate').addEventListener('input',render);
var feeEl=$('fee');if(feeEl)feeEl.addEventListener('input',render);
load();
</script></body></html>`;
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
.sync-badge{font-size:12px;padding:5px 10px;border-radius:7px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#9FB0C8;display:inline-flex;align-items:center;gap:6px;}
.sync-badge.ok{border-color:#7BE3B5;color:#7BE3B5;}.sync-badge.err{border-color:#ff9b8a;color:#ff9b8a;}
.sync-badge.loading{opacity:.7;}
#syncModal .row{display:flex;gap:10px;margin-bottom:10px;}
#syncLog{font-size:12px;color:#9FB0C8;margin-top:12px;max-height:200px;overflow-y:auto;}
#syncLog .log-row{padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.04);margin-bottom:4px;}
#syncLog .log-row.ok{border-left:3px solid #7BE3B5;}.log-row.err{border-left:3px solid #ff9b8a;}


/* Scroll ngang kép */
.wrap-outer{overflow-x:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y;overscroll-behavior-x:contain;border-radius:12px;}
.wrap-top-scroll{overflow-x:auto;overflow-y:hidden;height:16px;margin-bottom:3px;-webkit-overflow-scrolling:touch;}
.wrap-top-scroll>div{height:1px;background:transparent;}
.wrap{overflow-x:visible;overflow-y:visible;border-radius:0;}
table{width:100%;border-collapse:collapse;background:#101B2E;min-width:900px;}
</style></head>
<body>
<header>
  <h1>🇹🇭 Quản lý đơn Thái Lan</h1>
  <button class="btn g" id="addBtn">+ Thêm đơn</button>
  <button class="btn" id="pushBtn" style="background:#FF9F45;color:#0B1322;">🚚 Đẩy sang hậu cần</button>
  <a class="link" href="/thailand/api/export" id="csvBtn">⬇ Xuất CSV</a>
  <a class="link" href="/marketing-thailand.html">📊 MKT Thái Lan</a>
  <a class="link" href="/thailand/salary" id="salaryLink" style="display:none;">💰 Lương Thái</a>
  <a class="link" href="/">← Dashboard</a>
  <button class="btn ghost" id="syncBtn" style="display:none;">🔄 Đồng bộ HC</button>
  <span class="sync-badge" id="syncBadge" style="display:none;"></span>
  <a class="link" href="/thailand/logout">Đăng xuất</a>
</header>
<!-- Modal đồng bộ -->
<div class="modal-bg" id="syncModal">
  <div class="modal" style="width:520px;">
    <h2>🔄 Đồng bộ trạng thái từ hậu cần</h2>
    <p style="font-size:13px;color:#9FB0C8;margin:0 0 14px;">Kéo trạng thái đơn từ TDFFM về hệ thống, khớp theo số điện thoại.</p>
    <div style="display:flex;gap:10px;margin-bottom:14px;">
      <button class="btn g" id="syncNowBtn" style="flex:1;">▶ Bắt đầu đồng bộ ngay</button>
      <button class="btn ghost" id="syncRefreshBtn">↻ Refresh</button>
    </div>
    <div id="syncStatus" style="font-size:13px;padding:10px;background:rgba(255,255,255,.04);border-radius:8px;min-height:40px;"></div>
    <div id="syncLog"></div>
    <div class="modal-actions" style="margin-top:14px;">
      <button class="cancel modal-actions" style="flex:1;padding:10px;border:none;border-radius:9px;background:rgba(255,255,255,.08);color:#E7EEF8;font-size:14px;cursor:pointer;" id="syncClose">Đóng</button>
    </div>
  </div>
</div>
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
      <select id="fDay"><option value="">Đẩy/Chưa đẩy</option><option value="done">Đã đẩy</option><option value="pending">Chưa đẩy</option></select>
      <input id="fQ" placeholder="Tìm tên/SĐT/địa chỉ…">
      <button class="btn" id="fBtn">Lọc</button>
      <button class="btn ghost" id="fReset">Xoá lọc</button>
    </div>
    <div class="wrap-top-scroll" id="wrapTopScroll"><div id="wrapTopInner"></div></div>
<div class="wrap-outer" id="wrapOuter"><div class="wrap"><div id="tbl"></div></div></div>
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
let TT=[], NV=[], DSMAU=[], MAU_DEFAULT='', IS_ADMIN=true;

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
  if($('fDay').value)qs.set('day',$('fDay').value);
  if($('fQ').value)qs.set('q',$('fQ').value);
  $('tbl').innerHTML='<div class="empty">Đang tải…</div>';
  try{
    const r=await fetch('/thailand/api/orders?'+qs.toString());
    if(r.status===401){location.href='/thailand/login';return;}
    const d=await r.json();
    if(!d.ok){$('tbl').innerHTML='<div class="empty">'+esc(d.message)+'</div>';return;}
    TT=d.trangThais; NV=d.nhanViens; DSMAU=d.dsMau||[]; MAU_DEFAULT=d.maMauDefault||''; IS_ADMIN=d.isAdmin!==false;
    // Ẩn nút đẩy + bộ lọc nhân viên với nhân viên thường
    if($('pushBtn')) $('pushBtn').style.display = IS_ADMIN ? '' : 'none';
    if($('csvBtn')) $('csvBtn').style.display = IS_ADMIN ? '' : 'none';
    if($('syncBtn')) $('syncBtn').style.display = IS_ADMIN ? '' : 'none';
    if($('salaryLink')) $('salaryLink').style.display = IS_ADMIN ? '' : 'none';
    if($('fNv')) $('fNv').style.display = IS_ADMIN ? '' : 'none';
    if($('fDay')) $('fDay').style.display = IS_ADMIN ? '' : 'none';
    // fill selects
    if(IS_ADMIN && $('fNv').options.length<=1) NV.forEach(n=>$('fNv').insertAdjacentHTML('beforeend','<option>'+esc(n)+'</option>'));
    if($('fTt').options.length<=1) TT.forEach(t=>$('fTt').insertAdjacentHTML('beforeend','<option>'+esc(t)+'</option>'));
    render(d.orders);
  }catch(e){$('tbl').innerHTML='<div class="empty">Lỗi tải dữ liệu</div>';}
}


  function fmtNgayVe(o) {
    var dt = o.created_at || o.ngay_ve || '';
    if (!dt) return '';
    var d = new Date(dt);
    if (isNaN(d.getTime())) return dt.toString().slice(0, 16);
    // Chuyển sang giờ VN (UTC+7)
    var vn = new Date(d.getTime() + 7 * 3600 * 1000);
    var pad = n => String(n).padStart(2,'0');
    return vn.getUTCFullYear()+'-'+pad(vn.getUTCMonth()+1)+'-'+pad(vn.getUTCDate())
      +' '+pad(vn.getUTCHours())+':'+pad(vn.getUTCMinutes());
  }

  function stCls(t){
  if(['Thành công','Hoàn tất','Giao thành công','Đã giao'].includes(t))return 'st-tc';
  if(['Huỷ','Hoàn hàng','Từ chối','Có vấn đề','Đang hoàn'].includes(t))return 'st-huy';
  if(['Mới về','Chưa xử lý'].includes(t))return 'st-moi';
  return '';
}

function mauSelect(o){
  const cur=o.ma_mau||MAU_DEFAULT;
  const list=[...new Set([cur, ...DSMAU].filter(Boolean))];
  const opts=list.map(m=>'<option'+(m===cur?' selected':'')+'>'+esc(m)+'</option>').join('');
  return '<select class="st mausel" style="min-width:120px" data-id="'+o.id+'">'+opts+'</select>';
}
function render(orders){
  if(!orders.length){$('tbl').innerHTML='<div class="empty">Chưa có đơn nào.</div>';return;}
  let h='<div style="margin:0 0 10px;color:#9FB0C8;font-size:13px;">Tổng: <b style="color:#7BE3B5">'+orders.length+'</b> đơn</div>';
  h+='<table><thead><tr>'
    +(IS_ADMIN?'<th><input type="checkbox" id="chkAll"></th>':'')
    +'<th class="num">STT</th>'
    +'<th>Ngày về</th><th>Họ tên</th><th>SĐT</th><th>Địa chỉ</th><th>Combo</th>'
    +'<th class="num">SL</th><th class="num">Giá THB</th><th>Mã mẫu mã</th>'
    +'<th>Nhân viên</th><th>Trạng thái</th>'
    +(IS_ADMIN?'<th>Đẩy</th>':'')+(IS_ADMIN?'<th></th>':'')+'</tr></thead><tbody>';
  orders.forEach((o,idx)=>{
    const ttList = (o.trang_thai && !TT.includes(o.trang_thai)) ? [o.trang_thai, ...TT] : TT;
    const ttOpts=ttList.map(t=>'<option'+(t===o.trang_thai?' selected':'')+'>'+esc(t)+'</option>').join('');
    const dayBadge = o.da_day==1
      ? '<span style="color:#7BE3B5;font-size:12px;">✓ Đã đẩy</span>'
      : '<span style="color:#6B7C97;font-size:12px;">—</span>';
    h+='<tr>'
      +(IS_ADMIN?'<td><input type="checkbox" class="chk" data-id="'+o.id+'"'+(o.da_day==1?' disabled':'')+'></td>':'')
      +'<td class="num" style="color:#6B7C97">'+(idx+1)+'</td>'
      +'<td>'+esc(fmtNgayVe(o))+'</td>'
      +'<td>'+esc(o.ho_ten)+'</td>'
      +'<td>'+esc(o.sdt)+'</td>'
      +'<td class="muted">'+esc(o.dia_chi)+'</td>'
      +'<td class="muted" style="max-width:180px;white-space:normal;font-size:11px;">'+esc(o.combo)+'</td>'
      +'<td class="num"><input class="ed ednum edsl" data-id="'+o.id+'" value="'+esc(o.so_luong||0)+'" style="width:55px;text-align:right"></td>'
      +'<td class="num"><input class="ed ednum edgia" data-id="'+o.id+'" value="'+esc(o.gia_thb||0)+'" style="width:75px;text-align:right"></td>'
      +'<td>'+mauSelect(o)+'</td>'
      +'<td><input class="ed ednv" data-id="'+o.id+'" value="'+esc(o.nhan_vien||'')+'"></td>'
      +'<td><select class="st sttt" data-id="'+o.id+'" data-cls="'+stCls(o.trang_thai)+'">'+ttOpts+'</select></td>'
      +(IS_ADMIN?'<td>'+dayBadge+'</td>':'')
      +(IS_ADMIN?'<td><span class="del delbtn" data-id="'+o.id+'">✕</span></td>':'')
      +'</tr>';
  });
  h+='</tbody></table>';
  $('tbl').innerHTML=h;
  document.dispatchEvent(new Event('thaiTableRendered'));
  // Gắn sự kiện (tránh onchange inline để không lỗi escape)
  document.querySelectorAll('.mausel').forEach(el=>el.onchange=()=>upd(+el.dataset.id,'ma_mau',el.value));
  document.querySelectorAll('.ednv').forEach(el=>el.onchange=()=>upd(+el.dataset.id,'nhan_vien',el.value));
  document.querySelectorAll('.sttt').forEach(el=>{ if(el.dataset.cls) el.classList.add(el.dataset.cls); el.onchange=()=>upd(+el.dataset.id,'trang_thai',el.value); });
  document.querySelectorAll('.edsl').forEach(el=>el.onchange=()=>upd(+el.dataset.id,'so_luong',parseInt(el.value.replace(/[^0-9]/g,''),10)||0));
  document.querySelectorAll('.edgia').forEach(el=>el.onchange=()=>upd(+el.dataset.id,'gia_thb',parseInt(el.value.replace(/[^0-9]/g,''),10)||0));
  document.querySelectorAll('.delbtn').forEach(el=>el.onclick=()=>del(+el.dataset.id));
  if($('chkAll')) $('chkAll').onchange=function(){ toggleAll(this); };
}
function toggleAll(box){
  document.querySelectorAll('.chk:not(:disabled)').forEach(c=>c.checked=box.checked);
}
async function pushSelected(){
  const ids=[...document.querySelectorAll('.chk:checked')].map(c=>+c.dataset.id);
  if(!ids.length){ alert('Chưa chọn đơn nào để đẩy'); return; }
  if(!confirm('Đẩy '+ids.length+' đơn sang hệ thống hậu cần?')) return;
  try{
    const r=await fetch('/thailand/api/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
    const d=await r.json();
    if(d.ok){ alert('✅ '+d.message); loadOrders(); }
    else alert('❌ '+(d.message||'Lỗi đẩy đơn'));
  }catch(e){ alert('Lỗi kết nối khi đẩy đơn'); }
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

// ===== SYNC =====
async function fetchSyncStatus(){
  try{
    const r=await fetch('/thailand/api/sync-status');
    if(r.status===401||r.status===403)return null;
    return await r.json();
  }catch(e){return null;}
}

function fmtTime(iso){
  if(!iso)return '—';
  const d=new Date(iso);
  return d.toLocaleDateString('vi-VN')+' '+d.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});
}

function renderSyncStatus(data){
  if(!data){$('syncStatus').innerHTML='<span style="color:#6B7C97">Không lấy được trạng thái</span>';return;}
  const last=data.last;
  if(!last){$('syncStatus').innerHTML='<span style="color:#6B7C97">Chưa đồng bộ lần nào</span>';return;}
  const ok=last.ok;
  const color=ok?'#7BE3B5':'#ff9b8a';
  $('syncStatus').innerHTML='<span style="color:'+color+';font-weight:600;">'+(ok?'✅':'❌')+' '+esc(last.message||'')+'</span>'
    +'<div style="margin-top:6px;font-size:11px;color:#6B7C97;">'
    +(last.tdffmOrders!=null?'TDFFM: <b style="color:#E7EEF8">'+last.tdffmOrders+'</b> đơn · ':'')
    +(last.dbOrders!=null?'DB: <b style="color:#E7EEF8">'+last.dbOrders+'</b> đơn · ':'')
    +(last.updated!=null?'Cập nhật: <b style="color:#7BE3B5">'+last.updated+'</b> · ':'')
    +'Lúc: '+fmtTime(last.finishedAt||last.at)+'</div>';

  // Cập nhật badge trên header
  const badge=$('syncBadge');
  badge.style.display='inline-flex';
  if(ok){badge.className='sync-badge ok';badge.textContent='✓ Sync '+fmtTime(last.finishedAt||last.at);}
  else{badge.className='sync-badge err';badge.textContent='⚠ Sync lỗi';}

  // Log lịch sử
  if(data.logs&&data.logs.length){
    let h='<div style="font-size:11px;color:#6B7C97;margin:10px 0 5px;">Lịch sử 5 lần gần nhất:</div>';
    [...data.logs].reverse().forEach(l=>{
      if(typeof l!=='object')return;
      const c=l.ok?'ok':'err';
      h+='<div class="log-row '+c+'">'+(l.ok?'✅':'❌')+' '+esc(l.message||'')+' <span style="float:right;color:#6B7C97">'+fmtTime(l.finishedAt||l.at)+'</span></div>';
    });
    $('syncLog').innerHTML=h;
  }
}

async function openSyncModal(){
  $('syncModal').classList.add('show');
  $('syncStatus').innerHTML='<span style="color:#6B7C97">Đang tải...</span>';
  $('syncLog').innerHTML='';
  const data=await fetchSyncStatus();
  renderSyncStatus(data);
}

$('syncClose').onclick=()=>$('syncModal').classList.remove('show');
$('syncBtn').onclick=openSyncModal;

$('syncRefreshBtn').onclick=async()=>{
  $('syncStatus').innerHTML='<span style="color:#6B7C97">Đang tải...</span>';
  const data=await fetchSyncStatus();
  renderSyncStatus(data);
};

$('syncNowBtn').onclick=async()=>{
  $('syncNowBtn').disabled=true;
  $('syncNowBtn').textContent='⏳ Đang đồng bộ...';
  $('syncStatus').innerHTML='<span style="color:#9FB0C8">Đang gọi API TDFFM, vui lòng chờ...</span>';
  try{
    await fetch('/thailand/api/sync-now',{method:'POST',headers:{'Content-Type':'application/json'}});
    // Poll mỗi 2s trong tối đa 30s để chờ kết quả
    let tries=0;
    const poll=setInterval(async()=>{
      tries++;
      const data=await fetchSyncStatus();
      if(data&&data.last&&data.last.finishedAt){
        clearInterval(poll);
        renderSyncStatus(data);
        $('syncNowBtn').disabled=false;
        $('syncNowBtn').textContent='▶ Bắt đầu đồng bộ ngay';
        loadOrders(); // refresh bảng đơn
      }
      if(tries>=15){
        clearInterval(poll);
        $('syncStatus').innerHTML='<span style="color:#ff9b8a">Quá thời gian chờ, thử refresh lại</span>';
        $('syncNowBtn').disabled=false;
        $('syncNowBtn').textContent='▶ Bắt đầu đồng bộ ngay';
      }
    },2000);
  }catch(e){
    $('syncStatus').innerHTML='<span style="color:#ff9b8a">Lỗi kết nối: '+esc(e.message)+'</span>';
    $('syncNowBtn').disabled=false;
    $('syncNowBtn').textContent='▶ Bắt đầu đồng bộ ngay';
  }
};

$('fBtn').onclick=loadOrders;
$('fReset').onclick=()=>{['fTu','fDen','fNv','fTt','fDay','fQ'].forEach(id=>$(id).value='');loadOrders();};

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


// Scroll kép: đồng bộ thanh trên ↔ bảng
function initDualScroll() {
  var top = document.getElementById('wrapTopScroll');
  var outer = document.getElementById('wrapOuter');
  var inner = document.getElementById('wrapTopInner');
  if (!top || !outer || !inner) return;
  function updateWidth() {
    var tbl = outer.querySelector('table');
    if (tbl) inner.style.width = tbl.offsetWidth + 'px';
  }
  updateWidth();
  var lock = false;
  top.addEventListener('scroll', function() {
    if (lock) return; lock = true; outer.scrollLeft = top.scrollLeft; lock = false;
  }, {passive: true});
  outer.addEventListener('scroll', function() {
    if (lock) return; lock = true; top.scrollLeft = outer.scrollLeft; lock = false;
  }, {passive: true});
  document.addEventListener('thaiTableRendered', function() {
    setTimeout(updateWidth, 50);
    top.scrollLeft = 0; outer.scrollLeft = 0;
  });
  if (window.ResizeObserver) {
    new ResizeObserver(updateWidth).observe(outer);
  }
}
setTimeout(initDualScroll, 300);

(function(){
  var fmt=function(d){return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);};
  var t=new Date(),y=new Date(t); y.setDate(t.getDate()-1);
  if(!$('fTu').value)$('fTu').value=fmt(y);
  if(!$('fDen').value)$('fDen').value=fmt(t);
})();
loadOrders();
</script>
</body></html>`;
}
