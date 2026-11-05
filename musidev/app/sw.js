/* MusicDEV : cache pour l'utilisation hors ligne.
   Fichiers de l'app : réseau d'abord (pour recevoir les mises à jour), copie en cache si hors ligne
   ou si le site est fermé (404) : l'app installée continue de fonctionner. */
const VERSION='musicdev-1.39.1';
const SHELL=['./','./index.html','./manifest.webmanifest','./abcjs-basic-min.js','./fonts/fonts.css',
  './fonts/AtkinsonHyperlegible-Regular.ttf','./fonts/AtkinsonHyperlegible-Bold.ttf','./fonts/Lora.ttf','./fonts/BricolageGrotesque.ttf',
  './fonts/IBMPlexMono-Regular.ttf','./fonts/IBMPlexMono-Medium.ttf',
  './icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png','./icons/favicon-32.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin!==location.origin)return;
  const fromCache=()=>caches.match(r,{ignoreSearch:true}).then(m=>m||caches.match('./index.html'));
  e.respondWith(fetch(r).then(res=>{
    if(!res.ok)return fromCache().then(m=>m||res);
    const cp=res.clone();caches.open(VERSION).then(c=>c.put(r,cp));return res;
  }).catch(fromCache));
});
