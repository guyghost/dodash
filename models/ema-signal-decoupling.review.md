# Review — H-S1a Découplage des EMAs de signal du filtre de régime

Statut : APPROUVÉ AVEC CORRECTIONS (intégrées au modèle)
Date : 2026-08-26
Modèle : `models/ema-signal-decoupling.md`

Fichiers vérifiés : `packages/strategies/src/ema-cross.ts` (L1-63),
`packages/indicators-prolog/src/engine.ts` (L1-487, notamment validConfig
L186+, requiredIndicatorCandles L203-215, requêtes Prolog L308-312, snapshot
L469-475), `models/regime-filter.ts`, `models/weak-year-diagnosis.md` §6.4,
`models/signal-edge-inventory.md` §4, `models/product-oos-replication.md`
§8.1, `packages/backtest/src/replay.ts` (L202-229 validPreparedIndicators,
L641-654 régime), `packages/backtest/src/prepared-indicators.ts`,
`apps/agent/src/configuration.ts`, `packages/strategies/test/strategies.test.ts`.

## Checklist

### Exactitude des faits §2
- [x] crossedUp/crossedDown stricte transition, HOLD sinon, warm-up
      `previous === null` — vérifiés.
- [x] Confidence |fast−slow|/slow ; DEFAULT 12/26 ; convention `?? 0` du
      snapshot ; permissions BULLISH-only ; solo ema 0,00 % sur 6 fenêtres.

### Mécanisme §3
- [x] INV-E1 : champs absents ⇒ aucune requête Prolog additionnelle.
- [x] INV-E3/E4 : usage exclusif de la paire active ; le filtre consomme
      toujours 12/26 (vérifié replay.ts L641-654).
- [ ] Bascule fallback/warm-up → propriété de bascule 5/13 documentée
      (correction 3) : premier candle évalué ⇒ HOLD (INV-E6), candle
      suivant ⇒ paire 5/13 active définitivement, aucune transition
      silencieuse en cours de replay.
- [ ] `requiredIndicatorCandles` et la garantie signalEma > 0 → INV-E2
      étendu (correction 2) : le warm-up inclut `signalEmaSlowPeriod`.

### Justification a priori §4
- [x] Pré-enregistrement « ex. 5/13 vs 12/26 — pas de balayage » réel
      (signal-edge-inventory §4, ligne 81).
- [x] Argument structurel correct (5 < 12, 13 < 26 ⇒ crosses possibles en
      BULLISH confirmé) ; aucun tuning possible (0 trade historique).

### Protocole §6
- [x] Miroir D3-P2 exact (portes, argmax, défaut E0, folds propres = 6,
      WF3-E tol 5e-5).
- [x] Contrôles d'effet 1-2 falsifiables ; contrôle 3 (confinement
      structurel par permissions + INV-E4) défendable.

### Critères §7 et verrou §8
- [x] W1-E/W2-E/W3-E falsifiables ; note spread nul (leçon H-P2).
- [x] Verrou H-D2 : pool 43 − 4 brûlés = 39 — compte vérifié exact.

### Implémentabilité §9
- [ ] `validPreparedIndicators` (replay.ts L202-229) devait être ajouté à
      la surface — faille critique INV-E1 sinon (correction 1, appliquée).
- [ ] Consommateurs secondaires (Zod agent, factory test) notés §12
      (correction 4).

### Limites §11
- [x] SELL↔rsi, turnover, confidence, in-sample BTC — honnêtes.
- [ ] Chemin prepared-indicators ajouté (correction 1 bis).

## Corrections demandées (toutes appliquées au modèle)

1. **§9/§11** : `validPreparedIndicators` doit comparer les champs
   optionnels entre config préparée et config replay — sans cela WF3-E
   passe avec un mismatch silencieux (INV-E1 violé sans détection).
2. **INV-E2** : `requiredIndicatorCandles` inclut `signalEmaSlowPeriod`
   quand présent — le warm-up couvre la paire de signal (option robuste
   plutôt que restriction d'espace).
3. **§3** : propriété de bascule pour 5/13 documentée — pas de fenêtre où
   signalEma = 0 avec EMAs valides ; dépend de
   `signalEmaSlowPeriod ≤ emaSlowPeriod` (garanti par INV-E2).
4. **§12** : consommateurs secondaires notés (schéma Zod agent, factory
   snapshot des tests) — compilation, hors chemin critique.

## Risques résiduels assumés

- Le cœur pur est touché (engine + stratégie) : un bug subtil sur E1
  pourrait échapper à WF3-E seul (E0 bit-identique ≠ E1 correct) — mitigé
  par le contrôle d'effet solo et les tests INV-E1..E6.
- L'argument structurel garantit des crosses, pas leur signe : les
  cross-down 5/13 en fin de BULLISH peuvent dominer — W1/W2/W3 le
  détecteront.
- Confidence 5/13 typiquement plus faible au cross : interaction avec
  l'allocation mesurée par le walk-forward d'ensemble, pas isolément.
