# Revue du modèle de décision de lancement live

Statut : APPROUVÉ POUR IMPLÉMENTATION

## Couverture du workflow

| Cas | Décision attendue | Couverture exigée |
| --- | --- | --- |
| lancement nominal | cinq preuves successives → `approved` | test machine |
| mauvais SHA/policy/produits | rejet à la porte recherche | test assesseur + machine |
| scope initial hors politique figée | `LAUNCH_REQUESTED` → rejet recherche | test machine |
| alpha ou sécurité OOS insuffisants | rejet `RESEARCH_*` | test assesseur |
| protection exchange absente | rejet `RISK_PROTECTION_MISSING` | test assesseur |
| compte non réconcilié | rejet `RISK_ACCOUNT_NOT_RECONCILED` | test assesseur |
| kill sans liquidation | rejet `RISK_KILL_NOT_FLATTENING` | test assesseur |
| daily loss inopérante | rejet `RISK_DAILY_LIMIT_INEFFECTIVE` | test assesseur |
| CI rouge ou flaky | rejet `ENGINEERING_*` | test assesseur |
| vulnérabilité high/critical | rejet sécurité | test assesseur |
| branche non protégée | rejet branche | test assesseur |
| observabilité/rollback incomplets | rejet `OPERATIONS_*` | test assesseur |
| preuve opérations ancien/autre SHA | rejet scope ou fraîcheur | test assesseur + machine |
| shadow/canary incomplet | rejet `CANARY_*` | test assesseur |
| canary d'un autre SHA/policy/produit | rejet `CANARY_SCOPE_MISMATCH` | test assesseur |
| preuve hors séquence | ignorée, état inchangé | test machine |
| annulation | `cancelled` terminal | test machine |
| retry après rejet | retour porte recherche, preuves effacées | test machine |
| reset après rejet | `idle`, contexte initial | test machine |
| événement après terminal | ignoré | test machine |

## Revue des cas nominaux et limites

La recherche porte sur les actifs réellement autorisés en live et non sur BTC
ou sur une preuve de seule échelle notionnelle. Les coûts et métriques d'alpha
sont obligatoires. Les seuils sont fixés avant la nouvelle campagne économique :
trois folds positifs sur quatre par produit, médiane positive, profit factor et
espérance strictement positifs, drawdown au plus égal à 10 %.

La porte risque décrit des protections **exécutées** par Coinbase et une vision
du compte réel. Elle interdit de présenter les nombres `stopLossBps`,
`takeProfitBps`, `maxDailyLoss` ou le kill switch comme protections si le chemin
live ne les matérialise pas.

La porte ingénierie distingue une réussite locale d'une CI propre. Un timeout
reste un échec : augmenter arbitrairement le timeout sans mesurer la durée ne
suffit pas. L'audit sécurité et la protection de branche sont des preuves
externes mais structurées.

Le SHA et l'allowlist du scope ne sont pas choisis par l'appelant : ils sont
comparés à la politique live versionnée avant la première porte. Les preuves
opérationnelles sont liées au release/deployment SHA et à une collecte de moins
de 24 heures à l'instant d'évaluation.

Le canary est volontairement la dernière porte de la décision : un bon backtest
ne remplace pas une preuve d'exécution réelle. L'autorisation préalable de
lancer ce canary n'est donc pas le verdict `approved`; elle reste une décision
opérateur distincte après réussite des quatre premières portes. La règle
alternative 90 jours pour un signal rare est fixée avant observation et ne
diminue jamais l'exigence.

## Erreurs, annulations, retries et permissions

- Toute preuve mal formée ou non finie est rejetée avec le motif de sa porte.
- Aucun fallback vers un autre produit, profil ou SHA.
- `CANCEL_REQUESTED` n'exécute aucun effet et termine l'acteur.
- `RETRY_REQUESTED` ne reprend pas à la porte échouée : il invalide toutes les
  preuves afin d'éviter un mélange de dates ou de SHA.
- Seul un collecteur authentifié peut construire les preuves côté shell ; le
  modèle n'accorde aucune permission de déploiement ou de trading.
- `approved` et `cancelled` sont finaux ; `rejected` est stable jusqu'à retry ou
  reset explicite.

## Corrections imposées à l'implémentation

1. Utiliser `setup()` XState avec contexte et union d'événements explicites.
2. Gardes nommées et pures ; calculs de verdict dans des assesseurs purs séparés.
3. Mise à jour du contexte uniquement via `assign`, sans mutation.
4. Conserver `failedStage`, `reasonCode`, SHA et policy ID dans le contexte.
5. Tester chaque transition autorisée/interdite et les deux états terminaux.
6. Ne pas ajouter de champ d'override, même réservé aux tests.
7. Transporter tout input `workflow_dispatch` via `env` et le valider avant son
   premier usage shell.

## Verdict de revue

Le modèle couvre cas nominaux, erreurs, annulation, retry, permissions et états
terminaux. Les transitions sont explicites et aucune décision n'est pilotée par
du texte libre. **GO pour implémentation**, sous réserve des six corrections
ci-dessus et d'un cycle TDD rouge→vert.
