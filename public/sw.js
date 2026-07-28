// 리디플랜 서비스워커 — "홈 화면에 추가"(PWA 설치)를 위한 최소 구성.
// 원칙: 학생별 데이터(HTML/API)는 절대 캐시하지 않는다. 로고·아이콘 같은 /assets 정적 파일만 캐시.
// 코드를 고치면 아래 CACHE_VERSION 숫자만 올리면 학생 폰에서 옛날 캐시가 자동으로 지워집니다.
const CACHE_VERSION = 'rdplan-v2'; // v2: 앱 아이콘을 부엉이 마스코트로 교체(2026-07-29)

self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // 정적 자산만 캐시 우선(cache-first) — 폰트/아이콘/로고 로딩이 빨라짐
    if (url.pathname.startsWith('/assets/')) {
        e.respondWith(
            caches.match(req).then(hit => hit || fetch(req).then(res => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE_VERSION).then(c => c.put(req, copy));
                }
                return res;
            }))
        );
        return;
    }

    // 그 외(페이지·API)는 항상 네트워크. 오프라인이면 그냥 실패시킴 —
    // 지난 학생 데이터가 캐시돼서 잘못 보이는 것보다 안 보이는 게 낫다.
});
