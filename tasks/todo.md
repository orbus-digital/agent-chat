# Tâche : agent-chat-relay V1 — LOT 1 (noyau chiffré + CLI + transport ntfy)

Unité ADLC `agent-chat-relay-c20260904-1840` · spec `specs/agent-chat-relay/spec.md` **V1.1** ·
**16 AC** au total (AC-01..AC-16).

> **Écart relevé et tranché.** L'intitulé de l'unité de travail, rédigé sur la spec V1.0, mentionne
> des « fonctions Netlify d'archive + /api/health ». La spec **V1.1** du même jour les exclut
> explicitement (§8 « Pas de Netlify, pas de fonction serveur », R8 « Aucun serveur applicatif »,
> D-04). La spec fait foi : **aucune fonction serveur n'est écrite**, l'archive est l'export local
> chiffré (AC-09) et la santé se lit sur `GET {NTFY}/v1/health` (AC-13). Toute trace de Netlify a
> été retirée du dépôt.

## Objectif du lot

Livrer le **noyau** du relais : chiffrement E2E, signature, URL capacitaire, transport ntfy
(publication avec repli sur 429, abonnement SSE + repli polling), anti-rejeu, fichier de session,
et le CLI `agentchat` (`create`, `join`, `tail`, `send`).

8 demandes traitées : **AC-01, AC-02, AC-03, AC-04, AC-05, AC-07, AC-08, AC-11** → compteur 8/16.

Reporté au LOT 2 : AC-06 (UI Pages + observateur), AC-09 (export / replay / import),
AC-10 (TTL en écriture UI+CLI), AC-12 (couverture et intégration complètes), AC-13 (Pages + CSP),
AC-14 (README de démonstration), AC-15 (`--private-meta`), AC-16 (`control:migrate`).

## Contrat de transport — vérifié empiriquement avant d'écrire du code

Sondes directes sur `ntfy.sh`, 2026-09-04 (rejouées et confirmées en fin de lot) :

| Vérification | Résultat |
|---|---|
| `X-Title` / `X-Tags` conservés par ntfy.sh | oui (`title`, `tags[]` dans le JSON) |
| En-tête custom `X-Sig` conservé | **non — silencieusement supprimé** |
| Tags multiples avec `:` et base64url | oui (`["text","ts:...","sig:AbC-_dEf"]`) |
| `?since=<id>` | **exclusif** — ne renvoie pas le message d'ancrage (satisfait AC-07) |
| `/sse` | `event: open` puis une ligne `data:` par message |
| `GET /v1/health` | `200` |
| `expires - time` | 43 200 s = cache 12 h |

→ Conséquence de conception : la signature et le `ts` client voyagent dans les **tags**, le corps
reste exactement `base64url(nonce||ct||tag)` comme l'exige la spec §2.1/§3. Voir
`docs/adr/ADR-001-metadonnees-dans-les-tags-ntfy.md`.

## Plan

- [x] Socle npm : `package.json` (Node 22, ESM, zéro dépendance), `.gitignore`, portail de couverture
- [x] `lib/base64url.js` — encodage/décodage sans remplissage (tests d'abord)
- [x] `lib/crypto.js` — `generateKey`, `generateTopic`, `deriveWriteKey` (HKDF), `seal`/`open` AES-256-GCM + AAD
- [x] `lib/sign.js` — HMAC-SHA-256(Kw) + comparaison à temps constant
- [x] `lib/url.js` — construction/lecture de l'URL capacitaire (`#t=`, `k=`, `ro=1`, `s=`)
- [x] `lib/protocol.js` — enveloppe de message, `ReplayGuard` (nonce vu, `ts` décroissant > 60 s)
- [x] `lib/ntfy.js` — `publish` (limite 64 Ko, repli exponentiel sur 429), `poll`, `subscribe` (SSE → polling)
- [x] `lib/session.js` — `~/.agentchat/<topic>.json` en 600, dossier en 700
- [x] `test/helpers/fake-ntfy.js` — serveur ntfy de test local (POST, /json, /sse, 429 forcés, altération)
- [x] `bin/agentchat.js` — `create`, `join`, `tail`, `send` ; codes 0/2/3/4/5
- [x] Tests d'acceptation bout en bout : deux CLI conversent (AC-02), rien en clair sur le bus (AC-03)
- [x] `docs/adr/ADR-001` — métadonnées de message dans les tags ntfy
- [x] `npm test` vert + couverture ≥ 80 % sur `lib/crypto`, `lib/sign`, `lib/ntfy`
- [x] Purge des références à Netlify (spec V1.1)
- [x] Commits conventionnels, PR vers `dev`, compteur d'unité à 8/16

## Risques

- **ntfy.sh public applique une limite de débit** → les tests d'acceptation utilisent le serveur local ;
  seules les sondes manuelles touchent ntfy.sh.
- **Repli 429** : ne jamais déclarer un message envoyé s'il ne l'est pas (R5). Le test d'acceptation
  mesure le repli réel (≈ 15 s) : son délai de garde doit rester plus large, faute de quoi c'est le
  test qui tue le processus et le code de retour observé n'est plus celui du CLI.
- **Dépôt public (R6)** : aucun secret, aucun nom de client, aucune référence à un projet ODS dans le
  code, les tests, les jeux d'essai.

## Retour arrière

Le lot est isolé sur `feat/agent-chat-relay-lot1` ; `dev` n'est touchée que par la PR.
`git checkout dev && git branch -D feat/agent-chat-relay-lot1` annule tout.

## Vérification

```bash
npm test          # unitaires + acceptation + portail de couverture
node bin/agentchat.js create --ttl 2
```

## Notes de revue

- 127 tests, tous verts. Couverture : `lib/crypto` 98,3 % · `lib/sign` 100 % · `lib/ntfy` 99,4 %
  (seuil AC-12 : 80 %).
- Deux tests d'acceptation étaient rouges à la reprise du lot ; **aucun des deux ne révélait un
  défaut du produit** :
  - AC-03 cherchait chaque mot de la phrase d'essai dans le corps chiffré, y compris `a` et `la` —
    une suite de un à trois caractères apparaît par hasard dans n'importe quel base64. Le test
    cherche désormais la phrase entière et les mots d'au moins quatre caractères ; la preuve de
    non-fuite reste entière, l'aléa disparaît.
  - AC-11 attendait le code 4 après un repli de 1+2+4+8 s, mais le délai de garde du harnais valait
    exactement 15 s : le test tuait le CLI juste avant sa dernière tentative et observait 1. Délai
    porté à 40 s pour ce cas, et un processus tué lève désormais au lieu de se déguiser en code 1.
