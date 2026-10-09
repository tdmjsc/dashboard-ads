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
