/* Choix de la langue des outils, avant l'affichage (voir i18n.js). Cache la page le temps de la traduire. */
(function(){
  var KEY='tom-tools-lang',q=null,L=null;
  try{q=new URLSearchParams(location.search).get('lang')}catch(e){}
  if(q==='fr'||q==='en'){L=q;try{localStorage.setItem(KEY,q)}catch(e){}}
  if(!L){try{L=localStorage.getItem(KEY)}catch(e){}}
  if(L!=='fr'&&L!=='en')L=/^fr/i.test(navigator.language||'')?'fr':'en';
  window.TOM_LANG=L;
  if(L==='en'){var h=document.documentElement;h.lang='en';h.classList.add('tr-wait');
    var s=document.createElement('style');s.textContent='html.tr-wait body{visibility:hidden}';document.head.appendChild(s);
    setTimeout(function(){h.classList.remove('tr-wait')},2500);}
})();
