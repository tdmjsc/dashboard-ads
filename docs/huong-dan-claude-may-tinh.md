# Hướng dẫn cho Claude trên máy tính: kết nối "Tên xuất hoá đơn theo lô" với Sandbox

> Dán toàn bộ nội dung file này cho Claude trên máy tính (ứng dụng Claude có điều khiển máy tính, hoặc tiện ích Claude in Chrome).

## Bối cảnh

Công ty TDMJSC dùng các hệ thống sau:
- **Sandbox** (`tdmjsc.sandbox.com.vn`): quản lý đơn hàng và sản phẩm. Mỗi sản phẩm có ô **"Tên xuất hoá đơn"** trong form *Cập nhật sản phẩm* (Kho → Quản lý sản phẩm).
- **MISA AMIS Hộ kinh doanh**: theo dõi tồn kho, mỗi lô nhà cung cấp là một mã hàng riêng.
- **ads.tdmjsc.com**: trang quản trị nội bộ của công ty. Trang **`https://ads.tdmjsc.com/ten-hoa-don.html`** (chỉ tài khoản admin vào được) giữ cho mỗi sản phẩm Sandbox một danh sách tên xuất hoá đơn B, C, D… (cùng một mặt hàng, khác nhà cung cấp). Khi tên đang dùng hết số lượng, máy chủ tự sửa ô "Tên xuất hoá đơn" trên Sandbox sang tên kế tiếp.

Sandbox không có API công khai để sửa sản phẩm. Vì vậy máy chủ cần **một request "Lưu sản phẩm" thật**, chép từ trình duyệt, cho **từng sản phẩm**. Máy chủ gửi lại đúng request đó và chỉ thay trường tên xuất hoá đơn.

## Việc cần làm

Với **mỗi sản phẩm** đã khai trên trang `ten-hoa-don.html`:

1. **Mở trang quản trị.** Vào `https://ads.tdmjsc.com/ten-hoa-don.html`, đăng nhập tài khoản admin nếu được hỏi. Người dùng tự đăng nhập, không hỏi mật khẩu. Ghi lại tên các sản phẩm đang có trên trang. Nếu sản phẩm chưa được tạo, dừng lại và hỏi người dùng.
2. **Mở Sandbox ở tab khác.** Vào `https://tdmjsc.sandbox.com.vn` (người dùng đã đăng nhập sẵn), rồi **Kho → Quản lý sản phẩm** và tìm đúng sản phẩm đó.
3. **Mở DevTools.** Bấm `F12` (Mac: `Cmd+Option+I`), chọn tab **Network**, bấm 🚫 để xoá danh sách, chọn bộ lọc **Fetch/XHR**.
4. **Lấy request chi tiết (khuyên làm).** Mở form **Cập nhật sản phẩm** của sản phẩm.
   - Trong Network, tìm request vừa xuất hiện khi mở form: thường có mã sản phẩm trong địa chỉ, hoặc chữ `GetById`/`Detail`, và tab Preview có dữ liệu sản phẩm.
   - Chuột phải vào request → **Copy → Copy as cURL (bash)**.
   - Dán vào ô **"Request chi tiết sản phẩm"** của đúng sản phẩm trên `ten-hoa-don.html` → bấm **Lưu request chi tiết**.
5. **Lấy request Lưu.** Quay lại Sandbox, bấm 🚫 trong Network, rồi bấm nút **Lưu** trên form.
   - **Không sửa bất kỳ ô nào trước khi bấm Lưu.**
   - Tìm request vừa gửi khi Lưu: method POST/PUT, tab Payload chứa dữ liệu sản phẩm, có tên xuất hoá đơn hiện tại.
   - Chuột phải → **Copy as cURL (bash)** (không chọn bản *cmd*). Dán vào ô **"Request Lưu sản phẩm"** → bấm **Lưu request Lưu**.
6. **Kiểm tra trường tên.** Trang sẽ hiện "Trường tên xuất HĐ" và "giá trị trong request".
   - Giá trị đó phải trùng với tên xuất hoá đơn đang ghi trên Sandbox.
   - Nếu không trùng, chọn trường khác trong danh sách (hoặc gõ tên trường) rồi bấm **Chọn**.
7. **Gửi thử.** Bấm **Gửi thử**. Nút này ghi lại đúng tên đang dùng, không thay đổi gì.
   - Kết quả đúng là "Sandbox nhận request".
   - Mở lại form trên Sandbox để xác nhận tên xuất hoá đơn **và giá bán** không bị thay đổi.
8. Báo kết quả từng sản phẩm cho người dùng.

## Quy tắc an toàn (bắt buộc)

- **Không bấm "Dùng ngay"** và không đổi thứ tự tên trên `ten-hoa-don.html` nếu người dùng chưa đồng ý. Các thao tác đó đổi tên xuất hoá đơn thật trên Sandbox.
- **Không sửa dữ liệu sản phẩm trên Sandbox.** Chỉ mở form rồi bấm Lưu nguyên trạng.
- Đoạn cURL chứa cookie đăng nhập Sandbox. **Chỉ dán vào trang `ads.tdmjsc.com`.** Không chép vào chat, ghi chú, email hay trang nào khác. Không hỏi hay nhập mật khẩu thay người dùng.
- Không xoá sản phẩm hay request đã lưu trên `ten-hoa-don.html`.

## Lỗi thường gặp

| Thông báo | Cách xử lý |
|---|---|
| "Request phải gửi tới tên miền sandbox.com.vn" | Chép nhầm request (ví dụ của Google Analytics). Chọn lại request có địa chỉ `…sandbox.com.vn`. |
| "Request Lưu sản phẩm phải có dữ liệu sản phẩm (body)" | Đã chép request GET. Chọn request được gửi **khi bấm Lưu**. |
| "Không tự tìm thấy trường tên xuất hoá đơn" | Xem tab Payload của request Lưu, tìm khoá có giá trị đúng bằng tên xuất hoá đơn, gõ tên khoá đó vào ô "hoặc gõ tên trường" rồi bấm **Chọn**. Trường lồng nhau thì viết dạng `data.tenTruong`. |
| "Sandbox từ chối (HTTP 401/403)" | Phiên đăng nhập hết hạn: tải lại Sandbox, chép lại request. Nếu lỗi lặp lại, báo người dùng khai `SANDBOX_WEB_USER`/`SANDBOX_WEB_PASS` trên máy chủ hosting. |
| Gửi thử báo thành công nhưng tên/giá trên Sandbox bị đổi | **Dừng ngay**, báo người dùng và xoá request Lưu của sản phẩm đó (nút trong mục Kết nối Sandbox, hoặc dán lại request đúng). |

## Phần dành cho lập trình viên (Claude Code)

Bỏ qua phần này nếu chỉ làm các bước trên trình duyệt.

- Mã nguồn: GitHub `tdmjsc/dashboard-ads`. Đẩy lên `main` là tự deploy lên ads.tdmjsc.com. Đọc `CLAUDE.md` trước khi sửa.
- Module: `ten-hoa-don.js` (logic, API `/api/ton-kho/hd/*`), trang `public/ten-hoa-don.html`.
  - Dữ liệu lưu ở `DATA_DIR/ten-hoa-don.json` trên hosting.
  - Kiểm tra đổi tên chạy sau mỗi lần tồn MISA đồng bộ (`afterSnapshot` trong `tonkho.js`).
- Chưa từng chạy với Sandbox thật. Lần đầu dán request, nên xem cấu trúc URL/body thật để xác nhận `findInvoiceFields` chọn đúng trường.
- Việc có thể làm tiếp:
  1. Chỉ cần dán request một lần cho mọi sản phẩm (thay mã sản phẩm trong URL/body). Cần xem request thật trước để biết mã sản phẩm nằm ở đâu.
  2. Sửa health check trong `.github/workflows/deploy.yml`. Hiện log in ra "Server OK (HTTP 000000)" vì `curl … || echo "000"` nối thêm "000", nên khi server không phản hồi vẫn báo OK và không rollback.
