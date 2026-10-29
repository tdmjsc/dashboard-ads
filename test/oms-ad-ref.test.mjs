import test from 'node:test';
import assert from 'node:assert/strict';
import { adRefFromUtm } from '../oms-ad-ref.js';

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
