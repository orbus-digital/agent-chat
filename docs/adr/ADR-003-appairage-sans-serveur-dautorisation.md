# ADR-003 — L'entrée dans un salon se négocie par appairage, sans serveur d'autorisation

- **Statut** : accepté — 2026-09-15
- **Contexte** : le lien de session porte la clé dans son fragment ; le transmettre expose la clé à tout ce qui manipule des URL
- **Décideurs** : l'exploitant du projet, sur une proposition d'agent

## Contexte

Aujourd'hui, entrer dans un salon veut dire recevoir une URL dont le fragment contient la clé :

```
https://<pages>/#t=ac-xxxxxxxxxxxx&k=yyyyyyyyyyyy
```

La propriété qui tient tout l'édifice est réelle : un fragment n'est jamais envoyé au serveur par un
navigateur, donc ni GitHub Pages ni ntfy ne voient jamais la clé. Le problème n'est pas là. Il est
que **ce lien doit voyager jusqu'à son destinataire**, et qu'une URL est l'objet informatique le plus
copié, collé, journalisé et indexé qui soit : historique de navigateur, presse-papiers, salon de
discussion, ticket, journal d'un intermédiaire, capture d'écran. Chacun de ces passages est une copie
complète du pouvoir de lire et d'écrire dans le salon, et aucune n'est révocable.

Le README le dit déjà sans détour — « **le lien est la seule autorisation** ; qui l'obtient entre » —
et recommande un TTL court, ce qui atténue sans résoudre.

La comparaison qui vient à l'esprit est le *device authorization grant* (RFC 8628), celui par lequel
un téléviseur affiche un code que l'on saisit sur un autre appareil. Il est **inapplicable tel quel** :
ce flux repose sur un serveur d'autorisation qui émet les codes, conserve l'état en attente, reçoit
l'approbation et délivre le jeton. Ce serveur est l'arbitre, et il faudrait donc le créer.

Or ce projet n'a **aucun serveur applicatif**, et ce n'est pas une économie : c'est sa propriété
centrale. Un serveur qui courtise les clés de session serait un composant capable de lire **tous** les
salons — on remplacerait un lien fragile par une cible permanente.

## Décision

**On garde l'expérience du device login et on supprime l'arbitre.** Le bus ntfy sert de point de
rendez-vous, et la cryptographie asymétrique remplace le serveur d'autorisation.

### Le déroulé

1. L'agent qui demande l'entrée génère une **paire de clés éphémère**.
2. Il en dérive un **code court, qui est l'empreinte de sa clé publique**.
3. Il publie sa clé publique sur un sujet d'appairage dérivé du code, et s'y abonne.
4. Il annonce son code à un humain : `Code : KXR7-2M4Q-9T`.
5. Un membre du salon — qui détient la clé — saisit ce code. Son côté récupère la clé publique,
   **vérifie que son empreinte est exactement le code saisi**, puis publie la clé de session
   **chiffrée pour cette clé publique**.
6. L'agent déchiffre et entre.

La clé de session n'apparaît en clair nulle part : ni dans une URL, ni dans un message, ni dans un
historique, ni dans un canal de discussion.

### Le point qui fait tenir l'ensemble

Le sujet d'appairage est **public** : quiconque connaît le code peut s'y abonner et lire la clé
publique du demandeur. C'est sans conséquence — une clé publique est publique.

La seule attaque qui compte est la **substitution de clé** : un adversaire publie *sa* clé publique
sur le sujet d'appairage, en espérant qu'un membre chiffre la clé de session à son intention.

La parade est que **le code EST l'empreinte**. Substituer une clé change l'empreinte, donc le code
saisi ne correspond plus, et le côté autorisant refuse. C'est le motif de la *chaîne authentifiée
courte*, le même que les numéros de sécurité de Signal ou les empreintes SSH.

### Les paramètres, et pourquoi ceux-là

| Paramètre | Valeur retenue | Raison |
|---|---|---|
| Longueur du code | **10 caractères** (base32 sans ambiguïtés, ~50 bits) | Le code n'est pas un secret à deviner mais une **seconde préimage** à fabriquer : l'attaquant doit forger une paire dont l'empreinte tombe sur le code. 40 bits se force en quelques heures sur GPU ; 50 bits demandent ~10¹⁵ essais, hors d'atteinte dans la fenêtre. 60 bits seraient plus sûrs mais pénibles à dicter. |
| Validité | **5 minutes**, usage unique | Borne la fenêtre de forçage et empêche la réutilisation d'un code entendu. |
| Courbe | **ECDH P-256** | Disponible dans WebCrypto de tous les navigateurs depuis 2017. X25519 est préférable sur le principe mais n'est arrivé que récemment (Chrome 133+, Safari 17+) : l'interface doit pouvoir autoriser, donc la compatibilité l'emporte. Sécurité équivalente pour cet usage. |
| Dérivation | ECDH → HKDF-SHA-256 → AES-256-GCM | Mêmes primitives que le reste du projet, toutes natives : **aucune dépendance ajoutée**. |

### Ce que la décision n'affirme pas

**Le canal par lequel le code voyage doit rester digne de confiance.** C'est exactement la condition
du device login : le code affiché sur un téléviseur n'est fiable que parce qu'on regarde le sien. Si
un adversaire peut substituer le code au moment où le demandeur l'annonce, aucune cryptographie ne
protège. L'appairage réduit la surface — il ne l'annule pas.

## Alternatives écartées

**Un vrai serveur d'autorisation.** Rejeté : il détiendrait ou courtiserait les clés de session, donc
pourrait lire tous les salons. Il introduirait aussi une disponibilité à tenir et un coût
d'hébergement, là où le projet n'en a aucun.

**Chiffrer le lien pour une clé publique publiée hors bande** (le demandeur colle sa clé publique
quelque part, un membre lui renvoie la clé chiffrée). Techniquement équivalent et plus simple, mais
l'ergonomie est mauvaise : une clé publique se recopie mal, se vérifie mal à l'œil, et on retombe sur
le problème du copier-coller qu'on cherchait à supprimer.

**Allonger simplement la clé de session ou raccourcir le TTL.** Ne traite pas la cause : le problème
n'est pas la force de la clé, c'est qu'elle **voyage en clair** dans un objet fait pour être copié.

**Un mot de passe partagé de salon.** Déplace le secret sans le supprimer, et n'offre ni identité par
participant ni révocation.

## Conséquences

**Ce que ça apporte, au-delà du lien.** Chaque agent détient désormais **sa propre paire de clés**.
C'est le socle de la phase 2 déjà annoncée au README, et donc la fin de la limite la plus gênante du
projet — « le mode observateur est une convention, pas une barrière ». Avec des identités par
participant, on peut refuser l'écriture à un lecteur et **révoquer** un agent sans changer de salon.

L'autorisation devient par ailleurs **nominative et refusable** : on voit qui demande, et on peut dire
non.

**Ce que ça ne règle pas.** La clé de session reste un **secret partagé** : qui entre peut la
re-partager. L'appairage contrôle l'**entrée**, pas la **propagation**. Seule la phase 2 complète
traite ce point.

**Ce que ça coûte.** Deux allers-retours sur le bus, donc une dépendance de plus à sa disponibilité —
déjà assumée par ailleurs. Deux verbes de CLI à ajouter, le côté interface, une suite de tests, et la
documentation. Ce n'est pas une retouche : c'est une phase.

**Le lien de session n'est pas supprimé.** Il reste la voie normale pour un observateur humain qui
ouvre le salon dans son navigateur, et pour la démonstration en dix minutes du README. L'appairage
devient la voie recommandée **entre agents**, là où le lien devait auparavant transiter par un canal
de discussion.

## Mise en œuvre — 2026-09-15

Cette décision est implémentée. Les paramètres ci-dessus n'ont pas été rediscutés ; ce qui suit ne
consigne que ce que la mise en œuvre a dû trancher, et que l'ADR laissait ouvert.

- **`lib/appairage.js`**, au même niveau que `crypto.js` et `sign.js`, en WebCrypto pur : le même
  fichier sert le CLI et l'interface, qui doit pouvoir autoriser. **Aucune dépendance ajoutée.**
- **Alphabet du code** : base32 « de Crockford » — `0123456789ABCDEFGHJKMNPQRSTVWXYZ` —, sans `I`,
  `L`, `O` ni `U`. La saisie est tolérante (minuscules, tirets, espaces, `I`/`L` → `1`, `O` → `0`),
  la production ne l'est pas.
- **Séparation de domaine** : l'empreinte, le sujet et la clé de scellement sont hachés avec trois
  contextes distincts, pour qu'aucune empreinte ne serve deux usages.
- **Le sujet dérive du code, pas de la clé** : un membre qui n'a que le code doit pouvoir le
  calculer. Son préfixe `acp-` ne peut pas satisfaire la forme d'un topic de session.
- **La clé de scellement est liée à la transcription** : sel = `SHA-256(pk_demandeur || pk_membre)`,
  info = contexte + code. Un octroi rejoué sous une autre clé de membre n'ouvre rien.
- **La validité est bornée par le protocole, pas par l'offre** : `exp` ne sert que de borne basse.
  Une offre qui s'accorde un mois n'obtient que cinq minutes.
- **« Déjà consommé » se mesure sur le bus** — un octroi publié pour cette empreinte — et non dans
  un fichier local : le refus vaut alors pour tout membre, y compris celui qui n'a pas autorisé la
  première fois. Conséquence assumée : qui connaît le code peut le **brûler**. C'est un déni de
  service borné à cinq minutes, et non une lecture du salon.
- **Aucun code de retour nouveau** : code mal saisi → 2 ; code périmé ou déjà consommé → 3 ; clé qui
  ne répond pas du code, ou octroi illisible → 5. Les cinq codes de la spec suffisaient.
- **Entre deux offres portant le même code, la première publiée l'emporte** : un arrivant tardif ne
  déplace pas une offre déjà annonçable.

Réinjecté dans la spec en **V1.2** (R9, R10, AC-17 à AC-22), conformément à BR-0002.
