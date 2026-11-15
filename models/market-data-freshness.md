# Fraîcheur marché lors d'une reprise — amendement du 13 octobre 2026

Statut : normatif, modélisé et revu avant implémentation. Source :
`docs/analysis/audit-fiabilite-paper-2026-10-13.md`, F1.
Amende `trading-cycle.machine`, `agent-runtime.md` et l'invariant 4 de
`market-retry-schedule.md`. Aucun seuil ni stratégie ne change.

## Contrat et décision

`MARKET_DATA_READY` porte un nouvel instant obligatoire `evaluatedAt` (ms UTC),
lu par le shell via l'horloge injectée **après** le fetch et son checkpoint,
immédiatement avant l'émission de l'événement. La machine ne lit pas d'horloge.

La garde `isFreshMarketData` exige :

- `triggeredAt`, `candleClosedAt` et `evaluatedAt` entiers sûrs non négatifs ;
- `candleClosedAt ≤ triggeredAt ≤ evaluatedAt` ;
- `evaluatedAt − candleClosedAt ≤ maxMarketStalenessMs`.

La borne est inclusive : à l'échéance exacte la bougie reste admissible,
une milliseconde après elle est périmée. La sélection des bougies reste
ancrée au déclenchement original : une reprise après minuit n'accepte pas
une nouvelle bougie postérieure à `triggeredAt` sous l'identité de l'ancien cycle.

Transitions existantes, ordre conservé :

1. Bougie déjà décidée → `persisting`, `NO_ACTION`, aucun calcul.
2. Bougie fraîche selon le contrat → `computingIndicators`.
3. Sinon → retry stale borné puis `persisting`, `NO_ACTION`, code
   `STALE_MARKET_DATA`. Aucun indicateur, signal, intention ni ordre.

Stop/kill restent prioritaires via `shutdownRequested`. Les délais, budgets
de retry et alertes de décision manquée restent inchangés. Un rejet ne met
pas à jour `lastDecisionCandleClosedAt`.

## Persistance et compatibilité

Pas de nouveau champ de contexte ni de migration SQLite. Les snapshots legacy
en `retryingMarketData`/`fetchingMarketData` reçoivent l'instant courant au
prochain succès marché, sans fallback vers leur ancien `triggeredAt`.
Un événement legacy sans `evaluatedAt`, ou avec une horloge invalide/régressive,
ne satisfait jamais la garde fraîcheur (fail-closed).

La correction porte sur l'admission du snapshot marché, pas sur un TTL
d'autorisation d'ordre : une phase déjà admise avant un redémarrage, ou un
calcul long après admission, n'est pas réévalué par ce lot. La perte du réveil
de grille (F2), les marks et la disponibilité fournisseur restent séparés.

## Vérification requise

- Reproduction 00:01:05 → reprise 02:01:01 : aucun calcul sur le close 00:00.
- Frontières échéance − 1 ms, exacte, + 1 ms.
- Instant absent, NaN, infini, fractionnaire, négatif, antérieur au trigger.
- Reprise après minuit : ancien close expiré et nouveau close refusés.
- Interpréteur restauré après 429 : pas de stratégie/intention/soumission
  sur réponse tardive ; test avec horloge avançant pendant le fetch/checkpoint.
- Reprise dans la fenêtre, doublon de bougie et stop/kill inchangés.
- Tests existants avec temps synthétiques : horloge explicitement injectée.
