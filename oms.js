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

  // Bảng kho hàng (mỗi kho có GHTK/VTP riêng)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oms_warehouses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ten_kho VARCHAR(120) NOT NULL COMMENT 'Tên kho',
      dia_chi VARCHAR(500) DEFAULT '' COMMENT 'Địa chỉ kho',
      tinh VARCHAR(120) DEFAULT '',
      quan VARCHAR(120) DEFAULT '',
      sdt VARCHAR(50) DEFAULT '',
      ghtk_token VARCHAR(255) DEFAULT '',
      ghtk_pick_name VARCHAR(120) DEFAULT '',
      ghtk_pick_address VARCHAR(500) DEFAULT '',
      ghtk_pick_province VARCHAR(120) DEFAULT '',
      ghtk_pick_district VARCHAR(120) DEFAULT '',
      ghtk_pick_tel VARCHAR(50) DEFAULT '',
      vtp_username VARCHAR(120) DEFAULT '',
      vtp_password VARCHAR(255) DEFAULT '',
      vtp_token VARCHAR(500) DEFAULT '',
      vtp_sender_name VARCHAR(120) DEFAULT '',
      vtp_sender_address VARCHAR(500) DEFAULT '',
      vtp_sender_phone VARCHAR(50) DEFAULT '',
      active TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Thêm cột kho_id vào orders nếu chưa có
  try { await pool.query("ALTER TABLE oms_orders ADD COLUMN kho_id INT DEFAULT 0 COMMENT 'FK → oms_warehouses.id'"); } catch(e) {}

  // Bảng sản phẩm
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oms_products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ma_sp VARCHAR(60) DEFAULT '' COMMENT 'Mã sản phẩm',
      ten_sp VARCHAR(255) NOT NULL COMMENT 'Tên sản phẩm',
      gia_ban BIGINT DEFAULT 0 COMMENT 'Giá bán (VND)',
      gia_nhap BIGINT DEFAULT 0 COMMENT 'Giá nhập (VND)',
      mo_ta TEXT,
      hinh_anh VARCHAR(500) DEFAULT '',
      danh_muc VARCHAR(120) DEFAULT '' COMMENT 'Danh mục SP',
      active TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_masp (ma_sp),
      INDEX idx_tensp (ten_sp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Bảng đăng ký link: NV Marketing khai báo link → sản phẩm + NV
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oms_link_registry (
      id INT AUTO_INCREMENT PRIMARY KEY,
      url_pattern VARCHAR(500) NOT NULL COMMENT 'URL hoặc phần URL landing page',
      product_id INT DEFAULT 0 COMMENT 'FK → oms_products.id',
      ten_sp VARCHAR(255) DEFAULT '' COMMENT 'Tên SP (cache)',
      nv_marketing VARCHAR(120) NOT NULL COMMENT 'Tên NV Marketing',
      ghi_chu VARCHAR(255) DEFAULT '',
      active TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_url (url_pattern),
      INDEX idx_nv (nv_marketing)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
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
    let sanPham = d.product || d.san_pham || d.message || '';
    const soLuong = parseInt(d.quantity || d.so_luong || 1, 10) || 1;
    let gia = parseInt(d.price || d.gia || 0, 10) || 0;

    // UTM parameters → xác định nhân viên marketing
    const utmSource = d.utm_source || '';
    const utmMedium = d.utm_medium || '';
    const utmCampaign = d.utm_campaign || '';
    const utmContent = d.utm_content || '';
    let nvMarketing = d.utm_content || d.nhan_vien || d.user || d.marketing || '';

    // ---- TỰ NHẬN DIỆN từ Link Registry ----
    // Ladipage gửi kèm url_page (URL trang gửi form)
    const urlPage = d.url_page || d.page_url || d.referer || d.referrer || '';
    if (urlPage) {
      try {
        const links = await db('SELECT * FROM oms_link_registry WHERE active=1');
        for (const link of links) {
          // So khớp: URL chứa pattern đã đăng ký
          if (urlPage.toLowerCase().includes(link.url_pattern.toLowerCase())) {
            // Auto-fill NV Marketing nếu chưa có
            if (!nvMarketing) nvMarketing = link.nv_marketing;
            // Auto-fill sản phẩm nếu chưa có
            if (!sanPham && link.ten_sp) sanPham = link.ten_sp;
            // Auto-fill giá nếu chưa có
            if (!gia && link.product_id) {
              try {
                const [prod] = await db('SELECT gia_ban FROM oms_products WHERE id=?', [link.product_id]);
                if (prod?.gia_ban) gia = prod.gia_ban;
              } catch(e) {}
            }
            break; // Khớp link đầu tiên
          }
        }
      } catch(e) { console.error('[OMS] Link registry lookup error:', e.message); }
    }

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

    // Sale: sửa được thông tin đơn + chốt/huỷ chốt/không mua/quay lại đơn mới
    if (user.role === 'sale') {
      const saleAllowed = ['trang_thai','ghi_chu','sale_phu_trach','ten_kh','sdt',
        'dia_chi_full','san_pham','so_luong','gia_ban','tong_tien','phi_ship','kho_id'];
      // Sale được phép: Đơn mới, Đã chốt, Không mua (huỷ chốt/huỷ không mua → quay Đơn mới)
      if (d.trang_thai && !['Đơn mới','Đã chốt','Không mua'].includes(d.trang_thai)) {
        return res.status(403).json({ error: 'Sale không được đổi sang trạng thái này' });
      }
      const sets = []; const vals = [];
      for (const f of saleAllowed) {
        if (d[f] !== undefined) {
          sets.push(`${f}=?`); vals.push(d[f]);
          if (f === 'dia_chi_full') {
            const addr = parseAddress(d[f]);
            sets.push('tinh=?','quan=?','phuong=?','dia_chi=?');
            vals.push(addr.tinh, addr.quan, addr.phuong, addr.diaChi);
          }
        }
      }
      if (!sets.length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
      vals.push(id);
      await db(`UPDATE oms_orders SET ${sets.join(',')} WHERE id=?`, vals);
      return res.json({ ok: true });
    }

    // Admin/Warehouse có thể cập nhật hầu hết trường
    const allowedFields = ['trang_thai','ghi_chu','sale_phu_trach','don_vi_vc','ma_van_don',
      'trang_thai_vc','nv_marketing','ten_kh','sdt','dia_chi_full','san_pham',
      'so_luong','gia_ban','tong_tien','phi_ship','da_thanh_toan','kho_id'];

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
    await db('INSERT INTO oms_users (username, password, ho_ten, role) VALUES (?,?,?,?)',
      [username, password, ho_ten || username, role || 'sale']);
    res.json({ ok: true });
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

  // Xóa tài khoản (không cho xóa admin mặc định)
  app.delete('/oms/api/users/:id', requireRole('admin'), wrap(async (req, res) => {
    const [user] = await db('SELECT username FROM oms_users WHERE id=?', [req.params.id]);
    if (user?.username === 'admin') return res.status(400).json({ error: 'Không thể xóa tài khoản admin mặc định' });
    await db('DELETE FROM oms_users WHERE id=?', [req.params.id]);
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

  // ===================== Helper: lấy config GHTK/VTP từ kho hoặc config chung =====================
  async function getWarehouseConfig(khoId) {
    // Ưu tiên lấy từ kho riêng
    if (khoId) {
      const [wh] = await db('SELECT * FROM oms_warehouses WHERE id=? AND active=1', [khoId]);
      if (wh) return {
        ghtk_token: wh.ghtk_token,
        pick_name: wh.ghtk_pick_name || wh.ten_kho,
        pick_address: wh.ghtk_pick_address || wh.dia_chi,
        pick_province: wh.ghtk_pick_province || wh.tinh,
        pick_district: wh.ghtk_pick_district || wh.quan,
        pick_tel: wh.ghtk_pick_tel || wh.sdt,
        vtp_username: wh.vtp_username,
        vtp_password: wh.vtp_password,
        vtp_token: wh.vtp_token,
        vtp_sender_name: wh.vtp_sender_name || wh.ten_kho,
        vtp_sender_address: wh.vtp_sender_address || wh.dia_chi,
        vtp_sender_phone: wh.vtp_sender_phone || wh.sdt,
        ten_kho: wh.ten_kho,
      };
    }
    // Fallback: config chung
    const cfgRows = await db("SELECT config_key, config_value FROM oms_config");
    const cfg = {}; cfgRows.forEach(r => cfg[r.config_key] = r.config_value);
    return {
      ghtk_token: cfg.ghtk_token || process.env.GHTK_TOKEN || '',
      pick_name: cfg.ghtk_shop_name || process.env.GHTK_SHOP_NAME || 'Shop',
      pick_address: cfg.ghtk_pick_address || process.env.GHTK_PICK_ADDRESS || '',
      pick_province: cfg.ghtk_pick_province || process.env.GHTK_PICK_PROVINCE || '',
      pick_district: cfg.ghtk_pick_district || process.env.GHTK_PICK_DISTRICT || '',
      pick_tel: cfg.ghtk_pick_tel || process.env.GHTK_PICK_TEL || '',
      vtp_username: cfg.vtp_username || process.env.VTP_USERNAME || '',
      vtp_password: cfg.vtp_password || process.env.VTP_PASSWORD || '',
      vtp_token: cfg.vtp_token || process.env.VTP_TOKEN || '',
      vtp_sender_name: cfg.vtp_sender_name || process.env.VTP_SENDER_NAME || 'Shop',
      vtp_sender_address: cfg.vtp_sender_address || process.env.VTP_SENDER_ADDRESS || '',
      vtp_sender_phone: cfg.vtp_sender_phone || process.env.VTP_SENDER_PHONE || '',
      ten_kho: 'Kho mặc định',
    };
  }

  // ===================== ĐẨY ĐƠN GHTK =====================
  app.post('/oms/api/push-ghtk', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'Chưa chọn đơn' });

    const orders = await db(`SELECT * FROM oms_orders WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);
    const results = [];
    const apiUrl = 'https://services.giaohangtietkiem.vn';

    for (const o of orders) {
      try {
        // Lấy config từ kho của đơn
        const wCfg = await getWarehouseConfig(o.kho_id);
        if (!wCfg.ghtk_token) { results.push({ id: o.id, ok: false, error: 'Chưa cấu hình GHTK Token cho kho "'+wCfg.ten_kho+'"' }); continue; }
        if (!wCfg.pick_address) { results.push({ id: o.id, ok: false, error: 'Chưa nhập địa chỉ lấy hàng cho kho "'+wCfg.ten_kho+'"' }); continue; }

        const body = {
          products: [{ name: o.san_pham || 'Sản phẩm', weight: 0.5, quantity: o.so_luong || 1, product_code: '' }],
          order: {
            id: `OMS-${o.id}`,
            pick_name: wCfg.pick_name,
            pick_money: 0,
            pick_address: wCfg.pick_address,
            pick_province: wCfg.pick_province,
            pick_district: wCfg.pick_district,
            pick_tel: wCfg.pick_tel,
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
          headers: { 'Content-Type': 'application/json', 'Token': wCfg.ghtk_token },
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
  // Phân đơn thủ công
  app.post('/oms/api/assign-sale', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const { ids, sale } = req.body;
    if (!ids?.length || !sale) return res.status(400).json({ error: 'Thiếu đơn hoặc tên sale' });
    await db(`UPDATE oms_orders SET sale_phu_trach=? WHERE id IN (${ids.map(()=>'?').join(',')})`, [sale, ...ids]);
    res.json({ ok: true });
  }));

  // Phân đơn tự động chia đều cho tất cả Sale
  app.post('/oms/api/auto-assign', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const { ids } = req.body; // danh sách ID đơn cần phân
    // Lấy danh sách Sale đang hoạt động
    const sales = await db("SELECT ho_ten FROM oms_users WHERE role='sale' AND active=1 ORDER BY ho_ten");
    if (!sales.length) return res.status(400).json({ error: 'Chưa có nhân viên Sale nào' });

    let orderIds = ids;
    if (!orderIds?.length) {
      // Nếu không truyền IDs → phân tất cả đơn mới chưa phân
      const unassigned = await db("SELECT id FROM oms_orders WHERE trang_thai='Đơn mới' AND (sale_phu_trach='' OR sale_phu_trach IS NULL) ORDER BY id");
      orderIds = unassigned.map(r => r.id);
    }
    if (!orderIds.length) return res.json({ ok: true, message: 'Không có đơn nào cần phân' });

    // Chia đều round-robin
    const saleNames = sales.map(s => s.ho_ten);
    let assigned = 0;
    for (let i = 0; i < orderIds.length; i++) {
      const saleName = saleNames[i % saleNames.length];
      await db('UPDATE oms_orders SET sale_phu_trach=? WHERE id=?', [saleName, orderIds[i]]);
      assigned++;
    }

    res.json({ ok: true, message: `Đã phân ${assigned} đơn cho ${saleNames.length} Sale`, assigned, sales: saleNames });
  }));

  // ===================== QUẢN LÝ KHO (Admin) =====================
  app.get('/oms/api/warehouses', omsAuth, wrap(async (req, res) => {
    const rows = await db('SELECT * FROM oms_warehouses WHERE active=1 ORDER BY ten_kho');
    res.json(rows);
  }));

  app.get('/oms/api/warehouses/all', requireRole('admin'), wrap(async (req, res) => {
    const rows = await db('SELECT * FROM oms_warehouses ORDER BY ten_kho');
    res.json(rows);
  }));

  app.post('/oms/api/warehouses', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const d = req.body;
    if (!d.ten_kho) return res.status(400).json({ error: 'Thiếu tên kho' });
    const result = await db(`INSERT INTO oms_warehouses
      (ten_kho, dia_chi, tinh, quan, sdt,
       ghtk_token, ghtk_pick_name, ghtk_pick_address, ghtk_pick_province, ghtk_pick_district, ghtk_pick_tel,
       vtp_username, vtp_password, vtp_sender_name, vtp_sender_address, vtp_sender_phone)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.ten_kho, d.dia_chi||'', d.tinh||'', d.quan||'', d.sdt||'',
       d.ghtk_token||'', d.ghtk_pick_name||'', d.ghtk_pick_address||'', d.ghtk_pick_province||'', d.ghtk_pick_district||'', d.ghtk_pick_tel||'',
       d.vtp_username||'', d.vtp_password||'', d.vtp_sender_name||'', d.vtp_sender_address||'', d.vtp_sender_phone||'']);
    res.json({ ok: true, id: result.insertId });
  }));

  app.put('/oms/api/warehouses/:id', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const d = req.body;
    const fields = ['ten_kho','dia_chi','tinh','quan','sdt','active',
      'ghtk_token','ghtk_pick_name','ghtk_pick_address','ghtk_pick_province','ghtk_pick_district','ghtk_pick_tel',
      'vtp_username','vtp_password','vtp_token','vtp_sender_name','vtp_sender_address','vtp_sender_phone'];
    const sets = []; const vals = [];
    for (const f of fields) { if (d[f] !== undefined) { sets.push(`${f}=?`); vals.push(d[f]); } }
    if (!sets.length) return res.status(400).json({ error: 'Không có gì' });
    vals.push(req.params.id);
    await db(`UPDATE oms_warehouses SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  }));

  app.delete('/oms/api/warehouses/:id', requireRole('admin'), wrap(async (req, res) => {
    await db('DELETE FROM oms_warehouses WHERE id=?', [req.params.id]);
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

  // ===================== QUẢN LÝ SẢN PHẨM =====================
  app.get('/oms/api/products', omsAuth, wrap(async (req, res) => {
    const { q, danh_muc, active } = req.query;
    let where = ['1=1'];
    let params = [];
    if (q) { where.push('(ten_sp LIKE ? OR ma_sp LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (danh_muc) { where.push('danh_muc = ?'); params.push(danh_muc); }
    if (active !== undefined) { where.push('active = ?'); params.push(active); }
    const rows = await db(`SELECT * FROM oms_products WHERE ${where.join(' AND ')} ORDER BY ten_sp`, params);
    res.json(rows);
  }));

  app.post('/oms/api/products', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const d = req.body;
    if (!d.ten_sp) return res.status(400).json({ error: 'Thiếu tên sản phẩm' });
    const result = await db(`INSERT INTO oms_products (ma_sp, ten_sp, gia_ban, gia_nhap, mo_ta, hinh_anh, danh_muc)
      VALUES (?,?,?,?,?,?,?)`,
      [d.ma_sp||'', d.ten_sp, d.gia_ban||0, d.gia_nhap||0, d.mo_ta||'', d.hinh_anh||'', d.danh_muc||'']);
    res.json({ ok: true, id: result.insertId });
  }));

  app.put('/oms/api/products/:id', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const d = req.body;
    const fields = ['ma_sp','ten_sp','gia_ban','gia_nhap','mo_ta','hinh_anh','danh_muc','active'];
    const sets = []; const vals = [];
    for (const f of fields) { if (d[f] !== undefined) { sets.push(`${f}=?`); vals.push(d[f]); } }
    if (!sets.length) return res.status(400).json({ error: 'Không có gì' });
    vals.push(req.params.id);
    await db(`UPDATE oms_products SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  }));

  app.delete('/oms/api/products/:id', requireRole('admin'), wrap(async (req, res) => {
    await db('DELETE FROM oms_products WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  }));

  // Import sản phẩm hàng loạt (từ array JSON)
  app.post('/oms/api/products/import', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const items = req.body.items || [];
    if (!items.length) return res.status(400).json({ error: 'Danh sách rỗng' });
    let inserted = 0;
    for (const d of items) {
      if (!d.ten_sp) continue;
      try {
        await db(`INSERT INTO oms_products (ma_sp, ten_sp, gia_ban, gia_nhap, mo_ta, danh_muc)
          VALUES (?,?,?,?,?,?)`,
          [d.ma_sp||'', d.ten_sp, d.gia_ban||0, d.gia_nhap||0, d.mo_ta||'', d.danh_muc||'']);
        inserted++;
      } catch(e) { /* bỏ qua duplicate */ }
    }
    res.json({ ok: true, inserted, total: items.length });
  }));

  // Lấy danh mục SP (cho dropdown)
  app.get('/oms/api/products/categories', omsAuth, wrap(async (req, res) => {
    const rows = await db("SELECT DISTINCT danh_muc FROM oms_products WHERE danh_muc != '' AND active=1 ORDER BY danh_muc");
    res.json(rows.map(r => r.danh_muc));
  }));

  // ===================== ĐỒNG BỘ SẢN PHẨM TỪ GOOGLE SHEET =====================
  // Đọc SHEET_CSV_URL (đã cấu hình sẵn trong .env), lấy cột Sản phẩm + Giá nhập
  // Upsert: nếu SP đã có (theo tên) → cập nhật giá, nếu chưa → thêm mới
  app.post('/oms/api/products/sync-sheet', requireRole('admin'), wrap(async (req, res) => {
    const csvUrl = process.env.SHEET_CSV_URL || '';
    if (!csvUrl) return res.status(400).json({ error: 'Chưa khai biến SHEET_CSV_URL trên server' });

    // Đọc CSV từ Google Sheet
    const resp = await fetch(csvUrl, { redirect: 'follow' });
    if (!resp.ok) return res.status(502).json({ error: 'Không đọc được Google Sheet: HTTP ' + resp.status });
    const text = await resp.text();

    // Parse CSV (tự nhận dấu phân tách)
    const firstLine = (text.split(/\r?\n/)[0] || '');
    const nch = ch => (firstLine.split(ch).length - 1);
    let delim = ',';
    if (nch('\t') > nch(delim)) delim = '\t';
    if (nch(';') > nch(delim)) delim = ';';

    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cur.trim()); cur = ''; }
      else if (c === '\n') { row.push(cur.trim()); if (row.some(c => c)) rows.push(row); row = []; cur = ''; }
      else if (c === '\r') {}
      else cur += c;
    }
    if (cur || row.length) { row.push(cur.trim()); if (row.some(c => c)) rows.push(row); }

    if (rows.length < 2) return res.status(400).json({ error: 'Sheet rỗng hoặc không đọc được dữ liệu' });

    // Tìm cột Sản phẩm + Giá nhập từ header
    const hdr = rows[0].map(h => h.toLowerCase().replace(/\s+/g, ' '));
    const find = (keys) => hdr.findIndex(h => keys.some(k => h.includes(k)));

    const colSP = find(['sản phẩm', 'san pham', 'sanpham', 'product', 'tên sp', 'ten sp']);
    const colGiaNhap = find(['giá nhập', 'gia nhap', 'gianhap', 'giá vốn', 'gia von', 'cost']);
    const colQuanLy = find(['quản lý', 'quan ly', 'phụ trách', 'phu trach', 'manager']);
    const colDanhMuc = find(['danh mục', 'danh muc', 'loại', 'loai', 'category']);
    const colMaSP = find(['mã sp', 'ma sp', 'masp', 'sku', 'code']);
    const colGiaBan = find(['giá bán', 'gia ban', 'giaban', 'price', 'selling']);

    if (colSP < 0) return res.status(400).json({
      error: 'Không tìm thấy cột "Sản phẩm" trong Sheet. Header: ' + rows[0].join(' | '),
      hint: 'Đổi tên cột chứa tên SP thành "Sản phẩm" hoặc "Tên SP"'
    });

    const toNum = v => {
      const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
      return isNaN(n) ? 0 : n;
    };

    // Đọc SP hiện có trong DB (để upsert theo tên)
    const existing = await db('SELECT id, ten_sp FROM oms_products');
    const existMap = {};
    existing.forEach(p => { existMap[p.ten_sp.trim().toLowerCase()] = p.id; });

    let added = 0, updated = 0, skipped = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const tenSP = (r[colSP] || '').trim();
      if (!tenSP) { skipped++; continue; }

      const giaNhap = colGiaNhap >= 0 ? toNum(r[colGiaNhap]) : 0;
      const giaBan = colGiaBan >= 0 ? toNum(r[colGiaBan]) : 0;
      const quanLy = colQuanLy >= 0 ? (r[colQuanLy] || '').trim() : '';
      const danhMuc = colDanhMuc >= 0 ? (r[colDanhMuc] || '').trim() : '';
      const maSP = colMaSP >= 0 ? (r[colMaSP] || '').trim() : '';

      const key = tenSP.toLowerCase();

      if (existMap[key]) {
        // Cập nhật giá nhập + giá bán (nếu có)
        const sets = ['gia_nhap=?'];
        const vals = [giaNhap];
        if (giaBan) { sets.push('gia_ban=?'); vals.push(giaBan); }
        if (danhMuc) { sets.push('danh_muc=?'); vals.push(danhMuc); }
        if (maSP) { sets.push('ma_sp=?'); vals.push(maSP); }
        vals.push(existMap[key]);
        await db(`UPDATE oms_products SET ${sets.join(',')} WHERE id=?`, vals);
        updated++;
      } else {
        // Thêm mới
        try {
          await db(`INSERT INTO oms_products (ma_sp, ten_sp, gia_ban, gia_nhap, danh_muc, mo_ta)
            VALUES (?,?,?,?,?,?)`, [maSP, tenSP, giaBan, giaNhap, danhMuc, quanLy ? 'QL: ' + quanLy : '']);
          existMap[key] = true; // tránh duplicate trong cùng lần sync
          added++;
        } catch(e) { skipped++; }
      }
    }

    res.json({
      ok: true,
      message: `Đồng bộ xong: ${added} SP mới, ${updated} cập nhật, ${skipped} bỏ qua`,
      added, updated, skipped,
      sheetRows: rows.length - 1,
      columns: { sp: colSP, giaNhap: colGiaNhap, giaBan: colGiaBan, danhMuc: colDanhMuc, quanLy: colQuanLy, maSP: colMaSP },
      header: rows[0]
    });
  }));

  // ===================== ĐĂNG KÝ LINK (NV Marketing khai báo) =====================
  app.get('/oms/api/links', omsAuth, wrap(async (req, res) => {
    const user = req.session.omsUser;
    let where = ['1=1'];
    let params = [];
    // Marketing chỉ xem link của mình
    if (user.role === 'marketing') {
      where.push('nv_marketing = ?');
      params.push(user.ho_ten);
    }
    const rows = await db(`SELECT lr.*, p.ten_sp as product_name, p.gia_ban as product_price
      FROM oms_link_registry lr
      LEFT JOIN oms_products p ON lr.product_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY lr.created_at DESC`, params);
    res.json(rows);
  }));

  app.post('/oms/api/links', omsAuth, jsonParser, wrap(async (req, res) => {
    const d = req.body;
    const user = req.session.omsUser;
    if (!d.url_pattern) return res.status(400).json({ error: 'Thiếu URL landing page' });
    if (!d.product_id) return res.status(400).json({ error: 'Chưa chọn sản phẩm' });

    // NV Marketing: tự ghi tên mình. Admin: chọn NV bất kỳ
    const nvName = user.role === 'admin' ? (d.nv_marketing || user.ho_ten) : user.ho_ten;

    // Lấy tên SP để cache vào link registry
    let tenSp = '';
    try {
      const [prod] = await db('SELECT ten_sp FROM oms_products WHERE id=?', [d.product_id]);
      tenSp = prod?.ten_sp || '';
    } catch(e) {}

    const result = await db(`INSERT INTO oms_link_registry (url_pattern, product_id, ten_sp, nv_marketing, ghi_chu)
      VALUES (?,?,?,?,?)`,
      [d.url_pattern, d.product_id, tenSp, nvName, d.ghi_chu||'']);
    res.json({ ok: true, id: result.insertId });
  }));

  app.put('/oms/api/links/:id', omsAuth, jsonParser, wrap(async (req, res) => {
    const d = req.body;
    const user = req.session.omsUser;
    // Marketing chỉ sửa link của mình
    if (user.role === 'marketing') {
      const [existing] = await db('SELECT nv_marketing FROM oms_link_registry WHERE id=?', [req.params.id]);
      if (existing?.nv_marketing !== user.ho_ten) return res.status(403).json({ error: 'Không phải link của bạn' });
    }
    const sets = []; const vals = [];
    if (d.url_pattern) { sets.push('url_pattern=?'); vals.push(d.url_pattern); }
    if (d.product_id) {
      sets.push('product_id=?'); vals.push(d.product_id);
      try { const [p] = await db('SELECT ten_sp FROM oms_products WHERE id=?', [d.product_id]); sets.push('ten_sp=?'); vals.push(p?.ten_sp||''); } catch(e) {}
    }
    if (d.ghi_chu !== undefined) { sets.push('ghi_chu=?'); vals.push(d.ghi_chu); }
    if (d.active !== undefined) { sets.push('active=?'); vals.push(d.active); }
    if (d.nv_marketing && user.role === 'admin') { sets.push('nv_marketing=?'); vals.push(d.nv_marketing); }
    if (!sets.length) return res.status(400).json({ error: 'Không có gì' });
    vals.push(req.params.id);
    await db(`UPDATE oms_link_registry SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  }));

  app.delete('/oms/api/links/:id', requireRole('admin'), wrap(async (req, res) => {
    await db('DELETE FROM oms_link_registry WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  }));

  // ===================== KHỞI TẠO =====================
  // CHẶN SERVICE WORKER CACHE cho tất cả API OMS
  app.use('/oms', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

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
