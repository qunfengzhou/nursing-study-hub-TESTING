const CACHE = 'nursing-study-hub-v3-3-shell';
const SHELL=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./sync.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async()=>{
    for(const key of await caches.keys()) if(key.startsWith('nursing-study-hub-') && key!==CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if(event.request.method!=='GET' || new URL(event.request.url).origin!==self.location.origin) return;
  const request=event.request;
  if(request.mode==='navigate') {
    event.respondWith(fetch(request).then(response=>{
      if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(c=>c.put('./index.html',copy)));}
      return response;
    }).catch(()=>caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(request).then(hit=>hit || fetch(request)));
});
