/**
 * Service Worker。オフラインでも起動できるようにする。
 *
 * アプリ本体（HTML/CSS/JS）は install 時にまとめて取得しておく。
 * ただし取り出しはネットワーク優先にしてある。キャッシュ優先だと更新した
 * ファイルが古いまま返り続けてしまうため（オフライン時だけキャッシュを使う）。
 *
 * キャラクターアイコンは公式 CDN から実行時に読むものなので、
 * 一度表示したぶんだけ別キャッシュに貯める（取れなければ色付きの円で代替表示される）。
 * URL にハッシュが入っていて中身が変わらないのでキャッシュ優先でよい。
 *
 * SHELL_FILES を変えたら VERSION を上げること。古いキャッシュは activate で消える。
 */
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const ICONS = `icons-${VERSION}`;

// 相対パスで並べる。GitHub Pages のサブパス配信でもそのまま効く
const SHELL_FILES = [
  './',
  'index.html',
  'styles.css',
  'game.js',
  'items.js',
  'audio.js',
  'data/characters.js',
  'vendor/matter.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const ICON_HOST = 'images.microcms-assets.io';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== ICONS).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // キャラクターアイコン: 一度取れたらキャッシュから返す（CDN 側も 1 年キャッシュ）
  if (url.hostname === ICON_HOST) {
    e.respondWith(
      caches.open(ICONS).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch (err) {
          // オフラインで未キャッシュなら諦める（アイコンは色付きの円で代替される）
          return Response.error();
        }
      })
    );
    return;
  }

  // アプリ本体: 同じオリジンのものだけ扱う
  if (url.origin !== self.location.origin) return;

  // アプリ本体はネットワーク優先。取れたら次のオフラインに備えて貯め直す
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then(
        (hit) => hit || (request.mode === 'navigate' ? caches.match('index.html') : Response.error())
      ))
  );
});
