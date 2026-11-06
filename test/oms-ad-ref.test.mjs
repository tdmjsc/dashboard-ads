import test from 'node:test';
import assert from 'node:assert/strict';
import { adRefFromUtm, adIdFromFbclid, findFbclid, utmFromUrl, landingKey, guessByLanding, addLandingHist } from '../oms-ad-ref.js';

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

test('pasted link: any copy form gives the adid', () => {
  const fb = BINH_LUAN, want = '52658161396313';
  const forms = [
    'https://www.tdmjsc.com/gelduoichuototochinhhang?fbclid=' + fb,
    '  www.tdmjsc.com/gelduoichuototochinhhang?fbclid=' + fb + '  ',
    'tdmjs.com/binhutra?utm_source=ct&fbclid=' + fb + '&utm_content=My+-+B%C3%ACnh',
    'https://l.facebook.com/l.php?u=' + encodeURIComponent('https://www.tdmjsc.com/gel?fbclid=' + fb) + '&h=AT0abc',
    'fbclid=' + fb,
    fb,
    'Link: https://www.tdmjsc.com/gel?fbclid=' + fb + ' (bấm từ QC)',
  ];
  for (const f of forms) assert.equal(adIdFromFbclid(utmFromUrl(f)?.fbclid || ''), want, f);
  assert.equal(utmFromUrl(NUT).utm_content, '52658160753113');
  assert.equal(utmFromUrl('https://www.tdmjsc.com/gelduoichuototochinhhang'), null);
  assert.equal(utmFromUrl(''), null);
});

test('landing key ignores domain, query, trailing slash, case', () => {
  assert.equal(landingKey('https://www.tdmjsc.com/MaydonongdoCon-td-auto/?fbclid=Iw123'), '/maydonongdocon-td-auto');
  assert.equal(landingKey('tdmjs.com/maydonongdocon-td-auto'), '/maydonongdocon-td-auto');
  assert.equal(landingKey('https://www.tdmjsc.com/'), '');
  assert.equal(landingKey(''), '');
});

test('guess by landing: only when exactly one spending campaign of that NV used the page', () => {
  const hist = new Map();
  addLandingHist(hist, 'https://www.tdmjsc.com/maydonongdocon-td-auto?x=1', '111', '211');
  addLandingHist(hist, 'tdmjs.com/maydonongdocon-td-auto', '111', '212');
  addLandingHist(hist, 'tdmjsc.com/maydonongdocon-td-auto', '333', '');
  const camp = (id, emp, sp, adsets) => ({ id, name: 'C' + id, employee: emp, daily: [{ spent: sp }], adsets });
  const one = [camp('111', 'Vũ Hà Giang', 100, [{ id: '211', name: 'N1', spent: 100 }]), camp('333', 'Nguyễn Thị Trà My', 50, [])];
  const base = { landing: '/maydonongdocon-td-auto', nv: 'Vũ Hà Giang', hist };
  assert.deepEqual(guessByLanding({ ...base, camps: one }),
    { campaign_id: '111', campaign_name: 'C111', adset_id: '211', adset_name: 'N1' });
  // 2 nhóm đang tiêu, chỉ 1 nhóm từng ra đơn từ trang → nhóm đó; cả 2 từng ra → chỉ chiến dịch
  const two = [camp('111', 'Vũ Hà Giang', 100, [{ id: '211', name: 'N1', spent: 50 }, { id: '299', name: 'N9', spent: 50 }])];
  assert.equal(guessByLanding({ ...base, camps: two }).adset_id, '211');
  const both = [camp('111', 'Vũ Hà Giang', 100, [{ id: '211', spent: 50 }, { id: '212', spent: 50 }])];
  assert.equal(guessByLanding({ ...base, camps: both }).adset_id, undefined);
  // 2 chiến dịch của NV cùng trang → không đoán; chiến dịch không tiêu hôm đó → không tính
  addLandingHist(hist, 'tdmjsc.com/maydonongdocon-td-auto', '444', '');
  const amb = [...one, camp('444', 'Vũ Hà Giang', 10, [])];
  assert.equal(guessByLanding({ ...base, camps: amb }), null);
  assert.equal(guessByLanding({ ...base, camps: [...one, camp('444', 'Vũ Hà Giang', 0, [])] }).campaign_id, '111');
  assert.equal(guessByLanding({ ...base, landing: '/khac', camps: one }), null);
  assert.equal(guessByLanding({ ...base, nv: '', camps: one }), null);
});

test('guess by landing: campaign whose ads link to the page counts even with no history', () => {
  const hist = new Map();
  const ad = (land) => ({ id: 'a', land });
  const camp = (id, emp, sp, adsets) => ({ id, name: 'C' + id, employee: emp, daily: [{ spent: sp }], adsets });
  const L = 'https://www.tdmjs.com/maydonongdocon-tdauto-chinhhang-rv-2';
  const base = { landing: '/maydonongdocon-tdauto-chinhhang-rv-2', nv: 'Vũ Hà Giang', hist };
  // 1 chiến dịch của NV có quảng cáo trỏ tới trang, chiến dịch kia trỏ trang khác → ghép, nhóm có quảng cáo đó
  const camps = [
    camp('111', 'Vũ Hà Giang', 100, [{ id: '211', name: 'N1', spent: 60, ads: [ad([L + '?utm_source=x'])] },
      { id: '212', name: 'N2', spent: 40, ads: [ad(['https://tdmjs.com/khac'])] }]),
    camp('555', 'Vũ Hà Giang', 100, [{ id: '511', spent: 100, ads: [ad(['https://tdmjs.com/khac'])] }]),
  ];
  assert.deepEqual(guessByLanding({ ...base, camps }),
    { campaign_id: '111', campaign_name: 'C111', adset_id: '211', adset_name: 'N1' });
  // 2 chiến dịch cùng trỏ trang → không đoán
  camps[1].adsets[0].ads = [ad([L])];
  assert.equal(guessByLanding({ ...base, camps }), null);
  // Không có link quảng cáo, không lịch sử → không đoán
  assert.equal(guessByLanding({ ...base, camps: [camp('111', 'Vũ Hà Giang', 100, [{ id: '211', spent: 100, ads: [ad([])] }])] }), null);
  // Lịch sử nói 1 chiến dịch, link quảng cáo nói chiến dịch khác → mơ hồ, không đoán
  addLandingHist(hist, L, '777', '');
  const mix = [camp('777', 'Vũ Hà Giang', 50, []), camp('111', 'Vũ Hà Giang', 50, [{ id: '211', spent: 50, ads: [ad([L])] }])];
  assert.equal(guessByLanding({ ...base, camps: mix }), null);
});
