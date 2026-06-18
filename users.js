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

  // Thêm các tài khoản khác ở đây, ví dụ:
  // { user: 'truong', pass: '...', role: 'viewer', employees: ['Tạ Quang Trường'] },
  // { user: 'my',     pass: '...', role: 'viewer', employees: ['Nguyễn Thị Trà My'] },

];
