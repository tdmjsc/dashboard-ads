// =====================================================================
//  DANH SÁCH TÀI KHOẢN ĐĂNG NHẬP  —  BẠN TỰ QUẢN LÝ FILE NÀY
//  - File này KHÔNG bị ghi đè khi cập nhật server.js. Cứ giữ trên GitHub.
//  - Mỗi tài khoản: { user, pass, role, employees }
//      role: 'admin'  -> xem TẤT CẢ, là chủ hệ thống (không cần employees)
//      role: 'viewer' -> chỉ xem những người ghi trong "employees"
//  - "employees": ghi TÊN ĐẦY ĐỦ (giống hệt tên hiển thị / tên trong Sandbox).
//
//  Tên đầy đủ của các nhân viên (chép cho đúng dấu):
//      'Tạ Quang Trường'      'Trịnh Đức Phương'   'Nguyễn Trung Hiếu'
//      'Nguyễn Thị Trà My'    'Lê Thị Ánh'         'Nguyễn Duy Huân'
//      'Dương Văn Minh'       'Vũ Hà Giang'        'Đoàn Việt Hà'
//      'Vũ Thuý An'
//
//  ⚠️ ĐỔI HẾT mật khẩu mẫu bên dưới thành mật khẩu thật của bạn.
//  Thêm tài khoản = thêm một dòng { ... }, nhớ dấu phẩy ở cuối.
// =====================================================================
export const USERS = [

  // ----- Chủ hệ thống (xem tất cả) -----
  { user: 'tdmjsc', pass: 'Tdmjsc@0611', role: 'admin' },
  { user: 'ketoan', pass: 'Tdmjsc@1234', role: 'admin' },

  // ----- Trưởng phòng (xem nhiều nhân viên) — ví dụ, sửa lại theo thực tế -----
  { user: 'mkt.phuong', pass: 'Phuong@45678', role: 'viewer',
    employees: ['Trịnh Đức Phương', 'Đoàn Việt Hà', 'Nguyễn Duy Huân', 'Vũ Thuý An'] },

  // ----- Nhân viên (chỉ xem chính mình) — ví dụ -----
  { user: 'mkt.truong', pass: 'Truong@1234', role: 'viewer',
    employees: ['Tạ Quang Trường', 'Nguyễn Thị Trà My', 'Dương Văn Minh', 'Lê Thị Ánh'] },
  // ----- Nhân viên PHÁT TRIỂN SẢN PHẨM (chỉ vào trang Sản phẩm, chỉ thấy SP của mình) -----
  //  "manager" phải KHỚP tên ở cột "Quản Lý" trong Google Sheet.
  { user: 'kien',  pass: 'Kien@1122', role: 'product', manager: 'Đào Trung Kiên' },
  { user: 'trang', pass: 'Trang@8899', role: 'product', manager: 'Nguyễn Huyền Trang' },

  // ----- TÀI KHOẢN NHÂN VIÊN XEM LƯƠNG (role: 'staff') -----
  //  Chỉ vào được trang "Lương của tôi" (my-salary.html), xem bảng lương ĐÃ CÔNG KHAI.
  //  "employees" ghi TÊN ĐẦY ĐỦ của chính nhân viên đó (1 tên).
  //  Nhân viên PTSP thì dùng "manager" thay cho "employees".
  { user: 'nv.truong', pass: 'Truong@xem1', role: 'staff', employees: ['Tạ Quang Trường'] },
  { user: 'nv.phuong', pass: 'Phuong@xem1', role: 'staff', employees: ['Trịnh Đức Phương'] },
  { user: 'nv.hieu',   pass: 'Hieu@xem1',   role: 'staff', employees: ['Nguyễn Trung Hiếu'] },
  { user: 'nv.my',     pass: 'My@xem1',     role: 'staff', employees: ['Nguyễn Thị Trà My'] },
  { user: 'nv.anh',    pass: 'Anh@xem1',    role: 'staff', employees: ['Lê Thị Ánh'] },
  { user: 'nv.huan',   pass: 'Huan@xem1',   role: 'staff', employees: ['Nguyễn Duy Huân'] },
  { user: 'nv.minh',   pass: 'Minh@xem1',   role: 'staff', employees: ['Dương Văn Minh'] },
  { user: 'nv.giang',  pass: 'Giang@xem1',  role: 'staff', employees: ['Vũ Hà Giang'] },
  { user: 'nv.ha',     pass: 'Ha@xem1',     role: 'staff', employees: ['Đoàn Việt Hà'] },
  { user: 'nv.an',     pass: 'An@xem1',     role: 'staff', employees: ['Vũ Thuý An'] },
  // Nhân viên PTSP xem lương (dùng manager):
  { user: 'nv.kien',   pass: 'Kien@xem1',   role: 'staff', manager: 'Đào Trung Kiên' },
  { user: 'nv.trang2', pass: 'Trang@xem1',  role: 'staff', manager: 'Nguyễn Huyền Trang' },

];


// =====================================================================
//  CHAT ID TELEGRAM CỦA TỪNG NHÂN VIÊN  (để gửi bảng lương riêng)
//  - KEY = TÊN ĐẦY ĐỦ (giống hệt tên hiển thị trong bảng lương)
//  - VALUE = Chat ID Telegram (dạng số, ví dụ 123456789)
//
//  CÁCH LẤY CHAT ID:
//   1. Nhân viên nhắn 1 tin bất kỳ cho bot (bấm Start trong Telegram)
//   2. Admin mở: https://api.telegram.org/bot<TOKEN>/getUpdates
//   3. Tìm "chat":{"id":123456789} → số đó là Chat ID
//
//  ⚠️ Ai CHƯA có Chat ID (để trống/xoá dòng) thì sẽ KHÔNG nhận được lương.
// =====================================================================
export const TELEGRAM_CHAT_IDS = {
  // ----- Nhân viên Marketing -----
  'Tạ Quang Trường':   '',   // điền Chat ID vào đây
  'Trịnh Đức Phương':  '',
  'Nguyễn Trung Hiếu': '',
  'Nguyễn Thị Trà My': '',
  'Lê Thị Ánh':        '',
  'Nguyễn Duy Huân':   '',
  'Dương Văn Minh':    '',
  'Vũ Hà Giang':       '',
  'Đoàn Việt Hà':      '',
  'Vũ Thuý An':        '',

  // ----- Nhân viên Phát triển sản phẩm -----
  'Đào Trung Kiên':     '',
  'Nguyễn Huyền Trang': '',
};
