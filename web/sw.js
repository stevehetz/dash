// Dash service worker — handles push notifications

self.addEventListener("push", (event) => {
  let data = { title: "Dash", body: "New notification" };
  try {
    data = event.data.json();
  } catch {
    data.body = event.data?.text() || data.body;
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Dash", {
      body: data.body,
      icon: "/avatars/dash2.png",
      badge: "/avatars/dash2.png",
      tag: data.tag || "dash-default",
      data: data.url ? { url: data.url } : undefined,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
