# Tâche : agent-chat-relay — recette visuelle V1 et correctifs UI (LOT 1)

Unité ADLC `agent-chat-relay-c20260907-0854` · spec `specs/agent-chat-relay/spec.md` **V1.1** ·
branche `feat/agent-chat-relay-c20260907-0854-lot1` depuis `dev`.

## Objectif

La V1 est fonctionnellement complète (16/16 AC, PR #1 et #2 fusionnées dans `dev`). Il restait
la seule chose que `npm test` ne sait pas voir : **le rendu**. Cette unité passe l'interface au
navigateur réel, fait converser deux CLI contre `ntfy.sh`, et corrige ce que la recette révèle,
avant la promotion `dev` → `main`.

## Ce que la recette a révélé

Recette menée avec Chromium (Playwright) contre `npm run web` sur `127.0.0.1:8123`, et deux CLI
`agentchat` contre le vrai `ntfy.sh`. Journal complet dans « Notes de revue ».

- [x] **D-01 — `npm test` est rouge.** Le test TTL de `interface-salon` attend un prédicat vrai
      dès le départ (`ttl.expire` vaut `true` tant qu'aucun roster n'a été lu) : il n'attend donc
      rien, et l'assertion suivante gagne ou perd à la course. Vert isolément, rouge sous couverture.
- [x] **D-02 — Champs hauts de 192 px sur téléphone.** À ≤ 390 px, `.ligne` passe en colonne ;
      `flex: 1 1 12rem` cesse d'être une largeur et devient une **hauteur**. La zone de saisie et
      les deux champs de lien deviennent des boîtes de 192 px.
- [x] **D-03 — Case « métadonnées privées » décrochée de son libellé** à ≤ 390 px : la case est
      empilée au-dessus du texte, centrée, sans lien visuel avec lui.
- [x] **D-04 — La zone d'écriture masque le fil.** `position: sticky; bottom: 0` + D-02 :
      sur 390 × 844, le composeur occupe 311 px et se peint par-dessus les messages.
      **Aucun message n'est lisible sur un téléphone.**
- [x] **D-05 — Aucun défilement vers le message le plus récent.** 14 messages, `scrollY = 0` :
      l'arrivant voit le plus ancien et doit faire défiler à la main. Pour un fil en direct (AC-06),
      c'est le message qui vient d'arriver qu'il faut voir.
- [x] **D-06 — Indicateur de santé mort sur l'accueil.** `rafraichirSante()` sort tout de suite
      s'il n'y a pas de salon : l'accueil affiche « bus : vérification… » indéfiniment. AC-13
      demande que l'indicateur soit vert depuis l'interface.
- [x] **D-07 — `--ui` documenté mais ignoré.** `create` et `migrate` lisent `ctx.uiBase` et jamais
      `values.ui` : la recette locale n'est possible que par `AGENTCHAT_UI_BASE`.
- [x] **D-08 — La recette n'est pas rejouable.** Aucun scénario navigateur au dépôt. Ajouter
      `scripts/recette-visuelle.mjs` (`npm run recette`) : accueil, création, salon, observateur,
      clé absente, à 390 px et 1440 px, thèmes clair et sombre, **échec sur toute erreur console**
      et sur les régressions ci-dessus.

## Ce que la recette a validé (sans correctif)

Deux CLI conversent contre `ntfy.sh` en `verified:true` · le fil se déchiffre en direct dans le
navigateur · le roster se remplit · le mode observateur n'affiche pas de zone d'écriture · « clé
absente » sans fragment `k` · export téléchargé puis réimporté (14 → 28 messages) · thème sombre et
écran large corrects · navigation clavier · **zéro erreur console** sur tous les parcours.

## Risques

- **CSS sans test automatisé** : c'est précisément pourquoi D-08 vient avec les correctifs et non
  après. Chaque correctif de mise en page est écrit **après** l'assertion qui le réclame.
- **Playwright n'est pas une dépendance du dépôt** et ne doit pas le devenir : AC-14 promet « Node 22
  et un navigateur seulement ». `scripts/recette-visuelle.mjs` le résout dynamiquement et se
  déclare ignoré, avec la marche à suivre, s'il est absent. `npm test` reste sans dépendance.

## Retour arrière

`git checkout dev && git branch -D feat/agent-chat-relay-c20260907-0854-lot1`.

## Vérification

```bash
npm test                       # unitaires + acceptation + portail de couverture
npm run web &                  # interface servie localement
npm run recette                # scénario navigateur, 0 erreur console attendue
```

## Notes de revue — LOT 1

**8 demandes sur 8**, `npm test` vert (couverture au-dessus du seuil sur les sept modules gardés :
`lib/crypto` 98,6 % · `lib/sign` 100 % · `lib/ntfy` 99,5 % · `web/js/etat` 100 % · `web/js/salon`
98,5 % · `web/js/app` 92,8 % · `web/js/qr` 100 %), `npm run recette` vert : 25 vérifications, zéro
erreur console. Trois correctifs de l'atelier (nom mémorisé, écouteurs avant `demarrer`,
`frame-ancestors` retiré du `<meta>`) sont repris tels quels au bas de la branche.

### Ce que la recette a réellement changé

Sur un téléphone de 390 × 844, **aucun message n'était lisible** avant ce lot. Pas « mal
présenté » : la zone d'écriture occupait 311 px, se peignait par-dessus le fil, et la page restait
bloquée en haut. Un salon de conversation où l'on ne voit aucune conversation passait pourtant
315 tests verts — parce qu'aucun d'eux ne regardait un écran. C'est le seul enseignement du lot qui
vaille d'être retenu : la suite couvrait les règles, et rien de ce qui les rend visibles.

### Les trois pièges, et pourquoi ils n'étaient pas visibles autrement

- **`flex-basis` change de sens avec la direction.** `.ligne` passe en colonne sous 390 px, et
  `flex: 1 1 12rem` cesse alors d'être une largeur pour devenir une hauteur : un champ de saisie de
  192 px. Rien ne le signale — ni le HTML, ni le CSS, ni un test de règle métier. Il faut mesurer
  la boîte dans un navigateur, ce que fait désormais `npm run recette`.
- **Une distance au bas de page ne dit pas si le lecteur suit.** La première version du suivi
  mesurait « suis-je à moins de 120 px du bas ? » : pendant une rafale, la page grandit plus vite
  qu'elle ne défile et la mesure décroche dès le sixième message, sans que le lecteur ait bougé.
  Le navigateur a démenti l'idée ; on suit maintenant son **geste**, ce qu'un défilement provoqué
  par nous ne peut pas imiter puisqu'il va toujours vers le bas.
- **Un test peut attendre un drapeau déjà vrai.** `ttl.expire` vaut vrai tant qu'aucun roster n'a
  été lu — le sens prudent du doute. Le test AC-10 l'attendait : il n'attendait donc rien, et
  gagnait ou perdait à la course. Vert isolément, rouge sous couverture. C'est la deuxième fois que
  ce dépôt trouve un test probabiliste ; le premier altérait un chiffre dans son base64.

### Deux options documentées mais mortes

`--ui` figurait dans le mode d'emploi et dans les options acceptées, sans être lu nulle part.
L'indicateur de santé du bus sortait immédiatement s'il n'y avait pas de salon, c'est-à-dire
toujours à l'accueil — le seul écran où l'on choisit son bus. Les deux ont la même forme : une
promesse écrite que rien ne vérifiait. Elles ont désormais des tests, dont celui qui exige
qu'**aucune requête ne parte** vers un bus que la politique de sécurité bloquerait.

### Ce qui a été vérifié en vrai

Deux CLI `agentchat` contre `ntfy.sh` public (`verified: true` des deux côtés), rejoints par un
troisième participant depuis le navigateur, roster à trois, TTL de 2 h annoncé et tenu, export
téléchargé puis réimporté. Captures dans `recette/`. Aucune dépendance ajoutée au dépôt :
`npm audit` n'a rien à auditer, et c'est voulu (AC-14).

### Ce qui restait après le lot 1

- **D-09** — `join` réinventait la durée de vie d'une session. → traité au lot 2.
- **D-10** — aucun retour visible après « Copier » un lien. → traité au lot 2.
- **Activer GitHub Pages** sur `orbus-digital/agent-chat` (source : GitHub Actions) reste un geste
  humain ; le workflow `pages.yml` est prêt.

---

## LOT 2 — les deux demandes que la recette a fait apparaître

Branche `feat/agent-chat-relay-c20260907-0854-lot2`, **empilée** sur celle du lot 1 (PR #4 encore
ouverte, comme les lots 1 et 2 de la V1 l'avaient été). Sa PR vise `dev`.

- [x] **D-09 — Une durée de vie ne s'invente pas (R4).** `create --ttl 2` puis `join` aussitôt
      après, et la session devient une session de 24 h **pour tout le monde** : ntfy accuse
      réception avant de servir depuis son cache, le rejoignant ne trouve pas le roster du
      créateur, retombe sur 24 h et sur l'instant présent, puis **publie ce roster**. Comme tout
      client reprend la durée du dernier roster lu, la durée inventée par un arrivant remplace
      celle du créateur.
      → Une durée **supposée** n'est jamais publiée (`ttlSuppose`) : le rejoignant annonce sa
      présence, rien de plus. Ne rien savoir de la durée n'est pas la savoir dépassée : il peut
      écrire. Et un roster muet sur la durée n'efface plus celle qu'un roster antérieur portait —
      `dernierRoster` remonte jusqu'à celui qui l'annonce.
- [x] **D-10 — « Copier » ne disait rien.** Un presse-papier qui reçoit sans le dire ne se
      distingue pas d'un bouton mort, et l'on recopie alors le lien observateur en croyant tenir
      le lien participant — l'un donne le droit d'écrire, l'autre non.
      → Une ligne d'état nomme le lien copié ; un refus du presse-papier est dit avec sa raison et
      le repli manuel ; sans API du tout, on échoue franchement au lieu de rendre `undefined`, que
      l'appelant prenait pour un succès.

### Vérification du lot 2

`npm test` vert · `npm run recette` vert, **27 vérifications**, dont la lecture réelle du
presse-papier du navigateur pour s'assurer que c'est bien le lien participant qui s'y trouve.

---

# Tâche : agent-chat-relay — imposer HTTPS sur le bus ntfy (LOT 3, sécurité)

Unité ADLC `agent-chat-relay-c20260907-2348` · origine `review_finding` (suite **HR-20260907-003**) ·
spec `specs/agent-chat-relay/spec.md` **V1.1** ·
branche `feat/agent-chat-relay-c20260907-2348-lot3` depuis `dev`.

## Objectif

La revue de sécurité du LOT 2 a rendu un verdict `concerns` / MEDIUM avec **trois constats de même
racine** : l'URL du bus ntfy est acceptée telle quelle, sans contrainte de schéma, en trois endroits
(`--server` du CLI, paramètre `s` du lien de session, appels `fetch` du transport). Une URL `http://`
y passe sans un mot, et le salon retombe en clair sans que personne ne l'ait décidé.

Le chiffré ne fuite pas pour autant — AES-256-GCM tient — mais **les métadonnées, si** : `X-Title`
(le nom de l'auteur) et `X-Tags` (le `kind`) voyagent en en-têtes HTTP, donc en clair sur le réseau,
et l'identifiant de topic avec eux. C'est exactement ce que `--private-meta` sert à protéger : sur
`http://`, l'option ne protège plus de rien vis-à-vis d'un observateur du réseau.

Ce lot ferme les trois constats, et le seul FAIL de la revue DevOps (`.env.example` absent).

## Ce que la revue a demandé

- [x] **D-11 — Une seule garde de schéma, partagée.** `lib/url.js` expose `normaliseServeur(url, {allowInsecure})` :
      `https://` accepté ; `http://` refusé avec un message qui dit quoi faire ; autre schéma ou
      absence de schéma refusés. Un seul endroit décide, les trois autres l'appellent.
- [x] **D-12 — Le lien de session ne peut pas porter d'URL en clair.** `buildSessionUrl` valide `server`
      avant de l'encoder dans `&s=` : on ne fabrique pas un lien qui dégradera celui qui l'ouvrira.
- [x] **D-13 — Un lien reçu ne peut pas nous faire retomber en clair.** `parseSessionUrl` valide le
      `server` décodé de `&s=`. C'est le vecteur le plus sérieux : le lien vient d'un tiers.
- [x] **D-14 — Le transport garde la porte.** `lib/ntfy.js` (`publish`, `poll`, `subscribe`/SSE) refuse
      toute base qui n'est pas `https://`, sauf boucle locale. Défense en profondeur : c'est la seule
      couche qui parle au réseau, elle ne doit pas dépendre du bon vouloir de ses appelants.
- [x] **D-15 — `--allow-insecure`, réservée à la boucle locale.** Option de développement, documentée
      dans l'aide et le README, appliquée à `--server` **et** à toute lecture d'URL de session.
      `http://` hors `localhost`/`127.0.0.1`/`[::1]` reste refusé **même avec l'option**.
- [x] **D-16 — `NTFY_BASE_URL` lu depuis l'environnement.** La spec §10 déclare cette variable ; le
      code ne la lisait pas. Précédence : `--server` > `NTFY_BASE_URL` > défaut. Sans quoi le
      `.env.example` de D-18 documenterait une variable que rien ne lit.
- [x] **D-17 — L'interface tenue à la même règle.** `sonderSante` (web) passe par la garde partagée,
      et le sélecteur de serveur de l'accueil refuse une saisie `http://` avec le même message.
- [x] **D-18 — `.env.example` + README.** Variables documentées, **aucune valeur réelle** (R6).

## Décisions de conception

**Deux niveaux de sévérité, volontairement.** Le transport (`lib/ntfy.js`) applique l'invariant
objectif — *jamais de clair vers le réseau* — et laisse passer `http://127.0.0.1` sans rien demander,
parce qu'il ne peut pas connaître l'intention de son appelant et qu'un serveur de test local n'est pas
une fuite. Le CLI et le lien de session appliquent la **politique**, plus stricte : `http://` exige un
consentement explicite (`--allow-insecure`) *en plus* d'être sur la boucle locale. Un seul niveau
n'aurait pas suffi : au niveau transport seul, un `--server http://localhost` passait en silence ;
au niveau CLI seul, tout appelant du noyau contournait la garde.

**Refuser plutôt que réécrire.** On ne transforme pas `http://` en `https://` en silence : l'URL
appartient à l'utilisateur, et une réécriture muette produirait un échec réseau incompréhensible
là où un refus explicite dit ce qui ne va pas.

## Risques

- Les tests existants (`acceptance`, `cli-unit`, `interface-*`) parlent tous à un faux ntfy en
  `http://127.0.0.1:<port>`. Ils devront porter `--allow-insecure` — c'est le prix, et c'est aussi
  la preuve que la garde mord.
- `web/lib` est un lien symbolique vers `lib/` (noyau isomorphe) : la garde doit rester en WebCrypto
  pur, sans `node:*` ni `Buffer`. `new URL()` est disponible des deux côtés.

## Retour arrière

`git revert` du commit de lot, ou `--allow-insecure` en attendant. Aucune migration, aucun état
persistant modifié : les fichiers de session existants gardent leur champ `server` tel quel.

## Vérification

- `npm test` vert, couverture du noyau au-dessus du seuil AC-12.
- `npm run recette` (scénario navigateur) vert, zéro erreur console.
- `grep -rn "http://" lib/ web/js/` : aucune URL de bus en dur.

## Notes de revue — LOT 3

**Ce que la garde a réellement trouvé, une fois posée.** Un trou que la revue n'avait pas nommé :
`busAutorise`, dans l'interface, accepte le bus **de même origine que la page**, pour permettre la
recette locale. Sur une page servie en `http://` ailleurs que sur la boucle locale, cela revenait à
accepter un bus `http://` public — la liste blanche disait oui, et rien d'autre ne regardait le
schéma. C'est maintenant refusé, avec le message du noyau, et éprouvé
(`test/interface-page.test.js`, « une page servie en clair hors boucle locale ne propose pas son
propre bus »).

**Ce que les tests ont coûté, et pourquoi c'est un gain.** Toute la suite parle à un faux ntfy en
`http://127.0.0.1`. Plutôt que d'exempter les tests, ils portent `AGENTCHAT_ALLOW_INSECURE=1` —
la même variable que celle documentée dans `.env.example`. La contrainte est donc *visible* dans le
harnais au lieu d'être contournée, et le refus, lui, est éprouvé sans ce consentement dans
`test/serveur.test.js`. Deux tests d'interface ont dû être remontés depuis l'origine locale : un
lien vers un bus en clair n'est utilisable que depuis une page elle-même servie en clair localement
— ce qu'un navigateur imposerait de toute façon par le blocage du contenu mixte.

**`NTFY_BASE_URL` n'était pas lue.** La spec §10 la déclare depuis la V1 ; le code ne lisait que
`AGENTCHAT_UI_BASE`. Écrire un `.env.example` qui la documente sans la faire lire aurait produit
un fichier menteur : elle est donc branchée (précédence `--server` > `NTFY_BASE_URL` > défaut), et
elle passe la même garde — une variable d'environnement n'est pas un blanc-seing.

**Ce qui n'a pas été fait, et pourquoi.** Aucune tentative de mémoriser le consentement dans le
fichier de session, bien que ce soit l'ergonomie évidente : `parseSessionUrl` a lieu **avant** que
le topic soit connu, donc avant que la session locale puisse être chargée. Inverser cet ordre pour
une commodité aurait coûté plus cher que la variable d'environnement, qui rend le même service.
Détail dans ADR-002.

**Vérifié.** `npm test` : 383 tests verts, `lib/serveur.js` à 100 % (et désormais sous seuil dans
`scripts/run-tests.mjs` — une garde non couverte est une garde dont on ne sait pas si elle mord).
`npm run recette` : Chromium réel contre l'interface servie, session créée avec le CLI sur le vrai
`ntfy.sh`, 29 vérifications vertes, **zéro erreur console** (AC-13). Messages de refus relus à la
main sur les six cas (distant, local, option sur distant, sans schéma, `NTFY_BASE_URL`, lien forgé) :
code 2 partout, et chacun propose l'URL à écrire à la place.

---

# Tâche : agent-chat-relay — l'appairage sans serveur d'autorisation (LOT 1)

Décision **ADR-003** (`docs/adr/ADR-003-appairage-sans-serveur-dautorisation.md`, `9f325a8`),
demandée par l'exploitant du projet · branche `feat/agent-chat-relay-c20260915-0838-lot1` depuis
`dev` (les lots précédents sont fusionnés : on ne les empile pas).

## Objectif

Aujourd'hui, entrer dans un salon veut dire **recevoir un lien qui porte la clé**. Le fragment ne
part jamais au serveur — mais le lien, lui, voyage : presse-papiers, historique, ticket, capture
d'écran. Chaque passage est une copie complète du pouvoir de lire et d'écrire, et aucune n'est
révocable.

ADR-003 garde l'expérience du *device login* (un code court, dicté) et **supprime l'arbitre** : le
bus sert de point de rendez-vous, la cryptographie asymétrique remplace le serveur d'autorisation.
L'ADR est **actée** : ses paramètres ne se rediscutent pas ici, ils s'implémentent.

## Le déroulé, et le point qui le fait tenir

1. Le demandeur génère une paire éphémère **ECDH P-256**.
2. Le **code EST l'empreinte** de sa clé publique : 10 caractères base32 sans ambiguïtés (~50 bits).
3. Il publie sa clé publique sur le sujet d'appairage **dérivé du code**, et s'y abonne.
4. Il dicte le code à un humain — `KXR7-2M4Q-9T`.
5. Un membre saisit le code, récupère la clé publique, **vérifie que son empreinte est exactement
   le code saisi**, puis publie la clé de session **scellée pour cette clé**.
6. Le demandeur ouvre et entre.

Le sujet d'appairage est **public** : quiconque connaît le code y lit la clé publique du demandeur.
C'est sans conséquence — une clé publique est publique. La seule attaque qui compte est la
**substitution de clé**, et la parade est que le code est l'empreinte : substituer une clé change
l'empreinte, donc le code ne correspond plus, donc le membre refuse.

## Les demandes du lot

- [x] **D-19 — Le protocole dans `lib/appairage.js`**, au même niveau que `crypto.js` et `sign.js` :
      empreinte et code (base32 sans ambiguïtés, 10 caractères), sujet dérivé du code, offre,
      octroi scellé (ECDH P-256 → HKDF-SHA-256 → AES-256-GCM), et les trois refus. **WebCrypto pur,
      aucune dépendance ajoutée, aucun `node:*`** : le fichier est aussi chargé par le navigateur à
      travers `web/lib`.
- [x] **D-20 — Deux verbes de CLI.** `agentchat pair` (côté demandeur : génère, publie, imprime le
      code, attend) et `agentchat authorize <url> <code>` (côté membre : récupère, vérifie
      l'empreinte, scelle, publie).
- [x] **D-21 — Le côté interface.** Un membre doit pouvoir **autoriser depuis le navigateur** :
      champ de code dans le salon, visible seulement quand on a le droit d'écrire, et qui dit ce
      qu'il a fait — ou pourquoi il a refusé.
- [x] **D-22 — Les tests, dont les trois qui comptent** : la **substitution de clé publique** doit
      être refusée ; un **code expiré** doit être refusé ; un **code déjà consommé** doit être
      refusé. Unitaires, acceptation de bout en bout (vrais processus, faux ntfy), et interface.
- [x] **D-23 — La documentation** : README (dont ce que l'appairage ne résout pas), kit de session
      de la skill, et réinjection dans la spec (BR-0002 : une décision qui tranche une exigence se
      réécrit dans la spec, sinon la BA la re-signale).

## Ce qui reste hors périmètre, et doit le rester

- **Le lien de session n'est pas supprimé.** Il demeure la voie normale pour un observateur humain
  et pour la démonstration en dix minutes du README. L'appairage devient la voie recommandée
  **entre agents**.
- **Les identités par participant et la révocation sont la phase 2**, pas ce lot.

## Ce que le lot ne prétend pas résoudre, et le dit dans sa documentation

- **La clé de session reste un secret partagé** : qui entre peut la re-partager. L'appairage
  contrôle l'**entrée**, pas la **propagation**.
- **Le canal par lequel le code voyage doit rester digne de confiance**, exactement comme un code
  affiché sur un téléviseur : si un adversaire peut substituer le code au moment où le demandeur
  l'annonce, aucune cryptographie ne protège.

## Décisions de conception (ce que l'ADR laisse à l'implémentation)

- **Alphabet du code** : base32 de Crockford — `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — qui retire
  `I`, `L`, `O` et `U`. 10 caractères = 50 bits, la valeur de l'ADR. La saisie est tolérante
  (minuscules, tirets, espaces, et `I`/`L`→`1`, `O`→`0`), la production ne l'est pas.
- **Le sujet est dérivé du code, pas de la clé** : un membre qui n'a que le code doit pouvoir le
  calculer. Séparation de domaine par un préfixe de contexte, pour qu'aucune empreinte ne serve
  deux fois à deux usages.
- **L'octroi est lié à la transcription** : la clé de scellement dérive du secret ECDH *et* des
  deux clés publiques *et* du code. Une offre rejouée sous une autre clé ne produit pas la même
  clé, donc ne s'ouvre pas.
- **« Déjà consommé » se mesure sur le bus, pas dans un fichier local** : un octroi déjà publié
  pour cette empreinte suffit à refuser. Aucun état à conserver, et le refus vaut pour tout membre,
  pas seulement pour celui qui a autorisé.

## Risques

- **Le noyau est isomorphe** : y réintroduire `Buffer` ou un import `node:*` casserait l'interface
  sans casser le CLI (test `isomorphisme.test.js`).
- **Le corps publié doit rester du base64url** (`lib/ntfy.js`, R1). L'offre est **volontairement
  publique** (une clé publique l'est) ; l'octroi, lui, est scellé. Les deux sont encodés en
  base64url, et le module le dit là où on pourrait le lire de travers.
- **`npm run recette` est faillible pour une raison d'outillage** (Playwright non épinglé + CSP
  stricte : `waitForFunction` exige `unsafe-eval`). Attendre depuis Node (`page.evaluate`), jamais
  dans la page. Ne **jamais** relâcher la CSP pour faire passer un test.

## Retour arrière

`git revert` du commit de lot. Aucune migration, aucun format de session modifié : `pair` écrit un
fichier de session de la même forme que `join`.

## Vérification

```bash
npm test                       # unitaires + acceptation + portail de couverture (seuil AC-12)
npm run web &                  # interface servie localement
npm run recette                # scénario navigateur, 0 erreur console attendue
```

## Notes de revue — appairage (5 demandes sur 5)

**472 tests verts** (383 avant ce lot), `lib/appairage.js` à **99,1 %** de couverture, recette
navigateur **41 vérifications vertes et zéro erreur console** sur Chromium réel contre l'interface
servie et le vrai bus — y compris l'appairage complet, de bout en bout, depuis le navigateur.

### Ce que ce lot change, en une phrase

Un agent peut désormais entrer dans un salon **sans qu'aucun lien ne lui soit envoyé** : il annonce
un code de dix caractères, un membre le saisit, et la clé de session lui arrive scellée pour sa
seule clé publique. Le lien reste ce qu'il était pour un observateur humain.

### Les trois refus, et pourquoi ce sont eux qui font le mécanisme

Sans eux, l'appairage ne serait qu'une remise de clé à qui la demande. Chacun a son test dédié, à
trois niveaux — unitaire, CLI de bout en bout avec de vrais processus, et interface.

- **Substitution.** Un adversaire qui publie *sa* clé publique, parfaitement bien formée, sur le
  sujet de rendez-vous, est refusé : son empreinte n'est pas le code annoncé. Et quand les deux
  clés cohabitent, c'est la légitime — et elle seule — qui est servie ; l'octroi ne s'ouvre pas
  sous la clé de l'adversaire. Aucun octroi n'est publié lors d'un refus : c'est la propriété qui
  compte, plus encore que le code de retour.
- **Expiration.** Cinq minutes, et la borne est celle du **protocole**, pas celle que l'offre
  s'accorde : une offre qui réclame un mois n'obtient que cinq minutes. Le demandeur qui n'a pas
  été autorisé sort en code 3 **sans écrire de session**.
- **Usage unique.** « Déjà consommé » se mesure **sur le bus** — un octroi publié pour cette
  empreinte —, jamais dans un fichier local. Le refus vaut donc pour un second membre qui ne
  partage aucun état avec le premier : le test le vérifie avec deux `$HOME` distincts.

### Ce qui a été refusé en cours de route

- **Pas de sixième code de retour.** Les cinq de la spec couvrent exactement les cas : un code mal
  saisi est un usage (2), un code périmé ou consommé est un droit qui n'est plus là (3), une clé
  qui ne répond pas du code est un défaut d'intégrité (5). Ajouter un code aurait élargi un
  contrat stable pour rien.
- **Pas de seconde implémentation du chiffrement.** `crypto.js` dit « rien d'autre ne doit chiffrer
  dans ce dépôt » : le scellement passe donc par `seal`/`open`, et HKDF a été factorisée en
  `hkdf256` plutôt que recopiée. `deriveWriteKey` en est désormais le cas particulier.
- **Pas de durée de vie inventée.** L'invitation ne porte `ttlH` que si le salon l'a **annoncée** ;
  sinon elle l'omet, et l'arrivant la suppose pour lui seul. C'est exactement D-09, appliqué à une
  voie d'entrée qui n'existait pas alors.
- **Pas de CSP relâchée pour faire passer le scénario.** Les quatre `page.waitForFunction` du
  harnais, dont le *polling* exige `unsafe-eval`, sont remplacés par une attente **côté Node**
  (`page.evaluate`, qui passe par CDP). Le produit n'a pas bougé ; c'était le harnais qui n'était
  plus compatible avec la CSP qu'il mesure. Cela clôt le correctif de harnais laissé en suspens.

### Ce que le lot ne prétend pas résoudre, et qui est écrit noir sur blanc

README, kit de session et spec (R10) le disent dans les mêmes termes : la clé de session reste un
**secret partagé** — l'appairage contrôle l'**entrée**, pas la **propagation** ; le canal par lequel
le code voyage doit rester **digne de confiance**, comme un code affiché sur un téléviseur ; et qui
connaît le code peut le **brûler** — déni de service borné à cinq minutes, pas une lecture du salon.

### Réinjection dans la spec (BR-0002)

ADR-003 tranchait une exigence que la spec ne portait pas. Elle est donc réécrite en **V1.2** :
§2.2 (les deux verbes), §2.3 (le champ d'appairage), §2.4 (le sujet de rendez-vous et les deux
messages), **R9** (les paramètres), **R10** (ce que cela ne résout pas), **AC-17 à AC-22**. Sans
cela, la conformité fonctionnelle aurait été mesurée contre un texte qui ignore la moitié du lot.

### Dépôt public

Balayage des **2 383 lignes ajoutées** : 0 secret, 0 courriel, 0 adresse privée, 0 nom d'hôte
interne, 0 nom de projet interne, 0 chemin local, 0 sujet en dur. Les 14 occurrences du mot
« secret » sont de la prose (« la clé de session reste un secret partagé »).
