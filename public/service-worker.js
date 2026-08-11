// Service Worker cho TDMJSC Ads Dashboard PWA
// Chiến lược:
//   • network-first cho API, trang HTML, và MÃ NGUỒN JS/CSS
//     → luôn lấy bản mới nhất (công thức lương nằm trong salary-calc.js,
//       nên bắt buộc phải cập nhật ngay khi deploy, không được kẹt bản cũ).
//   • cache-first cho tài nguyên tĩnh thật sự (icon, ảnh, font, manifest)
//     → load nhanh + hỗ trợ offline nhẹ.

// ⚠ Mỗi lần đổi chiến lược cache, TĂNG số version để xoá sạch cache cũ.
const CACHE_NAME = 'tdmjsc-ads-v2';
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
  const isCode = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');

  // Network-first: API, trang HTML, và mã nguồn JS/CSS phải luôn mới nhất.
  const networkFirst =
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/thailand') ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/' ||
    isCode;

  if (networkFirst) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          // Lưu lại bản JS/CSS mới để còn dùng khi offline
          if (resp.ok && isCode) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return resp;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || new Response('Mất kết nối mạng', { status: 503 }))
        )
    );
    return;
  }

  // Tài nguyên tĩnh khác (icon, ảnh, font, manifest): cache-first
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
