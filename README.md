# agent-chat

Salon de conversation **inter-agents**, **chiffré de bout en bout**, **observable par un humain**,
et **sans aucun serveur applicatif**.

Deux briques publiques et gratuites suffisent :

- **[ntfy.sh](https://ntfy.sh)** transporte le flux en temps réel et le garde 12 h — il ne voit
  jamais que du chiffré ;
- **GitHub Pages** sert l'interface, une page statique.

Il n'y a ni compte, ni annuaire, ni base de données, ni fonction serveur. Une session est un lien :
qui l'a entre, qui ne l'a pas ne voit rien.

```
[agent A — CLI]  ─┐                    ┌─>  [humain — interface, mode observateur]
[agent B — CLI]  ─┼──>  ntfy.sh  ──────┼─>  [agent B]
[humain — page]  ─┘   (chiffré, 12 h)  └─>  [agent A]
```

---

## Démonstration en 10 minutes

Il vous faut **Node 22** et **un navigateur**. Rien d'autre — aucune dépendance à installer.

```bash
git clone https://github.com/orbus-digital/agent-chat.git
cd agent-chat
node --version        # doit afficher v22 ou plus
```

### 1. Créer la session (30 s)

```bash
node bin/agentchat.js create --ttl 2 --as agent-a
```

La commande imprime **une URL**, et c'est tout ce qui compte :

```
https://orbus-digital.github.io/agent-chat/#t=ac-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&k=yyyyyyyy…
                                            └─ le topic ntfy ─┘ └─ la clé de session ─┘
```

Tout ce qui suit le `#` est un **fragment** : un navigateur ne l'envoie jamais au serveur.
La clé ne quitte donc jamais votre poste et celui des personnes à qui vous transmettez le lien.
Elle est aussi écrite dans `~/.agentchat/<topic>.json`, en mode 600.

Gardez cette URL sous la main — appelons-la `$URL`.

> Pour une démonstration **en local**, ajoutez `--ui http://127.0.0.1:8080/` : l'URL imprimée
> pointe alors directement sur l'interface que `npm run web` sert (étape 3), et il n'y a plus
> aucun fragment à recoller à la main.

### 2. Brancher deux agents (2 min)

Dans **un premier terminal**, l'agent A écoute :

```bash
URL='…collez l’URL ici…'
node bin/agentchat.js join "$URL" --as agent-a
node bin/agentchat.js tail "$URL"
```

Dans **un deuxième terminal**, l'agent B rejoint et écrit :

```bash
URL='…la même URL…'
node bin/agentchat.js join "$URL" --as agent-b
node bin/agentchat.js send "$URL" "bonjour agent-a"
```

Le premier terminal affiche, en moins de trois secondes, une ligne JSON :

```json
{"id":"…","ts":1788…,"from":"agent-b","kind":"text","text":"bonjour agent-a","verified":true}
```

`verified: true` signifie que la signature du message a été vérifiée avec la clé de session.
Une ligne par message, sur `stdout` : c'est fait pour être lu par un programme autant que par vous.

### 3. Observer depuis l'interface (2 min)

```bash
npm run web       # sert web/ sur http://127.0.0.1:8080
```

Si vous avez créé la session avec `--ui http://127.0.0.1:8080/`, **ouvrez `$URL` telle quelle**.
Sinon, collez le **fragment** de votre URL derrière `http://127.0.0.1:8080/`.

Ajoutez `&ro=1` à la fin : vous voyez la conversation se dérouler en direct, déchiffrée, sans zone
d'écriture — c'est le **mode observateur**. Le fil suit le dernier message tant que vous ne
remontez pas lire : dès que vous remontez, il vous laisse tranquille.

Sans `&ro=1`, la page vous demande un nom et vous laisse écrire dans le même fil que les deux CLI.

> Le serveur local existe parce qu'un navigateur refuse de charger des modules ES depuis
> `file://`. Il ne sert que la recette : en production, c'est GitHub Pages.

### 4. Garder une trace (1 min)

Le cache de ntfy dure 12 h. Au-delà, la conversation n'existe que dans vos exports :

```bash
node bin/agentchat.js export "$URL" > session.json   # chiffré
node bin/agentchat.js replay session.json            # relu, sans réseau
```

Le même fichier se relit dans l'interface, bouton **Importer un export**.

---

## Le CLI `agentchat`

```
agentchat create  [--ttl H] [--as NOM] [--server URL] [--ui URL] [--private-meta]
agentchat join    <url> --as <NOM> [--private-meta]
agentchat tail    <url> [--since all|last|<id>] [--once] [--no-follow]
agentchat send    <url> "<texte>" [--kind text|control] [--as NOM] [--private-meta]
agentchat export  <url> [--since all|<id>]   > session.json
agentchat replay  <fichier> [--url <url>]      (aucun réseau)
agentchat migrate <url> [--as NOM]
```

**Codes de retour**, stables et faits pour être testés par un script :

| Code | Sens |
|---|---|
| 0 | succès |
| 2 | usage — argument manquant, option inconnue, fichier illisible |
| 3 | droit d'écriture absent — mode observateur, ou durée de vie dépassée |
| 4 | réseau — le bus n'a pas accusé réception ; **rien n'a été publié** |
| 5 | intégrité — un message n'a pas pu être ouvert ou vérifié |

Quelques usages utiles :

```bash
# rattraper l'historique et sortir, sans rester à l'écoute
agentchat tail "$URL" --once

# reprendre exactement là où l'on s'était arrêté
agentchat tail "$URL" --since last

# une instance ntfy dédiée
agentchat create --server https://ntfy.exemple.org

# ne rien publier en clair, pas même les noms ni le type des messages
agentchat create --private-meta

# changer de topic quand son nom a trop circulé
agentchat migrate "$URL"
```

---

## Ce que le chiffrement protège, et ce qu'il ne protège pas

**Protégé.** ntfy ne reçoit que `base64url(nonce || chiffré || tag)`. Chaque message est scellé en
**AES-256-GCM** avec un nonce aléatoire de 96 bits, et lié à son contexte par des données
authentifiées (`topic|auteur|type|horodatage`) : réécrire l'auteur ou l'horodatage d'un message
publié le rend illisible plutôt que trompeur. Chaque message porte une signature
**HMAC-SHA-256** calculée avec `Kw = HKDF(K, "write")` : un message dont la signature ne se vérifie
pas est affiché **« non vérifié »**, jamais comme du texte authentifié. Un nonce déjà vu est
ignoré, un horodatage qui recule de plus de 60 s est signalé.

**Non protégé, et il faut le savoir.**

- **Le mode observateur (`ro=1`) est une convention, pas une barrière.** Qui détient la clé de
  session peut en dériver la clé d'écriture et publier. La barrière réelle — une paire Ed25519 par
  participant — est prévue pour la phase 2.
- **Les métadonnées sont publiques par défaut** : le nom du participant et le type du message
  voyagent en clair dans les en-têtes ntfy. `--private-meta` les remplace par des constantes et les
  déplace dans le clair chiffré (l'interface fait de même).
- **Le lien est la seule autorisation.** Qui l'obtient entre. Transmettez-le par un canal sûr, et
  préférez un TTL court.
- **Un participant malveillant reste un participant.** Rien ici ne protège d'un membre du salon,
  ni d'un poste compromis.

---

## L'interface

Une page, deux vues : l'accueil crée une session, le salon l'affiche.

- création de session : lien participant, lien observateur, **code QR** pour ouvrir le salon sur
  un téléphone ;
- fil déchiffré en direct (SSE, repli sur interrogation périodique) ;
- roster, durée de vie restante, état de la connexion, santé du bus (`GET /v1/health`) ;
- export et import d'archive chiffrée ;
- mode observateur : aucune zone d'écriture n'est affichée ;
- sans clé dans le fragment : **« clé absente »**, et rien de lisible ;
- lisible à 390 px comme sur grand écran, thème clair et sombre, navigation au clavier.

La page déclare une politique de sécurité stricte :

```
default-src 'self'; connect-src 'self' https://ntfy.sh; script-src 'self'; style-src 'self';
img-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'
```

Elle ne charge donc **aucune ressource externe** et ne peut joindre **aucun domaine** hors du bus
déclaré. C'est aussi la limite du sélecteur de serveur : pour une instance ntfy dédiée, publiez
l'interface avec votre propre `connect-src`.

`frame-ancestors` n'y figure pas : cette directive ne s'applique qu'à partir d'un en-tête HTTP,
la laisser en `<meta>` n'ajoutait qu'un avertissement à chaque chargement. Pour bloquer l'inclusion
en `<iframe>`, servez la page avec un en-tête `Content-Security-Policy: frame-ancestors 'none'`
(ou, à défaut, `X-Frame-Options: DENY`) au niveau de votre hébergeur.

---

## Le dépôt

```
bin/            point d'entrée du CLI
lib/            noyau partagé : bytes, crypto, sign, url, protocol, ntfy, archive
                (+ session et cli, propres à Node)
web/            interface publiée par GitHub Pages
web/lib   ->    lien symbolique vers lib/ : une seule copie du noyau
web/js/qr.js    encodeur QR maison (mode octet, niveau L) : la page ne charge rien
test/           unitaires, acceptation (un test par critère), serveur ntfy de test
scripts/        portail de test avec seuil de couverture, serveur statique local
docs/adr/       décisions d'architecture
```

Le **noyau est isomorphe** : les mêmes fichiers s'exécutent dans Node 22 et dans un navigateur,
en **WebCrypto** uniquement. L'interface et le CLI chiffrent, signent et vérifient donc
exactement de la même façon — il n'y a pas deux implémentations à faire diverger.

```bash
npm test        # tests + portail de couverture (seuil 80 % sur le noyau)
npm run web     # interface en local
npm run recette # recette visuelle : un vrai navigateur sur l'interface réelle
```

Les tests d'acceptation utilisent un serveur ntfy écrit pour l'occasion, en Node, sans dépendance :
la suite ne dépend jamais du bus public et n'en consomme pas le quota.

### La recette visuelle

`npm test` éprouve les règles ; il ne voit pas le rendu. `npm run recette` ouvre un vrai navigateur
sur l'interface réellement servie, y crée une session **avec le CLI**, et vérifie ce qu'un humain
verrait : la santé du bus, la taille des champs, le fait qu'un message soit lisible sur un
téléphone de 390 px, le mode observateur, le thème sombre, et **zéro erreur console** (AC-13).
Les captures sont déposées dans `recette/` (hors de `coverage/`, que `npm test` efface).

Elle demande Playwright, qui n'est **pas** une dépendance du dépôt et ne doit pas le devenir :
ce README promet « Node 22 et un navigateur », et `npm test` reste sans dépendance. Installez-le
hors du dépôt, une fois :

```bash
npm install -g playwright && npx playwright install chromium
```

---

## Licence

MIT.
