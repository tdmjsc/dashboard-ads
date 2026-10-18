# App iOS "TDM Ads" (TestFlight nội bộ)

App chỉ là khung mở `https://ads.tdmjsc.com` (WKWebView). Mọi chức năng nằm trên web: đẩy lên `main` là app có bản mới, **không phải tải lại qua TestFlight**.

Chỉ phải tải bản build mới khi:
- sửa file trong thư mục `ios/` (icon, tên app, thêm tính năng native), hoặc
- bản build sắp hết hạn: mỗi bản TestFlight chỉ dùng được **90 ngày**.

App đã có sẵn: giữ đăng nhập (cookie 30 ngày của web), kéo xuống để tải lại, vuốt từ mép trái để quay lại, tự tải lại khi mở lại app sau hơn 10 phút, link ngoài mở bằng Safari, hiện `alert`/`confirm` của web, tải file (CSV, ảnh QR) ra bảng chia sẻ, màn hình "Thử lại" khi mất mạng.

## Thông báo đẩy (đơn OMS mới)

Web push không chạy trong WKWebView nên app dùng push native (APNs). Mở trang OMS trong app → bấm 🔔 → app xin quyền, gửi token lên `/oms/api/push/apns-register` (bảng `oms_apns_tokens`). Máy chủ gửi qua `apns.js` cùng lúc với web push (`sendPushToAll` trong `oms.js`). Bấm vào thông báo → mở `/go-oms`. Trong Cài đặt iOS chỉ hiện mục **Thông báo** sau khi app đã xin quyền lần đầu (bấm 🔔). Kiểm tra: `/oms/api/push/debug` (`apns_count`, `apns_config_error`), nút test push của OMS gửi cả tới app.

Cài đặt một lần:
1. developer.apple.com → Identifiers → `com.tdmjsc.ads` → bật **Push Notifications** → Save.
2. Hồ sơ ký cũ không có quyền push: Codemagic → Code signing identities → iOS provisioning profiles → xoá profile App Store cũ của `com.tdmjsc.ads` (và xoá trên developer.apple.com → Profiles) rồi **Fetch profiles** / để build tự tạo mới. Build báo lỗi `aps-environment` là do còn profile cũ.
3. developer.apple.com → **Keys** → + → tick **Apple Push Notifications service (APNs)** → tải file `.p8` (chỉ tải được 1 lần), ghi Key ID. Team ID ở Membership.
4. `.env` trên máy chủ: `APNS_KEY_ID=…`, `APNS_TEAM_ID=…`, và `APNS_KEY_FILE=/home/…/AuthKey_XXXX.p8` (hoặc `APNS_KEY` = nội dung file, xuống dòng viết `\n`). Khởi động lại Node.
5. Build mới (push `ios/` lên `main`), cài bản mới từ TestFlight, mở OMS → 🔔.

## Build và tải lên bằng Codemagic

Build chạy trên máy Mac của Codemagic (Xcode mới nhất), cấu hình ở `codemagic.yaml` (gốc repo), workflow **iOS → TestFlight**. Máy mình không cần Xcode 26.

### Cài đặt lần đầu

1. **Bundle ID:** developer.apple.com → Certificates, IDs & Profiles → Identifiers → + → App IDs → App → Bundle ID `com.tdmjsc.ads` (Explicit), bật capability **Push Notifications**.
2. **Tạo app trên App Store Connect** (appstoreconnect.apple.com → Apps → + → New App): iOS, Name `TDM Ads` (trùng thì đặt `TDM Ads Nội bộ`), Bundle ID `com.tdmjsc.ads`, SKU `tdm-ads`. Ghi lại **Apple ID** dạng số (App Information) → điền vào `APP_STORE_APPLE_ID` trong `codemagic.yaml` (không bắt buộc, dùng để số build luôn lớn hơn bản trên TestFlight).
3. **API key:** App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → + , quyền **App Manager**. Tải file `.p8` (chỉ tải được 1 lần), ghi lại Issuer ID và Key ID.
4. **Codemagic** (codemagic.io, đăng nhập bằng GitHub):
   - Add application → chọn repo này → loại **codemagic.yaml**.
   - Team settings → **Integrations → Developer Portal → Connect**: tên key phải trùng với `integrations.app_store_connect` trong `codemagic.yaml` (hiện là **`Wecoway ASC`**, key 2FC2ZW5DXL), nhập Issuer ID, Key ID, file `.p8`.
   - Team settings → **Code signing identities**:
     - tab iOS certificates → **Generate certificate** (loại Apple Distribution, dùng key `Wecoway ASC`). Lưu lại file/mật khẩu nếu nó cho tải.
     - tab iOS provisioning profiles → **Fetch profiles** (hoặc để Codemagic tự tạo khi build) loại App Store cho `com.tdmjsc.ads`.
5. Trong app trên Codemagic → **Start new build** → nhánh `main`, workflow **iOS → TestFlight**. Xong (~10 phút) thì App Store Connect cần thêm 5–30 phút xử lý.

### Khi nào build lại

- Push lên `main` có sửa `ios/` hoặc `codemagic.yaml` → Codemagic tự build và tải lên.
- Sửa web thì **không** build (app tự lấy web mới).
- Bản build TestFlight hết hạn sau 90 ngày → khoảng 80 ngày một lần vào Codemagic bấm **Start new build**. Số build tự tăng.

## Mời nhân viên

- Mỗi người phải là thành viên team App Store Connect (**Users and Access** → +, quyền tối thiểu như *Marketing* hoặc *Customer Support*), dùng Apple ID của họ. Tối đa 100 người.
- **TestFlight → Internal Testing → +** tạo nhóm (vd `Nhân viên`), thêm người, bật **Automatic Distribution** để bản build mới tự đến tay mọi người.
- Nhân viên cài app **TestFlight** từ App Store → mở email mời → **Accept** → **Install**. Trong TestFlight bật **Automatic Updates**.

## Build bằng Xcode trên máy (dự phòng)

Từ 4/2026 App Store Connect chỉ nhận bản build bằng Xcode 26 (cần macOS 15.6+). Có máy đủ đời thì: `open ios/TDMAds.xcodeproj` → Signing & Capabilities chọn Team → Any iOS Device → Product → Archive → Distribute App → TestFlight Internal Only. Nhớ tăng Build lớn hơn bản đã tải lên.

## Build thử trên simulator (không cần tài khoản)

```bash
cd ios && xcodebuild -project TDMAds.xcodeproj -scheme TDMAds -sdk iphonesimulator -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual build
```

Phải ký ad-hoc (`CODE_SIGN_IDENTITY=-`). Bản không ký thì WebKit không chạy, chỉ ra màn hình trống.
