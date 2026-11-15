# P7 — benchmarks cash/B&H, préparation locale

Statut : projection synthétique locale, 14 octobre 2026. Pas de nouvelle
collecte, ordre, démarrage, stockage distant ou modification du portefeuille P7.

## Model

Cash : référence analytique 20 000 $, taux 0 %. Aucune quote/frais inventés,
aucune disponibilité fournisseur inférée de sa valeur constante.

B&H : deux budgets initiaux de 10 000 $, BTC/ETH spot, frais/slippage paper
60/2 bps, aucun rééquilibrage. Profil de précision explicite enregistré
**avant T0** dans le journal local : sourceProfileId identique au manifest,
profileSha256 déclaré, quantityDecimals BTC/ETH entiers 0..12. Immuable,
pas de précision déduite du prix ou retouchée après résultats.

La borne 12 est une limite du prototype numérique, pas une règle de venue.
Nombre de lots doit être un entier sûr ; valeurs hors plage => refus, pas
de réduction silencieuse de précision. Règles minNotional/minSize et contraintes
du profil réel restent à vérifier avant collecte, non validées par ce lot.

Quantité : lot = 10^-quantityDecimals. Chercher le plus grand entier de lots
finançable selon `askNotional(q) ×1,0002×1,006 ≤10 000`. Consommer le même
carnet complet, jamais extrapoler. Si q+1 lot dépasse le carnet, la quantité
est déterminable uniquement si son **coût minimal**, au dernier ask connu
pour la partie inconnue, dépasse le budget. Sinon INSUFFICIENT_DEPTH :
aucun achat partiel opportuniste. Quantité nulle ou numérique invérifiable
=> benchmark non initialisé. Pas de tolérance permettant de dépasser le budget.

## Projection d'archive locale / frontière

`docs/analysis/p7-prospective-benchmarks.mjs` relit un export revalidé. Utilise
uniquement l'OBSERVE_QUOTE publié pour le slot daily initial T0 de chaque
produit, qui est unique dans le ledger courant, avec son éligibilité durable
et l'heure originale de persistance. Réutilise planP7Pricing puis le vrai
broker paper, VWAP brut, quantité au budget et coûts uniques.

Cette projection est un **replay déterministe de benchmark**, pas une écriture
de fill rétrospectif dans le ledger ou une exécution après observation. Aucun
nouveau carnet fourni par l'appelant, prix alternatif ou retry. Quote initiale
invalide/profondeur insuffisante => non initialisé, pas un meilleur carnet
choisi ensuite. Avant clôture de la fenêtre 2 h, absence = PENDING ; après,
NOT_INITIALIZED. Absence d'une jambe => B&H consolidé non initialisé.

Limite importante : le stream initial courant est celui du slot d'exécution
P7. Si P7 HOLD et ne publie pas de quote, ce prototype ne peut pas initialiser
B&H. Le futur collector doit publier son premier carnet éligible initial
indépendamment de la décision P7, sous checkpoint/modèle dédié. Ne pas prétendre
que ce lot implémente ce collecteur ou permet un démarrage réel.

## Marks et couverture comparables

Projection B&H sur les **mêmes preuves OBSERVE_MARK et asOf** que P7 ; cash
résiduel conservé, vente hypothétique sur les bids + coûts de sortie estimés,
aucun ordre/débit/vente ou recalcul de quantité initiale.

Avant l'initialisation complète ou avant la date du dernier fill benchmark,
marks B&H UNAVAILABLE, pas un portefeuille plat supposé. Quote/profondeur
insuffisante pour sa quantité => UNAVAILABLE, même si P7 CASH est disponible.
Séquences de marks B&H propres et non régressives ; checkpoint de requête
de mark respecté. Ni marks P7, ni état de sûreté P7 ne sont modifiés.

Rapport B&H réutilise le calendrier horaire 4 320 slots et les asOf réels :
AVAILABLE / UNAVAILABLE / UNOBSERVED, heure courante séparée, maximum de gap
historique >2 h strict. Aucun mark inventé pour remplir les heures absentes.
Le cash constant ne remplit pas la couverture B&H ou fournisseur.

Le rapport indique initializationComplete et les couvertures P7/B&H,
sans verdict technique/économique ou autorisation live. Preflight, assesseur,
persistance des fills/marks benchmark dans un stream dédié, après-fill/final,
source/T0 et exports/anchors restent des incréments séparés.

## Review / Verify

Accepté pour calculs/replay locaux : profil figé avant T0, budgets indépendants,
prix déjà publiés non sélectionnables, quantité déterminable sur profondeur,
broker existant, aucun coût doublé et aucune mutation P7.

Tests avant code : VWAP au budget multi-niveaux, arrondi/maximalité, manque
de profondeur vs reliquat d'arrondi, limites numériques, profil immuable,
quote initiale figée, une jambe manquante, marks communs non backfillés,
cash résiduel/frais uniques et couverture B&H distincte de P7 plat.

## Revue de livraison / Verify

- 6 tests purs : maximalité du lot financé, VWAP multi-niveaux, borne de
  profondeur vs reliquat, 0..12 décimales, plage numérique et profil fermé.
- 8 tests SQLite/broker : quotes initiales figées, deux jambes, cash résiduel,
  coûts uniques, une jambe manquante, profondeur B&H distincte de P7 CASH,
  marks antérieurs non backfillés, profil immuable/réouverture et rollback T0.
- Profil inscrit en enveloppe V6 et revalidé au replay ; idempotence avant
  clock comme les autres commandes. `benchmarkCheckedAt` est une vérification
  avant insertion, pas la date de fin du COMMIT/flush. Contrôle répété après
  insertion. Les hashes déclarés ne prouvent toujours pas l'authenticité amont.
- Core sans I/O/broker ; bridge lit seulement, réutilise broker paper et
  garde de pricing. Aucun fill/mark B&H écrit rétroactivement, état de campagne
  et portefeuille P7 non modifiés par la projection.
- Sizing : recherche monotone sur lots entiers sûrs, carnet ≤5 000 niveaux,
  contrôle du coût broker réel et du prochain lot, fail-closed sur overflow,
  underflow ou addition qui perd un niveau. Coût de replay local assumé,
  pas une promesse de performance/coût collector distant.
- Suite globale : 595 modèles, 313 agent et 133 backtest passent ; TypeScript,
  build dry-run et lint ciblé passent. Deux timeouts backtest de 5 s ont été
  observés avec builds/check/tests simultanés ; les 19 tests concernés puis
  toute la suite passent sans builds concurrents, sans changement de délais
  ou assertions. Le lint global reste limité par le JSON préexistant intact.

Accepté comme projection synthétique locale, **pas comme benchmark prospectif
collecté**. Le stream de quotes initiales indépendant de P7 HOLD et sa machine,
la persistance des fills/marks B&H et la qualification conjointe restent à livrer.
