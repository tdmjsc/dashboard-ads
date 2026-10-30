import test from 'node:test';
import assert from 'node:assert/strict';
import { adRefFromUtm, adIdFromFbclid, findFbclid } from '../oms-ad-ref.js';

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

test('order from comment link (fbclid only) resolves to ad, adset, campaign', async () => {
  const byId2 = async id => id === '120250903464480253' ? { ad_id: id, adset_id: '1', campaign_id: '2' } : null;
  const r = await adRefFromUtm({ fbclid: FBCLID }, { byId: byId2 });
  assert.deepEqual(r, { ad_id: '120250903464480253', adset_id: '1', campaign_id: '2' });
});
