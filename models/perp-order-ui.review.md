# Revue du modèle UI d'ordre perp

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Brouillon hors enveloppe (marché, levier > 2, quantité ≤ 0) | refusé avant `confirming`, code fermé | Testé |
| `dailyPnl` absent ou non fini | refusé avant `confirming` | Testé |
| Permissions insuffisantes | refusé avant `confirming` | Testé |
| Double clic pendant `submitting` | non réceptif : une seule soumission | Testé |
| Annulation à la confirmation | retour `form`, brouillon conservé, aucun `clientOrderId` généré | Testé |
| `clientOrderId` avant confirmation | inexistant : généré seulement à `PERP_ORDER_CONFIRMED` | Testé |
| Succès `SETTLED` | issue affichée, brouillon conservé au renvoi au formulaire | Testé |
| Refus serveur (`REFUSED`/`FAILED`) | code fermé affiché, brouillon conservé | Testé |
| Erreur transport | `REQUEST_FAILED` affiché, brouillon conservé | Testé |
| Reset | purge brouillon et issue | Testé |
| Token ou secret dans le contexte | impossible : le type du contexte ne les contient pas | Modélisé (types) |
| Levier borné par l'UI | le sélecteur ne propose que [1, maxLeverage] de l'enveloppe | Testé (garde machine) |

La machine d'UI ne parle à aucun réseau : la soumission est un effet du
shell dashboard via le gateway, et l'Agent reste l'unique décideur.
