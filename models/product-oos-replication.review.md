# Review — H-D1 Réplication OOS de V1 sur produits jamais consultés

Statut : APPROUVÉ AVEC CORRECTIONS (textuelles — intégrées au modèle)
Date : 2026-08-26
Modèle : `models/product-oos-replication.md`

Référents vérifiés : `signal-edge-inventory.md` §5.1, `production-launch.md`
§Porte 1, `live-trading-policy.md`, `strategy-permission.md` §6/§8/§11,
`regime-aware-selector.md`, `docs/operations/production-readiness-2026-08-24.md`,
`packages/backtest/src/coinbase-history.ts`, artefacts `.artifacts/studies/`
et `.artifacts/backtests/`, OpenAPI Coinbase `list-public-products`.

## Checklist

### Non-contamination de la découverte (§2.2)
- [x] Sonde 5/5 : uniquement présence/absence, aucun OHLCV exploité.
- [x] `volume_24h` en tie-break tiers, pas critère principal.
- [x] Séquence sonde → gel → campagne étanche (INV-R2).
- [ ] Formulation « aucune métrique économique » contredite par la lecture
      de `volume_24h` → reformulée (correction 1).
- [ ] `volume_24h` en devise de base, pas USD → note ajoutée (correction 2).
- [ ] Tri primaire `fenêtres desc` = signal de survie indirect → limite
      ajoutée (correction 3).

### Cohérence avec les référents
- [x] 20 produits consultés — exhaustifs contre les artefacts, vérifiés
      caractère par caractère (19 études + 3 runs V1).
- [x] G1/G2/G3/G4/G5/G6 ↔ conditions 2-7 de la Porte 1 — fidèles.
- [x] Allowlist live intégralement contaminée — affirmation VRAIE.
- [x] Contamination POWER_THIRD GRT/MANA/XTZ/ZEC confirmée (readiness).
- [x] Baselines V1 INV-R5 correctement calquées (§6 strategy-permission).
- [ ] Couche verdict global absente de production-launch → écart désormais
      noté explicitement (correction 4).
- [ ] G2 « ≥ 3/4 » ambigu pour > 4 folds → compte fixe 3 précisé
      (correction 5).

### Listes d'exclusion (§2.1)
- [x] Stablecoins et empaquetés raisonnables, append-only bien posé.
- [ ] LEO n'est pas un stablecoin → retiré, note ajoutée (correction 6).

### Lecture « fold = fenêtre annuelle » (§3)
- [x] OOS propre par construction, pas de train, transfert assumé —
      compatible et plus strict que production-launch.

### Critères et invariants
- [x] G1-G6 falsifiables, non ajustables ; lien K1 cohérent.
- [ ] Seuil ≥ 2/4 insuffisamment justifié → justification explicite
      ajoutée (correction 7).
- [x] INV-R1..R6 vérifiables mécaniquement ; INV-R5 bon contrôle.

### Implémentabilité
- [x] Endpoint et sonde compatibles avec `coinbase-history.ts`.
- [ ] `volume_24h` est un string API → note d'implémentation ajoutée
      (correction 8).
- [ ] `product_type=SPOT` non spécifié → ajouté (correction 9).
- [ ] Pagination non mentionnée → note ajoutée (correction 10).

### Style maison
- [x] Français, statut SPÉCIFIÉ, invariants, §8 à compléter, hors
      périmètre.

## Corrections demandées (toutes appliquées au modèle)

1. §2.2 : « aucune métrique économique » reformulé en « aucune métrique de
   performance/rendement/signal » ; `volume_24h` explicitement reconnu
   comme champ de liquidité instantané.
2. §2.3 : note `volume_24h` en devise de base (vs
   `approximate_quote_24h_volume` USD) ; biais accepté, tie-break tiers.
3. §6 : « fenêtres comme proxy de survie » — le tri primaire est un
   critère de survie indirect, gonfle l'edge apparent ; négatif malgré le
   biais = d'autant plus concluant.
4. §4 : écart noté — la condition pool inter-produits est un ajout H-D1,
   plus stricte que production-launch (par produit).
5. §4 G2 : compte fixe 3 (miroir exact condition 3), non ratio.
6. §2.1 : LEO retiré des stablecoins (token utilitaire, pas de peg).
7. §4 : justification explicite du seuil ≥ 2/4 (majorité de l'allowlist
   cible, déclencheur K1).
8. §2.2 : note d'implémentation — `volume_24h` en string, parser avant tri.
9. §2.2 : `product_type=SPOT` spécifié sur l'endpoint.
10. §2.2 : pagination itérée jusqu'à épuisement.

## Risques résiduels assumés

- Biais de survie irréductible (API publique) : un positif est un majorant
  de l'edge réel ; un négatif est renforcé.
- Politique calibrée sur BTC : transfert mesuré, pas optimalité locale.
- Coûts 6+2 bps homogènes non vérifiés par spread réel (porte 8 hors
  périmètre ; un VALIDÉ ne déploie rien).
- `volume_24h` base-currency comme tie-break : impact limité (tiers).
