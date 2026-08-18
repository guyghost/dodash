# Modèle de session du dashboard

Le dashboard est un interpréteur de `dashboardSessionMachine`. Il n’invente
jamais l’état du bot : il affiche uniquement une réponse validée du Worker Agent.

## États, événements et effets

| État | Événement accepté | Effet autorisé | État suivant |
| --- | --- | --- | --- |
| `disconnected` | `CONNECT_REQUESTED` | lire l’état de la cible via le proxy | `loading` |
| `loading` | `STATE_LOADED` | aucun | `ready` |
| `loading` | `REQUEST_FAILED` | aucun | `error` |
| `ready` | `REFRESH_REQUESTED` | relire l’état et les cycles | `refreshing` |
| `ready` | `COMMAND_REQUESTED` | envoyer une commande typée | `commanding` |
| `ready` | `KILL_CONFIRMATION_REQUESTED` | aucun | `confirmingKill` |
| `confirmingKill` | `KILL_CONFIRMED` | envoyer `kill` | `commanding` |
| `confirmingKill` | `KILL_CANCELLED` | aucun | `ready` |
| `commanding` | `COMMAND_SUCCEEDED` | aucun | `ready` |
| `commanding` | `REQUEST_FAILED` | aucun | `ready` |
| `error` | `RETRY_REQUESTED` | relire l’état | `loading` |
| tout état | `DISCONNECT_REQUESTED` | oublier le credential éphémère | `disconnected` |

## Frontière d’effets

- Le navigateur remet un credential dashboard au proxy same-origin ; le modèle
  ne conserve qu’un booléen `credentialPresent`, jamais sa valeur.
- Le Worker dashboard remplace ce credential par `CONTROL_API_TOKEN` avant
  d’appeler le service Agent. Le secret interne n’atteint jamais le navigateur.
- Le formulaire produit uniquement une configuration structurée. Les actions de
  contrôle utilisent l’enum `start | stop | reset | tick | kill`.
- L’état distant et son horodatage sont revalidés avant `STATE_LOADED` ou
  `COMMAND_SUCCEEDED`. Aucune mise à jour optimiste du bot n’est permise.
- `kill` ne peut pas être envoyé par `COMMAND_REQUESTED` : il exige les deux
  événements de confirmation dédiés.

## Invariants

1. Aucun secret ou Bearer token ne vit dans le contexte XState, l’URL ou le
   stockage persistant du navigateur.
2. Seule une réponse distante validée peut changer `remotePhase`.
3. `start` et `tick` exigent `canTrade`; les autres contrôles exigent
   `canControl`.
4. Une requête en vol est représentée par un état explicite.
5. Une erreur de commande conserve le dernier état distant confirmé.
