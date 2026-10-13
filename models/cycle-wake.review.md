# Revue — réveil de grille pendant un cycle

Revue locale du contrat avant implémentation, sans revue externe indépendante.
Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

- Écarter une seconde alarme dans l'interpréteur seul serait insuffisant : le
  shell doit traiter la demande courante après avoir publié l'ancienne issue.
- Enchaîner les deux cycles dans une seule invocation écraserait le résumé et
  les artefacts de l'ancien cycle ; deux invocations séparées sont retenues.
- L'état courant est relu après les effets, pour respecter stop/kill.
- UUID distinct et dédoublonnage de bougie existant : pas de nouvel ordre indu.
- Le même chemin produit publie l'exposition et les alertes avant la suite.
- La borne d'une seule suite évite une boucle active de rattrapage.
- Limite acceptée : demande non durable entre deux invocations ; la grille
  suivante reste la récupération après crash. Aucun changement de cadence.

## Vérification locale après implémentation

- RED : le test de reprise par une grille échouait avec `DUPLICATE_ALARM`
  avant correction dans l'interpréteur.
- 20 nouveaux cas : 11 tests du plan pur, 1 régression de l'interpréteur,
  8 tests du shell mono-produit/portefeuille avec l'interpréteur réel.
- Les tests du shell vérifient deux identités/issues distinctes publiées dans
  l'ordre, la même bougie sans second calcul, l'ancien cycle expiré avec
  `decision.missed` avant la nouvelle issue, l'absence de suite pour un retry
  ponctuel et l'autre produit inchangé.
- `npm test` du monorepo passe : notamment 511 tests modèles, 308 tests agent.
  `npm run check`, `npm run build`, lint ciblé et `git diff --check` passent.
  `npm run scan:secrets` passe aussi ; les paquets inchangés peuvent être cachés.
- Le lint global reste bloqué par les preuves JSON concaténées préexistantes
  décrites dans `market-data-freshness.review.md` ; elles restent intactes.
- SDK `agents` remplacé par un fake et stockage remplacé par des effets
  mémoire dans les tests du shell : ce n'est pas un test du planificateur
  Cloudflare ni une preuve de reprise après crash du DO réel.
- Relecture : aucune nouvelle transition ad hoc, aucune migration, aucun
  nouveau budget ; la décision de suite vient du modèle pur et les nouveaux
  cycles passent par `ALARM_FIRED` et les gardes existantes.
- Aucun push, déploiement, ordre réel ni changement de stratégie/dashboard.
