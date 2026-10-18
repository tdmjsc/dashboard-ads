# App iOS "TDM Ads" (TestFlight nội bộ)

App chỉ là khung mở `https://ads.tdmjsc.com` (WKWebView). Mọi chức năng nằm trên web: đẩy lên `main` là app có bản mới, **không phải tải lại qua TestFlight**.

Chỉ phải tải bản build mới khi:
- sửa file trong thư mục `ios/` (icon, tên app, thêm tính năng native), hoặc
- bản build sắp hết hạn: mỗi bản TestFlight chỉ dùng được **90 ngày**.

App đã có sẵn: giữ đăng nhập (cookie 30 ngày của web), kéo xuống để tải lại, vuốt từ mép trái để quay lại, tự tải lại khi mở lại app sau hơn 10 phút, link ngoài mở bằng Safari, hiện `alert`/`confirm` của web, tải file (CSV, ảnh QR) ra bảng chia sẻ, màn hình "Thử lại" khi mất mạng.

Chưa có: thông báo đẩy. Web push không chạy trong app; muốn có thì phải làm push native (APNs).

## Yêu cầu

- Từ 4/2026 App Store Connect chỉ nhận bản build làm bằng **Xcode 26** trở lên, mà Xcode 26 cần **macOS 15.6** trở lên. Máy hiện tại chạy Xcode 16.2 / macOS 14 nên build và chạy simulator được, nhưng **không tải lên được**.
- Tài khoản Apple Developer (đã có).

## Lần đầu

1. **Tạo app trên App Store Connect** (appstoreconnect.apple.com → Apps → + → New App):
   - Platform iOS, Name `TDM Ads` (tên phải chưa ai dùng trên App Store; trùng thì đặt `TDM Ads Nội bộ`).
   - Bundle ID: tạo `com.tdmjsc.ads` ở developer.apple.com → Identifiers nếu chưa có. Nếu muốn đổi Bundle ID thì sửa cả `PRODUCT_BUNDLE_IDENTIFIER` trong Xcode.
   - SKU: `tdm-ads`.
2. **Mở project:** `open ios/TDMAds.xcodeproj` → chọn target **TDMAds** → tab **Signing & Capabilities** → **Team** chọn team công ty (để "Automatically manage signing").
3. **Archive:** chọn thiết bị đích **Any iOS Device (arm64)** → menu **Product → Archive**.
4. **Tải lên:** khi cửa sổ Organizer mở → **Distribute App** → **TestFlight Internal Only** → Distribute.
5. Đợi khoảng 5–30 phút để Apple xử lý xong (có email báo).

## Mời nhân viên

- Mỗi người phải là thành viên team App Store Connect (**Users and Access** → +, quyền tối thiểu như *Marketing* hoặc *Customer Support*), dùng Apple ID của họ. Tối đa 100 người.
- **TestFlight → Internal Testing → +** tạo nhóm (vd `Nhân viên`), thêm người, bật **Automatic Distribution** để bản build mới tự đến tay mọi người.
- Nhân viên cài app **TestFlight** từ App Store → mở email mời → **Accept** → **Install**. Trong TestFlight bật **Automatic Updates**.

## Tải bản mới (khi sửa `ios/` hoặc gần 90 ngày)

1. Tăng **Build** (`CURRENT_PROJECT_VERSION`) lên 1 trong tab General của target. Nếu đổi lớn thì tăng cả **Version**.
2. Product → Archive → Distribute App → TestFlight Internal Only.

## Build thử trên simulator (không cần tài khoản)

```bash
cd ios && xcodebuild -project TDMAds.xcodeproj -scheme TDMAds -sdk iphonesimulator -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual build
```

Phải ký ad-hoc (`CODE_SIGN_IDENTITY=-`). Bản không ký thì WebKit không chạy, chỉ ra màn hình trống.
