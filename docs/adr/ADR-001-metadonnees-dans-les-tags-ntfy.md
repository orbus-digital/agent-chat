# ADR-001 — Les métadonnées de message voyagent dans les tags ntfy

- **Statut** : accepté — 2026-09-04
- **Contexte** : `agent-chat-relay` V1, spec §2.1 et §3
- **Décideurs** : agent de développement, sur constat empirique

## Contexte

La spec décrit le contrat de publication ainsi :

> `POST {NTFY_BASE_URL}/{topic}` — corps = `base64url(nonce||ct||tag)` ; en-têtes
> `X-Title: <from>`, `X-Tags: <kind>`, `X-Sig: <HMAC-SHA-256(Kw, corps)>`.

Deux informations sont indispensables au destinataire et ne peuvent pas se
trouver dans le chiffré, puisqu'elles servent à l'ouvrir ou à le juger :

- l'**horodatage client `ts`**, qui entre dans l'AAD (`topic|from|kind|ts`) : sans
  lui, le déchiffrement est impossible ;
- la **signature HMAC(Kw)** du corps, qui décide de l'état « vérifié » (R2).

## Constat

Sondage direct de `ntfy.sh` le 2026-09-04 :

```
POST https://ntfy.sh/ac-… -H 'X-Title: probe' -H 'X-Tags: text,ts:1,sig:AAA' -H 'X-Sig: deadbeef'
→ {"id":"…","title":"probe","message":"QUJDRA","tags":["text","ts:1","sig:AAA"]}
```

| Élément | Restitué par ntfy |
|---|---|
| `X-Title` | oui → `title` |
| `X-Tags`, y compris des valeurs contenant `:`, `-`, `_` | oui → `tags[]` |
| **en-tête inconnu `X-Sig`** | **non — supprimé sans erreur ni avertissement** |

ntfy ne conserve que les en-têtes de son propre vocabulaire. Un `X-Sig` publié
est accepté (200) puis perdu : le destinataire ne le voit jamais. Suivre la
lettre de la spec aurait donc produit un système où **aucun message n'est
jamais vérifié**, et où l'échec est silencieux — le pire des modes de panne
pour une garantie d'authenticité.

Deux autres points ont été vérifiés au même moment et fondent le reste du
transport : `?since=<id>` est **exclusif** (il ne renvoie pas le message
d'ancrage — c'est exactement ce qu'exige AC-07, « sans doublon »), et le champ
`expires` confirme le cache de **12 h**.

## Décision

1. Le **corps** publié reste **exactement** `base64url(nonce||ct||tag)`, sans
   aucun ajout : c'est la garantie R1 et le test AC-03 la vérifie sur la
   réponse brute du bus.
2. `from` reste dans `X-Title` et `kind` dans `X-Tags`, comme la spec le décrit.
3. `ts` et la signature voyagent **dans les tags**, sous forme préfixée :
   `["<kind>", "ts:<millisecondes>", "sig:<base64url>"]`.
4. L'en-tête `X-Sig` **continue d'être émis**, conformément à la spec : une
   instance ntfy auto-hébergée ou un relais qui le préserverait n'est pas
   pénalisé, et le contrat écrit reste vrai là où il peut l'être. Le client, lui,
   ne s'y fie pas.

## Conséquences

**Ce que cela donne**

- La signature survit au transport, donc R2 et AC-04 sont réellement portés.
- Aucun octet supplémentaire dans le corps : le chiffré reste le chiffré.
- Le repli fonctionne sur `ntfy.sh` public comme sur une instance dédiée, sans
  changement de code (`NTFY_BASE_URL`).

**Ce que cela coûte**

- Les tags sont publics : la **longueur** de la signature et l'existence d'un
  `ts` sont visibles de quiconque connaît le nom du topic. Ni l'un ni l'autre
  ne révèle de contenu ; le `ts` était déjà exposé par le `time` que ntfy
  attribue lui-même.
- `--private-meta` (AC-15) réduit encore cette surface : `X-Title` devient la
  constante `ac`, le tag de kind devient `m`, et `from`/`kind` passent dans le
  clair chiffré. `ts` et `sig` restent nécessairement en tags — ils sont, par
  construction, ce qu'il faut connaître **avant** de pouvoir ouvrir le message.

## Alternatives écartées

- **Mettre `ts` et `sig` dans le corps, à côté du chiffré** (par ex. un JSON
  enveloppant) : viole la spec §2.1 et brouille le test « le corps est du
  base64url et rien d'autre », qui est notre meilleure preuve de non-fuite.
- **Renoncer à la signature** : abandonne R2 et AC-04.
- **Dériver `ts` du `time` de ntfy** : le serveur choisirait alors une partie de
  l'AAD, ce qui lui donnerait prise sur le déchiffrement — exactement ce que le
  modèle de menace refuse.
- **Exiger une instance ntfy auto-hébergée dès la V1** : contredit la décision
  D-01 (bus public, coût nul) sans autre bénéfice que l'élégance du contrat.
