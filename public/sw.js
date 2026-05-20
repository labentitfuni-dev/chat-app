const SW_VERSION = 6;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch { return; }

  const isCall = data.data?.type === 'call';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // アプリがフォアグラウンドで表示中
      const isVisible = clientList.some(c => c.visibilityState === 'visible');
      if (isVisible && !isCall) return; // メッセージ通知はアプリが見えていれば抑制
      // 通話通知はアプリが見えていても表示（別のチャットを開いている可能性があるため）

      const options = {
        body: data.body || '',
        icon: data.icon || '/icon-192.png',
        badge: '/icon-192.png',
        data: data.data || {},
        requireInteraction: isCall, // 通話は消えない
        tag: isCall ? 'incoming-call' : 'message',
        renotify: true,
      };

      if (isCall) {
        // 着信: 長い繰り返しバイブで「電話が鳴る」感覚を演出
        options.vibrate = [500, 300, 500, 300, 500, 300, 500, 300, 500, 300, 500, 300, 500];
        options.actions = [
          { action: 'answer', title: '📞 応答' },
          { action: 'reject', title: '✕ 拒否' }
        ];
      } else {
        options.vibrate = [200, 100, 200];
        options.actions = [{ action: 'open', title: '開く' }];
      }

      return self.registration.showNotification(data.title || 'ChatApp', options);
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  // 「拒否」アクションはそのまま閉じるだけ
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
            c.navigate(targetUrl); // 通話ページへ移動
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
