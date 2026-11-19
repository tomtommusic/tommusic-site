/* Consentement aux témoins publicitaires (Loi 25) — tommusic.ca
   Par défaut : rien n'est chargé. Les pubs Google ne se chargent qu'après « Accepter ».
   Utilisation sur une page d'outil : <script src="../consent.js" data-ads="ca-pub-7421337246459807"></script>
   Sans data-ads, le script sert seulement au bouton « Revoir mon choix » (page de confidentialité). */
(function(){
  var KEY='tom-consent-pub',me=document.currentScript,ADS=me&&me.getAttribute('data-ads'),loaded=false;
  function get(){try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch(e){return null}}
  function put(v){try{localStorage.setItem(KEY,JSON.stringify({v:v,d:new Date().toISOString().slice(0,10)}))}catch(e){}}
  function loadAds(){if(loaded||!ADS)return;loaded=true;var s=document.createElement('script');s.async=true;s.crossOrigin='anonymous';
    s.src='https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client='+ADS;document.head.appendChild(s);
    document.documentElement.classList.add('pub-on');document.dispatchEvent(new Event('tom-pub-ok'));}
  var root=(me&&me.src.indexOf('/consent.js')>-1)?me.src.replace(/consent\.js.*$/,''):'/';
  var css='.tcb{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:720px;margin:0 auto;background:#1d2330;color:#f1f3f7;border-radius:14px;padding:14px 16px;box-shadow:0 10px 30px rgb(0 0 0/.3);font:14px/1.45 system-ui,-apple-system,sans-serif;display:flex;gap:12px 16px;align-items:center;flex-wrap:wrap}'
   +'.tcb p{margin:0;flex:1 1 320px}.tcb a{color:#9fd3f2}.tcb .b{display:flex;gap:8px;flex:0 0 auto}'
   +'.tcb button{font:600 14px/1 system-ui,sans-serif;padding:10px 14px;border-radius:10px;cursor:pointer;border:1px solid #6b7486;background:transparent;color:#f1f3f7}'
   +'.tcb button.ok{background:#f1f3f7;color:#1d2330;border-color:#f1f3f7}.tcb button:focus-visible{outline:3px solid #9fd3f2;outline-offset:2px}';
  function banner(){if(document.querySelector('.tcb'))return;var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
    var d=document.createElement('div');d.className='tcb';d.setAttribute('role','dialog');d.setAttribute('aria-label','Témoins publicitaires');
    var en=/^en/i.test(document.documentElement.lang||'');
    d.innerHTML='<p>'+(en?'This free tool can show Google ads, which use cookies. Ads load only if you accept.'
      :'Cet outil gratuit peut afficher des publicités Google, qui utilisent des témoins (cookies). Elles ne se chargent que si tu acceptes.')
      +' <a href="'+root+'confidentialite.html">'+(en?'Learn more':'En savoir plus')+'</a></p><div class="b"><button type="button" class="no">'+(en?'Decline':'Refuser')+'</button><button type="button" class="ok">'+(en?'Accept':'Accepter')+'</button></div>';
    d.querySelector('.no').onclick=function(){put('non');d.remove();};
    d.querySelector('.ok').onclick=function(){put('oui');d.remove();loadAds();};
    document.body.appendChild(d);}
  function start(){
    document.querySelectorAll('[data-consent-reset]').forEach(function(b){b.addEventListener('click',function(){try{localStorage.removeItem(KEY)}catch(e){}banner();});});
    if(!ADS)return;var c=get();if(c&&c.v==='oui')loadAds();else if(!c)banner();}
  window.tomConsent={get:function(){var c=get();return c&&c.v},reset:function(){try{localStorage.removeItem(KEY)}catch(e){}banner();}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
