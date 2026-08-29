# Revue du modèle d'exécution Hyperliquid

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Mode paper | hors de la politique, exécution simulée inchangée | Testé |
| Marché hors allowlist (`SOL-PERP`, …) | refus `PERP_PRODUCT_NOT_ALLOWED` | Testé |
| Un champ de risque supérieur à l'enveloppe | refus `PERP_POLICY_MISMATCH` | Testé |
| Venue ou timeframe différents | refus `PERP_POLICY_MISMATCH` | Testé |
| Enveloppe exacte | admission `APPROVED` | Testé |
| Intention malformée (quantité ≤ 0, levier non entier, …) | refus `PERP_INTENT_INVALID` | Testé |
| Admission absente à l'émission de l'ordre | refus `PERP_ADMISSION_REQUIRED` | Testé |
| Perte journalière à −1 000 USD | coupe-circuit, aucun ordre | Testé |
| Levier 3x | refus `PERP_LEVERAGE_EXCEEDED` | Testé |
| Ordre > 600 USD | refus `PERP_ORDER_NOTIONAL_EXCEEDED` | Testé |
| Position résultante > 10 000 USD | refus `PERP_POSITION_EXCEEDED` | Testé |
| Exposition brute > 10 000 USD avec autres produits | refus `PERP_EXPOSURE_EXCEEDED` | Testé |
| Short autorisé dans l'enveloppe (2x, long et short) | garde symétrique side BUY/SELL | Testé |
| Arrondi de taille | toujours vers zéro, jamais vers le haut | Testé |
| Clé d'agent absente | refus `AGENT_WALLET_NOT_READY`, aucun effet | Testé |
| Double soumission / clic pendant le cycle | `idle` non réceptif à un second `ORDER_INTENT_REQUESTED` | Testé |
| Intention non persistée | aucune signature : `persistingIntent` précède `signing` | Testé |
| Échec de signature | `failed` stable, `RESET` requis | Testé |
| Issue inconnue après soumission | réconciliation par `clientOrderId`, jamais de retry | Testé |
| Réconciliation impossible | `failed` stable | Testé |
| Issue rejetée | persistée puis `settled(REJECTED)` | Testé |
| Échec de persistance de l'issue | `failed`, jamais `settled` | Testé |
| Reprise après crash (intention persistée sans issue) | entre par `reconciling`, ne signe ni ne soumet | Testé |
| Reprise avec payload invalide | ignorée, machine reste `idle` | Testé |
| Clé ou signature dans le contexte | impossible : le type du contexte ne les contient pas | Modélisé (types) |
| Événement d'ordre hors `idle` | ignoré : seuls `INTENT_PERSIST_SUCCEEDED`/`FAILED` sont réceptifs | Testé |
| Arrondi vs incréments réels du marché | `szDecimals` figés, re-vérification obligatoire au préflight live | À tester au préflight |
| PnL journalier multi-produits | `otherGrossExposureNotional` fourni par le shell ; agrégation revue au câblage | À tester au shell |
| Signature EIP-712 | effet shell, domaine Hyperliquid, hors de cette machine | À tester au shell |
| Éligibilité géographique | prérequis opérateur avant live | À vérifier par l'opérateur |

La machine ne parle à aucun réseau et ne détient aucune clé. Elle séquence
persistance → signature → soumission → réconciliation → persistance et
n'accepte qu'une issue typée ; `tradingCycleMachine` et le shell Worker
restent respectivement l'arbitre du cycle et l'unique frontière réseau.
