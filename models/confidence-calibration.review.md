# Revue de la calibration de confiance

La transformation est un cœur fonctionnel sans workflow implicite : une entrée
valide produit une valeur, une entrée invalide produit un code fermé. Les quatre
profils préservent les bornes et l'ordre des signaux. Aucun texte libre, score
LLM, date courante ou état mutable ne choisit un profil.

Le chemin `IDENTITY` protège la compatibilité du backtest existant. Les profils
actifs ne changent que la confiance de `BUY` et `SELL`; un `HOLD` est retourné
tel quel. La revue interdit notamment de recalculer `suggestedSize`, de changer
un `reasonCode`, de transformer un `HOLD` en signal actif ou d'appliquer une
calibration cachée à RSI.

Les erreurs couvrent les profils inconnus, `NaN`, les infinis et les valeurs
hors `[0, 1]`. Les tests couvrent aussi les points `0` et `1`, la monotonie,
l'ordre de force des profils et une valeur dont les racines sont exactes.

L'expérience sépare développement et holdout par construction. Les datasets de
holdout ne sont demandés qu'après retour d'une sélection non nulle. Un échec de
chargement n'est jamais remplacé par un autre produit, une autre période ou une
résolution primaire seule. Il n'existe ni retry décisionnel, ni fallback vers
le meilleur rendement.

La sélection refuse :

- une combinaison profil/run/stratégie absente ou dupliquée ;
- un signal actif nul, une médiane absente ou non positive ;
- une métrique non finie ou hors de son domaine ;
- un plafond d'allocation ou une réduction risque, même si le rendement est bon ;
- un dépassement de drawdown, turnover ou frais ;
- un profil inconnu ou une liste de runs attendus vide/dupliquée.

Les seuils de sélection sont figés avant l'exécution. La bande 100–400 USD vise
une exposition suffisamment mesurable sans transformer chaque signal en ordre
plein de 1 000 USD. Les garde-fous sont volontairement larges et servent à
refuser une amplification manifestement coûteuse ou risquée, pas à optimiser le
PnL.

Le holdout vérifie la stabilité de l'échelle, des coûts et du risque, mais la
fenêtre 2025–2026 ETC/ATOM a été partiellement observée lors du diagnostic
précédent. Le rapport doit donc la qualifier de validation temporelle imparfaite,
pas d'échantillon totalement vierge. Une confirmation ultérieure sur des dates
futures ou des actifs jamais consultés reste nécessaire.

Le turnover est calculé sur les fills au prix papier, frais exclus du notionnel
échangé mais reportés séparément. Les intentions diagnostiquées au close et les
fills à l'ouverture suivante restent deux populations distinctes. Aucun gain de
calibration ne peut être présenté comme une garantie de liquidité ou de
performance live.
