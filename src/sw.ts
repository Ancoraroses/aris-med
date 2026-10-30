/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<string | { url: string; revision: string | null }> }

// Cachea solo la "carcasa" de la app (HTML/JS/CSS/iconos) para abrirla al instante.
// Los DATOS (tomas, medicación) NUNCA se cachean: siempre vienen del servidor.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

self.addEventListener('install', () => { void self.skipWaiting() })
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })

interface PushPayload { title?: string; body?: string; tag?: string; url?: string }

self.addEventListener('push', (event) => {
  let data: PushPayload = {}
  try { data = event.data ? (event.data.json() as PushPayload) : {} } catch { data = { body: event.data?.text() } }
  const title = data.title ?? 'Aris Med'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body ?? 'Hay una toma pendiente.',
      tag: data.tag,                 // misma etiqueta = se sustituye, no se duplica
      icon: './icon-192.png',
      badge: './icon-192.png',
      requireInteraction: true,
      data: { url: data.url ?? './' }
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? './'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { void c.focus(); return } }
      return self.clients.openWindow(url)
    })
  )
})
