/* Langues. Page d'artiste : FR / EN (langue du navigateur au départ).
   Page MusiDev : français par défaut, anglais et espagnol en option (data-langs="fr,en,es" data-default="fr"). */
(function(){
  var d=document.documentElement,langs=(d.getAttribute('data-langs')||'fr,en').split(','),def=d.getAttribute('data-default'),key=d.getAttribute('data-key')||'tom-lang',L;
  try{L=localStorage.getItem(key)}catch(e){}
  if(langs.indexOf(L)<0)L=def||(/^fr/i.test(navigator.language||'fr')?'fr':'en');
  var LOC={fr:'fr-CA',en:'en-CA',es:'es'},LAB={fr:'Passer en français',en:'Switch to English',es:'Cambiar a español'};
  function set(l){L=l;d.setAttribute('data-lang',l);d.lang=LOC[l];
    var t=d.getAttribute('data-title-'+l);if(t)document.title=t;
    var b=document.querySelector('.langbtn');
    if(b&&langs.length===2){var o=langs[0]===l?langs[1]:langs[0];b.textContent=o.toUpperCase();b.setAttribute('aria-label',LAB[o]);}
    document.querySelectorAll('.langpick button').forEach(function(x){x.setAttribute('aria-pressed',String(x.dataset.l===l));});}
  set(L);
  document.addEventListener('DOMContentLoaded',function(){
    var b=document.querySelector('.langbtn');
    if(b&&langs.length>2){var g=document.createElement('span');g.className='langpick';g.setAttribute('role','group');g.setAttribute('aria-label','Langue · Language · Idioma');
      langs.forEach(function(l){var x=document.createElement('button');x.type='button';x.dataset.l=l;x.textContent=l.toUpperCase();x.setAttribute('aria-label',LAB[l]);
        x.addEventListener('click',function(){try{localStorage.setItem(key,l)}catch(e){}set(l);});g.appendChild(x);});
      b.replaceWith(g);}
    else if(b)b.addEventListener('click',function(){var n=langs[0]===L?langs[1]:langs[0];try{localStorage.setItem(key,n)}catch(e){}set(n);});
    set(L);});
})();
