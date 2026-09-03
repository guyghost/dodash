# Review — Stratégie perp consciente du taux de financement (DAO #27)

Statut : APPROUVÉ AVEC CORRECTIONS (intégrées au modèle)
Modèle : `models/funding-rate-strategy.md`

Fichiers vérifiés : `packages/indicators-prolog/src/engine.ts` (paramètres
`computeIndicators`, validation, `parseAnswer`, snapshot), `prolog/series.pl`
(`sma/3`, `last_n`, `sum_values`), `packages/strategies/src/strategy.ts`,
`rsi-reversion.ts`, `ema-cross.ts`, `confidence-calibration.ts`,
`packages/backtest/src/replay.ts` (boucle, points d'équité, warm-up),
`packages/allocator/src/allocator.ts` (usage de confidence),
`packages/domain/src/trading.ts` (`createSignal`), `apps/agent/src/configuration.ts`,
`apps/agent/src/strategy-registry.ts`, `apps/agent/src/hyperliquid-execution.ts`
(`boundedRequest`, `finiteFrom`), `models/regime-filter.ts`,
`models/live-trading-policy.ts`, `models/hyperliquid-execution.ts`
(`HYPERLIQUID_PERP_POLICY`, admission), `models/confidence-calibration.ts`
(`CALIBRATED_STRATEGY_IDS`), `models/hyperliquid-signals.md`,
`models/hyperliquid-shell.md`, `models/effects.md`, `models/ema-signal-decoupling.md`
(précédent INV-E1/E2), tests existants (`strategies.test.ts`, `engine.test.ts`,
`configuration.test.ts`, `hyperliquid-signals.test.ts`).

## Checklist

### Décision C1 §2
- [x] 0 occurrence de funding dans le code — vérifié (grep TS/MD/PL).
- [x] `mcp-market-data` est bien mono-source Coinbase (routes
      `/internal/candles`, `/internal/ticker`, wrangler sans binding
      Hyperliquid) ; le modèle ne le modifie pas.
- [x] Le shell `/info` agent existe (`boundedRequest` : 1 MiB, 10 s,
      null si hors spec) ; `fundingHistory` est public sans signature L1
      — chemin sans credential, modélisable proprement : pas de STOP.
- [x] Fail-closed cohérent avec `models/hyperliquid-shell.md` (lecture
      hors spec ⇒ null ⇒ jamais de zéros substitués).
- [ ] **Correction 1** : le modèle omettait le format de réponse —
      `fundingRate` est sérialisé en chaîne numérique ; coercition via
      `finiteFrom` exigée, toute autre forme rejette la lecture entière
      (appliqué §2).
- [x] Le backtest consomme la même série pure 1:1 : cœur métier unique,
      sans I/O.

### Périmètre §1/§3
- [x] Le branchement runtime (`tradingCycleMachine`, interpréteur) est
      explicitement hors périmètre d'implémentation et spécifié pour un
      cycle séparé — cohérent avec la règle Model → Review → Implement →
      Verify (machine touchée ⇒ son propre passage). La stratégie reste
      inactive au sens plein tant que la couture n'est pas branchée (C3).
- [x] Critère d'acceptation 3 (stratégie enregistrée) respecté par le
      registre agent, sans activation live.

### Indicateur §4
- [x] `sma/3` existe et porte les gardes nécessaires
      (`Period > 0`, `Length >= Period`) : l'enrobage
      `funding_average/3` est minimal et honnête.
- [x] `parseAnswer` couvre décimales et notation exponentielle (taux
      ~1e-5) ; `asPrologList(String(value))` sûr pour les floats.
- [x] Aucun champ nouveau dans `IndicatorConfig` ⇒ `validPreparedIndicators`
      (replay.ts) et `requiredIndicatorCandles` intacts — le piège du
      précédent H-S1a (§11 : « chemin prepared-indicators ») est évité
      par construction.
- [x] Échauffement par longueur (`rates.length < avgPeriod` ⇒ champ
      absent) cohérent avec la convention warm-up du snapshot.
- [x] Décision review : le paramètre période voyage avec la donnée
      (`{ rates, avgPeriod }`), pas dans `IndicatorConfig` — évite tout
      couplage config/data et toute dérive de snapshot sans donnée.

### Stratégie §5
- [x] `createSignal` impose `suggestedSize = 0` sur HOLD — les règles
      respectent la convention (miroir rsi-reversion).
- [x] Confidence ∈ [0,1], amplitude-monotone ; à seuil exact ⇒ 0 ⇒
      contribution nulle à l'allocation (vérifié allocator : net =
      Σ ±size×confidence) — cohérent avec « l'amplitude autorise ».
- [x] Pas de lecture de `previousIndicators` : signal-état assumé,
      documenté (pas de double émission à filtrer dans ce cycle).
- [x] Seuils figés et justifiés a priori (§5, 4× base Hyperliquid) ;
      balayage exclu — conformité « seuils explicites figés » (C1/critère 1).
- [x] Aucun LLM, aucun effet : pattern `Object.freeze` + `strategySignal`.

### Backtest §6
- [x] Point d'application vérifié dans replay.ts : le coût est déduit du
      cash AVANT le point d'équité de chaque bougie ⇒ PnL, dd, sharpe le
      reflètent ; `capSpotOrder` et la fenêtre daily-risk consomment le
      cash post-funding (sémantique capital consommé, correcte).
- [x] Warm-up : aucune position possible pendant le warm-up (aucun
      remplissage avant décisions) ⇒ application uniforme à toutes les
      bougies équivalente et plus simple — sans changement de comportement.
- [x] `fundingRates` absent ⇒ aucune écriture de cash : INV-F7 bit-exact
      (miroir INV-E1/P1, précédents validés dans ce dépôt).
- [x] `fundingPaid` exposé sur `BacktestResult` : les formes de métriques
      existantes ne changent pas (aucune rupture des consommateurs).

### C4 §7
- [x] Enum Zod élargie, `max(3)` inchangé ; dédoublonnage/tri existants
      inchangés.
- [x] `DEFAULT_REGIME_PERMISSIONS` inchangé ⇒ déni partout ⇒ critère 5
      (« inactive tant que non permise ») garanti par la structure
      (`resolveRegimePermission` : absent de la liste ⇒ déni).
- [x] `LIVE_TRADING_POLICY.strategyIds` inchangé ⇒ toute config live spot
      avec le nouvel id est rejetée `LIVE_POLICY_MISMATCH` (C2/C3).
- [x] Admission perp ne lit pas `strategyIds` ⇒ inchangée ; activation =
      choix opérateur (config perp + permission de régime).
- [x] Registre : nouveau cas avec seuils figés ; exclus de la calibration
      (`CALIBRATED_STRATEGY_IDS` inchangé, INV-F6) — la condition du
      registre doit rester explicite (`id === "rsi-reversion" || id ===
      "funding-trend"`), pas d'indirection.
- [ ] **Correction 2** : la table §7 doit nommer explicitement la
      surface de test de non-régression (configuration.test.ts,
      hyperliquid-signals.test.ts) comme garde C3 (appliqué §9).

## Corrections demandées (appliquées au modèle)

1. **§2** : format de réponse `fundingHistory` spécifié (`time` ms,
   `fundingRate` chaîne numérique, coercition `finiteFrom`, rejet
   entier sinon) — sans cela une implémentation pourrait substituer
   `Number(x) || 0` et violer INV-F2.
2. **§9** : tests de non-régression d'admission (live spot et perp
   inchangés) listés comme livrables explicites de la garde C3.

## Risques résiduels assumés

- La stratégie est livrée **inactive au sens plein** (pas de source
  runtime branchée) : le risque principal est un test qui donnerait
  l'illusion d'un câblage live — les tests assertent l'inverse
  (déni par permission, admission inchangée).
- Le backtest funding reste long-only : le coût modelé est exact pour
  les longs uniquement ; un jour où le replay portera du short, la
  convention de signe devra être ré-établie dans un modèle.
- L'agrégation journalière du funding horaire (moyenne des taux
  observés) est une approximation assumée du coût composé réel ; la
  convention est figée ici et partagée backtest/runtime pour que
  l'edge reste vérifiable.
- Seuil 5e-5 et période 72 sont des choix a priori sans mesure (aucune
  donnée funding dans le dépôt) : toute campagne d'edge exigera un
  protocole pré-enregistré sur données réelles (§10).
