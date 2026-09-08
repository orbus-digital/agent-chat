# ADR-002 — Le bus ntfy doit être en `https://`, et le refus s'applique à deux niveaux

- **Statut** : accepté — 2026-09-08
- **Contexte** : revue de sécurité du LOT 2 (verdict `concerns`, sévérité MEDIUM), HR-20260907-003
- **Décideurs** : agent de développement, sur trois constats de la revue

## Contexte

La revue de sécurité a relevé trois constats de même racine : l'URL du bus ntfy était acceptée
telle quelle, sans contrainte de schéma, aux trois endroits où elle entre dans le programme —
l'option `--server` du CLI, le paramètre `s` d'un lien de session, et les appels `fetch` du
transport. Une URL `http://` y passait sans un mot.

Le corps des messages reste chiffré sur `http://` : AES-256-GCM ne dépend pas du transport. Ce qui
fuit, ce sont les **métadonnées**, et elles ne sont pas anodines :

- `X-Title` porte le nom de l'auteur, `X-Tags` le type du message : deux en-têtes HTTP, donc en
  clair sur le réseau ;
- le nom du topic est dans le chemin de l'URL, donc lisible aussi ;
- `--private-meta`, dont la raison d'être est précisément de cacher l'auteur et le type **au bus**,
  ne protège alors plus de rien vis-à-vis d'un observateur du réseau — l'option devient trompeuse ;
- sans TLS, rien n'empêche non plus l'injection ou le rejeu de messages par un intermédiaire ; la
  signature HMAC les rendrait « non vérifiés », mais le fil serait tout de même pollué.

Il fallait par ailleurs garder utilisable un serveur ntfy de test local, sur lequel reposent la
suite d'acceptation et la recette manuelle.

## Décision

**Un seul module décide** — `lib/serveur.js` — et **deux niveaux de sévérité** l'appliquent.

1. **L'invariant de transport** (`assertBaseTransport`, appelé par `lib/ntfy.js` dans `publish`,
   `poll`, `subscribe` et le flux SSE, ainsi que par la sonde de santé de l'interface) : jamais de
   requête en clair vers autre chose que la boucle locale. Cette couche ne demande rien à personne :
   elle ne peut pas connaître l'intention de son appelant, et un serveur sur `127.0.0.1` ne sort
   pas de la machine. C'est la garde qu'aucun appelant ne peut contourner.

2. **La politique d'usage** (`normaliseServeur`, appelée par `--server`, par `NTFY_BASE_URL`, par
   `buildSessionUrl` et par `parseSessionUrl`) : le clair exige un consentement **explicite**
   (`--allow-insecure`, ou `AGENTCHAT_ALLOW_INSECURE=1`) **en plus** d'être local.

Le consentement ne s'étend jamais à une adresse distante : `--allow-insecure` sur un hôte public
est refusé, avec un message qui le dit. Ce n'est pas un interrupteur général.

## Alternatives écartées

- **Un seul niveau, au transport.** `--server http://localhost:8080` serait alors passé en silence :
  l'utilisateur n'aurait jamais su qu'il travaillait en clair.
- **Un seul niveau, à la politique.** Tout appelant du noyau — l'interface, un futur pont — aurait
  contourné la garde en appelant `publish` directement.
- **Réécrire `http://` en `https://` en silence.** L'URL appartient à l'utilisateur ; une réécriture
  muette produit un échec réseau incompréhensible là où un refus explicite dit ce qui ne va pas.
  Chaque message de refus propose donc l'URL à écrire à la place.
- **Un consentement mémorisé dans le fichier de session.** Séduisant pour l'ergonomie, mais le
  `parseSessionUrl` a lieu **avant** que le topic soit connu, donc avant que la session locale
  puisse être chargée. La variable d'environnement rend le même service sans tordre l'ordre des
  opérations.

## Conséquences

- Le paramètre `s` d'un lien de session est le vecteur le plus sérieux — c'est le seul qu'un tiers
  contrôle de bout en bout —, et c'est désormais celui qui est vérifié à la lecture comme à
  l'écriture : on ne fabrique pas plus un lien dégradant qu'on n'en ouvre un.
- L'interface applique la même règle. Un lien vers un bus en clair y est « invalide », pas à moitié
  utilisable ; la sonde de santé ne part pas ; et le sélecteur de serveur refuse, avec le message du
  noyau, un bus en clair de même origine que la page — trou que la seule liste blanche laissait
  ouvert sur une page servie en `http://`.
- Une page servie en clair depuis la boucle locale (la recette locale) accorde implicitement le
  consentement pour un bus local : le contexte est déjà celui d'une mise au point, et un navigateur
  bloquerait de toute façon le contenu mixte dans l'autre sens.
- La suite de tests parle à un faux ntfy en `http://127.0.0.1` : elle porte donc
  `AGENTCHAT_ALLOW_INSECURE=1`, ce qui rend la contrainte visible plutôt que contournée. Le refus,
  lui, est éprouvé sans ce consentement dans `test/serveur.test.js`.
