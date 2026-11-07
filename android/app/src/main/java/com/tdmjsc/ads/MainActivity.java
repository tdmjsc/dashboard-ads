package com.tdmjsc.ads;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// App chỉ là khung mở ads.tdmjsc.com (giống app iOS): mọi chức năng nằm trên web,
// deploy web là app có bản mới. Chỉ phải build APK mới khi sửa thư mục android/.
public class MainActivity extends Activity {
    static final String START_URL = "https://ads.tdmjsc.com/";
    static final String APP_HOST = "ads.tdmjsc.com";
    // Mở lại app sau khoảng này thì tải lại trang để lấy bản web mới nhất.
    static final long RELOAD_AFTER_BG_MS = 10 * 60 * 1000;
    static final int REQ_FILE = 1;
    static final int BG = Color.rgb(0x0B, 0x13, 0x22);

    WebView web;
    SwipeRefreshLayout swipe;
    LinearLayout errorView;
    long backgroundedAt = 0;
    ValueCallback<Uri[]> fileCallback;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        web = new WebView(this);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(s.getUserAgentString() + " TDMAdsApp/1.0 Android");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.addJavascriptInterface(new Bridge(), "TDMAndroid");

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, ua, disposition, mime, len) -> download(url, ua, disposition, mime));

        swipe = new SwipeRefreshLayout(this);
        swipe.addView(web);
        swipe.setOnRefreshListener(this::reload);
        // Chỉ kéo-để-tải-lại khi trang đang ở đầu (tránh tranh với bảng cuộn bên trong).
        swipe.setOnChildScrollUpCallback((parent, child) -> web.getScrollY() > 0);
        root.addView(swipe, new FrameLayout.LayoutParams(-1, -1));

        errorView = buildErrorView();
        root.addView(errorView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(START_URL);
    }

    LinearLayout buildErrorView() {
        LinearLayout v = new LinearLayout(this);
        v.setOrientation(LinearLayout.VERTICAL);
        v.setGravity(Gravity.CENTER);
        v.setBackgroundColor(BG);
        TextView t = new TextView(this);
        t.setText("Không kết nối được máy chủ.\nKiểm tra mạng rồi thử lại.");
        t.setTextColor(Color.WHITE);
        t.setGravity(Gravity.CENTER);
        t.setTextSize(16);
        Button b = new Button(this);
        b.setText("Thử lại");
        b.setOnClickListener(x -> { v.setVisibility(View.GONE); reload(); });
        v.addView(t);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = 40;
        v.addView(b, lp);
        v.setVisibility(View.GONE);
        return v;
    }

    void reload() {
        if (web.getUrl() == null) web.loadUrl(START_URL); else web.reload();
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override protected void onPause() {
        super.onPause();
        backgroundedAt = SystemClock.elapsedRealtime();
        CookieManager.getInstance().flush(); // giữ đăng nhập khi app bị tắt
    }

    @Override protected void onResume() {
        super.onResume();
        if (backgroundedAt > 0 && (SystemClock.elapsedRealtime() - backgroundedAt >= RELOAD_AFTER_BG_MS
                || errorView.getVisibility() == View.VISIBLE)) {
            errorView.setVisibility(View.GONE);
            reload();
        }
        backgroundedAt = 0;
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    static boolean isAppUrl(Uri u) {
        String h = u.getHost();
        if (h == null) return false;
        h = h.toLowerCase();
        return h.equals(APP_HOST) || h.endsWith("." + APP_HOST);
    }

    void openExternally(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Không có ứng dụng mở được link này", Toast.LENGTH_SHORT).show();
        }
    }

    class Client extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            Uri u = r.getUrl();
            String sc = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            if (sc.equals("about") || sc.equals("blob") || sc.equals("data")) return false;
            if (sc.equals("http") || sc.equals("https")) {
                // Trang ngoài mở bằng trình duyệt, chỉ khi người dùng bấm link.
                if (!isAppUrl(u) && r.isForMainFrame() && r.hasGesture()) { openExternally(u); return true; }
                return false;
            }
            if (sc.equals("intent")) {
                try {
                    Intent i = Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME);
                    startActivity(i);
                } catch (Exception e) {
                    // bỏ qua
                }
                return true;
            }
            openExternally(u); // tel:, mailto:, zalo:, sms:...
            return true;
        }

        @Override public void onPageStarted(WebView v, String url, Bitmap f) { errorView.setVisibility(View.GONE); }

        @Override public void onPageFinished(WebView v, String url) {
            swipe.setRefreshing(false);
            CookieManager.getInstance().flush();
        }

        @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (!r.isForMainFrame()) return;
            swipe.setRefreshing(false);
            errorView.setVisibility(View.VISIBLE);
        }

        @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
            recreate();
            return true;
        }
    }

    class Chrome extends WebChromeClient {
        @Override public boolean onCreateWindow(WebView v, boolean dialog, boolean gesture, android.os.Message msg) {
            // target="_blank" / window.open: trang của app mở trong app, trang ngoài mở trình duyệt.
            WebView tmp = new WebView(MainActivity.this);
            tmp.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView w, WebResourceRequest r) {
                    Uri u = r.getUrl();
                    if (isAppUrl(u) || "blob".equals(u.getScheme())) web.loadUrl(u.toString());
                    else openExternally(u);
                    w.destroy();
                    return true;
                }
            });
            ((WebView.WebViewTransport) msg.obj).setWebView(tmp);
            msg.sendToTarget();
            return true;
        }

        @Override public boolean onJsAlert(WebView v, String url, String m, JsResult r) {
            new AlertDialog.Builder(MainActivity.this).setMessage(m)
                    .setPositiveButton("OK", (d, w) -> r.confirm())
                    .setOnCancelListener(d -> r.confirm()).show();
            return true;
        }

        @Override public boolean onJsConfirm(WebView v, String url, String m, JsResult r) {
            new AlertDialog.Builder(MainActivity.this).setMessage(m)
                    .setNegativeButton("Huỷ", (d, w) -> r.cancel())
                    .setPositiveButton("OK", (d, w) -> r.confirm())
                    .setOnCancelListener(d -> r.cancel()).show();
            return true;
        }

        @Override public boolean onJsPrompt(WebView v, String url, String m, String def, JsPromptResult r) {
            EditText in = new EditText(MainActivity.this);
            in.setText(def);
            new AlertDialog.Builder(MainActivity.this).setMessage(m).setView(in)
                    .setNegativeButton("Huỷ", (d, w) -> r.cancel())
                    .setPositiveButton("OK", (d, w) -> r.confirm(in.getText().toString()))
                    .setOnCancelListener(d -> r.cancel()).show();
            return true;
        }

        @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            try {
                startActivityForResult(p.createIntent(), REQ_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE && fileCallback != null) {
            Uri[] r = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    r = new Uri[n];
                    for (int i = 0; i < n; i++) r[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    r = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(r);
            fileCallback = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    // ---- Tải file → bảng chia sẻ (lưu vào Tệp, gửi Zalo...) ----

    void download(String url, String ua, String disposition, String mime) {
        String name = URLUtil.guessFileName(url, disposition, mime);
        if (url.startsWith("blob:")) {
            // blob chỉ đọc được trong trang: đọc ra base64 rồi gửi qua cầu nối.
            String js = "(function(){var x=new XMLHttpRequest();x.open('GET','" + url + "');x.responseType='blob';"
                    + "x.onload=function(){var r=new FileReader();r.onloadend=function(){"
                    + "var a=document.querySelector('a[href=\"" + url + "\"]');"
                    + "TDMAndroid.saveBase64(r.result,(a&&a.download)||'');};r.readAsDataURL(x.response);};x.send();})();";
            web.evaluateJavascript(js, null);
            return;
        }
        if (url.startsWith("data:")) { saveDataUrl(url, name); return; }
        Toast.makeText(this, "Đang tải " + name + "…", Toast.LENGTH_SHORT).show();
        String cookie = CookieManager.getInstance().getCookie(url);
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                if (cookie != null) c.setRequestProperty("Cookie", cookie);
                c.setRequestProperty("User-Agent", ua);
                File f = newCacheFile(name);
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(f)) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                String type = c.getContentType() != null ? c.getContentType().split(";")[0] : mime;
                runOnUiThread(() -> share(f, type));
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "Tải file không được: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    File newCacheFile(String name) {
        File dir = new File(getCacheDir(), "downloads/" + System.currentTimeMillis());
        dir.mkdirs();
        if (name == null || name.isEmpty()) name = "tai-ve";
        return new File(dir, name.replaceAll("[/\\\\]", "_"));
    }

    void saveDataUrl(String dataUrl, String name) {
        try {
            int comma = dataUrl.indexOf(',');
            String meta = dataUrl.substring(5, comma);
            String mime = meta.split(";")[0];
            byte[] bytes = meta.contains("base64")
                    ? Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
                    : Uri.decode(dataUrl.substring(comma + 1)).getBytes("UTF-8");
            if (name == null || name.isEmpty() || name.equals("downloadfile.bin")) {
                String ext = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
                name = "tai-ve" + (ext != null ? "." + ext : "");
            }
            File f = newCacheFile(name);
            try (OutputStream out = new FileOutputStream(f)) { out.write(bytes); }
            share(f, mime);
        } catch (Exception e) {
            Toast.makeText(this, "Tải file không được: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    void share(File f, String mime) {
        Uri u = FileProvider.getUriForFile(this, "com.tdmjsc.ads.files", f);
        Intent i = new Intent(Intent.ACTION_SEND);
        i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
        i.putExtra(Intent.EXTRA_STREAM, u);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(Intent.createChooser(i, f.getName()));
    }

    class Bridge {
        @JavascriptInterface public void saveBase64(String dataUrl, String name) {
            runOnUiThread(() -> saveDataUrl(dataUrl, name));
        }
    }
}
