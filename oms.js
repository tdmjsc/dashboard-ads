// =====================================================================
//  MODULE QUẢN LÝ ĐƠN HÀNG (OMS) — oms.js
//  Pattern giống thailand.js: AN TOÀN, lazy DB, try/catch toàn bộ
//  Mount vào server.js: mountOMS(app, { mysql, express })
// =====================================================================
import { sendApns, apnsConfigured } from './apns.js';
import { sendFcm, fcmConfigured } from './fcm.js';
import { omsDateBoundary } from './oms-date.js';
import { adRefFromUtm, hasUtm, findFbclid, adIdFromFbclid, utmFromUrl, landingKey, guessByLanding, landingCands, campLandings, addLandingHist, AD_REF_FROM } from './oms-ad-ref.js';

// ---- Trạng thái đơn hàng hợp lệ ----
const TRANG_THAI = ['Đơn mới', 'Đã chốt', 'Đang ship', 'Ship thành công', 'Hoàn thành công', 'Không mua',
  'KNM lần 1', 'KNM lần 2', 'KNM lần 3', 'KNM lần 4', 'KNM lần 5', 'KNM lần 6'];

// Cùng nguồn cơ cấu team với trang nhân viên; luôn gồm đơn của chính mình.
export function getOmsMarketingTeam(user, getTeamLead) {
  if (user.role !== 'marketing') return null;
  const members = getTeamLead()[user.ho_ten] || [];
  return [...new Set([user.ho_ten, ...members])];
}

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

// ---- Quyền xem chi nhánh của sale / kho (oms_users.xem_chi_nhanh) ----
// '' = chỉ chi nhánh chính, '*' = mọi chi nhánh, '2,3' = chi nhánh chính + các chi nhánh này.
// Trả mảng id được xem (luôn có chi nhánh chính) hoặc null = mọi chi nhánh.
export function parseXemCn(chinh, xem) {
  const c = Number(chinh) || 1, v = String(xem || '').trim();
  if (v === '*') return null;
  return [...new Set([c, ...v.split(',').map(Number).filter(n => Number.isInteger(n) && n > 0)])];
}
// Chuẩn hoá giá trị gửi lên (mảng id, chuỗi '1,2' hoặc '*'); null = không hợp lệ
export function normXemCn(v) {
  if (v === undefined || v === null || v === '') return '';
  if (v === '*' || v === 'all') return '*';
  const ids = (Array.isArray(v) ? v : String(v).split(',')).map(x => Number(String(x).trim()));
  if (ids.some(n => !Number.isInteger(n) || n <= 0)) return null;
  return [...new Set(ids)].sort((a, b) => a - b).join(',');
}

// Số điện thoại chuẩn để so trùng: chỉ chữ số, 84xxxxxxxxx → 0xxxxxxxxx, 9 số thiếu 0 đầu → thêm 0
export function normPhone(v) {
  let s = String(v || '').replace(/\D/g, '');
  if (s.startsWith('84') && s.length >= 11) s = '0' + s.slice(2);
  else if (s.length === 9 && !s.startsWith('0')) s = '0' + s;
  return s.slice(0, 20);
}

// ---- Tạo bảng nếu chưa có ----
// Chạy 1 lần mỗi tiến trình (trước đây chạy lại ~60 câu CREATE/ALTER mỗi lần tải đơn); lỗi thì lần sau thử lại
let tablesReady = null;
function ensureTables(pool) {
  if (!tablesReady) tablesReady = ensureTablesNow(pool).catch(e => { tablesReady = null; throw e; });
  return tablesReady;
}
async function ensureTablesNow(pool) {
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
      ma_don_hang VARCHAR(50) DEFAULT '' COMMENT 'Mã đơn hàng gửi VC (unique, có thể đổi)',
      trang_thai_vc VARCHAR(100) DEFAULT '' COMMENT 'Trạng thái từ đơn vị vận chuyển',
      da_xuat_hd TINYINT DEFAULT 0 COMMENT 'Đã xuất hóa đơn Misa chưa',
      misa_invoice_id VARCHAR(100) DEFAULT '',
      san_pham TEXT COMMENT 'Tên/mô tả sản phẩm',
      so_luong INT DEFAULT 1,
      gia_ban BIGINT DEFAULT 0 COMMENT 'Giá bán (VND)',
      tong_tien BIGINT DEFAULT 0 COMMENT 'Tổng tiền (VND)',
      phi_ship BIGINT DEFAULT 0,
      dat_coc BIGINT DEFAULT 0 COMMENT 'Tiền khách đặt cọc',
      tin_nhan_goc TEXT COMMENT 'Tin nhắn gốc từ Ladipage (giữ nguyên toàn bộ)',
      nguon_du_lieu VARCHAR(120) DEFAULT '' COMMENT 'Nguồn dữ liệu (Facebook, Google...)',
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
    "ma_don_hang VARCHAR(50) DEFAULT ''",
    "dat_coc BIGINT DEFAULT 0",
    "tin_nhan_goc TEXT",
    "nguon_du_lieu VARCHAR(120) DEFAULT ''",
    "utm_term VARCHAR(255) DEFAULT ''",
    // Chiến dịch / nhóm / quảng cáo Meta của đơn (tra từ UTM, xem oms-ad-ref.js); fb_ref_at = lúc tra
    "fb_campaign_id VARCHAR(32) DEFAULT ''",
    "fb_campaign_name VARCHAR(255) DEFAULT ''",
    "fb_adset_id VARCHAR(32) DEFAULT ''",
    "fb_adset_name VARCHAR(255) DEFAULT ''",
    "fb_ad_id VARCHAR(32) DEFAULT ''",
    "fb_ref_at DATETIME NULL",
    // fbclid (có ID quảng cáo, kể cả khi khách bấm link trong bình luận) + URL trang Ladipage gửi về
    "fbclid VARCHAR(512) DEFAULT ''",
    "url_page VARCHAR(1000) DEFAULT ''",
    // adid (ID ad nội bộ Meta) giải từ fbclid, '-' = có fbclid mà không có adid (xem oms-ad-ref.js)
    "fb_adid VARCHAR(32) DEFAULT ''",
    // 'trang' = chiến dịch / nhóm ghép dự phòng theo trang đích + NV (guessByLanding), '' = ghép chắc chắn / chưa ra
    "fb_ref_src VARCHAR(8) DEFAULT ''",
    // ---- Tác nghiệp sale (giờ UTC như ngay_ve) ----
    "hen_goi_lai DATETIME NULL",            // hẹn gọi lại; tới giờ nhắc sale phụ trách (hen_goi_bao = đã nhắc)
    "hen_goi_bao TINYINT DEFAULT 0",
    "sale_nhan_at DATETIME NULL",           // lúc sale hiện tại nhận đơn (chia / chuyển)
    "sale_tac_nghiep_at DATETIME NULL",     // lần tác nghiệp đầu của sale hiện tại (NULL quá hạn → thu hồi)
    "tac_nghiep_dau_at DATETIME NULL",      // lần tác nghiệp đầu tiên của đơn (thời gian phản hồi = từ ngay_ve)
    "sdt_norm VARCHAR(20) DEFAULT ''",      // SĐT chuẩn để báo trùng số / khách cũ
    // ---- Kho ----
    "chot_at DATETIME NULL",                // lúc chốt → hạn gửi hàng
    "dang_vc_at DATETIME NULL",
    "da_dong_goi TINYINT DEFAULT 0",        // quét mã khi đóng gói
    "da_doi_soat TINYINT DEFAULT 0",
    "doi_soat_at DATETIME NULL",
    "phi_vc_dv BIGINT DEFAULT 0",           // phí vận chuyển dịch vụ (shop trả hãng VC)
    "phi_hoan BIGINT DEFAULT 0",
    "da_nhan_hoan TINYINT DEFAULT 0",
    "nhan_hoan_at DATETIME NULL",
    "ly_do_hoan VARCHAR(255) DEFAULT ''",
    "nguoi_giao VARCHAR(120) DEFAULT ''",    // giao thủ công: shipper ngoài / người giao
  ];
  for (const col of addCols) {
    try { await pool.query(`ALTER TABLE oms_orders ADD COLUMN ${col}`); } catch(e) {}
  }
  try { await pool.query('ALTER TABLE oms_orders ADD INDEX idx_fb_camp (fb_campaign_id)'); } catch(e) {}
  try { await pool.query('ALTER TABLE oms_orders ADD INDEX idx_fb_adid (fb_adid)'); } catch(e) {}
  try { await pool.query('ALTER TABLE oms_orders ADD INDEX idx_hen (hen_goi_bao, hen_goi_lai)'); } catch(e) {}
  try { await pool.query('ALTER TABLE oms_orders ADD INDEX idx_sdtn (sdt_norm)'); } catch(e) {}

  // Lịch sử tác nghiệp từng đơn (ai làm gì, lúc nào) — không ghi đè như ô ghi chú
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oms_order_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      at DATETIME NOT NULL,
      nguoi VARCHAR(120) DEFAULT '',
      hanh_dong VARCHAR(60) DEFAULT '',
      chi_tiet TEXT,
      INDEX idx_order (order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Thư viện adid → quảng cáo (oms-ad-ref.js). nguon: utm (học từ lượt bấm nút có {{ad.id}}), admin
  // (thêm tay), seed (cặp đã đối chiếu 30/10/2026). xung_dot = ID quảng cáo khác mà UTM từng báo cho
  // cùng adid → không dùng cặp này nữa cho tới khi admin chọn lại.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oms_adid_map (
      adid VARCHAR(32) PRIMARY KEY,
      ad_id VARCHAR(32) NOT NULL,
      adset_id VARCHAR(32) DEFAULT '',
      adset_name VARCHAR(255) DEFAULT '',
      campaign_id VARCHAR(32) DEFAULT '',
      campaign_name VARCHAR(255) DEFAULT '',
      nguon VARCHAR(16) DEFAULT 'utm',
      so_lan INT DEFAULT 1,
      xung_dot VARCHAR(32) DEFAULT '',
      nguoi_them VARCHAR(120) DEFAULT '',
      first_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ad (ad_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await pool.query(`INSERT IGNORE INTO oms_adid_map (adid, ad_id, nguon, first_at, last_at)
    SELECT v.adid, v.ad_id, 'seed', UTC_TIMESTAMP(), UTC_TIMESTAMP() FROM (
      SELECT '52658161396313' AS adid, '52658160753113' AS ad_id UNION ALL SELECT '120251445125380239', '120251444343590239'
      UNION ALL SELECT '120250273826300239', '120250219632360239' UNION ALL SELECT '120250334187870239', '120250334107070239'
      UNION ALL SELECT '120251439971880239', '120251024356440239' UNION ALL SELECT '120251119076100239', '120249791491370239') v`);

  // Thêm cột mới cho link_registry (nếu chưa có)
  try { await pool.query(`ALTER TABLE oms_link_registry ADD COLUMN nguon_du_lieu VARCHAR(120) DEFAULT ''`); } catch(e) {}

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
      nguon_du_lieu VARCHAR(120) DEFAULT '' COMMENT 'Nguồn dữ liệu (Facebook, Google, Tiktok...)',
      ghi_chu VARCHAR(255) DEFAULT '',
      active TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_url (url_pattern),
      INDEX idx_nv (nv_marketing)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Chi nhánh (cơ sở): 1 = HKD TD (có sẵn), 2 = HKD Thắng. Mỗi chi nhánh xuất HĐ điện tử bằng MST + tài khoản
  // MISA riêng. Sale / kho thuộc 1 chi nhánh, chỉ thấy đơn chi nhánh đó; admin / marketing thấy cả hai.
  // Đơn, link, tài khoản cũ mặc định chi nhánh 1. Kho hàng chi_nhanh_id 0 = dùng chung.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oms_branches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ten VARCHAR(120) NOT NULL,
      ma_so_thue VARCHAR(30) DEFAULT '',
      misa_app_id VARCHAR(255) DEFAULT '',
      misa_access_token TEXT,
      active TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // HKD TD nhận cấu hình MISA chung đang có (oms_config) ở lần tạo đầu tiên
  await pool.query(`INSERT IGNORE INTO oms_branches (id, ten, ma_so_thue, misa_app_id, misa_access_token) VALUES (1, 'HKD TD',
    IFNULL((SELECT config_value FROM oms_config WHERE config_key='misa_tax_code'), ''),
    IFNULL((SELECT config_value FROM oms_config WHERE config_key='misa_app_id'), ''),
    IFNULL((SELECT config_value FROM oms_config WHERE config_key='misa_access_token'), ''))`);
  await pool.query(`INSERT IGNORE INTO oms_branches (id, ten, misa_access_token) VALUES (2, 'HKD Thắng', '')`);
  for (const t of ['oms_orders', 'oms_users', 'oms_link_registry']) {
    try { await pool.query(`ALTER TABLE ${t} ADD COLUMN chi_nhanh_id INT NOT NULL DEFAULT 1`); } catch(e) {}
  }
  try { await pool.query('ALTER TABLE oms_warehouses ADD COLUMN chi_nhanh_id INT NOT NULL DEFAULT 0'); } catch(e) {}
  // Quyền xem đơn của sale / kho: '' = chỉ chi nhánh chính (chi_nhanh_id), '*' = mọi chi nhánh, '2,3' = thêm các chi nhánh này
  try { await pool.query("ALTER TABLE oms_users ADD COLUMN xem_chi_nhanh VARCHAR(100) NOT NULL DEFAULT ''"); } catch(e) {}
  // Sale đang nhận đơn tự chia (0 = tạm ngừng: nghỉ, hết ca)
  try { await pool.query('ALTER TABLE oms_users ADD COLUMN nhan_don TINYINT NOT NULL DEFAULT 1'); } catch(e) {}
  try { await pool.query('ALTER TABLE oms_orders ADD INDEX idx_cn (chi_nhanh_id)'); } catch(e) {}
}

// =====================================================================
//  mountOMS(app, { mysql, express })
// =====================================================================
export function mountOMS(app, { mysql, express, getTeamLead = () => ({}) }) {
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

  // ---- Cột NV marketing mang ID quảng cáo / tên chiến dịch → tên NV (hàm ở server.js) ----
  async function resolveMkt(v) {
    try {
      return typeof global.__mktToEmployee === 'function' ? await global.__mktToEmployee(v) : '';
    } catch (e) { console.error('[OMS] Đổi NV MKT lỗi:', e.message); return ''; }
  }
  // Tên đã là tài khoản OMS (vd NV chưa có trong menu Nhân viên) thì giữ nguyên, không nhận diện lại
  async function omsNames() {
    return new Set((await db('SELECT ho_ten FROM oms_users')).map(r => r.ho_ten));
  }
  // Sửa đơn cũ: chạy lúc khởi động và mỗi 30 phút, xem/chạy tay /oms/api/fix-mkt-ids
  async function fixMktIds() {
    const known = await omsNames();
    const rows = await db(`SELECT nv_marketing AS id, COUNT(*) AS don FROM oms_orders
      WHERE nv_marketing != '' GROUP BY nv_marketing`);
    const out = [];
    for (const r of rows) {
      if (known.has(r.id)) continue;
      const ten = await resolveMkt(r.id);
      if (ten === r.id) continue; // đã đúng tên
      if (ten) await db('UPDATE oms_orders SET nv_marketing=? WHERE nv_marketing=?', [ten, r.id]);
      out.push({ id: r.id, don: r.don, ten: ten || null });
    }
    return out;
  }
  setTimeout(function loop() {
    if (getPool()) fixMktIds().catch(e => console.error('[OMS] fixMktIds:', e.message))
      .then(() => fixAdRefs()).catch(e => console.error('[OMS] fixAdRefs:', e.message));
    setTimeout(loop, 30 * 60 * 1000);
  }, 60 * 1000);

  // ---- Đơn → chiến dịch / nhóm quảng cáo Meta (thống kê đơn theo chiến dịch ở trang Ads) ----
  // Hàm tra Graph API ở server.js (global.__fbAdRef). Chỉ đơn từ AD_REF_FROM.
  function lookupAdRef(u) {
    if (typeof global.__fbAdRef !== 'function') throw new Error('Chưa nạp hàm tra ID Meta');
    return adRefFromUtm(u, { byId: global.__fbAdRef, adidRef, learn: (adid, ref) => learnAdid(adid, ref, 'utm') });
  }
  // Đơn Thái (thailand.js) tra cùng cách, dùng chung thư viện adid
  global.__omsLookupAdRef = async u => {
    if (!getPool()) throw new Error('OMS DB chưa cấu hình');
    await ensureTables(getPool());
    return lookupAdRef(u);
  };
  const fbAdidOf = fbclid => adIdFromFbclid(fbclid) || (String(fbclid || '').trim() ? '-' : '');
  const NO_UTM_ID = ['utm_campaign', 'utm_medium', 'utm_term', 'utm_content'].map(k => `${k} NOT REGEXP '^[0-9]{10,}$'`).join(' AND ');

  // Thư viện adid: cặp chưa có tên nhóm / chiến dịch (seed, thêm tay) thì tra ID quảng cáo rồi ghi lại
  async function adidRef(adid) {
    const [row] = await db('SELECT * FROM oms_adid_map WHERE adid=?', [adid]);
    if (!row || row.xung_dot) return null;
    if (row.campaign_id) return row;
    const r = await global.__fbAdRef(row.ad_id);
    if (!r?.campaign_id) return null;
    await db('UPDATE oms_adid_map SET adset_id=?, adset_name=?, campaign_id=?, campaign_name=? WHERE adid=?',
      [r.adset_id || '', (r.adset_name || '').slice(0, 255), r.campaign_id, (r.campaign_name || '').slice(0, 255), adid]);
    return { ...r, ad_id: row.ad_id };
  }
  // Ghi cặp adid → quảng cáo. Cặp mới (hoặc admin chọn lại) → ghép ngay các đơn mang adid đó mà chưa ra
  // chiến dịch (đơn từ link trong bài / bình luận về trước khi học được). UTM báo quảng cáo khác cho adid đã
  // có → đánh dấu xung đột, không tự đổi.
  async function learnAdid(adid, ref, nguon, nguoi = '') {
    const vals = [ref.ad_id, ref.adset_id || '', (ref.adset_name || '').slice(0, 255), ref.campaign_id || '',
      (ref.campaign_name || '').slice(0, 255)];
    const [row] = await db('SELECT ad_id FROM oms_adid_map WHERE adid=?', [adid]);
    if (!row) {
      const r = await db(`INSERT IGNORE INTO oms_adid_map (adid, ad_id, adset_id, adset_name, campaign_id, campaign_name, nguon,
        nguoi_them, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [adid, ...vals, nguon, nguoi]);
      if (r.affectedRows) await regroupAdid(adid, ref);
      return 'moi';
    }
    if (row.ad_id === ref.ad_id) {
      await db(`UPDATE oms_adid_map SET so_lan=so_lan+1, last_at=UTC_TIMESTAMP(), adset_id=?, adset_name=?, campaign_id=?,
        campaign_name=?${nguon === 'admin' ? ", xung_dot='', nguon='admin', nguoi_them=?" : ''} WHERE adid=?`,
        [...vals.slice(1), ...(nguon === 'admin' ? [nguoi] : []), adid]);
      if (nguon === 'admin') await regroupAdid(adid, ref);
      return 'cu';
    }
    if (nguon !== 'admin') {
      await db('UPDATE oms_adid_map SET xung_dot=?, last_at=UTC_TIMESTAMP() WHERE adid=?', [ref.ad_id, adid]);
      return 'xung_dot';
    }
    await db(`UPDATE oms_adid_map SET ad_id=?, adset_id=?, adset_name=?, campaign_id=?, campaign_name=?, nguon='admin',
      xung_dot='', nguoi_them=?, last_at=UTC_TIMESTAMP() WHERE adid=?`, [...vals, nguoi, adid]);
    await regroupAdid(adid, ref, row.ad_id);
    return 'doi';
  }
  // Đơn mang adid chưa ra chiến dịch; oldAd: đơn trước đó ghép theo cặp cũ (không có ID số trong UTM)
  async function regroupAdid(adid, ref, oldAd) {
    if (!ref.campaign_id) return null;
    if (typeof global.__thaiRegroupAdid === 'function') {
      await Promise.resolve(global.__thaiRegroupAdid(adid, ref, oldAd)).catch(e => console.error('[OMS] ghép adid đơn Thái:', e.message));
    }
    return saveAdRef(`ngay_ve >= ? AND fb_adid=? AND (fb_campaign_id='' OR fb_ref_src='trang'${oldAd ? ` OR (fb_ad_id=? AND ${NO_UTM_ID})` : ''})`,
      [omsDateBoundary(AD_REF_FROM), adid, ...(oldAd ? [oldAd] : [])], ref);
  }
  // Điền fb_adid cho đơn có fbclid về trước khi có cột (chạy trong fixAdRefs)
  async function fillFbAdid() {
    const rows = await db(`SELECT id, fbclid FROM oms_orders WHERE fbclid!='' AND fb_adid='' LIMIT 5000`);
    for (const r of rows) await db('UPDATE oms_orders SET fb_adid=? WHERE id=?', [fbAdidOf(r.fbclid), r.id]);
    return rows.length;
  }
  // Ghi kết quả tra cho các đơn khớp where; tra không ra vẫn ghi fb_ref_at để không tra lại mãi
  function saveAdRef(where, params, ref) {
    return db(`UPDATE oms_orders SET fb_campaign_id=?, fb_campaign_name=?, fb_adset_id=?, fb_adset_name=?,
      fb_ad_id=?, fb_ref_src='', fb_ref_at=UTC_TIMESTAMP() WHERE ${where}`,
      [ref.campaign_id || '', (ref.campaign_name || '').slice(0, 255), ref.adset_id || '',
       (ref.adset_name || '').slice(0, 255), ref.ad_id || '', ...params]);
  }
  // Tra cho đơn mà lúc về tra lỗi + đơn 14 ngày gần đây chưa ra chiến dịch (tra lại mỗi 6 giờ:
  // token có thể vừa được cấp quyền). Gom theo bộ UTM → mỗi bộ tra 1 lần. Đơn trước AD_REF_FROM bỏ qua.
  // all=1 (/oms/api/fix-ad-refs?all=1): tra lại mọi đơn từ AD_REF_FROM.
  let fixingAdRefs = false;
  async function fixAdRefs(all = false) {
    if (fixingAdRefs) return { busy: true };
    fixingAdRefs = true;
    try {
      await ensureTables(getPool()); // cột fb_* có thể chưa có khi máy chủ chưa nhận đơn nào
      const dienAdid = await fillFbAdid();
      // Đơn chưa ra chiến dịch mà adid đã có trong thư viện (cặp nhập sẵn / thêm tay / học sau) → ghép ngay
      const pend = await db(`SELECT DISTINCT o.fb_adid FROM oms_orders o JOIN oms_adid_map m ON m.adid=o.fb_adid AND m.xung_dot=''
        WHERE o.ngay_ve >= ? AND (o.fb_campaign_id='' OR o.fb_ref_src='trang')`, [omsDateBoundary(AD_REF_FROM)]);
      let ghepAdid = 0;
      for (const { fb_adid } of pend) {
        const ref = await adidRef(fb_adid).catch(() => null);
        if (ref) { await regroupAdid(fb_adid, ref); ghepAdid++; }
      }
      const cond = all ? '1=1' : `(fb_ref_at IS NULL OR (fb_campaign_id='' AND fb_ref_at < UTC_TIMESTAMP() - INTERVAL 6 HOUR
        AND ngay_ve > UTC_TIMESTAMP() - INTERVAL 14 DAY))`;
      const rows = await db(`SELECT utm_campaign, utm_medium, utm_term, utm_content, fbclid, COUNT(*) AS don
        FROM oms_orders WHERE ngay_ve >= ?
        AND (utm_campaign!='' OR utm_medium!='' OR utm_term!='' OR utm_content!='' OR fbclid!='')
        AND ${cond} GROUP BY utm_campaign, utm_medium, utm_term, utm_content, fbclid ORDER BY MAX(ngay_ve) DESC LIMIT 300`,
        [omsDateBoundary(AD_REF_FROM)]);
      const out = { bo: rows.length, ra: 0, khongRa: 0, don: 0, dienAdid, ghepAdid };
      for (const r of rows) {
        let ref;
        try { ref = await lookupAdRef(r); }
        catch (e) { out.dung = e.message; break; } // rate limit / mạng: dừng, lần chạy sau tra tiếp
        await saveAdRef('ngay_ve >= ? AND utm_campaign<=>? AND utm_medium<=>? AND utm_term<=>? AND utm_content<=>? AND fbclid<=>?',
          [omsDateBoundary(AD_REF_FROM), r.utm_campaign, r.utm_medium, r.utm_term, r.utm_content, r.fbclid], ref);
        if (ref.campaign_id) out.ra++; else out.khongRa++;
        out.don += Number(r.don) || 0;
      }
      out.theoTrang = await guessLandingRefs().catch(e => { out.loiTheoTrang = e.message; return 0; });
      return out;
    } finally { fixingAdRefs = false; }
  }

  // ---- Dự phòng ghép theo trang đích (guessByLanding trong oms-ad-ref.js): đơn có fbclid nhưng không có adid
  // (hoặc adid chưa có trong thư viện), tra thường không ra → chiến dịch duy nhất của NV đó có chi tiêu hôm đặt đơn
  // và từng ra đơn ghép chắc chắn từ trang đích này hoặc có quảng cáo trỏ tới trang này (link đọc từ Meta).
  // Ghi fb_ref_src='trang'; ghép chắc chắn sau này (học được
  // adid) ghi đè. Đơn không có fbclid (vào thẳng, Zalo…) không đoán. Dùng chung cho đơn Thái (thailand.js).
  let histCache = null;
  async function landingHist() {
    if (histCache && Date.now() - histCache.at < 10 * 60 * 1000) return histCache.hist;
    const hist = new Map();
    const rows = await db(`SELECT url_page, fb_campaign_id, fb_adset_id FROM oms_orders WHERE ngay_ve >= ?
      AND fb_campaign_id!='' AND fb_ref_src='' AND url_page!=''`, [omsDateBoundary(AD_REF_FROM)]);
    for (const r of rows) addLandingHist(hist, r.url_page, r.fb_campaign_id, r.fb_adset_id);
    if (typeof global.__thaiLandingRows === 'function') {
      for (const r of await global.__thaiLandingRows().catch(() => [])) addLandingHist(hist, r.url, r.fb_campaign_id, r.fb_adset_id);
    }
    histCache = { at: Date.now(), hist };
    return hist;
  }
  global.__omsLandingGuess = async ({ url, nv, day }) => {
    if (!getPool() || typeof global.__getCampaignsDay !== 'function') return null;
    const landing = landingKey(url);
    if (!landing || !nv || !day) return null;
    const hist = await landingHist();
    const camps = await global.__getCampaignsDay(day);
    return guessByLanding({ landing, nv, camps: Array.isArray(camps) ? camps : [], hist });
  };
  async function guessLandingRefs() {
    const rows = await db(`SELECT id, url_page, nv_marketing, DATE_FORMAT(ngay_ve + INTERVAL 7 HOUR, '%Y-%m-%d') AS d
      FROM oms_orders WHERE ngay_ve >= ? AND ngay_ve > UTC_TIMESTAMP() - INTERVAL 14 DAY AND fb_campaign_id=''
      AND fb_ref_at IS NOT NULL AND fbclid!='' AND url_page!='' AND nv_marketing!='' ORDER BY id DESC LIMIT 500`,
      [omsDateBoundary(AD_REF_FROM)]);
    let n = 0;
    for (const r of rows) {
      const ref = await global.__omsLandingGuess({ url: r.url_page, nv: r.nv_marketing, day: r.d });
      if (!ref) continue;
      await db(`UPDATE oms_orders SET fb_campaign_id=?, fb_campaign_name=?, fb_adset_id=?, fb_adset_name=?, fb_ad_id='',
        fb_ref_src='trang', fb_ref_at=UTC_TIMESTAMP() WHERE id=? AND fb_campaign_id=''`,
        [ref.campaign_id, ref.campaign_name.slice(0, 255), ref.adset_id || '', (ref.adset_name || '').slice(0, 255), r.id]);
      n++;
    }
    return n;
  }

  // Cho trang Ads (server.js /api/ads/adids, /api/ads/adid): adid đã có theo quảng cáo, và lưu adid từ link
  global.__omsAdidsForAds = async (ids) => {
    if (!getPool() || !ids.length) return {};
    await ensureTables(getPool());
    const rows = await db(`SELECT adid, ad_id, nguon, xung_dot, last_at FROM oms_adid_map WHERE ad_id IN (?)
      ORDER BY last_at DESC`, [ids]);
    const out = {};
    for (const r of rows) (out[r.ad_id] ||= []).push({ adid: r.adid, nguon: r.nguon, xung_dot: r.xung_dot, last_at: r.last_at });
    return out;
  };
  global.__omsAddAdid = async (link, ref, nguoi) => {
    if (!getPool()) return { error: 'OMS chưa cấu hình DB' };
    await ensureTables(getPool());
    const raw = String(link || '').trim();
    const adid = /^\d{10,}$/.test(raw) ? raw : adIdFromFbclid(utmFromUrl(raw)?.fbclid || '');
    if (!adid) return { error: 'Link không có adid. Phải là link bấm từ bài quảng cáo trên bảng tin Facebook (Mở xem trước → Hiển thị quảng cáo → vào bảng tin bấm nút / link đặt hàng). Link web gõ tay hoặc "bài viết có bình luận" không có adid.' };
    const ketqua = await learnAdid(adid, ref, 'admin', nguoi);
    return { ketqua, adid };
  };

  // Thống kê đơn theo chiến dịch + nhóm quảng cáo cho trang Ads (/api/ads/oms-orders ở server.js).
  // since/until = ngày VN (YYYY-MM-DD), since bị nâng lên AD_REF_FROM (tu). Đơn chưa tra ra chiến
  // dịch nằm ở dòng fb_campaign_id=''.
  global.__omsAdStats = async (since, until) => {
    if (!getPool()) return null;
    const tu = since < AD_REF_FROM ? AD_REF_FROM : since;
    if (tu > until) return { tu, rows: [] };
    await ensureTables(getPool());
    const rows = await db(`SELECT fb_campaign_id, MAX(fb_campaign_name) AS campaign_name,
      fb_adset_id, MAX(fb_adset_name) AS adset_name, nv_marketing,
      COUNT(*) AS don,
      SUM(CASE WHEN trang_thai IN ('Đã chốt','Đang ship','Ship thành công') THEN 1 ELSE 0 END) AS chot,
      SUM(CASE WHEN trang_thai='Không mua' THEN 1 ELSE 0 END) AS khongMua,
      SUM(CASE WHEN trang_thai IN ('Đã chốt','Đang ship','Ship thành công') THEN tong_tien ELSE 0 END) AS doanhThu,
      SUM(CASE WHEN fb_ref_at IS NULL AND (utm_campaign!='' OR utm_medium!='' OR utm_term!='' OR utm_content!='' OR fbclid!='')
        THEN 1 ELSE 0 END) AS dangTra
      FROM oms_orders WHERE ngay_ve >= ? AND ngay_ve < ?
      GROUP BY fb_campaign_id, fb_adset_id, nv_marketing`,
      [omsDateBoundary(tu), omsDateBoundary(until, true)]);
    return { tu, rows: rows.map(r => ({ ...r, don: +r.don || 0, chot: +r.chot || 0, khongMua: +r.khongMua || 0,
      doanhThu: +r.doanhThu || 0, dangTra: +r.dangTra || 0 })) };
  };

  // Cho bot cảnh báo (ads-alert.js): ngưỡng riêng theo sản phẩm. Danh sách SP, link đăng ký → SP,
  // và SP của đơn đã ra chiến dịch / nhóm trong 7 ngày tới `day` (nhận ra SP của nhóm khi trang đích chưa đăng ký link).
  global.__omsProductList = async () => {
    if (!getPool()) return [];
    return db('SELECT id, ma_sp, ten_sp FROM oms_products WHERE active=1 ORDER BY ten_sp');
  };
  global.__omsLinkProducts = async () => {
    if (!getPool()) return [];
    return db(`SELECT url_pattern, product_id, ten_sp FROM oms_link_registry WHERE active=1 AND url_pattern<>''
      ORDER BY CHAR_LENGTH(url_pattern) DESC, id DESC`);
  };
  global.__omsAdsetProducts = async (day) => {
    if (!getPool()) return [];
    const from = new Date(Date.parse(day + 'T00:00:00Z') - 6 * 86400e3).toISOString().slice(0, 10);
    return db(`SELECT fb_campaign_id, fb_adset_id, san_pham, COUNT(*) AS n FROM oms_orders
      WHERE ngay_ve >= ? AND ngay_ve < ? AND fb_campaign_id<>'' AND san_pham<>''
      GROUP BY fb_campaign_id, fb_adset_id, san_pham`, [omsDateBoundary(from), omsDateBoundary(day, true)]);
  };

  // Cho trang Sản phẩm (CPA theo SP, server.js productSpend): SP của đơn đã ra chiến dịch / nhóm trong khoảng ngày
  global.__omsAdsetProductsRange = async (since, until) => {
    if (!getPool()) return [];
    return db(`SELECT fb_campaign_id, fb_adset_id, san_pham, COUNT(*) AS n FROM oms_orders
      WHERE ngay_ve >= ? AND ngay_ve < ? AND fb_campaign_id<>'' AND san_pham<>''
      GROUP BY fb_campaign_id, fb_adset_id, san_pham`, [omsDateBoundary(since), omsDateBoundary(until, true)]);
  };

  // Cho trang Sản phẩm: số contact (đơn về OMS) theo SP trong khoảng ngày (đơn đẩy cả về Sandbox lẫn OMS)
  global.__omsContactsByProduct = async (since, until) => {
    if (!getPool()) return null;
    return db(`SELECT san_pham, COUNT(*) AS n FROM oms_orders WHERE ngay_ve >= ? AND ngay_ve < ?
      GROUP BY san_pham`, [omsDateBoundary(since), omsDateBoundary(until, true)]);
  };

  // Cho module Tồn kho đọc số lượng đã bán theo sản phẩm (tính số ngày đủ bán)
  global.__omsSalesByProduct = (days, trangThai) => db(
    `SELECT san_pham, SUM(so_luong) AS qty, COUNT(*) AS don FROM oms_orders
     WHERE ngay_ve >= DATE_SUB(NOW(), INTERVAL ? DAY) AND trang_thai IN (?)
     GROUP BY san_pham`, [days, trangThai]);

  // ---- Wrap route an toàn ----
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error('[OMS]', e); res.status(500).json({ error: e.message }); }
  };

  // ---- Middleware xác thực OMS ----
  // Tự động đăng nhập OMS từ tài khoản dashboard chính
  // Admin → admin OMS, Marketing/Sale → tìm khớp trong oms_users
  async function autoSetOmsUser(req) {
    if (req.session?.omsUser) return;
    if (!req.session?.user) return;
    if (getPool()) await syncAdsUsersOnce();

    const mainUser = req.session.user;
    const mainUsername = mainUser.user || '';

    // Admin dashboard chính → admin OMS
    if (mainUser.role === 'admin') {
      req.session.omsUser = { id: 0, username: mainUsername, ho_ten: 'Admin', role: 'admin' };
      return;
    }

    // Tìm user OMS khớp với tài khoản dashboard chính
    // Chỉ so theo username và salaryName của chính người đó.
    // KHÔNG dùng manager / employees: đó là tên người khác (trưởng nhóm / nhân viên dưới quyền),
    // ghép theo đó sẽ đăng nhập nhầm sang tài khoản OMS của họ.
    try {
      const searchNames = [mainUsername];
      if (mainUser.salaryName) searchNames.push(mainUser.salaryName);

      for (const name of searchNames) {
        if (!name) continue;
        const rows = await db('SELECT * FROM oms_users WHERE (username=? OR ho_ten=?) AND active=1 LIMIT 1', [name, name]);
        if (rows.length) {
          req.session.omsUser = { id: rows[0].id, username: rows[0].username, ho_ten: rows[0].ho_ten, role: rows[0].role };
          return;
        }
      }
    } catch(e) { /* DB chưa sẵn sàng */ }
  }

  // ---- Chi nhánh ----
  // Sale / kho: chi nhánh chính (oms_users.chi_nhanh_id: đơn tự chia, đơn tạo tay) + quyền xem (xem_chi_nhanh: chỉ
  // chi nhánh chính / thêm chi nhánh khác / mọi chi nhánh). Đọc lại mỗi request nên admin đổi là có hiệu lực ngay.
  // Admin / marketing xem mọi chi nhánh. Ai xem được nhiều chi nhánh thì lọc bằng ?cn=<id>.
  const branchLocked = role => role === 'sale' || role === 'warehouse';
  async function loadBranch(req) {
    const u = req.session?.omsUser;
    if (!u || !(u.id > 0)) return;
    try {
      const [r] = await db('SELECT chi_nhanh_id, xem_chi_nhanh FROM oms_users WHERE id=?', [u.id]);
      u.chi_nhanh_id = Number(r?.chi_nhanh_id) || 1;
      u.cn_xem = parseXemCn(u.chi_nhanh_id, r?.xem_chi_nhanh);
    } catch(e) { u.chi_nhanh_id = u.chi_nhanh_id || 1; }
  }
  // Chi nhánh tài khoản được xem; null = mọi chi nhánh
  function viewCns(u) {
    if (!branchLocked(u.role)) return null;
    return u.cn_xem === undefined ? [Number(u.chi_nhanh_id) || 1] : u.cn_xem;
  }
  // Điều kiện lọc đơn của request: quyền xem + ô lọc ?cn (chi nhánh ngoài quyền → không ra đơn nào)
  function cnWhere(req, col = 'chi_nhanh_id') {
    const allow = viewCns(req.session.omsUser);
    const q = Number(req.query?.cn) || 0;
    const ids = q ? (!allow || allow.includes(q) ? [q] : []) : allow;
    if (!ids) return { sql: '', params: [] };
    if (!ids.length) return { sql: '0=1', params: [] };
    return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  // Điều kiện SQL chặn sale / kho đụng đơn chi nhánh ngoài quyền (admin / marketing: không chặn)
  function lockSql(req, col = 'chi_nhanh_id') {
    const allow = viewCns(req.session.omsUser);
    return allow ? { sql: ` AND ${col} IN (${allow.map(() => '?').join(',')})`, params: allow } : { sql: '', params: [] };
  }

  // ---- Tác nghiệp ----
  // Giờ lưu DB = UTC dạng 'YYYY-MM-DD HH:MM:SS' như ngay_ve (đừng dùng NOW() của MySQL: múi giờ máy DB có thể khác)
  const utcStr = (d = new Date()) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
  const vnTime = v => new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z'))
    .toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  const actorName = u => typeof u === 'string' ? u : (u?.ho_ten || u?.username || 'Hệ thống');
  async function logOrder(orderId, user, hanhDong, chiTiet = '') {
    try {
      await db('INSERT INTO oms_order_logs (order_id, at, nguoi, hanh_dong, chi_tiet) VALUES (?,?,?,?,?)',
        [orderId, utcStr(), actorName(user).slice(0, 120), hanhDong.slice(0, 60), String(chiTiet || '').slice(0, 2000)]);
    } catch (e) { console.error('[OMS] Ghi lịch sử đơn lỗi:', e.message); }
  }
  async function cfgNum(key, def) {
    try {
      const [r] = await db('SELECT config_value FROM oms_config WHERE config_key=?', [key]);
      const n = Number(r?.config_value);
      return r && r.config_value !== '' && Number.isFinite(n) ? n : def;
    } catch (e) { return def; }
  }
  // Sale nhận đơn tự chia: đang bật nhận đơn, chi nhánh chính = chi nhánh đơn, ít đơn nhận hôm nay (giờ VN) nhất
  async function pickSale(cn, exclude = '') {
    const sales = (await db("SELECT ho_ten FROM oms_users WHERE role='sale' AND active=1 AND nhan_don=1 AND chi_nhanh_id=? ORDER BY ho_ten", [cn]))
      .map(s => s.ho_ten).filter(n => n && n !== exclude);
    if (!sales.length) return '';
    const vnDay = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    const counts = await db(`SELECT sale_phu_trach, COUNT(*) AS cnt FROM oms_orders
      WHERE sale_phu_trach IN (${sales.map(() => '?').join(',')}) AND ngay_ve >= ? GROUP BY sale_phu_trach`, [...sales, omsDateBoundary(vnDay)]);
    const cnt = Object.fromEntries(counts.map(c => [c.sale_phu_trach, Number(c.cnt)]));
    return sales.reduce((best, n) => (cnt[n] || 0) < (cnt[best] || 0) ? n : best, sales[0]);
  }
  // Tài khoản đăng nhập của sale (để gửi thông báo riêng)
  async function usernamesOf(hoTen) {
    if (!hoTen) return new Set();
    return new Set((await db("SELECT username FROM oms_users WHERE ho_ten=? AND active=1", [hoTen])).map(r => r.username));
  }

  function omsAuth(req, res, next) {
    // Phải gọi async
    autoSetOmsUser(req).then(() => loadBranch(req)).then(() => {
      if (req.session?.omsUser) return next();
      res.status(401).json({ error: 'Chưa đăng nhập OMS' });
    }).catch(() => res.status(401).json({ error: 'Chưa đăng nhập OMS' }));
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      autoSetOmsUser(req).then(() => loadBranch(req)).then(() => {
        if (!req.session?.omsUser) return res.status(401).json({ error: 'Chưa đăng nhập' });
        if (roles.includes(req.session.omsUser.role)) return next();
        res.status(403).json({ error: 'Không đủ quyền' });
      }).catch(() => res.status(401).json({ error: 'Lỗi xác thực' }));
    };
  }

  const jsonParser = express.json();
  const formParser = express.urlencoded({ extended: true });

  // CHẶN CACHE cho file HTML OMS — phải đặt TRƯỚC express.static
  app.get('/oms-admin.html', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

  // ===================== SMART REDIRECT → OMS =====================
  // Từ trang chủ bấm vào → tự redirect sang đúng trang OMS theo role
  app.get('/go-oms', async (req, res) => {
    try { await autoSetOmsUser(req); } catch(e) {}
    const role = req.session?.omsUser?.role;
    if (!role) return res.redirect('/oms-admin.html'); // chưa login → trang admin (có modal login)
    const pages = {
      admin: '/oms-admin.html',
      sale: '/oms-admin.html',      // Sale dùng chung trang admin (tab bị ẩn theo role)
      marketing: '/oms-admin.html',
      warehouse: '/oms-admin.html',
    };
    res.redirect(pages[role] || '/oms-admin.html');
  });

  // ===================== ĐĂNG NHẬP OMS =====================
  app.post('/oms/login', jsonParser, formParser, wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Thiếu username/password' });

    const rows = await db('SELECT * FROM oms_users WHERE username=? AND password=? AND active=1', [username, password]);
    if (rows.length === 0) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });

    const u = rows[0];
    req.session.omsUser = { id: u.id, username: u.username, ho_ten: u.ho_ten, role: u.role, chi_nhanh_id: Number(u.chi_nhanh_id) || 1 };
    req.session.save(() => res.json({ ok: true, user: req.session.omsUser }));
  }));

  app.post('/oms/logout', wrap(async (req, res) => {
    delete req.session.omsUser;
    req.session.save(() => res.json({ ok: true }));
  }));

  // Admin: đổi ngay các đơn đang mang ID quảng cáo sang tên NV; ten=null là chưa đổi được
  // (token Meta không thấy ID đó, hoặc tên chiến dịch không có mã/tên NV)
  app.get('/oms/api/fix-mkt-ids', requireRole('admin'), wrap(async (req, res) => {
    res.json({ ketqua: await fixMktIds() });
  }));

  // Admin: chẩn đoán vì sao đơn (theo SĐT) không ra chiến dịch — fbclid, adid, cặp trong thư viện adid
  app.get('/oms/api/ad-ref-debug', requireRole('admin'), wrap(async (req, res) => {
    const rows = await db(`SELECT id, ngay_ve, utm_source, utm_campaign, utm_medium, utm_term, utm_content, fbclid, url_page,
      fb_campaign_id, fb_campaign_name, fb_adset_id, fb_adset_name, fb_ad_id, fb_adid, fb_ref_src, fb_ref_at
      FROM oms_orders WHERE sdt=? ORDER BY id DESC LIMIT 3`, [String(req.query.sdt || '').trim()]);
    const out = [];
    for (const r of rows) {
      const adid = adIdFromFbclid(r.fbclid);
      out.push({ ...r, adidTuFbclid: adid || null,
        thuVienAdid: adid ? (await db('SELECT * FROM oms_adid_map WHERE adid=?', [adid]))[0] || null : null,
        traLai: await lookupAdRef(r).catch(e => ({ loi: e.message })) });
    }
    res.json(out);
  }));

  // Admin: vì sao chiến dịch không có đơn OMS (trang Ads, link "Vì sao?" khi 0 đơn OMS mà Meta có đơn).
  // ?id=<ID chiến dịch>&since&until (ngày VN, tối đa 14 ngày). Mỗi ngày: đơn của NV chiến dịch / đơn về trang đích
  // của chiến dịch / đơn đã ghép vào chiến dịch, kèm lý do ghép hoặc không ghép được.
  app.get('/oms/api/camp-debug', requireRole('admin'), wrap(async (req, res) => {
    if (typeof global.__getCampaignsDay !== 'function') return res.status(503).json({ error: 'Chưa nạp dữ liệu Ads' });
    await ensureTables(getPool());
    const id = String(req.query.id || '').trim();
    const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    const until = isDay(req.query.until) ? req.query.until : today;
    let since = isDay(req.query.since) ? req.query.since : until;
    if (since < AD_REF_FROM) since = AD_REF_FROM;
    const days = [];
    for (let t = Date.parse(since + 'T00:00:00Z'); days.length < 14; t += 86400e3) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (d > until) break;
      days.push(d);
    }
    const hist = await landingHist();
    const isNum = v => /^\d{10,}$/.test(String(v || '').trim());
    const out = { chienDich: null, tomTat: {}, ngay: [] };
    for (const day of days) {
      const camps = await global.__getCampaignsDay(day).catch(() => null);
      const c = Array.isArray(camps) && camps.find(x => String(x.id) === id);
      if (!c) { out.ngay.push({ ngay: day, loi: 'Không thấy chiến dịch trong dữ liệu Ads ngày này' }); continue; }
      const lands = campLandings(c, hist);
      const ads = (c.adsets || []).flatMap(a => (a.ads || []).map(ad => ({ nhom: a.name, nhomTieu: a.spent || 0,
        id: String(ad.id), ten: ad.name, trangDich: (ad.land || []).map(landingKey).filter(Boolean) })));
      const adids = ads.length && typeof global.__omsAdidsForAds === 'function'
        ? await global.__omsAdidsForAds(ads.map(a => a.id)).catch(() => ({})) : {};
      for (const a of ads) a.adid = (adids[a.id] || []).map(x => x.adid + (x.xung_dot ? ' (xung đột)' : ''));
      if (!out.chienDich) out.chienDich = { id, ten: c.name, nv: c.employee || '' };
      const rows = await db(`SELECT id, ngay_ve, nv_marketing, san_pham, url_page, utm_campaign, utm_medium, utm_term, utm_content,
        fbclid, fb_adid, fb_campaign_id, fb_campaign_name, fb_ref_src, fb_ref_at FROM oms_orders
        WHERE ngay_ve >= ? AND ngay_ve < ? ORDER BY id`, [omsDateBoundary(day), omsDateBoundary(day, true)]);
      const mine = rows.filter(r => r.fb_campaign_id === id || (c.employee && r.nv_marketing === c.employee)
        || lands.includes(landingKey(r.url_page)));
      const don = [];
      for (const r of mine) {
        const landing = landingKey(r.url_page);
        const utmIds = ['utm_content', 'utm_medium', 'utm_term', 'utm_campaign'].filter(k => isNum(r[k])).map(k => `${k}=${r[k]}`);
        const utmText = ['utm_campaign', 'utm_medium', 'utm_content'].filter(k => r[k] && !isNum(r[k])).map(k => `${k}=${r[k]}`);
        let loai, lyDo;
        if (r.fb_campaign_id === id) { loai = 'da_ghep'; lyDo = r.fb_ref_src === 'trang' ? 'Đã ghép (theo trang đích)' : 'Đã ghép'; }
        else if (r.fb_campaign_id) { loai = 'chien_dich_khac'; lyDo = `Đã ghép vào chiến dịch khác: ${r.fb_campaign_name || r.fb_campaign_id}${r.fb_ref_src === 'trang' ? ' (theo trang đích)' : ''}`; }
        else if (!r.fbclid && !utmIds.length && !utmText.length) {
          loai = 'khong_tham_so';
          lyDo = 'Đơn không mang UTM lẫn fbclid (Ladipage không gửi tham số link, hoặc khách vào thẳng / qua Zalo, inbox) → không ghép được';
        } else if (!r.fb_ref_at) { loai = 'chua_tra'; lyDo = 'Chưa tra (chờ lượt tra 30 phút)'; }
        else if (utmIds.length) { loai = 'utm_khong_ra'; lyDo = `UTM có ID (${utmIds.join(', ')}) nhưng Graph API không ra chiến dịch: token không đọc được TK quảng cáo, hoặc ID sai`; }
        else {
          const parts = [];
          if (utmText.length) parts.push(`UTM không có ID số (${utmText.join(', ')}): thông số URL quảng cáo phải dùng macro {{ad.id}}…`);
          if (!r.fbclid) parts.push('không có fbclid');
          else if (r.fb_adid && r.fb_adid !== '-') {
            const [m] = await db('SELECT ad_id, xung_dot FROM oms_adid_map WHERE adid=?', [r.fb_adid]);
            parts.push(!m ? `adid ${r.fb_adid} chưa có trong thư viện adid (dán link quảng cáo ở trang Ads)`
              : m.xung_dot ? `adid ${r.fb_adid} bị xung đột trong thư viện` : `adid ${r.fb_adid} có trong thư viện (quảng cáo ${m.ad_id}) nhưng chưa ghép, chờ lượt tra`);
          } else parts.push('fbclid không có adid');
          if (r.fbclid) {
            if (!landing) parts.push('đơn không có trang đích (url_page) → không đoán theo trang');
            else if (!r.nv_marketing) parts.push(`đơn không có NV marketing → không đoán theo trang (${landing})`);
            else {
              const cands = landingCands({ landing, nv: r.nv_marketing, camps, hist });
              if (cands.length > 1) parts.push(`đoán theo trang ${landing}: ${cands.length} chiến dịch của ${r.nv_marketing} cùng chạy trang này (${cands.map(x => x.name).join(' | ')}) → không biết chọn cái nào`);
              else if (!cands.length) {
                const all = landingCands({ landing, nv: '', camps, hist });
                parts.push(`đoán theo trang ${landing}: không chiến dịch nào của "${r.nv_marketing}" có chi tiêu dùng trang này`
                  + (c.employee && r.nv_marketing !== c.employee ? ` (NV của đơn khác NV chiến dịch "${c.employee}")` : '')
                  + (!lands.includes(landing) ? ` (quảng cáo của chiến dịch trỏ tới: ${lands.join(', ') || 'chưa đọc được link'})` : '')
                  + (all.length ? `; chiến dịch NV khác dùng trang này: ${all.map(x => `${x.name} (${x.employee})`).join(' | ')}` : ''));
              } else if (Date.parse(r.ngay_ve) < Date.now() - 14 * 86400e3) parts.push('đơn quá 14 ngày, không đoán theo trang nữa');
              else parts.push(`đoán theo trang ${landing} ra ${cands[0].name}, chờ lượt tra 30 phút`);
            }
          }
          loai = !r.fbclid ? 'utm_khong_id' : r.fb_adid && r.fb_adid !== '-' ? 'adid_chua_ghep' : 'fbclid_khong_adid';
          lyDo = parts.join('; ');
        }
        out.tomTat[loai] = (out.tomTat[loai] || 0) + 1;
        don.push({ id: r.id, luc: r.ngay_ve, nv: r.nv_marketing, trangDich: landing || r.url_page,
          utm: [...utmIds, ...utmText].join(' ') || '', fbclid: !!r.fbclid, adid: r.fb_adid || '', loai, lyDo });
      }
      // Mọi đơn trong ngày chưa ra chiến dịch (mọi NV): đơn của chiến dịch này có thể mang NV khác / không có NV
      // hoặc về trang đích mà máy chủ chưa biết là của chiến dịch này
      const donChuaRo = rows.filter(r => !r.fb_campaign_id && !mine.includes(r)).map(r => ({ id: r.id, luc: r.ngay_ve,
        nv: r.nv_marketing, sanPham: r.san_pham, trangDich: landingKey(r.url_page) || r.url_page,
        utm: ['utm_campaign', 'utm_medium', 'utm_content'].filter(k => r[k]).map(k => `${k}=${r[k]}`).join(' '),
        fbclid: !!r.fbclid, adid: r.fb_adid || '' }));
      out.ngay.push({ ngay: day, trangDichChienDich: lands, quangCao: ads, donVeTrangHoacNv: don.length, don,
        donChuaRoCuaNgay: donChuaRo.length, donChuaRo: donChuaRo.slice(0, 150) });
    }
    out.giaiThichLoai = { da_ghep: 'đã ghép vào chiến dịch này', chien_dich_khac: 'ghép vào chiến dịch khác',
      khong_tham_so: 'đơn không mang UTM / fbclid', chua_tra: 'chưa tra', utm_khong_ra: 'UTM có ID nhưng tra không ra',
      utm_khong_id: 'UTM không có ID số, không fbclid', adid_chua_ghep: 'có adid nhưng chưa ghép', fbclid_khong_adid: 'fbclid không có adid' };
    res.type('application/json').send(JSON.stringify(out, null, 2));
  }));

  // ---- Thư viện adid (trang /oms-adid.html) ----
  // Danh sách cặp đã có + adid của đơn chưa ra chiến dịch (kèm số đơn, trang đích) để admin / NV thêm tay
  app.get('/oms/api/adid-map', requireRole('admin', 'marketing'), wrap(async (req, res) => {
    await ensureTables(getPool());
    await fillFbAdid();
    const map = await db('SELECT * FROM oms_adid_map ORDER BY last_at DESC LIMIT 500');
    const chuaGhep = await db(`SELECT o.fb_adid AS adid, COUNT(*) AS don, MIN(o.ngay_ve) AS tu, MAX(o.ngay_ve) AS den,
      MAX(o.url_page) AS url_page, GROUP_CONCAT(DISTINCT o.nv_marketing SEPARATOR ', ') AS nv,
      MAX(m.ad_id) AS ad_id, MAX(m.xung_dot) AS xung_dot
      FROM oms_orders o LEFT JOIN oms_adid_map m ON m.adid=o.fb_adid
      WHERE o.ngay_ve >= ? AND o.fb_adid NOT IN ('', '-') AND o.fb_campaign_id=''
      GROUP BY o.fb_adid ORDER BY den DESC LIMIT 300`, [omsDateBoundary(AD_REF_FROM)]);
    // Đơn Thái (thailand.js) mang adid chưa ghép: gộp vào cùng dòng adid
    const thai = typeof global.__thaiAdidPending === 'function'
      ? await global.__thaiAdidPending().catch(e => { console.error('[OMS] adid đơn Thái:', e.message); return []; }) : [];
    if (thai.length) {
      const byAdid = new Map(chuaGhep.map(c => [c.adid, c]));
      const map2 = await db('SELECT adid, ad_id, xung_dot FROM oms_adid_map WHERE adid IN (?)', [thai.map(t => t.adid)]);
      const m2 = new Map(map2.map(m => [m.adid, m]));
      for (const t of thai) {
        const nv = t.nv ? `${t.nv} (Thái)` : '(Thái)';
        const c = byAdid.get(t.adid);
        if (c) {
          c.don += t.don;
          c.nv = [c.nv, nv].filter(Boolean).join(', ');
          if (new Date(t.tu) < new Date(c.tu)) c.tu = t.tu;
          if (new Date(t.den) > new Date(c.den)) c.den = t.den;
        } else {
          const m = m2.get(t.adid);
          chuaGhep.push({ ...t, nv, ad_id: m?.ad_id || null, xung_dot: m?.xung_dot || '' });
        }
      }
      chuaGhep.sort((a, b) => new Date(b.den) - new Date(a.den));
    }
    res.json({ map, chuaGhep });
  }));
  // Thêm / sửa tay: { ad_id, adid } hoặc { ad_id, link } (link bấm từ quảng cáo, có ?fbclid=…). ad_id phải là
  // ID quảng cáo (không phải nhóm / chiến dịch) mà token Meta của máy chủ đọc được.
  app.post('/oms/api/adid-map', requireRole('admin', 'marketing'), jsonParser, wrap(async (req, res) => {
    await ensureTables(getPool());
    const b = req.body || {};
    const adId = String(b.ad_id || '').trim();
    let adid = String(b.adid || '').trim();
    if (!adid && b.link) adid = adIdFromFbclid(utmFromUrl(b.link)?.fbclid || '');
    if (!/^\d{10,}$/.test(adid)) return res.status(400).json({ error: 'Không đọc được adid: dán link bấm từ bài quảng cáo trên bảng tin Facebook' });
    if (!/^\d{10,}$/.test(adId)) return res.status(400).json({ error: 'Thiếu ID quảng cáo' });
    const ref = await global.__fbAdRef(adId);
    if (!ref?.ad_id) return res.status(400).json({ error: `ID ${adId} không phải quảng cáo, hoặc token Meta không đọc được` });
    const ketqua = await learnAdid(adid, { ...ref, ad_id: adId }, 'admin', req.session.omsUser?.ho_ten || '');
    const [row] = await db('SELECT * FROM oms_adid_map WHERE adid=?', [adid]);
    res.json({ ketqua, adid, row });
  }));
  app.post('/oms/api/adid-map/delete', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    await db('DELETE FROM oms_adid_map WHERE adid=?', [String(req.body?.adid || '').trim()]);
    res.json({ ok: true });
  }));

  // Học thư viện adid từ lượt mở trang (đoạn script dán vào Ladipage gửi location.href bằng sendBeacon):
  // chỉ link có cả fbclid lẫn UTM (bấm nút quảng cáo). Không cần đăng nhập → bỏ qua adid đã có, giới hạn
  // mỗi IP 30 lần / phút; cặp học được vẫn phải là quảng cáo thật mà token Meta đọc được.
  const trackSeen = new Set();
  const trackHits = new Map();
  app.post('/oms/track', express.text({ type: '*/*', limit: '8kb' }), (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.status(204).end();
    const ip = req.ip || '';
    const now = Date.now();
    const h = trackHits.get(ip);
    if (h && now - h.t < 60000) { if (++h.n > 30) return; } else trackHits.set(ip, { t: now, n: 1 });
    if (trackHits.size > 5000) trackHits.clear();
    const u = utmFromUrl(typeof req.body === 'string' ? req.body : '');
    if (!u?.fbclid || !['utm_campaign', 'utm_medium', 'utm_term', 'utm_content'].some(k => /^\d{10,}$/.test(u[k]))) return;
    const adid = adIdFromFbclid(u.fbclid);
    if (!adid || trackSeen.has(adid) || !getPool()) return;
    trackSeen.add(adid);
    if (trackSeen.size > 20000) trackSeen.clear();
    (async () => {
      await ensureTables(getPool());
      const [row] = await db('SELECT adid FROM oms_adid_map WHERE adid=?', [adid]);
      if (!row) await lookupAdRef(u);
    })().catch(e => { trackSeen.delete(adid); console.error('[OMS] track adid:', e.message); });
  });

  // Admin: tra ngay chiến dịch / nhóm quảng cáo cho đơn chưa tra (?all=1: tra lại mọi đơn)
  app.get('/oms/api/fix-ad-refs', requireRole('admin'), wrap(async (req, res) => {
    res.json({ ketqua: await fixAdRefs(req.query.all === '1') });
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
    const utmTerm = d.utm_term || '';
    const fbclid = findFbclid(d); // link bình luận không có UTM nhưng fbclid mang ID quảng cáo
    let nvMarketing = d.utm_content || d.nhan_vien || d.user || d.marketing || '';
    // utm_content hay là ID quảng cáo Meta ({{ad.id}}) hoặc tên chiến dịch chứ không phải
    // tên NV → đổi ra tên NV. Link Registry được ưu tiên khi có link khớp bên dưới.
    // Không đổi được thì để trống cho Link Registry điền;
    // vẫn không có thì giữ giá trị gốc (admin còn thấy được). Đơn không mang đúng tên thì
    // NV marketing không thấy trên OMS (lọc theo tên) → cùng link có đơn hiện có đơn không.
    let rawMktId = '';
    if (nvMarketing) {
      const ten = await resolveMkt(nvMarketing);
      if (ten) nvMarketing = ten;
      else if (!(await omsNames().catch(() => new Set())).has(nvMarketing)) {
        rawMktId = nvMarketing;
        nvMarketing = '';
      }
    }

    // ---- TỰ NHẬN DIỆN từ Link Registry ----
    // Ladipage gửi kèm url_page (URL trang gửi form)
    const urlPage = d.url_page || d.page_url || d.referer || d.referrer || '';
    let chiNhanh = 1; // link không khớp → HKD TD
    if (urlPage) {
      try {
        const links = await db('SELECT * FROM oms_link_registry WHERE active=1 ORDER BY CHAR_LENGTH(url_pattern) DESC, id DESC');
        for (const link of links) {
          // So khớp: URL chứa pattern đã đăng ký
          if (urlPage.toLowerCase().includes(link.url_pattern.toLowerCase())) {
            // Link đã đăng ký quyết định NV; UTM có thể còn ID quảng cáo của NV khác.
            // Ưu tiên pattern cụ thể hơn khi nhiều link cùng khớp.
            if (link.nv_marketing?.trim()) nvMarketing = link.nv_marketing.trim();
            chiNhanh = Number(link.chi_nhanh_id) || 1; // link chọn chi nhánh nhận đơn
            // Auto-fill sản phẩm nếu chưa có
            if (!sanPham && link.ten_sp) sanPham = link.ten_sp;
            // Auto-fill nguồn dữ liệu
            var nguonDuLieu = link.nguon_du_lieu || '';
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

    if (!nvMarketing) nvMarketing = rawMktId;

    // Tách địa chỉ tự động
    const addr = parseAddress(diaChiFull);

    // Ghi vào DB
    const p = getPool();
    if (!p) return res.status(503).json({ error: 'DB chưa cấu hình' });
    await ensureTables(p);

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Ghi nhận nội dung gốc từ webhook (bỏ URL, UTM, tracking, field hệ thống)
    const skipKeys = new Set(['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid',
      'url_page','page_url','referer','referrer','ip','user_agent','_token','_method',
      'form_id','variant_id','form_type','page_id','landing_page']);
    const isJunk = (v) => {
      if (v.startsWith('http') || v.startsWith('fb.') || v.startsWith('ladi.')) return true;
      if (/^FORM\d/i.test(v)) return true;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return true; // UUID
      if (v.length > 80) return true; // tracking strings
      return false;
    };
    const rawParts = [];
    for (const [key, val] of Object.entries(d)) {
      if (skipKeys.has(key)) continue;
      if (typeof val === 'string' && val.trim() && !isJunk(val.trim())) {
        rawParts.push(val.trim());
      }
    }
    const tinNhanGoc = [...new Set(rawParts)].join(' | ');

    // Default nguon_du_lieu from UTM or link match
    const orderNguon = typeof nguonDuLieu !== 'undefined' ? nguonDuLieu : (d.utm_source || '');

    const createdOrder = await db(`INSERT INTO oms_orders
      (ngay_ve, nv_marketing, ten_kh, sdt, dia_chi_full, tinh, quan, phuong, dia_chi,
       trang_thai, san_pham, so_luong, gia_ban, tong_tien,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term, ghi_chu, tin_nhan_goc, nguon_du_lieu,
       fbclid, url_page, fb_adid, chi_nhanh_id, sdt_norm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Đơn mới', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [now, nvMarketing, ten, sdt, diaChiFull, addr.tinh, addr.quan, addr.phuong, addr.diaChi,
       sanPham, soLuong, gia, gia * soLuong,
       utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
       d.ghi_chu || '', tinNhanGoc, orderNguon,
       fbclid.slice(0, 512), String(urlPage).slice(0, 1000), fbAdidOf(fbclid), chiNhanh, normPhone(sdt)]);
    logOrder(createdOrder.insertId, 'Webhook', 'Đơn về', urlPage ? String(urlPage).slice(0, 300) : '');

    // Tra chiến dịch / nhóm quảng cáo (gọi Graph API) sau khi đã ghi đơn → Ladipage không phải chờ.
    // Lỗi thì fb_ref_at còn trống, fixAdRefs tra lại.
    const utm = { utm_campaign: utmCampaign, utm_medium: utmMedium, utm_term: utmTerm, utm_content: utmContent, fbclid };
    if (hasUtm(utm)) {
      lookupAdRef(utm).then(ref => saveAdRef('id=?', [createdOrder.insertId], ref))
        .catch(e => console.error('[OMS] Tra chiến dịch Meta của đơn lỗi:', e.message));
    }

    // Tự chia sale: chi nhánh nhận đơn, sale đang bật nhận đơn, ít đơn hôm nay nhất
    try {
      const minSale = await pickSale(chiNhanh);
      if (minSale) {
        await db('UPDATE oms_orders SET sale_phu_trach=?, sale_nhan_at=? WHERE id=?', [minSale, utcStr(), createdOrder.insertId]);
        logOrder(createdOrder.insertId, 'Hệ thống', 'Chia sale', minSale);
      }
    } catch(e) { console.error('[OMS] Auto-assign sale error:', e.message); }

    // Push notification
    try {
      if (app._omsPush) {
        app._omsPush(
          (sanPham || 'Sản phẩm') + ' — Có đơn mới!',
          `${ten} — ${sanPham || 'Sản phẩm'}`,
          createdOrder.insertId
        );
      }
    } catch(e) {}

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

    // Chi nhánh: sale / kho trong quyền xem, lọc thêm theo ?cn
    const cw = cnWhere(req);
    if (cw.sql) { where.push(cw.sql); params.push(...cw.params); }

    // Phân quyền
    if (user.role === 'sale') {
      // Sale chỉ thấy đơn được phân công hoặc đơn mới
      where.push(`(sale_phu_trach = ? OR (sale_phu_trach = '' AND trang_thai = 'Đơn mới'))`);
      params.push(user.ho_ten);
    } else if (user.role === 'marketing') {
      // Marketing: team lead thấy đơn cả team, NV thường thấy đơn mình
      const team = getMktTeam(user);
      where.push(`nv_marketing IN (${team.map(()=>'?').join(',')})`);
      params.push(...team);
    } else if (user.role === 'warehouse') {
      // Kho: đơn đã chốt trở đi (gồm đã giao / hoàn để đối soát COD và nhận hàng hoàn)
      where.push(`trang_thai IN ('Đã chốt', 'Đang ship', 'Ship thành công', 'Hoàn thành công')`);
    }
    // Admin thấy tất cả

    if (tu) { where.push('ngay_ve >= ?'); params.push(omsDateBoundary(tu)); }
    if (den) { where.push('ngay_ve < ?'); params.push(omsDateBoundary(den, true)); }
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

    // Trùng số / khách cũ: đếm đơn khác cùng SĐT (mọi chi nhánh), khách cũ = có đơn khác đã chốt trở đi
    try {
      const keyOf = r => (r.sdt_norm && r.sdt_norm !== '-') ? r.sdt_norm : normPhone(r.sdt);
      const keys = [...new Set(rows.map(keyOf).filter(Boolean))];
      if (keys.length) {
        const agg = await db(`SELECT sdt_norm, COUNT(*) AS n,
          SUM(trang_thai IN ('Đã chốt','Đang ship','Ship thành công')) AS mua
          FROM oms_orders WHERE sdt_norm IN (${keys.map(() => '?').join(',')}) GROUP BY sdt_norm`, keys);
        const m = Object.fromEntries(agg.map(a => [a.sdt_norm, a]));
        const MUA = ['Đã chốt', 'Đang ship', 'Ship thành công'];
        for (const r of rows) {
          const a = m[keyOf(r)];
          if (!a) continue;
          const self = r.sdt_norm && r.sdt_norm !== '-' ? 1 : 0; // đơn chưa có sdt_norm không nằm trong số đếm
          r.trung_so = Math.max(0, Number(a.n) - self);
          r.khach_cu = Number(a.mua) - (self && MUA.includes(r.trang_thai) ? 1 : 0) > 0;
        }
      }
    } catch (e) { console.error('[OMS] Đếm trùng số lỗi:', e.message); }

    res.json({ orders: rows, total: countRows[0].total, page: parseInt(page), limit: parseInt(limit) });
  }));

  // ===================== THÊM ĐƠN THỦ CÔNG =====================
  app.post('/oms/api/orders', omsAuth, jsonParser, wrap(async (req, res) => {
    const d = req.body;
    const addr = parseAddress(d.dia_chi_full || '');
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await ensureTables(getPool());
    const u = req.session.omsUser;
    // Sale / kho: chi nhánh chọn trong quyền xem, không chọn thì chi nhánh chính
    const allow = viewCns(u), want = Number(d.chi_nhanh_id) || 0;
    const chiNhanh = allow ? (want && allow.includes(want) ? want : (Number(u.chi_nhanh_id) || 1)) : (want || 1);
    const result = await db(`INSERT INTO oms_orders
      (ngay_ve, nv_marketing, ten_kh, sdt, dia_chi_full, tinh, quan, phuong, dia_chi,
       trang_thai, san_pham, so_luong, gia_ban, tong_tien, ghi_chu, sale_phu_trach, chi_nhanh_id, sdt_norm, sale_nhan_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.ngay_ve || now, d.nv_marketing || '', d.ten_kh || '', d.sdt || '',
       d.dia_chi_full || '', addr.tinh, addr.quan, addr.phuong, addr.diaChi,
       d.trang_thai || 'Đơn mới', d.san_pham || '', d.so_luong || 1,
       d.gia_ban || 0, (d.gia_ban || 0) * (d.so_luong || 1),
       d.ghi_chu || '', d.sale_phu_trach || '', chiNhanh, normPhone(d.sdt), d.sale_phu_trach ? utcStr() : null]);
    logOrder(result.insertId, u, 'Tạo đơn tay', d.sale_phu_trach ? 'Sale: ' + d.sale_phu_trach : '');

    // Push notification (giống đơn về từ webhook)
    try {
      if (app._omsPush) {
        app._omsPush(
          (d.san_pham || 'Sản phẩm') + ' — Có đơn mới!',
          `${d.ten_kh || ''} — ${d.san_pham || 'Sản phẩm'} (tạo tay)`,
          result.insertId
        );
      }
    } catch(e) {}

    res.json({ ok: true, id: result.insertId });
  }));

  // ===================== CẬP NHẬT ĐƠN =====================
  const INFO_FIELDS = { ten_kh: 'tên KH', sdt: 'SĐT', dia_chi_full: 'địa chỉ', san_pham: 'SP', so_luong: 'SL', gia_ban: 'giá',
    tong_tien: 'tổng tiền', phi_ship: 'phí ship', dat_coc: 'đặt cọc', kho_id: 'kho', nv_marketing: 'NV MKT',
    don_vi_vc: 'ĐVVC', ma_van_don: 'mã vận đơn', trang_thai_vc: 'TT vận chuyển', da_thanh_toan: 'đã thanh toán' };
  const same = (a, b) => String(a ?? '') === String(b ?? '');

  app.put('/oms/api/orders/:id', omsAuth, jsonParser, wrap(async (req, res) => {
    const { id } = req.params;
    const d = req.body || {};
    const user = req.session.omsUser;

    // Sale / kho không sửa đơn của chi nhánh ngoài quyền
    const lk = lockSql(req);
    const [old] = await db(`SELECT * FROM oms_orders WHERE id=?${lk.sql}`, [id, ...lk.params]);
    if (!old) return res.status(branchLocked(user.role) ? 403 : 404).json({ error: branchLocked(user.role) ? 'Đơn thuộc chi nhánh khác' : 'Không có đơn' });

    let allowed;
    if (user.role === 'sale') {
      // Sale: sửa được thông tin đơn + chốt/huỷ chốt/không mua/quay lại đơn mới
      allowed = ['trang_thai','ghi_chu','sale_phu_trach','ten_kh','sdt',
        'dia_chi_full','san_pham','so_luong','gia_ban','tong_tien','phi_ship','dat_coc','kho_id'];
      const saleStatuses = ['Đơn mới','Đã chốt','Không mua','KNM lần 1','KNM lần 2','KNM lần 3','KNM lần 4','KNM lần 5','KNM lần 6'];
      if (d.trang_thai && !saleStatuses.includes(d.trang_thai)) {
        return res.status(403).json({ error: 'Sale không được đổi sang trạng thái này' });
      }
    } else {
      // Admin/Warehouse có thể cập nhật hầu hết trường
      allowed = ['trang_thai','ghi_chu','sale_phu_trach','don_vi_vc','ma_van_don',
        'trang_thai_vc','nv_marketing','ten_kh','sdt','dia_chi_full','san_pham',
        'so_luong','gia_ban','tong_tien','phi_ship','dat_coc','da_thanh_toan','kho_id'];
    }

    const sets = []; const vals = [];
    const set = (f, v) => { sets.push(`${f}=?`); vals.push(v); };
    for (const f of allowed) {
      if (d[f] === undefined) continue;
      set(f, d[f]);
      if (f === 'dia_chi_full') {
        const addr = parseAddress(d[f]);
        sets.push('tinh=?', 'quan=?', 'phuong=?', 'dia_chi=?');
        vals.push(addr.tinh, addr.quan, addr.phuong, addr.diaChi);
      }
      if (f === 'sdt') set('sdt_norm', normPhone(d[f]));
    }

    // Admin chuyển đơn sang chi nhánh khác: bỏ sale / kho không thuộc chi nhánh mới
    let cnMoi = null;
    if (user.role === 'admin' && d.chi_nhanh_id !== undefined && Number(d.chi_nhanh_id) !== (Number(old.chi_nhanh_id) || 1)) {
      const cn = Number(d.chi_nhanh_id) || 1;
      const [br] = await db('SELECT id, ten FROM oms_branches WHERE id=?', [cn]);
      if (!br) return res.status(400).json({ error: 'Chi nhánh không tồn tại' });
      set('chi_nhanh_id', cn); cnMoi = br.ten;
      if (d.sale_phu_trach === undefined && old.sale_phu_trach) {
        const [s2] = await db("SELECT id FROM oms_users WHERE ho_ten=? AND role='sale' AND chi_nhanh_id=?", [old.sale_phu_trach, cn]);
        if (!s2) { set('sale_phu_trach', ''); d.sale_phu_trach = ''; }
      }
      if (d.kho_id === undefined && old.kho_id) {
        const [k] = await db('SELECT id FROM oms_warehouses WHERE id=? AND chi_nhanh_id IN (0, ?)', [old.kho_id, cn]);
        if (!k) set('kho_id', 0);
      }
    }

    // Hẹn gọi lại (sale / admin): giờ ISO từ trình duyệt → UTC; '' / null = bỏ hẹn
    let henMoi;
    if (d.hen_goi_lai !== undefined && ['sale', 'admin'].includes(user.role)) {
      if (d.hen_goi_lai) {
        const t = new Date(d.hen_goi_lai);
        if (isNaN(t)) return res.status(400).json({ error: 'Giờ hẹn không hợp lệ' });
        henMoi = utcStr(t);
      } else henMoi = null;
      set('hen_goi_lai', henMoi); set('hen_goi_bao', 0);
    }

    if (!sets.length) return res.status(400).json({ error: 'Không có gì để cập nhật' });

    // ---- Mốc thời gian + lịch sử ----
    const now = utcStr();
    const logs = [];
    const doiTT = d.trang_thai !== undefined && !same(d.trang_thai, old.trang_thai);
    const doiSale = d.sale_phu_trach !== undefined && !same(d.sale_phu_trach, old.sale_phu_trach);
    const doiNote = d.ghi_chu !== undefined && !same(d.ghi_chu, old.ghi_chu) && String(d.ghi_chu || '').trim();
    if (doiTT) {
      logs.push(['Đổi trạng thái', `${old.trang_thai} → ${d.trang_thai}`]);
      if (d.trang_thai === 'Đã chốt' && !old.chot_at) set('chot_at', now);
      // Chốt / không mua / giao vận → hết hẹn gọi lại
      if (henMoi === undefined && !(d.trang_thai === 'Đơn mới' || d.trang_thai.startsWith('KNM')) && old.hen_goi_lai) set('hen_goi_lai', null);
    }
    if (doiSale) {
      logs.push(['Chuyển sale', `${old.sale_phu_trach || '(trống)'} → ${d.sale_phu_trach || '(trống)'}`]);
      set('sale_nhan_at', d.sale_phu_trach ? now : null); set('sale_tac_nghiep_at', null);
    }
    if (doiNote) logs.push(['Ghi chú', String(d.ghi_chu).trim()]);
    if (henMoi !== undefined && !same(henMoi, old.hen_goi_lai && utcStr(old.hen_goi_lai))) {
      logs.push(['Hẹn gọi lại', henMoi ? vnTime(henMoi) : 'Bỏ hẹn']);
    }
    if (cnMoi) logs.push(['Chuyển chi nhánh', cnMoi]);
    const doiInfo = Object.keys(INFO_FIELDS).filter(f => allowed.includes(f) && d[f] !== undefined && !same(d[f], old[f]));
    if (doiInfo.length) logs.push(['Sửa thông tin', doiInfo.map(f => INFO_FIELDS[f]).join(', ')]);
    // Tác nghiệp = đổi trạng thái / ghi chú / hẹn gọi (thời gian phản hồi + chặn thu hồi đơn)
    if ((doiTT || doiNote || henMoi) && ['sale', 'admin'].includes(user.role)) {
      if (!old.tac_nghiep_dau_at) set('tac_nghiep_dau_at', now);
      if (!doiSale && !old.sale_tac_nghiep_at) set('sale_tac_nghiep_at', now);
    }

    vals.push(id);
    await db(`UPDATE oms_orders SET ${sets.join(', ')} WHERE id=?`, vals);
    for (const [h, c] of logs) await logOrder(id, user, h, c);

    // Auto-push Misa nếu trạng thái = Ship thành công (admin / kho)
    if (user.role !== 'sale' && d.trang_thai === 'Ship thành công') {
      try { await pushToMisa(id); } catch(e) { console.error('[OMS] Misa push error:', e.message); }
    }
    // Chuyển sale → báo riêng sale mới
    if (doiSale && d.sale_phu_trach && app._omsPush) {
      usernamesOf(d.sale_phu_trach).then(u => app._omsPush('Bạn được giao đơn #' + id, `${old.ten_kh || ''} — ${old.san_pham || ''}`, id, u)).catch(() => {});
    }

    res.json({ ok: true });
  }));

  // Lịch sử tác nghiệp + các đơn cùng SĐT (khách cũ / trùng số)
  app.get('/oms/api/orders/:id/history', omsAuth, wrap(async (req, res) => {
    const user = req.session.omsUser;
    const lk = lockSql(req);
    const [o] = await db(`SELECT id, sdt, sdt_norm, nv_marketing FROM oms_orders WHERE id=?${lk.sql}`, [req.params.id, ...lk.params]);
    if (!o) return res.status(404).json({ error: 'Không có đơn hoặc đơn thuộc chi nhánh khác' });
    if (user.role === 'marketing' && !getMktTeam(user).includes(o.nv_marketing)) return res.status(403).json({ error: 'Không phải đơn của bạn' });
    const logs = await db('SELECT at, nguoi, hanh_dong, chi_tiet FROM oms_order_logs WHERE order_id=? ORDER BY id DESC LIMIT 200', [o.id]);
    const key = (o.sdt_norm && o.sdt_norm !== '-') ? o.sdt_norm : normPhone(o.sdt);
    let cungSdt = [], tongCungSdt = 0;
    if (key) {
      const [c] = await db('SELECT COUNT(*) AS n FROM oms_orders WHERE sdt_norm=? AND id<>?', [key, o.id]);
      tongCungSdt = Number(c?.n) || 0;
      cungSdt = await db(`SELECT id, ngay_ve, trang_thai, san_pham, tong_tien, sale_phu_trach, chi_nhanh_id FROM oms_orders
        WHERE sdt_norm=? AND id<>?${lk.sql} ORDER BY id DESC LIMIT 30`, [key, o.id, ...lk.params]);
    }
    res.json({ logs, cungSdt, tongCungSdt });
  }));

  // ===================== XÓA ĐƠN (chỉ admin) =====================
  app.delete('/oms/api/orders/:id', requireRole('admin'), wrap(async (req, res) => {
    await db('DELETE FROM oms_orders WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  }));

  // ===================== THÔNG BÁO ĐƠN MỚI =====================
  app.get('/oms/api/new-orders', omsAuth, wrap(async (req, res) => {
    const { since_id } = req.query;
    const user = req.session.omsUser;
    let where = ['id > ?'];
    let params = [parseInt(since_id) || 0];

    if (user.role === 'sale') {
      where.push(`(sale_phu_trach = ? OR (sale_phu_trach = '' AND trang_thai = 'Đơn mới'))`);
      params.push(user.ho_ten);
    } else if (user.role === 'marketing') {
      const team = getMktTeam(user);
      where.push(`nv_marketing IN (${team.map(()=>'?').join(',')})`);
      params.push(...team);
    }
    // warehouse + admin: thấy tất cả (sale / kho: trong chi nhánh mình)
    const lk = lockSql(req);
    if (lk.sql) { where.push('chi_nhanh_id = ?'); params.push(...lk.params); }

    // max_id: id lớn nhất của mọi đơn (không lọc quyền) → trang dùng làm mốc lúc mở,
    // kể cả khi tài khoản chưa có đơn nào (trước đây mốc = 0 thì không bao giờ báo).
    // Lấy trước rồi chỉ trả đơn id <= max_id để đơn về giữa 2 câu truy vấn không bị bỏ qua.
    const [mx] = await db('SELECT MAX(id) as max_id FROM oms_orders');
    const maxId = mx?.max_id || 0;
    where.push('id <= ?'); params.push(maxId);
    const orders = await db(`SELECT id, ten_kh, sdt, san_pham, tong_tien, trang_thai, sale_phu_trach, nv_marketing
      FROM oms_orders WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 50`, params);
    res.json({ orders, count: orders.length, max_id: maxId });
  }));

  // Helper: lấy danh sách NV marketing mà user được xem (team lead → cả team)
  function getMktTeam(user) {
    return getOmsMarketingTeam(user, getTeamLead);
  }

  // ===================== THỐNG KÊ / BÁO CÁO =====================
  app.get('/oms/api/stats', omsAuth, wrap(async (req, res) => {
    const { tu, den } = req.query;
    const user = req.session.omsUser;
    let dateFilter = '';
    let params = [];
    let userFilter = '';
    if (user.role === 'marketing') {
      const team = getMktTeam(user);
      userFilter = ` AND nv_marketing IN (${team.map(()=>'?').join(',')})`;
      params.push(...team);
    } else if (user.role === 'sale') {
      userFilter = ' AND sale_phu_trach = ?'; params.push(user.ho_ten);
    }
    const cw = cnWhere(req);
    if (cw.sql) { userFilter += ' AND ' + cw.sql; params.push(...cw.params); }
    if (tu) { dateFilter += ' AND ngay_ve >= ?'; params.push(omsDateBoundary(tu)); }
    if (den) { dateFilter += ' AND ngay_ve < ?'; params.push(omsDateBoundary(den, true)); }

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
      FROM oms_orders WHERE 1=1 ${userFilter} ${dateFilter}`, params);

    // Theo Sale
    const bySale = await db(`SELECT sale_phu_trach as ten,
      COUNT(*) as tongDon,
      SUM(CASE WHEN trang_thai IN ('Đã chốt','Đang ship','Ship thành công') THEN 1 ELSE 0 END) as daChot,
      ROUND(SUM(CASE WHEN trang_thai IN ('Đã chốt','Đang ship','Ship thành công') THEN 1 ELSE 0 END)*100/COUNT(*),1) as tyLeChot,
      ROUND(AVG(CASE WHEN tac_nghiep_dau_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, ngay_ve, tac_nghiep_dau_at) END)) as phanHoiPhut,
      SUM(CASE WHEN tac_nghiep_dau_at IS NOT NULL THEN 1 ELSE 0 END) as soPhanHoi
      FROM oms_orders WHERE sale_phu_trach != '' ${userFilter} ${dateFilter}
      GROUP BY sale_phu_trach ORDER BY daChot DESC`, params);

    // Theo Marketing
    const byMkt = await db(`SELECT nv_marketing as ten,
      COUNT(*) as tongDon,
      SUM(CASE WHEN trang_thai IN ('Đã chốt','Đang ship','Ship thành công') THEN 1 ELSE 0 END) as daChot
      FROM oms_orders WHERE nv_marketing != '' ${userFilter} ${dateFilter}
      GROUP BY nv_marketing ORDER BY tongDon DESC`, params);

    // Theo ngày (7 ngày gần nhất)
    const byDay = await db(`SELECT DATE(ngay_ve) as ngay, COUNT(*) as soDon,
      SUM(CASE WHEN trang_thai='Ship thành công' THEN tong_tien ELSE 0 END) as doanhThu
      FROM oms_orders WHERE ngay_ve >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) ${userFilter} ${dateFilter}
      GROUP BY DATE(ngay_ve) ORDER BY ngay DESC`, params);

    res.json({ overview: overview || {}, bySale, byMkt, byDay });
  }));

  // ===================== QUẢN LÝ TÀI KHOẢN (Admin) =====================
  app.get('/oms/api/users', requireRole('admin'), wrap(async (req, res) => {
    const rows = await db('SELECT id, username, ho_ten, role, active, chi_nhanh_id, xem_chi_nhanh, nhan_don FROM oms_users ORDER BY role, ho_ten');
    res.json(rows);
  }));

  app.post('/oms/api/users', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const { username, password, ho_ten, role, chi_nhanh_id } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Thiếu username/password' });
    await ensureTables(getPool());
    const xem = normXemCn(req.body.xem_chi_nhanh);
    if (xem === null) return res.status(400).json({ error: 'Quyền xem chi nhánh không hợp lệ' });
    await db('INSERT INTO oms_users (username, password, ho_ten, role, chi_nhanh_id, xem_chi_nhanh) VALUES (?,?,?,?,?,?)',
      [username, password, ho_ten || username, role || 'sale', Number(chi_nhanh_id) || 1, xem]);
    res.json({ ok: true });
  }));

  app.put('/oms/api/users/:id', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const { ho_ten, role, active, password, chi_nhanh_id } = req.body;
    const sets = [];
    const vals = [];
    if (chi_nhanh_id !== undefined) { sets.push('chi_nhanh_id=?'); vals.push(Number(chi_nhanh_id) || 1); }
    if (req.body.nhan_don !== undefined) { sets.push('nhan_don=?'); vals.push(req.body.nhan_don ? 1 : 0); }
    if (req.body.xem_chi_nhanh !== undefined) {
      const xem = normXemCn(req.body.xem_chi_nhanh);
      if (xem === null) return res.status(400).json({ error: 'Quyền xem chi nhánh không hợp lệ' });
      sets.push('xem_chi_nhanh=?'); vals.push(xem);
    }
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

    const lk = lockSql(req);
    const orders = await db(`SELECT * FROM oms_orders WHERE id IN (${ids.map(()=>'?').join(',')})${lk.sql}`, [...ids, ...lk.params]);
    const results = [];
    const apiUrl = 'https://services.giaohangtietkiem.vn';

    for (const o of orders) {
      try {
        // Lấy config từ kho của đơn
        const wCfg = await getWarehouseConfig(o.kho_id);
        if (!wCfg.ghtk_token) { results.push({ id: o.id, ok: false, error: 'Chưa cấu hình GHTK Token cho kho "'+wCfg.ten_kho+'"' }); continue; }
        if (!wCfg.pick_address) { results.push({ id: o.id, ok: false, error: 'Chưa nhập địa chỉ lấy hàng cho kho "'+wCfg.ten_kho+'"' }); continue; }

        // Xử lý tỉnh/quận/phường người nhận — strip prefix
        let recvProvince = (o.tinh || '').replace(/^(TP |Tỉnh |T\.P\.?\s*)/i, '').trim();
        let recvDistrict = (o.quan || '').trim();
        let recvWard = (o.phuong || '').trim();

        // Nếu tỉnh trống → thử tách lại từ địa chỉ đầy đủ
        if (!recvProvince && o.dia_chi_full) {
          const addr = parseAddress(o.dia_chi_full);
          recvProvince = (addr.tinh || '').replace(/^(TP |Tỉnh |T\.P\.?\s*)/i, '').trim();
          recvDistrict = recvDistrict || addr.quan;
          recvWard = recvWard || addr.phuong;
          // Cập nhật lại DB để lần sau không lỗi
          if (recvProvince) {
            try { await db('UPDATE oms_orders SET tinh=?, quan=?, phuong=?, dia_chi=? WHERE id=?',
              [addr.tinh, addr.quan, addr.phuong, addr.diaChi, o.id]); } catch(e) {}
          }
        }

        if (!recvProvince) { results.push({ id: o.id, ok: false, error: `Đơn #${o.id}: Thiếu tỉnh/TP người nhận. Vui lòng sửa địa chỉ đơn hàng.` }); continue; }

        // Strip prefix quận/huyện/phường cho GHTK
        const cleanDistrict = recvDistrict.replace(/^(Quận|Huyện|Thị xã|TX\.?|Thành phố)\s*/i, '').trim();
        const cleanWard = recvWard.replace(/^(Phường|Xã|Thị trấn|TT\.?)\s*/i, '').trim();

        // Sinh/lấy mã đơn hàng unique
        let maDonHang = o.ma_don_hang;
        if (!maDonHang) {
          maDonHang = `OM${String(Math.floor(100000+Math.random()*900000))}`;
          await db('UPDATE oms_orders SET ma_don_hang=? WHERE id=?', [maDonHang, o.id]);
        }

        const codAmount = Math.max(0, (o.tong_tien || 0) - (o.dat_coc || 0));

        const body = {
          products: [{ name: o.san_pham || 'Sản phẩm', weight: 0.5, quantity: o.so_luong || 1, product_code: '' }],
          order: {
            id: maDonHang,
            pick_name: wCfg.pick_name,
            pick_money: codAmount,
            pick_address: wCfg.pick_address,
            pick_province: wCfg.pick_province,
            pick_district: wCfg.pick_district,
            pick_tel: wCfg.pick_tel,
            name: o.ten_kh,
            address: o.dia_chi || o.dia_chi_full,
            province: recvProvince,
            district: recvDistrict,
            ward: recvWard,
            tel: o.sdt,
            email: '',
            hamlet: 'Khác',
            is_freeship: 1,
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
          // Phí VC dịch vụ: trường fee của GHTK (chưa đối chiếu với đơn thật; không có thì để 0, kho sửa lúc đối soát)
          const fee = Math.round(Number(data.order?.fee) || 0);
          logOrder(o.id, req.session.omsUser, 'Đăng vận đơn', 'GHTK ' + (data.order?.label || '') + (fee ? ` · phí ${fee}` : ''));
          await db(`UPDATE oms_orders SET don_vi_vc='GHTK', ma_van_don=?, trang_thai='Đang ship', dang_vc_at=?, phi_vc_dv=IF(?>0, ?, phi_vc_dv) WHERE id=?`,
            [data.order?.label || '', utcStr(), fee, fee, o.id]);
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

    const lk = lockSql(req);
    const orders = await db(`SELECT * FROM oms_orders WHERE id IN (${ids.map(()=>'?').join(',')})${lk.sql}`, [...ids, ...lk.params]);
    const results = [];

    for (const o of orders) {
      try {
        // Sinh mã đơn hàng nếu chưa có
        let maDonHang = o.ma_don_hang;
        if (!maDonHang) {
          maDonHang = `OM${String(Math.floor(100000+Math.random()*900000))}`;
          await db('UPDATE oms_orders SET ma_don_hang=? WHERE id=?', [maDonHang, o.id]);
        }
        const body = {
          ORDER_NUMBER: maDonHang,
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
          // Phí VC dịch vụ: MONEY_TOTAL của VTP (chưa đối chiếu với đơn thật)
          const fee = Math.round(Number(data.data.MONEY_TOTAL) || 0);
          logOrder(o.id, req.session.omsUser, 'Đăng vận đơn', 'VTP ' + (data.data.ORDER_NUMBER || '') + (fee ? ` · phí ${fee}` : ''));
          await db(`UPDATE oms_orders SET don_vi_vc='VTP', ma_van_don=?, trang_thai='Đang ship', dang_vc_at=?, phi_vc_dv=IF(?>0, ?, phi_vc_dv) WHERE id=?`,
            [data.data.ORDER_NUMBER || '', utcStr(), fee, fee, o.id]);
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

  // ===================== ĐỔI MÃ ĐƠN HÀNG =====================
  app.post('/oms/api/change-order-code', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const { id, ma_don_hang } = req.body;
    if (!id) return res.status(400).json({ error: 'Thiếu ID đơn' });
    const newCode = ma_don_hang || `OM${String(Math.floor(100000+Math.random()*900000))}`;
    const lk = lockSql(req);
    const r = await db(`UPDATE oms_orders SET ma_don_hang=? WHERE id=?${lk.sql}`, [newCode, id, ...lk.params]);
    if (!r.affectedRows) return res.status(403).json({ error: 'Đơn thuộc chi nhánh khác' });
    res.json({ ok: true, ma_don_hang: newCode });
  }));

  // ===================== HUỶ ĐƠN GHTK =====================
  app.post('/oms/api/cancel-ghtk', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'Chưa chọn đơn' });

    const lk = lockSql(req);
    const orders = await db(`SELECT * FROM oms_orders WHERE id IN (${ids.map(()=>'?').join(',')})${lk.sql}`, [...ids, ...lk.params]);
    const results = [];

    for (const o of orders) {
      if (o.don_vi_vc !== 'GHTK' || !o.ma_van_don) {
        results.push({ id: o.id, ok: false, error: 'Đơn chưa đăng GHTK hoặc thiếu mã vận đơn' });
        continue;
      }
      try {
        const wCfg = await getWarehouseConfig(o.kho_id);
        if (!wCfg.ghtk_token) { results.push({ id: o.id, ok: false, error: 'Thiếu GHTK Token' }); continue; }

        const resp = await fetch(`https://services.giaohangtietkiem.vn/services/shipment/cancel/${o.ma_van_don}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Token': wCfg.ghtk_token },
        });
        const data = await resp.json();

        if (data.success) {
          // Sinh mã đơn hàng mới để lần đăng lại không bị trùng
          const newMaDH = `OM${String(Math.floor(100000+Math.random()*900000))}`;
          await db(`UPDATE oms_orders SET don_vi_vc='', ma_van_don='', ma_don_hang=?, trang_thai='Đã chốt', trang_thai_vc='Đã huỷ GHTK', da_dong_goi=0 WHERE id=?`, [newMaDH, o.id]);
          logOrder(o.id, req.session.omsUser, 'Huỷ vận đơn', 'GHTK ' + o.ma_van_don);
          results.push({ id: o.id, ok: true, message: 'Đã huỷ trên GHTK' });
        } else {
          results.push({ id: o.id, ok: false, error: data.message || 'GHTK từ chối huỷ' });
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
            const statusText = data.order.status_text || String(st);
            let newTrangThai = 'Đang ship'; // giữ nguyên mặc định
            if (st === 5 || st === 6) newTrangThai = 'Ship thành công';
            else if (st === 13 || st === 21) newTrangThai = 'Hoàn thành công';
            // Luôn cập nhật trang_thai_vc cho mọi trạng thái
            await db('UPDATE oms_orders SET trang_thai=?, trang_thai_vc=? WHERE id=?',
              [newTrangThai, statusText, o.id]);
            if (newTrangThai !== 'Đang ship') logOrder(o.id, 'Đồng bộ VC', 'Đổi trạng thái', `Đang ship → ${newTrangThai} (${statusText})`);
            if (newTrangThai === 'Ship thành công') {
              try { await pushToMisa(o.id); } catch(e) {}
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
            const statusText = data.data.ORDER_STATUSTEXT || String(st);
            let newTrangThai = 'Đang ship';
            if (st === 501 || st === 503) newTrangThai = 'Ship thành công';
            else if (st === 504 || st === 505) newTrangThai = 'Hoàn thành công';
            await db('UPDATE oms_orders SET trang_thai=?, trang_thai_vc=? WHERE id=?',
              [newTrangThai, statusText, o.id]);
            if (newTrangThai !== 'Đang ship') logOrder(o.id, 'Đồng bộ VC', 'Đổi trạng thái', `Đang ship → ${newTrangThai} (${statusText})`);
            if (newTrangThai === 'Ship thành công') {
              try { await pushToMisa(o.id); } catch(e) {}
            }
          }
        } catch(e) { console.error('[OMS] VTP sync error:', o.id, e.message); }
      }

      console.log('[OMS] Đồng bộ xong:', orders.length, 'đơn');
    } catch(e) { console.error('[OMS] Sync error:', e.message); }
  }

  // Cronjob mỗi 30 phút đồng bộ trạng thái vận chuyển
  function scheduleCronjob() {
    // Chạy lần đầu sau 2 phút khởi động
    setTimeout(() => syncShippingStatus(), 2 * 60 * 1000);
    // Sau đó mỗi 30 phút
    setInterval(() => syncShippingStatus(), 30 * 60 * 1000);
    console.log('[OMS] Cronjob đồng bộ vận chuyển: mỗi 30 phút');
  }

  // API thủ công đồng bộ (admin)
  app.post('/oms/api/sync-shipping', requireRole('admin'), wrap(async (req, res) => {
    await syncShippingStatus();
    res.json({ ok: true, message: 'Đã đồng bộ xong' });
  }));

  // ===================== TÍCH HỢP MISA =====================
  // Mỗi chi nhánh xuất bằng tài khoản MISA (MST) riêng ở oms_branches; chi nhánh chưa cài thì không xuất.
  // Biến môi trường MISA_* chỉ là dự phòng cho HKD TD (chi nhánh 1).
  async function pushToMisa(orderId) {
    const [order] = await db('SELECT * FROM oms_orders WHERE id=? AND da_xuat_hd=0', [orderId]);
    if (!order) return;
    const cn = Number(order.chi_nhanh_id) || 1;
    const [br] = await db('SELECT * FROM oms_branches WHERE id=?', [cn]);
    const accessToken = br?.misa_access_token || (cn === 1 ? process.env.MISA_ACCESS_TOKEN : '') || '';
    const appId = br?.misa_app_id || (cn === 1 ? process.env.MISA_APP_ID : '') || '';
    if (!accessToken || !appId) {
      console.log(`[OMS] Chi nhánh ${br?.ten || cn} chưa cài MISA, không xuất HĐ đơn ${orderId}`);
      return;
    }

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
        console.log('[OMS] Misa invoice created for order', orderId, 'chi nhánh', br?.ten || cn);
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
    await db(`UPDATE oms_orders SET sale_phu_trach=?, sale_nhan_at=?, sale_tac_nghiep_at=NULL WHERE id IN (${ids.map(()=>'?').join(',')})`, [sale, utcStr(), ...ids]);
    for (const i of ids) logOrder(i, req.session.omsUser, 'Chuyển sale', sale);
    res.json({ ok: true });
  }));

  // Phân đơn tự động chia đều cho tất cả Sale
  app.post('/oms/api/auto-assign', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const { ids } = req.body; // danh sách ID đơn cần phân
    // Mỗi chi nhánh chia cho sale của chi nhánh đó
    const sales = await db("SELECT ho_ten, chi_nhanh_id FROM oms_users WHERE role='sale' AND active=1 AND nhan_don=1 ORDER BY ho_ten");
    if (!sales.length) return res.status(400).json({ error: 'Chưa có Sale nào đang bật nhận đơn' });

    let orders;
    if (ids?.length) {
      orders = await db(`SELECT id, chi_nhanh_id FROM oms_orders WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`, ids);
    } else {
      // Nếu không truyền IDs → phân tất cả đơn mới chưa phân
      orders = await db("SELECT id, chi_nhanh_id FROM oms_orders WHERE trang_thai='Đơn mới' AND (sale_phu_trach='' OR sale_phu_trach IS NULL) ORDER BY id");
    }
    if (!orders.length) return res.json({ ok: true, message: 'Không có đơn nào cần phân' });

    // Chia đều round-robin trong từng chi nhánh
    const byCn = {};
    for (const s of sales) (byCn[Number(s.chi_nhanh_id) || 1] ||= []).push(s.ho_ten);
    const turn = {};
    let assigned = 0, skipped = 0;
    const used = new Set();
    for (const o of orders) {
      const cn = Number(o.chi_nhanh_id) || 1;
      const names = byCn[cn];
      if (!names?.length) { skipped++; continue; }
      const saleName = names[(turn[cn] = (turn[cn] ?? -1) + 1) % names.length];
      await db('UPDATE oms_orders SET sale_phu_trach=?, sale_nhan_at=?, sale_tac_nghiep_at=NULL WHERE id=?', [saleName, utcStr(), o.id]);
      logOrder(o.id, req.session.omsUser, 'Chia sale', saleName);
      used.add(saleName);
      assigned++;
    }

    res.json({ ok: true, message: `Đã phân ${assigned} đơn cho ${used.size} Sale` + (skipped ? ` (${skipped} đơn chưa phân: chi nhánh chưa có Sale đang nhận đơn)` : ''), assigned, sales: [...used] });
  }));

  // ===================== QUẢN LÝ KHO (Admin) =====================
  app.get('/oms/api/warehouses', omsAuth, wrap(async (req, res) => {
    // Sale / kho: kho của các chi nhánh được xem + kho dùng chung (chi_nhanh_id 0)
    const allow = viewCns(req.session.omsUser);
    const rows = allow
      ? await db(`SELECT * FROM oms_warehouses WHERE active=1 AND chi_nhanh_id IN (0, ${allow.map(() => '?').join(',')}) ORDER BY ten_kho`, allow)
      : await db('SELECT * FROM oms_warehouses WHERE active=1 ORDER BY ten_kho');
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
       vtp_username, vtp_password, vtp_sender_name, vtp_sender_address, vtp_sender_phone, chi_nhanh_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.ten_kho, d.dia_chi||'', d.tinh||'', d.quan||'', d.sdt||'',
       d.ghtk_token||'', d.ghtk_pick_name||'', d.ghtk_pick_address||'', d.ghtk_pick_province||'', d.ghtk_pick_district||'', d.ghtk_pick_tel||'',
       d.vtp_username||'', d.vtp_password||'', d.vtp_sender_name||'', d.vtp_sender_address||'', d.vtp_sender_phone||'',
       Number(d.chi_nhanh_id) || 0]);
    res.json({ ok: true, id: result.insertId });
  }));

  app.put('/oms/api/warehouses/:id', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const d = req.body;
    const fields = ['ten_kho','dia_chi','tinh','quan','sdt','active',
      'ghtk_token','ghtk_pick_name','ghtk_pick_address','ghtk_pick_province','ghtk_pick_district','ghtk_pick_tel',
      'vtp_username','vtp_password','vtp_token','vtp_sender_name','vtp_sender_address','vtp_sender_phone','chi_nhanh_id'];
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

  // ===================== KHO: QUÉT MÃ / ĐỐI SOÁT / HÀNG HOÀN =====================
  // Cài đặt tác nghiệp (mọi tài khoản đọc; admin sửa qua /oms/api/config)
  app.get('/oms/api/ops-config', omsAuth, wrap(async (req, res) => {
    res.json({ han_gui_gio: await cfgNum('han_gui_gio', 24), thu_hoi_phut: await cfgNum('thu_hoi_phut', 0) });
  }));

  // Quét mã khi đóng gói: mã vận đơn / mã đơn hàng / #id → đánh dấu đã đóng gói
  app.post('/oms/api/kho/quet', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const ma = String(req.body?.ma || '').trim();
    if (!ma) return res.status(400).json({ error: 'Chưa có mã' });
    const lk = lockSql(req);
    const idNum = /^#?\d{1,9}$/.test(ma) ? Number(ma.replace('#', '')) : 0;
    const [o] = await db(`SELECT * FROM oms_orders WHERE (ma_van_don=? OR ma_don_hang=? OR id=?)${lk.sql}
      AND trang_thai IN ('Đã chốt','Đang ship') ORDER BY id DESC LIMIT 1`, [ma, ma, idNum, ...lk.params]);
    if (!o) return res.status(404).json({ error: `Không thấy đơn chờ giao có mã "${ma}" (hoặc đơn thuộc chi nhánh khác)` });
    const moi = !o.da_dong_goi;
    if (moi) {
      await db('UPDATE oms_orders SET da_dong_goi=1 WHERE id=?', [o.id]);
      await logOrder(o.id, req.session.omsUser, 'Đóng gói', 'Quét mã ' + ma);
    }
    res.json({ ok: true, id: o.id, moi, ten_kh: o.ten_kh, san_pham: o.san_pham, so_luong: o.so_luong });
  }));

  // Đối soát COD: đơn đã giao / đã hoàn. bo=true = bỏ đối soát. phi_vc_dv / phi_hoan: sửa phí nếu gửi lên
  app.post('/oms/api/kho/doi-soat', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Chưa chọn đơn' });
    const bo = !!req.body.bo;
    const lk = lockSql(req);
    const rows = await db(`SELECT id, da_doi_soat FROM oms_orders WHERE id IN (${ids.map(() => '?').join(',')})${lk.sql}
      AND trang_thai IN ('Ship thành công','Hoàn thành công')`, [...ids, ...lk.params]);
    const phi = k => req.body[k] === undefined || req.body[k] === '' ? null : Math.max(0, Math.round(Number(req.body[k]) || 0));
    const phiVc = phi('phi_vc_dv'), phiHoan = phi('phi_hoan');
    let n = 0;
    for (const r of rows) {
      const sets = ['da_doi_soat=?', 'doi_soat_at=?']; const vals = [bo ? 0 : 1, bo ? null : utcStr()];
      if (phiVc !== null) { sets.push('phi_vc_dv=?'); vals.push(phiVc); }
      if (phiHoan !== null) { sets.push('phi_hoan=?'); vals.push(phiHoan); }
      await db(`UPDATE oms_orders SET ${sets.join(',')} WHERE id=?`, [...vals, r.id]);
      await logOrder(r.id, req.session.omsUser, bo ? 'Bỏ đối soát' : 'Đối soát COD',
        [phiVc !== null && `phí VC ${phiVc}`, phiHoan !== null && `phí hoàn ${phiHoan}`].filter(Boolean).join(', '));
      n++;
    }
    res.json({ ok: true, n, boQua: ids.length - n });
  }));

  // Đã nhận lại hàng hoàn (kiểm hàng) + lý do
  app.post('/oms/api/kho/nhan-hoan', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const id = Number(req.body?.id);
    const lk = lockSql(req);
    const [o] = await db(`SELECT id FROM oms_orders WHERE id=? AND trang_thai='Hoàn thành công'${lk.sql}`, [id, ...lk.params]);
    if (!o) return res.status(404).json({ error: 'Đơn không ở trạng thái Hoàn thành công (hoặc thuộc chi nhánh khác)' });
    const lyDo = String(req.body.ly_do || '').trim().slice(0, 255);
    const phiHoan = req.body.phi_hoan === undefined || req.body.phi_hoan === '' ? null : Math.max(0, Math.round(Number(req.body.phi_hoan) || 0));
    await db(`UPDATE oms_orders SET da_nhan_hoan=1, nhan_hoan_at=?, ly_do_hoan=?${phiHoan !== null ? ', phi_hoan=?' : ''} WHERE id=?`,
      phiHoan !== null ? [utcStr(), lyDo, phiHoan, id] : [utcStr(), lyDo, id]);
    await logOrder(id, req.session.omsUser, 'Nhận hàng hoàn', [lyDo, phiHoan !== null && `phí hoàn ${phiHoan}`].filter(Boolean).join(' · '));
    res.json({ ok: true });
  }));

  // ===================== GIAO HÀNG THỦ CÔNG (không qua GHTK / VTP) =====================
  // Như "Giao hàng thủ công" của Sandbox: don_vi_vc = 'Ship ngoài' (shipper riêng / xe nhà → Đang ship, kho tự báo
  // đã giao / hoàn) hoặc 'Khách lấy' (khách đến lấy → Ship thành công ngay). Không có mã vận đơn thì tự sinh TC<id>.
  // Đồng bộ VC (syncShippingStatus) chỉ hỏi GHTK / VTP nên không đụng các đơn này.
  const GIAO_TC = { ship_ngoai: 'Ship ngoài', khach_lay: 'Khách lấy' };
  const isThuCong = vc => Object.values(GIAO_TC).includes(vc);
  app.get('/oms/api/kho/nguoi-giao', requireRole('admin', 'warehouse'), wrap(async (req, res) => {
    const rows = await db(`SELECT nguoi_giao, COUNT(*) AS n FROM oms_orders WHERE nguoi_giao<>''
      GROUP BY nguoi_giao ORDER BY n DESC LIMIT 30`);
    res.json(rows.map(r => r.nguoi_giao));
  }));
  app.post('/oms/api/kho/giao-thu-cong', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const d = req.body || {};
    const ids = (d.ids || []).map(Number).filter(Boolean);
    const vc = GIAO_TC[d.hinh_thuc];
    if (!ids.length) return res.status(400).json({ error: 'Chưa chọn đơn' });
    if (!vc) return res.status(400).json({ error: 'Chọn hình thức giao' });
    if (d.ma_van_don && ids.length > 1) return res.status(400).json({ error: 'Mã vận đơn tự nhập chỉ dùng khi giao 1 đơn' });
    const nguoi = String(d.nguoi_giao || '').trim().slice(0, 120);
    const phi = Math.max(0, Math.round(Number(d.phi) || 0));
    const note = String(d.ghi_chu || '').trim().slice(0, 300);
    const lk = lockSql(req);
    const orders = await db(`SELECT id, ma_van_don FROM oms_orders WHERE id IN (${ids.map(() => '?').join(',')})${lk.sql}
      AND trang_thai='Đã chốt'`, [...ids, ...lk.params]);
    const results = [];
    for (const o of orders) {
      if (o.ma_van_don) { results.push({ id: o.id, ok: false, error: 'Đơn đã có mã vận đơn' }); continue; }
      const ma = String(d.ma_van_don || '').trim().slice(0, 100) || `TC${o.id}`;
      const xong = d.hinh_thuc === 'khach_lay';
      const now = utcStr();
      const r = await db(`UPDATE oms_orders SET don_vi_vc=?, ma_van_don=?, nguoi_giao=?, phi_vc_dv=?, dang_vc_at=?,
        trang_thai=?, trang_thai_vc=? WHERE id=? AND trang_thai='Đã chốt' AND ma_van_don=''`,
        [vc, ma, nguoi, phi, now, xong ? 'Ship thành công' : 'Đang ship', xong ? 'Khách đã nhận hàng' : 'Đang giao (thủ công)', o.id]);
      if (!r.affectedRows) { results.push({ id: o.id, ok: false, error: 'Đơn vừa được cập nhật ở nơi khác' }); continue; }
      await logOrder(o.id, req.session.omsUser, 'Giao thủ công', [vc, nguoi && `người giao: ${nguoi}`, phi && `phí ${phi}`, note].filter(Boolean).join(' · '));
      if (xong) { try { await pushToMisa(o.id); } catch (e) { console.error('[OMS] Misa push error:', e.message); } }
      results.push({ id: o.id, ok: true, label: ma });
    }
    for (const id of ids) if (!orders.some(o => o.id === id)) results.push({ id, ok: false, error: 'Đơn không ở trạng thái Đã chốt (hoặc thuộc chi nhánh khác)' });
    res.json({ ok: true, results });
  }));
  // Kết quả đơn giao thủ công: giao = Ship thành công, hoan = Hoàn thành công, huy = về Đã chốt (bỏ mã)
  app.post('/oms/api/kho/ket-qua-thu-cong', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const id = Number(req.body?.id), kq = req.body?.ket_qua;
    const lk = lockSql(req);
    const [o] = await db(`SELECT id, don_vi_vc, trang_thai FROM oms_orders WHERE id=?${lk.sql}`, [id, ...lk.params]);
    if (!o || !isThuCong(o.don_vi_vc)) return res.status(404).json({ error: 'Không phải đơn giao thủ công (hoặc thuộc chi nhánh khác)' });
    const MAP = {
      giao: ['Ship thành công', 'Đã giao (thủ công)', 'Đã giao'],
      hoan: ['Hoàn thành công', 'Hoàn (thủ công)', 'Hoàn hàng'],
    };
    if (kq === 'huy') {
      if (o.trang_thai !== 'Đang ship') return res.status(400).json({ error: 'Chỉ huỷ được đơn đang giao' });
      await db(`UPDATE oms_orders SET don_vi_vc='', ma_van_don='', nguoi_giao='', trang_thai='Đã chốt', trang_thai_vc='Huỷ giao thủ công',
        da_dong_goi=0, dang_vc_at=NULL WHERE id=?`, [id]);
      await logOrder(id, req.session.omsUser, 'Huỷ giao thủ công', o.don_vi_vc);
      return res.json({ ok: true });
    }
    const m = MAP[kq];
    if (!m) return res.status(400).json({ error: 'Kết quả không hợp lệ' });
    if (o.trang_thai !== 'Đang ship') return res.status(400).json({ error: 'Đơn không ở trạng thái Đang ship' });
    await db('UPDATE oms_orders SET trang_thai=?, trang_thai_vc=? WHERE id=?', [m[0], m[1], id]);
    await logOrder(id, req.session.omsUser, 'Đổi trạng thái', `Đang ship → ${m[0]} (${m[2]}, thủ công)`);
    if (kq === 'giao') { try { await pushToMisa(id); } catch (e) { console.error('[OMS] Misa push error:', e.message); } }
    res.json({ ok: true });
  }));

  // ===================== DANH SÁCH NV (cho dropdown) =====================
  app.get('/oms/api/employees', omsAuth, wrap(async (req, res) => {
    // Sale / kho chỉ thấy sale cùng chi nhánh; salesCN kèm chi nhánh để trang lọc khi chuyển sale
    const lk = lockSql(req);
    const sales = await db(`SELECT ho_ten, MIN(chi_nhanh_id) AS chi_nhanh_id FROM oms_users WHERE role='sale' AND active=1${lk.sql} GROUP BY ho_ten`, lk.params);
    const mkts = await db("SELECT DISTINCT ho_ten FROM oms_users WHERE role='marketing' AND active=1");
    res.json({ sales: sales.map(r => r.ho_ten), salesCN: sales.map(r => ({ ten: r.ho_ten, chi_nhanh_id: Number(r.chi_nhanh_id) || 1 })),
      marketings: mkts.map(r => r.ho_ten) });
  }));

  // ===================== CHI NHÁNH =====================
  // Mọi tài khoản: id + tên + MST (để lọc / hiện nhãn). Admin: thêm cấu hình MISA của từng chi nhánh.
  app.get('/oms/api/branches', omsAuth, wrap(async (req, res) => {
    await ensureTables(getPool());
    const rows = await db('SELECT * FROM oms_branches ORDER BY id');
    const isAdmin = req.session.omsUser.role === 'admin';
    res.json(rows.map(r => isAdmin ? r : { id: r.id, ten: r.ten, ma_so_thue: r.ma_so_thue, active: r.active }));
  }));
  app.post('/oms/api/branches', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const ten = String(req.body?.ten || '').trim();
    if (!ten) return res.status(400).json({ error: 'Thiếu tên chi nhánh' });
    const r = await db('INSERT INTO oms_branches (ten, ma_so_thue, misa_app_id, misa_access_token) VALUES (?,?,?,?)',
      [ten, req.body.ma_so_thue || '', req.body.misa_app_id || '', req.body.misa_access_token || '']);
    res.json({ ok: true, id: r.insertId });
  }));
  app.put('/oms/api/branches/:id', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    const sets = []; const vals = [];
    for (const f of ['ten', 'ma_so_thue', 'misa_app_id', 'misa_access_token', 'active']) {
      if (req.body?.[f] !== undefined) { sets.push(`${f}=?`); vals.push(f === 'active' ? (req.body[f] ? 1 : 0) : String(req.body[f]).trim()); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Không có gì' });
    if (req.body.ten !== undefined && !String(req.body.ten).trim()) return res.status(400).json({ error: 'Tên chi nhánh trống' });
    vals.push(req.params.id);
    await db(`UPDATE oms_branches SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  }));

  // ===================== API ĐỊA CHỈ VIỆT NAM (proxy từ API công khai) =====================
  // Frontend gọi endpoint này → server fetch từ provinces.open-api.vn
  app.get('/oms/api/address/provinces', wrap(async (req, res) => {
    try {
      const r = await fetch('https://provinces.open-api.vn/api/?depth=1');
      const data = await r.json();
      res.json(data);
    } catch(e) { res.json(TINH_TP.map((t,i) => ({ code: i+1, name: t }))); }
  }));

  app.get('/oms/api/address/districts/:provinceCode', wrap(async (req, res) => {
    try {
      const r = await fetch(`https://provinces.open-api.vn/api/p/${req.params.provinceCode}?depth=2`);
      const data = await r.json();
      res.json(data.districts || []);
    } catch(e) { res.json([]); }
  }));

  app.get('/oms/api/address/wards/:districtCode', wrap(async (req, res) => {
    try {
      const r = await fetch(`https://provinces.open-api.vn/api/d/${req.params.districtCode}?depth=2`);
      const data = await r.json();
      res.json(data.wards || []);
    } catch(e) { res.json([]); }
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
  // Cùng URL (bỏ khoảng trắng, không phân biệt hoa thường, bỏ / cuối) đã đăng ký → trả dòng đó
  const linkKey = u => String(u || '').trim().toLowerCase().replace(/\/+$/, '');
  async function findDupLink(url, exceptId = 0) {
    const key = linkKey(url);
    if (!key) return null;
    const rows = await db('SELECT id, url_pattern, nv_marketing, ten_sp, active FROM oms_link_registry WHERE id<>?', [Number(exceptId) || 0]);
    return rows.find(r => linkKey(r.url_pattern) === key) || null;
  }
  const dupLinkMsg = r => `Link này đã đăng ký rồi (#${r.id}, NV ${r.nv_marketing}, SP ${r.ten_sp || '?'}${r.active ? '' : ', đang tắt'}). Sửa dòng đó thay vì đăng ký thêm.`;

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

    // Chặn đăng ký trùng: máy chủ chỉ dùng 1 dòng cho mỗi URL khi nhận đơn, các dòng trùng chỉ làm rối bảng
    const dup = await findDupLink(d.url_pattern);
    if (dup) return res.status(409).json({ error: dupLinkMsg(dup) });

    // Chi nhánh nhận đơn của link (mặc định HKD TD)
    const cn = Number(d.chi_nhanh_id) || 1;
    const [br] = await db('SELECT id FROM oms_branches WHERE id=?', [cn]);
    if (!br) return res.status(400).json({ error: 'Chi nhánh không tồn tại' });

    const result = await db(`INSERT INTO oms_link_registry (url_pattern, product_id, ten_sp, nv_marketing, nguon_du_lieu, ghi_chu, chi_nhanh_id)
      VALUES (?,?,?,?,?,?,?)`,
      [d.url_pattern, d.product_id, tenSp, nvName, d.nguon_du_lieu||'', d.ghi_chu||'', cn]);
    res.json({ ok: true, id: result.insertId });
  }));

  app.put('/oms/api/links/:id', omsAuth, jsonParser, wrap(async (req, res) => {
    const d = req.body;
    const user = req.session.omsUser;
    if (user.role === 'marketing') {
      const [existing] = await db('SELECT nv_marketing FROM oms_link_registry WHERE id=?', [req.params.id]);
      if (existing?.nv_marketing !== user.ho_ten) return res.status(403).json({ error: 'Không phải link của bạn' });
    }
    const sets = []; const vals = [];
    if (d.url_pattern) {
      const dup = await findDupLink(d.url_pattern, req.params.id);
      if (dup) return res.status(409).json({ error: dupLinkMsg(dup) });
      sets.push('url_pattern=?'); vals.push(d.url_pattern);
    }
    if (d.product_id) {
      sets.push('product_id=?'); vals.push(d.product_id);
      try { const [p] = await db('SELECT ten_sp FROM oms_products WHERE id=?', [d.product_id]); sets.push('ten_sp=?'); vals.push(p?.ten_sp||''); } catch(e) {}
    }
    if (d.nguon_du_lieu !== undefined) { sets.push('nguon_du_lieu=?'); vals.push(d.nguon_du_lieu); }
    if (d.ghi_chu !== undefined) { sets.push('ghi_chu=?'); vals.push(d.ghi_chu); }
    if (d.active !== undefined) { sets.push('active=?'); vals.push(d.active); }
    if (d.chi_nhanh_id !== undefined) {
      const cn = Number(d.chi_nhanh_id) || 1;
      const [br] = await db('SELECT id FROM oms_branches WHERE id=?', [cn]);
      if (!br) return res.status(400).json({ error: 'Chi nhánh không tồn tại' });
      sets.push('chi_nhanh_id=?'); vals.push(cn);
    }
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

  // ===================== THỐNG KÊ MARKETING (theo NV + nguồn dữ liệu) =====================
  app.get('/oms/api/mkt-stats', requireRole('admin', 'marketing'), wrap(async (req, res) => {
    const { tu, den } = req.query;
    const user = req.session.omsUser;
    let userFilter = ''; let params = [];
    if (user.role === 'marketing') {
      const team = getMktTeam(user);
      userFilter = ` AND nv_marketing IN (${team.map(()=>'?').join(',')})`;
      params.push(...team);
    }
    const cw = cnWhere(req);
    if (cw.sql) { userFilter += ' AND ' + cw.sql; params.push(...cw.params); }
    let dateFilter = '';
    if (tu) { dateFilter += ' AND ngay_ve >= ?'; params.push(omsDateBoundary(tu)); }
    if (den) { dateFilter += ' AND ngay_ve < ?'; params.push(omsDateBoundary(den, true)); }

    const byNV = await db(`SELECT nv_marketing as ten, COUNT(*) as tongDon,
      SUM(CASE WHEN trang_thai='Đơn mới' THEN 1 ELSE 0 END) as donMoi,
      SUM(CASE WHEN trang_thai='Đã chốt' OR trang_thai='Đang ship' OR trang_thai='Ship thành công' THEN 1 ELSE 0 END) as daChot,
      SUM(CASE WHEN trang_thai='Không mua' THEN 1 ELSE 0 END) as khongMua,
      SUM(CASE WHEN trang_thai LIKE 'KNM%' THEN 1 ELSE 0 END) as knm,
      SUM(tong_tien) as doanhThu
      FROM oms_orders WHERE nv_marketing != '' ${userFilter} ${dateFilter}
      GROUP BY nv_marketing`, params);

    const byNguon = await db(`SELECT IFNULL(NULLIF(nguon_du_lieu,''),'(Chưa có)') as nguon, COUNT(*) as tongDon,
      SUM(CASE WHEN trang_thai='Đã chốt' OR trang_thai='Đang ship' OR trang_thai='Ship thành công' THEN 1 ELSE 0 END) as daChot,
      SUM(tong_tien) as doanhThu
      FROM oms_orders WHERE 1=1 ${userFilter} ${dateFilter}
      GROUP BY nguon`, params);

    res.json({ byNV, byNguon });
  }));

  // ===================== KHỞI TẠO =====================
  // CHẶN CACHE cho tất cả API OMS
  app.use('/oms', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

  // ---- Đồng bộ tài khoản ads (users.js) → oms_users ----
  // Chỉ TẠO tài khoản còn thiếu, không sửa/xoá tài khoản đã có (giữ chỉnh sửa, Vô hiệu của admin OMS).
  // Đã có = trùng username HOẶC trùng họ tên. Chỉ đồng bộ admin ads (gồm kế toán) → admin, viewer → marketing;
  // vai trò khác (product…) bỏ qua.
  // Xoá tài khoản bên OMS thì lần khởi động sau sẽ được tạo lại → muốn chặn thì bấm "Vô hiệu".
  // Chạy lúc khởi động và ở lần tự đăng nhập OMS đầu tiên (autoSetOmsUser); 1 lần mỗi tiến trình, lỗi thì lần sau thử lại.
  let adsUsersSynced = null;
  function syncAdsUsersOnce() {
    if (!adsUsersSynced) adsUsersSynced = (async () => {
      await ensureTables(getPool());
      await syncAdsUsers();
    })().catch(e => { adsUsersSynced = null; console.error('[OMS] Đồng bộ tài khoản ads lỗi:', e.message); });
    return adsUsersSynced;
  }
  async function syncAdsUsers() {
    let USERS = [];
    try { USERS = (await import('./users.js')).USERS || []; } catch(e) { return; }
    const existing = await db('SELECT username, ho_ten FROM oms_users');
    const names = new Set(existing.flatMap(r => [r.username, r.ho_ten]).filter(Boolean));
    const created = [];
    for (const u of USERS) {
      const role = { admin: 'admin', viewer: 'marketing' }[u?.role];
      if (!u?.user || !u.pass || !role) continue;
      const hoTen = u.salaryName || (u.employees?.length === 1 ? u.employees[0] : '') || u.user;
      if (names.has(u.user) || names.has(hoTen)) continue;
      // INSERT IGNORE: nhiều tiến trình cùng chạy thì username UNIQUE chặn trùng
      const r = await db('INSERT IGNORE INTO oms_users (username, password, ho_ten, role) VALUES (?,?,?,?)',
        [u.user, u.pass, hoTen, role]);
      if (r.affectedRows) created.push(u.user);
      names.add(u.user); names.add(hoTen);
    }
    if (created.length) console.log('[OMS] Đã tạo tài khoản từ ads:', created.join(', '));
  }

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

  // ---- Nhắc hẹn gọi lại + thu hồi đơn sale chưa tác nghiệp (mỗi 2 phút) ----
  // Nhiều tiến trình: mỗi đơn giành bằng UPDATE có điều kiện (affectedRows) nên không nhắc / thu hồi trùng.
  async function opsTick() {
    if (!getPool()) return;
    await ensureTables(getPool());
    const now = utcStr();
    // 1) Tới giờ hẹn gọi lại → báo riêng sale phụ trách
    const due = await db(`SELECT id, ten_kh, sdt, san_pham, sale_phu_trach FROM oms_orders
      WHERE hen_goi_bao=0 AND hen_goi_lai IS NOT NULL AND hen_goi_lai <= ? LIMIT 100`, [now]);
    for (const o of due) {
      const r = await db('UPDATE oms_orders SET hen_goi_bao=1 WHERE id=? AND hen_goi_bao=0', [o.id]);
      if (!r.affectedRows || !o.sale_phu_trach || !app._omsPush) continue;
      const users = await usernamesOf(o.sale_phu_trach);
      if (users.size) app._omsPush(`⏰ Tới giờ gọi lại đơn #${o.id}`, `${o.ten_kh || ''} ${o.sdt || ''} — ${o.san_pham || ''}`, o.id, users);
    }
    // 2) Thu hồi: đơn mới, sale nhận quá N phút chưa tác nghiệp → chia sale khác cùng chi nhánh (7h–22h giờ VN)
    const phut = await cfgNum('thu_hoi_phut', 0);
    const gioVN = new Date(Date.now() + 7 * 3600000).getUTCHours();
    if (phut > 0 && gioVN >= 7 && gioVN < 22) {
      const han = utcStr(Date.now() - phut * 60000);
      const late = await db(`SELECT id, ten_kh, san_pham, sale_phu_trach, chi_nhanh_id FROM oms_orders
        WHERE trang_thai='Đơn mới' AND sale_phu_trach<>'' AND sale_tac_nghiep_at IS NULL
          AND sale_nhan_at IS NOT NULL AND sale_nhan_at <= ? AND hen_goi_lai IS NULL LIMIT 50`, [han]);
      for (const o of late) {
        const moi = await pickSale(Number(o.chi_nhanh_id) || 1, o.sale_phu_trach);
        if (!moi) continue;
        const r = await db(`UPDATE oms_orders SET sale_phu_trach=?, sale_nhan_at=? WHERE id=? AND sale_phu_trach=?
          AND sale_tac_nghiep_at IS NULL AND trang_thai='Đơn mới'`, [moi, utcStr(), o.id, o.sale_phu_trach]);
        if (!r.affectedRows) continue;
        await logOrder(o.id, 'Hệ thống', 'Thu hồi', `${o.sale_phu_trach} → ${moi} (quá ${phut} phút chưa tác nghiệp)`);
        const users = await usernamesOf(moi);
        if (users.size && app._omsPush) app._omsPush(`Bạn được giao đơn #${o.id} (thu hồi)`, `${o.ten_kh || ''} — ${o.san_pham || ''}`, o.id, users);
      }
    }
  }
  // Điền sdt_norm cho đơn cũ (báo trùng số / khách cũ), từng lô
  async function fillSdtNorm() {
    if (!getPool()) return;
    await ensureTables(getPool());
    for (let i = 0; i < 200; i++) {
      const rows = await db("SELECT id, sdt FROM oms_orders WHERE sdt_norm='' AND sdt<>'' LIMIT 500");
      const ok = rows.filter(r => normPhone(r.sdt));
      for (const r of ok) await db('UPDATE oms_orders SET sdt_norm=? WHERE id=?', [normPhone(r.sdt), r.id]);
      if (ok.length < rows.length) { // SĐT không có chữ số → đánh dấu để khỏi quét lại
        for (const r of rows.filter(r => !normPhone(r.sdt))) await db("UPDATE oms_orders SET sdt_norm='-' WHERE id=?", [r.id]);
      }
      if (rows.length < 500) break;
    }
  }
  setTimeout(() => fillSdtNorm().catch(e => console.error('[OMS] Điền sdt_norm lỗi:', e.message)), 20000);
  setInterval(() => opsTick().catch(e => console.error('[OMS] Nhắc hẹn / thu hồi lỗi:', e.message)), 2 * 60 * 1000);
  if (getPool()) setTimeout(syncAdsUsersOnce, 5000);

  // ---- Inject nút "Lưu đơn VN" vào trang chủ dashboard ----
  app.get('/api/oms-button', (req, res) => {
    res.type('text/javascript').send(`
      (function(){
        if(document.getElementById('oms-float-btn')) return;
        var btn = document.createElement('a');
        btn.id = 'oms-float-btn';
        btn.href = '/go-oms';
        btn.innerHTML = '📋 Lưu đơn VN';
        btn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;background:#2563eb;color:#fff;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;box-shadow:0 4px 12px rgba(37,99,235,.4);transition:transform .15s;font-family:sans-serif;';
        btn.onmouseenter = function(){ btn.style.transform='scale(1.05)'; };
        btn.onmouseleave = function(){ btn.style.transform='scale(1)'; };
        document.body.appendChild(btn);
      })();
    `);
  });

  // ===================== WEB PUSH NOTIFICATIONS (web-push) =====================
  let webpush = null;
  const webpushReady = import('web-push').then(m => {
    webpush = m.default || m;
    console.log('[OMS] web-push loaded OK');
    return true;
  }).catch(e => { console.warn('[OMS] web-push NOT installed:', e.message); return false; });

  // Tạo bảng lưu push subscriptions
  async function ensurePushTable() {
    try {
      await getPool().query(`CREATE TABLE IF NOT EXISTS oms_push_subs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT DEFAULT 0,
        username VARCHAR(120) DEFAULT '',
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_endpoint (endpoint(500))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    } catch(e) {}
    // Device token của app iOS TDM Ads (app là WKWebView, không dùng được web push → gửi qua APNs, apns.js)
    try {
      await getPool().query(`CREATE TABLE IF NOT EXISTS oms_apns_tokens (
        token VARCHAR(200) PRIMARY KEY,
        user_id INT DEFAULT 0,
        username VARCHAR(120) DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    } catch(e) {}
    // FCM token của app Android TDM Ads (WebView Android không có web push → gửi qua FCM, fcm.js)
    try {
      await getPool().query(`CREATE TABLE IF NOT EXISTS oms_fcm_tokens (
        token VARCHAR(255) PRIMARY KEY,
        user_id INT DEFAULT 0,
        username VARCHAR(120) DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    } catch(e) {}
    // Đăng ký từ hồi endpoint chưa đòi đăng nhập (người lạ cũng nhận được thông báo đơn mới).
    // Giờ subscribe/apns-register bắt buộc omsAuth nên không phát sinh thêm.
    try {
      await getPool().query("DELETE FROM oms_push_subs WHERE username='anonymous' OR username=''");
      await getPool().query("DELETE FROM oms_apns_tokens WHERE username='anonymous' OR username=''");
    } catch(e) {}
  }

  // Gửi APNs tới mọi token, xoá token Apple báo đã chết (gỡ app...)
  async function sendApnsToAll(title, body, recipients = null) {
    await ensurePushTable();
    const rows = (await db('SELECT token, user_id, username FROM oms_apns_tokens'))
      .filter(row => recipients === null || recipients.has(row.username));
    if (!rows.length) return [];
    const results = await sendApns(rows.map(r => r.token), title, body);
    for (const r of results) {
      const u = rows.find(x => x.token === r.token)?.username || '';
      r.username = u;
      if (r.dead) await db('DELETE FROM oms_apns_tokens WHERE token=?', [r.token]);
      else if (!r.ok) console.error('[OMS] APNs send error:', u, r.status, r.reason);
    }
    return results;
  }

  // Gửi FCM tới mọi token app Android, xoá token Google báo đã chết
  async function sendFcmToAll(title, body, recipients = null) {
    await ensurePushTable();
    const rows = (await db('SELECT token, user_id, username FROM oms_fcm_tokens'))
      .filter(row => recipients === null || recipients.has(row.username));
    if (!rows.length) return [];
    const results = await sendFcm(rows.map(r => r.token), title, body);
    for (const r of results) {
      const u = rows.find(x => x.token === r.token)?.username || '';
      r.username = u;
      if (r.dead) await db('DELETE FROM oms_fcm_tokens WHERE token=?', [r.token]);
      else if (!r.ok) console.error('[OMS] FCM send error:', u, r.status, r.reason);
    }
    return results;
  }

  // VAPID keys: sinh 1 lần, lưu DB
  let vapidError = '';
  async function getVapidKeys() {
    vapidError = '';
    try {
      await webpushReady;

      const rows = await db("SELECT config_key, config_value FROM oms_config WHERE config_key IN ('vapid_public','vapid_private')");
      const pub = rows.find(r => r.config_key === 'vapid_public');
      const priv = rows.find(r => r.config_key === 'vapid_private');

      if (pub?.config_value?.length >= 80 && priv?.config_value?.length >= 40) {
        return { publicKey: pub.config_value, privateKey: priv.config_value };
      }

      // Xóa keys cũ
      await db("DELETE FROM oms_config WHERE config_key IN ('vapid_public','vapid_private')");
      await db("DELETE FROM oms_push_subs WHERE 1=1");

      if (!webpush) { vapidError = 'webpush is null'; return null; }

      const keys = webpush.generateVAPIDKeys();

      await db("INSERT INTO oms_config (config_key, config_value) VALUES ('vapid_public',?) ON DUPLICATE KEY UPDATE config_value=?", [keys.publicKey, keys.publicKey]);
      await db("INSERT INTO oms_config (config_key, config_value) VALUES ('vapid_private',?) ON DUPLICATE KEY UPDATE config_value=?", [keys.privateKey, keys.privateKey]);

      vapidError = '';
      console.log('[OMS] VAPID keys generated OK, pub length:', keys.publicKey.length);
      return keys;
    } catch(e) {
      vapidError = e.message;
      console.error('[OMS] VAPID error:', e.message);
      return null;
    }
  }

  // API: lấy VAPID public key
  app.get('/oms/api/push/vapid-key', wrap(async (req, res) => {
    await ensurePushTable();
    const keys = await getVapidKeys();
    if (!keys) return res.status(500).json({ error: 'VAPID lỗi: ' + (vapidError || 'unknown') });
    res.json({ publicKey: keys.publicKey });
  }));

  // API: đăng ký subscription
  app.post('/oms/api/push/subscribe', omsAuth, jsonParser, wrap(async (req, res) => {
    await ensurePushTable();
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Thiếu subscription' });
    const omsUser = req.session?.omsUser;
    const mainUser = req.session?.user;
    const username = omsUser?.username || mainUser?.username || 'anonymous';
    await db(`INSERT INTO oms_push_subs (user_id, username, endpoint, p256dh, auth)
      VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), p256dh=VALUES(p256dh), auth=VALUES(auth), username=VALUES(username)`,
      [omsUser?.id || 0, username, endpoint, keys.p256dh, keys.auth]);
    console.log('[OMS] Push subscription saved for:', username);
    res.json({ ok: true });
  }));

  // API: app iOS gửi device token (gọi từ trong WKWebView nên có cookie phiên → biết ai)
  app.post('/oms/api/push/apns-register', omsAuth, jsonParser, wrap(async (req, res) => {
    await ensurePushTable();
    const token = String(req.body?.token || '').toLowerCase();
    if (!/^[0-9a-f]{32,200}$/.test(token)) return res.status(400).json({ error: 'Token không hợp lệ' });
    const omsUser = req.session?.omsUser;
    const mainUser = req.session?.user;
    const username = omsUser?.username || mainUser?.username || 'anonymous';
    await db(`INSERT INTO oms_apns_tokens (token, user_id, username) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), username=VALUES(username), updated_at=CURRENT_TIMESTAMP`,
      [token, omsUser?.id || 0, username]);
    const [{ n }] = await db('SELECT COUNT(*) AS n FROM oms_apns_tokens');
    res.json({ ok: true, apns_configured: apnsConfigured(), devices: n });
  }));

  // API: app Android gửi FCM token (gọi từ trong WebView nên có cookie phiên → biết ai)
  app.post('/oms/api/push/fcm-register', omsAuth, jsonParser, wrap(async (req, res) => {
    await ensurePushTable();
    const token = String(req.body?.token || '');
    if (!/^[A-Za-z0-9_:\-]{20,255}$/.test(token)) return res.status(400).json({ error: 'Token không hợp lệ' });
    const omsUser = req.session?.omsUser;
    const mainUser = req.session?.user;
    const username = omsUser?.username || mainUser?.username || 'anonymous';
    await db(`INSERT INTO oms_fcm_tokens (token, user_id, username) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), username=VALUES(username), updated_at=CURRENT_TIMESTAMP`,
      [token, omsUser?.id || 0, username]);
    res.json({ ok: true, fcm_configured: fcmConfigured() });
  }));

  app.post('/oms/api/push/apns-unregister', omsAuth, jsonParser, wrap(async (req, res) => {
    const token = String(req.body?.token || '').toLowerCase();
    if (token) await db('DELETE FROM oms_apns_tokens WHERE token=?', [token]);
    res.json({ ok: true });
  }));

  // API: huỷ subscription
  app.post('/oms/api/push/unsubscribe', omsAuth, jsonParser, wrap(async (req, res) => {
    const { endpoint } = req.body;
    if (endpoint) await db('DELETE FROM oms_push_subs WHERE endpoint=?', [endpoint]);
    res.json({ ok: true });
  }));

  // API: DEBUG (lộ tên người đăng ký → chỉ admin)
  app.get('/oms/api/push/debug', requireRole('admin'), wrap(async (req, res) => {
    await ensurePushTable();
    const ready = await webpushReady;
    const keys = await getVapidKeys();
    const subs = await db('SELECT id, username, LEFT(endpoint,80) as ep, created_at FROM oms_push_subs');
    const apns = await db('SELECT username, LEFT(token,12) AS token, updated_at FROM oms_apns_tokens');
    const fcm = await db('SELECT username, LEFT(token,12) AS token, updated_at FROM oms_fcm_tokens');
    res.json({
      apns_configured: apnsConfigured(),
      apns_devices: apns,
      fcm_configured: fcmConfigured(),
      fcm_devices: fcm,
      webpush_installed: ready,
      webpush_loaded: !!webpush,
      vapid_ok: !!keys,
      vapid_public_length: keys?.publicKey?.length || 0,
      vapid_error: vapidError || null,
      subscriptions: subs,
      subscription_count: subs.length + apns.length + fcm.length,
    });
  }));

  // API: TEST — gửi push test ngay
  app.post('/oms/api/push/test', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    await webpushReady;
    await ensurePushTable();
    const apnsResults = await sendApnsToAll('🧪 Test thông báo OMS', 'Push notification hoạt động!');
    const fcmResults = await sendFcmToAll('🧪 Test thông báo OMS', 'Push notification hoạt động!');
    if (!webpush) return res.json({ error: 'web-push chưa cài', apns: apnsResults });
    const keys = await getVapidKeys();
    if (!keys) return res.json({ error: 'VAPID keys chưa sẵn sàng', apns: apnsResults });
    const subs = await db('SELECT * FROM oms_push_subs');
    if (!subs.length && !apnsResults.length && !fcmResults.length) return res.json({ error: 'Chưa có ai subscribe. Bấm 🔔 trong app trước.' });

    webpush.setVapidDetails('mailto:admin@tdmjsc.com', keys.publicKey, keys.privateKey);
    const payload = JSON.stringify({ title: '🧪 Test thông báo OMS', body: 'Push notification hoạt động!' });
    const results = apnsResults.map(r => ({ username: r.username, ok: r.ok, app_ios: true, error: r.ok ? undefined : r.reason, statusCode: r.status }))
      .concat(fcmResults.map(r => ({ username: r.username, ok: r.ok, app_android: true, error: r.ok ? undefined : r.reason, statusCode: r.status })));
    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 60 });
        results.push({ id: sub.id, username: sub.username, ok: true });
      } catch(e) {
        results.push({ id: sub.id, username: sub.username, ok: false, error: e.message, statusCode: e.statusCode });
        if (e.statusCode === 410 || e.statusCode === 404) await db('DELETE FROM oms_push_subs WHERE id=?', [sub.id]);
      }
    }
    res.json({ ok: true, results });
  }));

  // Xác định người nhận từ đơn đã lưu, không lấy quyền từ subscription cũ.
  async function orderPushRecipients(orderId) {
    const recipients = new Set();
    if (!orderId) return recipients;
    const [order] = await db('SELECT nv_marketing, sale_phu_trach, trang_thai, chi_nhanh_id FROM oms_orders WHERE id=?', [orderId]);
    if (!order) return recipients;
    const users = await db('SELECT username, ho_ten, role, chi_nhanh_id, xem_chi_nhanh FROM oms_users WHERE active=1');
    // Chi nhánh của đơn nằm trong quyền xem: chi nhánh chính, '*' = mọi chi nhánh, hoặc danh sách thêm
    const sameCn = user => {
      const ocn = Number(order.chi_nhanh_id) || 1, xem = String(user.xem_chi_nhanh || '').trim();
      return xem === '*' || (Number(user.chi_nhanh_id) || 1) === ocn || xem.split(',').map(Number).includes(ocn);
    };
    for (const user of users) {
      if (user.role === 'admin'
          || (user.role === 'marketing' && order.nv_marketing && getMktTeam(user).includes(order.nv_marketing))
          || (user.role === 'sale' && order.sale_phu_trach && user.ho_ten === order.sale_phu_trach && sameCn(user))
          || (user.role === 'warehouse' && ['Đã chốt', 'Đang ship'].includes(order.trang_thai) && sameCn(user))) {
        recipients.add(user.username);
      }
    }
    // Admin dashboard có thể đăng nhập OMS với id=0, không có dòng oms_users.
    const { USERS } = await import('./users.js');
    for (const user of USERS || []) if (user.role === 'admin') recipients.add(user.user);
    return recipients;
  }

  // onlyUsers (Set username) = chỉ gửi những người này (nhắc hẹn gọi, giao đơn); không có = theo quyền xem đơn
  async function sendPushToAll(title, body, orderId, onlyUsers = null) {
    let recipients;
    try { recipients = onlyUsers || await orderPushRecipients(orderId); }
    catch (e) { console.error('[OMS] Push recipients error:', e.message); return; }
    try { await sendApnsToAll(title, body, recipients); } catch(e) { console.error('[OMS] APNs error:', e.message); }
    try { await sendFcmToAll(title, body, recipients); } catch(e) { console.error('[OMS] FCM error:', e.message); }
    await webpushReady;
    if (!webpush) return;
    try {
      const keys = await getVapidKeys();
      if (!keys) return;
      webpush.setVapidDetails('mailto:admin@tdmjsc.com', keys.publicKey, keys.privateKey);
      const subs = (await db('SELECT * FROM oms_push_subs')).filter(sub => recipients.has(sub.username));
      if (!subs.length) return;
      const payload = JSON.stringify({ title, body });
      console.log('[OMS] Sending push to', subs.length, 'subscribers:', title);
      for (const sub of subs) {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 86400 });
        } catch(e) {
          console.error('[OMS] Push send error:', sub.username, e.statusCode, e.message);
          if (e.statusCode === 410 || e.statusCode === 404) await db('DELETE FROM oms_push_subs WHERE id=?', [sub.id]);
        }
      }
    } catch(e) { console.error('[OMS] Push error:', e.message); }
  }

  app._omsPush = sendPushToAll;


  // ---- Serve manifest.json và sw-push.js ----
  app.get('/oms-manifest.json', (req, res) => {
    res.json({
      name: 'OMS - Quản lý đơn hàng',
      short_name: 'OMS',
      start_url: '/go-oms',
      display: 'standalone',
      background_color: '#f0f2f5',
      theme_color: '#2563eb',
      icons: [{ src: '/favicon.ico', sizes: '64x64', type: 'image/x-icon' }]
    });
  });

  app.get('/sw-push.js', (req, res) => {
    res.type('application/javascript')
      .set('Cache-Control','no-store')
      .set('Service-Worker-Allowed', '/')
      .send(`
// Service Worker — CHỈ xử lý Push, KHÔNG cache gì
self.addEventListener('push', function(event) {
  let data = { title: 'OMS', body: 'Có đơn mới' };
  try { data = event.data.json(); } catch(e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      // Mỗi đơn một tag: tag chung làm đơn sau thay đơn trước, 2 đơn về gần nhau chỉ còn 1 thông báo
      tag: data.tag || ('oms-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)),
      vibrate: [200, 100, 200]
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        return clientList[i].focus();
      }
      return clients.openWindow('/');
    })
  );
});

// KHÔNG cache gì cả
self.addEventListener('fetch', function(event) {});
    `);
  });

  console.log('[OMS] Module đã gắn thành công: /oms/*');
}
