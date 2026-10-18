import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private let webVC = WebViewController()

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // Đã cho phép từ trước → lấy lại token (token có thể đổi sau khi cài lại / khôi phục máy).
        UNUserNotificationCenter.current().getNotificationSettings { s in
            if s.authorizationStatus == .authorized {
                DispatchQueue.main.async { application.registerForRemoteNotifications() }
            }
        }

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = webVC
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        webVC.didReceivePushToken(deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        webVC.didFailPushRegistration(error)
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    // Đang mở app vẫn hiện thông báo.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // Bấm vào thông báo → mở trang trong payload ("url", vd /go-oms).
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let path = response.notification.request.content.userInfo["url"] as? String {
            webVC.openFromNotification(path)
        }
        completionHandler()
    }
}
