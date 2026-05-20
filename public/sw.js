const SW_VERSION = 5;

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

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // アプリが画面に表示中なら通知を出さない（通話は除く）
      const isVisible = clientList.some(c => c.visibilityState === 'visible');
      if (isVisible && data.data?.type !== 'call') return;

      return self.registration.showNotification(data.title || 'ChatApp', {
        body: data.body || '',
        icon: data.icon || '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: [400, 200, 400],
        data: data.data || {},
        requireInteraction: data.data?.type === 'call',
        actions: [{ action: 'open', title: '開く' }]
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

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
          if (data.fromId && data.type !== 'call') {
            // 既に開いているアプリにpostMessageでチャットを開かせる
            c.postMessage({ type: 'open-chat', fromId: data.fromId });
          } else if (data.type === 'call') {
            c.navigate(targetUrl);
          }
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
