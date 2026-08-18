# Revue du modèle — cycle de trading

## Couverture

| Cas | Transition attendue | Décision |
| --- | --- | --- |
| Démarrage nominal | `stopped → scheduling → waiting` | Couvert |
| Permission de contrôle absente | reste `stopped` avec code fermé | Couvert |
| Permission de trading absente | reste `stopped` avec code fermé | Couvert |
| Alarme dupliquée | reste `waiting` | Couvert |
| Données périmées | retry borné puis persistance d’échec | Couvert |
| Signal HOLD / aucune allocation | persistance `NO_ACTION`, aucun ordre | Couvert |
| Risque refusé | persistance `RISK_REJECTED`, aucun ordre | Couvert |
| JWT invalide/expiré | régénération bornée | Couvert |
| Rejet d’ordre certain | retry borné avec même intention | Couvert |
| Issue d’ordre inconnue | réconciliation obligatoire | Couvert |
| Arrêt avant soumission | annulation de l’effet puis persistance | Couvert |
| Arrêt après soumission possible | réconciliation puis persistance | Couvert |
| Kill switch | arrêt contrôlé vers `halted` | Couvert |
| Permission révoquée | plus de nouvel ordre, puis `halted` | Couvert |
| Persistance indisponible | retry borné ; aucun rescheduling avant succès | Couvert |
| Retry épuisé | état stable `failed` | Couvert |
| Reprise opérateur | `RESET → stopped` uniquement | Couvert |

## Contraintes de mise en œuvre

- Les adapters ne choisissent jamais la prochaine phase ; ils traduisent une réponse externe en événement typé.
- La machine ne calcule ni indicateur, ni signal, ni sizing. Elle appelle le cœur pur et consomme son résultat.
- Une exécution réessayée réutilise le `clientOrderId` déjà persisté et fabrique un nouveau JWT.
- La réconciliation interroge Coinbase par identifiant client avant toute nouvelle tentative.
- `failed` et `halted` n’ont aucune transition automatique.

## Avis de revue

Le modèle couvre le chemin nominal, les erreurs externes et déterministes, les annulations, les retries bornés, les permissions et les états terminaux. Les transitions sont pilotées uniquement par des événements discriminés ; aucun texte libre ni sortie LLM n’est accepté comme événement de contrôle.

