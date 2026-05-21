const SW_VERSION = 13;
const CACHE_NAME = 'cha-shell-v13';
const HTML_URLS  = ['/', '/call'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // インストール時にメインページをキャッシュしておく（オフライン対応）
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(HTML_URLS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // 古いキャッシュを削除してから claim
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

// HTML: ネットワークファースト → 成功したらキャッシュ更新 → オフライン時はキャッシュ返却
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  const isHtml = event.request.headers.get('accept')?.includes('text/html');
  if (!isHtml && !HTML_URLS.includes(url.pathname)) return;
  if (url.pathname === '/sw.js') return; // SWは自身をキャッシュしない

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then(r => r || caches.match('/')))
  );
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch { return; }

  const type         = data.data?.type || 'message';
  const isCall       = type === 'call';
  const isTest       = type === 'test';
  const isMissedCall = type === 'missedCall';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const isVisible = clientList.some(c => c.visibilityState === 'visible');

      // ===== 着信の場合: 開いているウィンドウに直接メッセージを送り着信UIを起動 =====
      // ソケットが切れていてもSWがブリッジとして機能する
      if (isCall) {
        const fromName = (data.title || '').replace(/^📞\s*/, '') || data.data?.fromName || '';
        clientList.forEach(c => {
          c.postMessage({
            type: 'incoming-call-push',
            fromId:   data.data?.fromId || '',
            fromName,
            callUrl:  data.data?.callUrl || ''
          });
        });
      }

      // フォアグラウンドかつメッセージ通知 → アプリ内バナーに任せるので抑制
      // 着信・テスト・不在着信は常に表示
      if (isVisible && !isCall && !isTest && !isMissedCall) return;

      const fromId = data.data?.fromId;
      const tag    = isCall       ? 'incoming-call'
                   : isTest       ? 'test-notif'
                   : isMissedCall ? 'missed-' + (fromId || 'unknown')
                   : 'msg-' + (fromId || 'unknown');

      const options = {
        body:               data.body || '',
        icon:               data.icon || '/icon-192.png',
        badge:              '/icon-192.png',
        data:               data.data || {},
        requireInteraction: isCall,
        tag,
        renotify:           true,
      };

      if (isCall) {
        options.vibrate = [500,300,500,300,500,300,500,300,500,300,500,300,500];
        options.requireInteraction = true;
        options.silent  = false;
        options.actions = [
          { action: 'answer', title: '📞 応答' },
          { action: 'reject', title: '✕ 拒否'  }
        ];
      } else if (isMissedCall) {
        options.vibrate = [300, 100, 300];
        options.actions = [{ action: 'open', title: '確認する' }];
      } else if (isTest) {
        options.vibrate = [200, 100, 200, 100, 200];
        options.actions = [{ action: 'open', title: '✓ 確認' }];
      } else {
        options.vibrate = [200, 100, 200];
        options.actions = [{ action: 'open', title: '開く' }];
      }

      return self.registration.showNotification(data.title || 'CHA', options);
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  if (event.action === 'reject') return;

  let targetUrl = '/';
  if (data.type === 'call' && data.callUrl) {
    targetUrl = data.callUrl;
  } else if (data.fromId) {
    targetUrl = '/?chat=' + data.fromId;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin)) {
          c.focus();
          if (data.type === 'call') {
            c.navigate(targetUrl);
          } else if (data.fromId) {
            c.postMessage({ type: 'open-chat', fromId: data.fromId });
          }
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
