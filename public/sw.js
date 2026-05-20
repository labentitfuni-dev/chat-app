const SW_VERSION = 4;

self.addEventListener('install', (event) => {
  self.skipWaiting(); // 即座に新しいSWを有効化
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim()); // 既存タブにも即反映
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch { return; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'ChatApp', {
      body: data.body || '',
      icon: data.icon || '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [400, 200, 400],
      data: data.data || {},
      requireInteraction: data.data?.type === 'call', // 通話通知は消えない
      actions: [{ action: 'open', title: '開く' }]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  const targetUrl = (data.type === 'call' && data.callUrl) ? data.callUrl : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // 既に開いているウィンドウがあればそこに移動
      for (const c of list) {
        if (c.url.includes(self.location.origin)) {
          c.focus();
          if (data.type === 'call') c.navigate(targetUrl);
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// プッシュ購読が期限切れになったとき自動で再購読
self.addEventListener('pushsubscriptionchange', (event) => {
  const options = event.oldSubscription?.options || event.newSubscription?.options;
  if (!options) return;
  event.waitUntil(
    self.registration.pushManager.subscribe(options)
      .then((sub) => fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub)
      }))
  );
});
