# P7 — entrée B&H indépendante, registre synthétique local

Statut : préparation locale uniquement, 14 octobre 2026. Aucun collector,
appel réseau, choix de source/T0, déploiement ou START_AUTHORIZED.

## Model / Review préalable

Budget BUY 10 000 $ par BTC/ETH, profil V6 immuable avant T0, frais/slippage
60/2 bps simulés. Pas d'intention P7 requise : un HOLD n'empêche pas B&H.
Le budget/profil est le checkpoint d'intention benchmark avant pricing ;
la quantité est calculée au budget après carnet, selon le protocole gelé.

Machine XState par produit : expected → requested → quoted → initialized/failed.
Carnet non éligible : requested → rejected → requested (nouvel essai explicite
dans les 2 h). Tous les essais/refus sont conservés ; aucun retry réseau
automatique ou budget d'appels fournisseur choisi dans ce lot.

- EXPECT_BENCHMARK : inscrit l'attente. Premier événement indépendant active
  ce mode pour **les deux** jambes : pas de mélange avec le replay legacy P7.
  Ce premier événement doit précéder toute publication initiale de quote ou
  mark dans le stream legacy : pas de changement de mode après avoir vu un prix.
- REQUEST_BENCHMARK : checkpoint durable en `[T0,T0+2 h]`, T1 exclus,
  profil présent et campagne localObserving ; un seul essai en vol par produit.
- OBSERVE_BENCHMARK_BOOK { book, bodySha256 } : requestedAt doit égaler le
  checkpoint ; identité/profil/cache/clock/séquence/temps/délais vérifiés.
  Éligibilité à l'heure de persistance, âge ≤5 s. Première quote éligible
  devient quoted, jamais remplaçable même si sa profondeur est insuffisante.
  Quote invalide reste archivée et rejected ; nouvel essai possible seulement
  tant qu'aucune quote éligible n'a été figée, sans prolongation.
- RESOLVE_BENCHMARK : aucune quantité/prix/frais/portefeuille client. Recalcul
  sous verrou sur la quote figée, quantité maximale au budget et broker réel.
  quote stale/depth insuffisante/campagne suspendue => failed sans débit.
  initialized contient fill simulé, coût/quantité, cash résiduel, preuve liée.
- EXPIRE_BENCHMARK : après la fenêtre uniquement, expected/rejected/quoted
  non initialisés deviennent failed. requested sans réponse reste UNOBSERVED :
  pas de faux refus technique ou de nouveau prix, récupération explicite requise.

Aucun rebalancing/sell/transfert. Les états terminalisés ne sont jamais remis
à zéro. Les deux portefeuilles B&H sont indépendants de P7 et entre eux.

## Transaction / reprise

Enveloppe V7 append-only dans le SQLite local. Replay recalcule phases,
éligibilité, sizing et balances ; le shell vérifie la concordance avec
executePaperOrder, sans accepter un signal/outcome libre d'un LLM.
Même commandId/contenu => reçu initial, même expiré, sans double achat.
Le premier carnet éligible et la résolution restent liés au profil enregistré.

Pré-COMMIT : horloge non régressive ; nouvelle initialisation doit toujours
respecter campagne localObserving, âge 5 s et fenêtre 2 h. Sinon rollback
total. Ces contrôles ne prouvent pas l'instant de fin du flush disque.
Une reprise requested sans réponse => SUSPEND, aucun refetch permis par
REQUEST_BENCHMARK. RECOVER_LOCAL considère aussi ces requêtes B&H perdues et
suspend le harnais P7 ; un I/O normal en vol n'est pas qualifié perdu sans reprise.

Projection cash/B&H préfère les portefeuilles V7 dès que le mode indépendant
est inscrit, sans fallback sur quotes P7 ni replay de fill implicitement.
Marks B&H restent dérivés en lecture seule des mêmes preuves horaires que P7.
Sans les deux initialisations, économie non évaluable et marks consolidés
UNAVAILABLE, pas des portefeuilles plats supposés.

Accepté pour implémentation locale : pas de transition réelle d'activation,
aucune mutation des balances/versions P7 ; hash déclaré non authentifiant.
Collector/budget fournisseur, minSize/minNotional du profil réel, marks B&H
persistés, after-fill/final, couverture conjointe/sûreté et assesseur restent
à livrer avant collecte. L'indépendance du stream local ne valide pas une source.

## Verify requis

HOLD/absence de quote P7, deux jambes, premier eligible figé, refus puis
nouvel essai avant deadline, profondeur insuffisante sans remplacement,
perte de réponse/reprise, T0/2 h/T1/5 s, idempotence/crash/replay, balances P7
inchangées, anti-fallback legacy, profil et reçus non falsifiables via API.

## Revue de livraison / Verify

- 8 tests purs : phases, mode figé, initialisation indépendante, carnet éligible
  non remplaçable, rejet/requête explicite, fenêtre/fraîcheur, profil et reprise.
- 8 tests SQLite/broker : deux HOLD, perte de réponse/réouverture, profondeur
  insuffisante, rollback de fraîcheur, sorties réelles avant/après COMMIT,
  refus puis premier eligible, idempotence après expiration et anti-hindsight.
- Architecture : core pur/XState typé ; shell revalide sous verrou, compare au
  broker réel, vérifie encore avant COMMIT. Aucun fill/risque/quantité P7 modifié.
- Sécurité : commandes sans prix/outcome et books normalisés fermés, profil
  antérieur immuable. Hash/chaîne/reçus revalidés ; ni signature ni authenticité
  de venue démontrée. `entryCheckedAt` est pré-insertion, pas l'heure de flush.
- Performance : mêmes limites numériques/profondeur et replay local complet.
  Les carnets restent archivés et dans la projection de jambe : pas un schéma
  de payloads optimisé ou un benchmark de coût pour 180 jours distants.
- Limites : aucun I/O automatique, lease, repair/resume, quota choisi ou profil
  réel vérifié. Les marks B&H demeurent des projections en lecture seule ;
  qualité/sûreté conjointes et assesseur restent à livrer.
- Verify global : 603 tests modèles, 313 agent et 133 backtest passent ;
  TypeScript, builds dry-run et lint ciblé passent. Aucun fichier utilisateur
  préexistant modifié ; JSON concaténé limitant le lint global laissé intact.
