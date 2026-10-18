// Gửi thông báo đẩy tới app iOS "TDM Ads" qua APNs (HTTP/2 + JWT ES256, không cần thư viện ngoài).
// Cấu hình trong .env:
//   APNS_KEY_ID    Key ID của khoá APNs (.p8) — developer.apple.com → Keys
//   APNS_TEAM_ID   Team ID (Membership)
//   APNS_KEY       nội dung file .p8 (xuống dòng viết \n) — hoặc APNS_KEY_FILE = đường dẫn file .p8
//   APNS_TOPIC     bundle ID, mặc định com.tdmjsc.ads
//   APNS_SANDBOX=1 chỉ khi chạy app build từ Xcode (bản debug). TestFlight dùng máy chủ thật.
import http2 from 'http2';
import crypto from 'crypto';
import fs from 'fs';

const TOPIC = process.env.APNS_TOPIC || 'com.tdmjsc.ads';
const HOST = process.env.APNS_SANDBOX === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';

function loadKey() {
  if (process.env.APNS_KEY) return process.env.APNS_KEY.replace(/\\n/g, '\n');
  if (process.env.APNS_KEY_FILE) { try { return fs.readFileSync(process.env.APNS_KEY_FILE, 'utf8'); } catch (e) {} }
  return '';
}

export function apnsConfigError() {
  if (!process.env.APNS_KEY_ID) return 'Thiếu APNS_KEY_ID trong .env';
  if (!process.env.APNS_TEAM_ID) return 'Thiếu APNS_TEAM_ID trong .env';
  if (!loadKey()) return 'Thiếu APNS_KEY (hoặc APNS_KEY_FILE) trong .env';
  return '';
}

// Apple: token dùng được 1 giờ, không được tạo mới quá 1 lần / 20 phút.
let jwtCache = { token: '', at: 0 };
function providerToken() {
  if (jwtCache.token && Date.now() - jwtCache.at < 50 * 60 * 1000) return jwtCache.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'ES256', kid: process.env.APNS_KEY_ID });
  const body = b64({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) });
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: loadKey(), dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwtCache = { token: `${head}.${body}.${sig}`, at: Date.now() };
  return jwtCache.token;
}

function sendOne(client, deviceToken, payload, ttlSec) {
  return new Promise((resolve) => {
    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + deviceToken,
      authorization: 'bearer ' + providerToken(),
      'apns-topic': TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSec),
    });
    let status = 0, data = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let reason = '';
      try { reason = JSON.parse(data).reason || ''; } catch (e) {}
      resolve({ ok: status === 200, status, reason });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, reason: e.message }));
    req.setTimeout(15000, () => { req.close(); resolve({ ok: false, status: 0, reason: 'timeout' }); });
    req.end(JSON.stringify(payload));
  });
}

// Gửi tới nhiều máy. Trả về [{ token, ok, status, reason, dead }]; dead = token không còn dùng được (xoá khỏi DB).
export async function apnsSend(tokens, { title, body, url } = {}, { ttlSec = 86400 } = {}) {
  if (!tokens.length) return [];
  const err = apnsConfigError();
  if (err) return tokens.map(token => ({ token, ok: false, status: 0, reason: err, dead: false }));
  const payload = { aps: { alert: { title, body }, sound: 'default' } };
  if (url) payload.url = url;
  const client = http2.connect(HOST);
  client.on('error', () => {});
  try {
    const out = [];
    for (const token of tokens) {
      const r = await sendOne(client, token, payload, ttlSec);
      r.token = token;
      r.dead = r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered' || r.reason === 'DeviceTokenNotForTopic';
      out.push(r);
    }
    return out;
  } finally { client.close(); }
}
