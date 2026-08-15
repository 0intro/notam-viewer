/*
 * Kill switch for the service worker this path used to serve.
 *
 * The application that lived at /v2/ has moved to https://loxodrome.fr/. An
 * app installed from here does not notice: its old worker answers navigations
 * from its own precache, so it keeps opening and keeps serving aeronautical
 * data out of a 30-day StaleWhileRevalidate cache. Failing silently would be
 * bad in any app; in this one it means presenting an AIRAC cycle that has
 * expired, which is worse than presenting nothing.
 *
 * A browser re-fetches a worker script bypassing the HTTP cache once the
 * registration is over 24 hours old, so every install picks this up on one of
 * its next launches. It takes control at once, drops every cache, unregisters
 * itself, and sends its clients to the new site.
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			await self.clients.claim();
			const names = await caches.keys();
			await Promise.all(names.map((n) => caches.delete(n)));
			await self.registration.unregister();
			const clients = await self.clients.matchAll({ type: 'window' });
			for (const client of clients) {
				client.navigate('https://loxodrome.fr/');
			}
		})(),
	);
});

// Everything else goes straight to the network: nothing here is cached, and a
// navigation must be able to reach the moved-page notice at /v2/.
self.addEventListener('fetch', () => {});
