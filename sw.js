/* 오프라인 담당 (service worker = 화면 뒤에서 도는 작은 도우미).
   앱 파일(화면·코드·pdf.js)만 미리 받아둔다.
   차트 PDF 는 이미 IndexedDB 창고에 들어 있으므로 여기서 또 받지 않는다. */

/* ★★ 앱을 고쳐서 다시 올릴 때는 아래 번호를 1 올릴 것 (ncv-v1 → ncv-v2).
       안 올리면 아이패드가 예전 화면을 계속 쓴다. ★★ */
const CACHE = 'ncv-v12';  // v12: 모바일 로고 표시, 즐겨찾기 공항 클릭 시 목록 펼침, 글자·아이콘 크기 조정 (2026-08-01)

const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon.png',
  './jeppesen_icon.png',
  './pdfjs/pdf.min.mjs',
  './pdfjs/pdf.worker.min.mjs'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 하나씩 넣는다. 한꺼번에 넣으면 파일 하나만 없어도 설치 전체가 취소된다
    for (const f of APP_FILES) {
      try { await cache.add(new Request(f, { cache: 'reload' })); }
      catch (err) { console.warn('미리 받아두지 못한 파일:', f, err); }
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // 번호가 바뀌면 예전 캐시는 버린다
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;   // 바깥 주소는 건드리지 않는다

  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();          // 응답은 한 번만 읽을 수 있어 복사본을 넣는다
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      // 인터넷도 없고 저장해 둔 것도 없을 때, 화면 이동이면 첫 화면이라도 돌려준다
      if (req.mode === 'navigate') {
        const home = await caches.match('./index.html');
        if (home) return home;
      }
      throw err;
    }
  })());
});
