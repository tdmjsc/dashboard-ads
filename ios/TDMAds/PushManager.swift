import UIKit
import UserNotifications
@preconcurrency import WebKit

// Thông báo đẩy native (APNs). WKWebView không có web push, nên nút 🔔 trên trang OMS gọi
// window.webkit.messageHandlers.tdmPush.postMessage('enable') → app xin quyền iOS, lấy device token
// và gửi về /oms/api/push/apns-register bằng fetch ngay trong trang (có cookie phiên → máy chủ biết ai).
// Máy chủ gửi qua APNs (apns.js) mỗi khi gửi web push.
final class PushManager: NSObject, WKScriptMessageHandler {
    static let shared = PushManager()

    private let enabledKey = "pushEnabled"
    private let tokenKey = "apnsToken"
    weak var webView: WKWebView?
    weak var presenter: UIViewController?
    private var showResultOnNextSync = false
    private var lastSyncedURL: String?

    private var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }
    private var token: String? {
        get { UserDefaults.standard.string(forKey: tokenKey) }
        set { UserDefaults.standard.set(newValue, forKey: tokenKey) }
    }

    // Mở app: đã bật trước đó thì đăng ký lại (token có thể đổi sau khi cài lại / khôi phục máy).
    func appDidLaunch() {
        UNUserNotificationCenter.current().delegate = self
        guard enabled else { return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if (message.body as? String) == "enable" { enable() }
    }

    private func enable() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                guard granted else {
                    self.alert("Thông báo đang bị tắt cho TDMJSC. Bật trong Cài đặt → Thông báo → TDMJSC.", openSettings: true)
                    return
                }
                self.enabled = true
                self.showResultOnNextSync = true
                self.lastSyncedURL = nil
                UIApplication.shared.registerForRemoteNotifications()
                if self.token != nil { self.sync() }
            }
        }
    }

    func didRegister(deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
        lastSyncedURL = nil
        sync()
    }

    func didFailToRegister(_ error: Error) {
        if showResultOnNextSync {
            showResultOnNextSync = false
            alert("Không đăng ký được thông báo: \(error.localizedDescription)")
        }
    }

    // Gửi token về máy chủ. Gọi sau mỗi lần tải trang xong (trang đăng nhập chưa có phiên thì lần sau gửi lại).
    func sync() {
        guard enabled, let token = token, let webView = webView,
              let url = webView.url, url.host == WebViewController.appHost else { return }
        let page = url.absoluteString
        if page == lastSyncedURL && !showResultOnNextSync { return }
        let js = """
        const r = await fetch('/oms/api/push/apns-register', {method: 'POST', credentials: 'same-origin',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: token})});
        return r.ok ? 'ok' : ('HTTP ' + r.status);
        """
        webView.callAsyncJavaScript(js, arguments: ["token": token], in: nil, in: .page) { result in
            let ok = (try? result.get()) as? String == "ok"
            if ok { self.lastSyncedURL = page }
            if self.showResultOnNextSync {
                self.showResultOnNextSync = false
                self.alert(ok ? "✅ Đã bật thông báo trên máy này." : "⚠️ Chưa gửi được đăng ký thông báo lên máy chủ. Kéo xuống tải lại trang rồi thử lại.")
            }
        }
    }

    private func alert(_ message: String, openSettings: Bool = false) {
        guard let vc = presenter else { return }
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        if openSettings, let url = URL(string: UIApplication.openSettingsURLString) {
            a.addAction(UIAlertAction(title: "Mở Cài đặt", style: .default) { _ in UIApplication.shared.open(url) })
        }
        a.addAction(UIAlertAction(title: "OK", style: .cancel))
        vc.present(a, animated: true)
    }
}

extension PushManager: UNUserNotificationCenterDelegate {
    // Đang mở app vẫn hiện thông báo
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}
