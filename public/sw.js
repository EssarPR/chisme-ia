const CACHE_NAME = 'chisme-ia-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/terminos.html',
  '/privacidad.html',
  '/acerca.html'
];

// Instalación - cachear recursos
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Activación - limpiar cachés antiguos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch - Network First, luego Cache
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Clonar respuesta para guardar en cache
        const responseToCache = response.clone();
        caches.open(CACHE_NAME)
          .then((cache) => cache.put(event.request, responseToCache));
        return response;
      })
      .catch(() => {
        // Si falla la red, intentar desde cache
        return caches.match(event.request);
      })
  );
});