// =====================================================================
//  Gửi thông báo đẩy tới app Android "TDM Ads" qua Firebase Cloud Messaging (HTTP v1).
//  WebView Android không có web push; app lấy FCM token rồi gửi về /oms/api/push/fcm-register
//  (oms.js), máy chủ gửi qua FCM cùng lúc với web push / APNs. Không cần thư viện ngoài.
//
//  .env (khoá tài khoản dịch vụ: Firebase console → Project settings → Service accounts →
//  Generate new private key):
//    FCM_SERVICE_ACCOUNT       nội dung file JSON (1 dòng), hoặc
//    FCM_SERVICE_ACCOUNT_FILE  đường dẫn tới file JSON trên máy chủ
//  Thiếu khoá thì bỏ qua FCM (web push / APNs vẫn chạy).
// =====================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';

function readAccount() {
  try {
    if (process.env.FCM_SERVICE_ACCOUNT) return JSON.parse(process.env.FCM_SERVICE_ACCOUNT);
    if (process.env.FCM_SERVICE_ACCOUNT_FILE) return JSON.parse(fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8'));
  } catch (e) {
    console.error('[FCM] Khoá tài khoản dịch vụ lỗi:', e.message);
  }
  return null;
}

export function fcmConfigured() {
  const a = readAccount();
  return !!(a && a.project_id && a.client_email && a.private_key);
}

// Access token OAuth2 (hạn 1 giờ) đổi từ JWT ký bằng khoá tài khoản dịch vụ → giữ 50 phút.
let tokenCache = { token: '', exp: 0 };
async function accessToken(acc) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && now < tokenCache.exp) return tokenCache.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: acc.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), acc.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Lấy access token Google lỗi: ' + (d.error_description || d.error || r.status));
  tokenCache = { token: d.access_token, exp: now + 50 * 60 };
  return tokenCache.token;
}

// Trả về kết quả từng token. `dead: true` = token không còn dùng được (gỡ app...) → nên xoá.
export async function sendFcm(tokens, title, body) {
  if (!tokens.length) return [];
  const acc = readAccount();
  if (!fcmConfigured()) return tokens.map((token) => ({ token, ok: false, status: 0, reason: 'FCM chưa cấu hình (FCM_SERVICE_ACCOUNT)' }));
  let bearer;
  try { bearer = await accessToken(acc); }
  catch (e) { return tokens.map((token) => ({ token, ok: false, status: 0, reason: e.message })); }
  const url = `https://fcm.googleapis.com/v1/projects/${acc.project_id}/messages:send`;
  const results = [];
  for (const token of tokens) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            android: {
              priority: 'HIGH',
              ttl: '86400s',
              // channel "orders" do app tạo (PushService.java)
              notification: { channel_id: 'orders', sound: 'default', default_vibrate_timings: true },
            },
          },
        }),
      });
      const d = await r.json().catch(() => ({}));
      const code = d.error?.details?.find((x) => x.errorCode)?.errorCode || d.error?.status || '';
      results.push({
        token, ok: r.ok, status: r.status, reason: r.ok ? '' : (code + ' ' + (d.error?.message || '')).trim(),
        dead: r.status === 404 || code === 'UNREGISTERED' || (r.status === 400 && code === 'INVALID_ARGUMENT' && /token/i.test(d.error?.message || '')),
      });
    } catch (e) {
      results.push({ token, ok: false, status: 0, reason: e.message });
    }
  }
  return results;
}
