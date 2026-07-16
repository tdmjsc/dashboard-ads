/* ════════════════════════════════════════════════════════════════════
   salary-calc.js — CÔNG THỨC LƯƠNG DÙNG CHUNG

   ⚠ ĐÂY LÀ NƠI DUY NHẤT chứa công thức tính lương.
     Dùng bởi:  salary.html  ·  salary-product.html  ·  ket-qua-kinh-doanh.html
     Sửa quy tắc lương thì CHỈ SỬA Ở ĐÂY, mọi trang tự khớp theo.

   Các hàm đều THUẦN (pure): nhận dữ liệu vào → trả kết quả ra,
   không đụng tới DOM, không gọi mạng.
   ════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const normKey = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
  // Làm tròn XUỐNG hàng nghìn (3 số cuối = 000)
  const roundK = n => Math.floor((Number(n) || 0) / 1000) * 1000;

  /* ── LƯƠNG MARKETING ───────────────────────────────────────────── */

  const CH_MKT = ['thailan', 'pushsale', 'san'];   // 'san' = Sàn TMĐT (Shopee)
  const AUTOFIELD = { dt: 'doanhthu', qc: 'chiPhiQC', gv: 'giaVon', ship: 'phiShip' };

  // Thưởng DTT theo bậc thang. DTT = Doanh thu − Giá vốn − Phí ship (KHÔNG trừ QC)
  const DTT_BRACKETS = [
    { min: 150e6, max: 240e6, bonus: 1e6 }, { min: 240e6, max: 330e6, bonus: 2e6 },
    { min: 330e6, max: 420e6, bonus: 3e6 }, { min: 420e6, max: 510e6, bonus: 4e6 },
    { min: 510e6, max: 600e6, bonus: 5e6 }, { min: 600e6, max: 690e6, bonus: 6e6 },
  ];
  function tinhThuongDTT(dtt) {
    if (dtt < 150e6) return 0;
    for (const b of DTT_BRACKETS) if (dtt >= b.min && dtt <= b.max) return b.bonus;
    if (dtt > 690e6) return 6e6 + Math.floor((dtt - 690e6) / 90e6 + 1) * 1e6;
    return 0;
  }

  function blankCh() { return { dt: 0, qc: 0, gv: 0, ship: 0 }; }

  // Chuẩn hoá 1 bản ghi nhập tay (bổ sung field thiếu)
  function chuanHoaManual(o, name) {
    o = o || {};
    const channels = {};
    for (const c of CH_MKT) channels[c] = Object.assign(blankCh(), (o.channels || {})[c] || {});
    return {
      name: o.name || name,
      channels,
      luongCung: +o.luongCung || 0,
      thuongNgayTuan: +o.thuongNgayTuan || 0,
      phat: +o.phat || 0,
      bhxh: +o.bhxh || 0,
    };
  }

  const chSum = (m, metric) => CH_MKT.reduce((s, c) => s + (+m.channels[c][metric] || 0), 0);

  /**
   * Tính lương Marketing cho tất cả nhân viên.
   * @param {Array}  rows     - report.rows từ /api/salary/report (dữ liệu tự động)
   * @param {Object} manual   - dữ liệu nhập tay từ /api/salary/manual, key = normKey(tên)
   * @param {Object} opts     - { tyLe, teamLead, roster }
   * @returns {{ list: Array, tong: Object }}
   */
  function tinhLuongMKT(rows, manual, opts) {
    opts = opts || {};
    const tyLe = opts.tyLe != null ? opts.tyLe : 0.02;
    const teamLead = opts.teamLead || {};
    const autoByKey = {};
    (rows || []).forEach(r => { autoByKey[normKey(r.name)] = r; });

    // Danh sách người: roster (nếu có) hoặc lấy từ rows
    const names = (opts.roster && opts.roster.length)
      ? opts.roster.slice()
      : (rows || []).map(r => r.name);

    // ── Vòng 1: DT/QC/GV/SHIP thực tế (tự động + kênh nhập tay) → lương 2% ──
    const list = names.map(name => {
      const key = normKey(name);
      const a = autoByKey[key] || {};
      const m = chuanHoaManual((manual || {})[key], name);
      const DT = (+a[AUTOFIELD.dt] || 0) + chSum(m, 'dt');
      const QC = (+a[AUTOFIELD.qc] || 0) + chSum(m, 'qc');
      const GV = (+a[AUTOFIELD.gv] || 0) + chSum(m, 'gv');
      const SHIP = (+a[AUTOFIELD.ship] || 0) + chSum(m, 'ship');
      const l2 = Math.round((DT - QC - GV - SHIP) * tyLe);
      return {
        name, key, m,
        autoDT: +a[AUTOFIELD.dt] || 0, autoQC: +a[AUTOFIELD.qc] || 0,
        autoGV: +a[AUTOFIELD.gv] || 0, autoSHIP: +a[AUTOFIELD.ship] || 0,
        manDT: chSum(m, 'dt'), manQC: chSum(m, 'qc'), manGV: chSum(m, 'gv'), manSHIP: chSum(m, 'ship'),
        DT, QC, GV, SHIP, l2,
        thuongDTT: tinhThuongDTT(DT - GV - SHIP),
        thuongTop1: 0, hl: 0,
      };
    });

    // ── HH Leader = ½ × tổng lương 2% của thành viên, KHÔNG tính phần từ Sàn TMĐT ──
    const l2ByKey = {};
    list.forEach(x => {
      const san = x.m.channels['san'] || blankCh();
      const sanNet = (+san.dt || 0) - (+san.qc || 0) - (+san.gv || 0) - (+san.ship || 0);
      l2ByKey[x.key] = x.l2 - Math.round(sanNet * tyLe);
    });
    const teamByKey = {};
    Object.keys(teamLead).forEach(lead => { teamByKey[normKey(lead)] = teamLead[lead]; });
    list.forEach(x => {
      const members = teamByKey[x.key];
      if (!members) return;
      x.hl = Math.round(members.reduce((s, n) => s + (l2ByKey[normKey(n)] || 0), 0) / 2);
    });

    // ── Thưởng Top 1: lương 2% cao nhất, phải DUY NHẤT và > 0 → ½ lương 2% ──
    const eligible = list.filter(x => x.l2 > 0).sort((a, b) => b.l2 - a.l2);
    if (eligible.length && (eligible.length === 1 || eligible[0].l2 !== eligible[1].l2))
      eligible[0].thuongTop1 = Math.round(eligible[0].l2 / 2);

    // ── Thực nhận ──
    list.forEach(x => {
      x.thuong = x.thuongDTT + x.thuongTop1 + x.m.thuongNgayTuan;
      x.tn = roundK(x.l2 + x.m.luongCung + x.thuong - x.m.phat - x.m.bhxh + x.hl);
      x.laAdmin = x.key === normKey('Admin');
    });

    // ── Tổng: doanh thu/chi phí GỒM Admin (là số công ty), lương TÁCH RIÊNG Admin ──
    const tong = {
      DT: 0, QC: 0, GV: 0, SHIP: 0, l2: 0, hl: 0, lc: 0, th: 0, ph: 0, bh: 0, tn: 0,
      luongKhongAdmin: 0, luongAdmin: 0,
    };
    list.forEach(x => {
      tong.DT += x.DT; tong.QC += x.QC; tong.GV += x.GV; tong.SHIP += x.SHIP;
      tong.l2 += x.l2; tong.hl += x.hl; tong.lc += x.m.luongCung; tong.th += x.thuong;
      tong.ph += x.m.phat; tong.bh += x.m.bhxh; tong.tn += x.tn;
      if (x.laAdmin) tong.luongAdmin += x.tn; else tong.luongKhongAdmin += x.tn;
    });

    return { list, tong };
  }

  /* ── LƯƠNG PHÁT TRIỂN SẢN PHẨM ─────────────────────────────────── */

  /**
   * Tính lương PTSP.
   * @param {Array}  managers - report.managers từ /api/salary-product/report
   * @param {Object} manual   - từ /api/salary-product/manual, key = normKey(tên)
   *
   * BHXH: ưu tiên số nhập tay, không có thì lấy mặc định server gắn vào report.
   *       (khớp đúng dòng `man.bhxh = man.bhxh || m.bhxh || 0` ở salary-product.html)
   */
  function tinhLuongPTSP(managers, manual) {
    const list = (managers || []).map(m => {
      const rec = (manual || {})[normKey(m.manager)] || {};
      const thuong = (+rec.thuongSP || 0) + (+rec.thuongThang || 0);
      const bhxh = (+rec.bhxh || 0) || (+m.bhxh || 0);
      const luongCung = +rec.luongCung || 0;
      const phat = +rec.phat || 0;
      const tn = roundK((m.hoaHong || 0) + luongCung + thuong - phat - bhxh);
      return { name: m.manager, hoaHong: m.hoaHong || 0, luongCung, thuong, phat, bhxh, tn };
    });
    const tong = list.reduce((s, x) => s + x.tn, 0);
    return { list, tong };
  }

  global.SalaryCalc = {
    normKey, roundK,
    CH_MKT, AUTOFIELD, DTT_BRACKETS,
    tinhThuongDTT, chuanHoaManual, chSum,
    tinhLuongMKT, tinhLuongPTSP,
  };
})(typeof window !== 'undefined' ? window : globalThis);
