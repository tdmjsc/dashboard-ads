# App Android "TDM Ads"

Khung WebView mở `https://ads.tdmjsc.com` (giống app iOS). Sửa web thì không cần build lại.

Đã có: giữ đăng nhập, kéo xuống để tải lại, nút Back quay lại trang trước, tự tải lại khi mở app sau hơn 10 phút, link ngoài mở bằng trình duyệt, alert/confirm/prompt, chọn file tải lên, tải file (cả blob/data) ra bảng chia sẻ, màn hình "Thử lại" khi mất mạng.
Chưa có: thông báo đẩy (WebView Android không có web push; muốn có phải thêm Firebase FCM).

## Build

```bash
cd android && JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home ./gradlew assembleRelease
```

APK: `android/app/build/outputs/apk/release/app-release.apk`. Bản mới phải tăng `versionCode` trong `app/build.gradle`.

Khoá ký `tdm-release.jks` + `keystore.properties` không có trên git. **Phải sao lưu.** Mất khoá thì bản sau không cài đè được, mọi người phải gỡ app rồi cài lại.
