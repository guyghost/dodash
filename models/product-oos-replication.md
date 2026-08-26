# H-D1 — Réplication OOS de V1 sur produits jamais consultés

Statut : MESURÉ — DÉCLASSÉ (H-D0 retenue ; K1 déclenché : la voie
« bot autonome rentable » est fermée pour V1)

## 1. Contexte et question

`signal-edge-inventory.md` (MESURÉ-COMPILÉ) classe H-D1 rang 1 : c'est la
seule voie d'évidence OOS **réellement propre** sans attendre des fenêtres
futures. Constatations motivantes :

- Les fenêtres BTC 2022-2026 sont contaminées par la calibration
  `POWER_THIRD` (`production-readiness-2026-08-24.md` porte 1) ; les fenêtres
  2023/2025 le sont par la sélection sizing.
- L'allowlist live `CONFIDENCE_POWER_THIRD_2026_08` (XTZ/ZEC/GRT/MANA) est
  intégralement composée de produits consultés — la porte recherche d'un
  futur lancement est donc inatteignable en l'état.
- H-P2 (`regime-aware-selector.md`) est DÉCLASSÉ : la politique mesurée ici
  est **V1-IDENTITY pure** (champion gelé, aucune règle de sélection).

**Hypothèse falsifiable H-D1** : la politique V1-IDENTITY (constantes
bit-identiques aux campagnes BTC) montre un edge net positif sur des
produits **jamais consultés**, au sens des portes de
`production-launch.md` §Porte 1 (≥ 4 folds annuels propres par produit).

**Contre-hypothèse H-D0** : aucun produit ne passe les portes (ou moins de
deux) → l'edge de V1 est spécifique à BTC/inexistant → le kill-criterion K1
du plan de rentabilité s'applique : la voie « bot autonome rentable » est
fermée ; priorité unique à H-S1a (découplage EMAs) puis aux nouveaux
signaux.

## 2. Produits — exclusions et découverte non contaminante

### 2.1 Exclusions (fail-closed, append-only)

Trois listes nominales, fusionnées avant toute découverte :

1. **Consultés** (20, `signal-edge-inventory.md` §5.1) : BTC, ETH, LTC,
   SOL, ATOM, ETC, ALGO, FIL, GRT, MANA, XTZ, ZEC, ADA, DOGE, AAVE, XLM,
   LINK, AVAX, BCH, UNI.
2. **Stablecoins** (prix administrativement collé à un fiat — aucun régime
   ni edge possible) : USDC, USDT, DAI, PYUSD, TUSD, GUSD, FDUSD, USDS,
   FRAX.
3. **Actifs empaquetés** (répliquent un sous-jacent exclu — edge confondu
   avec celui du sous-jacent) : WBTC, WETH, cbBTC, cbETH, wstETH, weETH,
   rETH, stETH.

Note : LEO (token utilitaire Bitfinex) n'est **pas** un stablecoin et
n'appartient à aucune liste ; s'il s'avérait problématique à l'exécution,
il serait ajouté par le mécanisme append-only.

BTC-USD reste chargé comme **contrôle de câblage** (INV-R5) mais jamais
mesuré. La liste ne peut que croître ; tout produit ajouté après coup doit
l'être par document de modèle séparé.

### 2.2 Découverte (pré-enregistrée comme non économique)

- Source : endpoint public Coinbase `/api/v3/brokerage/market/products`
  (`product_type=SPOT` ; réponse paginée — le script itère jusqu'à
  épuisement) ; candidats = `status === "online"`,
  `quote_currency_id === "USD"`, base absente des exclusions.
- **Sonde** (miroir de la sonde 5/5 de `confidence-sizing-walkforward.md`
  §2) : pour chaque candidat et chaque fenêtre W ∈ {2016..2025} (bornes
  `[YYYY-08-21 → YYYY+1-08-21]`), requête de 5 candles ONE_DAY au départ de
  W ; la fenêtre est « présente » si et seulement si les 5 candles attendues
  reviennent. **Aucune métrique de performance, de rendement ni de signal
  de la politique n'est lue ou calculée pendant la découverte** :
  uniquement la présence/absence de données. Le seul champ du listing
  utilisé au-delà de la présence est `volume_24h` (volume des dernières
  24 h en devise de base, champ instantané de liquidité) — cf.
  justification §2.3 et limite §6. Note d'implémentation : `volume_24h`
  est un string dans la réponse Coinbase (ex. `"1908432"`) — le script le
  parse en nombre avant tout tri numérique.
- Éligibilité : ≥ 5 fenêtres sondees présentes sur les 10.
- **Sélection** (fonction pure, déterministe) : les 4 premiers à
  `(fenêtres présentes desc, volume_24h desc, product_id asc)`.
- La sélection est gelée et consignée **avant** la première lecture
  économique (INV-R2). Aucun produit ne peut être substitué après campagne
  (INV-R4) : un produit sélectionné qui finit avec < 4 folds complets
  échoue la porte correspondante, sans remplacement.

### 2.3 Justification de la taille et des tie-breaks

- 4 produits : miroir de la taille d'allowlist live (4 instances
  `live-trading-policy.md`) — un verdict positif est directement
  transposable en candidate d'allowlist d'une future politique.
- `fenêtres présentes desc` : maximiser l'évidence disponible (≥ 4 folds
  exigés, marge pour éliminations de complétude).
- `volume_24h desc` : privilégier la liquidité, condition de réalisme du
  coût 6+2 bps ; critère du jour, indépendant de toute performance. Note :
  le champ est en **devise de base** (nombre de tokens, pas USD ;
  `approximate_quote_24h_volume` serait le volume USD). Le présent
  protocole retient `volume_24h` : le tie-break est tiers (intervient
  uniquement à nombre de fenêtres égal) et la corrélation volume
  base ↔ liquidité USD est monotone à prix stable — le biais (favorise les
  tokens à faible prix unitaire) est accepté pour la simplicité d'un
  endpoint unique.
- `product_id asc` : départage final total, aucune discrétion.

## 3. Campagne

- Par produit sélectionné P et par fenêtre sondée présente : chargement
  complet `[YYYY-08-21 → YYYY+1-08-21]` via `loadCoinbaseHistoricalDataset`
  (la complétude est le seul filtre — `INCOMPLETE_HISTORICAL_DATA` élimine
  la fenêtre, consignée, jamais comblée), puis UN replay V1-IDENTITY
  bit-identique aux campagnes D3-P2 C0 (config §3 de
  `strategy-permission.md` : gate EMA_THRESHOLD 100/5/3, exits
  REGIME_CONDITIONAL bull NONE / autres FIXED 300/600, calibration
  IDENTITY, permissions défaut, frais 6 bps, slippage 2 bps, capital
  10 000, targetSignalNotional 1 000, risque V1, ensemble
  rsi-reversion + ema-cross + breakout).
- **Chaque fenêtre annuelle d'un produit jamais consulté est un fold OOS
  propre par construction** : aucune sélection, calibration ou
  décision n'a jamais utilisé ces données. Il n'y a pas de train — la
  politique est le champion gelé ; l'objet mesuré est son transfert.
- Sorties par fenêtre : totalReturn, maxDrawdown, trades clôturés,
  realizedPnl, PnL net total (réalisé + latent final).

## 4. Portes et critères a priori (par produit, puis global)

Portes par produit (miroir `production-launch.md` §Porte 1, adaptées au
contexte sans-sélection) :

| # | Porte | Seuil |
| --- | --- | --- |
| G1 | Folds propres | ≥ 4 fenêtres annuelles complètes |
| G2 | Positivité | au moins 3 folds à rendement net > 0 (miroir exact de `production-launch.md` condition 3 : compte fixe, non ratio — un produit à 6 folds valides exige 3 positifs, pas 5) |
| G3 | Médiane | rendement net médian des folds > 0 |
| G4 | Profit factor | PF agrégé (gains/pertes réalisés poolés) > 1 |
| G5 | Espérance | PnL net total poolé / trades clôturés poolés > 0 |
| G6 | Sécurité | dd ≤ 10 % sur chaque fold |

Verdict H-D1 :

- **VALIDÉ** si ≥ 2 produits sur 4 passent G1-G6 **et** le pool de tous
  les folds de tous les produits a médiane > 0 et PF agrégé > 1.
- Tout autre issue : **DÉCLASSÉ** → H-D0 retenue, K1 déclenché (fermeture
  de la voie « bot autonome rentable » pour V1 ; priorité H-S1a).

Le seuil ≥ 2/4 exige qu'au moins la moitié de l'allowlist cible montre un
edge transférable : un résultat 0/4 ou 1/4 signifierait que l'edge V1 ne
se transfère pas de manière fiable et justifie la fermeture de la voie
(K1). Ce seuil est pré-enregistré et non ajustable.

Note : `production-launch.md` §Porte 1 évalue chaque produit
indépendamment. La condition globale (pool inter-produits) est un ajout
H-D1 : elle exige que le signal soit positif non seulement produit par
produit, mais aussi en agrégat — un produit fortement positif ne peut pas
masquer trois produits négatifs.

Lecture consignée hors critères : rendement géométrique annualisé par
produit, comparé à un proxy de taux sans risque (hypothèse externe, ~4 %/an,
non mesurée dans ce dépôt) — information K1, pas une porte.

## 5. Invariants

| # | Invariant |
| --- | --- |
| INV-R1 | Config V1 bit-identique D3-P2 C0 ; seuls le produit et les fenêtres varient. |
| INV-R2 | La découverte ne lit aucune métrique économique (présence + volume_24h du listing) ; la sélection est gelée et consignée avant la première lecture économique. |
| INV-R3 | Les listes d'exclusion sont appliquées avant la sonde et sont append-only. |
| INV-R4 | Aucune substitution de produit après la campagne ; un produit sous-approvisionné échoue G1. |
| INV-R5 | Contrôle de câblage : BTC-USD chargé par le même code, fenêtres 2023 et 2025 reproduisent les baselines V1 (+0,27 %/dd 2,93 % ; +3,63 %/3,37 %, tol 5e-5). |
| INV-R6 | Sélection et verdicts sont des fonctions pures sur données fermées ; aucun LLM. |

## 6. Limites assumées

- **Biais de survie** : les produits retenus existent aujourd'hui sur
  Coinbase avec historique — les délistés sont invisibles à l'API publique.
  Inévitable, consigné ; il gonfle mécaniquement l'edge apparent des
  années haussières (les produits morts de la période n'entrent pas).
- **Fenêtres comme proxy de survie** : le tri primaire par nombre de
  fenêtres présentes favorise les produits listés depuis longtemps et
  encore vivants — un produit délisté en 2019 ne peut pas contribuer. Ce
  n'est pas un critère de performance (aucun rendement n'est lu), mais
  c'est un critère de survie indirect. La justification est utilitaire
  (maximiser l'évidence disponible pour G1-G2-G3) et le biais va dans le
  sens d'un edge apparent gonflé — un résultat négatif malgré ce biais
  serait d'autant plus concluant ; un résultat positif est un majorant
  de l'edge réel.
- **Coûts homogènes 6+2 bps** : hypothèse raisonnable pour des produits
  liquides (le tie-break volume l'encourage) mais non vérifiée par spread
  réel — la porte 8 de `production-launch.md` (réalisme des coûts)
  exigeait une donnée spread par produit avant tout lancement ; hors
  périmètre ici.
- **Politique développée sur BTC** : les constantes V1 (exits 300/600, gate
  100/5/3) ont été choisies sur BTC ; les nouveaux produits testent le
  **transfert** de cette politique, pas son optimalité locale. C'est
  précisément l'objet d'H-D1 (edge transportable), assumé.
- **N = 4 produits** : un verdict VALIDÉ n'est pas une preuve portfolio ;
  c'est une porte de recherche franchie, rien de plus.
- Stablecoins et empaquetés exclus nominalement : toute erreur d'omission
  se corrige par ajout à la liste (append-only), pas par retrait de
  résultats.

## 7. Livrables

- `packages/backtest/scripts/product-oos-replication.ts` : découverte
  (§2.2), gel de sélection, campagne (§3), portes et verdict (§4),
  contrôle INV-R5 — une exécution, sortie tabulaire.
- Ce document complété : §8 résultats, statut → MESURÉ.

## 8. Résultats

Exécution : `packages/backtest/scripts/product-oos-replication.ts`
(2026-08-26). **INV-R5 PASS** — BTC reproduit les baselines V1 par le même
code-path (+0,27 %/2,93 % ; +3,63 %/3,37 %) : la mesure dérive de rien.

### 8.1 Découverte

Listing SPOT paginé : 927 produits ; 378 candidats USD/online hors
exclusions (20 consultés, 2 stables, 0 empaquetés, 527 statut/quote).
Sondes 5/5 × 10 fenêtres : 43 éligibles (≥ 5 fenêtres présentes). Sélection
gelée (fonction pure §2.2) : **ZRX-USD** (7/10), **OXT-USD, KNC-USD,
DASH-USD** (6/10). Les fenêtres 2016-2018 (ZRX) et 2016-2019 (autres) ont
été éliminées à la campagne par `INCOMPLETE_HISTORICAL_DATA` — les produits
sont listés trop récemment pour ces bornes (la sonde 5/5 au départ de
fenêtre ne détecte que le début, pas la complétude intégrale ; cause
constatée, non une substitution — INV-R4).

### 8.2 Campagne (folds = fenêtres annuelles OOS propres)

| Produit | folds | positifs | médiane | PF ($) | esp/trade | dd max | portes | Géom. annualisé |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ZRX-USD | 7 | 2 | −0,52 % | 0,86 | −1,55 $ | 8,46 % | FAIL G2-G5 | −0,52 % |
| OXT-USD | 6 | 1 | −2,24 % | 0,65 | −6,76 $ | 7,35 % | FAIL G2-G5 | −2,36 % |
| KNC-USD | 6 | 0 | −1,82 % | 0,60 | −6,88 $ | 6,29 % | FAIL G2-G5 | −2,38 % |
| DASH-USD | 6 | 3 | −0,60 % | 0,96 | −0,45 $ | 6,90 % | FAIL G3-G5 | −0,16 % |

Pool : médiane −1,45 %, PF 0,75. **Verdict : DÉCLASSÉ — 0/4 produits
PASS** (≥ 2 requis). H-D0 retenue.

### 8.3 Lecture honnête

- **L'edge de V1 ne se transfère pas du tout.** Sur des produits jamais
  consultés, la politique est perdante partout (−0,16 % à −2,38 %/an
  géométrique), y compris sur 2020-2024 qui contient des bull markets
  majeurs. Seul DASH approche l'équilibre (PF 0,96) sans l'atteindre.
- **Le résultat est renforcé par son propre biais** : la découverte
  favorise les survivants (§6), le pool est gonflé d'années haussières —
  et l'edge reste négatif. Un négatif malgré un biais qui gonfle est plus
  concluant qu'un positif net.
- **La moitié haute du portefeuille de portes transfère** : G6 (dd ≤ 10 %)
  passe sur les 4 produits (6,3-8,5 %) — le contrôle de risque et les
  garde-fous sont transportables. Ce qui ne transfère pas, c'est l'alpha.
- **La lecture rétrospective de BTC change de statut** : +1,66 %/an sur des
  fenêtres partiellement contaminées, négatif OOS propre ailleurs —
  l'hypothèse la plus parcimonieuse est que la marginalité BTC était
  elle-même un artefact (constants V1 choisies en regardant BTC). V1 n'a
  pas d'edge démontrable sur quelque produit que ce soit.
- Conséquence K1 : la voie « bot autonome rentable » pour **V1 en l'état**
  est fermée. La suite désignée par `signal-edge-inventory.md` §6 est
  **H-S1a** (découplage EMAs de signal vs filtre) — le seul levier
  restant qui touche la source du signal sans ré-optimiser sur données
  contaminées. La valeur démontrée et transférable du système reste son
  ingénierie (contrôle de risque, discipline, observabilité), pas sa
  politique de trading.

## 9. Hors périmètre

- Toute modification de V1 (un seul objet mesuré : le transfert du champion
  gelé) ; sélection par train (H-P2 fermé) ; timeframes (H-S1c) ;
  ré-optimisation par produit ; déploiement (un VALIDÉ ne déploie rien et
  n'ouvre aucune porte `production-launch.md` — il motive au mieux une
  nouvelle politique live candidate à son propre cycle).
