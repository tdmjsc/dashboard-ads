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
- Số lượng đã xuất hoá đơn dưới tên đang dùng (`refreshInvoiced`, chạy trong `checkAll` và mỗi 20 phút): hoá đơn điện tử từ `invoice/api/Invoice/TimHoaDonDienTuTheoDieuKien` (phiên web, chỉ `actionCode` 1 = phát hành, `ngayTao` giờ VN ≥ lúc tên bắt đầu dùng). Hoá đơn không có dòng hàng → dòng hàng lấy theo mã đơn qua web API `orderlogistic/api/DonHangLogistic/GetChiTietDonByMa` `{MaDon}` (cùng phiên web), cache ở `STORE.orders`. Dòng hàng: `donHangLogisticSanPhamDtos` (đã xác nhận với đơn thật) + combo `donHangLogisticComboDtos` (`soLuong` combo × `soLan` của sản phẩm trong `comBoSpaKhachHangChiTietDtos`; đã xác nhận với đơn combo thật 12/10/2026). `idSanPham` ở dòng đơn là id con, khác id sản phẩm gốc (`idSanPhamCha` mới là id gốc). Dòng trong combo không có mã SP (chỉ `ten`, `idSanPham`) → nhận qua id trong đơn: sản phẩm có thuộc tính thì `TimTheoDieuKienSPCha` trả id "cha", còn đơn dùng id do `SanPham/TimTheoDieuKien` trả (bắt buộc truyền nhóm SP, tìm theo tên rồi lọc đúng mã) → `rule.sbBranchIds`. Đã đối chiếu 12/10/2026 với máy đo và gel. Thêm dự phòng: id học từ dòng bán lẻ khớp mã SP (`rule.sbIds`). Đừng dùng API đối tác `GetOrderByConditions` cho việc này: nó lọc theo ngày data về (không theo mã đơn) và bị giới hạn ~1 lần gọi / 30–60 giây (dùng chung với trang marketing). Chẩn đoán một đơn: `/api/ton-kho/hd/debug-don?ma=DHLOG…`. Nhập tay SL được xuất thì còn lại = SL − số đã xuất HĐ (thay cách trừ theo tồn MISA). Chưa xử lý hoá đơn thay thế/điều chỉnh/huỷ.
- Kiểm tra chạy sau mỗi lần tồn MISA đổi (`afterSnapshot` trong `tonkho.js`).

## Lương MKT: doanh thu TikTok + Shopee ghi nhận cho ai (`salary.html`, `ttspAdminPortion` trong `server.js`)

Đơn TikTok/Shopee không gán NV marketing nên nằm trong dòng Admin (dòng này còn lẫn đơn khác). Mỗi tháng admin chọn người ghi nhận (lưu `salary-ttsp.json`; tháng chưa cài thì lấy người nhận của tháng trước). Phần chuyển sang nhân viên được tính vào lương 2% nhưng không tính Thưởng DTT / Top 1 / HH Leader (`tinhLuongMKT` trong `salary-calc.js`, opts `ttsp`).

Số tự động: lấy `id` các nguồn có tên TikTok/Shopee từ báo cáo "Leads theo nguồn", rồi gọi báo cáo sản phẩm `BaoCaoMktTheoSanPham` với `strIdNguonDuLieu` = các id nối dấu phẩy, `idUserMkts` = [id Admin = GUID toàn số 0], theo từng trạng thái giao/thanh toán → doanh số + số lượng từng SP (giá vốn). Đã đối chiếu 14/10/2026 tháng 8/2026: Shopee 85.252.625 + TikTok 39.894.000 = 125.146.625 (Admin tổng 132.962.625).
- Báo cáo lương theo nhân sự `ReportLeadByNhanSuMktSearch` **bỏ qua** `strIdNguonDuLieu`; nó chỉ lọc nguồn qua `idLandingSanPham` (1 id dạng chuỗi, mảng thì ra 0).
- Ô nhập tay trên trang ghi đè số tự động (để trống = tự động).

## Bot Telegram "chat all" (`telegram-all.js`)

Gõ `@all` hoặc `/all` trong nhóm có bot → bot nhắc tên mọi thành viên (5 người / tin, mỗi nhóm tối đa 1 lần / 30 giây). Token riêng `TELEGRAM_ALL_BOT_TOKEN` trong `.env`; không có token thì bot tắt. Nhận tin qua webhook `/tg-all/webhook` (loại trừ khỏi middleware đăng nhập, kiểm tra header secret_token); máy chủ tự `setWebhook` lúc khởi động. Đừng chạy bản dev có cùng token: nó sẽ chiếm webhook của máy chủ thật.

Telegram không cho bot lấy danh sách thành viên → bot ghi nhớ người đã nhắn / vào / rời nhóm (`DATA_DIR/tg-all.json`). Cần tắt privacy mode (BotFather /setprivacy) hoặc cho bot làm admin để bot thấy mọi tin. Xem tình trạng: `/api/tg-all` (admin).
