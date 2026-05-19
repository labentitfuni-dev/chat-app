self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'ChatApp', {
      body: data.body || '',
      icon: data.icon || '/icon.svg',
      badge: data.badge || '/icon.svg',
      vibrate: [200, 100, 200],
      data: data.data || {},
      actions: [{ action: 'open', title: '開く' }]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  // 通話通知の場合はJitsiのURLを直接開く
  if (data.type === 'call' && data.jitsiUrl) {
    event.waitUntil(clients.openWindow(data.jitsiUrl));
    return;
  }

  // 通常のメッセージ通知はアプリを開く
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length > 0) { list[0].focus(); return; }
      return clients.openWindow('/');
    })
  );
});
