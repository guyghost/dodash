# Revue préalable — pricing/valorisation P7

Accepté pour implémentation locale selon le protocole gelé ; pas d'activation.

- Quantité fixée avant quote ; pas de remplissage de profondeur absente.
- BUY asks / SELL bids ; spread implicite, slippage/frais appliqués une fois.
- VWAP brut au broker réel, pas de double slippage ; balances utilisées,
  pas de PnL calculé avec un prix moyen absent du ledger.
- Fraîcheur 5 s au moment d'usage, 2 h uniquement pour les décisions/fills.
  Les marks horaires ne simulent pas une intention pour contourner cette garde.
- Cash plat exact distinct d'une quote de marché disponible ; manque de
  profondeur sur position ouverte ferme la valorisation.
- Pure projection de liquidation, aucune écriture ou vente à partir d'un mark.
- Bridge alimenté par la quote déjà persistée et export revalidé ; écriture
  finale et gate de campagne encore séparés, pas de promotion des fixtures V1.

Verify requis : unitaires numériques/temporels, broker réel, registre local,
frais uniques, refus, idempotence et invariants de non-mutation.

## Revue de l'implémentation / Verify

- Correctness : 16 tests purs passent (VWAP, profondeur, bornes 5 s/2 h/T1,
  marks horaires, disponibilité et consolidation). 6 tests bridge passent
  avec vrai broker et SQLite : BUY/SELL, frais/slippage uniques, refus cash,
  quote persistée invalide jamais promue ultérieurement, terminal idempotent.
- Architecture : core sans I/O, horloge injectée, aucune transition de
  campagne ajoutée. La garde structurelle de carnet est partagée avec la
  garde d'exécution existante, dont les 8 tests restent verts.
- Security : identité/cache/clock/timestamps/séquences vérifiés ; aucun endpoint,
  secret ou prix alternatif. Le store revalide son export avant le planning.
  Ce n'est pas une authentification des données amont ou de leur hash déclaré.
- Lisibilité/performance : consommation linéaire, côtés bornés à 5 000 niveaux,
  overflow/underflow refusés ; aucun retry ou extrapolation. Le replay complet
  du bridge est volontairement local, pas optimisé pour un Worker.
- Limites : la fraîcheur est évaluée à `asOf` injecté, pas à un futur commit.
  Le store V1 accepte encore des fixtures déclarées ; ce pont ne sécurise pas
  une écriture différée. Revalidation transactionnelle avant persistance
  obligatoire dans le prochain incrément. Marks non persistés, pas de DD,
  benchmark B&H ou suspension de campagne implémentés ici.
- Le broker reçoit un champ averagePrice neutre pour son interface existante ;
  seules cash/quantité et prix/frais du fill sont exposés. Ses sorties
  averagePrice/realizedPnl sont volontairement ignorées, jamais des preuves.

Tests globaux : 566 modèles, 313 agent, 133 backtest passent ; TypeScript,
builds dry-run et lint ciblé passent. Les 11 tests du store local restent verts.
Le lint global reste limité par le fichier JSON concaténé préexistant,
non modifié dans ce lot. Aucun déploiement ou observation prospective.

## Incrément suivant — commit local

Le blocage du commit **local** est traité par le contrat
`p7-prospective-pricing-commit.md` : requête price-free, relecture verrouillée,
pricing/broker recalculés, refus et fill commités atomiquement. Le contrôle
pré-COMMIT ne garantit pas la fin du flush disque. V1 reste déclaratif ; marks
persistés, backend distant et activation demeurent hors périmètre.
