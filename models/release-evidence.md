# Modèle de preuve de release live-OFF

Ce modèle décrit l'artefact immuable produit par la CI après vérification d'une
release. Il ne déploie rien, n'active aucun Worker et n'accorde aucune
permission de trading. Son unique décision est d'accepter ou refuser une preuve
structurée liée à un SHA Git complet.

## Invariants

- `schemaVersion` vaut `1` ;
- `releaseSha` contient exactement 40 caractères hexadécimaux minuscules ;
- `generatedAt` est un instant ISO 8601 UTC valide fourni par le shell CI ;
- `liveTradingEnabled` vaut littéralement `false` ;
- les gates `install`, `audit`, `secretScan`, `check`, `test`, `build` et
  `artifactTest` sont tous présents et valent `passed` ;
- aucun champ libre, résultat LLM ou statut partiel ne peut remplacer un gate.

Une preuve qui viole un seul invariant est refusée entièrement. Le modèle est
pur : il ne lit ni l'horloge, ni Git, ni le système de fichiers. Le shell lui
fournit le SHA, l'instant de génération et les résultats déjà observés.

## Décisions et erreurs fermées

`createReleaseEvidence(input)` produit soit une preuve immuable, soit une erreur
parmi :

- `INVALID_RELEASE_SHA` ;
- `INVALID_GENERATED_AT` ;
- `LIVE_TRADING_NOT_DISABLED` ;
- `RELEASE_GATE_NOT_PASSED`.

`validateReleaseEvidence(value)` applique les mêmes invariants à une valeur
inconnue désérialisée. Toute forme inattendue retourne `INVALID_EVIDENCE`.

## Frontière d'effets

Le générateur CLI est le shell impératif. Il lit uniquement ses arguments,
appelle le modèle, sérialise le résultat puis le relit pour validation avant
écriture. La CI conserve ensuite le JSON comme artefact. Elle ne reçoit aucun
credential de production et aucun événement du modèle ne peut déclencher un
déploiement.
