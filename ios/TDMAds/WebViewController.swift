import UIKit
import UserNotifications
@preconcurrency import WebKit

// App chỉ là khung mở ads.tdmjsc.com: mọi chức năng nằm trên web, deploy web là app có bản mới.
// Chỉ phải tải bản mới lên TestFlight khi sửa file trong thư mục ios/ (hoặc bản build hết hạn 90 ngày).
final class WebViewController: UIViewController {
    static let startURL = URL(string: "https://ads.tdmjsc.com/")!
    static let appHost = "ads.tdmjsc.com"
    // Mở lại app sau khoảng này (giây) thì tải lại trang để lấy bản web mới nhất.
    // Không tải lại khi chỉ chuyển app nhanh, để khỏi mất dữ liệu đang nhập dở.
    static let reloadAfterBackground: TimeInterval = 10 * 60

    private var webView: WKWebView!
    private let refresh = UIRefreshControl()
    private let errorView = UIStackView()
    private var backgroundedAt: Date?
    private var pushToken: String?
    private var pushRequestedByUser = false

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(named: "LaunchBackground")

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // giữ cookie đăng nhập giữa các lần mở app
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "TDMAdsApp/1.0 Mobile/15E148 Safari/604.1"
        // Nút 🔔 của web gọi window.webkit.messageHandlers.tdmPush.postMessage('enable') (WKWebView không có Web Push).
        config.userContentController.add(PushMessageProxy(self), name: "tdmPush")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.backgroundColor = view.backgroundColor
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        refresh.tintColor = .white
        refresh.addTarget(self, action: #selector(pullToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        setupErrorView()

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)

        webView.load(URLRequest(url: Self.startURL))
    }

    // MARK: - Tải lại

    @objc private func pullToRefresh() {
        if webView.url == nil { webView.load(URLRequest(url: Self.startURL)) } else { webView.reload() }
    }

    @objc private func didEnterBackground() { backgroundedAt = Date() }

    @objc private func willEnterForeground() {
        guard let t = backgroundedAt else { return }
        backgroundedAt = nil
        if Date().timeIntervalSince(t) >= Self.reloadAfterBackground || !errorView.isHidden {
            pullToRefresh()
        }
    }

    // MARK: - Thông báo đẩy (APNs)

    fileprivate func enablePushFromWeb() {
        pushRequestedByUser = true
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { s in
            DispatchQueue.main.async {
                if s.authorizationStatus == .denied { return self.askOpenSettings() }
                center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                    DispatchQueue.main.async {
                        if granted { UIApplication.shared.registerForRemoteNotifications() } else { self.askOpenSettings() }
                    }
                }
            }
        }
    }

    private func askOpenSettings() {
        pushRequestedByUser = false
        let a = UIAlertController(title: "Thông báo đang tắt",
                                  message: "Vào Cài đặt → TDM Ads → Thông báo → bật Cho phép thông báo.",
                                  preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Để sau", style: .cancel))
        a.addAction(UIAlertAction(title: "Mở Cài đặt", style: .default) { _ in
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        })
        present(a, animated: true)
    }

    func didReceivePushToken(_ token: String) {
        pushToken = token
        sendPushTokenToServer()
    }

    func didFailPushRegistration(_ error: Error) {
        guard pushRequestedByUser else { return }
        pushRequestedByUser = false
        alert("Không đăng ký được thông báo: \(error.localizedDescription)")
    }

    // Gửi token kèm cookie đăng nhập của trang (gọi fetch trong web). Gọi lại mỗi lần tải trang
    // để token gắn đúng tài khoản đang đăng nhập; chỉ báo kết quả khi người dùng vừa bấm 🔔.
    private func sendPushTokenToServer() {
        guard isViewLoaded, let token = pushToken, let url = webView.url, isAppURL(url) else { return }
        let announce = pushRequestedByUser
        pushRequestedByUser = false
        let js = """
        fetch('/oms/api/push/apns-register', {method: 'POST', credentials: 'include',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: '\(token)'})})
          .then(r => r.json().then(d => ({ok: r.ok, d})))
          .then(({ok, d}) => {
            if (!\(announce)) return;
            if (!ok) alert('⚠️ Chưa bật được thông báo: ' + (d.error || 'lỗi máy chủ'));
            else if (d.config_error) alert('⚠️ Máy đã đăng ký, nhưng máy chủ chưa cấu hình gửi thông báo: ' + d.config_error);
            else alert('✅ Đã bật thông báo trên máy này');
          })
          .catch(e => { if (\(announce)) alert('⚠️ Chưa bật được thông báo: ' + e.message); });
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func openFromNotification(_ path: String) {
        guard let url = URL(string: path, relativeTo: Self.startURL)?.absoluteURL, isAppURL(url) else { return }
        webView.load(URLRequest(url: url))
    }

    // MARK: - Màn hình mất mạng

    private func setupErrorView() {
        let label = UILabel()
        label.text = "Không kết nối được máy chủ.\nKiểm tra mạng rồi thử lại."
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .white
        let button = UIButton(type: .system)
        button.setTitle("Thử lại", for: .normal)
        button.titleLabel?.font = .boldSystemFont(ofSize: 17)
        button.addTarget(self, action: #selector(retry), for: .touchUpInside)

        errorView.axis = .vertical
        errorView.spacing = 16
        errorView.alignment = .center
        errorView.addArrangedSubview(label)
        errorView.addArrangedSubview(button)
        errorView.isHidden = true
        errorView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(errorView)
        NSLayoutConstraint.activate([
            errorView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            errorView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            errorView.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        ])
    }

    @objc private func retry() {
        errorView.isHidden = true
        webView.isHidden = false
        pullToRefresh()
    }

    private func showError(_ error: Error) {
        let code = (error as NSError).code
        if code == NSURLErrorCancelled || code == 102 /* WebKit: frame load interrupted (tải file) */ { return }
        webView.isHidden = true
        errorView.isHidden = false
    }

    // MARK: - Mở link

    private func isAppURL(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host == Self.appHost || host.hasSuffix("." + Self.appHost)
    }

    private func openExternally(_ url: URL) {
        UIApplication.shared.open(url)
    }

    // MARK: - Tải file → bảng chia sẻ (lưu vào Tệp, gửi Zalo...)

    private var downloadDestinations: [ObjectIdentifier: URL] = [:]

    private func share(fileAt url: URL) {
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = view
        vc.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        present(vc, animated: true)
    }
}

extension WebViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            return decisionHandler(.allow)
        }
        if ["about", "blob", "data"].contains(scheme) { return decisionHandler(.allow) }
        if scheme == "http" || scheme == "https" {
            // Trang ngoài (bài quảng cáo, link ngân hàng...) mở bằng Safari, chỉ khi người dùng bấm vào.
            if !isAppURL(url) && navigationAction.navigationType == .linkActivated && navigationAction.targetFrame?.isMainFrame != false {
                openExternally(url)
                return decisionHandler(.cancel)
            }
            return decisionHandler(.allow)
        }
        // tel:, mailto:, zalo:, sms:...
        openExternally(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
           disposition.lowercased().hasPrefix("attachment") {
            return decisionHandler(.download)
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        refresh.endRefreshing()
        sendPushTokenToServer()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        refresh.endRefreshing()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        refresh.endRefreshing()
        showError(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

extension WebViewController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(suggestedFilename.isEmpty ? "tai-ve" : suggestedFilename)
        downloadDestinations[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let dest = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        share(fileAt: dest)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        alert("Tải file không được: \(error.localizedDescription)")
    }

    fileprivate func alert(_ message: String) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        present(a, animated: true)
    }
}

// alert / confirm / prompt của trang web: WKWebView bỏ qua nếu app không tự hiện.
extension WebViewController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target="_blank" / window.open: trang của app mở ngay trong app, trang ngoài mở Safari.
        if let url = navigationAction.request.url {
            if isAppURL(url) || navigationAction.shouldPerformDownload || url.scheme == "blob" {
                webView.load(navigationAction.request)
            } else {
                openExternally(url)
            }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Huỷ", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Huỷ", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        present(a, animated: true)
    }
}

// WKUserContentController giữ handler bằng tham chiếu mạnh → dùng proxy weak để tránh giữ WebViewController mãi.
private final class PushMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: WebViewController?
    init(_ target: WebViewController) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let host = message.frameInfo.request.url?.host?.lowercased(),
              host == WebViewController.appHost || host.hasSuffix("." + WebViewController.appHost) else { return }
        if message.body as? String == "enable" { target?.enablePushFromWeb() }
    }
}
