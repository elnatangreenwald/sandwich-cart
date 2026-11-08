self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'עדכון להזמנה', body: event.data && event.data.text() }; }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'order-push', data });

    await self.registration.showNotification(data.title || 'עדכון להזמנה', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'order',
      renotify: true,
      requireInteraction: data.status === 'ready',
      vibrate: data.status === 'ready' ? [300, 120, 300, 120, 500] : [200, 100, 200],
      lang: 'he',
      dir: 'rtl',
      data: { url: data.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data && event.notification.data.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client) return client.navigate(url);
        return undefined;
      }
    }
    return self.clients.openWindow(url);
  })());
});
