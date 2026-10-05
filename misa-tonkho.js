// misa-tonkho.js — Lấy TỒN KHO từ MISA AMIS Hộ kinh doanh (báo cáo "Tổng hợp tồn kho")
//
// MISA bản Hộ kinh doanh KHÔNG có Open API, nên file này gọi lại đúng request
// nội bộ mà trang báo cáo của MISA đang dùng:
//   POST https://amisapp.misa.vn/hkd/g1/api/report/v1/report/dynamic/v2/paging_filter
// Request đó cần các header sinh ra từ PHIÊN ĐĂNG NHẬP MISA (Authorization,
// X-MISA-Context, X-Device). Admin tự chép request từ trình duyệt ("Copy as cURL")
// rồi dán vào trang /ton-kho.html — tonkho.js lưu lại và tự gọi theo lịch.
//
// HẠN CHẾ CẦN BIẾT:
//   • Token MISA sống khoảng 12 giờ; máy chủ tự xin token mới bằng phiên AMIS (cookie) trong
//     request đã dán (xem renewSession). Phiên AMIS hết hẳn thì admin phải dán lại request.
//   • Đây là API nội bộ, MISA đổi cấu trúc thì phải sửa file này.

const MISA_HOST = 'amisapp.misa.vn';
const MISA_PATH_END = '/report/dynamic/v2/paging_filter';
const REPORT_ID = 'INInventoryBalanceSummary';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
// Header trình duyệt tự sinh — không gửi lại từ server
const DROP_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding', 'priority']);

const b64dec = s => Buffer.from(String(s || ''), 'base64').toString('utf8');
const b64enc = s => Buffer.from(String(s), 'utf8').toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Đọc request dán vào: "Copy as cURL (bash)" hoặc "Copy as fetch" ---------- */

// Tách chuỗi lệnh shell thành các token, hiểu '...', $'...' và "..."
function shellTokens(src) {
  const out = []; let i = 0; const n = src.length;
  while (i < n) {
    while (i < n && (/\s/.test(src[i]) || (src[i] === '\\' && (src[i + 1] === '\n' || src[i + 1] === '\r')))) i++;
    if (i >= n) break;
    let tok = '';
    while (i < n && !/\s/.test(src[i])) {
      const c = src[i];
      if (c === "'") {
        const j = src.indexOf("'", i + 1);
        if (j < 0) throw new Error('thiếu dấu nháy đóng');
        tok += src.slice(i + 1, j); i = j + 1;
      } else if (c === '$' && src[i + 1] === "'") {
        i += 2;
        while (i < n && src[i] !== "'") {
          if (src[i] === '\\') {
            const e = src[i + 1];
            if (e === 'n') { tok += '\n'; i += 2; }
            else if (e === 'r') { tok += '\r'; i += 2; }
            else if (e === 't') { tok += '\t'; i += 2; }
            else if (e === 'u') { tok += String.fromCharCode(parseInt(src.substr(i + 2, 4), 16)); i += 6; }
            else if (e === 'x') { tok += String.fromCharCode(parseInt(src.substr(i + 2, 2), 16)); i += 4; }
            else { tok += e; i += 2; }
          } else tok += src[i++];
        }
        i++;
      } else if (c === '"') {
        i++;
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\' && '"\\$`'.includes(src[i + 1])) { tok += src[i + 1]; i += 2; }
          else tok += src[i++];
        }
        i++;
      } else if (c === '\\') {
        if (src[i + 1] === '\n') { i += 2; break; }
        tok += src[i + 1] || ''; i += 2;
      } else tok += src[i++];
    }
    out.push(tok);
  }
  return out;
}

function parseCurl(raw) {
  const t = shellTokens(raw);
  const req = { url: '', headers: {}, body: '' };
  for (let i = 1; i < t.length; i++) {
    const a = t[i];
    if (a === '-H' || a === '--header') {
      const h = t[++i] || ''; const k = h.indexOf(':');
      if (k > 0) req.headers[h.slice(0, k).trim().toLowerCase()] = h.slice(k + 1).trim();
    } else if (a === '-b' || a === '--cookie') req.headers.cookie = t[++i] || '';
    else if (['--data-raw', '--data', '-d', '--data-binary', '--data-ascii'].includes(a)) req.body = t[++i] || '';
    else if (a === '--url') req.url = t[++i] || '';
    else if (a === '-X' || a === '--request' || a === '-A' || a === '-e' || a === '-o') i++;
    else if (!a.startsWith('-') && !req.url) req.url = a;
  }
  return req;
}

function parseFetch(raw) {
  const m = raw.match(/fetch\(\s*("(?:[^"\\]|\\.)*")\s*,\s*(\{[\s\S]*\})\s*\)/);
  if (!m) throw new Error('không đọc được lệnh fetch');
  const opt = JSON.parse(m[2]);
  const headers = {};
  for (const [k, v] of Object.entries(opt.headers || {})) headers[k.toLowerCase()] = String(v);
  return { url: JSON.parse(m[1]), headers, body: opt.body || '' };
}

// Trả về cấu hình đã kiểm tra, hoặc ném lỗi tiếng Việt để hiện cho admin
export function parsePastedRequest(raw) {
  raw = String(raw || '').trim();
  if (!raw) throw new Error('Chưa dán nội dung.');
  let req;
  try { req = /^curl\b/i.test(raw) ? parseCurl(raw) : parseFetch(raw); }
  catch (e) { throw new Error('Không đọc được nội dung đã dán (' + e.message + '). Hãy dùng "Copy as cURL (bash)".'); }

  let u;
  try { u = new URL(req.url); } catch { throw new Error('Không tìm thấy địa chỉ request.'); }
  // Chỉ cho phép đúng API báo cáo của MISA — tránh bị lợi dụng gọi tới địa chỉ khác
  if (u.protocol !== 'https:' || u.hostname !== MISA_HOST || !u.pathname.endsWith(MISA_PATH_END))
    throw new Error('Đây không phải request "paging_filter" của báo cáo MISA. Hãy chép đúng dòng paging_filter trong tab Network.');

  let body;
  try { body = JSON.parse(req.body); } catch { throw new Error('Request thiếu phần dữ liệu gửi đi (body).'); }
  if (b64dec(body.report_id) !== REPORT_ID)
    throw new Error('Request này không phải của báo cáo "Tổng hợp tồn kho".');
  try { JSON.parse(b64dec(body.parameters)); } catch { throw new Error('Không đọc được tham số báo cáo.'); }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers))
    if (!DROP_HEADERS.has(k) && !k.startsWith(':')) headers[k] = v;
  if (!headers.authorization) throw new Error('Request thiếu header Authorization — hãy chép khi đang đăng nhập MISA.');
  headers['content-type'] = 'application/json';

  delete body.sessionId;
  return { url: u.origin + u.pathname, headers, body };
}

// Nếu Authorization là JWT thì đọc được giờ hết hạn (chỉ để hiển thị)
export function tokenExpiry(headers) {
  try {
    const parts = String(headers.authorization || '').replace(/^Bearer\s+/i, '').split('.');
    if (parts.length !== 3) return null;
    const pl = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return pl.exp ? new Date(pl.exp * 1000).toISOString() : null;
  } catch { return null; }
}

// Kỳ báo cáo = từ đầu tháng tới cuối tháng hiện tại (giờ Việt Nam, UTC+7),
// đúng định dạng MISA dùng: 00:00 giờ VN đổi sang UTC.
function currentPeriod(now = new Date()) {
  const vn = new Date(now.getTime() + 7 * 3600e3);
  const y = vn.getUTCFullYear(), m = vn.getUTCMonth();
  const from = new Date(Date.UTC(y, m, 1) - 7 * 3600e3);
  const to = new Date(Date.UTC(y, m + 1, 0) - 7 * 3600e3);
  return { from: from.toISOString(), to: to.toISOString() };
}

const num = v => Number(v) || 0;
// Cùng cấu trúc dòng tồn kho mà tonkho.js dùng (code, name, unit, stockCode, stockName, qty, amount)
function mapRow(x) {
  return {
    code: String(x.inventory_item_code || ''), name: String(x.inventory_item_name || ''),
    unit: String(x.unit_name || ''),
    stockCode: String(x.stock_code || ''), stockName: String(x.stock_name || ''),
    qty: num(x.closing_quantity), amount: num(x.closing_amount),
  };
}

class MisaError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

/* ---------- Gọi MISA ---------- */
export async function fetchInventory(cfg, fetchImpl, now = new Date()) {
  const period = currentPeriod(now);
  const baseParams = JSON.parse(b64dec(cfg.body.parameters));
  baseParams.p_from_date = period.from;
  baseParams.p_to_date = period.to;

  const call = async (params, extra) => {
    const body = { ...cfg.body, ...extra, pageSize: PAGE_SIZE, parameters: b64enc(JSON.stringify(params)) };
    let r;
    try { r = await fetchImpl(cfg.url, { method: 'POST', headers: cfg.headers, body: JSON.stringify(body), redirect: 'manual' }); }
    catch (e) { throw new MisaError('Không kết nối được tới MISA: ' + e.message, 'network'); }
    if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400))
      throw new MisaError('Phiên MISA hết hạn — cần dán lại request mới.', 'auth');
    let j;
    try { j = await r.json(); } catch { throw new MisaError('MISA trả về dữ liệu lạ (HTTP ' + r.status + ').', r.ok ? 'format' : 'http'); }
    if (!j || j.Success !== true) {
      const msg = (j && Array.isArray(j.ErrorsMessage) && j.ErrorsMessage.join('; ')) || ('mã ' + (j && j.Code));
      throw new MisaError('MISA báo lỗi: ' + msg, 'misa');
    }
    return j.Data || {};
  };

  // Bước 1: yêu cầu MISA dựng báo cáo → nhận SessionId
  const first = await call({ ...baseParams, p_is_refresh: true }, { pageIndex: 1 });
  const sessionId = first.SessionId;
  if (!sessionId) throw new MisaError('MISA không trả về mã phiên báo cáo.', 'format');

  // Bước 2: đọc từng trang
  const params = { ...baseParams, p_is_refresh: false };
  const rows = []; let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let d = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      d = await call(params, { sessionId, pageIndex: page });
      if (Array.isArray(d.PageData)) break;
      await sleep(1500); // báo cáo đang được dựng
    }
    if (!Array.isArray(d.PageData)) throw new MisaError('MISA chưa dựng xong báo cáo, thử lại sau.', 'format');
    if (page === 1) total = num(d.Total);
    rows.push(...d.PageData);
    if (!d.PageData.length || rows.length >= total) break;
  }
  return { period, total, items: rows.map(mapRow) };
}

/* ---------- Tự gia hạn phiên MISA ----------
   Token của phần Hộ kinh doanh chỉ sống khoảng 12 giờ và MISA không tự gia hạn nó. Trình duyệt
   lấy token mới bằng cách đăng nhập lại qua phiên AMIS (cookie), không cần mật khẩu:
     1) GET  /APIS/IntegrationAPI/app/redirect/hkd  (kèm cookie)  → chuyển hướng tới
        /hkd/callback?sid=…&tid=…&mid=…
     2) POST /hkd/g1/api/auth/v1/account/login/misa_id  (sid, lang, tid, mid)  → AccessToken mới
   Hàm này làm đúng hai bước đó bằng cookie có trong request admin đã dán.
   GIỚI HẠN: chỉ chạy được chừng nào phiên AMIS (cookie) còn sống. Kế toán đăng xuất MISA,
   hoặc cookie hết hạn, thì phải dán lại request. */
const AMIS_ORIGIN = 'https://' + MISA_HOST;
const AMIS_SSO_URL = AMIS_ORIGIN + '/APIS/IntegrationAPI/app/redirect/hkd';
const HKD_LOGIN_URL = AMIS_ORIGIN + '/hkd/g1/api/auth/v1/account/login/misa_id';

const parseCookies = s => new Map(String(s || '').split(';').map(p => p.trim()).filter(Boolean)
  .map(p => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; }));
const cookieString = jar => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
// Ghi cookie MISA trả về vào "lọ" — nhờ vậy phiên AMIS được nối dài mỗi lần gia hạn
function absorbSetCookie(jar, res) {
  const list = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const first = String(line).split(';')[0]; const i = first.indexOf('=');
    if (i <= 0) continue;
    const k = first.slice(0, i).trim(), v = first.slice(i + 1).trim();
    if (v === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) jar.delete(k); else jar.set(k, v);
  }
}
// X-MISA-Context là JSON; có thể được mã hoá URI. Trả về { obj, encode } để ghi lại đúng kiểu cũ.
function readContext(raw) {
  for (const [dec, enc] of [[s => s, s => s], [decodeURIComponent, encodeURIComponent]]) {
    try { const obj = JSON.parse(dec(raw)); if (obj && typeof obj === 'object') return { obj, encode: enc }; } catch {}
  }
  return null;
}

// Trả về cấu hình mới (headers đã có token mới). Ném MisaError('auth') nếu phiên AMIS đã hết.
export async function renewSession(cfg, fetchImpl) {
  const jar = parseCookies(cfg.headers.cookie);
  if (!jar.size) throw new MisaError('Request đã dán không kèm cookie nên không tự gia hạn được — cần dán lại request mới.', 'auth');
  const ua = cfg.headers['user-agent'];
  const base = () => ({ ...(ua ? { 'user-agent': ua } : {}), cookie: cookieString(jar) });

  // Bước 1: đi theo chuỗi chuyển hướng (chỉ trong amisapp.misa.vn) cho tới khi gặp /hkd/callback?sid=
  let url = AMIS_SSO_URL, cb = null;
  for (let hop = 0; hop < 6 && !cb; hop++) {
    let r;
    try { r = await fetchImpl(url, { method: 'GET', headers: { ...base(), accept: 'text/html,*/*' }, redirect: 'manual' }); }
    catch (e) { throw new MisaError('Không kết nối được tới MISA để gia hạn phiên: ' + e.message, 'network'); }
    absorbSetCookie(jar, r);
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : '';
    if (!loc) break;
    let next; try { next = new URL(loc, url); } catch { break; }
    if (next.origin !== AMIS_ORIGIN) break;                       // bị đẩy sang trang đăng nhập (id.misa.vn)
    if (next.pathname.startsWith('/hkd/callback') && next.searchParams.get('sid')) cb = next;
    else if (next.pathname.startsWith('/login')) break;           // phiên AMIS đã hết
    else url = next.href;
  }
  if (!cb) throw new MisaError('Phiên đăng nhập MISA đã hết hạn hẳn — cần dán lại request mới.', 'auth');

  // Bước 2: đổi sid lấy token mới
  const form = new URLSearchParams({ sid: cb.searchParams.get('sid') });
  form.set('lang', cb.searchParams.get('lang') || 'vi');
  for (const k of ['tid', 'mid']) if (cb.searchParams.get(k)) form.set(k, cb.searchParams.get(k));
  let r, j;
  try {
    r = await fetchImpl(HKD_LOGIN_URL, {
      method: 'POST', redirect: 'manual',
      headers: { ...base(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json, text/plain, */*',
        origin: AMIS_ORIGIN, referer: cb.href.split('?')[0], ...(cfg.headers['x-device'] ? { 'x-device': cfg.headers['x-device'] } : {}) },
      body: form.toString(),
    });
    absorbSetCookie(jar, r);
    j = await r.json();
  } catch (e) { throw new MisaError('MISA không trả lời khi gia hạn phiên: ' + e.message, 'network'); }
  const data = j && j.Success === true ? j.Data : null;
  const token = data && data.AccessToken && data.AccessToken.Token;
  if (!token) throw new MisaError('MISA từ chối gia hạn phiên — cần dán lại request mới.', 'auth');

  const headers = { ...cfg.headers, authorization: 'Bearer ' + token, cookie: cookieString(jar) };
  // Giữ nguyên ngữ cảnh cũ (chi nhánh, dữ liệu kế toán…), chỉ thay mã phiên — giống cách trang MISA tự làm
  const old = readContext(cfg.headers['x-misa-context'] || '');
  if (old && data.Context) {
    for (const k of ['SessionId', 'AmisSessionId']) if (data.Context[k] != null) old.obj[k] = data.Context[k];
    headers['x-misa-context'] = old.encode(JSON.stringify(old.obj));
  } else if (data.Context) headers['x-misa-context'] = JSON.stringify({ ...data.Context, Language: 'vi' });
  const ttl = Number(data.AccessToken.TokenExpired) || 0;
  return { ...cfg, headers, renewedAt: new Date().toISOString(), renewCount: (cfg.renewCount || 0) + 1,
    tokenExpAt: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : '' };
}
