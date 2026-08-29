# Revue du shell d'exécution Hyperliquid

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Flag perp absent ou faux | `HYPERLIQUID_EXECUTION_UNAVAILABLE`, aucun réglage construit | Testé |
| Clé d'agent malformée (court, non hex) | réglages refusés | Testé |
| Adresse maître malformée | réglages refusés | Testé |
| URL API non https ou avec credentials | réglages refusés | Testé |
| Signature vs SDK de référence | identique (r, s, v) pour même action/nonce/clé | Testé (équivalence) |
| Nonce injecté | le nonce du corps est celui du shell injecté | Testé |
| Prix d'agression achat | au-dessus de la marque, 5 chiffres significatifs | Testé |
| Prix d'agression vente | en dessous de la marque | Testé |
| Taille en chaîne exacte | zéros traînants supprimés, valeur inchangée | Testé |
| `cloid` déterministe | même `clientOrderId` → même `cloid`, format `0x` + 32 hex | Testé |
| Réponse `ok` avec ordre posé | `ACCEPTED` | Testé |
| Réponse `ok` avec ordre exécuté | `ACCEPTED` | Testé |
| Erreur portée par l'ordre individuel | `REJECTED` | Testé |
| Corps `status: "err"` | `REJECTED`, détail en télémétrie seulement | Testé |
| Réseau indisponible / HTTP 500 | `UNKNOWN` | Testé |
| Réponse non JSON ou hors spec | `UNKNOWN` | Testé |
| Réponse > 1 MiB | rejetée, `UNKNOWN` | Testé |
| Timeout de requête | `UNKNOWN` | Testé |
| Réconciliation : ordre exécuté ou posé | résolu `ACCEPTED` | Testé |
| Réconciliation : « never placed » | résolu `REJECTED` | Testé |
| Réconciliation : réponse hors spec | `UNKNOWN` → `RECONCILIATION_FAILED` | Testé |
| `szDecimals` réel ≠ enveloppe | préflight en échec typé | Testé |
| `maxLeverage` réel < enveloppe | préflight en échec typé | Testé |
| Marché absent de la méta | préflight en échec typé | Testé |
| Méta hors spec | préflight en échec | Testé |
| Clé dans le corps de requête | impossible : seul `{ action, nonce, signature }` part | Testé |
| Bundle Worker | aucun import du SDK racine (ws) ; msgpack + ethers purs | Testé au build dry-run |
| Montée de version du schéma SDK | le test d'équivalence casse avant production | Testé (équivalence) |
| Flag spot et flag perp | indépendants ; l'un n'active pas l'autre | Testé |
| Lecture de compte (clearinghouseState) | instantané typé ; positions, exposition et PnL extraits en nombres finis | Testé |
| Compte sans position sur le marché visé | `positionQuantity = 0` | Testé |
| Dérivation de garde avec position existante | own notional déduit de l'exposition totale, bornée à zéro | Testé |
| Positions hors allowlist du compte | incluses dans `otherGross` (conservateur) | Testé |
| Réponse hors spec ou non numérique | refus `PERP_ACCOUNT_UNAVAILABLE`, jamais de zéros substitués | Testé |
| `dailyPnl` jamais inféré | requis de la requête ; ancrage journalier = jalon séparé | Testé |

Le shell ne prend aucune décision d'état : il produit des issues typées
fermées et laisse `hyperliquidPerpOrderMachine` arbitrer. Le détail textuel
des erreurs API ne franchit jamais la frontière de transition.
