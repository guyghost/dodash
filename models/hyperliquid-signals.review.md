# Revue du modèle signaux perp

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Produit configuré hors miroir (`SOL-USD`) | refus `PERP_PRODUCT_NOT_ALLOWED` | Testé |
| Champ de risque différent de l'enveloppe | refus `PERP_POLICY_MISMATCH` | Testé |
| Défauts forcés (timeframe, intervalle, risque) | identiques à l'enveloppe figée | Testé |
| Admission perp non approuvée au démarrage | refus, aucun `START_REQUESTED` | Testé |
| Flag ou secrets absents | `HYPERLIQUID_EXECUTION_UNAVAILABLE`, boucle non démarrée | Testé |
| Conversion d'intention | mapping produit, quantité arrondie vers zéro, levier 1 | Testé |
| Quantité sous un incrément | abandon en amont (résultat zéro) | Testé |
| Bougies périmées | rejet hérité du cycle (une décision par bougie) | Couvert par le cycle |
| Coupe-circuit journalier | référence jour de l'Agent, refus `PERP_DAILY_LOSS_BREACHED` | Testé (contrôle) |
| Position réelle déjà ouverte | garde lue sur clearinghouseState, ouverture refusée si plafond | Testé (contrôle) |
| Kill switch en mode perp | arrêt de boucle sans appel Coinbase | Testé |
| Credentials croisées (spot live ↔ perp) | chaînes disjointes : l'une n'active pas l'autre | Testé |
| Compte Hyperliquid illisible au moment de l'ordre | refus `PERP_ACCOUNT_UNAVAILABLE`, aucun ordre | Testé (contrôle) |
| Dérive portefeuille virtuel vs position réelle | seule la garde réelle peut refuser ; jamais autoriser un faux ordre | Modélisé |
| Double démarrage d'instance perp | nom canonique d'Agent inchangé, un DO par produit | Couvert par le DO |
| Échec de soumission inconnu | réconciliation par cloid héritée du runner | Testé (runner) |

Le cœur métier n'est pas dupliqué : la venue est une couture d'effets et
`tradingCycleMachine` orchestre les instances perp comme les instances
spot, avec les mêmes invariants de fraîcheur, d'unicité de décision et de
persistance.
