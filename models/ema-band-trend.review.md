# Review — H-T1 ema-band-trend : le signal de bande de régime comme stratégie

Statut : APPROUVÉ
Date : 2026-08-28
Modèle : `models/ema-band-trend.md`

Revue humaine (décision du propriétaire du dépôt, consignée) sur les
quatre points soumis, sans correction requise.

## Checklist

### Écart assumé §3 — franchissement de bande brute vs confirmation 5/3
- [x] Validé. La confirmation exige un état interne, non implémentable
      dans une stratégie pure sans dupliquer la machine de régime dans
      une seconde source de vérité. La forme candidate est le
      franchissement strict ±100 bps ; l'écart est consigné avant toute
      mesure ; aucune variante « confirmée » dans ce cycle.

### Exits NONE vs exits V1
- [x] Validé. La sortie est le signal ; surmonter les exits protectifs
      V1 (calibrés pour les positions courtes de rsi-reversion)
      préempterait la sortie propre du candidat et répliquerait les
      confondus d'interaction documentés (`regime-exit-v3.md` §5).
      Sécurité reportée sur : exposition bornée (~1 000 $ / 10 000 $),
      permission déniée en warm-up, porte G6.

### Solo sans ensemble
- [x] Validé. L'attribution propre prime : l'ensemble V1 transfère
      négativement (H-D1 0/4) et confondrait la lecture. L'intégration
      (remplacement de rsi-reversion, etc.) est verrouillée §8 — un
      cycle ultérieur à son propre pré-enregistrement.

### Seuils de verdict
- [x] Validés. Portes G1-G6 miroir exact H-D1 (aucune réécrite pour le
      candidat) ; ≥ 2/4 produits ∧ pool médiane > 0 ∧ PF > 1 ;
      EFF1 ≥ 8 trades clôturés poolés sinon campagne invalide ; INV-T7
      BTC bit-exact (tol 5e-5), jamais lu économiquement pour le
      candidat.

## Conséquence

L'implémentation peut procéder : `packages/strategies/src/ema-band-trend.ts`,
export, tests unitaires, `packages/backtest/scripts/ema-band-trend-oos.ts`,
puis campagne (une exécution) et complétion §12 du modèle.
