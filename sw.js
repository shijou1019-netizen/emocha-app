/**
 * えもちゃっとライブ スマホ版（閲覧だけ）- Service Worker
 *
 * 最低限のキャッシュ戦略（ネットワークファースト）:
 *   通信できる時は常に最新を取りに行き、取れた分をキャッシュに控える。
 *   オフライン等で取りに行けない時だけ、控えてあるキャッシュを返す（画面そのものを開く時だけ index.html で代用）。
 * これに加えて Service Worker が登録されていること自体が、Android Chrome 等の
 * 「ホーム画面に追加（インストール）」の必須条件のひとつになっている。
 *
 * 控えるのは「同じ場所（このサイト）の GET」だけ（2026-10-14）。
 *   Supabase からの応答（自分の視聴記録）は控えない。控えると、ログアウトしても端末に残ってしまうため。
 *   記録の控えは app.js が localStorage に 1 日分だけ持ち、ログアウトで消す。
 */
const CACHE_NAME = "emocha-pwa-v42"; // 2026-10-25 v28: 文字を手書き風の丸ゴシック Zen Maru Gothic に（fonts/ を同梱）
const APP_SHELL = ["./", "./index.html", "./app.js", "./icons.js", "./vendor/supabase.js", "./manifest.webmanifest", "./WEBアプリアイコン.png", "./banner.webp"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // POST 等（RPC の呼び出し）はキャッシュを通さない
  if (new URL(request.url).origin !== self.location.origin) return; // 他のサイト（Supabase・配信者のアイコン等）は控えない

  event.respondWith(
    // 通信中に、公開先が少しの間だけ返している古いファイルを控え直さない（2026-10-19）
    fetch(request, { cache: "no-store" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? (request.mode === "navigate" ? caches.match("./index.html") : Response.error()))),
  );
});
