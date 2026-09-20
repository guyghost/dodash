# Incident : perte de #51–#53 lors d'un write CLI 0.15 sur un état au format 0.12

**Date** : 2026-09-20
**Sévérité** : High (perte de données de gouvernance : trois propositions entières, dont leurs votes)
**Statut** : Réparé — propositions restaurées, deux défauts amont corrigés, tests de non-régression ajoutés

## Symptôme

Après un `swarm-dao dry-run 51` lancé avec le CLI construit depuis `~/Developer/OSS/swarm-dao`
(core 0.15.0 / 2.2.0), les propositions **#51, #52 et #53 ont disparu de `.dao/state.json` et
de `.dao/archive.json`**. `swarm-dao list` ne montrait plus que #23–#50, et le `control 51`
suivant a répondu `Proposal #51 not found`. Seules les projections `.dao/decisions/051..053.json`
et le journal `.dao/audit.jsonl` survivaient.

## Cause racine (deux défauts cumulés, côté swarm-dao core)

1. **Partition sans écriture d'archive.** `partitionState` déplace toute proposition close
   (tout sauf `open`/`deliberating`) hors de `state.json` vers la partition d'archive. Mais la
   décision d'écrire `archive.json` repose sur `archiveSignature`, qui n'encode que des paires
   `id:status` par proposition — et cette signature est calculée **après** le chargement, donc
   elle inclut déjà les propositions closes trouvées dans `state.json`. Pour un état écrit par un
   ancien CLI (propositions closes encore dans `state.json`, format 0.12), la signature est
   inchangée, `archivedDirty` est faux, l'archive n'est **pas** réécrite — et les propositions
   sont retirées de l'écriture de `state.json`. Elles n'existent alors dans aucun des deux
   fichiers. Le champ `archiveOnDiskKnown` ne sauve que le cas où `archive.json` est **absent** :
   ici l'archive existait (28 propositions héritées), donc la garde ne s'appliquait pas.
2. **Écriture aveugle sur une proposition archivée.** `DryRunProposalUseCase` n'appelait pas
   `repository.markArchivedDirty()`, contrairement à `control`/`ship`/`rate`/`round-table`. Or
   `dryRunAt` est un changement de champ que la signature ne voit pas : l'écriture était
   silencieusement abandonnée. Le même défaut touchait donc l'outil hôte MCP `dao_dry_run` :
   il annonçait un dry-run enregistré qui n'atteignait jamais le disque, laissant le gate
   `mandatory-dry-run` définitivement fermé pour une proposition rouge. C'est une cause
   plausible des blocages constatés sur les propositions rouges avant cet incident.

## Réparation

Côté swarm-dao (branche `feat/dao-cli-dry-run-acceptance-criteria`) :

- chargeur : `archivedDirty` est forcé à `true` quand `state.json` porte une proposition close
  que `archive.json` ne contient pas encore (garde de migration) ;
- `DryRunProposalUseCase` marque l'archive sale quand la proposition visée est close ;
- `isArchivedStatus` déplacé dans `domain/proposal-status.ts` (ré-exporté depuis son ancien
  emplacement) pour que le code applicatif consulte la règle sans importer d'infrastructure
  (contrat hexagonal) ;
- deux tests de non-régression dans `packages/core/tests/file-repository.archive.test.ts` :
  « keeps an inline closed proposal when archive.json already exists » et « persists a dry-run
  recorded on an archived proposal ». Vérifiés en échec sans le correctif, verts avec.

Côté dodash : les trois propositions ont été reconstruites dans `.dao/archive.json`.

## Fidélité de la restauration

| Donnée | Source | Fidélité |
| --- | --- | --- |
| `title`, `type`, `description` | `/tmp/dao-propose.mjs` (texte exact rédigé) | verbatim |
| `status`, `riskZone`, `createdAt`, `resolvedAt` | `.dao/decisions/05*.json` | exact |
| votes (agent, position, poids) | comptages de délibération imprimés en session + `.dao/audit.jsonl` | exact pour les 6/8 voix de #51 (11 poids pour) et 8/8 de #52/#53 (17 poids pour) |
| `reasoning` des votes | extraits imprimés par le tally | extraits, non verbatim |
| `agentOutputs` (corps des réponses d'agents) | indisponible | **vide, volontairement non inventé** |
| `dryRunAt` de #51 | ré-exécuté après correctif | exact (`2026-09-20T22:25:56.949Z`) |

## État final

`#51 approved → control` (gate `mandatory-dry-run` satisfait, quorum 65 %, approbation 100 %) →
`controlled`. `#52` et `#53` restent `executed` (leur code est committé : `bafc4e9`, `33718b2`).

## Reproduction (avant correctif)

```sh
# état au format 0.12 : propositions closes dans state.json, archive.json existant
node <oss>/packages/cli/dist/cli.js dry-run <id>   # → dryRunAt jamais écrit, proposition perdue
```

## Suites

1. Le CLI installé (0.12.2) n'écrit pas ce format problématique, mais tout passage à un CLI
   ≥ 0.15 doit se faire avec le correctif : sans lui, la première écriture détruit les
   propositions closes encore dans `state.json`.
2. `archiveSignature` reste aveugle aux changements de champs : tout nouveau use case qui
   modifie une proposition close doit appeler `markArchivedDirty()`. Un test générique
   (mutation de champ sur une proposition archivée) serait la vraie barrière.
3. Le gate `mandatory-dry-run` lit `dryRunAt` sans regarder `dryRunCanProceed` : un dry-run qui
   conclut « ne pas procéder » ouvre quand même le gate. Comportement préexistant, non modifié ici.
