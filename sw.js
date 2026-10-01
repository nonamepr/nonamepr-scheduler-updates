// 휴대폰 웹앱 서비스 워커 (v3.0)
// · 화면 파일은 '인터넷 먼저' — 새 버전을 올리면 다음에 열 때 바로 바뀐다 (안 되면 저장해 둔 것으로)
// · 일정 데이터(서버 통신)는 저장하지 않는다
// · 휴대폰 알림(웹 푸시)을 받아 띄우고, 누르면 앱의 해당 화면을 연다
const CACHE = 'scheduler-shell-v3.0.1';
const SHELL = [
  './', './index.html', './styles.css', './app.js?v=3.0.1', './core.js?v=3.0.1', './insp.js?v=3.0.1', './meet.js?v=3.0.1', './more.js?v=3.0.1', './cloud-store.js?v=3.0.1',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
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
  if (e.request.method !== 'GET' || url.hostname.endsWith('supabase.co')) return;
  // 같은 주소의 화면 파일은 '바뀌었는지' 서버에 확인하고 받는다 (GitHub Pages 의 10분 저장 때문에 예전 파일이 섞이지 않게)
  // (첫 화면(navigate)은 그대로 — 그 요청은 새로 만들 수 없다. 대신 그 안의 파일 주소에 버전이 붙어 있다)
  const req = url.origin === location.origin && e.request.mode !== 'navigate'
    ? new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : e.request;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});

// ---------- 휴대폰 알림 ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || '무명기획 스케줄러';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        w.postMessage({ type: 'open', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
