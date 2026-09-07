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

- [ ] **D-01 — `npm test` est rouge.** Le test TTL de `interface-salon` attend un prédicat vrai
      dès le départ (`ttl.expire` vaut `true` tant qu'aucun roster n'a été lu) : il n'attend donc
      rien, et l'assertion suivante gagne ou perd à la course. Vert isolément, rouge sous couverture.
- [ ] **D-02 — Champs hauts de 192 px sur téléphone.** À ≤ 390 px, `.ligne` passe en colonne ;
      `flex: 1 1 12rem` cesse d'être une largeur et devient une **hauteur**. La zone de saisie et
      les deux champs de lien deviennent des boîtes de 192 px.
- [ ] **D-03 — Case « métadonnées privées » décrochée de son libellé** à ≤ 390 px : la case est
      empilée au-dessus du texte, centrée, sans lien visuel avec lui.
- [ ] **D-04 — La zone d'écriture masque le fil.** `position: sticky; bottom: 0` + D-02 :
      sur 390 × 844, le composeur occupe 311 px et se peint par-dessus les messages.
      **Aucun message n'est lisible sur un téléphone.**
- [ ] **D-05 — Aucun défilement vers le message le plus récent.** 14 messages, `scrollY = 0` :
      l'arrivant voit le plus ancien et doit faire défiler à la main. Pour un fil en direct (AC-06),
      c'est le message qui vient d'arriver qu'il faut voir.
- [ ] **D-06 — Indicateur de santé mort sur l'accueil.** `rafraichirSante()` sort tout de suite
      s'il n'y a pas de salon : l'accueil affiche « bus : vérification… » indéfiniment. AC-13
      demande que l'indicateur soit vert depuis l'interface.
- [ ] **D-07 — `--ui` documenté mais ignoré.** `create` et `migrate` lisent `ctx.uiBase` et jamais
      `values.ui` : la recette locale n'est possible que par `AGENTCHAT_UI_BASE`.
- [ ] **D-08 — La recette n'est pas rejouable.** Aucun scénario navigateur au dépôt. Ajouter
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

## Notes de revue
(à compléter en fin de lot)
