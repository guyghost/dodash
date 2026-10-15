# Dodash — préparation locale en parallèle

Base : `8969e1ef18bbecc1b8357cbbbfad5b867641212b`.

## Résultat attendu

Trois lots implémentés et testés localement : qualification de source spot,
collector shadow P7 indépendant et vérification runtime/livraison paper.
Stockage cible : Durable Object SQLite par campagne et R2 pour les exports.
Pas de collecte réelle, provisionnement, déploiement, démarrage ou push.

## Modélisation et répartition

Chaque lot suit **Model → Review → Implement → Verify**. Les événements,
invariants et effets sont définis dans `models/` avant le code. Les LLM ne
décident aucune transition. Worktrees séparés et revue croisée avant intégration.

- **Source** : adaptateur offline Coinbase Exchange L2 BTC/ETH USD, profil
  candidat et fixtures de qualification ; timestamps amont/fetch distincts,
  séquence exacte, profondeur, cache/clock/métadonnées vérifiés. Bilan des
  captures existantes sans fabriquer d'exécution cron ou choisir une venue.
- **Collector** : lifecycle XState prospectif distinct des fixtures, calendrier
  durable daily/B&H/marks/checkpoints, SQLite transactionnel et outbox R2.
  REQUEST précède I/O, reprise sans réponse suspend, aucun repricing implicite.
  Source et clock injectées pour les essais locaux ; collecte réelle fermée
  sans manifest/profil/autorisation. Aucun registre synthétique promu en preuve.
- **Paper** : SDK agents réel sous workerd, stockage SQLite persistant,
  redémarrage et callback d'alarme réels ; marché substitué. Préparation dry-run
  des configurations paper et manifeste SHA/bundles/configs avec flags live
  et perp false. Ne pas utiliser le workflow CI de production.

## Vérification

Tests ciblés puis suite globale, check, lint, scan secrets et builds dry-run.
Couverture des frontières 5 s/2 h/T1, crash avant/après checkpoint/commit,
réveils répétés, isolation BTC/ETH, suspension sticky et exports interrompus.
Préserver les 17 fichiers utilisateur non suivis avec leurs SHA-256.
Exclure uniquement la capture brute concaténée du parsing Biome, sans modifier
son contenu ni ignorer globalement les preuves.

## Gates futurs

Choix définitif de source, T0 futur, garanties/anchors indépendants,
provisionnement, migration distante, déploiement et démarrage restent séparés.
Les seuils P7 sont gelés. Tests et hashes locaux ne prouvent ni durabilité
Cloudflare, ni disponibilité du fournisseur, ni rentabilité prospective.
