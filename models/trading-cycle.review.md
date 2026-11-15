# Revue du modèle — cycle de trading

## Couverture

| Cas | Transition attendue | Décision |
| --- | --- | --- |
| Démarrage nominal | `stopped → scheduling → waiting` | Couvert |
| Permission de contrôle absente | reste `stopped` avec code fermé | Couvert |
| Permission de trading absente | reste `stopped` avec code fermé | Couvert |
| Alarme dupliquée | reste `waiting` | Couvert |
| Données périmées | retry borné puis `NO_ACTION`, persistance et replanification | Couvert |
| Bougie déjà traitée | persistance `NO_ACTION`, aucun calcul ni ordre | Couvert par la politique live |
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
| Retry épuisé de `scheduling`, `reconcilingOrder` ou `persisting` | état stable `failed` | Couvert |
| Échec non retryable ou retry épuisé d’une opération de cycle (`reconcilingAccount`, `authorizing`, `fetchingMarketData`) | issue `FAILED` enregistrée puis persistée, retour à `scheduling` — l’agent n’est pas arrêté | Couvert |
| Retry épuisé sur données périmées (`fetchingMarketData`) | persistance `NO_ACTION`, retour à `scheduling`, aucun calcul ni ordre | Couvert |
| Reprise opérateur | `RESET → stopped` uniquement | Couvert |

## Contraintes de mise en œuvre

- Les adapters ne choisissent jamais la prochaine phase ; ils traduisent une réponse externe en événement typé.
- La machine ne calcule ni indicateur, ni signal, ni sizing. Elle appelle le cœur pur et consomme son résultat.
- Une exécution réessayée réutilise le `clientOrderId` déjà persisté et fabrique un nouveau JWT.
- Une clôture de bougie enregistrée n'est jamais évaluée une seconde fois,
  même après un reset ou un redémarrage live.
- La réconciliation interroge Coinbase par identifiant client avant toute nouvelle tentative.
- `failed` et `halted` n’ont aucune transition automatique.
- Une panne d’inspection de compte (échec non retryable ou budget de retries
  épuisé) n’atteint jamais l’état `failed` : aucun ordre n’est en vol, donc
  poursuivre est sûr. La garde `shouldFailAfterPersistence` ne s’ouvre que sur
  `terminalFailure` (défaut de protection, échec d’annulation) ; l’issue
  `FAILED` du cycle est persistée puis replanifiée. Seuls l’épuisement des
  retries de `scheduling`, `reconcilingOrder` ou `persisting` — et les
  défaillances terminales — rejoignent l’état stable `failed`, car y continuer
  est impossible (`scheduling`, `persisting`) ou dangereux (ordre inconnu en
  vol).

## Avis de revue

Le modèle couvre le chemin nominal, les erreurs externes et déterministes, les annulations, les retries bornés, les permissions et les états terminaux. Les transitions sont pilotées uniquement par des événements discriminés ; aucun texte libre ni sortie LLM n’est accepté comme événement de contrôle.
