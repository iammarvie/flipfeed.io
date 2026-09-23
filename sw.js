const CACHE="flipfeed-v4";
const ASSETS=["./","./index.html","./style.css","./responsive.css","./app.js","./firebase-sync.js","./manifest.webmanifest","./icons/icon.svg","./vendor/jszip.min.js","./vendor/sql-wasm.js","./vendor/sql-wasm.wasm"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{if(e.request.method!=="GET")return;e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return response}).catch(()=>caches.match("./index.html"))))});
