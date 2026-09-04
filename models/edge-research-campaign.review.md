# Revue — Campagne d'edge multi-régimes (grille v2, DAO #40)

Relecture du modèle `models/edge-research-campaign.md` avant gel. La revue
vérifie la fidélité aux modèles existants, la résistance au biais de
sélection et l'exactitude des mécaniques d'exécution déclarées. Elle ne
contient aucune valeur issue d'un run de la grille.

## Cohérence avec les modèles existants

- **Évaluation v2** (`models/backtest-diagnostics.md`) : les verdicts
  n'utilisent que les métriques primaires ; l'excess reste contextuel et
  toujours accompagné du régime calculé au seuil figé zéro. Le modèle
  n'introduit aucun second seuil de régime (HAUSSIER/BAISSIER suffisent ;
  un régime « range » exigerait un nouvel amendement, pas un paramètre de
  campagne).
- **Calibration** (`models/confidence-calibration.md`,
  `models/confidence-calibration-confirmation.md`) : POWER_THIRD s'applique
  à ema-cross et breakout, rsi-reversion n'est pas calibrée — la duplication
  IDENTITY/POWER_THIRD des cellules rsi est déclarée avant exécution et la
  déduplication des candidates est figée. Le seuil d'inactivité (médiane du
  notional demandé < 100 $) reprend la borne basse de la bande confirmée
  [100 ; 400] $ : il s'appuie sur une constante déjà revue, il n'invente pas
  une nouvelle métrique. Le turnover seul serait un mauvais critère
  d'inactivité (un trade unique de fort notional le gonfle) — la médiane du
  notional demandé est la mesure directe de l'exposition.
- **Funding-trend** (`models/funding-rate-strategy.md` §5) : la cellule
  informationnelle réutilise la constante figée p75 et les fixtures
  dao30/dao35 avec re-vérification d'empreinte ; « 0 trade attendu » est le
  constat de structure de signe déjà pré-enregistré au modèle §5, repris
  tel quel, sans le présenter comme un résultat nouveau.

## Décisions de conception et alternatives rejetées

1. **Découpe des fenêtres** : années civiles à bornes figées, régime
   calculé a posteriori par fenêtre. Alternative rejetée : découper la
   fenêtre complète en segments contigus de régime (HAUSSIER/BAISSIER)
   dérivés de la courbe du benchmark — c'est une découpe dépendante des
   données, impossible à figer proprement avant exécution (les bornes
   dépendraient du dataset du jour) ; elle ouvrirait une porte à la
   sélection post-hoc. La variante retenue garde toutes les bornes
   indépendantes des données : seul le label de régime est calculé, par le
   seuil déjà figé de l'évaluation v2.
2. **Criblage large, confirmation stricte** : l'étiquette « edge démontré »
   (PnL > 0 et Sharpe > 0, cellule active) est volontairement permissive
   pour ne rien filtrer avant l'OOS ; les seuils stricts sont portés par le
   protocole OOS. L'inverse (criblage sévère) aurait créé une classe de
   cellules positives invisibles sans voie de confirmation — pire pour le
   risque de faux positifs, pas meilleur.
3. **Fenêtre successor hors données existantes** ([2026-09-05,
   2027-09-05)) : aucune partie de la grille ne peut servir d'« OOS » à une
   autre (toutes les fenêtres sont in-sample par construction et BTC/ETH
   partagent leurs régimes) ; la seule confirmation non contaminée est
   temporelle, sur des données futures. La réplication cross-actif et la
   cohérence ×1/×2 sont des contrôles nécessaires mais explicitement non
   suffisants.
4. **Seuils OOS** : leur justification est mince par nature (des valeurs
   atteignables, nettement positives) ; le modèle le dit. Ce qui les rend
   valides est le gel antérieur à toute lecture OOS et l'interdiction de
   recalibrage — la revue insiste pour que cette phrase reste dans le
   modèle.
5. **Multiplicité (C4)** chiffrée avant exécution : ~84 cellules positives
   attendues sous H0 sur 168. Ce chiffrage précède la lecture d'un quelconque
   résultat ; il interdit de découvrir après coup « qu'il fallait » corriger
   la multiplicité.

## Corrections appliquées en revue

1. **Borne de fin explicite** : les fenêtres sont désormais déclarées avec
   borne de fin exclusive (2026-09-04T00:00:00Z) et dernier jour clôturé
   nommé (2026-09-03) — la formulation initiale « jusqu'au 2026-09-04 »
   était ambiguë sur l'inclusion du dernier jour.
2. **Chemin d'exécution funding-trend** : le modèle interdit désormais le
   chemin des indicateurs préparés (#37) pour la cellule funding-trend —
   les snapshots préparés ne portent pas `fundingAvg`, un 0 trade obtenu
   par ce chemin serait un artefact de mécanique et non un résultat. Le
   coût (chemin de repli quadratique, ~75 s) est assumé et chiffré.
3. **Dénombrement figé** : 56 runs, 168 cellules primaires, 58 cellules
   informationnelles écrits explicitement, pour que tout écart entre la
   grille annoncée et la grille exécutée soit visible dans le rapport.

## Vérifications de mécanique

- La suite (`packages/backtest/src/suite.ts`) produit par run les scénarios
  rsi-reversion, ema-cross, breakout et ensemble avec les diagnostics
  demandés (notional demandé médian par stratégie) ; les champs requis par
  l'évaluation v2 (réalisé/latent, win rate liquidatif) sont présents sur
  les runs neufs — aucune lecture legacy n'est nécessaire dans cette
  campagne.
- Un dataset par (actif, fenêtre) partagé entre les 4 bras garantit que
  toute différence inter-bras vient de la calibration ou des coûts, pas du
  fetch.
- La reprise sur artefact existant ne réécrit aucune valeur ; elle ne
  peut pas masquer un échec (le statut d'échec fait partie de l'artefact
  consolidé).
- C2 : le périmètre d'écriture se limite à deux fichiers de modèle, un
  script d'analyse et un rapport ; aucun fichier de `src/` de trading
  n'est touché.

## Verdict de revue

Modèle approuvé en l'état (corrections 1-3 intégrées). La grille est figée ;
l'exécution peut commencer après commit de ce dossier models, l'historique
git devant établir l'antériorité (C1).
