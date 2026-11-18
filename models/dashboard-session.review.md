# Revue du modèle de session dashboard

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Credential absent | connexion refusée, aucun effet | Testé |
| Nom de cible vide ou trop long | connexion refusée | Testé |
| Réponse Agent invalide | `error` ou retour `ready`, état non modifié | Modélisé |
| Commande sans permission | reste `ready`, erreur typée | Testé |
| Double clic pendant une requête | état non réceptif à une seconde commande | Modélisé |
| Échec réseau au chargement | `error`, retry explicite | Modélisé |
| Échec réseau après commande | état distant précédent conservé | Testé |
| Kill accidentel | confirmation dédiée obligatoire | Testé |
| Annulation du kill | retour `ready`, aucun effet | Modélisé |
| Déconnexion pendant une requête | retour global `disconnected` | Modélisé |
| Live non activé côté serveur | échec explicite de `start`, aucun optimisme | Couvert par l’Agent |
| État terminal Agent | affiché tel quel; seul `reset` peut être demandé | Couvert par l’Agent |
| Bearer dashboard absent ou erroné | `401`, aucun appel Agent | À tester au proxy |
| Route ou méthode hors allowlist | `404`/`405`, aucun appel Agent | À tester au proxy |
| Nom Agent encodé, vide ou trop long | normalisé ou refusé avant effet | À tester au proxy |
| Corps inattendu ou supérieur à 16 KiB | `413`/`400`, aucun appel Agent | À tester au proxy |
| Headers navigateur malveillants | supprimés; seul le token interne est injecté | À tester au proxy |
| Échec service binding | `502`, aucun retry implicite d'une commande | À tester au proxy |
| Réponse Agent supérieure à 1 MiB | `413`, contenu non relayé | À tester au proxy |
| Secret interne absent ou trop faible | `503`, aucun appel Agent | À tester au proxy |
| Tentative cross-origin navigateur | absence de CORS; le déploiement doit router `/api/*` same-origin | Modélisé |
| Accès direct au proxy, à l'Agent ou au MCP | aucun sous-domaine public; service bindings seulement | À vérifier dans les configs et après déploiement |
| Route dashboard `/api/*` | transmise au proxy sans réécriture; aucune logique métier dans l'edge d'assets | À tester |
| Route dashboard hors `/api/*` | servie par `ASSETS` avec fallback SPA | À tester |
| Premier déploiement | paper uniquement; aucun secret Coinbase requis | À vérifier dans les secrets/configs |
| Namespace KV absent | provisioning explicite avant le Worker marché | À vérifier avant déploiement |

La machine ne prend aucune décision de trading. Elle autorise seulement des
effets UI typés; `tradingCycleMachine` reste l’unique arbitre des transitions du
bot et le Worker Agent reste l’unique frontière de permission métier.

## Revue de l'amendement du 2026-11-16

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

- **Pureté & invariants** : L'ajout de `readOnly` dans `DashboardSessionContext`
  et la garde `!context.readOnly` garantissent au niveau de la machine XState
  qu'aucune session anonyme ne peut émettre `start`, `stop`, `reset`, `tick`,
  `kill` ou `perp-order`. L'invariant V1 (`credentialPresent: false` sans
  `readOnly: true` → `INVALID_CREDENTIAL`) reste intact.
- **Frontière serveur fail-closed** : Au proxy `dashboard-api`,
  `PUBLIC_READ_ONLY === "true"` est opt-in, limité au mode `paper`, et ne
  s'applique qu'aux verbes `GET` de la liste blanche (`state`, `cycles`, `pnl`,
  `portfolio`). Tout `POST` sans `DASHBOARD_ACCESS_TOKEN` continue d'échouer en
  `401 UNAUTHORIZED`.
- **Limites acceptées** : L'activation de `PUBLIC_READ_ONLY` en `paper` expose
  en lecture l'état et les métriques paper du bot ; aucun secret ni endpoint
  d'exécution live n'est exposé.
