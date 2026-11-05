// Đơn OMS → chiến dịch / nhóm quảng cáo Meta, từ UTM Ladipage gửi kèm đơn.
// Tham số URL quảng cáo nên là
//   utm_source=facebook&utm_campaign={{campaign.id}}&utm_medium={{adset.id}}&utm_content={{ad.id}}
// nhưng không dựa vào vị trí: mỗi ID số trong UTM được tra (byId, Graph API) ra loại của nó
// (ad → nhóm + chiến dịch, nhóm → chiến dịch), nên đơn chỉ mang {{ad.id}} hay ID nhóm vẫn ra đủ.
// Đơn đặt qua link trong bài / bình luận không có UTM, chỉ có fbclid. fbclid kiểu mới mang "adid" =
// ID "ad" NỘI BỘ của Meta (không phải ID quảng cáo: Ads Manager gọi quảng cáo là adgroup, mỗi quảng cáo
// có một ad nội bộ, sinh lúc Meta duyệt quảng cáo, đổi khi sửa rồi duyệt lại; mở được ở Thư viện quảng cáo
// facebook.com/ads/library/?id=<adid>). Graph API công khai không tra được adid (đã thử 30/10/2026) →
// OMS tự lập thư viện adid → quảng cáo (bảng oms_adid_map): học từ lượt bấm nút quảng cáo (link có cả
// UTM {{ad.id}} lẫn fbclid), hoặc admin / NV thêm tay. Cùng một quảng cáo thì nút, link trong bài và
// link bình luận cho cùng adid.
// Chỉ tính đơn từ AD_REF_FROM (ngày bắt đầu gắn ID vào tham số URL); đơn cũ không tra.
export const AD_REF_FROM = '2026-10-29';
export const AD_REF_FIELDS = ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id'];
// ad.id hay nằm ở utm_content → tra trước (cụ thể nhất); trường đầu tiên có giá trị được giữ
const ID_KEYS = ['utm_content', 'utm_medium', 'utm_term', 'utm_campaign'];

// fbclid kiểu mới: base64url (bỏ phần "_aem_…") của các cặp khoá–giá trị; sau khoá "adid" là
// 8 byte big-endian (không có byte độ dài) = ID ad nội bộ (xem đầu file). Không có adid (fbclid kiểu cũ
// "IwAR…", bài không chạy quảng cáo) → ''.
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
    if (/^\d{12,20}$/.test(id)) return id;
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

// adidRef(adid) → { ad_id, adset_id, … } từ thư viện adid (hoặc null); learn(adid, ref) được gọi khi UTM
// cho ra ID quảng cáo và link có adid (lượt bấm nút quảng cáo) → thư viện học cặp đó. UTM ưu tiên hơn
// thư viện (macro {{ad.id}} luôn đúng quảng cáo đang hiển thị, kể cả quảng cáo nhân bản).
export async function adRefFromUtm(u, { byId, adidRef, learn }) {
  const ref = {};
  const seen = new Set();
  for (const raw of ID_KEYS.map(k => u[k])) {
    const v = String(raw || '').trim();
    if (!/^\d{10,}$/.test(v) || seen.has(v)) continue;
    seen.add(v);
    const r = await byId(v); // lỗi tạm thời (rate limit) ném ra → người gọi để lần sau tra lại
    if (!r) continue;
    // ID của chiến dịch khác (UTM lệch nhau) thì bỏ, không ghép nhóm của chiến dịch này với chiến dịch kia
    if (ref.campaign_id && r.campaign_id && r.campaign_id !== ref.campaign_id) continue;
    for (const f of AD_REF_FIELDS) if (r[f] && !ref[f]) ref[f] = String(r[f]);
  }
  const adid = adIdFromFbclid(u.fbclid);
  if (adid && ref.ad_id && learn) await learn(adid, ref);
  if (!ref.campaign_id && adid && adidRef) {
    const r = await adidRef(adid);
    if (r) for (const f of AD_REF_FIELDS) if (r[f]) ref[f] = String(r[f]);
  }
  return ref;
}

// Link NV dán / trang gửi về → { fbclid, utm_* } để học / thêm tay. Chịu mọi kiểu copy: link đầy đủ, thiếu
// https://, link bọc l.facebook.com/l.php?u=… (giữ tay vào nút → Sao chép liên kết), chỉ đoạn "fbclid=…",
// hoặc chỉ chuỗi fbclid (Iw…), kèm khoảng trắng / chữ thừa. Không có gì → null.
export function utmFromUrl(url) {
  let s = String(url || '').trim();
  if (!s) return null;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) { try { s = decodeURIComponent(s); } catch { break; } }
  const get = k => {
    const m = new RegExp(`(?:^|[?&#\\s])${k}=([^&#\\s"'<>]+)`).exec(s);
    return m ? m[1].replace(/\+/g, ' ') : '';
  };
  const out = { fbclid: get('fbclid') };
  if (!out.fbclid) { const m = /(?:^|[^A-Za-z0-9_-])(Iw[A-Za-z0-9_-]{30,})/.exec(s); if (m) out.fbclid = m[1]; }
  for (const k of ['utm_campaign', 'utm_medium', 'utm_term', 'utm_content']) out[k] = get(k);
  return out.fbclid || out.utm_content || out.utm_medium || out.utm_term || out.utm_campaign ? out : null;
}

// ---- Dự phòng: đơn có fbclid KHÔNG có adid (khách mở bài như bài thường, vd bấm thông báo trả lời bình luận)
// hoặc không có gì để tra → ghép theo trang đích + NV (người dùng chọn 5/11/2026). Không đoán khi mơ hồ.
// Trang đích = đường dẫn trang Ladipage (bỏ tên miền: tdmjsc.com và tdmjs.com đều là của công ty).
export function landingKey(url) {
  const m = /^(?:[a-z]+:\/\/)?[^/?#\s]+(\/[^?#\s]*)/i.exec(String(url || '').trim());
  const path = m ? m[1].replace(/\/+$/, '').toLowerCase() : '';
  return path && path !== '/' ? path : '';
}
// hist: Map trang đích → Map ID chiến dịch → Set ID nhóm, học từ đơn đã ghép chắc chắn (UTM / adid).
// camps: chiến dịch trang Ads của ngày đặt đơn (getCampaigns(day, day): employee, daily[].spent, adsets[]).
// Ghép khi đúng 1 chiến dịch của NV đó có chi tiêu trong ngày và từng ra đơn từ trang đích này; nhóm chỉ khi
// chiến dịch có 1 nhóm đang tiêu, hoặc trong các nhóm đang tiêu chỉ 1 nhóm từng ra đơn từ trang này.
export function guessByLanding({ landing, nv, camps, hist }) {
  const h = landing && nv ? hist.get(landing) : null;
  if (!h) return null;
  const spent = c => (c.daily || []).reduce((a, d) => a + (Number(d.spent) || 0), 0);
  const cands = (camps || []).filter(c => c.employee === nv && spent(c) > 0 && h.has(String(c.id)));
  if (cands.length !== 1) return null;
  const c = cands[0];
  const ref = { campaign_id: String(c.id), campaign_name: c.name || '' };
  const active = (c.adsets || []).filter(a => a.spent > 0);
  const known = h.get(String(c.id));
  const pick = active.length === 1 ? active : active.filter(a => known.has(String(a.id)));
  if (pick.length === 1) { ref.adset_id = String(pick[0].id); ref.adset_name = pick[0].name || ''; }
  return ref;
}
export function addLandingHist(hist, url, campaignId, adsetId) {
  const k = landingKey(url);
  if (!k || !campaignId) return;
  const byCamp = hist.get(k) || hist.set(k, new Map()).get(k);
  const set = byCamp.get(String(campaignId)) || byCamp.set(String(campaignId), new Set()).get(String(campaignId));
  if (adsetId) set.add(String(adsetId));
}

export function hasUtm(u) {
  return ['utm_campaign', 'utm_medium', 'utm_term', 'utm_content', 'fbclid'].some(k => String(u[k] || '').trim());
}
