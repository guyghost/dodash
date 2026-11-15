# Bug: Délibération DAO 0/8 votes — prompt passé comme extension `-e` + modèle retiré du catalogue

**Date** : 2026-09-18
**Sévérité** : Medium (toute délibération/roundtable échoue en quorum 0 % → rejet par défaut ; les propositions legitimes meurent en état `rejected` sans recours, cf. bug-dao-stuck-failed-state-2026-08-31.md)
**Statut** : Diagnostiqué — correctif local appliqué (modèles), redémarrage de session requis

## Symptôme

`dao_deliberate` (#46, 05:33Z) et `dao_roundtable` (05:50Z) : les 8 agents
échouent en ~1 s chacun avec :

```
Error: Failed to load extension "/Users/guy/Developer/dev/dodash/<charte complète>":
Extension path does not exist: …
Warning: Model "GLM-5.1" not found for provider "z.ai". Using custom model id.
Hint: Start without extensions using "pi -ne".
```

Tally : 0/8 votants, quorum 0 % → proposition #46 passée en `rejected`
(sink state sans recours) alors que le contenu n'avait jamais été délibéré.

## Cause racine (double)

1. **Prompt via `-e`** : la version du paquet `@guyghost/swarm-dao-pi-adapter`
   chargée en mémoire par la session pi hôte (démarrée 2026-09-17T20:15Z)
   spawne les votants avec `pi … --model <model> -e <charte+proposition>` —
   `-e` = `--extension <path>` dans pi, qui résout le texte contre le CWD et
   sort en erreur 1 (`resource-loader.ts` : `Extension path does not exist`).
   La v0.9.1 publiée sur disque (~/.pi/agent/npm/…) corrige ça (prompt en
   positionnel + `--no-extensions`, cf. commit swarm-dao `96cf36b`), **mais
   pi charge les extensions au démarrage de session** : la session hôte
   exécute encore l'ancien code.
2. **Modèle disparu** : les 8 agents de `.dao/state.json` référençaient
   `z.ai/GLM-5.1`, retiré du catalogue pi (disponibles : `z.ai/GLM-5.3`,
   `z.ai/GLM-5-Turbo`, `zai/glm-5.2`…). Même avec un spawn correct, le
   fallback « custom model id » part sur un modèle inexistant côté API.

## Correctifs

1. **Appliqué (2026-09-18)** : `.dao/state.json` — 7 agents passés de
   `z.ai/GLM-5.1` à `z.ai/GLM-5.3`.
2. **Requis** : redémarrer la session pi hôte pour recharger le pi-adapter
   v0.9.1 depuis le disque (vérifier ensuite avec un `dao_roundtable` :
   les erreurs `-e` doivent disparaître).
3. **Proposition #46** : recréée en #48 (convention #41-bis) — délibérer
   #47 et #48 après redémarrage.
4. **À instruire côté swarm-dao (OSS)** : la délibération ne doit pas
   rejeter une proposition quand 0 vote a été exprimé par suite d'une erreur
   d'infrastructure (distinguer « quorum non atteint » de « spawn 100 %
   échoué »), et les modèles d'agents devraient être revalidés contre le
   catalogue au démarrage.

## Reproduction

Session pi démarrée avant la mise à jour du paquet pi-adapter → tout
`dao_deliberate`/`dao_roundtable` → 8 erreurs `Failed to load extension
"<prompt>"` + tally 0/8 → `rejected`.
