// Đơn OMS → chiến dịch / nhóm quảng cáo Meta, từ UTM Ladipage gửi kèm đơn.
// Tham số URL quảng cáo nên là
//   utm_source=facebook&utm_campaign={{campaign.id}}&utm_medium={{adset.id}}&utm_content={{ad.id}}
// nhưng không dựa vào vị trí: mỗi ID số trong UTM được tra (byId, Graph API) ra loại của nó
// (ad → nhóm + chiến dịch, nhóm → chiến dịch), nên đơn chỉ mang {{ad.id}} hay ID nhóm vẫn ra đủ.
// Chỉ tính đơn từ AD_REF_FROM (ngày bắt đầu gắn ID vào tham số URL); đơn cũ không tra.
export const AD_REF_FROM = '2026-10-29';
export const AD_REF_FIELDS = ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id'];
// ad.id hay nằm ở utm_content → tra trước (cụ thể nhất); trường đầu tiên có giá trị được giữ
const ID_KEYS = ['utm_content', 'utm_medium', 'utm_term', 'utm_campaign'];

export async function adRefFromUtm(u, { byId }) {
  const ref = {};
  const seen = new Set();
  for (const k of ID_KEYS) {
    const v = String(u[k] || '').trim();
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
  return ['utm_campaign', 'utm_medium', 'utm_term', 'utm_content'].some(k => String(u[k] || '').trim());
}
