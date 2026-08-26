# Review — Diagnostic mix core-satellite (H-CS1)

Statut : APPROUVÉ AVEC CORRECTIONS (clarifications — intégrées au modèle)
Date : 2026-08-26
Modèle : `models/core-satellite-mix.md`

Fichiers vérifiés : `packages/backtest/src/suite.ts` (L67-71, L200-238),
`packages/backtest/src/metrics.ts` (L32-105), `packages/backtest/src/replay.ts`
(L141, L597-604, L829-834), `packages/backtest/src/index.ts`,
`models/confidence-sizing-walkforward.md`, `models/strategy-permission.md` §6,
`models/bull-alpha-diagnosis.md` §3, `models/signal-edge-inventory.md`.

## Checklist

### Cohérence avec le code réel
- [x] `benchmarkBuyAndHold` (suite.ts L200-238) : mécanique exacte —
      slippage L207, feeRate L208, quantité L209, finalEquity L229-231.
- [x] `calculateMetrics` : totalReturn/maxDrawdown/sharpe définis sur la
      seule courbe (metrics.ts L40, L81, L83-89).
- [x] `equityCurve` : un point par bougie, `at = candle.start`, marqué au
      close, chemins warmup et normal cohérents (replay.ts L597-604,
      L829-834).
- [x] Exports publics suffisants (`BacktestResult.equityCurve`,
      `calculateMetrics`, `EquityPoint`).
- [ ] `benchmarkBuyAndHold` ne produit ni courbe ni dd (résumé seul) —
      clarifié après correction #1 : le script construit la courbe.

### Cohérence avec les modèles antérieurs
- [x] Baselines V1 et tolérance 5e-5 — identiques WF2/WF3-P.
- [x] Config V1 — identique confidence-sizing-walkforward.md §3 et
      strategy-permission.md §6.
- [x] Fenêtres contaminées 2023/2025 — correctement citées.
- [x] ~118 pt (bull-alpha §3), champion ~+1,7 %/an (recalculé
      géométriquement ≈ +1,65 %), dd max C0 = 6,88 % — exacts.

### Discipline a priori
- [x] Grille w {0,25 ; 0,5 ; 0,75} + extrémités, fixée avant mesure.
- [x] W-CS-A/B/C binaires, non ajustables post-hoc.
- [x] INV-CS1 à CS5 vérifiables mécaniquement.
- [x] Contamination consignée honnêtement (§7).

### Soundness statistique/financière
- [x] Mise à l'échelle linéaire exacte (aucun chemin de décision ne dépend
      de w — INV-CS5) ; l'argument est rigoureux.
- [x] G(w) géométrique, Calmar standard, DDworst = max des dd annuels.
- [x] `calculateMetrics(curve, [], 10_000, 0)` safe (profitFactor null,
      champs par trades sans objet).
- [x] dd du mix calculé sur la courbe composée — capture les corrélations
      intra-jour, pas de fausse additivité.
- [x] Sharpe √252 qualifié d'indicatif, jamais critère.
- [ ] Sous-exposition du bot non assumée comme limite — ajoutée après
      correction #2 (polarisation probable du verdict).

## Corrections demandées (appliquées au modèle avant exécution)

1. **§3** : expliciter que `benchmarkBuyAndHold` ne retourne qu'un résumé
   — le script construit la courbe holding bougie par bougie avec la même
   mécanique d'achat, puis `calculateMetrics` pour le dd M0 et la jambe
   du mix.
2. **§7** : assumer la sous-exposition structurelle du bot comme limite —
   pour w ≥ 0,50 la jambe bot est majoritairement du cash ; W-CS-B quasi
   automatique, W-CS-C quasi impossible ; verdict probable NON SOUTENU,
   le critère conjoint reste falsifiable.
3. **§4** : préciser la gestion du warmup — l'alignement couvre toutes les
   bougies (bot flat pendant le warmup, holding investie dès la première).

## Risques résiduels assumés

- Sharpe annualisé par √252 sur 365 points : biaisé mais indicatif, jamais
  critère.
- Reboot annuel du mix : mix continu = modèle séparé, hors périmètre.
- 2016 potentiellement indisponible : INV-CS4 gère (élimination consignée).
- Appel métriques avec trades vides : sans objet documenté.
