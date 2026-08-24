# Modèle de décision de lancement live

Ce modèle est la source de vérité du verdict `GO` / `NO_GO` pour le trading
live avec capital réel. Il ne déploie rien et n'active jamais le live : il
évalue des preuves fermées, dans un ordre déterministe, avant qu'un opérateur
distinct puisse demander un déploiement.

Le verdict est **fail-closed**. Une preuve absente, périmée, incohérente ou
partielle vaut `NO_GO`; un texte libre, un avis humain ou un LLM ne peut jamais
remplacer une porte.

## Périmètre figé

- release identifiée par un SHA Git complet ;
- produits live exactement égaux à l'allowlist de `live-trading-policy` ;
- marché spot long-only, timeframe de décision `ONE_DAY` ;
- configuration et limites égales à la politique live versionnée ;
- verdict valable uniquement pour ce SHA et cette politique.
- instant d'évaluation UTC explicite, utilisé pour refuser les preuves
  opérationnelles futures ou âgées de plus de 24 heures.

Toute modification du SHA, de la politique, des produits, des stratégies, du
sizing ou du risque invalide le verdict et exige une nouvelle évaluation.
`LAUNCH_REQUESTED` est refusé avant la porte recherche si le SHA n'est pas 40
hexadécimaux minuscules, si le policy ID diffère de
`LIVE_TRADING_POLICY_ID`, si l'allowlist diffère de
`LIVE_TRADING_PRODUCTS`, ou si l'instant d'évaluation est invalide.

## États, événements et transitions

```text
idle
  └─ LAUNCH_REQUESTED → assessingResearch
       ├─ RESEARCH_EVIDENCE_SUBMITTED valide → assessingRisk
       └─ preuve invalide → rejected(RESEARCH_*)
            └─ RETRY_REQUESTED → assessingResearch

assessingRisk
  ├─ RISK_EVIDENCE_SUBMITTED valide → assessingEngineering
  └─ preuve invalide → rejected(RISK_*)

assessingEngineering
  ├─ ENGINEERING_EVIDENCE_SUBMITTED valide → assessingOperations
  └─ preuve invalide → rejected(ENGINEERING_*)

assessingOperations
  ├─ OPERATIONS_EVIDENCE_SUBMITTED valide → assessingCanary
  └─ preuve invalide → rejected(OPERATIONS_*)

assessingCanary
  ├─ CANARY_EVIDENCE_SUBMITTED valide → approved (terminal)
  └─ preuve invalide → rejected(CANARY_*)
```

`CANCEL_REQUESTED` mène à `cancelled` depuis tout état d'évaluation.
`RESET` est accepté uniquement depuis `rejected` et revient à `idle`.
`RETRY_REQUESTED` depuis `rejected` recommence toujours à la première porte :
aucune preuve antérieure n'est conservée après un échec.

`approved` et `cancelled` sont terminaux. Un nouveau SHA exige un nouvel acteur.

## Porte 1 — recherche OOS sur les produits live

La preuve porte sur les quatre produits live exacts et sur une campagne
préenregistrée avant lecture de ses métriques économiques finales.

Conditions cumulatives :

1. SHA, identifiant de politique et produits correspondent au lancement ;
2. au moins quatre folds annuels propres par produit ;
3. au moins trois folds sur quatre ont un rendement net strictement positif
   pour chaque produit ;
4. rendement net médian strictement positif pour chaque produit ;
5. profit factor agrégé strictement supérieur à 1 pour chaque produit ;
6. espérance nette par trade strictement positive pour chaque produit ;
7. drawdown maximal inférieur ou égal à 10 % sur chaque fold ;
8. frais, spread, slippage et latence décision→exécution sont inclus ;
9. aucun fold, produit ou trade n'est retiré après observation ;
10. le verdict de campagne est `VALIDATED`, jamais `RESEARCH_ONLY`.

Le win rate est consigné mais n'est pas une porte isolée : il ne peut compenser
une espérance, un profit factor ou un rendement net négatif.

Motifs fermés : `RESEARCH_SCOPE_MISMATCH`, `RESEARCH_EVIDENCE_INCOMPLETE`,
`RESEARCH_OOS_FAILED`, `RESEARCH_COST_MODEL_INCOMPLETE`,
`RESEARCH_NOT_DEPLOYABLE`.

## Porte 2 — risque live exécutable

Conditions cumulatives :

1. chaque position live possède des ordres protecteurs stop/take confirmés par
   l'exchange, ou aucune position n'est ouverte ;
2. les ordres ouverts, fills, balances et positions Coinbase sont réconciliés
   avant toute nouvelle décision ;
3. les limites de position et d'exposition agrègent l'état réel du compte, pas
   seulement le portefeuille virtuel de l'Agent ;
4. le kill switch annule les ordres ouverts, liquide la position gérée de
   manière idempotente, réconcilie l'issue, puis atteint `halted` ;
5. la limite de perte journalière est effectivement observable et testée avec
   le timeframe live ;
6. un défaut de réconciliation, de protection ou de mesure de risque ferme les
   nouvelles entrées ;
7. les tests couvrent succès, rejet, fill partiel, timeout, retry, crash,
   annulation et idempotence.

Motifs fermés : `RISK_PROTECTION_MISSING`, `RISK_ACCOUNT_NOT_RECONCILED`,
`RISK_KILL_NOT_FLATTENING`, `RISK_DAILY_LIMIT_INEFFECTIVE`,
`RISK_FAILURE_NOT_CLOSED`, `RISK_TEST_COVERAGE_INCOMPLETE`.

## Porte 3 — ingénierie et sécurité

Conditions cumulatives pour le SHA évalué :

1. installation verrouillée, check statique, tests, build et tests d'artefact
   réussis dans un checkout CI propre ;
2. aucun test flaky, ignoré ou dépassant son timeout dans la CI de référence ;
3. audit de dépendances : zéro vulnérabilité `critical` ou `high` ;
4. scan de secrets sans résultat ;
5. branche `main` protégée, check CI requis avant merge et push direct bloqué ;
6. le workflow de déploiement dépend du même SHA et du gate réussi ;
7. en-têtes de sécurité et limitation de débit présents sur la frontière
   d'authentification publique.

Motifs fermés : `ENGINEERING_CI_NOT_GREEN`, `ENGINEERING_TESTS_UNSTABLE`,
`ENGINEERING_SECURITY_AUDIT_FAILED`, `ENGINEERING_SECRET_SCAN_FAILED`,
`ENGINEERING_BRANCH_UNPROTECTED`, `ENGINEERING_RELEASE_SHA_MISMATCH`,
`ENGINEERING_EDGE_HARDENING_MISSING`.

## Porte 4 — opérations, observabilité et rollback

Conditions cumulatives :

1. `releaseSha` et `deploymentSha` égalent le SHA évalué ; la collecte est
   antérieure ou égale à l'instant d'évaluation et date d'au plus 24 heures ;
2. logs structurés, métriques et alertes couvrent erreurs, latence, cycles,
   ordres inconnus, réconciliation, exposition, PnL et déclenchements de risque ;
3. health checks des quatre Workers testés après déploiement ;
   - l'assertion santé tolère le délai de propagation edge post-promotion :
     retries bornées (fenêtre ≤ 90 s) sur le corps `{"status":"ok"}`, car une
     réponse 200 peut temporairement servir un résidu de la version précédente ;
   - le probe API respecte strictement le contrat de routage dashboard-api
     (`searchParams` rejetés hors `cycles?limit`) : aucun paramètre synthétique
     (cache-buster) n'est ajouté à l'URL probe — sinon la réponse attendue est
     404 `NOT_FOUND`, pas 401 `UNAUTHORIZED` ;
4. runbook d'incident et propriétaire d'astreinte identifiés ;
5. rollback versionné, chronométré et vérifié sans perte d'intégrité ;
6. déploiement incrémental : code avec live OFF, smoke test, puis un seul produit ;
7. seuils d'arrêt explicites avant activation ;
8. secrets et bindings de production vérifiés sans les journaliser.

Motifs fermés : `OPERATIONS_SCOPE_MISMATCH`, `OPERATIONS_EVIDENCE_STALE`,
`OPERATIONS_OBSERVABILITY_MISSING`,
`OPERATIONS_ALERTING_MISSING`, `OPERATIONS_HEALTHCHECK_FAILED`,
`OPERATIONS_RUNBOOK_MISSING`, `OPERATIONS_ROLLBACK_UNVERIFIED`,
`OPERATIONS_ROLLOUT_UNSAFE`, `OPERATIONS_SECRETS_UNVERIFIED`.

## Porte 5 — shadow puis canary

La preuve canary est propre au SHA, à la politique et au premier produit.

Conditions cumulatives :

1. shadow/paper sur données live pendant au moins 30 jours calendaires ;
2. au moins 30 trades clôturés ou, si le signal est trop rare, une durée de
   90 jours sans réduire ce seuil après observation ;
3. zéro ordre à issue inconnue non résolue, zéro duplication et zéro écart de
   position non réconcilié ;
4. slippage p95 inférieur ou égal au budget préenregistré ;
5. drawdown, perte journalière et exposition restent dans les limites ;
6. canary réel sur un seul produit, budget de perte approuvé, observateur humain
   disponible et kill switch testé juste avant activation ;
7. fenêtre d'observation de 48 heures sans trigger de rollback avant extension.

Motifs fermés : `CANARY_SHADOW_INSUFFICIENT`, `CANARY_SAMPLE_INSUFFICIENT`,
`CANARY_SCOPE_MISMATCH`, `CANARY_EXECUTION_INTEGRITY_FAILED`, `CANARY_SLIPPAGE_FAILED`,
`CANARY_RISK_LIMIT_BREACHED`, `CANARY_CONTROL_UNAVAILABLE`,
`CANARY_OBSERVATION_INCOMPLETE`.

## Permissions et effets de bord

- Le modèle et ses assesseurs sont purs et synchrones.
- Le shell seul collecte GitHub, Cloudflare, Coinbase et les artefacts.
- La collecte ne peut produire qu'un événement typé avec preuves structurées.
- `approved` autorise seulement la **demande d'extension au-delà du canary** ;
  il ne modifie aucun secret, flag, Worker, ordre ou position. L'autorisation
  opérateur d'activer le canary après les quatre premières portes est une
  décision séparée, auditée, réversible et ne constitue jamais un verdict `GO`.
- L'activation live reste une action opérateur séparée, auditée et réversible.

## Invariants

1. `approved` est impossible si une des cinq portes n'a pas réussi dans l'ordre.
2. Le premier échec détermine un code fermé et interdit toute porte suivante.
3. Une preuve d'un autre SHA, produit ou policy ID est refusée.
4. Après retry, toutes les portes sont rejouées depuis la recherche.
5. Aucun booléen libre `force`, `override` ou `operatorApproved` n'existe.
6. Aucun LLM, texte libre ou rendement in-sample ne pilote une transition.
7. Les effets de déploiement et de trading sont hors du modèle de décision.
8. Un verdict `approved` est immuable et propre à un seul acteur/release.
9. Une preuve future ou une configuration modifiée ne rétrovalide jamais un SHA.
10. Si le comportement ne peut pas être prouvé par une structure typée, il est
    `NO_GO`.
11. Une entrée `workflow_dispatch` n'est jamais interpolée directement dans un
    script shell : elle est transportée par `env`, validée avant comparaison et
    utilisée entre guillemets.
