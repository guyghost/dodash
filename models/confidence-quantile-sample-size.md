# Modèle d’audit de résolution du rang p95

Cette étape conserve sans re-sélection `NEAREST_RANK`, la borne absolue de
`600 USD` et la borne relative `p95 / médiane <= 2`. Elle explique séparément
combien d’observations actives soutiennent chaque p95 et si la faible résolution
du rang rend le diagnostic sensible aux conventions discrètes. Elle ne modifie
aucun verdict antérieur et n’autorise aucune exécution live.

## Question et protocole figé

L’audit répond à deux questions indépendantes :

1. quelle est la résolution empirique du rang p95 dans chaque case active de
   l’étude XTZ/ZEC puis GRT/MANA ;
2. une source locale permet-elle une réplication identique sur une paire issue
   d’un univers moins corrélé ?

Les décisions suivantes sont prises avant le nouvel audit :

- probabilité `0.95` ;
- estimateur sélectionné `NEAREST_RANK` ;
- médiane `LINEAR_R7` à `0.5` ;
- borne p95 `<= 600 USD` ;
- borne p95/médiane `<= 2` ;
- conventions discrètes descriptives `LOWER`, `NEAREST_RANK`, `HIGHER` ;
- populations, produits, folds, profils, stratégies et échantillons identiques
  à l’artefact de sensibilité XTZ/ZEC/GRT/MANA ;
- aucune re-sélection d’estimateur, d’actif, de fold ou de seuil ;
- PnL, liquidité et alpha hors du verdict.

L’audit inter-univers n’est exécutable que si une frontière de données déjà
disponible fournit une paire non crypto à la fois en `ONE_DAY` et `SIX_HOUR`
sur les quatre folds, avec OHLCV, timestamps, politique d’ajustement et
sémantique d’exécution comparables. Une source exigeant un nouveau credential,
une souscription, un fallback de granularité ou une reconstruction à partir
d’un autre grain n’est pas « disponible » pour cette instance.

## Grain et résolution du rang

Le grain de base reste
`population × produit/fold × stratégie`, uniquement pour `POWER_THIRD`.
Chaque case conserve :

- `activeSignalCount = n` ;
- le rang sélectionné `r = ceil(0.95 × n)` pour `n > 0` ;
- le nombre d’observations au-dessus du rang `n - r` ;
- médiane R7, p95 `LOWER`, `NEAREST_RANK` et `HIGHER` ;
- dépassements absolu et relatif de `NEAREST_RANK` ;
- étendue discrète `max(p95) - min(p95)` et cette étendue rapportée à la
  médiane ;
- désaccord de décision si les trois conventions discrètes ne produisent pas
  toutes le même résultat face aux deux bornes.

La classe de résolution découle uniquement du rang, pas des données observées :

| Classe | Définition | Interprétation |
| --- | --- | --- |
| `NO_ACTIVE_SIGNALS` | `n = 0` | p95 non défini |
| `MAXIMUM` | `n - r = 0` | nearest-rank sélectionne le maximum |
| `ONE_ABOVE` | `n - r = 1` | une seule observation subsiste au-dessus |
| `TWO_OR_MORE_ABOVE` | `n - r >= 2` | au moins deux observations subsistent |

À `q = 0.95`, ces classes correspondent respectivement à `n = 0`, `1..19`,
`20..39` et `>= 40`. Les résumés sont calculés séparément par population puis
par classe ; aucun taux agrégé ne masque la taille d’échantillon de chaque run.

## États, événements et transitions

Le runner one-shot suit les transitions explicites suivantes :

1. `CREATED` reçoit `POLICY_FROZEN` et devient `FROZEN` ;
2. `FROZEN` reçoit `LOCAL_SOURCES_AUDITED` et devient `SOURCE_AUDITED` ;
3. `SOURCE_AUDITED` reçoit `PRIOR_ARTIFACT_LOADED` et devient `VALIDATING` ;
4. `VALIDATING` reçoit `EVIDENCE_ACCEPTED` et devient `AUDITING` ;
5. `AUDITING` reçoit `AUDIT_COMPUTED` et devient `REPORT_READY` ;
6. `REPORT_READY` reçoit `ARTIFACT_WRITTEN` et devient `COMPLETED`, terminal ;
7. toute preuve invalide reçoit `EVIDENCE_REJECTED` et devient
   `INVALID_EVIDENCE`, terminal, sans nouvel artefact final.

Le statut de réplication inter-univers est un résultat fermé de l’audit de
source : `NOT_EXECUTED_SOURCE_UNAVAILABLE` si aucune source n’est éligible, ou
`NOT_EXECUTED_PREREGISTRATION_REQUIRED` si une source comparable existe mais
que sa paire n’a pas encore été figée. Seul un runner ultérieur, pré-enregistré
avant lecture des prix, pourra produire `EXECUTED`. Ces statuts ne bloquent pas
l’audit des tailles d’échantillon existantes et ne peuvent déclencher ni
substitution d’actifs, ni téléchargement, ni modification de protocole.

## Validation de l’évidence

Le cœur exige exactement les huit run keys de référence XTZ/ZEC et les huit run
keys externes GRT/MANA, chacune croisée avec `ema-cross` et `breakout`, soit 32
cases `POWER_THIRD`. Il refuse : population, run key ou stratégie inconnue ;
case absente ou dupliquée ; compteur négatif/non entier ; longueur d’échantillon
différente du compteur actif ; valeur non finie ou non positive ; quantile ou
médiane impossible ; ou protocole amont différent de `NEAREST_RANK`, `600` et
`2`.

Une case inactive est valide seulement avec un échantillon vide. Elle est
rapportée dans `NO_ACTIVE_SIGNALS` et ne produit ni quantile, ni ratio, ni
dépassement.

## Décision et limites d’usage

L’audit est descriptif. Il peut confirmer qu’un dépassement est concentré dans
une classe de résolution, mais il ne peut pas :

- remplacer `NEAREST_RANK` par une convention plus favorable ;
- modifier les bornes `600` et `2` ;
- requalifier la confirmation GRT/MANA ;
- conclure à la liquidité exécutable, à l’alpha ou à la rentabilité ;
- activer une permission paper ou live.

Le statut publié reste `RESEARCH_ONLY`, avec
`liveAuthorization = false`, `liquidityValidated = false` et
`alphaValidated = false`.

## Effets de bord et invariants

Le cœur est synchrone, pur et sans I/O. Le shell seul inspecte les adapters,
lit l’artefact antérieur, journalise et écrit le nouvel artefact atomiquement.

1. `NEAREST_RANK`, `600` et `2` sont immuables.
2. Les trois conventions discrètes consomment exactement le même échantillon.
3. `activeSignalCount` est publié pour chaque case, jamais seulement agrégé.
4. La classe de résolution dépend uniquement de `n` et de `q = 0.95`.
5. Une source absente produit un statut explicite, jamais un proxy implicite.
6. La réplication inter-univers et l’audit de taille sont deux résultats
   indépendants.
7. Aucun résultat ne change un verdict antérieur ou une configuration live.
8. Une preuve invalide ne produit ni résumé, ni artefact final.
