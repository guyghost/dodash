# Revue de mise en production — 2026-08-24

Verdict : **NO_GO pour tout capital réel**

Ce verdict applique `models/production-launch.md` en mode fail-closed. Il porte
sur l'arborescence locale non commitée basée sur
`8528dc5b2bb50ee2e382fcab6b2c41c39b720928`; ce SHA n'est pas le SHA d'une
release candidate, car les changements examinés ne sont pas encore commités.

## Résultat par porte

| Porte | État | Preuve disponible | Preuve bloquante |
| --- | --- | --- | --- |
| Recherche OOS | **FAIL** | Études de calibration/sizing et produits exacts documentés | Les fenêtres 2022–2026 de GRT/MANA/XTZ/ZEC ont déjà été consultées pendant la calibration `POWER_THIRD`. Une nouvelle lecture économique de ces mêmes fenêtres ne serait ni préenregistrée ni OOS propre. Aucun artefact `VALIDATED` ne satisfait quatre folds annuels propres par produit. |
| Risque live | **INCOMPLET** | Réconciliation de compte, brackets BUY, lifecycle SELL, kill/flatten idempotent, limite journalière et tests de recovery sont implémentés et testés localement | Aucun preflight live-OFF signé par Coinbase ni aucune confirmation exchange réelle des protections/permissions/portfolio n'a été conservé pour une release. |
| Ingénierie | **INCOMPLET** | `pnpm verify:push` passe localement : audit sans vulnérabilité connue, scan de secrets propre, 18/18 tâches de check, 18/18 tâches de test, 11/11 builds et test d'artefact Sites | Candidate non commitée, aucune CI GitHub propre sur son SHA, `main` non prouvée protégée et token GitHub local invalide. |
| Opérations | **FAIL** | Télémétrie structurée, bindings Analytics Engine, health endpoints, workflow live-OFF et runbook présents | Alertes non configurées, propriétaire d'astreinte et canal incident `UNASSIGNED`, health checks de production absents, secrets non vérifiés et rollback non répété/chronométré. |
| Shadow/canary | **FAIL** | Protocole et seuils d'arrêt figés | Aucun shadow de 30 jours/30 trades (ou 90 jours signal rare), aucun canary réel mono-produit de 48 h et aucune preuve d'intégrité d'exécution. |

## Décision fermée

Les premiers motifs applicables sont `RESEARCH_NOT_DEPLOYABLE` et
`RESEARCH_EVIDENCE_INCOMPLETE`. Les portes suivantes resteraient également
fermées avec `ENGINEERING_CI_NOT_GREEN`, `ENGINEERING_BRANCH_UNPROTECTED`,
`OPERATIONS_ALERTING_MISSING`, `OPERATIONS_RUNBOOK_MISSING` et
`CANARY_SHADOW_INSUFFICIENT`.

La réussite locale prouve que la candidate est techniquement vérifiable; elle
ne prouve ni l'alpha OOS de la politique exacte, ni le comportement du compte
Coinbase de production, ni la capacité opérationnelle à arrêter et récupérer le
système.

## Chemin minimal vers une nouvelle décision

1. Figer les changements dans un SHA de release, ouvrir la PR et obtenir une CI
   propre avec `main` protégée et le check requis.
2. Déployer ce SHA avec live OFF, configurer les alertes et les destinations,
   nommer l'astreinte/canal incident, exécuter les quatre health checks, les
   quatre preflights Coinbase et un rollback chronométré.
3. Produire une preuve économique réellement indépendante. Les fenêtres déjà
   observées ne peuvent pas être reclassées OOS. Avec le gate actuel, il faut
   quatre folds annuels futurs propres par produit; toute alternative plus
   rapide doit être modélisée et revue **avant** observation de ses résultats,
   sans réduction post-hoc des seuils.
4. Exécuter le shadow préenregistré, puis seulement après réussite des quatre
   premières portes un canary réel sur un produit avec budget de perte, humain
   présent et kill prétesté. Étendre après 48 h sans trigger de rollback.

Jusqu'à la soumission de ces preuves structurées pour le même SHA et la même
politique, `LIVE_TRADING_ENABLED` doit rester `false`.
