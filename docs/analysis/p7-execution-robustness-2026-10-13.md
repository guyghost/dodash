# P7 — robustesse aux coûts et à l'open suivant, 13 octobre 2026

## Verdict

**`SENSITIVE_TO_ASSUMPTIONS` : P7 ne respecte pas la contrainte de drawdown
dans tous les scénarios préenregistrés.** L'open suivant avec les coûts
actuels reste proche de la référence. Le scénario 60 bps de frais + 50 bps
de slippage n'a plus que **0,57 point** de marge sous 50 %. Les deux scénarios
à 120 bps de frais dépassent 50 %, malgré un rendement historique positif.

Pas de retouche de P7, de seuil ou de scénario après lecture. Pas d'OOS, de
preuve de rendement futur, de validation live ni d'activation paper.

## Protocole et provenance

- Protocole approuvé puis commité **avant calcul** : `64806af`,
  `models/p7-execution-robustness.md`. Six scénarios, aucun classement optimisé.
- Replay et tests : `6454c6c`. Premier lancement bloqué par la validation des
  données, avant tout replay économique : ETH annonce deux bougies comblées.
- Amendement de provenance explicitement approuvé puis commité avant résultat :
  **`07e7291`**. Même archive que la référence, BTC 0/4 090 bougies comblées,
  ETH **2/3 787** (0,053 %). Pas de nouveau remplissage ou retrait de jour.
  Les tuples ne conservent pas le flag individuel : les dates des deux lignes
  ne sont pas prétendues identifiées ; leurs opens peuvent être synthétiques.
- Jobs daily-long archivés, SHA-256 de fichiers vérifiés avant parsing.
  BTC depuis 2015-07-21, ETH depuis 2016-05-19, dernière bougie 2026-09-30.
- Capital **20 000 $**, soit 10 000 $ par créneau indépendant, ETH en cash
  avant sa cotation. Fenêtres identiques à la campagne historique ; aucun reset
  du portefeuille entre fenêtres. Valeur finale marquée au close, non liquidée.
- Fonctions existantes réutilisées : `planTargetExposure`, gardes de risque,
  `checkRisk` et `executePaperOrder`. Assesseur et transitions dans `models/`.

## Les six résultats, frais et slippage inclus

| ID | Exécution | Frais / slippage bps | CAGR historique | DD maximal global | Plus grand DD de fenêtre | Verdict |
|---|---|---|---:|---:|---:|---|
| C0 | close du signal | 60 / 2 | 50,40 % | 47,17 % | 35,20 % | dans la contrainte |
| O0 | open suivant | 60 / 2 | 50,57 % | 47,14 % | 35,16 % | dans la contrainte |
| O1 | open suivant | 60 / 10 | 49,86 % | 47,53 % | 35,36 % | dans la contrainte |
| O2 | open suivant | 60 / 50 | 46,53 % | 49,43 % | 36,32 % | dans la contrainte, marge faible |
| O3 | open suivant | 120 / 10 | 44,95 % | **50,36 %** | 36,79 % | hors contrainte |
| O4 | open suivant | 120 / 50 | 41,84 % | **52,19 %** | 37,73 % | hors contrainte |

C0 reproduit le test de cohérence existant : capital final
**1 929 659,86 $**, 624 fills, 80 achats bloqués par risque, zéro vente rejetée.
Les différences de CAGR et capital final avec ce test sont au bruit flottant.
Il ne faut pas comparer C0 au simulateur originel 50/50 rééquilibré comme
s'ils étaient identiques : les créneaux runtime restent indépendants.

Les cinq fenêtres prises séparément restent sous 50 % ; O3/O4 échouent sur
le drawdown **global**, dont le pic et le creux peuvent traverser les bornes
des fenêtres. Le CAGR élevé d'une décennie connue ne neutralise pas cet échec.
W2 (2018–2019) reste négative dans tous les scénarios.

### Coûts et refus conservés

| ID | Fills | Achats bloqués risque | Refus cash broker | Frais cumulés $ | Slippage cumulé $ |
|---|---:|---:|---:|---:|---:|
| C0 | 624 | 80 | 0 | 325 337,55 | 10 844,60 |
| O0 | 624 | 88 | 19 | 328 580,19 | 10 952,69 |
| O1 | 625 | 87 | 19 | 316 484,36 | 52 747,74 |
| O2 | 630 | 78 | 20 | 265 753,78 | 221 473,16 |
| O3 | 630 | 77 | 19 | 488 961,65 | 40 747,31 |
| O4 | 629 | 74 | 20 | 414 561,79 | 172 748,26 |

Les 19–20 refus cash sont des résultats : une intention dimensionnée au close
ne peut parfois pas être achetée à l'open suivant avec le cash disponible.
Pas de redimensionnement, fill partiel ou retry de cette intention. La
décision du close suivant peut proposer une nouvelle intention selon P7.
Zéro refus position, zéro vente bloquée par risque et zéro intention finale
non exécutée dans ces six trajectoires particulières (le cas terminal est
testé synthétiquement). Aucun cash ou quantité négatif.

Les dollars de frais ne sont pas comparables à capital constant : des coûts
plus élevés diminuent l'équité et les notionnels futurs. Des frais cumulés
plus bas en O4 qu'en O3 ne rendent pas O4 moins cher.

## Ce que ce test permet, et ce qu'il ne permet pas

1. Le simple passage close→open daily ne détruit pas cette trajectoire ;
   son petit avantage en O0 n'est ni un edge ni une raison de sélectionner
   ce prix comme hypothèse favorable.
2. La marge de sécurité de P7 est faible face aux coûts. Garder les coûts
   réels de la venue comme exigence de mesure prospective, pas les diminuer
   après coup pour obtenir un verdict favorable.
3. L'open suivant est **un proxy optimiste à la frontière du jour**, pas le
   prix reçu/exécutable à 00:01 ou après deux heures de retries. L'archive
   n'a ni minute, spread, carnet, impact, high/low ni trajectoire intraday.
   Les stress de slippage sont conventionnels, non mesurés.
4. Risque paper : perte de bougie et plafonds neutralisés selon le modèle P7.
   Pour une exécution à l'open, cette convention de perte n'est pas une
   réconciliation intraday exacte. Les prix daily ne mesurent pas le DD intraday.
5. Positions finales non liquidées : PnL non réalisé compris, frais de sortie
   terminale et fiscalité exclus. Cash rémunéré à 0 %, pas d'inflation.
6. Même historique déjà sélectionné parmi huit politiques ; BTC/ETH gagnants
   de la décennie et deux bougies ETH synthétiques héritées. Ni indépendance
   statistique ni alpha démontré ; aucun changement des gates live.

**Suite recommandée :** préparer une campagne prospective dont le registre
conserve signal/close, heure d'admission, prix après disponibilité, coût et
refus. Évaluer séparément fiabilité et économie. Le diagnostic fournisseurs
reste autonome ; ce replay ne choisit pas une venue et ne prolonge pas sa fenêtre.

## Vérification et reproduction

- 4 tests modèle (complétude, référence, frontières et XState), 6 tests Node
  (provenance, grille, causalité, refus cash, frais buy/sell, dernier ordre).
- Suite globale : 530 tests modèles, 313 agent, 133 backtest passent ;
  TypeScript, build global dry-run, lint ciblé et scan secrets passent.
- Second replay en répertoire temporaire neuf : **six fichiers de trajectoire
  identiques octet par octet**, même résumé hors horodatage. Sommes frais et
  slippage, dates causales, unicité produit/jour et bilans finaux vérifiés.
- Aucun push, appel réseau de collecte, déploiement ou contrôle du bot dans
  ce lot. Les fichiers utilisateurs préexistants restent intacts.

```sh
pnpm --filter @dodash/backtest build
node --test docs/analysis/p7-execution-robustness.test.mjs
node docs/analysis/p7-execution-robustness-2026-10-13.mjs \
  --output docs/analysis/evidence-p7-execution-robustness-NOUVEAU
```

Le script refuse d'écraser un répertoire existant. Preuves :
`evidence-p7-execution-robustness-2026-10-13/summary.json`, six trajectoires
avec ordres, `sha256.json`, et `verification.json`.
