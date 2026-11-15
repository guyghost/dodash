# Revue préalable — registre P7 local

**Accepté pour implémentation/tests locaux uniquement**, dans le périmètre
de préparation approuvé. Pas de collecte ou de choix du backend distant.

- Une issue et son portefeuille vivent dans un événement transactionnel ;
  impossible de publier uniquement le fill ou uniquement son débit.
- Déduplication avant toute transition : une réponse perdue après commit
  retourne le reçu original. Collision de contenu sous même ID = conflit.
- REQUEST_QUOTE durable avant I/O : une réponse non persistée n'est pas
  remplacée par un nouveau prix à la reprise. Limite réseau explicitée.
- Versions de portefeuille + un intent en vol par produit : pas de double
  consommation du cash ; BTC/ETH séparés.
- Machine XState et gardes dans models ; SQLite orchestre seulement la
  transaction/hash/I/O. Aucun état de trading ou signal venant d'un LLM.
- Limites : fait de fill simulé, pricer/VWAP encore absent ; snapshots et
  autorisations de démarrage non implémentés ; chaînes de hash non signées.

Vérification requise avant livraison : tests purs et vraie persistance SQLite,
rollback/réouverture, réponse perdue après commit, preuve perdue avant quote,
conflits, invariants de balances et export revalidé. Les résultats synthétiques
ne seront jamais archivés comme observations prospectives.

## Revue de l'implémentation / Verify

- Correctness : XState contrôle les phases, gardes pures contrôlent dates,
  version, quantité et équations du fill. Même réponse ne peut être enregistrée
  deux fois ; même slot terminal ne peut être résolu sous un nouvel ID.
- Architecture : aucun I/O/clock/crypto dans le core. SQLite sérialise les
  writes, calcule les hashes et appelle le modèle, sans décider de pricing.
- Security : champs de commandes/manifest fermés, raisons codées, JSON fini
  borné, SHA et chaîne revalidés à chaque lecture. Refus des bases SQLite
  étrangères ; aucun secret, callback sérialisé ou endpoint réseau.
  `bodySha256` est une référence déclarée au futur payload amont : seul son
  format est validé ici. La chaîne garantit l'intégrité du contenu normalisé
  inscrit, pas l'authenticité de sa source ni le lien à une capture externe.
- Performance : replay complet pour les tests locaux ; pas un adaptateur
  Worker optimisé. Les payloads de quote ne restent pas dans la projection
  de slot, mais figurent dans le journal. Backend/exports externes non choisis.
- 12 tests purs passent et 11 tests SQLite passent, dont vraie sortie de
  processus enfant avant/après COMMIT, double connexion, réouverture,
  déduplication après expiration, refus des mutations et hash corrompu.
- Suite globale : 550 tests modèles, 313 agent et 133 backtest passent.
  TypeScript, build global dry-run et lint ciblé passent. Les bases de test
  restent dans des répertoires temporaires, jamais dans le dépôt ou le bot.

Deux chemins clarifiés par des tests RED : une réponse non observée requiert
le motif explicite `QUOTE_RESPONSE_UNOBSERVED` pour être clôturée ; une quote
invalide donne `REJECT_INVALID_QUOTE`, jamais une instruction de repricing.

**Accepté comme registre synthétique local uniquement.** VWAP, slippage 2 bps,
risque, collecte réelle, autorisation de démarrage, marks et benchmarks ne
sont pas validés par ce store. La campagne reste non démarrable.
