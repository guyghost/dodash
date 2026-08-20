# Modèle des quality gates Git et CI

`qualityGateMachine` est la source de vérité du workflow de validation. Les
hooks Git et GitHub Actions projettent les mêmes étapes ; aucun résultat textuel
ou LLM ne choisit une transition.

## États et transitions

```text
idle
  → validatingEnvironment
  → checking
      ├─ pre-commit → passed
      └─ pre-push | ci → testing → building → testingArtifact → passed
```

Chaque étape active accepte uniquement son événement de succès, son événement
d’échec fermé ou `CANCEL_REQUESTED`. Un échec mène à `failed` avec un code et
une étape typés. Seul `RETRY_REQUESTED` relance depuis la validation de
l’environnement ; il n’existe aucun retry automatique. `passed` et `cancelled`
sont terminaux.

## Projection état → effet

| Source / état | Effet autorisé | Événement produit |
| --- | --- | --- |
| CI / `validatingEnvironment` | `pnpm install --frozen-lockfile` avec Node 22 et pnpm épinglé | `ENVIRONMENT_VALIDATED`, `ENVIRONMENT_FAILED` |
| hook local / `validatingEnvironment` | vérifier que le gestionnaire et les dépendances installées sont disponibles | `ENVIRONMENT_VALIDATED`, `ENVIRONMENT_FAILED` |
| toutes / `checking` | `pnpm check` | `CHECK_PASSED`, `CHECK_FAILED` |
| pre-push, CI / `testing` | `pnpm test` | `TESTS_PASSED`, `TESTS_FAILED` |
| pre-push, CI / `building` | `pnpm build` | `BUILD_PASSED`, `BUILD_FAILED` |
| pre-push, CI / `testingArtifact` | `pnpm --filter @dodash/dashboard test:sites` | `ARTIFACT_TESTS_PASSED`, `ARTIFACT_TESTS_FAILED` |

Le hook `pre-commit` privilégie le feedback rapide et s’arrête après le check
statique. Le hook `pre-push` exécute le gate complet identique au job CI.

## Invariants

1. Un commit est refusé si le check statique échoue.
2. Un push est refusé si un check, test, build ou test d’artefact échoue.
3. Un checkout CI propre construit les dépendances workspace requises avant de
   vérifier leurs consommateurs.
4. Le gate CI et le gate pre-push appellent une commande racine commune ; leur
   séquence ne peut pas dériver silencieusement.
5. Une étape suivante ne démarre jamais après un échec ou une annulation.
6. `--no-verify` peut contourner un hook local, mais ne désactive jamais les
   déclencheurs CI sur pull request et push vers `main`.
7. Le déploiement n’appartient pas au gate : il reste manuel, séparé, et dépend
   d’un gate CI réussi ainsi que des permissions de l’environnement production.
8. Aucun secret de production n’est requis pour vérifier un changement.
9. Aucun texte libre et aucun LLM ne pilote une transition.
