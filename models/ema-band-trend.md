# H-T1 — ema-band-trend : le signal de bande de régime comme stratégie (branche 5)

Statut : MESURÉ — DÉCLASSÉ (H-T0 retenue ; branche 5 fermée sur ce
 candidat ; K1/K3 demeurent ; infrastructure conservée, INV-T6 bit-exacte)

## 1. Contexte et question

K1 et K3 sont actés (`product-oos-replication.md` §8.3,
`ema-signal-decoupling.md` §10.4) : la politique V1 n'a pas d'edge
démontrable — elle perd sur des produits jamais consultés (0/4, médiane
pool −1,45 %, PF 0,75) et la recherche d'edge **V1** est fermée. La
seule propriété mesurée comme transférable est le **contrôle de régime**
(dd ≤ 10 % sur 4/4 produits propres) ; les gains résiduels de V1 sont
bull-dominés et concentrés sur des événements fragiles (take RANGE 2020,
n=1).

Décision d'orientation consignée (conversation 2026-08-28, option A) :
ouvrir la **branche 5** — nouveaux signaux — en testant le seul levier
adossé à une propriété déjà mesurée : le signal de régime lui-même,
utilisé directement comme décision de position.

**Hypothèse falsifiable H-T1** : une stratégie pure qui achète au
franchissement haussier de la bande de régime (écart EMA 12/26 >
+100 bps) et sort au franchissement baissier (< −100 bps) — mêmes
constantes que le gate V1, aucun paramètre libre — montre un edge net
positif sur des produits **jamais consultés** (mêmes portes G1-G6 que
H-D1).

**Contre-hypothèse H-T0** : soit le signal est inert (moins de 8 trades
clôturés poolés — campagne invalide), soit les portes échouent
(< 2/4 produits, ou pool non positif) → le candidat est déclassé, la
branche 5 est fermée sur ce candidat et K1/K3 demeurent : la conclusion
« pas de rentabilité démontrable » se renforce d'un point d'évidence.

## 2. Faits établis utilisés (code et mesures antérieures)

| # | Fait | Source |
| --- | --- | --- |
| F1 | Les stratégies sont **pures et sans état** : `evaluate(context)` reçoit `productId`, `candles`, `indicators`, `previousIndicators` — une bougie de mémoire au plus. Le régime vit dans `regimeFilterMachine`, côté replay. | `packages/strategies/src/strategy.ts` |
| F2 | `classifyRegimeObservation` (EMA_THRESHOLD 100, sans `bearishThresholdBps`) : BULLISH si `emaFast > emaSlow × 1,01` ; BEARISH si `emaFast < emaSlow × 0,99` ; **au seuil = RANGE** (inégalités strictes symétriques). | `models/regime-filter.ts` |
| F3 | Le régime gate **retarde** la classification brute : warm-up = 5 observations + 3 confirmations consécutives ; bascule = 3 brutes opposées consécutives. Une transition de bande du candidat précède donc le régime confirmé de ~2 bougies. | `models/regime-filter.machine.ts` |
| F4 | La permission se refuse (jamais ne crée) : régime `null` ⇒ tout signal dénié ; la table `regimePermissions` est une surface de config existante (INV-P1..P3, nécessite `regimeFilter`). `DEFAULT_REGIME_PERMISSIONS` n'inclut pas de nouveau venu. | `packages/backtest/src/replay.ts`, `models/regime-filter.ts` |
| F5 | SELL spot sans position ⇒ `INEXECUTABLE` silencieux (pré-validation) ; un SELL avec position est borné à la quantité détenue (`capSpotOrder`). Un SELL de sortie sans position n'est donc jamais une erreur. | `packages/backtest/src/replay.ts` |
| F6 | `ema-cross` établit le pattern du franchissement sans état (crossing via `previousIndicators`, warm-up ⇒ HOLD, confidence = min(1, |Δ|/dénominateur)) — le candidat le reflète sur des bandes et non un cross zéro. | `packages/strategies/src/ema-cross.ts` |
| F7 | H-D1 : V1 perd OOS propre (0/4) ; G6 dd ≤ 10 % passe 4/4. H-S1a : un cross 0 bps sur paire 5/13 **réveillée** reste économiquement vide (BTC, in-sample pour ce levier). | `models/product-oos-replication.md` §8, `models/ema-signal-decoupling.md` §10 |
| F8 | `reasonCode` de signal : chaîne non vide validée — pas d'union fermée à étendre. | `packages/domain/src/trading.ts` |

## 3. Modèle — stratégie pure à double seuil

Nouvelle stratégie `ema-band-trend` (`packages/strategies/src/ema-band-trend.ts`),
miroir structurel d'`ema-cross` (F6), sur la paire historique du snapshot :

- `spreadBps(t) = (emaFast(t) − emaSlow(t)) / emaSlow(t) × 10 000`
- **BUY** si `spreadBps(précédent) ≤ +100` **et** `spreadBps(courant) > +100`
- **SELL** si `spreadBps(précédent) ≥ −100` **et** `spreadBps(courant) < −100`
- **HOLD** sinon (bande intérieure comprise — la position se garde en RANGE)
- `confidence = min(1, |spreadBps(courant)| / 100)`
- `suggestedSize = baseSize` ; habillée du même `withTargetSignalNotional`
  (1 000) que les stratégies existantes en campagne.
- Codes fermés : `EMA_BAND_BULL_ENTRY` / `EMA_BAND_BEAR_EXIT` /
  `EMA_BAND_WARMUP` / `EMA_BAND_NO_EVENT` (F8).

Émission **uniquement à la bougie de franchissement** (INV-T4) : au plus
un BUY par entrée de bande haussière, un SELL par entrée de bande
baissière — pas d'émission répétée à l'intérieur d'une bande, donc pas
d'accumulation non bornée. Relation au gate (F3) : l'entrée précède la
confirmation BULLISH de ~2 bougies, la sortie précède la confirmation
BEARISH — le candidat n'attend pas le régime confirmé, il **est** le
signal de régime.

**Écart assumé au cadrage initial** (option A, « BUY à la confirmation
BULLISH ») : une sémantique de confirmation 5/3 exige un état interne —
non implémentable dans une stratégie pure sans état (F1) sans dupliquer
la machine de régime dans une seconde source de vérité. La version sans
état utilisable est le franchissement de bande brute. Le choix est
consigné ici **avant toute mesure** ; aucune variante « confirmée » ne
sera testée dans ce cycle.

Politique de campagne (solo, cf. §6) :
`protectiveExit: NONE` — la sortie **est** le signal (franchissement
baissier) ; surmonter les exits protectifs V1 (calibrés pour des
positions courtes de rsi-reversion) préempterait la sortie propre du
candidat et répliquerait les confondus d'interaction documentés
(`regime-exit-v3.md` §5, `ema-signal-decoupling.md` §11). La sécurité
découle de : exposition bornée (~1 000 $ de notional cible / 10 000 $ de
capital), permission déniée en warm-up, et porte G6 (dd ≤ 10 %).

`regimePermissions` de campagne (table explicite, totale) :
`{ BULLISH: ["ema-band-trend"], BEARISH: ["ema-band-trend"], RANGE: ["ema-band-trend"] }`
— le gate ne peut plus bloquer le candidat hors warm-up (INV-T5) ; en
solo, aucune autre stratégie n'existe dans le registry.

### Invariants

| # | Invariant |
| --- | --- |
| INV-T1 | La stratégie est pure, déterministe, sans état : elle lit exclusivement `indicators` et `previousIndicators` — **jamais `context.candles`** ; aucun LLM, aucun effet, aucune I/O, aucun recalcul d'EMA. |
| INV-T2 | Warm-up fail-closed : `previousIndicators === null` ou EMA non finies/non positives ⇒ HOLD (`EMA_BAND_WARMUP`). Le régime `null` du gate dénie la permission (double protection) — aucune décision exécutable avant ~7 bougies évaluées. |
| INV-T3 | Validation fail-closed : `baseSize` fini > 0 ; id non vide, défaut `ema-band-trend` ; toute autre valeur ⇒ `INVALID_STRATEGY_CONFIG`, jamais corrigée silencieusement. |
| INV-T4 | Sémantique exacte (inégalités strictes au seuil, miroir F2) : BUY seulement sur franchissement strict au-dessus de +100 bps depuis ≤ +100 ; SELL seulement sous −100 bps depuis ≥ −100 ; HOLD sinon ; zéro émission répétée dans une bande. |
| INV-T5 | Table de permission du candidat explicite sur les trois régimes ; `DEFAULT_REGIME_PERMISSIONS` inchangé (bit-exact pour tout replay existant). Le gate ne crée jamais une décision — il ne peut que dénier. |
| INV-T6 | Zéro changement du cœur : ni `replay.ts`, ni le moteur d'indicateurs, ni une machine ne sont modifiés ; le candidat n'utilise que des surfaces existantes (registry, `regimePermissions`, `protectiveExit: NONE`). Candidat absent du registry ⇒ tout replay existant bit-identique. |
| INV-T7 | Contrôle de câblage : BTC-USD chargé par le même code **reproduit les baselines V1** (2023 +0,27 %/dd 2,93 % ; 2025 +3,63 %/3,37 %, tol 5e-5) avec le module candidat présent mais hors registry mesuré. Les replays candidat sur BTC ne sont **jamais** lus économiquement (contamination). |
| INV-T8 | Découverte non économique (miroir H-D1 §2) : présence 5/5 + `volume_24h` du listing seuls ; sélection gelée avant la première lecture économique ; exclusions append-only ; aucune substitution de produit après campagne. |

## 4. Choix a priori — zéro paramètre libre

- **Bande ±100 bps** : constante même du gate V1 (`EMA_THRESHOLD
  thresholdBps 100`, F2). Aucune nouvelle valeur introduite ; tout autre
  seuil serait un balayage déguisé (interdit, §11).
- **Paire 12/26** : `DEFAULT_INDICATOR_CONFIG`, consommée par le
  snapshot — aucun champ de config d'indicateur ajouté (l'infrastructure
  H-S1a `signalEma*` reste inutilisée : inactive par défaut).
- **Exits NONE, permission trois régimes, solo** : justifiés §3 — ce
  sont des choix de **cadrage** du candidat, pas des paramètres
  ajustables ; chacun est monolithique dans ce cycle.
- **Un seul degré de liberté** : l'existence du candidat. Tout autre
  changement de V1 est interdit.

## 5. Candidat

| Candidat | Config | Lecture |
| --- | --- | --- |
| T1 | solo `ema-band-trend`, bande ±100 bps sur 12/26, exits NONE, permission 3 régimes, reste du plumbing bit-identique H-D1 | le signal de régime comme décision de position |

T0 = absence de candidat (statu quo). Il n'y a **pas** de bras de
comparaison internes à sélectionner : l'objet mesuré est l'edge net du
candidat sur produits propres, contre les portes G1-G6 — pas un argmax.

## 6. Protocole de vérification

### 6.1 Exclusions (fail-closed, append-only)

Trois listes fusionnées avant découverte : **consultés** (20 de
`signal-edge-inventory.md` §5.1 **+ ZRX, OXT, KNC, DASH** brûlés par la
campagne H-D1 = 24), **stablecoins** (9) et **actifs empaquetés** (8),
à l'identique de H-D1 §2.1. BTC-USD : contrôle de câblage uniquement
(INV-T7), jamais mesuré.

### 6.2 Découverte et sélection (non économiques)

Miroir H-D1 §2.2 : listing public SPOT/USD/online paginé ; sonde 5/5
candles ONE_DAY au départ de chacune des 10 fenêtres annuelles
`[YYYY-08-21 → YYYY+1-08-21]` UTC (2016..2025) ; éligibilité ≥ 5 fenêtres
présentes ; sélection = fonction pure gelée (fenêtres présentes desc,
`volume_24h` desc, `product_id` asc) → **4 produits**, consignée avant
la première lecture économique (INV-T8). Un produit sélectionné qui
échoue en complétude échoue G1 — aucune substitution.

### 6.3 Campagne

Par produit sélectionné et fenêtre présente : chargement complet via
`loadCoinbaseHistoricalDataset` (`INCOMPLETE_HISTORICAL_DATA` élimine la
fenêtre, consignée) ; **un** replay solo :

- registry = [`withTargetSignalNotional(ema-band-trend, 1 000)`] ;
- config : `initialCapital 10 000`, `maxDecisionNotional 2 000`,
  `minNetQuantity 0,000 001`, `indicators DEFAULT_INDICATOR_CONFIG`,
  risque miroir exact H-D1 (`maxOrderNotional 2 000`,
  `maxPositionNotional 10 000`, `maxGrossExposure 20 000`,
  `maxDailyLoss 1 000`, `cooldownMs 0`, `stopLossBps 150`,
  `takeProfitBps 300`), `broker { feeBps 6, slippageBps 2 }` ;
- `regimeFilter` EMA_THRESHOLD 100/5/3 (actif — surface requise par
  `regimePermissions` et garde du warm-up) ;
- `protectiveExit: NONE` ; `regimePermissions` table §3.

Chaque fenêtre annuelle d'un produit jamais consulté est un fold OOS
propre par construction (miroir H-D1 §3) — la politique n'a jamais vu
ces données ; il n'y a pas de train.

Sorties par fenêtre : `totalReturn`, `maxDrawdown`, trades clôturés,
`pnl` (réalisé + latent final), grossWin/grossLoss sur clôturés, fills
BUY/SELL exécutés, exposition (fraction du temps en position), frais
totaux payés.

### 6.4 Contrôles d'effet

1. **EFF1 — non-inertie** : ≥ 8 trades clôturés poolés sur les produits
   sélectionnés ; sinon **campagne invalide** (signal inert, pas un
   verdict sur l'edge ; H-S1a §10.1). 
2. **EFF2 — morsure exécutable** : consignation des décisions
   **exécutables** (fills) par fold — jamais les compteurs de gating par
   bougie (insensibles au candidat ; leçon H-S1a effet 2).

## 7. Critères a priori (portes miroir H-D1 §4)

| # | Porte | Seuil |
| --- | --- | --- |
| G1 | Folds propres | ≥ 4 fenêtres annuelles complètes |
| G2 | Positivité | ≥ 3 folds à rendement net > 0 (compte fixe, pas ratio) |
| G3 | Médiane | rendement net médian des folds > 0 |
| G4 | Profit factor | PF agrégé ($ gains / $ pertes clôturés) > 1 |
| G5 | Espérance | PnL net poolé / trades clôturés poolés > 0 |
| G6 | Sécurité | dd ≤ 10 % sur chaque fold |

**Verdict H-T1 : VALIDÉ** si INV-T7 PASS ∧ EFF1 PASS ∧ ≥ 2 produits/4
passent G1-G6 ∧ médiane pool > 0 ∧ PF pool > 1. Tout autre issue :
**DÉCLASSÉ** → H-T0 retenue (branche 5 fermée sur ce candidat, K1/K3
demeurent).

Consignés **hors critères** (lecture K1, pas des portes) : buy & hold
par fold (`dernier close / premier close de la fenêtre − 1`, sans
frais), proxy sans-risque ~4 %/an (hypothèse externe), géométrique
annualisé par produit, exposition moyenne, durée de détention moyenne,
frais totaux. **Règle de lecture pré-enregistrée** : si VALIDÉ avec
médiane nette < médiane buy & hold, le verdict tient mais « capture de
bêta dominante » est consigné — toute suite devra le peser.

## 8. Verrou épistémique

Un verdict VALIDÉ **ne déploie rien** (pas de flag live, pas de porte
`production-launch.md`). Suite unique autorisée : un nouveau cycle
Model pour l'intégration (ex. remplacement de rsi-reversion dans
l'ensemble, ou politique live candidate) — à son propre protocole
pré-enregistré. BTC n'est jamais lu économiquement pour ce candidat ;
les fenêtres futures (2026+) serviront de confirmation supplémentaire le
cas échéant. Aucun ajustement des constantes après lecture des
résultats ; tout échec ferme le candidat, il ne le reparamètre pas.

## 9. Livrables

- `packages/strategies/src/ema-band-trend.ts` : stratégie pure
  (INV-T1..T4) + export dans `src/index.ts` (INV-T6).
- `packages/strategies/test/strategies.test.ts` : tests unitaires —
  franchissements stricts (candles synthétiques), HOLD en warm-up,
  rejets fail-closed de config, non-lecture de `candles` (INV-T1).
- `packages/backtest/scripts/ema-band-trend-oos.ts` : campagne §6
  (découverte, gel, replays, INV-T7, EFF1/EFF2, portes, verdict) — une
  exécution, sortie tabulaire, miroir de `product-oos-replication.ts`.
- Ce document complété : §12 résultats, statut → MESURÉ.

## 10. Limites assumées

- **Échantillon mince** : ~2-6 allers-retours par fold attendus (turnover
  volontairement bas) — PF et espérance fragiles ; miroir de la maigreur
  H-D1, la porte EFF1 borne le dénuement.
- **Biais de survie** et coûts homogènes 6+2 bps : miroir H-D1 §6 — un
  négatif malgré ces biais gonflants serait d'autant plus concluant.
- **Capture de bêta** : le candidat ressemble à un buy & hold filtré par
  régime ; le benchmark consigné §7 quantifie exactement cette
  ressemblance, il ne la cache pas.
- **Exits NONE** : aucun stop protectif dans ce cycle ; la charge de
  sécurité repose sur l'exposition bornée et G6 seul.
- **H-S1a** : un signal « réveillé » peut être économiquement vide ; ce
  candidat diffère par paire (12/26), seuil (±100) et espace (produits
  propres), mais aucune priorité ne lui est accordée — les portes
  décident.
- **Latence décision→exécution** (clôture T, open T+1) : artefact
  structurel connu, symétrique pour toute stratégie daily.

## 11. Hors périmètre

Balayage de seuils ou de paires ; variante « confirmée » à état interne ;
timeframes infra-journaliers ; runs ensemble, ablation, retrait de
rsi-reversion ; permission sélective par régime ; calibrage de
confidence (axe fermé, IDENTITY) ; changement du gate, des exits, du
risque, des frais ; tout déploiement live.

## 12. Résultats

Exécution : `packages/backtest/scripts/ema-band-trend-oos.ts` (2026-08-28).

### 12.1 Conduite de la campagne (consignée intégralement)

- **Découverte** (non économique) : listing SPOT 929 produits, 377
  candidats USD/online hors exclusions (24 consultés, 2 stables, 0
  empaquetés, 526 statut/quote/autre) ; sondes 5/5 × 10 fenêtres → 39
  éligibles. **Sélection gelée (INV-T8)** : BAND-USD, COMP-USD, NMR-USD
  (6/10 fenêtres), AMP-USD (5/10, vol 1,33 Md).
- **Incident de conduite** : la première exécution a planté sur un bug
  de script (lecture d'un champ `portfolio` inexistant sur `PaperTrade`)
  **avant toute sortie de métrique économique**. Correction apportée au
  seul calcul de l'exposition consignée (suivi local de position) ; la
  sélection gelée a été conservée (le gel prime, aucune re-sonde).
- **INV-T7 : PASS** — BTC 2023 +0,27 %/dd 2,93 % et 2025 +3,63 %/3,37 %
  reproduits bit-près par le même code-path avec le module candidat
  présent : le cœur ne dérive de rien.
- **EFF1 : PASS** — 61 trades clôturés poolés (≥ 8 requis) : le signal
  n'est **pas** inert (~5 fills BUY/an/produit). EFF2 : fills consignés
  par fold (table ci-dessous).

### 12.2 Campagne (folds = fenêtres annuelles OOS propres)

| Produit | folds | positifs | médiane | PF ($) | esp/trade | dd max | portes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BAND-USD | 6 | 3 | −1,39 % | 0,79 | −89,23 $ | 28,50 % | FAIL G3-G6 |
| COMP-USD | 6 | 3 | −0,01 % | 1,84 | +358,19 $ | 47,93 % | FAIL G3, G6 |
| NMR-USD | 6 | 1 | −2,14 % | 1,10 | −94,08 $ | 35,97 % | FAIL G2-G3, G5-G6 |
| AMP-USD | 5 | 2 | −1,12 % | 2,12 | +63,20 $ | 39,04 % | FAIL G2-G3, G6 |

Pool : médiane −1,12 %, PF 1,32. Fenêtres 2016-2019 (et 2020 pour AMP)
éliminées `INCOMPLETE_HISTORICAL_DATA` (listées trop récemment — cause
constatée, pas une substitution, miroir H-D1 §8.1).

**VERDICT : DÉCLASSÉ — 0/4 produits PASS** (≥ 2 requis). H-T0 retenue.

### 12.3 Erreur de modèle détectée par la mesure (consignée)

Le §3 justifiait la sécurité par une « exposition bornée (~1 000 $ /
10 000 $) ». **Cet argument était faux** : la sémantique INV-T4 permet
une ré-émission BUY après retour dans la bande sans SELL intermédiaire
— chaque ré-entrée empile une tranche (~5-6 BUY/an), portant
l'exposition moyenne à 73-74 % du temps (pointes ~90 %) et la position
bien au-delà du notional cible. Combiné à exits NONE, cela produit les
dd 6,6-47,9 % mesurés : **G6 échoue sur les 4 produits**. La porte a
fait exactement son travail — l'argument de sécurité non démontré a été
réfuté par la mesure, pas par l'argument.

### 12.4 Lecture honnête

- **Le signal n'est ni inert ni anti-edge brut — il module du bêta.**
  Médiane candidat −1,12 % contre B&H −23,57 % : la bande de régime
  **tronque massivement les queues** (BAND 2021 : −12,4 % vs −85,4 % ;
  AMP 2021 : −9,8 % vs −88,1 % ; COMP 2020 : +77,5 % tout en captant
  moins que B&H +182,4 %). C'est la version position-porteuse de la
  propriété déjà mesurée en H-D1 (le contrôle de régime transfère) —
  **relative** au marché, pas absolue.
- **Mais l'économie absolue est négative ou marginale partout** : médiane
  pool < 0, 3/4 produits sous 0, le meilleur géométrique (COMP +7,54 %/an)
  porte dd 47,9 % et médiane nulle — aucun produit ne bat le sans-risque
  4 % en médiane. PF pool 1,32 : des poches d'espérance existent, elles ne
  composent pas en edge.
- **Aucune licence de variante** : une version « exposition bornée +
  stops » corrigerait G6, mais rien dans cette mesure ne suggère qu'elle
  corrigerait G3 — le prior honnête s'affaiblit, il ne se renforce pas.
  Toute variante serait une nouvelle hypothèse pré-enregistrée, et la
  chaîne d'évidence K1/K3 (5 branches fermées : calibration, sizing,
  exits, permissions/produits, signaux v1-v5) recommande de ne pas
  l'ouvrir sans justification mécanistique nouvelle.
- **Ce que la mesure ajoute au dépôt** : la propriété « perdre moins que
  le marché » du signal de régime est confirmée OOS sur 4 produits
  vierges supplémentaires (23 folds) — elle est réelle, relative, et non
  monétisable telle quelle sous les portes de sécurité.

### 12.5 Conséquences

- H-T0 retenue : branche 5 fermée sur ce candidat. K1 (« bot autonome
  rentable ») et K3 (arrêt recherche d'edge) demeurent et se renforcent.
- Infrastructure conservée : `ema-band-trend` (INV-T1..T6, tests au vert,
  INV-T7 bit-exact) demeure une capacité inerte par défaut — comme les
  champs `signalEma*` d'H-S1a.
- Les 4 produits de cette campagne (BAND, COMP, NMR, AMP) rejoignent la
  liste des consultés (append-only) pour toute campagne future.
