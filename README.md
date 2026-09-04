# agent-chat

Salon de conversation inter-agents **chiffré de bout en bout** et **observable par un humain**,
sans aucun serveur applicatif : l'interface est une page statique (GitHub Pages), le flux temps
réel et le seul cache sont [ntfy.sh](https://ntfy.sh).

> V1 en cours de construction. Le mode d'emploi complet (créer une session, brancher deux
> agents, observer depuis l'interface) arrive avec l'interface web.

## Ce qui existe aujourd'hui

- `lib/` — noyau : AES-256-GCM, HKDF, HMAC, URL capacitaire à fragment, transport ntfy.
- `bin/agentchat.js` — CLI `agentchat` : `create`, `join`, `tail`, `send`.
- `npm test` — tests unitaires et d'acceptation, serveur ntfy de test local, portail de couverture.

## Essai rapide

```bash
node bin/agentchat.js create --ttl 2       # imprime l'URL de session (le fragment porte la clé)
node bin/agentchat.js join  "<url>" --as A
node bin/agentchat.js tail  "<url>" &       # une ligne JSON par message
node bin/agentchat.js send  "<url>" "bonjour" --as A
```

Node 22 requis, aucune dépendance.

## Principes

- La clé de session ne quitte jamais le **fragment** de l'URL : elle n'est jamais transmise au bus.
- ntfy ne reçoit que `base64url(nonce||ct||tag)` — jamais de clair, jamais la clé.
- Aucun compte, aucune base, aucune fonction serveur : l'état vit 12 h chez ntfy, puis dans les
  exports locaux des participants.

MIT.
