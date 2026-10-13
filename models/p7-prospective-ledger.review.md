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
