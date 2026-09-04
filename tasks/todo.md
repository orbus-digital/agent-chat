# Tâche : agent-chat-relay V1 — LOT 1 (noyau chiffré + CLI + transport ntfy)

Unité ADLC `agent-chat-relay-c20260904-1840` · spec `specs/agent-chat-relay/spec.md` · 15 AC au total.

## Objectif du lot

Livrer le **noyau** du relais : chiffrement E2E, signature, URL capacitaire, transport ntfy
(publication avec repli sur 429, abonnement SSE + repli polling), anti-rejeu, fichier de session,
et le CLI `agentchat` (`create`, `join`, `tail`, `send`).

8 demandes traitées : **AC-01, AC-02, AC-03, AC-04, AC-05, AC-07, AC-08, AC-11** → compteur 8/15.

Reporté au LOT 2 : AC-06 (UI Pages), AC-09 (archive/export Netlify), AC-10 (TTL en écriture UI+CLI),
AC-12 (couverture complète + intégration fonctions), AC-13 (déploiement/CSP), AC-14 (README démo),
AC-15 (`control:migrate`).

## Contrat de transport — vérifié empiriquement avant d'écrire du code

| Vérification | Résultat |
|---|---|
| `X-Title` / `X-Tags` conservés par ntfy.sh | oui (`title`, `tags[]` dans le JSON) |
| En-tête custom `X-Sig` conservé | **non — silencieusement supprimé** |
| Tags multiples avec `:` et base64url | oui (`["text","ts:...","sig:AbC-_dEf"]`) |
| `?since=<id>` | **exclusif** — ne renvoie pas le message d'ancrage (satisfait AC-07) |
| `/sse` | `event: open` puis une ligne `data:` par message |

→ Conséquence de conception : la signature et le `ts` client voyagent dans les **tags**, le corps
reste exactement `base64url(nonce||ct||tag)` comme l'exige la spec §2.1/§3. Voir `docs/adr/ADR-001`.

## Plan

- [ ] Socle npm : `package.json` (Node 22, ESM, zéro dépendance), `.gitignore`, portail de couverture
- [ ] `lib/base64url.js` — encodage/décodage sans remplissage (tests d'abord)
- [ ] `lib/crypto.js` — `generateKey`, `generateTopic`, `deriveWriteKey` (HKDF), `seal`/`open` AES-256-GCM + AAD
- [ ] `lib/sign.js` — HMAC-SHA-256(Kw) + comparaison à temps constant
- [ ] `lib/url.js` — construction/lecture de l'URL capacitaire (`#t=`, `k=`, `ro=1`, `s=`)
- [ ] `lib/protocol.js` — enveloppe de message, `ReplayGuard` (nonce vu, `ts` décroissant > 60 s)
- [ ] `lib/ntfy.js` — `publish` (limite 64 Ko, repli exponentiel sur 429), `poll`, `subscribe` (SSE → polling)
- [ ] `lib/session.js` — `~/.agentchat/<topic>.json` en 600, dossier en 700
- [ ] `test/helpers/fake-ntfy.js` — serveur ntfy de test local (POST, /json, /sse, 429 forcés, altération)
- [ ] `bin/agentchat.js` — `create`, `join`, `tail`, `send` ; codes 0/2/3/4/5
- [ ] Tests d'intégration bout en bout : deux CLI conversent (AC-02), rien en clair sur le bus (AC-03)
- [ ] `docs/adr/ADR-001` — métadonnées de message dans les tags ntfy
- [ ] `npm test` vert + couverture ≥ 80 % sur `lib/crypto`, `lib/sign`, `lib/ntfy`
- [ ] Commits conventionnels, PR vers `dev`, compteur d'unité à 8/15

## Risques

- **ntfy.sh public applique une limite de débit** → les tests d'intégration utilisent le serveur local ;
  seules les sondes manuelles touchent ntfy.sh.
- **Repli 429** : ne jamais déclarer un message envoyé s'il ne l'est pas (R5) ; les délais sont injectés
  dans les tests pour ne pas dormir réellement.
- **Dépôt public (R6)** : aucun secret, aucun nom de client, aucune référence à un projet ODS dans le
  code, les tests, les jeux d'essai.

## Retour arrière

Le lot est isolé sur `feat/agent-chat-relay-lot1` ; `dev` n'est touchée que par la PR.
`git checkout dev && git branch -D feat/agent-chat-relay-lot1` annule tout.

## Vérification

```bash
npm test          # unitaires + intégration + portail de couverture
node bin/agentchat.js create --ttl 2
```

## Notes de revue
(à compléter en fin de lot)
