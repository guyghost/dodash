# Marks horaires conjoints P7/B&H — préparation synthétique locale

## Model

V8 est un opt-in local explicite via `applyJointMark`, avant REQUEST/I/O.
Les phases XState horaires existantes expected → requested → observed restent
la source de vérité. EXPECT V8 active durablement le mode conjoint ; tous les
marks suivants passent par V8. Les reçus anciens restent inchangés, sans backfill.
Entrées B&H V7 indépendantes requises avant EXPECT V8 ; pas de fallback legacy.

OBSERVE V8 conserve atomiquement le mark P7 et un mark B&H calculé depuis les
portefeuilles V7 relus sous verrou, sur les mêmes books, requestedAt et asOf.
Une jambe non initialisée est UNAVAILABLE (jamais cash fictif), un slot sans
réponse UNOBSERVED. Quantités/cash/fills ne sont pas modifiés. La preuve source
reste dans la commande commune. Séquences B&H sont monotones indépendamment
des séquences P7 cash, et prennent en compte les carnets d'entrée V7.
Les checks pré-COMMIT couvrent la fraîcheur des deux trajectoires.

Sûreté : après opt-in V8, gap historique >2 h P7 **ou** B&H suspend le harnais,
y compris nouvelle intention/requête, pricing P7 et entrée B&H. Suspension sticky,
marks diagnostiques permis, aucune reprise automatique. DD >50 % reste le
critère P7 gelé : un DD B&H ne déclenche pas à lui seul l'arrêt P7.
La couverture B&H est calculée depuis les 4 320 slots calendaires ; aucun
mark antérieur V3 n'est promu rétroactivement en preuve B&H.

## Review préalable

Accepté pour implémentation locale : réutiliser le modèle horaire et la garde
existants, mais garder deux couvertures distinctes. Ne pas comparer/sommer
les equities de deux stratégies. Replay V1–V7 inchangé jusqu'au premier V8.
Récupération d'une réponse V8 perdue suit REQUEST_MARK → SUSPEND explicite.
Hash déclaré non authentifiant ; aucune API réseau, migration distante,
déploiement, activation réelle, timer ou seuil ajusté.

## Verify attendu / limites

Tests cash P7 sans preuve B&H, portefeuilles figés, checkpoint et séquences,
initialisation absente, fraîcheur pré-COMMIT, reprise/idempotence/atomicité,
gap historique sticky et non-contournement V3 après V8. Les marks after-fill
et final, assesseur J30/J90/J180, qualification économique et exports distants
restent hors de cet incrément ; campagne toujours non démarrable.

## Review / Verify de livraison

- 10 nouveaux tests SQLite/broker passent : cash P7 vs trou B&H, snapshot sans
  débit, DD B&H seul sans arrêt P7, séquence d'entrée régressive, checkpoint
  différent, absence d'initialisation, anti-backfill, récupération explicite,
  idempotence avant horloge, crash processus avant/après COMMIT et rollback
  de fraîcheur B&H. 84 tests Node prospectifs locaux passent au total.
- Suite globale : 603 modèles, 313 agent, 133 backtest ; TypeScript et builds
  dry-run passent. Lint ciblé passe, lint global non revendiqué (JSON concaténé
  préexistant). Fichiers utilisateurs préexistants laissés intacts.
- Correctness : reçus V8 recalculés au replay, fenêtre et âge vérifiés pour
  chaque trajectoire avant insertion et avant COMMIT. `markCheckedAt` n'est
  toujours pas une preuve de fin du flush disque. Aucun nouveau fill effectué
  par un mark ; pas d'interpolation ni reprise sticky automatique.
- Architecture/lisibilité : core pur réutilise XState horaire, shell SQLite
  reste propriétaire de l'I/O. Garde commune utilisée aux intentions, pricing
  et benchmark ; aucune décision LLM, nouvelle dépendance ou changement bot.
- Sécurité/performance : validations fermées existantes et journal borné ;
  deux snapshots augmentent la taille/replay locaux, sans benchmark distant
  de coût à 180 jours. Hashes déclarés non authentifiants. Les portefeuilles
  internes à zéro d'une jambe absente ne donnent jamais une equity disponible.
- Limite explicite : un registre V7 sans opt-in V8 reste un ancien prototype
  de replay ; il ne revendique pas cette sûreté conjointe. Le futur préflight
  réel devra exiger V8 avant les I/O horaires, ainsi que les autres gates.
