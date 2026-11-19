/* Traduction FR → EN des outils (Chart It, EZ Lyrics, Tonality).
   Le code des outils reste en français. Ce script traduit l'affichage à la volée avec le dictionnaire de l'outil
   (window.TOM_EN = { t:{ "texte fr": "english" }, re:[ [/regex fr/, "english $1"] ], skip:"sélecteurs à ne pas traduire", meta:{title,desc} }).
   Langue : ?lang=fr ou ?lang=en dans l'adresse > choix mémorisé > langue du navigateur (français → FR, sinon EN).
   Un texte absent du dictionnaire reste simplement en français : rien ne brise si l'outil change.
   À ajouter dans la page, juste avant les scripts de l'outil :
     <script src="en.js"></script><script src="../i18n.js"></script>
   et dans <head> :  <script src="../i18n-head.js"></script>  (évite le flash de texte français). */
(function(){
  var KEY='tom-tools-lang',D=window.TOM_EN||{t:{},re:[]},L=window.TOM_LANG||'fr',html=document.documentElement;
  var base=location.pathname,FR_URL=base+'?lang=fr',EN_URL=base;

  /* ---------- sélecteur de langue ---------- */
  function addSwitch(){
    var nav=document.querySelector('nav.toplinks');if(!nav||document.querySelector('.langsw2'))return;
    var g=document.createElement('span');g.className='langsw2';g.setAttribute('role','group');g.setAttribute('aria-label','Langue · Language');
    [['fr','FR','Français'],['en','EN','English']].forEach(function(x){
      var a=document.createElement('a');a.href=x[0]==='fr'?FR_URL:EN_URL+'?lang=en';a.textContent=x[1];a.setAttribute('lang',x[0]);a.title=x[2];a.setAttribute('data-notr','');
      if(x[0]===L)a.setAttribute('aria-current','true');
      a.addEventListener('click',function(e){try{localStorage.setItem(KEY,x[0])}catch(er){}});
      g.appendChild(a);});
    nav.appendChild(g);
    var st=document.createElement('style');st.textContent='.langsw2{display:inline-flex;align-items:stretch;border:1px solid var(--line-hi,var(--line,#ccd));border-radius:999px;overflow:hidden;margin-left:6px;align-self:center}'
      +'.langsw2 a,.toplinks .langsw2 a{padding:7px 11px;border:0;border-radius:0;gap:0;font:700 12px/1 var(--ui,system-ui);letter-spacing:.06em;color:var(--muted,#555);text-decoration:none}'
      +'.langsw2 a[aria-current]{background:var(--accent,#333);color:var(--accent-ink,#fff)}.langsw2 a:focus-visible{outline:2px solid var(--accent,#333);outline-offset:-2px}';
    document.head.appendChild(st);
  }
  /* lien canonique et balises de langue (Google) */
  function seo(){
    var c=document.querySelector('link[rel=canonical]');if(!c){c=document.createElement('link');c.rel='canonical';document.head.appendChild(c);}
    c.href=location.origin+(L==='fr'?FR_URL:EN_URL);
  }

  if(L==='fr'){html.classList.remove('tr-wait');document.addEventListener('DOMContentLoaded',function(){addSwitch();seo();});if(document.readyState!=='loading'){addSwitch();seo();}
    if(D.metaFr){document.title=D.metaFr.title;var md=document.querySelector('meta[name=description]');if(md)md.content=D.metaFr.desc;}
    return;}

  /* ---------- traduction ---------- */
  var T=D.t||{},RE=(D.re||[]).map(function(p){return[p[0],p[1]]});
  var N=function(s){return s.replace(/[\s\u00a0\u202f]+/g,' ').replace(/\u2019/g,"'").trim()};
  var TT={};Object.keys(T).forEach(function(k){TT[N(k)]=T[k]});
  function tr(s){
    if(!s)return null;var n=N(s);if(!n||!/[A-Za-zÀ-ÿ]/.test(n))return null;
    var r=TT[n];if(r==null){for(var i=0;i<RE.length;i++){if(RE[i][0].test(n)){RE[i][0].lastIndex=0;r=n.replace(RE[i][0],RE[i][1]);break;}}}
    if(r==null&&n.indexOf(' · ')>0){var ps=n.split(' · '),ch=false;ps=ps.map(function(x){var y=tr(x);if(y!=null){ch=true;return y.trim()}return x});if(ch)r=ps.join(' · ');}
    if(r==null)return null;
    var lead=s.match(/^[\s ]*/)[0],trail=s.match(/[\s ]*$/)[0];return lead+r+trail;
  }
  window.tomTr=function(s){var r=tr(String(s));return r==null?s:r};
  var SKIP='script,style,textarea,code,pre,[contenteditable],[data-notr]'+(D.skip?','+D.skip:'');
  var SKIPA='[data-notr]'+(D.skip?','+D.skip:'');
  var done=new WeakMap();
  function trText(n){
    var v=n.nodeValue;if(done.get(n)===v)return;
    var p=n.parentElement;if(!p||p.closest(SKIP))return;
    var r=tr(v);if(r!=null&&r!==v){n.nodeValue=r;done.set(n,r);}else done.set(n,v);
  }
  var ATTR=['placeholder','title','aria-label','alt'];
  function trAttrs(el){
    if(el.closest&&el.closest(SKIPA))return;
    for(var i=0;i<ATTR.length;i++){var a=el.getAttribute&&el.getAttribute(ATTR[i]);if(a){var r=tr(a);if(r!=null&&r!==a)el.setAttribute(ATTR[i],r);}}
    if(el.tagName==='INPUT'&&/^(button|submit)$/.test(el.type)&&el.value){var r2=tr(el.value);if(r2)el.value=r2;}
  }
  function walk(root){
    if(root.nodeType===3){trText(root);return;}
    if(root.nodeType!==1)return;
    trAttrs(root);
    var w=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT),n;
    while((n=w.nextNode())){if(n.nodeType===3)trText(n);else trAttrs(n);}
  }
  function meta(){
    if(D.meta){document.title=D.meta.title;var md=document.querySelector('meta[name=description]');if(md)md.content=D.meta.desc;}
    else{var t=tr(document.title);if(t)document.title=t;}
  }
  /* boîtes de dialogue, presse-papiers, PDF */
  ['alert','confirm','prompt'].forEach(function(f){var o=window[f];if(!o)return;window[f]=function(m){var a=[].slice.call(arguments);if(typeof m==='string')a[0]=tomTr(m);return o.apply(window,a)};});
  function trLines(s){return String(s).split('\n').map(function(l){return tomTr(l)}).join('\n')}
  try{if(navigator.clipboard&&navigator.clipboard.writeText){var cw=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=function(s){return cw(D.clipboard===false?s:trLines(s))};}}catch(e){}
  function patchPdf(){try{var J=window.jspdf&&window.jspdf.jsPDF;if(!J||J.__tr)return;var ot=J.API.text;J.API.text=function(t){var a=[].slice.call(arguments);
      if(typeof t==='string')a[0]=tomTr(t);else if(Array.isArray(t))a[0]=t.map(function(x){return typeof x==='string'?tomTr(x):x});return ot.apply(this,a)};J.__tr=1;}catch(e){}}

  html.lang='en';
  if(D.before)try{D.before()}catch(e){}
  function start(){
    walk(document.body);meta();addSwitch();seo();patchPdf();
    html.classList.remove('tr-wait');
    new MutationObserver(function(ms){
      for(var i=0;i<ms.length;i++){var m=ms[i];
        if(m.type==='characterData')trText(m.target);
        else if(m.type==='attributes')trAttrs(m.target);
        else for(var j=0;j<m.addedNodes.length;j++)walk(m.addedNodes[j]);}
      if(document.title&&/[éèàç]|\bde\b|\bla\b/.test(document.title))meta();
    }).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:ATTR});
    window.addEventListener('load',patchPdf);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
