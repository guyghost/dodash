# Review — Inventaire branche 4 signaux et données

Statut : APPROUVÉ AVEC CORRECTIONS (intégrées au modèle)
Date : 2026-08-26
Modèle : `models/signal-edge-inventory.md`

Fichiers vérifiés : `packages/strategies/src/ema-cross.ts` L26-35,
`packages/indicators-prolog/src/engine.ts` L28-31,
`models/regime-filter.ts` L10-14/L99-110, `models/regime-filter.md`,
`models/weak-year-diagnosis.md` §6, `models/bull-alpha-diagnosis.md`,
`models/regime-slope.md`, `models/strategy-permission.md` L259-263,
artefacts `.artifacts/studies/` et `.artifacts/backtests/` (produits).

## Checklist

### Constat mécanistique §3.2 (verrou ema-cross)
- [x] Émission uniquement à la transition — vérifié (L26-35, HOLD sinon,
      `EMA_WARMUP` si `previous === null`).
- [x] Mêmes EMAs 12/26 que le filtre — vérifié (engine.ts L30-31).
- [x] Gate EMA_THRESHOLD 100/5/3, ema-cross autorisé uniquement en
      BULLISH — vérifié (`DEFAULT_REGIME_PERMISSIONS`).
- [x] Cross-down doublement bloqué (absent de BEARISH) — vérifié,
      renforce l'inertie.
- [x] Délai ~8+ bougies (5 obs + 3 confirmations à > 100 bps) —
      raisonnement correct.
- [x] Raisonnement global logiquement et factuellement correct :
      **le constat de verrou structurel tient**.

### Faits compilés §2
- [x] wr 22-33 %, solo ≈ ensemble, SPOT_SHORT_FORBIDDEN 70,6 %, écart
      ~118 pt, gain 2020 n=1 +1 111 $, ema-cross 0,00 % sur 6 fenêtres,
      EMA_SLOPE sans amélioration — tous exacts aux sources citées.

### Classement §4
- [x] 4 hypothèses falsifiables, une par cycle, un levier chacune ;
      « pas de balayage » et « justification indépendante » explicites.

### Allowlist d'exclusion (correction majeure)
- [ ] Version initiale incomplète : **9 produits manquants** identifiés
      dans `.artifacts/studies/` (SOL, LTC via rsi-adx ; ETH via
      indicator-combinations ; AAVE, XLM via ATR ; LINK, AVAX via
      protective-brackets ; BCH, UNI via volume-entry-filter).
      → Corrigé : §5.1 du modèle liste 20 produits et définit
      explicitement « consulté » (fail-closed : tout artefact, toute
      config, y compris RESEARCH_ONLY).

### Nature inventaire
- [x] Aucune décision déployée ; renvoi explicite à un cycle complet par
      hypothèse ; statut MESURÉ-COMPILÉ.

## Corrections demandées (appliquées au modèle)

1. **Majeure — §4/§5** : allowlist d'exclusion H-D1 complétée (+ SOL,
   LTC, ETH, AAVE, XLM, LINK, AVAX, BCH, UNI = 20 produits au total) ET
   définition explicite de « produit consulté » posée en §5.1
   (fail-closed : toute apparition dans un artefact, quelle que soit la
   config, contamine les fenêtres 2022-2026 du produit). Le modèle H-D1
   devra re-vérifier la liste contre les artefacts à son exécution.
2. **Mineure — §3.2** : « l'écart est nul par construction » remplacé par
   la formulation exacte (strictement positif au cross, quasi nul,
   typiquement quelques bps au plus) ; ajout de la note double warm-up
   (renforce le verrou sans en être la cause).

## Risques résiduels assumés

- Définition de « contaminé » volontairement conservatrice : elle réduit
  le vivier H-D1 ; toute assouplissement (restriction aux runs V1
  complets) serait une décision post-hoc à pré-enregistrer séparément.
- Multiplicateurs de coût §3.4 (×24 à ×1440) : estimés par ratio de
  granularité, pas mesurés — acceptable pour un inventaire.
