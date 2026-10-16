// Kiểm tra: hai tiến trình (Passenger) dùng chung DATA_DIR không xoá thay đổi của nhau.
// Mỗi module được gắn 2 lần trên cùng thư mục dữ liệu (2 closure = 2 bản STORE như 2 tiến trình).
// B gắn trước (giữ bản cũ), A đổi dữ liệu, rồi B chạy việc ghi định kỳ / ghi của nó → thay đổi của A phải còn.
// Chạy: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.MOD_DIR || path.join(import.meta.dirname, '..');
const load = f => import(pathToFileURL(path.join(ROOT, f)).href);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Express giả: ghi lại route, chạy middleware app.use theo tiền tố đường dẫn
function fakeApp() {
  const uses = [], routes = {};
  const add = m => (p, ...h) => { routes[m + ' ' + p] = h; };
  const app = {
    use: (p, ...h) => typeof p === 'string' ? uses.push([p, h]) : uses.push(['', [p, ...h]]),
    get: add('GET'), post: add('POST'),
    async call(method, p, body = {}, headers = {}) {
      const chain = [...uses.filter(([pre]) => p.startsWith(pre)).flatMap(([, h]) => h), ...(routes[method + ' ' + p] || assert.fail('không có route ' + p))];
      const req = { body, query: {}, session: { user: { role: 'admin', user: 'test' } }, get: k => headers[k.toLowerCase()] };
      let out;
      const res = { json: j => { out = j; }, status() { return res; }, sendStatus: c => { out = c; } };
      for (const h of chain) {
        let next = false;
        await h(req, res, () => { next = true; });
        if (!next) break;
      }
      return out;
    },
  };
  return app;
}
const express = { json: () => (req, res, next) => next() };
const tgFetch = calls => async (url, opt) => {
  const method = url.split('/').pop(), body = JSON.parse(opt?.body || '{}');
  calls?.push({ method, body });
  const result = method === 'getChat' ? { id: Number(body.chat_id), type: 'supergroup', title: 'Nhóm kho' }
    : method === 'getMe' ? { username: 'testbot', can_read_all_group_messages: true } : true;
  return { status: 200, json: async () => ({ ok: true, result }) };
};
// Bắt setInterval của module để tự gọi "lần chạy định kỳ"
function mountCapturingTimers(fn) {
  const real = globalThis.setInterval, timers = [];
  globalThis.setInterval = cb => { timers.push(cb); return { unref() {} }; };
  try { fn(); } finally { globalThis.setInterval = real; }
  return timers;
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nhieu-tien-trinh-'));

test('tonkho: cấu hình + mức tồn tối thiểu không bị tiến trình cũ ghi đè khi đồng bộ', async () => {
  const { mountTonKho } = await load('tonkho.js');
  const DATA_DIR = tmpDir();
  const fetchWithTimeout = tgFetch();
  const B = fakeApp(), A = fakeApp();
  const timersB = mountCapturingTimers(() => mountTonKho(B, { express, DATA_DIR, fetchWithTimeout }));
  mountCapturingTimers(() => mountTonKho(A, { express, DATA_DIR, fetchWithTimeout }));

  // A: đổi cấu hình + mức tồn tối thiểu
  assert.equal((await A.call('POST', '/api/ton-kho/setting', { key: 'SP01', min: 7, alias: 'may do' })).ok, true);
  assert.equal((await A.call('POST', '/api/ton-kho/alert-config', { alertThreshold: 25 })).ok, true);
  // B (bản cũ): lần chạy định kỳ + nhập số tồn mới
  for (const t of timersB) t();
  assert.equal((await B.call('POST', '/api/ton-kho/import', { items: [{ code: 'SP01', name: 'Máy đo', qty: 3 }] })).ok, true);
  await sleep(50); // cảnh báo tồn thấp chạy ngầm sau khi nhập
  const f = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ton-kho.json'), 'utf8'));
  assert.deepEqual(f.settings.SP01, { min: 7, alias: 'may do' });
  assert.equal(f.config.alertThreshold, 25);
  assert.equal(f.snapshot.items[0].qty, 3);
  assert.equal(f.history.length, 1);
  // B đọc được thay đổi của A
  const r = await B.call('GET', '/api/ton-kho');
  assert.equal(r.items[0].min, 7);
  assert.equal(r.alert.threshold, 25);
  // A: đổi mức tồn của mã khác sau khi B nhập → cả hai còn
  await A.call('POST', '/api/ton-kho/setting', { key: 'SP02', min: 1 });
  await B.call('POST', '/api/ton-kho/import', { items: [{ code: 'SP01', name: 'Máy đo', qty: 4 }] });
  await sleep(50);
  const f2 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ton-kho.json'), 'utf8'));
  assert.deepEqual(Object.keys(f2.settings).sort(), ['SP01', 'SP02']);
  assert.equal(f2.history.length, 2);
  assert.equal((fs.statSync(path.join(DATA_DIR, 'ton-kho.json')).mode & 0o777), 0o600);
});

test('telegram-kho: nhóm A vừa chọn không bị B (bản cũ) ghi đè khi gửi tin', async () => {
  const { mountKhoBot } = await load('telegram-kho.js');
  const DATA_DIR = tmpDir(), calls = [];
  const B = fakeApp(), A = fakeApp();
  const botB = mountKhoBot(B, { express, DATA_DIR, fetchWithTimeout: tgFetch(calls), token: 'x' });
  mountKhoBot(A, { express, DATA_DIR, fetchWithTimeout: tgFetch(calls), token: 'x' });

  assert.ok((await A.call('POST', '/api/ton-kho/bot/group', { id: '-1001234567890' })).group);
  const r = await botB.send('thử');
  assert.equal(r.ok, true);
  assert.equal(calls.filter(c => c.method === 'sendMessage').pop().body.chat_id, '-1001234567890');
  const f = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'kho-bot.json'), 'utf8'));
  assert.equal(f.chatId, '-1001234567890');
  assert.equal(f.lastSend.ok, true);
});

test('telegram-all: thành viên A ghi nhớ không bị B (bản cũ) xoá', async () => {
  const { mountTgAll } = await load('telegram-all.js');
  const DATA_DIR = tmpDir();
  const B = fakeApp(), A = fakeApp();
  mountTgAll(B, { express, DATA_DIR, fetchWithTimeout: tgFetch(), token: 'x' });
  mountTgAll(A, { express, DATA_DIR, fetchWithTimeout: tgFetch(), token: 'x' });
  const secret = crypto.createHash('sha256').update('tg-all:x').digest('hex').slice(0, 48); // như trong module
  const hook = (app, uid, name) => app.call('POST', '/tg-all/webhook',
    { message: { message_id: uid, chat: { id: -100, type: 'supergroup', title: 'Nhóm' }, from: { id: uid, first_name: name }, text: 'chào' } },
    { 'x-telegram-bot-api-secret-token': secret });

  await hook(A, 1, 'An');
  await hook(B, 2, 'Bình');
  await hook(A, 3, 'Cường');
  await sleep(2500); // bản cũ ghi file chậm 2 giây sau lần đổi cuối
  const f = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tg-all.json'), 'utf8'));
  assert.deepEqual(Object.values(f.chats['-100'].members).map(m => m.name).sort(), ['An', 'Bình', 'Cường']);
});
