// Đơn OMS → chiến dịch / nhóm quảng cáo Meta, từ UTM Ladipage gửi kèm đơn.
// Tham số URL quảng cáo nên là
//   utm_source=facebook&utm_campaign={{campaign.id}}&utm_medium={{adset.id}}&utm_content={{ad.id}}
// nhưng không dựa vào vị trí: mỗi ID số trong UTM được tra (byId, Graph API) ra loại của nó
// (ad → nhóm + chiến dịch, nhóm → chiến dịch), nên đơn chỉ mang {{ad.id}} hay ID nhóm vẫn ra đủ.
// Đơn đặt qua link trong bình luận không có UTM, nhưng fbclid Facebook gắn vào link (kiểu mới,
// bắt đầu "Iw") có trường adid = ID quảng cáo người xem đã thấy → adIdFromFbclid, tra trước UTM.
// Chỉ tính đơn từ AD_REF_FROM (ngày bắt đầu gắn ID vào tham số URL); đơn cũ không tra.
export const AD_REF_FROM = '2026-10-29';
export const AD_REF_FIELDS = ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id'];
// ad.id hay nằm ở utm_content → tra trước (cụ thể nhất); trường đầu tiên có giá trị được giữ
const ID_KEYS = ['utm_content', 'utm_medium', 'utm_term', 'utm_campaign'];

// fbclid kiểu mới: base64url (bỏ phần "_aem_…") của các cặp khoá–giá trị; sau khoá "adid" là
// 8 byte big-endian = ID quảng cáo (đã đối chiếu 30/10/2026 với một lần bấm link bình luận bài
// quảng cáo: 120250903464480253). Không có adid (fbclid kiểu cũ "IwAR…", bài không chạy quảng cáo) → ''.
export function adIdFromFbclid(fbclid) {
  const main = String(fbclid || '').trim().split('_aem_')[0];
  if (!main) return '';
  for (let skip = 0; skip < 4; skip++) { // chưa rõ độ dài phần đầu → thử các độ lệch base64
    const part = main.slice(skip);
    let buf;
    try { buf = Buffer.from(part.slice(0, part.length - (part.length % 4)), 'base64url'); } catch { continue; }
    const at = buf.indexOf('adid');
    if (at < 0 || at + 12 > buf.length) continue;
    const id = buf.readBigUInt64BE(at + 4).toString();
    if (/^\d{15,20}$/.test(id)) return id;
  }
  return '';
}

// fbclid trong dữ liệu Ladipage gửi về: trường fbclid riêng, hoặc tham số trong URL trang
export function findFbclid(d) {
  if (d && typeof d.fbclid === 'string' && d.fbclid.trim()) return d.fbclid.trim();
  for (const v of Object.values(d || {})) {
    const m = typeof v === 'string' && /[?&]fbclid=([^&#\s]+)/.exec(v);
    if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  }
  return '';
}

export async function adRefFromUtm(u, { byId }) {
  const ref = {};
  const seen = new Set();
  const cands = [adIdFromFbclid(u.fbclid), ...ID_KEYS.map(k => u[k])];
  for (const raw of cands) {
    const v = String(raw || '').trim();
    if (!/^\d{10,}$/.test(v) || seen.has(v)) continue;
    seen.add(v);
    const r = await byId(v); // lỗi tạm thời (rate limit) ném ra → người gọi để lần sau tra lại
    if (!r) continue;
    // ID của chiến dịch khác (UTM lệch nhau) thì bỏ, không ghép nhóm của chiến dịch này với chiến dịch kia
    if (ref.campaign_id && r.campaign_id && r.campaign_id !== ref.campaign_id) continue;
    for (const f of AD_REF_FIELDS) if (r[f] && !ref[f]) ref[f] = String(r[f]);
  }
  return ref;
}

export function hasUtm(u) {
  return ['utm_campaign', 'utm_medium', 'utm_term', 'utm_content', 'fbclid'].some(k => String(u[k] || '').trim());
}
