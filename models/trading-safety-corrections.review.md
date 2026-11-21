# Revue — Corrections de sûreté du runtime et des protections (2026-11-21)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

- La demande « corrige » autorise les corrections locales des six constats reproduits. Les évolutions v7 déjà présentes sont conservées.
- Le cycle et les commandes utilisent l'acteur XState existant ; aucun nouvel état métier implicite ne décide d'un ordre. Le registre d'exécution du shell ne transporte que l'acteur et sa promesse.
- Les contrôles restent immédiats et le drainage conserve la réconciliation des soumissions possibles. Les appels concurrents rejoignent l'exécution ; le propriétaire est toujours libéré.
- La protection est calculée par une fonction pure de `models/`, puis transportée par un événement typé et persistée avant les effets. Son identité borne sa reprise ; les données legacy se normalisent sans inventer d'historique.
- L'exemption consolidée repose sur des quantités ou expositions numériques validées, jamais sur un booléen de décision fourni par l'effet. Le kill switch, les permissions et les statuts restent prioritaires.
- La projection et le dashboard sont en lecture seule. Une protection absente ou incompatible reste absente ; un plan paper n'est pas un ordre exchange confirmé.
- Limite acceptée : les anciens extrêmes non persistés ne peuvent être reconstruits au-delà des bougies disponibles. Les nouveaux extrêmes sont conservés ; aucune donnée de production n'est réécrite.
- Les tests couvriront chaque point de « Vérification requise », les régressions v7 et les frontières mono/multi-produits.

## Vérification de l'implémentation — 2026-11-21

| Contrat | Preuve de non-régression |
| --- | --- |
| Stop/kill avant soumission et réveils concurrents | `apps/agent/test/trading-safety.test.ts` : `handles $command while $stage is in flight without duplicate execution`, 12 combinaisons fetch/allocation/autorisation/soumission |
| Réconciliation après soumission possible | Les variantes `submission` attendent exactement une soumission et une réconciliation, puis `stopped` ou `halted` |
| Libération du propriétaire après erreur | `releases execution ownership after an error` |
| Contrôle de tous les produits avant drainage | `broadcasts %s to every portfolio product before draining an active cycle`, stop et kill |
| Trailing LONG/SHORT et persistance | `preserves a trailing stop after the peak candle leaves the rolling window for quantity %s` et `carries protection through stop/start and restores it until explicit reset` |
| Monotonie avec ATR, nouvelle entrée, legacy | `models/paper-position-protection.test.ts`, 6 cas |
| Risque consolidé, réductions partielles et kill | `models/portfolio-risk-reduction.test.ts`, 8 cas ; `packages/risk/test/position-reduction.test.ts`, 3 cas ; clôture protectrice via l'interpréteur |
| Plans short, trailing dans l'historique et fermeture | `models/paper-protection-history.test.ts`, 3 cas |
| Short visible, échelle orientée, absence de protection et isolation produit | `apps/dashboard/test/position-protection.test.tsx`, 3 cas |
| Frais d'ouverture et de clôture short | `includes both opening and closing short fees in realized pnl` et suite v7 du broker conservée |

- `npm run check` : réussi sur les 13 packages.
- `npm test` : 1 564 tests réussis, dont 20 tests de sûreté de l'agent et les régressions v7 ; cache Turbo réutilisé pour les packages non modifiés.
- `npm run lint` : réussi, 27 avertissements et 14 informations préexistants ; aucune nouvelle erreur.
- `npm run scan:secrets` : réussi.
- `npm run build` : réussi sur les 13 packages.
- Vérification navigateur native Dia sur le serveur local `127.0.0.1:5174` : démo chargée, protection BTC affichée depuis ses faits ; sélection ETH sans protection disponible affichée « NON PROTÉGÉ » sans niveaux inventés.
- Les tests de course utilisent le shell et l'interpréteur réels avec SDK/effets simulés. Aucune validation en production ni ordre réel.
- `npm --prefix apps/dashboard run test:sites` : 4 tests réussis sur les artefacts construits.
