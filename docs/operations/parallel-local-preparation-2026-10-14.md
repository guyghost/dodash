# Dodash — préparation locale livrée le 14 octobre 2026

Branche : `codex/parallel-local-preparation-20261014`, depuis `8969e1e`.
Les trois lots ont été implémentés en worktrees séparés, puis intégrés après
revue croisée et revue finale indépendante. Chaque lot suit
**Model → Review → Implement → Verify**. Aucun push ou déploiement n'est inclus.

## Livrables

- **Source** : candidat Coinbase Exchange L2 hors ligne, séquence sans arrondi,
  raw/hash, timestamps et métadonnées conservés ; décisions de qualification
  dans le modèle pur. Bilan archivé reproductible : deux lots réseau exploitables,
  erreurs de harnais exclues du dénominateur, 429 explicites, cron inconnu.
- **Collector** : vrai Durable Object SQLite et R2 sous workerd local,
  journal/projection/outbox atomiques, captures bornées et reprises sans refetch,
  B&H indépendant, pricing/broker P7, marks communs, alarmes et rapports figés.
  Une admission interrompue suspend explicitement ; une décision expirée non
  résolue demeure inconnue et ne bloque pas indéfiniment le planificateur.
- **Paper** : harnais SDK réel, SQLite et reprise, frontières de fraîcheur,
  réveils et isolation produit ; préparation des quatre configurations paper.
  Le manifeste lie SHA Git, inputs, bundles et snapshot des assets HTML/JS/CSS,
  et refuse les mutations, ajouts, omissions et provenances périmées.

Les captures brutes sont bornées à 1 MiB pendant la lecture, avec une deadline
de cinq secondes couvrant headers et body. Les réponses complètes conservent
leur SHA-256 exact ; les réponses tronquées ne prétendent conserver qu'un hash
de préfixe et une taille observée. Le journal contient des références compactes,
les captures et projections sont découpées en lignes bornées. Cette conception
respecte la [limite de taille des lignes SQLite DO](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Vérifications exécutées sur l'intégration

| Vérification | Résultat |
| --- | --- |
| `npm run verify:local` | Passe : lint, scan secrets, check, tests, coverage, build, Sites |
| Check / tests Turbo | 21 tâches passent dans chaque gate |
| Tests des packages | 1 278 tests passent, dont 623 modèles, 313 agent et 15 collector workerd |
| `npm run test:runtime` | Deux smoke tests source et assertions SDK paper passent |
| `npm run test:paper-release-manifest` | 15 tests passent |
| `node --test docs/analysis/*.test.mjs` | 108 tests passent |
| `git diff --check` | Passe |
| Preuves utilisateur préexistantes | 17/17 fichiers inchangés, SHA-256 comparés |

Turbo réutilise le cache des paquets inchangés ; les nouveaux modèles, le
collector et les harnais runtime ont été exécutés sur l'intégration. Le lint
garde ses avertissements préexistants. Seule la capture brute concaténée du
8 octobre est exclue explicitement du parsing ; son contenu reste intact.
Le layout pnpm par projet est explicite et l'installation frozen a été vérifiée.

La revue finale a trouvé quatre défauts (reprises daily, taille des captures,
assets omis) : corrections, régressions et relecture ciblée terminées sans
constatation actionnable restante. Cette revue est une inspection indépendante
du code ; les preuves runtime proviennent des exécutions des auteurs et du root.

## Préparer un candidat paper après ce commit

```sh
WRANGLER_SEND_METRICS=false node scripts/paper-release-manifest.mjs \
  /private/tmp/dodash-paper-candidate-NOUVEAU \
  /private/tmp/dodash-paper-manifest-NOUVEAU.json --prepare
```

Le répertoire et le manifeste doivent être nouveaux. Le script reconstruit les
packages et le dashboard, exécute les quatre dry-runs paper, copie les assets,
puis fige la provenance. Il refuse les sources suivies modifiées et les inputs
de build non suivis, tout en préservant les analyses utilisateur non suivies.
Tout changement de SHA nécessite une nouvelle préparation. Ce candidat
n'autorise aucune publication ni modification de secrets.

## Limites et gates futurs

La collecte prospective réelle reste désactivée : `/start` refuse toujours,
les fixtures sont désactivées par défaut et aucune base synthétique n'est promue.
Source définitive, cache/clock/profondeur réels, quotas, T0 futur, authentification
opérateur, ressources/migrations distantes, anchors indépendants, déploiement
et démarrage restent à traiter séparément. Le calendrier complet de 180 jours
est testé ; la charge économique complète sous workerd n'a pas été mesurée.

Les tests paper utilisent une source substituée et un sink SQLite de témoin
pour les payloads de télémétrie ; ils ne prouvent pas l'ingestion Analytics
Engine ou le comportement des alarmes Cloudflare déployées. Les dry-runs du
dashboard ne constituent pas une validation visuelle navigateur. Aucun ordre
réel, activation du bot ou inventaire de secrets distant n'a été exécuté.
