# P7 — registre horaire des marks, préparation locale

Statut : contrat local, 14 octobre 2026. Pas de collecte réseau, stockage
distant, migration du bot, démarrage ou autorisation de trading.

## Model

Calendrier horaire UTC figé : 4 320 slots sur `[T0,T1)`, clé
`(campaignId, scheduledAt)`, pour un mark consolidé P7 BTC+ETH. T0 est inclus,
T1 exclu ; la projection finale à T1 et les marks après fill sont séparés,
non implémentés par ce calendrier. B&H et qualification globale non livrés.

Machine XState : `expected → requested → observed`.

- `EXPECT_MARK` : inscrit le slot, possible avant sa date ou après un trou.
  Enregistrer tard l'attente ne crée pas une observation passée.
- `REQUEST_MARK` : checkpoint durable **avant** I/O, heure injectée dans
  `[scheduledAt, scheduledAt+1 h)` et `[T0,T1)`. Un seul essai par slot.
- `OBSERVE_MARK { books }` : réponse de cet essai uniquement, dans la même
  heure. Les deux produits sont calculés à l'heure de persistance `asOf`,
  avec cash/positions/versions relus sous verrou. Aucun portefeuille client.
  Le délai depuis scheduledAt est conservé : pas de mark antidaté au début
  de l'heure. Cette classification horaire ne prouve pas une ponctualité
  seconde-par-seconde ; les écarts se mesurent sur les asOf réels.

Chaque preuve produit est `{ bodySha256, book }` ou null (absence explicitement
observée). Le carnet garde identité/profil, cache, timestamp ms, délai/âge
≤5 s, ordre et profondeur ; requestedAt doit égaler le checkpoint. Le hash
déclaré est une référence, pas une authentification du payload amont.
Séquences de marks non régressives, comparées aussi au dernier carnet
d'exécution durable connu ; les marques ne changent pas le flux de séquence
d'exécution existant. Leur unification distante reste à concevoir.

Position nulle connue : mark CASH sans carnet inventé ; ce n'est pas une
preuve de disponibilité fournisseur. Position ouverte sans preuve fraîche
ou profondeur : UNAVAILABLE, equity null. Les frais de sortie restent une
estimation sans vente, débit, fill ou version de portefeuille supplémentaire.
Consolidation disponible seulement si BTC et ETH disponibles au même asOf.

## Atomicité / reprise

Enveloppe append-only `schemaVersion:3` dans le journal existant, commande,
reçu, versions/balances de référence et marks ensemble. Replay recalcule
depuis les portefeuilles antérieurs et preuves inscrites ; reçu client non
autoritaire. Pas de table mutable de marks ou de portefeuille.

Méthode locale `applyMark` : BEGIN IMMEDIATE, replay, déduplication, horloge,
modèle pur, insertion unique, contrôle final, COMMIT. Même ID/contenu => reçu
initial sans recalcul, même expiré. Collision V1/V2/V3 ou nouveau prix sur un
slot observed : conflit/refus. Une commande V3 ne passe pas par apply V1.

Après insertion, une marque ouverte annoncée disponible doit rester fraîche
au contrôle pré-COMMIT ; sinon rollback total (`MARK_EXPIRED_BEFORE_COMMIT`).
Régression de clock : rollback. Les refus sont conservés, pas transformés
en marks disponibles. L'heure conservée est asOf avant insertion, pas l'heure
de flush disque. Reprise requested sans réponse : SUSPEND, pas de refetch.
API de réparation/observation perdue non livrée ; le trou reste visible.

## Complétude (pas un verdict)

Rapport pur calculé sur le calendrier **indépendamment des EXPECT inscrits**.
À asOf, seuls les slots dont l'heure est terminée entrent dans le dénominateur
de couverture à date ; l'heure courante est séparée, pas une panne anticipée.
À T1 le dénominateur vaut 4 320. Aucune prolongation après T1.

- AVAILABLE : observation consolidée valide.
- UNAVAILABLE : observation inscrite mais consolidation impossible.
- UNOBSERVED : aucune observation, y compris slot non enregistré ou requested
  sans réponse. Détail pending conservé, jamais MISSED ou zéro inventé.
- Ratio = AVAILABLE / slots terminés, null si aucun terminé. ≥99 % inchangé.

Gap calculé sur les heures **réelles** des marks disponibles : segment initial
depuis T0 (sans prétendre à une observation T0), segments internes et trailing
jusqu'à min(asOf,T1). Maximum historique conservé, >2 h strict déclenche un
signal `proofGapExceeded`, pas une transition automatique ou un verdict.
Un mark récent ne gomme pas un trou passé. CASH compte pour P7 disponible,
mais ne valide ni les carnets B&H ni la couverture fournisseur.

## Review / Verify

Accepté pour prototype local : modèle/valorisation sans I/O, XState par slot,
clock et SQLite dans shell. Cash, position et version inchangés ; seules les
projections de preuve et de clock progressent. Un trou ne peut être comblé
par une valorisation actuelle attribuée à une heure terminée.

Tests requis : calendrier/T0/T1, deux produits, profondeur/source stale,
asOf vs scheduledAt, portefeuille changé entre request et réponse, cash plat,
reprise/idempotence/crash, conflits de versions de format, non-mutation,
comptes cohérents, seuil exact 2 h et trou historique non effacé.

Machine de campagne/suspension effective, B&H, marks après fill/final,
exports/anchors distants et choix de source/T0 restent bloquants.

## Revue de livraison / Verify

- 11 tests purs : phases/horloge, calendrier UTC, asOf distinct de la clé,
  cash/position ouverte, dénominateur indépendant du journal, heures manquantes,
  heure courante, frontière 2 h et trou historique conservé.
- 15 tests SQLite : balances/versions non mutées, portefeuille changé après
  REQUEST, quotes stale/profondeur/sequence/checkpoint, revalidation finale,
  rollback, sorties réelles de processus avant/après COMMIT, réouverture,
  collisions V1/V3, deux connexions et altération de mark malgré hash recalculé.
- Architecture : core pur + XState, même transaction shell et journal que
  V1/V2. Projection de clock partagée pour empêcher une observation antidatée.
- Sécurité : commandes/preuves fermées, JSON canonique borné, SHA/chaîne et
  reçus recalculés. Les hashes ne sont pas des signatures ; réécriture entière
  par administrateur hostile, authenticité amont et anchors externes non prouvés.
- Performance : calendrier borné à 4 320 heures, côtés de carnet bornés ;
  replay complet et payloads dans le journal local. Pas une architecture
  optimisée ou benchmark de coût pour un Worker 180 jours.
- API de récupération d'une réponse perdue hors périmètre : requested reste
  suspendu/UNOBSERVED. Aucun carnet différent à la reprise ou trou effacé.
- Suite globale : 580 tests modèles, 313 agent et 133 backtest passent ;
  TypeScript, builds dry-run et lint ciblé passent. Le JSON concaténé
  préexistant limitant le lint global est laissé intact.

Accepté pour préparation synthétique locale seulement. Les critères 99 %,
5 s et >2 h ne sont pas retouchés ; aucune collecte ou activation.
