# Revue du modèle — portefeuille multi-produits (DAO #24)

## Couverture

| Cas | Comportement attendu | Décision |
| --- | --- | --- |
| Config mono-produit legacy | forme, valeurs, admissions et sérialisation strictement identiques (INV-P6) | Couvert |
| Config `products[]` à 1 élément | normalisée vers la forme legacy par le même pipeline (INV-P6) | Couvert |
| Config `products[]` + `productId` | rejet `INVALID_CONFIGURATION` | Couvert |
| Config multi-produits N ≥ 2 sans `portfolioRisk` | rejet `INVALID_CONFIGURATION` | Couvert |
| Config multi-produits N ≥ 2 avec `risk` top-level | rejet `INVALID_CONFIGURATION` (budget par produit uniquement) | Couvert |
| Config multi-produits live/perp | rejet fail-closed `MULTI_PRODUCT_LIVE_UNSUPPORTED` (INV-P7) | Couvert |
| Porte runtime face à une config multi-produits | rejet `MULTI_PRODUCT_UNSUPPORTED` tant que le branchement n'existe pas | Couvert |
| Somme des expositions ≤ plafond consolidé | admissions par produit puis consolidées | Couvert |
| Somme dépassant le plafond consolidé | le ou les produits en excès rejetés `CONSOLIDATED_GROSS_EXPOSURE_LIMIT`, premier en ordre trié servi (INV-P1, INV-P4) | Couvert |
| Ordre qui réduit l'exposition sur portefeuille plafonné | admis (dérisquer jamais bloqué, INV-P1) | Couvert |
| Perte quotidienne consolidée atteinte | tous les produits rejetés `CONSOLIDATED_DAILY_LOSS_LIMIT` (INV-P2) | Couvert |
| Produit rejeté ou arrêté localement | les autres produits non affectés (INV-P3) | Couvert |
| Produit sans ordre proposé | contribue son socle d'exposition, statut `NO_ORDER` | Couvert |
| Ordre déterministe | produits triés, sommes sur clés triées, adjudication pure de l'historique (INV-P4) | Couvert |
| Entrée machine invalide (doublon, liste vide, limites non positives) | état `rejected` fail-closed | Couvert |
| Kill switch portefeuille | `draining` : plus aucune admission, quiescence puis `halted` | Couvert |
| Backtest multi-produits, plafond consolidé dépassé | rejet consolidé visible dans les décisions, aucun ordre en excès exécuté (INV-P8) | Couvert |
| Backtest multi-produits, quiescence | un produit sans signaux n'empêche pas le trading des autres | Couvert |
| Backtest séries désalignées | erreur `MISALIGNED_PRODUCT_CANDLES`, aucun rejeu partiel | Couvert |
| Rejeu identique | mêmes décisions et mêmes trades (déterminisme, INV-P4) | Couvert |

## Contraintes de mise en œuvre

- `checkRisk`, l'allocateur et le courtier paper existants sont consommés tels
  quels ; aucune sémantique mono-produit n'est modifiée (INV-P6, C2).
- L'union `RiskReasonCode` de `@dodash/risk` n'est pas étendue : les codes
  consolidés vivent dans une union dédiée, pour ne pas casser le verrou
  miroir de `models/backtest-diagnostics.types.ts`.
- Les sommes consolidées itèrent des clés triées ; aucun compteur global, ni
  horloge, ni I/O dans le cœur pur (C3).
- La porte runtime est un refus explicite, jamais un acheminement silencieux
  d'une config multi-produits vers l'interpréteur mono-produit.
- Toute admission consolidée est une garde de machine ou une fonction pure ;
  un LLM/effet ne produit que des signaux (INV-P5, règle d'architecture).
- La machine ne porte ni prix ni ordre ; seuls des notionals rapportés par
  les effets alimentent les gardes.

## Avis de revue

Le modèle sépare proprement les deux étages de risque (produit, portefeuille)
et fixe les trois invariants contractuels du brief : plafond consolidé,
quiescence par produit, ordre déterministe. La décision C1 est honnête : le
cœur pur livré est complet et testé, le branchement runtime est spécifié au
§9 pour son propre passage Model → Review → Implement → Verify, et aucune
portion de branchement non testée n'est livrée. La rétrocompatibilité
mono-produit est garantie par construction (normalisation par le pipeline
legacy existant) et vérifiable par égalité stricte. Rien à redire : modèle
approuvé pour implémentation.
