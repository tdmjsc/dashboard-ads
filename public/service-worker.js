// Service Worker cho TDMJSC Ads Dashboard PWA
// Chiến lược: network-first cho API/HTML (luôn lấy dữ liệu mới nhất),
// cache-first cho tài nguyên tĩnh (icon, css, js) để load nhanh + hỗ trợ offline nhẹ.

const CACHE_NAME = 'tdmjsc-ads-v1';
const PRECACHE_URLS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // không can thiệp POST/PUT (login, lưu dữ liệu...)

  const url = new URL(request.url);

  // Luôn lấy mới với API và trang HTML (dữ liệu quảng cáo/đơn hàng phải luôn mới nhất)
  const isApiOrPage =
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/thailand') ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/';

  if (isApiOrPage) {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(request).then((cached) => cached || new Response('Mất kết nối mạng', { status: 503 }))
      )
    );
    return;
  }

  // Tài nguyên tĩnh: cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return resp;
      });
    })
  );
});
