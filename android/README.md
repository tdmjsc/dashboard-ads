# App Android "TDM Ads"

Khung WebView mở `https://ads.tdmjsc.com` (giống app iOS). Sửa web thì không cần build lại.

Đã có: giữ đăng nhập, kéo xuống để tải lại, nút Back quay lại trang trước, tự tải lại khi mở app sau hơn 10 phút, link ngoài mở bằng trình duyệt, alert/confirm/prompt, chọn file tải lên, tải file (cả blob/data) ra bảng chia sẻ, màn hình "Thử lại" khi mất mạng.
## Thông báo đẩy (Firebase Cloud Messaging)

WebView Android không có web push, nên app dùng FCM (giống APNs bên iOS). Trên trang OMS admin bấm 🔔 → app xin quyền thông báo, lấy FCM token, gửi về `/oms/api/push/fcm-register` (bảng `oms_fcm_tokens`). Máy chủ gửi qua FCM (`fcm.js`) mỗi lần gửi web push. Xem tình trạng: `/oms/api/push/debug` (`fcm_configured`, `fcm_devices`); gửi thử: nút test push trên OMS.

Cài đặt lần đầu (console.firebase.google.com):
1. Tạo project (vd `tdm-ads`), không cần Google Analytics.
2. Thêm app **Android**, package `com.tdmjsc.ads` → tải `google-services.json` → đặt vào `android/app/google-services.json` → build lại APK. Không có file này app vẫn build nhưng bấm 🔔 sẽ báo chưa cài Firebase.
3. Project settings → **Service accounts** → **Generate new private key** → file JSON. Đưa lên máy chủ: dán nội dung (1 dòng) vào `.env` là `FCM_SERVICE_ACCOUNT=...`, hoặc để file trên máy chủ và ghi `FCM_SERVICE_ACCOUNT_FILE=/đường/dẫn.json`. Khởi động lại Node. File này là khoá bí mật, không đưa lên git.

## Build

```bash
cd android && JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home ./gradlew assembleRelease
```

APK: `android/app/build/outputs/apk/release/app-release.apk`. Bản mới phải tăng `versionCode` trong `app/build.gradle`.

Khoá ký `tdm-release.jks` + `keystore.properties` không có trên git. **Phải sao lưu.** Mất khoá thì bản sau không cài đè được, mọi người phải gỡ app rồi cài lại.
