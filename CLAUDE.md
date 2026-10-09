# Ghi chú cho Claude

Đẩy lên `main` là tự deploy lên ads.tdmjsc.com (`.github/workflows/deploy.yml`).

## Báo cáo marketing (`/api/marketing/report`, hàm `sandboxReport` trong `server.js`)

Doanh số / đơn chốt / số SP lấy từ báo cáo Sandbox `ReportLeadByNhanSuMktSearch`, gọi mới mỗi lần mở trang (không cache). Chỉ chi tiêu Meta là có cache (`meta-cache.json`).

**Bắt buộc giữ cả hai tham số** (Sandbox đã xác nhận đây là cách ra số đúng, đã đối chiếu: Lưu Xuân Phong ngày 7/10/2026 = 11 SP / 4.900.000):

- `kieuNgay: 'NgayTaoContact'`: chỉ tính contact về trong khoảng ngày chọn.
  - Đừng dùng `'NgayTao'`: kiểu này tính cả đơn chốt trong ngày của contact về từ các ngày trước, nên tỷ lệ chốt có thể vượt 100%.
- `khongGioiHanNgayChot` (Không giới hạn ngày chốt): tính mọi đơn chốt của các contact đó, kể cả đơn chốt những ngày sau.
  - Thiếu cờ này thì Sandbox chỉ đếm đơn chốt trong chính khoảng ngày, nên xem lại ngày cũ sẽ thiếu doanh số của đơn chốt muộn.

Đã từng xảy ra lỗi: chỉ có `NgayTaoContact` mà không có cờ thì thiếu doanh số. Có lần gửi cờ dạng `true` thì Sandbox báo "Lỗi gọi báo cáo". Vì vậy `sandboxReport` thử lần lượt các dạng `[true, 1, 'true']` và nhớ dạng chạy được. Nếu không dạng nào chạy được, hàm gọi không có cờ và trang hiện cảnh báo. Đừng gỡ cơ chế thử lần lượt này.

Muốn kiểm tra số liệu thì mở endpoint dành cho admin: `/api/marketing/check-ngay-chot?since=YYYY-MM-DD&until=YYYY-MM-DD&name=<tên NV>`. Endpoint này so sánh các cách gọi và hiện lỗi gốc của Sandbox.

Không có tài khoản Sandbox trong môi trường dev. Đổi tham số báo cáo xong thì nhờ người dùng đối chiếu số với Sandbox.

## Tên xuất hoá đơn theo lô (`ten-hoa-don.js`, trang `/ten-hoa-don.html`)

Một sản phẩm Sandbox nhập từ nhiều nhà cung cấp, mỗi nhà cung cấp có tên riêng trên MISA. Module giữ hàng đợi tên xuất hoá đơn. Khi tên đang dùng hết số lượng (tồn MISA, hoặc số nhập tay trừ dần theo tồn MISA giảm), module tự đổi ô "Tên xuất hoá đơn" trên Sandbox sang tên kế tiếp.

- Cách chính (khi có `SANDBOX_WEB_USER`/`SANDBOX_WEB_PASS`): admin nhập **Mã SP Sandbox**, máy chủ dùng phiên đăng nhập của nó (`global.__sandboxAuth` trong `server.js`) gọi web API của form Cập nhật sản phẩm: `TimTheoDieuKienSPCha` (tìm id theo mã) → `SanPhamInit` (`data.data`) → `CapNhatThongTin`. `buildSaveBody` dựng body y hệt form (đã so khớp từng trường với một lần Lưu thật 9/10/2026). Sau khi lưu, đọc lại và so mọi trường; lệch thì ghi lại dữ liệu cũ và báo lỗi. Sản phẩm có thuộc tính con / cấu thành thì từ chối.
- Sandbox xác thực bằng cookie (không có header Authorization). Mỗi tài khoản chỉ một phiên: máy chủ đăng nhập lại sẽ đá phiên trình duyệt cùng tài khoản và ngược lại.
- Cách dự phòng: admin dán request "Lưu" (và request chi tiết) từ DevTools, máy chủ gửi lại request đó và chỉ thay trường tên (`tenXuatHoaDon`).
- "Gửi thử" lưu lại nguyên trạng tên đang có trên Sandbox, không lấy tên trong hàng đợi.
- Kiểm tra chạy sau mỗi lần tồn MISA đổi (`afterSnapshot` trong `tonkho.js`).
