// =====================================================================
//  Gửi thông báo đẩy tới app iOS "TDM Ads" qua APNs (Apple Push Notification service).
//  App là WKWebView nên không dùng được web push; app gửi device token về
//  /oms/api/push/apns-register (oms.js), máy chủ gửi qua APNs cùng lúc với web push.
//
//  .env:
//    APNS_KEY_ID   Key ID của khoá APNs (developer.apple.com → Keys, bật "Apple Push Notifications service")
//    APNS_KEY_P8   nội dung file AuthKey_XXXX.p8 (xuống dòng ghi là \n), hoặc
//    APNS_KEY_FILE đường dẫn tới file .p8 trên máy chủ
//    APNS_TEAM_ID  (mặc định GH2VW96CHH)   APNS_TOPIC (mặc định com.tdmjsc.ads = bundle id)
//    APNS_SANDBOX=1 chỉ khi build cài thẳng từ Xcode (TestFlight / App Store dùng máy chủ production)
//  Thiếu khoá thì bỏ qua APNs (web push vẫn chạy).
// =====================================================================
import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';

const TEAM_ID = () => process.env.APNS_TEAM_ID || 'GH2VW96CHH';
const TOPIC = () => process.env.APNS_TOPIC || 'com.tdmjsc.ads';
const HOST = () => (process.env.APNS_SANDBOX === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');

function readKey() {
  if (process.env.APNS_KEY_P8) return process.env.APNS_KEY_P8.replace(/\\n/g, '\n');
  if (process.env.APNS_KEY_FILE) {
    try { return fs.readFileSync(process.env.APNS_KEY_FILE, 'utf8'); } catch (e) { return ''; }
  }
  return '';
}

export function apnsConfigured() {
  return !!(process.env.APNS_KEY_ID && readKey());
}

// JWT ES256, Apple cho dùng tối đa 1 giờ và không muốn tạo mới quá 20 phút / lần → giữ 40 phút.
let jwtCache = { token: '', at: 0 };
function providerToken() {
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache.token && now - jwtCache.at < 40 * 60) return jwtCache.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'ES256', kid: process.env.APNS_KEY_ID }) + '.' + b64({ iss: TEAM_ID(), iat: now });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: readKey(), dsaEncoding: 'ieee-p1363' });
  jwtCache = { token: unsigned + '.' + sig.toString('base64url'), at: now };
  return jwtCache.token;
}

function sendOne(session, token, body) {
  return new Promise((resolve) => {
    const req = session.request({
      ':method': 'POST',
      ':path': '/3/device/' + token,
      authorization: 'bearer ' + providerToken(),
      'apns-topic': TOPIC(),
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400),
      'content-type': 'application/json',
    });
    let status = 0, data = '';
    req.setTimeout(15000, () => { req.close(); resolve({ token, ok: false, status: 0, reason: 'timeout' }); });
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let reason = '';
      try { reason = data ? JSON.parse(data).reason : ''; } catch (e) { reason = data; }
      resolve({ token, ok: status === 200, status, reason });
    });
    req.on('error', (e) => resolve({ token, ok: false, status: 0, reason: e.message }));
    req.end(body);
  });
}

// Trả về kết quả từng token. `dead: true` = token không còn dùng được (gỡ app / tắt) → nên xoá.
export async function sendApns(tokens, title, body) {
  if (!tokens.length) return [];
  if (!apnsConfigured()) return tokens.map((token) => ({ token, ok: false, status: 0, reason: 'APNs chưa cấu hình (APNS_KEY_ID / APNS_KEY_P8)' }));
  const payload = JSON.stringify({ aps: { alert: { title, body }, sound: 'default' } });
  let session;
  try {
    session = http2.connect(HOST());
    session.on('error', () => {});
    const results = [];
    for (const t of tokens) results.push(await sendOne(session, t, payload));
    for (const r of results) {
      r.dead = r.status === 410 || (r.status === 400 && (r.reason === 'BadDeviceToken' || r.reason === 'DeviceTokenNotForTopic'));
    }
    return results;
  } catch (e) {
    return tokens.map((token) => ({ token, ok: false, status: 0, reason: e.message }));
  } finally {
    try { session && session.close(); } catch (e) {}
  }
}
