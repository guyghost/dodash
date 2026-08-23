# Revue du modèle du filtre de régime

| Cas | Décision explicite |
| --- | --- |
| Politique invalide (bps hors bornes, compteurs < 1, non finis) | `failed` `INVALID_REGIME_POLICY` avant toute observation, via transition sans événement |
| Snapshot valide haussier / baissier / range | classification brute fermée, aucun autre régime possible |
| Séparation EMA exactement égale à `thresholdBps` | `RANGE` (inégalités strictes) |
| EMA non finie, nulle ou négative | `failed` `INVALID_REGIME_OBSERVATION` |
| Timestamp regressé, dupliqué ou non entier | `failed` `INVALID_REGIME_OBSERVATION` |
| Moins de `minObservations` bougies | reste `warmingUp`, aucun régime publié |
| Série consécutive < `confirmationCount` en entrée | reste `warmingUp`, série conservée |
| Brutes alternées autour du seuil (flapping) | la série opposée se remet à zéro à chaque observation conforme ; aucun claquement |
| Brute opposée isolée en régime confirmé | état inchangé, série opposée incrémentée |
| `confirmationCount` brutes opposées consécutives | transition unique vers le régime opposé, compteurs réinitialisés à l'entrée |
| Observation conforme après série partielle | série opposée remise à zéro, état inchangé |
| `STOP_REQUESTED` en `warmingUp` ou régime confirmé | `stopped` terminal, raison typée |
| Événement après `failed` ou `stopped` | ignoré, aucun recyclage implicite ; nouvel acteur requis |
| `strategyId` absent de la carte du régime courant | permission refusée (deny by default) |
| Carte de permissions incomplète ou vide | refus pour les régimes non listés ; la carte reste une entrée validée, jamais déduite |
| Erreur de la couche d'indicateurs en amont | aucun `CANDLE_CLOSED` émis ; le filtre reste dans son état, aucune transition sur silence |
| Retry | aucun : le calcul est local et déterministe ; un nouvel acteur repart de zéro |

La revue couvre nominal, erreurs fermées, annulation, états terminaux et
permissions. Les transitions sans événement de `idle` sont déterministes et ne
dépendent que de la politique d'entrée. Aucune transition ne dépend d'un LLM,
d'un texte libre ou d'un seuil non figé. La persistance, les ordres Coinbase,
le sizing et le live trading ne font pas partie de cet acteur ; le filtre se
place en amont de l'évaluation des stratégies du replay et de l'agent.
