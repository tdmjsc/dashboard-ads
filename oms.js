// =====================================================================
//  MODULE QUẢN LÝ ĐƠN HÀNG (OMS) — oms.js
//  Pattern giống thailand.js: AN TOÀN, lazy DB, try/catch toàn bộ
//  Mount vào server.js: mountOMS(app, { mysql, express })
// =====================================================================
import { sendApns, apnsConfigured } from './apns.js';
import { omsDateBoundary } from './oms-date.js';
import { adRefFromUtm, hasUtm, findFbclid, adIdFromFbclid, utmFromUrl, AD_REF_FROM } from './oms-ad-ref.js';

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
  ];
  for (const col of addCols) {
    try { await pool.query(`ALTER TABLE oms_orders ADD COLUMN ${col}`); } catch(e) {}
  }
  try { await pool.query('ALTER TABLE oms_orders ADD INDEX idx_fb_camp (fb_campaign_id)'); } catch(e) {}
  try { await pool.query('ALTER TABLE oms_orders ADD INDEX idx_fb_adid (fb_adid)'); } catch(e) {}

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
  function regroupAdid(adid, ref, oldAd) {
    if (!ref.campaign_id) return null;
    return saveAdRef(`ngay_ve >= ? AND fb_adid=? AND (fb_campaign_id=''${oldAd ? ` OR (fb_ad_id=? AND ${NO_UTM_ID})` : ''})`,
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
      fb_ad_id=?, fb_ref_at=UTC_TIMESTAMP() WHERE ${where}`,
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
        WHERE o.ngay_ve >= ? AND o.fb_campaign_id=''`, [omsDateBoundary(AD_REF_FROM)]);
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
      return out;
    } finally { fixingAdRefs = false; }
  }

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

  function omsAuth(req, res, next) {
    // Phải gọi async
    autoSetOmsUser(req).then(() => {
      if (req.session?.omsUser) return next();
      res.status(401).json({ error: 'Chưa đăng nhập OMS' });
    }).catch(() => res.status(401).json({ error: 'Chưa đăng nhập OMS' }));
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      autoSetOmsUser(req).then(() => {
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
    req.session.omsUser = { id: u.id, username: u.username, ho_ten: u.ho_ten, role: u.role };
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
      fb_campaign_id, fb_campaign_name, fb_adset_id, fb_adset_name, fb_ad_id, fb_adid, fb_ref_at
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
    if (!/^\d{10,}$/.test(adid)) return res.status(400).json({ error: 'Không đọc được adid (link phải có ?fbclid=… bấm từ quảng cáo)' });
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
    if (urlPage) {
      try {
        const links = await db('SELECT * FROM oms_link_registry WHERE active=1 ORDER BY CHAR_LENGTH(url_pattern) DESC, id DESC');
        for (const link of links) {
          // So khớp: URL chứa pattern đã đăng ký
          if (urlPage.toLowerCase().includes(link.url_pattern.toLowerCase())) {
            // Link đã đăng ký quyết định NV; UTM có thể còn ID quảng cáo của NV khác.
            // Ưu tiên pattern cụ thể hơn khi nhiều link cùng khớp.
            if (link.nv_marketing?.trim()) nvMarketing = link.nv_marketing.trim();
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
       fbclid, url_page, fb_adid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Đơn mới', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [now, nvMarketing, ten, sdt, diaChiFull, addr.tinh, addr.quan, addr.phuong, addr.diaChi,
       sanPham, soLuong, gia, gia * soLuong,
       utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
       d.ghi_chu || '', tinNhanGoc, orderNguon,
       fbclid.slice(0, 512), String(urlPage).slice(0, 1000), fbAdidOf(fbclid)]);

    // Tra chiến dịch / nhóm quảng cáo (gọi Graph API) sau khi đã ghi đơn → Ladipage không phải chờ.
    // Lỗi thì fb_ref_at còn trống, fixAdRefs tra lại.
    const utm = { utm_campaign: utmCampaign, utm_medium: utmMedium, utm_term: utmTerm, utm_content: utmContent, fbclid };
    if (hasUtm(utm)) {
      lookupAdRef(utm).then(ref => saveAdRef('id=?', [createdOrder.insertId], ref))
        .catch(e => console.error('[OMS] Tra chiến dịch Meta của đơn lỗi:', e.message));
    }

    // Auto-assign Sale round-robin
    try {
      const inserted = { id: createdOrder.insertId };
      if (inserted) {
        const sales = await db("SELECT ho_ten FROM oms_users WHERE role='sale' AND active=1 ORDER BY ho_ten");
        if (sales.length) {
          // Đếm số đơn mỗi sale hiện có (hôm nay) để chia đều
          const today = now.slice(0, 10);
          const counts = await db(`SELECT sale_phu_trach, COUNT(*) as cnt FROM oms_orders 
            WHERE sale_phu_trach != '' AND DATE(ngay_ve) = ? GROUP BY sale_phu_trach`, [today]);
          const countMap = {};
          counts.forEach(c => { countMap[c.sale_phu_trach] = c.cnt; });
          // Chọn sale có ít đơn nhất
          let minSale = sales[0].ho_ten;
          let minCount = countMap[minSale] || 0;
          for (const s of sales) {
            const cnt = countMap[s.ho_ten] || 0;
            if (cnt < minCount) { minCount = cnt; minSale = s.ho_ten; }
          }
          await db('UPDATE oms_orders SET sale_phu_trach=? WHERE id=?', [minSale, inserted.id]);
        }
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
      // Kho chỉ thấy đơn đã chốt
      where.push(`trang_thai IN ('Đã chốt', 'Đang ship')`);
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
  app.put('/oms/api/orders/:id', omsAuth, jsonParser, wrap(async (req, res) => {
    const { id } = req.params;
    const d = req.body;
    const user = req.session.omsUser;

    // Sale: sửa được thông tin đơn + chốt/huỷ chốt/không mua/quay lại đơn mới
    if (user.role === 'sale') {
      const saleAllowed = ['trang_thai','ghi_chu','sale_phu_trach','ten_kh','sdt',
        'dia_chi_full','san_pham','so_luong','gia_ban','tong_tien','phi_ship','dat_coc','kho_id'];
      // Sale được phép: Đơn mới, Đã chốt, Không mua, KNM lần 1-6
      const saleStatuses = ['Đơn mới','Đã chốt','Không mua','KNM lần 1','KNM lần 2','KNM lần 3','KNM lần 4','KNM lần 5','KNM lần 6'];
      if (d.trang_thai && !saleStatuses.includes(d.trang_thai)) {
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
      'so_luong','gia_ban','tong_tien','phi_ship','dat_coc','da_thanh_toan','kho_id'];

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
    // warehouse + admin: thấy tất cả

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
      ROUND(SUM(CASE WHEN trang_thai IN ('Đã chốt','Đang ship','Ship thành công') THEN 1 ELSE 0 END)*100/COUNT(*),1) as tyLeChot
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

  // ===================== ĐỔI MÃ ĐƠN HÀNG =====================
  app.post('/oms/api/change-order-code', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const { id, ma_don_hang } = req.body;
    if (!id) return res.status(400).json({ error: 'Thiếu ID đơn' });
    const newCode = ma_don_hang || `OM${String(Math.floor(100000+Math.random()*900000))}`;
    await db('UPDATE oms_orders SET ma_don_hang=? WHERE id=?', [newCode, id]);
    res.json({ ok: true, ma_don_hang: newCode });
  }));

  // ===================== HUỶ ĐƠN GHTK =====================
  app.post('/oms/api/cancel-ghtk', requireRole('admin', 'warehouse'), jsonParser, wrap(async (req, res) => {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'Chưa chọn đơn' });

    const orders = await db(`SELECT * FROM oms_orders WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);
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
          await db(`UPDATE oms_orders SET don_vi_vc='', ma_van_don='', ma_don_hang=?, trang_thai='Đã chốt', trang_thai_vc='Đã huỷ GHTK' WHERE id=?`, [newMaDH, o.id]);
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

    const result = await db(`INSERT INTO oms_link_registry (url_pattern, product_id, ten_sp, nv_marketing, nguon_du_lieu, ghi_chu)
      VALUES (?,?,?,?,?,?)`,
      [d.url_pattern, d.product_id, tenSp, nvName, d.nguon_du_lieu||'', d.ghi_chu||'']);
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
    if (d.url_pattern) { sets.push('url_pattern=?'); vals.push(d.url_pattern); }
    if (d.product_id) {
      sets.push('product_id=?'); vals.push(d.product_id);
      try { const [p] = await db('SELECT ten_sp FROM oms_products WHERE id=?', [d.product_id]); sets.push('ten_sp=?'); vals.push(p?.ten_sp||''); } catch(e) {}
    }
    if (d.nguon_du_lieu !== undefined) { sets.push('nguon_du_lieu=?'); vals.push(d.nguon_du_lieu); }
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
    res.json({
      apns_configured: apnsConfigured(),
      apns_devices: apns,
      webpush_installed: ready,
      webpush_loaded: !!webpush,
      vapid_ok: !!keys,
      vapid_public_length: keys?.publicKey?.length || 0,
      vapid_error: vapidError || null,
      subscriptions: subs,
      subscription_count: subs.length + apns.length,
    });
  }));

  // API: TEST — gửi push test ngay
  app.post('/oms/api/push/test', requireRole('admin'), jsonParser, wrap(async (req, res) => {
    await webpushReady;
    await ensurePushTable();
    const apnsResults = await sendApnsToAll('🧪 Test thông báo OMS', 'Push notification hoạt động!');
    if (!webpush) return res.json({ error: 'web-push chưa cài', apns: apnsResults });
    const keys = await getVapidKeys();
    if (!keys) return res.json({ error: 'VAPID keys chưa sẵn sàng', apns: apnsResults });
    const subs = await db('SELECT * FROM oms_push_subs');
    if (!subs.length && !apnsResults.length) return res.json({ error: 'Chưa có ai subscribe. Bấm 🔔 trong app trước.' });

    webpush.setVapidDetails('mailto:admin@tdmjsc.com', keys.publicKey, keys.privateKey);
    const payload = JSON.stringify({ title: '🧪 Test thông báo OMS', body: 'Push notification hoạt động!' });
    const results = apnsResults.map(r => ({ username: r.username, ok: r.ok, app_ios: true, error: r.ok ? undefined : r.reason, statusCode: r.status }));
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
    const [order] = await db('SELECT nv_marketing, sale_phu_trach, trang_thai FROM oms_orders WHERE id=?', [orderId]);
    if (!order) return recipients;
    const users = await db('SELECT username, ho_ten, role FROM oms_users WHERE active=1');
    for (const user of users) {
      if (user.role === 'admin'
          || (user.role === 'marketing' && order.nv_marketing && getMktTeam(user).includes(order.nv_marketing))
          || (user.role === 'sale' && order.sale_phu_trach && user.ho_ten === order.sale_phu_trach)
          || (user.role === 'warehouse' && ['Đã chốt', 'Đang ship'].includes(order.trang_thai))) {
        recipients.add(user.username);
      }
    }
    // Admin dashboard có thể đăng nhập OMS với id=0, không có dòng oms_users.
    const { USERS } = await import('./users.js');
    for (const user of USERS || []) if (user.role === 'admin') recipients.add(user.user);
    return recipients;
  }

  async function sendPushToAll(title, body, orderId) {
    let recipients;
    try { recipients = await orderPushRecipients(orderId); }
    catch (e) { console.error('[OMS] Push recipients error:', e.message); return; }
    try { await sendApnsToAll(title, body, recipients); } catch(e) { console.error('[OMS] APNs error:', e.message); }
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
