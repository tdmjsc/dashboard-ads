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
  { user: 'admin', pass: 'DAT_MAT_KHAU_MANH', role: 'admin' },

  // ----- Trưởng phòng (xem nhiều nhân viên) — ví dụ, sửa lại theo thực tế -----
  { user: 'truongphong1', pass: 'doi_mat_khau', role: 'viewer',
    employees: ['Trịnh Đức Phương', 'Nguyễn Thị Trà My', 'Nguyễn Duy Huân'] },

  // ----- Nhân viên (chỉ xem chính mình) — ví dụ -----
  { user: 'phuong', pass: 'doi_mat_khau', role: 'viewer',
    employees: ['Trịnh Đức Phương'] },

  // Thêm các tài khoản khác ở đây, ví dụ:
  // { user: 'truong', pass: '...', role: 'viewer', employees: ['Tạ Quang Trường'] },
  // { user: 'my',     pass: '...', role: 'viewer', employees: ['Nguyễn Thị Trà My'] },

];
