const SW_VERSION = 7;

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

  const type   = data.data?.type || 'message';
  const isCall = type === 'call';
  const isTest = type === 'test';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const isVisible = clientList.some(c => c.visibilityState === 'visible');

      // フォアグラウンドのとき:
      //   - メッセージ通知 → アプリ内バナーに任せるので抑制
      //   - テスト通知    → 常に表示（動作確認用）
      //   - 着信通知      → 常に表示（別チャット画面の可能性あり）
      if (isVisible && !isCall && !isTest) return;

      const fromId = data.data?.fromId;
      const tag    = isCall ? 'incoming-call'
                   : isTest ? 'test-notif'
                   : 'msg-' + (fromId || 'unknown');

      const options = {
        body:              data.body || '',
        icon:              data.icon || '/icon-192.png',
        badge:             '/icon-192.png',
        data:              data.data || {},
        requireInteraction: isCall,
        tag,
        renotify:          true,
      };

      if (isCall) {
        options.vibrate = [500,300,500,300,500,300,500,300,500,300,500,300,500];
        options.actions = [
          { action: 'answer', title: '📞 応答' },
          { action: 'reject', title: '✕ 拒否'  }
        ];
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
