# Revue du modèle EMA_SLOPE (`regime-slope.md`)

## Couverture

| Cas | Couvert par | Statut |
| --- | --- | --- |
| Nominal : pente > seuil / < −seuil / entre | Classification, inégalités strictes | ✅ |
| Warm-up : pente non calculable | *Pending* — compté, historique appendu, aucun garde satisfait | ✅ |
| Erreur : politique invalide | `INVALID_REGIME_POLICY` → `failed` avant toute observation | ✅ |
| Erreur : observation invalide | `INVALID_REGIME_OBSERVATION` → `failed` (inchangé) | ✅ |
| Annulation | `STOP_REQUESTED` → `stopped` depuis warmingUp ou régime | ✅ |
| Changement de régime | Hystérésis v1 inchangée (série opposée ≥ confirmationCount) | ✅ |
| États terminaux | `failed`/`stopped` finaux, aucun recyclage | ✅ |
| Permissions | Carte figée inchangée, deny-by-default | ✅ |
| Rétro-compat | EMA_THRESHOLD ≡ v1 ; IG6 replay sans filtre | ✅ |

## Points de friction identifiés (exigences d'implémentation)

1. **R1 — Pending vs actions v1 (couplage majeur).** En v1,
   `recordWarmingObservation` retourne `{}` quand `raw === null` (code
   défensif mort : une observation valide est toujours classifiable en
   mode threshold). En mode slope, *pending* est un cas vivant pendant les
   `slopePeriods` premières observations. L'implémentation doit appendre
   l'historique et incrémenter `observationCount` **indépendamment** du
   résultat de classification ; seule la mise à jour des séries
   (pending/opposing) dépend du raw. Sinon la référence de pente devient
   obsolète et la classification dérive.
2. **R2 — Pending ne casse ni ne prolonge une série.** Une observation
   *pending* ne met à jour aucune série de confirmation : la série
   précédente est préservée telle quelle. Choix explicite : *pending* =
   absence d'information, pas preuve opposée. Pratiquement inobservable
   (voir R3), mais piné ici pour éviter toute interprétation implicite.
3. **R3 — Pending est un phénomène de warm-up uniquement.** L'historique
   croît strictement jusqu'à son plafond puis y reste : dès l'observation
   `slopePeriods + 1`, la classification est toujours calculable. Entrée
   de régime effective au plus tôt à
   `max(minObservations, slopePeriods + 1) + (confirmationCount − 1)`
   observations valides.
4. **R4 — Cohérence de l'anneau.** À l'observation k, la référence est
   `emaSlowHistory[0]` = valeur de l'observation `k − slopePeriods`.
   Vérifié par simulation (`slopePeriods = 2`, séquences o1..o4) : append
   puis tronque aux `slopePeriods` dernières valeurs.
5. **R5 — Division sûre.** `emaSlow > 0` garanti par la validation
   d'observation ; le ratio est toujours fini.
6. **R6 — Union discriminée, pas de champs optionnels.** Le mode est un
   tag explicite ; `isValidRegimeFilterPolicy` valide les champs du mode
   déclaré et refuse tout mode inconnu. Interdiction d'un mode implicite
   déduit de la présence de champs (règle : pas de transition implicite).

## CLI (contrat)

- `--regime-filter EMA_THRESHOLD|EMA_SLOPE|NONE` ; flags optionnels
  mutuellement exclusifs par mode (`--regime-threshold-bps` vs
  `--regime-slope-bps` + `--regime-slope-periods`).
- Suffixe d'artefact distinct par mode pour éviter toute collision de
  noms de fichiers.
- Défauts EMA_SLOPE : `slopeThresholdBps = 200`, `slopePeriods = 10`
  (EMA 26 daily ; ordre de grandeur des jambes de tendance BTC vs
  consolidations). À confronter aux mesures en Verify — seul un
  balayage peut arbitrer.

## Décision

Modèle validé. Aucun bloceur. Risques acceptés :

- **RA1** (moyen) : R1 touche trois actions partagées par les deux modes —
  les tests v1 (170) doivent rester verts sans modification sémantique ;
  seule la construction des politiques de test devient taguée `mode`.
- **RA2** (faible) : le warm-up effectif s'allonge (`slopePeriods + 1`
  bougies de plus en deny-by-default) — conforme au deny-par-défaut,
  mesurable en Verify.

## Mesures Verify ( BTC-USD ONE_DAY, protective 300/600, ensemble)

### Transitions et invariants (models, 185 tests verts)

- Pending observé en warm-up uniquement (R3) : 12 jours slope 200/10,
  4 jours threshold (minObservations=5 + confirmation 3) — cohérent avec
  l'entrée au plus tôt `max(minObs, slopePeriods+1)+(conf−1)`.
- Historique borné à `slopePeriods` (R4), aucun crash machine, 0
  classification en régime (post-warm-up) — conforme à I13.
- CLI : flags slope mutuellement exclusifs avec threshold, suffixe
  `-regime-slope-200-10-5-3`, runId distinct.

### Distribution des régimes (script scripts/regime-days.ts)

| Fenêtre | Politique | BULLISH | RANGE | BEARISH |
|---|---|---|---|---|
| bull 2023-08→2024-08 | threshold 100 | 59 % | 19 % | 21 % |
| bull 2023-08→2024-08 | slope 200/10 | 53 % | 25 % | 19 % |
| bear 2025-08→2026-08 | slope 200/10 | 14 % | 43 % | 39 % |

**Hypothèse initiale infirmée** : EMA_THRESHOLD ne classe pas l'année bull
en BEARISH — il y est BULLISH 59 % du temps ; le « final BEARISH » observé
précédemment vient uniquement de la fin de fenêtre (drawdown été 2024),
comportement correct du modèle. Les deux modes produisent des
distributions comparables sur l'année bull.

### Économie (return ensemble, même fenêtres)

| Politique | bull 23-24 | bear 25-26 | somme |
|---|---|---|---|
| baseline (sans filtre) | −0,38 % | +3,70 % | +3,32 % |
| EMA_THRESHOLD 100 | −0,17 % | +3,63 % | +3,46 % |
| EMA_SLOPE 100/10 | −0,64 % | — | — |
| EMA_SLOPE 200/10 | **+0,02 %** | +2,86 % | +2,88 % |
| EMA_SLOPE 300/10 | −0,33 % | +2,86 % | +2,53 % |
| EMA_SLOPE 200/20 | −1,29 % | +2,58 % | +1,29 % |

### Conclusion Verify

- Le mode EMA_SLOPE est **conforme au modèle** (transitions, pending,
  bornes, hystérésis) et ses défauts 200/10 sont confirmés comme
  raisonnables.
- Aucune configuration ne domine : slope 200/10 est la seule à rendre
  l'année bull positive, mais coûte ~0,8 pt sur l'année bear (il filtre
  les rallyes haussiers d'un marché baissier où rsi-reversion gagnait).
- Décision : **EMA_THRESHOLD reste le défaut de gating** ; EMA_SLOPE est
  disponible pour exploration. Le gain de win rate ne viendra pas de la
  détection de régime mais de l'alpha du portefeuille en année bull
  (tout est à −125 pt d'excès vs buy-and-hold).
