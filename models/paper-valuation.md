# Valorisation paper datée — DAO #62

Statut : modèle normatif pour l’implémentation de #62. Aucun déploiement ou
changement de décision live n’est autorisé par ce modèle.

## 1. But et frontière

Fournir une mesure paper déterministe et partageable par le runtime, les
réponses API, le dashboard et Analytics Engine. Cette mesure ne choisit pas une
stratégie, ne valide pas le risque et ne produit aucune transition de la
`tradingCycleMachine`. Il s’agit d’une projection pure, donc aucun nouvel état
persistant ni machine XState n’est nécessaire.

Le contrat exécutable est `models/paper-valuation.ts` :
`projectPaperValuation({ cash, positionQuantity, mark, asOf })`.

## 2. Entrées et provenance

- `cash` et `positionQuantity` sont les faits du portefeuille paper après la
  dernière exécution confirmée. Une valeur négative ou non finie est invalide.
- Le seul prix accepté est `COINBASE_CANDLE_CLOSE`, lu dans la dernière bougie
  du snapshot marché accepté pour le cycle. Le mark capture également son
  timeframe.
- `candleClosedAt = candle.start + TIMEFRAME_MILLISECONDS[timeframe]`. Ne pas
  employer l’heure de déclenchement, l’heure d’écriture, l’`averagePrice` ou le
  prix de fill à la place de la date de clôture de la bougie.
- Le mark capture `timeframe` et `maxMarketStalenessMs`, politique déjà validée
  dans la configuration au moment de l’observation. `asOf` est l’horodatage de
  la projection. Pas de nouveau seuil implicite.
- Une marque absente rend la valorisation indisponible. Un ancien dernier mark
  peut rester affiché avec sa date et sa qualité `stale`; le coût d’acquisition
  n’est jamais une marque de repli.

## 3. Calcul et qualité

Pour une marque valide :

```text
ageMs = asOf - candleClosedAt
equity = cash + positionQuantity * mark.price
quality = fresh si 0 <= ageMs <= mark.maxMarketStalenessMs, sinon stale
exposureNotional = abs(positionQuantity) * mark.price
exposureQuality = quality si positionQuantity > 0, fresh si positionQuantity = 0
```

La marque future ou invalide produit un échec typé. Sans marque, le résultat
porte prix/date/âge nuls et `quality = unavailable`; `equity` vaut `null` avec
une position ouverte, et `cash` si la quantité est nulle. Une marque périmée
conserve la dernière estimation numérique mais la qualifie `stale`; elle ne
constitue pas une preuve de valeur fraîche ou de respect d’une limite.
Le projecteur retourne aussi `exposureNotional` et `exposureQuality` : zéro exact
pour une position plate, `null/unavailable` pour une position ouverte sans mark.

Les frais sont déjà inscrits dans le cash post-fill et ne sont pas retranchés
une seconde fois. Après fill, appliquer le mark accepté au portefeuille mis à
jour. À portefeuille constant, une variation `Δprice` change l’équité de
`positionQuantity * Δprice`. Une vente partielle réduit la quantité et inclut
le fill et les frais déjà portés dans le cash.

Si la quantité est nulle et le mark indisponible, la somme exacte de cash reste
connue (`equity=cash`), mais la qualité du mark reste `unavailable`. Avec une
position ouverte sans mark, `equity=null`.

## 4. Exposition et risque

L’exposition brute mesurée d’un produit est `abs(positionQuantity) * mark`.
Une marque périmée produit une exposition `stale`; une marque indisponible
rend l’exposition numérique indisponible. L’agrégat portefeuille est la somme
déterministe, triée par `productId`; il est `unavailable` si un créneau n’a pas
de valeur calculable, et `stale` si au moins un créneau est stale. L’API et le
dashboard ne substituent ni `averagePrice` ni zéro en cas d’absence.

L’état de la machine orchestratrice reste la source du périmètre de produits.
Le modèle de mesure n’altère pas ses chiffres d’admission, le snapshot transmis
à `checkRisk`, les seuils, `dailyPnl`, ni les états XState. Le contrat de
`models/daily-risk.ts` accepte toujours la valeur que son appelant lui fournit;
utiliser la nouvelle mesure pour modifier une garde exige une revue de risque
et une décision gouvernée distinctes.

En télémétrie, distinguer la valeur consolidée mesurée de
`otherExposureNotional`, champ historique du snapshot risque. En paper,
`otherExposureNotional` n’est pas une mesure fiable à publier quand sa source
est le stub; publier `null` et une qualité indisponible. Aucun consommateur ne
doit interpréter le zéro de remplissage Analytics Engine comme une vraie
exposition nulle sans son indicateur de présence et sa qualité.

## 5. Persistance, API et compatibilité

Le résumé de cycle persiste le prix, `candleClosedAt`, sa source et la limite
d’âge employée. Une restauration legacy sans provenance produit une mesure
`unavailable`, jamais un timestamp reconstruit depuis `triggeredAt`. Les
réponses `/state`, `/pnl` et la hiérarchie `portfolioSummary` exposent valeur,
source, date et qualité cohérentes. Analytics Engine conserve les blobs
existants 1–7 (blob6 = erreur, blob7 = rejet broker); les champs de valuation
et d’exposition s’ajoutent après eux sous un nouveau `schemaVersion`.

Un `valuationMark` issu des artefacts de cycle n’est accepté qu’après
validation complète et copie immuable via `normalizePaperValuationMark`. Une
marque absente ou invalide conserve uniquement le précédent mark s’il passe à
nouveau cette normalisation; un ancien mark invalide devient `null`. Cette
normalisation s’applique au runtime mono-produit, à chaque produit d’une
session et à leur restauration. Elle ne change ni l’issue du cycle ni une
transition de la machine.

Le changement de schéma API/AE est additif. La lecture des données legacy reste
possible et produit des champs de marque indisponibles. Aucun secret, payload
de requête ou identifiant de compte n’est ajouté.

## 6. Vérification requise

- variation du prix sur cash et quantité constants;
- achat, frais uniques, vente partielle et cycle sans fill;
- marque fraîche à la limite, stale au-delà, absente et future/invalide;
- mono-produit et portefeuille multi-produits, avec un mark indisponible;
- exposition/API/dashboard/AE cohérentes sur la même provenance;
- tests de caractérisation prouvant que `checkRisk`, les gardes d’admission et
  les transitions de `dailyRisk` ne changent pas.
