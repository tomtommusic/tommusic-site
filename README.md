# tommusic.ca

Site de TOM (Tom Tom Music) : page d'artiste et page MusiDev.
Publié avec GitHub Pages sur https://tommusic.ca


## Traduction anglaise des outils (Chart It, EZ Lyrics, Tonality)
- Le code des outils reste en français. `i18n-head.js` (dans `<head>`) choisit la langue; `i18n.js` traduit l'affichage avec le dictionnaire `en.js` de chaque outil.
- Langue : `?lang=fr` / `?lang=en` > choix mémorisé (`tom-tools-lang`) > langue du navigateur. Google voit l'anglais à l'adresse de base; le français est à `?lang=fr` (balises hreflang).
- **Quand tu ajoutes ou changes un texte français dans un outil, ajoute sa traduction dans `<outil>/en.js`** (`t` pour un texte fixe, `re` pour un texte avec des variables). Un texte absent reste en français, sans rien briser.
