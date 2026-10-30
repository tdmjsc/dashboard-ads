// thu-chi.js — SỔ QUỸ TIỀN MẶT (trang /thu-chi.html, menu trong Kết quả kinh doanh)
//
// Admin / kế toán ghi tay từng khoản thu, chi tiền mặt. Tồn quỹ = tồn quỹ ban đầu + Σ thu − Σ chi.
// Dữ liệu: DATA_DIR/thu-chi.json  { tonBanDau: {soTien, ghiChu}, items: [{id, ngay, loai:'thu'|'chi', nhom,
//   noiDung, doiTuong, soTien, by, at, sua?}] }
//
// Nhiều tiến trình (xem CLAUDE.md): mọi lần ghi đi qua commit(fn) — đọc file mới nhất → sửa theo id → ghi
// file tạm rồi đổi tên; bản trước chép sang thu-chi.json.bak. Khác json-store.js: file chính hỏng thì
// KHÔNG coi là rỗng (sẽ xoá sạch sổ khi ghi) mà đọc .bak, cả hai hỏng thì từ chối ghi.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LOAI = ['thu', 'chi'];
const laNgay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const money = v => Math.abs(parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10) || 0);
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const ngayVN = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

export function mountThuChi(app, { express, DATA_DIR }) {
  const FILE = path.join(DATA_DIR, 'thu-chi.json');
  const BAK = FILE + '.bak';

  const parse = f => {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!s || !Array.isArray(s.items)) throw new Error('sai định dạng');
    if (!s.tonBanDau || typeof s.tonBanDau !== 'object') s.tonBanDau = { soTien: 0, ghiChu: '' };
    return s;
  };
  const empty = () => ({ tonBanDau: { soTien: 0, ghiChu: '' }, items: [] });
  // Đọc file mới nhất; hỏng → .bak; chưa có file → sổ trống; cả hai hỏng → ném lỗi
  function read() {
    try { return parse(FILE); } catch (e) {
      if (!fs.existsSync(FILE) && !fs.existsSync(BAK)) return empty();
      try { return parse(BAK); } catch { throw new Error('File sổ quỹ bị hỏng, không đọc được (' + e.message + ')'); }
    }
  }
  function commit(fn) {
    const s = read();
    const out = fn(s);
    if (out === false) return { s, out };
    try { parse(FILE); fs.copyFileSync(FILE, BAK); } catch {} // chỉ sao lưu bản đọc được
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return { s, out };
  }
  // Khởi động: file chính hỏng mà .bak còn tốt → khôi phục
  try { parse(FILE); } catch (e) {
    if (fs.existsSync(FILE)) {
      try { parse(BAK); fs.copyFileSync(BAK, FILE); console.error('[THUCHI] thu-chi.json lỗi (' + e.message + ') → khôi phục từ .bak'); }
      catch { console.error('[THUCHI] thu-chi.json lỗi và không có .bak đọc được'); }
    }
  }

  const chiAdmin = (req, res, next) => {
    const me = req.session.user || {};
    if (me.role !== 'admin') return res.status(403).json({ ok: false, message: 'Chỉ quản trị viên' });
    next();
  };
  const tien = it => it.loai === 'thu' ? it.soTien : -it.soTien;
  const sapXep = (a, b) => a.ngay < b.ngay ? -1 : a.ngay > b.ngay ? 1 : String(a.at).localeCompare(String(b.at));

  /* GET /api/thu-chi?from=YYYY-MM-DD&to=YYYY-MM-DD
     → các khoản trong khoảng (cũ → mới) + tồn đầu kỳ / tổng thu / tổng chi / tồn cuối kỳ / tồn hiện tại */
  app.get('/api/thu-chi', chiAdmin, (req, res) => {
    let s;
    try { s = read(); } catch (e) { return res.json({ ok: false, message: e.message }); }
    const from = laNgay(req.query.from) ? req.query.from : '0000-00-00';
    const to = laNgay(req.query.to) ? req.query.to : '9999-12-31';
    const all = s.items.slice().sort(sapXep);
    const tonBanDau = money(s.tonBanDau.soTien);
    let tonDauKy = tonBanDau, tongThu = 0, tongChi = 0, tonHienTai = tonBanDau;
    const items = [];
    for (const it of all) {
      tonHienTai += tien(it);
      if (it.ngay < from) tonDauKy += tien(it);
      else if (it.ngay <= to) {
        items.push(it);
        if (it.loai === 'thu') tongThu += it.soTien; else tongChi += it.soTien;
      }
    }
    const nhom = [...new Set(all.map(x => x.nhom).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
    const doiTuong = [...new Set(all.map(x => x.doiTuong).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
    res.json({
      ok: true, from: req.query.from || '', to: req.query.to || '',
      tonBanDau: { soTien: tonBanDau, ghiChu: s.tonBanDau.ghiChu || '' },
      tonDauKy, tongThu, tongChi, tonCuoiKy: tonDauKy + tongThu - tongChi, tonHienTai,
      items, nhom, doiTuong, homNay: ngayVN(),
    });
  });

  /* POST /api/thu-chi/item {action:'add'|'update'|'delete', id, ngay, loai, nhom, noiDung, doiTuong, soTien} */
  app.post('/api/thu-chi/item', express.json(), chiAdmin, (req, res) => {
    const me = req.session.user || {};
    const b = req.body || {};
    const action = b.action;
    let rec;
    if (action !== 'delete') {
      rec = {
        ngay: b.ngay, loai: b.loai, nhom: str(b.nhom, 80), noiDung: str(b.noiDung, 300),
        doiTuong: str(b.doiTuong, 120), soTien: money(b.soTien),
      };
      if (!laNgay(rec.ngay)) return res.json({ ok: false, message: 'Ngày không hợp lệ' });
      if (!LOAI.includes(rec.loai)) return res.json({ ok: false, message: 'Chọn Thu hoặc Chi' });
      if (!rec.noiDung) return res.json({ ok: false, message: 'Nhập nội dung' });
      if (!rec.soTien) return res.json({ ok: false, message: 'Nhập số tiền' });
    }
    try {
      const { out } = commit(s => {
        if (action === 'add') {
          s.items.push({ id: crypto.randomUUID(), ...rec, by: me.user || '', at: new Date().toISOString() });
          return true;
        }
        const it = s.items.find(x => x.id === b.id);
        if (!it) return false;
        if (action === 'update') Object.assign(it, rec, { sua: { by: me.user || '', at: new Date().toISOString() } });
        else if (action === 'delete') s.items.splice(s.items.indexOf(it), 1);
        else return false;
        return true;
      });
      if (out === false) return res.json({ ok: false, message: ['add', 'update', 'delete'].includes(action) ? 'Khoản này không còn (có thể vừa bị xoá). Tải lại trang.' : 'action không hợp lệ' });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });

  /* POST /api/thu-chi/ton-ban-dau {soTien, ghiChu} — tiền mặt có trong quỹ trước khoản đầu tiên của sổ */
  app.post('/api/thu-chi/ton-ban-dau', express.json(), chiAdmin, (req, res) => {
    const me = req.session.user || {};
    const b = req.body || {};
    try {
      commit(s => { s.tonBanDau = { soTien: money(b.soTien), ghiChu: str(b.ghiChu, 300), by: me.user || '', at: new Date().toISOString() }; });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });
}
