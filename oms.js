// =====================================================================
//  MODULE QUẢN LÝ ĐƠN HÀNG (OMS) — oms.js
//  Pattern giống thailand.js: AN TOÀN, lazy DB, try/catch toàn bộ
//  Mount vào server.js: mountOMS(app, { mysql, express })
// =====================================================================

// ---- Trạng thái đơn hàng hợp lệ ----
const TRANG_THAI = ['Đơn mới', 'Đã chốt', 'Đang ship', 'Ship thành công', 'Hoàn thành công', 'Không mua'];

// ---- Danh sách Tỉnh/Thành phố Việt Nam (63 tỉnh) ----
const TINH_TP = [
  'Hà Nội','Hồ Chí Minh','Đà Nẵng','Hải Phòng','Cần Thơ',
  'An Giang','Bà Rịa - Vũng Tàu','Bắc Giang','Bắc Kạn','Bạc Liêu',
  'Bắc Ninh','Bến Tre','Bình Định','Bình Dương','Bình Phước',
  'Bình Thuận','Cà Mau','Cao Bằng','Đắk Lắk','Đắk Nông',
  'Điện Biên','Đồng Nai','Đồng Tháp','Gia Lai','Hà Giang',
  'Hà Nam','Hà Tĩnh','Hải Dương','Hậu Giang','Hòa Bình',
  'Hưng Yên','Khánh Hòa','Kiên Giang','Kon Tum','Lai Châu',
  'Lâm Đồng','Lạng Sơn','Lào Cai','Long An','Nam Định',
  'Nghệ An','Ninh Bình','Ninh Thuận','Phú Thọ','Phú Yên',
  'Quảng Bình','Quảng Nam','Quảng Ngãi','Quảng Ninh','Quảng Trị',
  'Sóc Trăng','Sơn La','Tây Ninh','Thái Bình','Thái Nguyên',
  'Thanh Hóa','Thừa Thiên Huế','Tiền Giang','Trà Vinh','Tuyên Quang',
  'Vĩnh Long','Vĩnh Phúc','Yên Bái'
];

// ---- Hàm tách địa chỉ Việt Nam ----
// Input: "123 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh"
// Output: { tinh, quan, phuong, diaChi }
function parseAddress(raw) {
  if (!raw) return { tinh: '', quan: '', phuong: '', diaChi: '' };
  const s = raw.trim();

  // Tách theo dấu phẩy hoặc dấu gạch ngang
  const parts = s.split(/[,\-]+/).map(p => p.trim()).filter(Boolean);

  let tinh = '', quan = '', phuong = '', diaChiParts = [];

  // Duyệt từ CUỐI lên (địa chỉ VN thường: chi tiết, phường, quận, tỉnh)
  const used = new Set();

  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    const low = p.toLowerCase().replace(/\s+/g, ' ');

    // Tìm Tỉnh/Thành phố
    if (!tinh) {
      if (/^(tp\.?|thành phố|t\.p\.?)\s*/i.test(p) ||
          /tỉnh\s*/i.test(p) ||
          TINH_TP.some(t => low.includes(t.toLowerCase()))) {
        tinh = p.replace(/^(tp\.?|thành phố|t\.p\.?|tỉnh)\s*/i, '').trim();
        // Tìm tên chuẩn
        const match = TINH_TP.find(t => low.includes(t.toLowerCase()));
        if (match) tinh = match;
        // Thêm prefix nếu là TP trực thuộc TW
        if (['Hà Nội','Hồ Chí Minh','Đà Nẵng','Hải Phòng','Cần Thơ'].includes(tinh)) {
          tinh = 'TP ' + tinh;
        } else if (tinh && !tinh.startsWith('Tỉnh')) {
          tinh = 'Tỉnh ' + tinh;
        }
        used.add(i);
        continue;
      }
    }

    // Tìm Quận/Huyện/Thị xã/Thành phố (cấp huyện)
    if (!quan) {
      if (/^(quận|huyện|thị xã|tx\.?|thành phố|tp\.?)\s/i.test(p) ||
          /^(q\.?\s*\d)/i.test(p)) {
        quan = p;
        used.add(i);
        continue;
      }
    }

    // Tìm Phường/Xã/Thị trấn
    if (!phuong) {
      if (/^(phường|xã|thị trấn|tt\.?|p\.?\s*\d)/i.test(p)) {
        phuong = p;
        used.add(i);
        continue;
      }
    }
  }

  // Phần còn lại = Địa chỉ chi tiết
  for (let i = 0; i < parts.length; i++) {
    if (!used.has(i)) diaChiParts.push(parts[i]);
  }

  return {
    tinh: tinh || '',
    quan: quan || '',
    phuong: phuong || '',
    diaChi: diaChiParts.join(', ') || s
  };
}

// ---- Tạo bảng nếu chưa có ----
async function ensureTables(pool) {
  // Bảng đơn hàng chính
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oms_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ngay_ve DATETIME DEFAULT CURRENT_TIMESTAMP,
      nv_marketing VARCHAR(120) DEFAULT '' COMMENT 'Nhân viên marketing (từ UTM)',
      ten_kh VARCHAR(255) DEFAULT '' COMMENT 'Tên khách hàng',
      sdt VARCHAR(50) DEFAULT '',
      dia_chi_full TEXT COMMENT 'Địa chỉ gốc đầy đủ',
      tinh VARCHAR(120) DEFAULT '',
      quan VARCHAR(120) DEFAULT '',
      phuong VARCHAR(120) DEFAULT '',
      dia_chi VARCHAR(500) DEFAULT '' COMMENT 'Địa chỉ chi tiết',
      trang_thai VARCHAR(40) DEFAULT 'Đơn mới',
      ghi_chu TEXT,
      sale_phu_trach VARCHAR(120) DEFAULT '' COMMENT 'Sale được phân công',
      utm_source VARCHAR(255) DEFAULT '',
      utm_medium VARCHAR(255) DEFAULT '',
      utm_campaign VARCHAR(255) DEFAULT '',
      utm_content VARCHAR(255) DEFAULT '',
      don_vi_vc VARCHAR(40) DEFAULT '' COMMENT 'GHTK hoặc VTP',
      ma_van_don VARCHAR(100) DEFAULT '' COMMENT 'Tracking ID từ GHTK/VTP',
      trang_thai_vc VARCHAR(100) DEFAULT '' COMMENT 'Trạng thái từ đơn vị vận chuyển',
      da_xuat_hd TINYINT DEFAULT 0 COMMENT 'Đã xuất hóa đơn Misa chưa',
      misa_invoice_id VARCHAR(100) DEFAULT '',
      san_pham TEXT COMMENT 'Tên/mô tả sản phẩm',
      so_luong INT DEFAULT 1,
      gia_ban BIGINT DEFAULT 0 COMMENT 'Giá bán (VND)',
      tong_tien BIGINT DEFAULT 0 COMMENT 'Tổng tiền (VND)',
      phi_ship BIGINT DEFAULT 0,
      da_thanh_toan TINYINT DEFAULT 0,
      INDEX idx_ngay (ngay_ve),
      INDEX idx_tt (trang_thai),
      INDEX idx_nv (nv_marketing),
      INDEX idx_sale (sale_phu_trach),
      INDEX idx_mavandon (ma_van_don)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Bảng tài khoản OMS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oms_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(60) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      ho_ten VARCHAR(120) DEFAULT '',
      role ENUM('admin','sale','marketing','warehouse') DEFAULT 'sale',
      active TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Bảng cấu hình API
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oms_config (
      config_key VARCHAR(100) PRIMARY KEY,
      config_value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Tạo tài khoản admin mặc định nếu chưa có
  const [rows] = await pool.query(`SELECT id FROM oms_users WHERE username='admin'`);
  if (rows.length === 0) {
    await pool.query(`INSERT INTO oms_users (username, password, ho_ten, role)
      VALUES ('admin', 'admin123', 'Admin', 'admin')`);
  }

  // Thêm cột mới nếu bảng cũ chưa có (an toàn)
  const addCols = [
    "san_pham TEXT",
    "so_luong INT DEFAULT 1",
    "gia_ban BIGINT DEFAULT 0",
    "tong_tien BIGINT DEFAULT 0",
    "phi_ship BIGINT DEFAULT 0",
    "da_thanh_toan TINYINT DEFAULT 0",
  ];
  for (const col of addCols) {
    try { await pool.query(`ALTER TABLE oms_orders ADD COLUMN ${col}`); } catch(e) {}
  }
}

// =====================================================================
//  mountOMS(app, { mysql, express })
// =====================================================================
export function mountOMS(app, { mysql, express }) {
  let pool = null;

  // ---- Lazy DB connection ----
  // DATABASE RIÊNG cho OMS — bắt buộc đặt OMS_DB_*
  // Không dùng chung DB với Thailand để tránh ảnh hưởng lẫn nhau
  function getPool() {
    if (pool) return pool;
    const cfg = {
      host: process.env.OMS_DB_HOST || 'localhost',
      user: process.env.OMS_DB_USER || '',
      password: process.env.OMS_DB_PASS || '',
      database: process.env.OMS_DB_NAME || '',
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
    };
    if (!cfg.user || !cfg.database) {
      console.warn('[OMS] Thiếu biến OMS_DB_USER / OMS_DB_NAME → module OMS tắt (app chính vẫn chạy)');
      return null;
    }
    pool = mysql.createPool(cfg);
    console.log('[OMS] MySQL pool riêng:', cfg.database);
    return pool;
  }

  async function db(sql, params) {
    const p = getPool();
    if (!p) throw new Error('OMS DB chưa cấu hình');
    const [rows] = await p.query(sql, params);
    return rows;
  }

  // ---- Wrap route an toàn ----
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error('[OMS]', e); res.status(500).json({ error: e.message }); }
  };

  // ---- Middleware xác thực OMS ----
  // Tự động nhận admin từ dashboard chính → không cần đăng nhập OMS riêng
  function autoSetOmsUser(req) {
    if (req.session?.omsUser) return;
    if (req.session?.user?.role === 'admin') {
      req.session.omsUser = { id: 0, username: req.session.user.user || 'admin', ho_ten: 'Admin', role: 'admin' };
    }
  }

  function omsAuth(req, res, next) {
    autoSetOmsUser(req);
    if (req.session?.omsUser) return next();
    res.status(401).json({ error: 'Chưa đăng nhập OMS' });
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      autoSetOmsUser(req);
      if (!req.session?.omsUser) return res.status(401).json({ error: 'Chưa đăng nhập' });
      if (roles.includes(req.session.omsUser.role)) return next();
      res.status(403).json({ error: 'Không đủ quyền' });
    };
  }

  const jsonParser = express.json();
  const formParser = express.urlencoded({ extended: true });

  // ===================== ĐĂNG NHẬP OMS =====================
  app.post('/oms/login', jsonParser, formParser, wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Thiếu username/password' });

    const rows = await db('SELECT * FROM oms_users WHERE username=? AND password=? AND active=1', [username, password]);
    if (rows.length === 0) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });

    const u = rows[0];
    req.session.omsUser = { id: u.id, username: u.username, ho_ten: u.ho_ten, role: u.role };
    req.session.save(() => res.json({ ok: true, user: req.session.omsUser }));
  }));

  app.post('/oms/logout', wrap(async (req, res) => {
    delete req.session.omsUser;
    req.session.save(() => res.json({ ok: true }));
  }));

  app.get('/oms/api/me', omsAuth, wrap(async (req, res) => {
    res.json(req.session.omsUser);
  }));

  // ===================== WEBHOOK LADIPAGE (KHÔNG CẦN LOGIN) =====================
  app.post('/oms/webhook', jsonParser, formParser, wrap(async (req, res) => {
    const d = req.body || {};

    // Map trường Ladipage → OMS
    const ten = d.name || d.ten || d.ho_ten || '';
    const sdt = d.phone || d.sdt || d.dien_thoai || '';
    const diaChiFull = d.address || d.dia_chi || '';
    const sanPham = d.product || d.san_pham || d.message || '';
    const soLuong = parseInt(d.quantity || d.so_luong || 1, 10) || 1;
    const gia = parseInt(d.price || d.gia || 0, 10) || 0;

    // UTM parameters → xác định nhân viên marketing
    const utmSource = d.utm_source || '';
    const utmMedium = d.utm_medium || '';
    const utmCampaign = d.utm_campaign || '';
    const utmContent = d.utm_content || '';
    const nvMarketing = d.utm_content || d.nhan_vien || d.user || d.marketing || '';

    // Tách địa chỉ tự động
    const addr = parseAddress(diaChiFull);

    // Ghi vào DB
    const p = getPool();
    if (!p) return res.status(503).json({ error: 'DB chưa cấu hình' });
    await ensureTables(p);

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await db(`INSERT INTO oms_orders
      (ngay_ve, nv_marketing, ten_kh, sdt, dia_chi_full, tinh, quan, phuong, dia_chi,
       trang_thai, san_pham, so_luong, gia_ban, tong_tien,
       utm_source, utm_medium, utm_campaign, utm_content, ghi_chu)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Đơn mới', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [now, nvMarketing, ten, sdt, diaChiFull, addr.tinh, addr.quan, addr.phuong, addr.diaChi,
       sanPham, soLuong, gia, gia * soLuong,
       utmSource, utmMedium, utmCampaign, utmContent,
       d.url_page || d.ghi_chu || '']);

    // Log webhook
    try {
      const DATA_DIR = process.env.DATA_DIR || '/home/u422036594/data';
      const logLine = `[${now}] ${ten} | ${sdt} | ${nvMarketing} | ${diaChiFull}\n`;
      const fs = await import('node:fs');
      fs.default.appendFileSync(DATA_DIR + '/oms-webhook.log', logLine);
    } catch(e) {}

    res.status(201).json({ ok: true, message: 'Đã nhận đơn' });
  }));

  // ===================== API DANH SÁCH ĐƠN =====================
  app.get('/oms/api/orders', omsAuth, wrap(async (req, res) => {
    const p = getPool();
    if (!p) return res.json([]);
    await ensureTables(p);

    const user = req.session.omsUser;
    const { tu, den, trang_thai, nv, sale, q, page = 1, limit = 50 } = req.query;

    let where = ['1=1'];
    let params = [];

    // Phân quyền
    if (user.role === 'sale') {
      // Sale chỉ thấy đơn được phân công hoặc đơn mới
      where.push(`(sale_phu_trach = ? OR (sale_phu_trach = '' AND trang_thai = 'Đơn mới'))`);
      params.push(user.ho_ten);
    } else if (user.role === 'marketing') {
      // Marketing chỉ thấy đơn do mình mang về
      where.push(`nv_marketing = ?`);
      params.push(user.ho_ten);
    } else if (user.role === 'warehouse') {
      // Kho chỉ thấy đơn đã chốt
      where.push(`trang_thai IN ('Đã chốt', 'Đang ship')`);
    }
    // Admin thấy tất cả

    if (tu) { where.push('ngay_ve >= ?'); params.push(tu); }
    if (den) { where.push('ngay_ve <= ?'); params.push(den + ' 23:59:59'); }
    if (trang_thai) { where.push('trang_thai = ?'); params.push(trang_thai); }
    if (nv) { where.push('nv_marketing = ?'); params.push(nv); }
    if (sale) { where.push('sale_phu_trach = ?'); params.push(sale); }
    if (q) { where.push('(ten_kh LIKE ? OR sdt LIKE ? OR ma_van_don LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`); }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countRows = await db(`SELECT COUNT(*) as total FROM oms_orders WHERE ${where.join(' AND ')}`, params);
    const rows = await db(
      `SELECT * FROM oms_orders WHERE ${where.join(' AND ')} ORDER BY ngay_ve DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ orders: rows, total: countRows[0].total, page: parseInt(page), limit: parseInt(limit) });
  }));

  // ===================== THÊM ĐƠN THỦ CÔNG =====================
  app.post('/oms/api/orders', omsAuth, jsonParser, wrap(async (req, res) => {
    const d = req.body;
    const addr = parseAddress(d.dia_chi_full || '');
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await ensureTables(getPool());
    const result = await db(`INSERT INTO oms_orders
      (ngay_ve, nv_marketing, ten_kh, sdt, dia_chi_full, tinh, quan, phuong, dia_chi,
       trang_thai, san_pham, so_luong, gia_ban, tong_tien, ghi_chu, sale_phu_trach)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.ngay_ve || now, d.nv_marketing || '', d.ten_kh || '', d.sdt || '',
       d.dia_chi_full || '', addr.tinh, addr.quan, addr.phuong, addr.diaChi,
       d.trang_thai || 'Đơn mới', d.san_pham || '', d.so_luong || 1,
       d.gia_ban || 0, (d.gia_ban || 0) * (d.so_luong || 1),
       d.ghi_chu || '', d.sale_phu_trach || '']);

    res.json({ ok: true, id: result.insertId });
  }));

  // ===================== CẬP NHẬT ĐƠN =====================
  app.put('/oms/api/orders/:id', omsAuth, jsonParser, wrap(async (req, res) => {
    const { id } = req.params;
    const d = req.body;
    const user = req.session.omsUser;

    // Sale chỉ được cập nhật ghi chú + trạng thái (Đã chốt / Không mua)
    if (user.role === 'sale') {
      const allowed = {};
      if (d.trang_thai && ['Đã chốt', 'Không mua'].includes(d.trang_thai)) allowed.trang_thai = d.trang_thai;
      if (d.ghi_chu !== undefined) allowed.ghi_chu = d.ghi_chu;
      if (d.sale_phu_trach) allowed.sale_phu_trach = d.sale_phu_trach;
      if (Object.keys(allowed).length === 0) return res.status(400).json({ error: 'Không có gì để cập nhật' });

      const sets = Object.keys(allowed).map(k => `${k}=?`).join(', ');
      await db(`UPDATE oms_orders SET ${sets} WHERE id=?`, [...Object.values(allowed), id]);
      return res.json({ ok: true });
    }

    // Admin/Warehouse có thể cập nhật nhiều trường hơn
    const allowedFields = ['trang_thai','ghi_chu','sale_phu_trach','don_vi_vc','ma_van_don',
      'trang_thai_vc','nv_marketing','ten_kh','sdt','dia_chi_full','san_pham',
      'so_luong','gia_ban','tong_tien','phi_ship','da_thanh_toan'];

    const sets = [];
    const vals = [];
    for (const f of allowedFields) {
      if (d[f] !== undefined) {
        sets.push(`${f}=?`);
        vals.push(d[f]);
        // Nếu cập nhật địa chỉ đầy đủ → tách lại
        if (f === 'dia_chi_full') {
          const addr = parseAddress(d[f]);
          sets.push('tinh=?', 'quan=?', 'phuong=?', 'dia_chi=?');
          vals.push(addr.tinh, addr.quan, addr.phuong, addr.diaChi);
        }
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: 'Không có gì để cập nhật' });
    await db(`UPDATE oms_orders SET ${sets.join(', ')} WHERE id=?`, [...vals, id]);

    // Auto-push Misa nếu trạng thái = Ship thành công
    if (d.trang_thai === 'Ship thành công') {
      try { await pushToMisa(id); } catch(e) { console.error('[OMS] Misa push error:', e.message); }
    }

    res.json({ ok: true });
  }));

  // ===================== XÓA ĐƠN (chỉ admin) =====================
  app.delete('/oms/api/orders/:id', requireRole('admin'), wrap(async (req, res) => {
    await db('DELETE FROM oms_orders WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  }));

  // ===================== THỐNG KÊ / BÁO CÁO (Admin) =====================
  app.get('/oms/api/stats', requireRole('admin'), wrap(async (req, res) => {
    const { tu, den } = req.query;
    let dateFilter = '';
    let params = [];
    if (tu) { dateFilter += ' AND ngay_ve >= ?'; params.push(tu); }
    if (den) { dateFilter += ' AND ngay_ve <= ?'; params.push(den + ' 23:59:59'); }

    // Tổng quan
    const [overview] = await db(`SELECT
      COUNT(*) as tongDon,
      SUM(CASE WHEN trang_thai='Ship thành công' THEN tong_tien ELSE 0 END) as doanhThu,
      SUM(CASE WHEN trang_thai='Đã chốt' THEN 1 ELSE 0 END) as daChot,
      SUM(CASE WHEN trang_thai='Đơn mới' THEN 1 ELSE 0 END) as donMoi,
      SUM(CASE WHEN trang_thai='Đang ship' THEN 1 ELSE 0 END) as dangShip,
      SUM(CASE WHEN trang_thai='Ship thành công' THEN 1 ELSE 0 END) as shipOK,
      SUM(CASE WHEN trang_thai='Hoàn thành công' THEN 1 ELSE 0 END) as hoanHang,
      SUM(CASE WHEN trang_thai='Không mua' THEN 1 ELSE 0 END) as khongMua
      FROM oms_orders WHERE 1=1 ${dateFilter}`, params);

    // Theo Sale
    const bySale = await db(`SELECT sale_phu_trach as ten,
      COUNT(*) as tongDon,
      SUM(CASE WHEN trang_thai IN ('Đã chốt','Đang ship','Ship thành công') THEN 1 ELSE 0 END) as daChot,
      ROUND(SUM(CASE WHEN trang_thai IN ('Đã chốt','Đang ship','Ship thành công') THEN 1 ELSE 0 END)*100/COUNT(*),1) as tyLeChot
      FROM oms_orders WHERE sale_phu_trach != '' ${dateFilter}
      GROUP BY sale_phu_trach ORDER BY daChot DESC`, params);

    // Theo Marketing
    const byMkt = await db(`SELECT nv_marketing as ten,
      COUNT(*) as tongDon,
      SUM(CASE WHEN trang_thai IN ('Đã chốt','Đang ship','Ship thành công') THEN 1 ELSE 0 END) as daChot
      FROM oms_orders WHERE nv_marketing != '' ${dateFilter}
      GROUP BY nv_marketing ORDER BY tongDon DESC`, params);

    // Theo ngày (7 ngày gần nhất)
    const byDay = await db(`SELECT DATE(ngay_ve) as ngay, COUNT(*) as soDon,
      SUM(CASE WHEN trang_thai='Ship thành công' THEN tong_tien ELSE 0 END) as doanhThu
      FROM oms_orders WHERE ngay_ve >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) ${dateFilter}
      GROUP BY DATE(ngay_ve) ORDER BY ngay DESC`, params);

    res.json({ overview: overview || {}, bySale, byMkt, byDay });
  }));

  // ===================== QUẢN LÝ TÀI KHOẢN (Admin) =====================
  app.get('/oms/api/users', requireRole('admin'), wrap(async (req, res) => {
    const rows = await db('SELECT id, username, ho_ten, role, active FROM oms_users ORDER BY role, ho_ten');
    res.json(rows);
  }));

  app.post('/oms/api/users', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const { username, password, ho_ten, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Thiếu username/password' });
    await ensureTables(getPool());
    const result = await db('INSERT INTO oms_users (username, password, ho_ten, role) VALUES (?,?,?,?)',
      [username, password, ho_ten || username, role || 'sale']);
    // Debug: đọc lại ngay để kiểm tra
    const check = await db('SELECT COUNT(*) as cnt FROM oms_users');
    const allUsers = await db('SELECT id, username FROM oms_users ORDER BY id');
    res.json({ ok: true, debug: { insertId: result.insertId, affectedRows: result.affectedRows, totalUsers: check[0]?.cnt, allUsers } });
  }));

  app.put('/oms/api/users/:id', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const { ho_ten, role, active, password } = req.body;
    const sets = [];
    const vals = [];
    if (ho_ten !== undefined) { sets.push('ho_ten=?'); vals.push(ho_ten); }
    if (role !== undefined) { sets.push('role=?'); vals.push(role); }
    if (active !== undefined) { sets.push('active=?'); vals.push(active); }
    if (password) { sets.push('password=?'); vals.push(password); }
    if (sets.length === 0) return res.status(400).json({ error: 'Không có gì' });
    vals.push(req.params.id);
    await db(`UPDATE oms_users SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  }));

  // ===================== CẤU HÌNH API (Admin) =====================
  app.get('/oms/api/config', requireRole('admin'), wrap(async (req, res) => {
    await ensureTables(getPool());
    const rows = await db('SELECT config_key, config_value FROM oms_config');
    const cfg = {};
    rows.forEach(r => cfg[r.config_key] = r.config_value);
    res.json(cfg);
  }));

  app.post('/oms/api/config', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const entries = req.body; // { key: value, ... }
    await ensureTables(getPool());
    for (const [k, v] of Object.entries(entries)) {
      await db(`INSERT INTO oms_config (config_key, config_value) VALUES (?,?)
        ON DUPLICATE KEY UPDATE config_value=?`, [k, v, v]);
    }
    res.json({ ok: true });
  }));

  // ===================== ĐẨY ĐƠN GHTK =====================
  app.post('/oms/api/push-ghtk', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const { ids } = req.body; // [1, 2, 3]
    if (!ids?.length) return res.status(400).json({ error: 'Chưa chọn đơn' });

    // Lấy config GHTK
    const cfgRows = await db("SELECT config_value FROM oms_config WHERE config_key='ghtk_token'");
    const token = cfgRows[0]?.config_value || process.env.GHTK_TOKEN || '';
    const apiUrl = process.env.GHTK_URL || 'https://services.giaohangtietkiem.vn';

    if (!token) return res.status(400).json({ error: 'Chưa cấu hình GHTK Token' });

    const orders = await db(`SELECT * FROM oms_orders WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);
    const results = [];

    for (const o of orders) {
      try {
        const body = {
          products: [{ name: o.san_pham || 'Sản phẩm', weight: 0.5, quantity: o.so_luong || 1, product_code: '' }],
          order: {
            id: `OMS-${o.id}`,
            pick_name: process.env.GHTK_SHOP_NAME || 'Shop',
            pick_money: 0,
            pick_address: process.env.GHTK_PICK_ADDRESS || '',
            pick_province: process.env.GHTK_PICK_PROVINCE || '',
            pick_district: process.env.GHTK_PICK_DISTRICT || '',
            pick_tel: process.env.GHTK_PICK_TEL || '',
            name: o.ten_kh,
            address: o.dia_chi || o.dia_chi_full,
            province: o.tinh?.replace(/^(TP |Tỉnh )/,'') || '',
            district: o.quan || '',
            ward: o.phuong || '',
            tel: o.sdt,
            email: '',
            hamlet: 'Khác',
            is_freeship: 0,
            value: o.tong_tien || 0,
            pick_option: 'cod',
            note: o.ghi_chu || '',
          }
        };

        const resp = await fetch(`${apiUrl}/services/shipment/order/?ver=1.5`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Token': token },
          body: JSON.stringify(body)
        });
        const data = await resp.json();

        if (data.success) {
          await db(`UPDATE oms_orders SET don_vi_vc='GHTK', ma_van_don=?, trang_thai='Đang ship' WHERE id=?`,
            [data.order?.label || '', o.id]);
          results.push({ id: o.id, ok: true, label: data.order?.label });
        } else {
          results.push({ id: o.id, ok: false, error: data.message });
        }
      } catch(e) {
        results.push({ id: o.id, ok: false, error: e.message });
      }
    }

    res.json({ results });
  }));

  // ===================== ĐẨY ĐƠN VIETTEL POST =====================
  app.post('/oms/api/push-vtp', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'Chưa chọn đơn' });

    const cfgRows = await db("SELECT config_key, config_value FROM oms_config WHERE config_key IN ('vtp_token','vtp_username','vtp_password')");
    const cfg = {};
    cfgRows.forEach(r => cfg[r.config_key] = r.config_value);

    let token = cfg.vtp_token || process.env.VTP_TOKEN || '';
    const apiUrl = 'https://partner.viettelpost.vn/v2/order/createOrder';

    // Nếu chưa có token → login lấy
    if (!token && (cfg.vtp_username || process.env.VTP_USERNAME)) {
      try {
        const loginResp = await fetch('https://partner.viettelpost.vn/v2/user/Login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            USERNAME: cfg.vtp_username || process.env.VTP_USERNAME,
            PASSWORD: cfg.vtp_password || process.env.VTP_PASSWORD
          })
        });
        const loginData = await loginResp.json();
        token = loginData.data?.token || '';
        if (token) {
          await db(`INSERT INTO oms_config (config_key, config_value) VALUES ('vtp_token',?)
            ON DUPLICATE KEY UPDATE config_value=?`, [token, token]);
        }
      } catch(e) {}
    }

    if (!token) return res.status(400).json({ error: 'Chưa cấu hình Viettel Post' });

    const orders = await db(`SELECT * FROM oms_orders WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);
    const results = [];

    for (const o of orders) {
      try {
        const body = {
          ORDER_NUMBER: `OMS-${o.id}`,
          SENDER_FULLNAME: process.env.VTP_SENDER_NAME || 'Shop',
          SENDER_ADDRESS: process.env.VTP_SENDER_ADDRESS || '',
          SENDER_PHONE: process.env.VTP_SENDER_PHONE || '',
          RECEIVER_FULLNAME: o.ten_kh,
          RECEIVER_ADDRESS: o.dia_chi_full || `${o.dia_chi}, ${o.phuong}, ${o.quan}, ${o.tinh}`,
          RECEIVER_PHONE: o.sdt,
          PRODUCT_NAME: o.san_pham || 'Sản phẩm',
          PRODUCT_QUANTITY: o.so_luong || 1,
          PRODUCT_WEIGHT: 500,
          MONEY_COLLECTION: o.tong_tien || 0,
          ORDER_PAYMENT: 3, // Người nhận trả phí
          PRODUCT_TYPE: 'HH', // Hàng hóa
          NOTE: o.ghi_chu || '',
        };

        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Token': token },
          body: JSON.stringify(body)
        });
        const data = await resp.json();

        if (data.status === 200 && data.data) {
          await db(`UPDATE oms_orders SET don_vi_vc='VTP', ma_van_don=?, trang_thai='Đang ship' WHERE id=?`,
            [data.data.ORDER_NUMBER || '', o.id]);
          results.push({ id: o.id, ok: true, label: data.data.ORDER_NUMBER });
        } else {
          results.push({ id: o.id, ok: false, error: data.message });
        }
      } catch(e) {
        results.push({ id: o.id, ok: false, error: e.message });
      }
    }

    res.json({ results });
  }));

  // ===================== ĐỒNG BỘ TRẠNG THÁI VẬN CHUYỂN =====================
  async function syncShippingStatus() {
    console.log('[OMS] Bắt đầu đồng bộ trạng thái vận chuyển...');
    try {
      // Lấy đơn đang ship
      const orders = await db("SELECT id, don_vi_vc, ma_van_don FROM oms_orders WHERE trang_thai='Đang ship' AND ma_van_don != ''");

      // GHTK
      const cfgGhtk = await db("SELECT config_value FROM oms_config WHERE config_key='ghtk_token'");
      const ghtkToken = cfgGhtk[0]?.config_value || process.env.GHTK_TOKEN || '';

      for (const o of orders.filter(o => o.don_vi_vc === 'GHTK')) {
        try {
          const resp = await fetch(`https://services.giaohangtietkiem.vn/services/shipment/v2/${o.ma_van_don}`, {
            headers: { 'Token': ghtkToken }
          });
          const data = await resp.json();
          if (data.success && data.order) {
            const st = data.order.status;
            let newStatus = '';
            if (st === 5 || st === 6) newStatus = 'Ship thành công'; // Đã giao
            else if (st === 13 || st === 21) newStatus = 'Hoàn thành công'; // Đã hoàn
            if (newStatus) {
              await db('UPDATE oms_orders SET trang_thai=?, trang_thai_vc=? WHERE id=?',
                [newStatus, data.order.status_text || String(st), o.id]);
              // Nếu ship thành công → push Misa
              if (newStatus === 'Ship thành công') {
                try { await pushToMisa(o.id); } catch(e) {}
              }
            }
          }
        } catch(e) { console.error('[OMS] GHTK sync error:', o.id, e.message); }
      }

      // Viettel Post
      const cfgVtp = await db("SELECT config_value FROM oms_config WHERE config_key='vtp_token'");
      const vtpToken = cfgVtp[0]?.config_value || process.env.VTP_TOKEN || '';

      for (const o of orders.filter(o => o.don_vi_vc === 'VTP')) {
        try {
          const resp = await fetch(`https://partner.viettelpost.vn/v2/order/UpdateOrder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Token': vtpToken },
            body: JSON.stringify({ ORDER_NUMBER: o.ma_van_don, TYPE: 4 })
          });
          const data = await resp.json();
          if (data.status === 200 && data.data) {
            const st = data.data.ORDER_STATUS;
            let newStatus = '';
            if (st === 501 || st === 503) newStatus = 'Ship thành công';
            else if (st === 504 || st === 505) newStatus = 'Hoàn thành công';
            if (newStatus) {
              await db('UPDATE oms_orders SET trang_thai=?, trang_thai_vc=? WHERE id=?',
                [newStatus, data.data.ORDER_STATUSTEXT || String(st), o.id]);
              if (newStatus === 'Ship thành công') {
                try { await pushToMisa(o.id); } catch(e) {}
              }
            }
          }
        } catch(e) { console.error('[OMS] VTP sync error:', o.id, e.message); }
      }

      console.log('[OMS] Đồng bộ xong:', orders.length, 'đơn');
    } catch(e) { console.error('[OMS] Sync error:', e.message); }
  }

  // Cronjob 8h sáng mỗi ngày (giờ VN = UTC+7 = 1h UTC)
  function scheduleCronjob() {
    const check = () => {
      const now = new Date();
      const vnHour = (now.getUTCHours() + 7) % 24;
      const vnMin = now.getUTCMinutes();
      if (vnHour === 8 && vnMin === 0) {
        syncShippingStatus();
      }
    };
    setInterval(check, 60000); // Kiểm tra mỗi phút
    console.log('[OMS] Cronjob đồng bộ vận chuyển: 8h sáng mỗi ngày (VN)');
  }

  // API thủ công đồng bộ (admin)
  app.post('/oms/api/sync-shipping', requireRole('admin'), wrap(async (req, res) => {
    await syncShippingStatus();
    res.json({ ok: true, message: 'Đã đồng bộ xong' });
  }));

  // ===================== TÍCH HỢP MISA =====================
  async function pushToMisa(orderId) {
    const cfgRows = await db("SELECT config_key, config_value FROM oms_config WHERE config_key IN ('misa_app_id','misa_access_token','misa_tax_code')");
    const cfg = {};
    cfgRows.forEach(r => cfg[r.config_key] = r.config_value);

    const accessToken = cfg.misa_access_token || process.env.MISA_ACCESS_TOKEN || '';
    const appId = cfg.misa_app_id || process.env.MISA_APP_ID || '';
    if (!accessToken || !appId) return;

    const [order] = await db('SELECT * FROM oms_orders WHERE id=? AND da_xuat_hd=0', [orderId]);
    if (!order) return;

    const body = {
      inv_date: new Date().toISOString(),
      buyer_name: order.ten_kh,
      buyer_phone: order.sdt,
      buyer_address: order.dia_chi_full,
      payment_method: order.da_thanh_toan ? 'TM' : 'CK',
      inv_details: [{
        item_name: order.san_pham || 'Sản phẩm',
        unit_name: 'Cái',
        quantity: order.so_luong || 1,
        unit_price: order.gia_ban || 0,
        amount: order.tong_tien || 0,
        vat_rate: 8,
        vat_amount: Math.round((order.tong_tien || 0) * 0.08),
      }]
    };

    try {
      const resp = await fetch('https://api.meinvoice.vn/api/v1/invoices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'X-MISA-AppID': appId,
        },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (data.Success || data.Data) {
        await db('UPDATE oms_orders SET da_xuat_hd=1, misa_invoice_id=? WHERE id=?',
          [data.Data?.inv_id || 'OK', orderId]);
        console.log('[OMS] Misa invoice created for order', orderId);
      }
    } catch(e) {
      console.error('[OMS] Misa error:', e.message);
    }
  }

  // ===================== PHÂN CÔNG SALE (Admin) =====================
  app.post('/oms/api/assign-sale', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const { ids, sale } = req.body;
    if (!ids?.length || !sale) return res.status(400).json({ error: 'Thiếu đơn hoặc tên sale' });
    await db(`UPDATE oms_orders SET sale_phu_trach=? WHERE id IN (${ids.map(()=>'?').join(',')})`, [sale, ...ids]);
    res.json({ ok: true });
  }));

  // ===================== DANH SÁCH NV (cho dropdown) =====================
  app.get('/oms/api/employees', omsAuth, wrap(async (req, res) => {
    const sales = await db("SELECT DISTINCT ho_ten FROM oms_users WHERE role='sale' AND active=1");
    const mkts = await db("SELECT DISTINCT ho_ten FROM oms_users WHERE role='marketing' AND active=1");
    res.json({ sales: sales.map(r => r.ho_ten), marketings: mkts.map(r => r.ho_ten) });
  }));

  // ===================== WEBHOOK LOG =====================
  app.get('/oms/api/webhook-log', requireRole('admin'), wrap(async (req, res) => {
    try {
      const DATA_DIR = process.env.DATA_DIR || '/home/u422036594/data';
      const fs = await import('node:fs');
      const log = fs.default.readFileSync(DATA_DIR + '/oms-webhook.log', 'utf8');
      const lines = log.trim().split('\n').slice(-100);
      res.type('text').send(lines.join('\n'));
    } catch(e) {
      res.type('text').send('(Chưa có log)');
    }
  }));

  // ===================== KHỞI TẠO =====================
  // Ensure tables khi có request đầu tiên
  let tableReady = false;
  app.use('/oms', async (req, res, next) => {
    if (!tableReady && getPool()) {
      try { await ensureTables(getPool()); tableReady = true; } catch(e) {}
    }
    next();
  });

  // Bắt đầu cronjob
  try { scheduleCronjob(); } catch(e) {}

  console.log('[OMS] Module đã gắn thành công: /oms/*');
}
