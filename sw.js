// 앱 화면(껍데기)만 캐시해 오프라인에서도 열리게 한다.
// 실제 일정 데이터는 항상 서버에서 새로 받아온다.
const CACHE = 'scheduler-shell-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 서버 통신(일정 데이터·로그인)은 캐시하지 않는다
  if (url.hostname.endsWith('supabase.co') || e.request.method !== 'GET') return;

  // 화면 파일은 네트워크 우선, 실패 시 캐시 사용
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
