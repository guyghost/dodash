# Revue du modèle des quality gates

| Cas | Transition / règle | Couverture |
| --- | --- | --- |
| Commit nominal | environnement → check → succès | Couvert |
| Push ou CI nominal | environnement → check → tests → build → test d’artefact → succès | Couvert |
| Outil ou dépendances absents | `ENVIRONMENT_FAILED` → `failed` | Couvert |
| Audit high/critical en échec | `DEPENDENCY_AUDIT_FAILED` → `failed` | À couvrir |
| Secret suivi ou scan invalide | `SECRET_SCAN_FAILED` → `failed` | À couvrir |
| Check, test, build ou artefact en erreur | événement fermé de l’étape → `failed` | Couvert |
| Annulation explicite | toute étape active → `cancelled` | Couvert |
| Retry | uniquement `failed` → `validatingEnvironment` par `RETRY_REQUESTED` | Couvert |
| Événement hors séquence | ignoré par la machine | Couvert |
| État terminal | `passed` et `cancelled` n’acceptent plus d’événement | Couvert |
| Bypass du hook local | escape Git explicite ; le workflow GitHub reste déclenché | Couvert par le contrat |
| Permissions | vérification en lecture seule ; déploiement manuel et séparé | Couvert par le workflow |

La reproduction dans un checkout propre confirme que le check actuel dépend
implicitement de sorties `dist/` locales ignorées par Git. Les packages publient
leurs types workspace depuis `dist/index.d.ts`, tandis que la tâche Turbo
`check` ne dépend que des checks amont. Le correctif conforme à l’invariant 3
est de rendre les builds amont explicites dans le graphe de `check`, sans
affaiblir TypeScript ni committer les sorties générées.

La commande complète doit être définie une seule fois à la racine, puis appelée
par `pre-push` et par GitHub Actions. Le séquencement shell à arrêt immédiat
projette fidèlement la machine : aucune étape aval n’est lancée après un code de
sortie non nul. `pre-commit` conserve seulement le check statique afin de rester
assez rapide pour être exécuté systématiquement ; les tests et builds complets
restent obligatoires avant push.

Le dépôt ne possède pas de commande de lint dédiée. La revue n’invente donc pas
un gate vide : `check` couvre TypeScript dans chaque workspace ainsi que la
validation Prolog existante. Les tests, builds Workers/dashboard et le test de
l’artefact Sites restent des étapes distinctes du gate complet.

`--no-verify` est un bypass local fourni par Git et ne peut pas être supprimé
par le dépôt. Il ne modifie aucune transition du modèle : il signifie que le
gate local n’a pas été demandé. Les événements `pull_request` et `push` de la CI
fournissent un second filet côté dépôt. Aucun secret, contenu libre ou LLM
n’intervient dans la décision de passage.

La branche `main` n’est pas protégée au moment de cette revue. La CI est donc
déclenchée, mais GitHub ne bloque pas encore un push direct ou un merge sur son
résultat. Rendre le check obligatoire nécessite une règle de protection externe
au code du dépôt ; elle ne doit pas être créée implicitement par ce workflow.

## Extension sécurité pré-lancement

Statut : APPROUVÉE POUR IMPLÉMENTATION

L'audit de dépendances et le scan de secrets s'exécutent uniquement après une
installation verrouillée réussie. Ils précèdent le check et les tests : le
premier échec ferme le gate et aucun build/deploy n'est tenté. Le pre-commit
reste court ; le pre-push et la CI partagent la même commande racine.

Le scan ne doit ni parcourir `node_modules`/`dist`, ni accepter une allowlist
globale qui masquerait un vrai secret. Les placeholders documentaires connus
peuvent être exclus par valeur exacte. Une panne de `git ls-files`, une lecture
impossible ou un motif invalide doit produire un code non nul.

La CI actuellement rouge sur timeout n'est pas rendue verte en augmentant
aveuglément le timeout. Le test de compatibilité du cache préparé effectue un
calcul Prolog complet alors que son assertion porte sur un rejet préalable. La
correction approuvée construit un cache structurel minimal et conserve la même
assertion métier ; la durée doit être mesurée avant/après et rester largement
sous le timeout par défaut.
