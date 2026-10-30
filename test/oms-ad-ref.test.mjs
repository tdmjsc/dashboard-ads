import test from 'node:test';
import assert from 'node:assert/strict';
import { adRefFromUtm, adIdFromFbclid, findFbclid, utmFromUrl } from '../oms-ad-ref.js';

const META = {
  '1200000000000001': { ad_id: '1200000000000001', adset_id: '1200000000000002', adset_name: 'Nhóm A', campaign_id: '1200000000000003', campaign_name: 'TD1 - Máy đo' },
  '1200000000000002': { adset_id: '1200000000000002', adset_name: 'Nhóm A', campaign_id: '1200000000000003', campaign_name: 'TD1 - Máy đo' },
  '1200000000000003': { campaign_id: '1200000000000003', campaign_name: 'TD1 - Máy đo' },
  '1200000000000009': { campaign_id: '1200000000000099', campaign_name: 'Khác' },
};
const calls = [];
const byId = async id => { calls.push(id); return META[id] || null; };

test('ad.id alone gives adset and campaign', async () => {
  const r = await adRefFromUtm({ utm_content: '1200000000000001' }, { byId });
  assert.deepEqual(r, META['1200000000000001']);
});

test('full recommended UTM set', async () => {
  const r = await adRefFromUtm({ utm_campaign: '1200000000000003', utm_medium: '1200000000000002', utm_content: '1200000000000001' }, { byId });
  assert.equal(r.adset_id, '1200000000000002');
  assert.equal(r.campaign_id, '1200000000000003');
  assert.equal(r.ad_id, '1200000000000001');
});

test('adset id in utm_content (old setup) still gives campaign', async () => {
  const r = await adRefFromUtm({ utm_content: '1200000000000002' }, { byId });
  assert.equal(r.campaign_id, '1200000000000003');
  assert.equal(r.ad_id, undefined);
});

test('ID of another campaign is ignored', async () => {
  const r = await adRefFromUtm({ utm_content: '1200000000000001', utm_campaign: '1200000000000009' }, { byId });
  assert.equal(r.campaign_id, '1200000000000003');
});

test('name or unknown id gives nothing', async () => {
  assert.deepEqual(await adRefFromUtm({ utm_content: 'TD1 - Máy đo', utm_medium: '1200000000000077' }, { byId }), {});
});

test('rate limit error propagates', async () => {
  await assert.rejects(adRefFromUtm({ utm_content: '1200000000000001' }, { byId: async () => { throw new Error('rl'); } }));
});

// Link thật: bấm link trong bình luận của bài quảng cáo (30/10/2026)
const FBCLID = 'IwdGRjcAVRCupleHRuA2FlbQEwAHBkb2YFZmRpZBZRFCC9GbjAJOGOj_0cjWJd_cUYzxopYWRpZAGrN49A6439c3J0YwZhcHBfaWQKNjYyODU2ODM3OQABH5eoI2z05NEqlNFSSzsidncXMH8iI_ejXv6CeXFnSYVjzzY6S9LeNXoIU87p_aem_PxrdaN2aLdl5JuPoFlc7EA';

test('fbclid carries the ad id', () => {
  assert.equal(adIdFromFbclid(FBCLID), '120250903464480253');
  assert.equal(adIdFromFbclid('IwAR3xYzOldStyleEncrypted'), '');
  assert.equal(adIdFromFbclid(''), '');
});

test('fbclid found in page URL', () => {
  assert.equal(findFbclid({ url_page: 'https://www.tdmjsc.com/gelduoichuott?fbclid=' + FBCLID }), FBCLID);
  assert.equal(findFbclid({ fbclid: 'abc' }), 'abc');
  assert.equal(findFbclid({ url_page: 'https://x.com/a' }), '');
});

// Quảng cáo gel chuột của Tùng (30/10/2026): nút mang UTM {{ad.id}} + fbclid; link trong bài và link
// bình luận chỉ có fbclid, cùng adid 52658161396313 (ID ad nội bộ, khác ID quảng cáo 52658160753113)
const NUT = 'https://www.tdmjsc.com/gelduoichuototochinhhang?fbclid=IwdGRjcAVRMbBleHRuA2FlbQEwAHBkb2YFZmRpZBZRFOnWkZG1nt2HSSjkLZZsi13P2sIGYWRpZAAAL-RvASpZc3J0YwZhcHBfaWQKNjYyODU2ODM3OQABH536pKDhr9KuVOn5KceKyjQVns-Fdm5_F5f4UVe25211CsxEX_hNE5ZintpG_aem_3G7B-QrSXilzdgj8wL_edA&utm_medium=paid&utm_source=fb&utm_id=52658160752713&utm_content=52658160753113&utm_term=52658160752913&utm_campaign=52658160752713';
const BINH_LUAN = 'IwdGRjcAVRMflleHRuA2FlbQEwAHBkb2YFZmRpZBZRFNsd-NSXfICPcKepakLYU-oKH_5oYWRpZAAAL-RvASpZc3J0YwZhcHBfaWQKNjYyODU2ODM3OQABHw4Av7QUzW-SNZ85Y6IQxpCR13iJRQ0iWyIaJ-YN90m17DcV-wV9M-E5FiOv_aem_3G7B-QrSXilzdgj8wL_edA';
const TUNG = { ad_id: '52658160753113', adset_id: '52658160752913', campaign_id: '52658160752713' };
const byIdTung = async id => id === TUNG.ad_id ? TUNG : id === TUNG.adset_id ? { adset_id: id, campaign_id: TUNG.campaign_id }
  : id === TUNG.campaign_id ? { campaign_id: id } : null;

test('button click teaches the adid library, comment link then resolves from it', async () => {
  const lib = new Map();
  const deps = { byId: byIdTung, adidRef: async a => lib.get(a) || null, learn: async (a, ref) => { lib.set(a, ref); } };
  const nut = utmFromUrl(NUT);
  assert.equal(adIdFromFbclid(nut.fbclid), '52658161396313');
  assert.equal((await adRefFromUtm(nut, deps)).ad_id, TUNG.ad_id);
  assert.deepEqual(lib.get('52658161396313'), TUNG);
  assert.equal(adIdFromFbclid(BINH_LUAN), '52658161396313');
  assert.deepEqual(await adRefFromUtm({ fbclid: BINH_LUAN }, deps), TUNG);
});

test('adid is never sent to Graph API; unknown adid gives nothing', async () => {
  const asked = [];
  const r = await adRefFromUtm({ fbclid: FBCLID }, { byId: async id => { asked.push(id); return null; }, adidRef: async () => null });
  assert.deepEqual(r, {});
  assert.deepEqual(asked, []);
});

test('UTM wins over the library; no learning without an ad id in UTM', async () => {
  const learned = [];
  const deps = { byId: byIdTung, adidRef: async () => ({ ad_id: '1', adset_id: '2', campaign_id: '3' }), learn: async a => learned.push(a) };
  assert.equal((await adRefFromUtm({ ...utmFromUrl(NUT) }, deps)).campaign_id, TUNG.campaign_id);
  learned.length = 0;
  await adRefFromUtm({ utm_term: TUNG.adset_id, fbclid: BINH_LUAN }, deps); // chỉ có ID nhóm → không học
  assert.deepEqual(learned, []);
});
