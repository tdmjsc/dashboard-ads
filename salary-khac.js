// salary-khac.js — LƯƠNG NV KHÁC (sale, kho, kế toán…) nhập tay — trang /salary-khac.html
//
// Dữ liệu: DATA_DIR/salary-khac.json
//   { staff: [{ id, name, boPhan, active }],
//     months: { 'YYYY-MM': { [id]: { luong, thuong, phat, bhxh, ghiChu } } } }
// Thực nhận = Lương + Thưởng − Phạt − BHXH. Tổng thực nhận theo bộ phận đổ sang Kết quả kinh doanh
// (global.__salaryKhacTong → /api/business-result trả luongKhac).
// Lương / BHXH tháng chưa nhập thì lấy theo tháng gần nhất trước đó có số (kế thừa).
//
// Nhiều tiến trình (xem CLAUDE.md): mọi lần ghi đi qua commit(fn) — đọc file mới nhất → sửa theo id →
// ghi file tạm rồi đổi tên; bản trước chép sang .bak. File chính hỏng thì đọc .bak, cả hai hỏng thì
// từ chối ghi (không coi là trống). API nằm dưới /api/salary… nên middleware chỉ-admin trong server.js chặn sẵn.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BO_PHAN = ['sale', 'kho', 'keToan'];   // khớp 3 ô Lương Sale / Kho / Kế toán ở Kết quả kinh doanh
const FIELDS = ['luong', 'thuong', 'phat', 'bhxh'];
const KE_THUA = ['luong', 'bhxh'];
const laThang = s => /^\d{4}-\d{2}$/.test(String(s || ''));
const money = v => Math.abs(parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10) || 0);
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

const MAC_DINH = () => ({
  staff: [
    { id: 'sen', name: 'Vũ Thị Sen', boPhan: 'sale', active: true },
    { id: 'van', name: 'Vũ Thị Tố Vân', boPhan: 'sale', active: true },
    { id: 'vinh', name: 'Bùi Tiến Vinh', boPhan: 'kho', active: true },
    { id: 'trang', name: 'Trần Phương Trang', boPhan: 'keToan', active: true },
  ],
  months: {},
});

export function mountSalaryKhac(app, { express, DATA_DIR }) {
  const FILE = path.join(DATA_DIR, 'salary-khac.json');
  const BAK = FILE + '.bak';

  const parse = f => {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!s || !Array.isArray(s.staff) || typeof s.months !== 'object' || !s.months) throw new Error('sai định dạng');
    return s;
  };
  function read() {
    try { return parse(FILE); } catch (e) {
      if (!fs.existsSync(FILE) && !fs.existsSync(BAK)) return MAC_DINH();
      try { return parse(BAK); } catch { throw new Error('File lương NV khác bị hỏng, không đọc được (' + e.message + ')'); }
    }
  }
  function commit(fn) {
    const s = read();
    const out = fn(s);
    if (out === false) return { s, out };
    try { parse(FILE); fs.copyFileSync(FILE, BAK); } catch {}
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return { s, out };
  }
  try { parse(FILE); } catch (e) {
    if (fs.existsSync(FILE)) {
      try { parse(BAK); fs.copyFileSync(BAK, FILE); console.error('[LUONG-KHAC] salary-khac.json lỗi (' + e.message + ') → khôi phục từ .bak'); }
      catch { console.error('[LUONG-KHAC] salary-khac.json lỗi và không có .bak đọc được'); }
    }
  }

  const chiAdmin = (req, res, next) => {
    const me = req.session.user || {};
    if (me.role !== 'admin') return res.status(403).json({ ok: false, message: 'Chỉ quản trị viên' });
    next();
  };

  // Số của 1 tháng cho từng NV, kèm số kế thừa (lương / BHXH) từ tháng trước gần nhất
  function bangThang(s, month) {
    const cur = s.months[month] || {};
    const truoc = Object.keys(s.months).filter(m => m < month).sort().reverse();
    const data = {};
    for (const st of s.staff) {
      const v = cur[st.id] || {};
      const row = { luong: 0, thuong: 0, phat: 0, bhxh: 0, ghiChu: v.ghiChu || '', keThua: {} };
      for (const f of FIELDS) row[f] = money(v[f]);
      for (const f of KE_THUA) {
        if (v[f] != null) continue;          // tháng này đã nhập (kể cả 0)
        for (const m of truoc) {
          const o = (s.months[m] || {})[st.id];
          if (o && o[f] != null) { row[f] = money(o[f]); if (row[f]) row.keThua[f] = m; break; }
        }
      }
      row.thucNhan = row.luong + row.thuong - row.phat - row.bhxh;
      data[st.id] = row;
    }
    return data;
  }
  const hien = (s, month) => {
    const cur = s.months[month] || {};
    return s.staff.filter(st => st.active !== false || cur[st.id]);
  };

  // Tổng thực nhận theo bộ phận của 1 tháng → trang Kết quả kinh doanh (/api/business-result).
  //   Bộ phận có tổng 0 (tháng chưa nhập gì, kể cả kế thừa) → KQKD dùng ô nhập tay cũ.
  global.__salaryKhacTong = month => {
    if (!laThang(month)) return null;
    const s = read();
    const data = bangThang(s, month), tong = {}, soNV = {};
    for (const st of hien(s, month)) {
      const bp = BO_PHAN.includes(st.boPhan) ? st.boPhan : 'sale';
      tong[bp] = (tong[bp] || 0) + data[st.id].thucNhan;
      soNV[bp] = (soNV[bp] || 0) + 1;
    }
    return { tong, soNV };
  };

  app.get('/api/salary-khac', chiAdmin, (req, res) => {
    const month = req.query.month;
    if (!laThang(month)) return res.json({ ok: false, message: 'Tháng không hợp lệ' });
    let s; try { s = read(); } catch (e) { return res.json({ ok: false, message: e.message }); }
    res.json({ ok: true, month, staff: hien(s, month), data: bangThang(s, month) });
  });

  // Lưu số 1 NV 1 tháng: { month, id, values: { luong, thuong, phat, bhxh, ghiChu } }
  app.post('/api/salary-khac', chiAdmin, express.json(), (req, res) => {
    const { month, id, values } = req.body || {};
    if (!laThang(month)) return res.json({ ok: false, message: 'Tháng không hợp lệ' });
    try {
      const { s, out } = commit(s => {
        if (!s.staff.some(x => x.id === id)) return false;
        const m = s.months[month] || (s.months[month] = {});
        const o = m[id] || (m[id] = {});
        const v = values || {};
        for (const f of FIELDS) if (f in v) o[f] = money(v[f]);
        if ('ghiChu' in v) o.ghiChu = str(v.ghiChu, 200);
        o.by = (req.session.user || {}).user || ''; o.at = new Date().toISOString();
      });
      if (out === false) return res.json({ ok: false, message: 'Không thấy nhân viên (có thể vừa bị xoá)' });
      res.json({ ok: true, row: bangThang(s, month)[id] });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });

  // Danh sách NV: { action: 'add'|'edit'|'remove', id?, name?, boPhan? }
  app.post('/api/salary-khac/staff', chiAdmin, express.json(), (req, res) => {
    const { action, id } = req.body || {};
    const name = str((req.body || {}).name, 80);
    const boPhan = BO_PHAN.includes((req.body || {}).boPhan) ? req.body.boPhan : 'sale';
    try {
      const { s, out } = commit(s => {
        if (action === 'add') {
          if (!name) return false;
          const cu = s.staff.find(x => x.name.toLowerCase() === name.toLowerCase());
          if (cu) { cu.active = true; cu.boPhan = boPhan; return; }
          s.staff.push({ id: crypto.randomBytes(5).toString('hex'), name, boPhan, active: true });
          return;
        }
        const st = s.staff.find(x => x.id === id);
        if (!st) return false;
        if (action === 'edit') { if (name) st.name = name; st.boPhan = boPhan; return; }
        if (action === 'remove') { st.active = false; return; }   // giữ số các tháng cũ
        return false;
      });
      if (out === false) return res.json({ ok: false, message: 'Không thực hiện được (thiếu tên hoặc không thấy NV)' });
      res.json({ ok: true, staff: s.staff });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });
}
