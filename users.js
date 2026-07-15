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

  // ----- TEAM LEAD MARKETING -----
  //  employees = danh sách người xem được KẾT QUẢ Marketing (cả team)
  //  salaryName = chỉ xem LƯƠNG của chính mình
  { user: 'mkt.phuong', pass: 'Phuong@45678', role: 'viewer',
    employees: ['Trịnh Đức Phương', 'Đoàn Việt Hà', 'Nguyễn Duy Huân', 'Vũ Thuý An', 'Lê Thị Ánh Tuyết', 'Phạm Quang Tùng'],
    salaryName: 'Trịnh Đức Phương' },
  { user: 'mkt.truong', pass: 'Truong@1234', role: 'viewer',
    employees: ['Tạ Quang Trường', 'Nguyễn Thị Trà My', 'Dương Văn Minh', 'Lê Thị Ánh', 'Lưu Xuân Phong', 'Nguyễn Thị Thu Phương'],
    salaryName: 'Tạ Quang Trường' },

  // ----- NHÂN VIÊN MARKETING (xem KQ marketing của mình + lương của mình) -----
  { user: 'mkt.hieu',  pass: 'Hieu@1452',  role: 'viewer', employees: ['Nguyễn Trung Hiếu'], salaryName: 'Nguyễn Trung Hiếu' },
  { user: 'mkt.my',    pass: 'My@7853',    role: 'viewer', employees: ['Nguyễn Thị Trà My'], salaryName: 'Nguyễn Thị Trà My' },
  { user: 'mkt.anh',   pass: 'Anh@2314',   role: 'viewer', employees: ['Lê Thị Ánh'],        salaryName: 'Lê Thị Ánh' },
  { user: 'mkt.huan',  pass: 'Huan@1245',  role: 'viewer', employees: ['Nguyễn Duy Huân'],   salaryName: 'Nguyễn Duy Huân' },
  { user: 'mkt.minh',  pass: 'Minh@7532',  role: 'viewer', employees: ['Dương Văn Minh'],    salaryName: 'Dương Văn Minh' },
  { user: 'mkt.giang', pass: 'Giang@1737', role: 'viewer', employees: ['Vũ Hà Giang'],       salaryName: 'Vũ Hà Giang' },
  { user: 'mkt.ha',    pass: 'Ha@3597',    role: 'viewer', employees: ['Đoàn Việt Hà'],       salaryName: 'Đoàn Việt Hà' },
  { user: 'mkt.thuyan',    pass: 'An@2578',    role: 'viewer', employees: ['Vũ Thuý An'],         salaryName: 'Vũ Thuý An' },
  { user: 'mkt.anhtuyet',    pass: 'Tuyet@2278',    role: 'viewer', employees: ['Lê Thị Ánh Tuyết'],         salaryName: 'Lê Thị Ánh Tuyết' },
  { user: 'mkt.tung',    pass: 'Tung@35927',    role: 'viewer', employees: ['Phạm Quang Tùng'],       salaryName: 'Phạm Quang Tùng' },

  // ----- NHÂN VIÊN PHÁT TRIỂN SẢN PHẨM (xem trang SP của mình + lương của mình) -----
  //  manager = tên ở cột "Quản Lý" trong Google Sheet (để lọc SP + xem lương)
  { user: 'kien',  pass: 'Kien@1122', role: 'product', manager: 'Đào Trung Kiên',     salaryName: 'Đào Trung Kiên' },
  { user: 'trang', pass: 'Trang@8899', role: 'product', manager: 'Nguyễn Huyền Trang', salaryName: 'Nguyễn Huyền Trang' },

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
