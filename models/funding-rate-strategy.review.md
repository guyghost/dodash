# Review — Stratégie perp consciente du taux de financement (DAO #27)

Statut : APPROUVÉ AVEC CORRECTIONS (intégrées au modèle)
Modèle : `models/funding-rate-strategy.md`

---

# Review 3 — Amendement du seuil d'entrée en percentile figé (dao #38)

Statut : APPROUVÉ (aucune correction demandée)
Date : dao #38
Périmètre vérifié : amendement §5 (seuil percentile figé, étiquetage
in-sample), constante source unique `models/funding-rate-strategy.ts`,
nouvel invariant INV-F9, garanties C1/C2/C3 du brief.

Fichiers vérifiés : `models/funding-rate-strategy.md` (§1, §5, §7, §8,
§9, §10), `models/funding-edge-campaign.md` (§3/§7/§9 v2 — non touché),
`models/funding-edge-campaign-v2.annexe-calibration.json` (source de la
valeur), `models/regime-filter.ts` (`DEFAULT_REGIME_PERMISSIONS`, non
modifié), `models/live-trading-policy.ts` (non modifié),
`models/confidence-calibration.ts` (`CALIBRATED_STRATEGY_IDS`, non
modifié), `packages/backtest/scripts/funding-edge-walkforward.ts` (seuil
v1 explicite, non modifié), `packages/backtest/scripts/
funding-edge-calibration-v2.ts` et `funding-edge-oos-v2.ts` (seuil
campagne explicite, non modifiés).

## Checklist

### C3 — percentile figé AVANT le rejeu
- [x] La règle (quantité `|fundingAvg|` SMA-72, dataset dao30, p75 par
      rang le plus proche sans interpolation, N = 294 jours de décision)
      et la valeur (`8,8750099537037e-6`) sont figées dans le modèle au
      commit 1, avant tout rejeu au nouveau seuil.
- [x] La valeur est dérivée d'un artefact antérieur commité (annexe #35,
      `distributionAbsFundingAvg.p75`) — aucune donnée nouvelle. Dérivation
      re-exécutée indépendamment depuis les fixtures (règle identique
      calibration-v2) : même valeur au bit près, 74/294 jours traversés
      (25,2 % — bande cible 5–25 %).
- [x] p90 écarté en connaissance de cause : c'est le seuil calibré du
      protocole #35 EN ATTENTE (INV-C7 : itération unique, aucun
      recalibrage) ; en faire le défaut produit confondrait recherche et
      produit. Le p75 sépare les deux artefacts.
- [x] Aucun balayage : un percentile unique, une règle unique, une
      exécution unique (miroir #35 §9).

### C1 — variant inactif/inactivable
- [x] `DEFAULT_REGIME_PERMISSIONS` inchangé : `funding-trend` absente des
      3 listes ⇒ déni partout (`resolveRegimePermission` : absent ⇒ déni).
- [x] `LIVE_TRADING_POLICY.strategyIds` inchangé (3 ids) ⇒ toute config
      live contenant `funding-trend` reste rejetée `LIVE_POLICY_MISMATCH`.
- [x] `CALIBRATED_STRATEGY_IDS` inchangé (INV-F6) ; admission perp
      inchangée ; aucun branchement runtime/paper nouveau.
- [x] INV-F9 ajoute l'étiquetage normatif (non validé OOS, activation =
      proposition séparée) sans toucher INV-F1..F8 (pureté, coût intégré,
      convention de signe inchangées).

### C2 — rejeu v1 reproductible (mode comparaison)
- [x] La stratégie rend le seuil **optionnel** (défaut = constante) :
      élargissement de signature rétrocompatible, tout appelant explicite
      garde son comportement bit-exact.
- [x] Les scripts campagne passent leur seuil explicitement (v1 #30 :
      `5e-5` ; #35 : p90 calibré re-vérifié contre l'annexe) — aucune de
      leurs surfaces n'est modifiée.
- [x] Preuve par exécution : `funding-edge-walkforward.ts` et
      `funding-edge-oos-v2.ts` ré-exécutés avant/après implémentation,
      sorties identiques bit à bit (verdict EN ATTENTE #35 préservé,
      grille non évaluée).

### Constat pré-enregistré et critère « ≥ 1 trade in-sample »
- [x] Le modèle constate AVANT le rejeu (données annexées #35) :
      `fundingAvg` signé strictement positif sur toute la campagne-1
      (min +2,17e-7) ⇒ longCarry jamais autorisable ⇒ 0 remplissage
      attendu au rejeu H12 quel que soit le seuil positif (shortCrowding
      seul peut s'autoriser, inexécutable en long-only sans position).
- [x] Conséquence assumée et consignée : le critère de vérification
      « au moins 1 trade sur H12 in-sample » du brief #38 est
      **structurellement non atteignable** sur ces données — le modèle
      n'est pas retouché pour le « faire passer » (aucune inversion de
      convention de signe, aucun seuil négatif). Point ouvert reporté à
      la proposition : seule une fenêtre où le SMA-72 passe négatif (ou
      un chemin short modélisé) peut produire des remplissages.
- [x] Le rejeu comparatif reste livré intégralement (trades/PnL/Sharpe
      v1 vs v2 + distributions de signaux) : il mesure le rétablissement
      de l'autorisation d'amplitude (74 vs 0 jours) et confirme le
      constat pré-enregistré.

### Implémentation (vérifiée a priori dans le modèle)
- [x] Source unique de la constante : `models/funding-rate-strategy.ts`
      (modèles = vérité, miroir `DEFAULT_REGIME_PERMISSIONS` /
      `CALIBRATED_STRATEGY_IDS`), exportée par `models/index.ts`, test de
      verrouillage de la valeur littérale.
- [x] Stratégie : défaut = constante, validation `enterThreshold > 0`
      inchangée (un seuil négatif ou nul reste `INVALID_STRATEGY_CONFIG`).
- [x] Registre agent : `enterThreshold: FUNDING_TREND_ENTER_THRESHOLD`
      explicite (pas d'implicite caché).
- [x] Script comparatif : lecture-seule, fixtures SHA-256 vérifiées,
      re-vérification de la constante contre l'annexe (fatal si écart),
      aucune évaluation de la grille #35 (INV-C7), aucune écriture
      d'artefact campagne.

## Risques résiduels assumés

- Le défaut produit p75 est calibré in-sample sur UNE fenêtre (2025-26,
  marché BTC −27,48 %) : biais de fenêtre assumé et étiqueté (INV-F9) —
  l'activation exigerait une validation OOS dédiée.
- Sur cette fenêtre, l'autorisation rétablie ne porte que sur la branche
  shortCrowding (inexécutable en long-only) : le variant reste sans effet
  de remplissage tant que le régime de signe du funding ne change pas —
  c'est la mesure du constat, pas une promesse d'edge.
- La précision de la constante (16 chiffres significatifs) lie le défaut
  produit à l'annexe #35 : toute re-derive de l'annexe (non prévue —
  INV-C7) exigerait un nouveau protocole et un nouvel amendement.

---

# Review 2 — Branchement runtime (cycle C1-suite, §3)

Statut : APPROUVÉ AVEC CORRECTIONS (intégrées au modèle)
Date : cycle C1-suite
Périmètre vérifié : effet `fetchFundingData`, interpréteur
`computingIndicators`, alignement suffixe du moteur, alimentation de
l'indicateur dans le backtest non préparé.

Fichiers vérifiés : `apps/agent/src/interpreter.ts` (cas
`computingIndicators`, `checkpoint`), `apps/agent/src/trading-effects.ts`
(résolution des réglages perp, pattern des effets conditionnés au mode),
`apps/agent/src/types.ts` (interface `TradingCycleEffects`),
`apps/agent/src/hyperliquid-execution.ts` (couture pure livrée au cycle
1), `packages/indicators-prolog/src/engine.ts` (validation funding),
`packages/backtest/src/replay.ts` (chemin non préparé,
`validPreparedIndicators`), `models/trading-cycle.machine.ts` (états et
événements de `computingIndicators`), tests interpréteur
(`interpreter.test.ts`, fakes d'effets) et effets
(`trading-effects.test.ts`).

## Checklist

### Aucun changement de machine
- [x] `tradingCycleMachine` : l'état `computingIndicators` et ses deux
      événements restent inchangés — la lecture funding est un
      fournisseur d'entrée de l'effet, pas un état. Précédent interne :
      lectures de compte (`reconcileAccount`) qui alimentent les gardes
      sans état dédié.
- [x] Aucun axe de retry nouveau : `MARKET_DATA_FAILED`/retry reste
      réservé aux bougies (input requis) ; le funding est optionnel —
      un échec de fetch ne doit jamais router le cycle vers l'échec
      (garde C3 pour les instances perp héritées).

### Effet optionnel et double porte
- [x] `fetchFundingData?` optionnel dans `TradingCycleEffects` : les
      fakes d'effets existants (tests interpréteur) restent valides sans
      modification (C3 vérifié par la suite de tests existante).
- [x] Porte fournisseur : effet câblé uniquement en mode perp avec
      `resolveHyperliquidSettings` résolu (miroir de `perpSettings`).
- [x] Porte interpréteur : mode perp ∧ `funding-trend` configuré ∧ effet
      présent. Une instance perp sans `funding-trend` ne provoque aucun
      fetch — zéro changement réseau (C3).
- [x] C2 : le mode paper (et le live spot) ne passent jamais par la
      couture — testé (effet jamais appelé).

### Alignement suffixe (écart v1 documenté)
- [x] La spec v1 (1:1 strict, `rates.length === candles.length`) est
      **intenable au runtime** : couverture complète = jusqu'à ~8 400
      enregistrements `fundingHistory` (réponse au-delà du plafond 1 MiB
      à candleLimit 350) et fragilité totale (une heure manquée dans une
      vieille bougie invalide toute la série). Correction : alignement
      par suffixe (`rates.length ≤ candles.length`, dernières bougies),
      intégrée au modèle §4. Le backtest passe la série pleine (cas
      particulier) — INV-F1/F7 inchangés, tests bit-exact revalidés.
- [x] Pré-validation interpréteur (`1 ≤ len ≤ candles.length`, finitude)
      avant passage au moteur : un fournisseur bogué ne peut jamais
      transformer un input optionnel en échec de cycle.
- [x] Warm-up : suffixe < période ⇒ champ absent ⇒ HOLD (INV-F3) —
      atteignable au runtime seulement si `candleLimit < 72`, cohérent.

### Alimentation de l'indicateur au backtest
- [x] Chemin non préparé : `computeIndicators(history, …)` reçoit le
      suffixe `slice(max(0, n − avgPeriod), n)` de la série de config —
      testé de bout en bout (stratégie émet, fills constatés).
- [x] Chemin préparé : `prepareBacktestIndicators` reste funding-blind ;
      les snapshots préparés font autorité sur les valeurs (règle §6).
      La combinaison série + snapshots préparés sans `fundingAvg` ⇒ la
      stratégie HOLD (jamais de valeur inventée) — consigné comme
      limite, extension hors périmètre.
- [ ] **Correction 3 (appliquée §6)** : la règle d'autorité prepared
      n'était pas explicite dans la v1 du modèle — ajoutée.

### Écueils vérifiés
- [x] `checkpoint` : les échantillons bruts ne sont pas persistés ; le
      snapshot (dont le hash couvre l'entrée funding) l'est. Une reprise
      ré-exécute l'effet (lecture seule) ; aucun chemin ne décide avec
      un input partiel.
- [x] Télémétrie `funding_data_unavailable` : émise seulement quand les
      portes passent et que le résultat est `null` — un HOLD prolongé
      n'est jamais silencieux ; aucun bruit pour les instances sans
      `funding-trend`.
- [x] `FUNDING_AVG_PERIOD = 72` exporté de `@dodash/indicators-prolog` :
      source unique (couture, backtest, tests).
- [x] `fundingRatesForCandles` réutilisée sur le suffixe : la
      granularité dérivée des deux derniers starts reste correcte sur
      une tranche contiguë ; bougie sans observation ⇒ `null` (INV-F2).

## Corrections (appliquées au modèle)

1. **§4** : alignement par suffixe en remplacement du 1:1 strict —
   intenable au runtime (taille de réponse, fragilité aux trous).
2. **§3** : spécification portée au grade d'implémentation (effet
   optionnel, double porte, pré-validation, pas de retry, télémétrie,
   échantillons non checkpointés).
3. **§6** : règle d'autorité des snapshots préparés sur les valeurs
   d'indicateur ; la série de config nourrit toujours le coût.

## Risques résiduels assumés

- Une reprise de cycle recalculant les indicateurs peut observer un
  `fundingAvg` différent (nouvelles heures publiées entre-temps) — la
  décision reste cohérente : valeur complète ou absence (HOLD), jamais
  partielle.
- Le suffixe de 72 jours suppose que `fundingHistory` reste complet sur
  cette profondeur ; un trou dans la fenêtre suffixe dégrade en HOLD
  (télémétrie), jamais en signal faux.
- `prepareBacktestIndicators` funding-blind : une campagne future qui
  veut le chemin préparé rapide avec indicateur funding devra étendre
  la préparation (extension modélisée, hors périmètre).

---

# Review 1 — Modèle initial (dao #27)

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
