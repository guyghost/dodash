# Revue — durabilité du book paper (2026-11-14)

## Couverture

| Cas | Comportement attendu | Décision |
| --- | --- | --- |
| Deploy ou redémarrage DO | book recopié, audit nul (INV-B1) | Couvert |
| `/start` | book recopié, audit nul (INV-B1) | Couvert |
| `RESET` sans `explicit` | refus `RESET_NOT_EXPLICIT`, book non réécrit (INV-B2) | Couvert |
| `RESET` explicite, capital positif | manches à `initialCapital` / quantité 0, audit `portfolio.reset` avant et après (INV-B2) | Couvert |
| Capital de reset non positif | refus `INVALID_BOOK` | Couvert |
| Blob d'état absent | copie durable, jamais un book synthétique à 10 000 $ (INV-B3) | Couvert |
| Blob mémoire déjà commis | la mémoire gagne sur une copie durable plus ancienne (INV-B3) | Couvert |
| Charge utile illisible | `null` / `INVALID_BOOK`, pas un book plat (INV-B4) | Couvert |
| Fonction pure, sans I/O | le shell applique, il n'invente pas un second reset (INV-B5) | Couvert |

## Contraintes de mise en œuvre

- Le cœur est `applyPaperBookCommand` / `paperBookAfterRestart` /
  `parseDurablePaperBook`. Le Durable Object journalise et persiste ; il
  ne choisit pas d'autres montants.
- `CANCELLED` reste l'issue d'un stop (`markCancelled`). Il ne solde pas
  le book. Le correctif ne retire pas cette issue.
- Une restauration invalide désarme (`enabled = false`,
  `portfolioRestoreError`) et conserve la session. Les réveils ne tradent
  pas tant que l'erreur est posée.
- `/reset` est refusé si une manche est encore active. L'opérateur arrête
  d'abord. Le reset qui suit est le seul chemin vers 10 000 $.
- Aucun secret, aucun flag live, aucune migration `new_sqlite_classes`.
  La table `dodash_paper_book` est un `CREATE TABLE IF NOT EXISTS` dans la
  base SQLite déjà attachée à la classe.

## Avis

Le modèle sépare l'annulation de cycle (`CANCELLED`) de la comptabilité
du book, et réserve la remise à zéro à une commande explicite auditée.
L'épinglage de version n'est pas nié : il explique le recyclage
opérationnel ; il n'est pas, à lui seul, la réécriture à 10 000 $. Le
start l'était. Modèle approuvé pour implémentation.
