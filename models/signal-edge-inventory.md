# Inventaire branche 4 — signaux et données (diagnostic d'orientation)

Statut : MESURÉ-COMPILÉ (inventaire ; aucun changement de comportement)

## 1. Contexte

Tous les méta-axes sont fermés : calibration (`confidence-sizing-walkforward.md`
DÉCLASSÉ), sizing conditionné (`weak-year-diagnosis.md` §1), exits v1/v2/v3
(DÉCLASSÉS), permission par régime (`strategy-permission.md` DÉCLASSÉ ×2).
Convergence des conclusions : **le problème est l'edge du signal de base**,
pas le plumbing — branche 4 du diagnostic (`weak-year-diagnosis.md` §6.5).
Ce document compile l'état mécanistique connu par stratégie, identifie un
verrou structurel nouveau (§3.2), et classe les hypothèses candidates pour
les prochains cycles. Chaque hypothèse listée exigera son propre document
Model → Review → Implement → Verify ; rien ici n'est une décision.

## 2. Faits compilés (sources mesurées antérieures)

| Stratégie | État mesuré | Source |
| --- | --- | --- |
| rsi-reversion | Porte ~100 % de la perte des années faibles (solo ≈ ensemble ; BUY oversold en BEARISH/RANGE prolongé, wr 22-33 %). Ses SELL sont massivement rejetés `SPOT_SHORT_FORBIDDEN` (70,6 % des rejets de l'année bull). | `weak-year-diagnosis.md` §6.4, `bull-alpha-diagnosis.md` §1 |
| ema-cross | **Inerte** : 0,00 % sur 6 fenêtres (2016-2024), jamais de signal exécutable dans V1 daily. | `weak-year-diagnosis.md` §6.4 |
| breakout | Porte le gain 2020 mais sur **un unique take** (+1 111 $, n=1) ; marginal ailleurs. | `weak-year-diagnosis.md` §6.2/§7 |
| Régime (méta-signal) | EMA_THRESHOLD v1 champion ; EMA_SLOPE DÉCLASSÉ (aucun mode n'améliore sensiblement le win rate). | `regime-slope.md`, `bull-alpha-diagnosis.md` préambule |

## 3. Lecture mécanistique

### 3.1 rsi-reversion — un seul côté branché

Spot long-only : le SELL rsi (survendu) ne peut s'exécuter sans position
préalable ; il est rejeté structurellement. La stratégie est donc
**asymétrique de facto** : elle n'exprime que « BUY l'oversold », y compris
en tendance baissaire — précisément le pattern à espérance négative
identifié. Les leviers restants touchent la **source** : paramètres RSI
(seuils/période — jamais balayés à ce jour), timeframe (rsi daily dans un
régime daily), ou remplacement.

### 3.2 ema-cross — verrou structurel découplable (constat code, nouveau)

`createEmaCrossStrategy` émet **uniquement à la bougie de transition**
(`crossedUp` : `emaFast ≤ emaSlow` la veille et `>` aujourd'hui,
`packages/strategies/src/ema-cross.ts` L26-35) sur les **mêmes EMAs 12/26**
que le filtre de régime (`DEFAULT_INDICATOR_CONFIG`,
`indicators-prolog/src/engine.ts` L30-31). Or le gate EMA_THRESHOLD
100/5/3 n'autorise ema-cross qu'en **BULLISH confirmé** : ≥ 5 observations
puis 3 confirmations consécutives d'écart > 100 bps. Au moment du cross,
l'écart vient de changer de signe : strictement positif mais quasi nul
(typiquement quelques bps au plus, très loin du seuil de 100 bps) ; le
régime BULLISH ne peut être confirmé que ~8+ bougies **après** le cross —
et la stratégie n'émet plus rien (HOLD hors transition). **Le signal et sa
permission sont donc structurellement désynchronisés : jamais un signal
ema-cross ne peut passer le gate.** Un cross-down est doublement bloqué
(ema-cross absent de `DEFAULT_REGIME_PERMISSIONS.BEARISH`). Le verrou est
renforcé, sans en être la cause, par le chevauchement des warm-ups :
régime `null` (filtre) et `previousIndicators === null` (stratégie)
déniennent tous deux les premières bougies. Cela explique mécaniquement
l'inertie mesurée (0,00 %) sans invoquer un manque d'edge du cross
lui-même. Levier évident à un seul degré de liberté : **découpler les
périodes** (EMAs de signal ≠ EMAs du filtre) pour que des crosses
surviennent *à l'intérieur* de régimes établis.

### 3.3 breakout — fragilité d'échantillon, pas d'anti-edge

lookback 20 ; le seul gros gain est n=1. Aucun levier chirurgical connu ;
bénéficie mécaniquement des régimes BULLISH (autorisé uniquement là).

### 3.4 Timeframes

V1 décide en ONE_DAY et exécute au candle suivant ; l'artefact de latence
décision→exécution traverse les transitions de régime
(`strategy-permission.md` §9). L'exécution SIX_HOUR existe et est testée ;
la fenêtre dailyPnl est désormais fidèle au live (`daily-pnl-fidelity.md`),
ce qui rend les timeframes infra-journaliers *observables* correctement —
mais leur coût de données/calcul est ~24× (ONE_HOUR) à ~1440× (ONE_MINUTE).

## 4. Hypothèses candidates (classement a priori)

| Rang | ID | Hypothèse falsifiable (une par cycle, un seul levier) | Pourquoi ce rang |
| --- | --- | --- | --- |
| 1 | **H-D1** | Sur des produits **jamais consultés** (allowlist d'exclusion a priori, cf. §5.1), la politique V1 + R-H2 (si VALIDÉ) montre un edge net > 0 sur ≥ 4 folds annuels propres par produit. | Seule voie d'OOS **réellement propre** sans attendre des années ; réutilise tout l'existant ; débloque la porte recherche de `production-launch.md`. |
| 2 | **H-S1a** | Des EMAs de signal découplées du filtre (périodes fixées a priori avec justification, ex. 5/13 vs 12/26 — **pas de balayage**) rendent ema-cross non inerte sans dégrader dd/turnover/fees. | Verrou mécanistique identifié (§3.2) ; coût d'un cycle standard ; ne touche ni au gate ni aux autres stratégies. |
| 3 | **H-S1c** | Un timeframe de décision infra-journalier (ONE_HOUR, warm-up et coûts adaptés) améliore l'espérance nette/trade de rsi-reversion sous le même gate. | Infra prête (exécution, dailyPnl) ; coût de calcul majeur ; risque de coût de frais/slippage non couvert par 6+2 bps daily — à modéliser. |
| 4 | **H-S1b** | Des seuils RSI recalibrés (fixés a priori) réduisent la perte bear/range de rsi-reversion sans ablation complète. | Interagit avec l'axe permission fermé (le mécanisme de perte est le même) ; risque de répliquer C1/C2 par d'autres moyens — justification indépendante requise, comme H-P2. |

## 5. Contraintes transversales rappelées

### 5.1 Définition de « produit consulté » (fail-closed)

Un produit est **consulté** dès lors qu'il apparaît dans un artefact
(`.artifacts/backtests/`, `.artifacts/studies/`), quelle que soit la
config du run — y compris les études `RESEARCH_ONLY` sans gate V1. La
prudence fail-closed prime sur le décompte : toute exposition antérieure
aux données, même sous une autre politique, risque un biais de sélection
inconscient. Allowlist d'exclusion a priori (constatée dans les artefacts
au 2026-08-26) : **BTC, ETH, LTC, SOL, ATOM, ETC, ALGO, FIL, GRT, MANA,
XTZ, ZEC, ADA, DOGE, AAVE, XLM, LINK, AVAX, BCH, UNI** (20 produits). Les
fenêtres 2022-2026 de ces produits sont contaminées ; tout produit absent
de cette liste et présent sur Coinbase avec ≥ 5 ans d'historique ONE_DAY
complet est éligible à H-D1. Le modèle H-D1 devra re-vérifier cette liste
contre les artefacts au moment de son exécution (append-only : elle ne
peut que croître).

### 5.2 Règles de protocole

- Une hypothèse = un document pré-enregistré = un seul degré de liberté ;
  critères W1/W2/W3 a priori, portes **recalibrées au type de candidat**
  (leçon post-mortem D3-P §9 de `strategy-permission.md`).
- Les fenêtres contaminées (2023, 2025 pour BTC ; 2022-2026 pour les
  produits consultés au sens §5.1) ne sont jamais reclassées OOS.
- Aucun balayage de paramètres : toute valeur est fixée avec justification
  écrite avant mesure ; un sweep = protocole séparé pré-enregistré.
- L'objectif économique minimal pour poursuivre : **edge net > sans-risque**
  sur folds propres (kill-criteria K1/K3 du plan de rentabilité).

## 6. Décision d'orientation consignée

Prochain cycle recommandé : **H-D1** (rang 1), en parallèle du verdict
H-P2 (`regime-aware-selector.md`) dont il est la seule suite possible en
cas de VALIDÉ. H-S1a suit si H-D1 laisse l'edge non démontré mais le
verrou §3.2 confirmé sur les nouveaux produits. Aucune priorité aux
rang 3-4 avant que les rangs 1-2 soient tranchés.
