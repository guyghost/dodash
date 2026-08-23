# Review — strategy-permission.md

Date : 2026-02-15 · Reviewer : agent (vérification contre le code) ·
Verdict : **APPROUVÉ** (2 corrections appliquées pendant la review)

## Vérifications contre le code

| #  | Claim du modèle | Preuve code | Verdict |
|----|-----------------|-------------|---------|
| R1 | Le mécanisme existe déjà et est paramétré | `regime-filter.ts` L104-117 : `resolveRegimePermission(regime, strategyId, permissions = DEFAULT_REGIME_PERMISSIONS)` — pur, total, déterministe | ✔ aucun nouveau résolveur à écrire |
| R2 | La table par défaut est inversée par rapport au besoin | `regime-filter.ts` L10-14 : `BEARISH: ["rsi-reversion"], RANGE: ["rsi-reversion"]` — rsi seule autorisée là où la perte se concentre | ✔ motivation fondée (weak-year-diagnosis §6) |
| R3 | Le replay n'utilise pas le paramètre permissions | `replay.ts` L658-661 : appel à 2 arguments → défaut codé en dur, non configurable | ✔ le levier est le câblage, pas le mécanisme |
| R4 | Warm-up ⇒ deny-all | `replay.ts` L658-667 : `activeRegime === null` → `permission = null` → condition `permission !== null && …` fausse → `countDenied` | ✔ comportement hérité, documenté INV-P5 |
| R5 | Permission side-agnostique | `regime-filter.ts` L116 : `allowed.includes(strategyId)` — aucun test du side | ✔ INV-P4 fondé |
| R6 | Instrumentation gratuite | `replay.ts` L308-317 : `regimeCounters.{signalsPassed,signalsFiltered}` + `deniedByStrategy` Map ; exposé dans `RegimeGatingSummary` (L101-108, alimenté L824-826) | ✔ |
| R7 | Le résolveur est déjà testé unitairement | `regime-filter.machine.test.ts` L148-179 : permission défaut (BULLISH/BEARISH/RANGE × stratégie), stratégie inconnue → deny, régime manquant → `INVALID_REGIME_POLICY` | ✔ la base de tests Verify existe |
| R8 | Pattern de validation config prêt à étendre | `replay.ts` L165-181 `validConfig` (booléen, champs optionnels `=== undefined ||` garde) — miroir exact pour `regimePermissions` + `isValidRegimePermissions` | ✔ |
| R9 | Fenêtres et portes reproductibles | `regime-sizing-walkforward.ts` windowBounds L47-54, portes CS4, folds propres {2023, 2025} — le script D3-P est un clone où seuls les candidats changent | ✔ comparabilité D2-S |
| R10 | WF3-P baselines disponibles | D2-S §8 : 2023 +0,27 % dd 2,93 % ; 2025 +3,63 % dd 3,37 % — même config V1, C0 = défaut ⇒ bit-identité attendue | ✔ |

## Corrections demandées et appliquées

1. **Contrôle d'effet (§6)** — la formulation originale
   (`deniedByStrategy[rsi] > 0`) était déjà vraie en C0 : le deny-all
   du warm-up (R4) compte les signaux rsi warm-up chez tous les
   candidats. Remplacé par un contrôle à delta :
   `denied(C_k) − denied(C0) > 0` sur les fenêtres faibles + contrôles
   de fills (zéro entrée rsi en BEARISH pour C1, zéro partout pour
   C2). Appliqué.
2. **Limite portes CS4 (§9)** — la formulation originale (« portes non
   ré-étalonnées ») masquait le vrai point : la porte médiane notional
   ne couvre que les stratégies calibrables (ema-cross, breakout —
   `CALIBRATED_STRATEGY_IDS`), dont les permissions ne changent pas.
   L'effet de C1/C2 sur rsi n'atteint le sélecteur que via les
   métriques globales. Précisé.

## Analyse des invariants

- **INV-P1** : fondé sur R3 + câblage `?? DEFAULT_REGIME_PERMISSIONS`.
  Vérifiable par WF3-P (bit-identité des baselines V1) — la garantie
  la plus forte du cycle : aucun risque de régression du défaut.
- **INV-P2** : `isValidRegimePermissions` à écrire — tests Verify :
  Record complet sur les 3 `RegimeKind`, liste vide acceptée (C1/C2),
  doublon rejeté, string vide rejetée, clé inconnue rejetée.
- **INV-P3** : grep de garde possible (aucune littérale de table de
  permission dans `packages/`).
- **INV-P4/P5** : hérités (R4, R5) — aucun comportement nouveau ; les
  tests R7 couvrent déjà le résolveur sur ces chemins.

## Couverture des cas (checklist Review)

- Nominaux : signal autorisé / dénié par (régime, stratégie) — tests
  R7 existants ; C0 bit-exact — WF3-P.
- Edge : warm-up deny-all (hérité, R4) ; liste vide = interdiction
  totale du régime (C1 BEARISH) — à tester unitairement ; bascules
  de régime fréquentes — le résolveur est sans état par candle, aucune
  transition à séquencer (pas de machine à états supplémentaire : le
  régime vient déjà de `regimeFilterMachine`, la permission est une
  fonction pure au-dessus — conforme à la règle « le modèle décide »).
- Erreurs : config invalide → rejet explicite par `validConfig`
  (pattern R8), jamais de comportement implicite.
- Interaction couches : permission amont du sizing conditionné —
  orthogonale, INV-S2 inchangé ; les signaux déniés ne sont jamais
  recalibrés (droppés en amont, `replay.ts` L656-675).

## Risques résiduels acceptés

- Side-agnosticisme (INV-P4) : C1 coupe aussi les SELL rsi en BEARISH.
  Réfinement par side = cycle ultérieur éventuel, seulement si VALIDÉ.
- C2 réutilise l'espace de l'ablation M5 mais la soumet aux portes et
  à la sélection — aucune conclusion M5 n'est un verdict.
- Le sélecteur ne voit l'effet rsi que via les métriques globales
  (correction 2) — biais de sélection possible en faveur de C0 ;
  assumé pour la comparabilité.
