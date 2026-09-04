# Revue du modèle de persistance des fills perp (dao #31)

Verdict : **APPROUVÉ** (0 bloqueur ouvert).
Modèle : `hyperliquid-fill-persistence.md`

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Ordre accepté, fill complet | fills lus (`userFills` par `cloid`) et persistés avant l'issue ; `settled` inchangé | Testé |
| Ordre accepté, fill partiel (IOC partiel puis annulé) | le seul fill venue est persisté avec sa quantité réelle ; PnL sur la quantité réelle | Testé |
| Ordre accepté, aucun fill | lecture `[]` → aucune ligne inventée | Testé |
| Lecture venue indisponible | `PERP_FILLS_UNAVAILABLE` + compteur ; l'issue est quand même persistée, `settled` | Testé |
| Écriture SQLite refusée | `PERP_FILL_PERSIST_FAILED` + compteur ; jamais un échec de cycle (C3) | Testé |
| Issue rejetée (`REJECTED`) | aucune lecture, aucune ligne de fill (INV 9) | Testé |
| Re-réconciliation du même ordre | `INSERT OR IGNORE` sur `(client_order_id, fill_id)` : zéro doublon | Testé |
| Reprise après crash (intention en vol) | fills persistés lors de la réconciliation de reprise, même port | Testé |
| Fill venue malformé (champ hors domaine) | lecture entière rejetée (`null`), zéro écrit, compteur (INV-F2) | Testé |
| Store SQLite reçoit un fill mal formé | rejet typé à la frontière, aucune écriture partielle | Testé |
| Lignes `dodash_perp_orders` préexistantes | jamais modifiées : fills insert-only, migration additive (INV 3, C1) | Testé |
| Cycles perp préexistants sans fills | mêmes résultats `SETTLED`/`REFUSED`/`FAILED`, même réconciliation (non-régression) | Testé |
| Machine XState | aucun état, événement ou transition ajouté ou modifié (C2) | Testé (machine inchangée) |
| Projection : fenêtre bornée | `LIMIT N`, `N ∈ [1,50]`, défaut 30 ; fills hors fenêtre ignorés | Testé |
| Projection : PnL par fill | `closedPnl − fee`, sommes chronologiques traçables aux enregistrements bruts | Testé |
| Projection : ligne malformée | échec typé global, aucune projection partielle (INV 8) | Testé |
| Projection : ordre sans fill | absence projetée, jamais un zéro | Testé |
| Secrets dans `fill_json`/projection/logs | impossibles : type fermé sans adresse, hash ni signature (INV 4) | Testé |
| Compteur `fillPersistenceFailures` | signal de sortie only : aucune transition n'en dépend (INV 10, `trading-telemetry.md`) | Testé |
| Projection spot `dashboard-pnl-history` | projection parallèle : zéro changement, zéro régression | Testé (suite existante) |

Décisions de revue :

- **Table dédiée** retenue contre l'extension de `dodash_perp_orders` : un
  blob JSON réécrit à chaque fill serait une rétroécriture de ligne
  existante ; la table dédiée rend la migration purement additive et
  l'idempotence structurelle.
- **Deux effets enrichis** (réconciliation et persistance d'une issue
  ACCEPTED) au lieu d'un seul : sans le second, le chemin nominal
  `SUBMIT_ACCEPTED` — le plus fréquent — ne persisterait jamais de fill et
  le PnL perp resterait vide. Aucun nouvel état ni événement : la machine
  reste l'unique arbitre.
- **`closedPnl` venue** retenu contre toute reconstitution locale du PnL :
  la mécanique de position perp n'est pas dupliquée ; chaque chiffre exposé
  reste traçable à un enregistrement brut daté.
- **Pas de retry de la lecture fills** : une lecture ratée laisse des fills
  absents (fait absent), le backfill est un jalon séparé à modeler — la
  revue refuse un backfill implicite non spécifié.

La machine ne sait pas que les fills existent : le shell lit, le store
écrit, la projection lit. Aucun LLM, aucune télémétrie décisionnelle.

## Amendement dao #33 — rattrapage borné des fills manqués (2026-09-04)

Verdict : **APPROUVÉ** (0 bloqueur ouvert). Le modèle initial refusait un
backfill implicite non spécifié ; l'amendement le spécifie fermé avant toute
implémentation — c'est cette spécification qui lève le refus, pas le code.
Invariants 1–10 inchangés ; invariants 11–12 ajoutés.

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Créneau détecté (`ACCEPTED` sans fill), la venue connaît le fill | fills relus (couture #31/#27) et persistés, `fillBackfillFilled` | Testé |
| Venue sans données (`[]`) | aucune ligne inventée (INV 9), créneau reporté, `fillBackfillUnresolved` | Testé |
| Plafond atteint (cap + 1 créneaux) | au plus 10 créneaux relus, `fillBackfillTruncated`, reste reporté au cycle suivant | Testé |
| Re-réconciliation après rattrapage | `INSERT OR IGNORE` : zéro doublon, le créneau comblé sort de la détection | Testé |
| Ordre `ACCEPTED` ayant déjà un fill | jamais considéré créneau, jamais réécrit (INV 3) | Testé |
| Échec de lecture/écriture pendant le rattrapage | log fermé + `fillBackfillFailures`, réconciliation et cycle inchangés (INV 12, C3) | Testé |
| Ordres en vol | `recovered`/`unresolved` inchangés par le rattrapage | Testé |
| Machine XState | aucun état, événement ou transition nouveau (INV 6, C2) | Testé (machine inchangée) |
| Détection | `SELECT` lecture-seul `NOT EXISTS` + `LIMIT`, ordre déterministe `settled_at DESC, client_order_id DESC` (INV 11) | Testé |
| Schéma | aucune migration nouvelle : tables et lignes existantes intactes (C1) | Testé (suite existante) |

Décisions de revue de l'amendement :

- **Plafond = 10 créneaux/cycle** : chaque créneau coûte au plus une
  lecture venue plafonnée (1 MiB, timeout, erreurs fermées) ; 10 borne le
  surcoût d'un cycle de reprise à un ordre de grandeur sous la fenêtre de
  projection (50), et la répétition cyclique couvre le reste, récemment
  réglé d'abord. Pas de compteur d'essais ni de table « déjà tenté » : ce
  serait un état nouveau non modélisé ; le plafond par cycle suffit à borner
  le coût d'un créneau légitimement vide (IOC jamais exécuté) re-relu à
  chaque reprise.
- **Ordre déterministe le plus récemment réglé d'abord** (`settled_at DESC`,
  `client_order_id DESC`) : aligné sur la fenêtre de projection §4 dont la
  fidélité bénéficie en premier ; les créneaux anciens sont servis par
  érosion cyclique, jamais au détriment des créneaux récents.
- **Couture `userFills` inchangée** : pas de `userFillsByTime` dans cet
  amendement ; un fill plus vieux que l'historique récent de la venue reste
  non rattrapable — limite documentée au §2.5, jamais approximée.
- **Détection dérivée, pas stockée** : un créneau est calculé par `NOT
  EXISTS` à chaque cycle de reprise ; aucune table, colonne ou migration
  nouvelle (C1 inchangé), aucun état machine (C2), aucun échec de cycle
  (C3 étendu, INV 12).
