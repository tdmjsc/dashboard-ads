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
//   • Khi phiên MISA hết hạn, đồng bộ dừng cho tới khi admin dán lại request mới.
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
