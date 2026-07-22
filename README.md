# 🕯️ Frédéric Vivant — WebAR pour « Les petites leçons de Frédéric »

Pointez la caméra sur la couverture du livre : Frédéric apparaît en 3D au-dessus
des pages, entouré de flammes de chandelles, et **répond à la voix** aux
questions des enfants (Claude en coulisses, en personnage, 2-3 phrases max).

**Zéro installation pour le lecteur** : un QR code dans le livre → le navigateur → la magie.

---

## Architecture

```
public/                    → le site (Cloudflare Pages)
  index.html               → accueil + expérience AR + UI
  ar.js                    → MindAR + Three.js, Frédéric 3D animé, particules
  chat.js                  → micro (fr-FR) → /api/chat → voix
  style.css                → design "chandelles & parchemin"
  targets/frederic.mind    → ⚠️ marqueur à compiler (voir ci-dessous)
  frederic.glb             → (optionnel) modèle 3D pro, remplace le procédural
functions/api/
  chat.js                  → proxy Claude + persona + rate-limit KV (40/jour/IP)
  tts.js                   → voix ElevenLabs optionnelle + cache KV
```

Deux modes :
- **Mode livre** : tracking d'image sur la couverture (MindAR).
- **Mode démo** : sans marqueur — caméra + Frédéric flottant + parallaxe gyroscope.
  Aussi le fallback automatique tant que `frederic.mind` n'est pas compilé.

---

## Déploiement (10 minutes)

### 1. GitHub → Cloudflare Pages
Le flow que tu connais déjà (celui qui marche, pas l'onglet Workers !) :
1. Push ce repo sur GitHub.
2. Dashboard Cloudflare → **Workers & Pages → Pages → Connect to Git**.
3. Build settings : framework **None**, build command vide, output directory **`public`**.
4. Le dossier `functions/` à la racine est détecté automatiquement → routes `/api/*`.

### 2. KV + secrets
1. **KV** : crée un namespace `frederic-kv`, puis dans le projet Pages →
   Settings → Functions → **KV namespace bindings** → nom de variable
   **`FREDERIC_KV`** → ton namespace. (Sinon : pas de rate-limit ni de cache voix,
   mais tout fonctionne quand même.)
2. **Secrets** (Settings → Environment variables, type *Secret*) :
   - `ANTHROPIC_API_KEY` — obligatoire.
   - `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` — optionnels (belle voix).
     Sans eux : synthèse vocale du navigateur, gratuite.
3. Redéploie (Deployments → Retry) pour prendre en compte les bindings.

### 3. Compiler le marqueur de la couverture
1. Prends un **scan/export à plat** de la couverture (le fichier d'impression de
   ton ami est idéal — pas une photo de biais).
2. Va sur le compilateur MindAR : https://hiukim.github.io/mind-ar-js-doc/tools/compile
3. Upload l'image → Start → télécharge `targets.mind`.
4. Renomme-le **`frederic.mind`** et place-le dans `public/targets/`.
5. Commit + push → déploiement auto.

> Conseils marqueur : la couverture est excellente pour le tracking (beaucoup de
> détails et de contraste). Évite les zones brillantes/reflets à l'impression.
> Tu peux ajouter plusieurs pages du livre dans le même compilateur → plusieurs
> ancres (index 0, 1, 2…) → une scène différente par page.

### 4. Le QR code
Génère un QR vers l'URL Pages (ex. `https://frederic-vivant.pages.dev`) et
fais-le imprimer en 2e de couverture : « Scanne-moi, Frédéric t'attend ! »

---

## Upgrade du personnage 3D (optionnel mais spectaculaire)

Le Frédéric procédural (redingote bleue, gilet jaune, plume, favoris !) marche
partout et pèse 0 Ko. Pour un rendu identique aux illustrations :
1. Génère un modèle depuis une illustration du livre (Tripo3D / Meshy, vue de face).
2. Rig + animations : https://www.mixamo.com (upload FBX → auto-rig → "Standing Idle").
3. Exporte en **GLB**, compresse (gltf.report → Draco), vise **< 4 Mo**.
4. Nomme-le `frederic.glb` dans `public/` : il remplace automatiquement le
   personnage procédural, l'animation 0 est jouée en boucle.

## Phase 2 : APK Android

La même webapp dans Capacitor (comme VelohNav) :
```bash
npm init -y && npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init frederic-vivant lu.silexperience.frederic --web-dir=public
npx cap add android && npx cap sync && npx cap open android
```
Permissions à ajouter dans `AndroidManifest.xml` : `CAMERA`, `RECORD_AUDIO`, `INTERNET`.
Bonus APK possibles ensuite : mode hors-ligne (leçons pré-enregistrées),
notifications « la leçon du jour », ARCore pour l'occlusion.

## Coûts

| Poste | Coût |
|---|---|
| Cloudflare Pages + Functions + KV | 0 € (free tier large) |
| Claude Haiku (~220 tokens/réponse, 40 req/jour/IP max) | quelques centimes / jour d'usage réel |
| ElevenLabs (optionnel, avec cache KV) | ~5 $/mois |
| MindAR, Three.js | open source |

## Sécurité intégrée
- Clé API jamais côté client (proxy Functions).
- Rate-limit 40 questions/jour/IP (KV, TTL auto).
- Questions tronquées à 500 caractères, historique limité à 12 messages.
- Persona verrouillé : contenu enfants uniquement, refus doux du reste.
