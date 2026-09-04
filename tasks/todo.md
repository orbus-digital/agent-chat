# Tâche : agent-chat-relay V1 — LOT 2 (interface, archive, TTL, migration, publication)

Unité ADLC `agent-chat-relay-c20260904-1840` · spec `specs/agent-chat-relay/spec.md` **V1.1** ·
16 AC au total · LOT 1 livré (PR #1, 8/16).

## Objectif du lot

Les 8 demandes restantes : **AC-06, AC-09, AC-10, AC-12, AC-13, AC-14, AC-15, AC-16** → 16/16.

## Décision d'architecture qui commande tout le lot

L'interface doit chiffrer et vérifier **exactement** comme le CLI. Deux implémentations
(`node:crypto` côté CLI, WebCrypto côté navigateur) auraient divergé un jour, et la divergence
d'un protocole de chiffrement est silencieuse : elle ne casse pas un test, elle rend un message
illisible ou, pire, faussement authentifié.

→ **Un seul noyau isomorphe**, écrit en **WebCrypto pur** (disponible nativement dans Node 22 comme
dans tout navigateur), sans `Buffer`, sans `node:*`. Il vit dans `web/js/core/` — le dossier que
GitHub Pages publie — et `lib/` n'en est plus qu'une façade Node, plus `session.js` qui, lui, est
légitimement propre à Node (système de fichiers).

Conséquence : `seal`/`open`/`sign` deviennent asynchrones (WebCrypto l'est). Le CLI l'était déjà.

## Plan

- [ ] **Noyau isomorphe** — `web/js/core/{bytes,crypto,sign,url,protocol,ntfy}.js` en WebCrypto pur ;
      `lib/*.js` réduits à des réexports ; tests existants adaptés (async) et **toujours verts**
- [ ] **AC-15 `--private-meta`** — `X-Title: ac`, tag `m` ; `from`/`kind` dans le clair chiffré ;
      l'AAD se construit sur ce qui est **réellement publié**, donc reste vérifiable des deux côtés
- [ ] **AC-09 export / replay / import** — `agentchat export` (JSON chiffré), `agentchat replay`
      **sans réseau**, et le même fichier importable dans l'interface
- [ ] **AC-10 TTL** — refus d'écrire passé le TTL, côté CLI (code 3) **et** côté interface ;
      lecture et export restent possibles
- [ ] **AC-16 `control:migrate`** — `agentchat migrate` publie l'ordre, `tail` bascule sur le nouveau
      topic sans perte (5 messages avant, 5 après)
- [ ] **AC-06 + AC-13 interface** — `web/index.html` + modules : accueil (créer → URL + QR), salon
      (fil déchiffré en direct, roster, état de connexion, export/import, sélecteur de serveur),
      mode observateur `ro=1` sans zone d'écriture, « clé absente » sans fragment `k` ;
      CSP stricte `default-src 'self'; connect-src <NTFY_BASE_URL>`, 390 px et écran large,
      thème clair/sombre, indicateur `GET {NTFY}/v1/health`
- [ ] **Publication Pages** — workflow GitHub Actions publiant `web/` (le mode « branche » de Pages
      ne sait servir que `/` ou `/docs`, jamais `/web` : l'artefact est donc explicite)
- [ ] **AC-12** — tests d'intégration complets, couverture ≥ 80 % maintenue sur le noyau
- [ ] **AC-14 README** — mode d'emploi vérifiable en moins de 10 minutes, Node 22 + navigateur
- [ ] Commits conventionnels, PR vers `dev`, compteur d'unité à 16/16

## Risques

- **Refactorisation d'un noyau vert** : chaque module est déplacé puis les tests sont relancés
  immédiatement ; aucune fonctionnalité n'est ajoutée pendant le déplacement.
- **CSP stricte** : `connect-src` doit contenir le serveur ntfy choisi. Un sélecteur de serveur
  libre et une CSP stricte sont contradictoires ; l'interface documente et applique une liste
  restreinte (méta CSP + vérification à l'exécution).
- **Pas de dépendance** : le QR code est dessiné par un encodeur maison minimal, ou remplacé par un
  lien copiable si l'encodeur devient plus coûteux que le service rendu.
- **Dépôt public (R6)** : aucun secret, aucun nom de client, aucun projet interne dans le code,
  les tests, les jeux d'essai.

## Retour arrière

`git checkout dev && git branch -D feat/agent-chat-relay-lot2`. Le lot est empilé sur
`feat/agent-chat-relay-lot1` (PR #1 encore ouverte) ; sa PR vise `dev`.

## Vérification

```bash
npm test                 # unitaires + acceptation + portail de couverture
npx serve web            # interface : accueil, salon, observateur, import d'export
```

## Notes de revue
(à compléter en fin de lot)

## Notes de revue — LOT 2

**301 tests verts**, couverture au-dessus du seuil sur les sept modules gardés
(`lib/crypto` 98,6 % · `lib/sign` 100 % · `lib/ntfy` 99,5 % · `web/js/etat` 100 % ·
`web/js/salon` 98,4 % · `web/js/app` 89,6 % · `web/js/qr` 100 %).

### La décision qui a commandé le lot

Le noyau est devenu **isomorphe**, en WebCrypto pur. C'était l'alternative au fait d'écrire deux
implémentations du protocole, une par runtime — et une divergence entre elles n'aurait cassé aucun
test : elle aurait rendu un message illisible, ou faussement authentifié. `web/lib` est un lien
symbolique vers `lib/`, donc GitHub Pages sert exactement les fichiers que la suite éprouve, sans
copie et sans étape de construction. `test/isomorphisme.test.js` garde l'invariant, parce que rien
d'autre ne signalerait une régression qui réintroduit `Buffer` : le CLI resterait vert, et
l'interface tomberait en production.

### Ce qui a été appris en route

- **GitHub Pages ne sait pas servir `/web`** en mode « branche » : seulement la racine ou `/docs`.
  D'où un workflow qui construit l'artefact et matérialise le lien symbolique au dernier moment.
- **`ntfy` accuse réception avant de servir le message dans son cache** : un `join` immédiatement
  après un `create` ne trouve pas toujours le roster. Sans conséquence — les rosters sont cumulatifs
  et le suivant complète la liste — mais le taire aurait donné à croire la session vide, donc le CLI
  le dit maintenant.
- **Une CSP stricte et un sélecteur de serveur libre se contredisent.** L'interface applique une
  liste restreinte (`connect-src`) et explique le refus au lieu de laisser une requête échouer sans
  raison visible.
- **Le double de DOM est construit depuis les identifiants réels de `index.html`**, attribut
  `hidden` compris. Un identifiant renommé dans la page sans l'être dans le code fait donc échouer
  les tests, alors qu'un navigateur ne l'aurait signalé qu'à l'exécution.

### Le code QR (§2.3)

Écrit sur place, sans dépendance : la page ne charge aucune ressource externe. Un QR faux étant
pire que pas de QR, il est éprouvé par trois garde-fous indépendants — les informations de format
et de version comparées aux tables publiées de la norme, les mots de correction vérifiés par leurs
**syndromes** (calcul que l'encodeur ne fait jamais), et une relecture module par module qui doit
rendre le texte de départ. Un test retourne délibérément un module pour prouver que la vérification
a du mordant.

### Ce qui reste à un humain

`npm test` couvre les règles, pas le rendu. Restent à voir dans un vrai navigateur : l'absence
d'erreur en console, l'aspect à 390 px et sur grand écran, et le thème sombre. Le README donne la
marche à suivre en quatre étapes (`npm run web`), et la démonstration CLI a été rejouée telle quelle
contre `ntfy.sh` : deux agents ont conversé, le message est arrivé `verified: true`.
