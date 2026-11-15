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

### Contrat HTTP du proxy dashboard

Le proxy est stateless : il traduit une requête dashboard validée en un appel
au service binding Agent. Il ne possède donc pas de machine d'état distincte.

| Route dashboard | Méthode | Route Agent | Corps |
| --- | --- | --- | --- |
| `/api/agents/:name/state` | `GET` | `/api/agents/:name/state` | interdit |
| `/api/agents/:name/cycles` | `GET` | `/api/agents/:name/cycles` | interdit |
| `/api/agents/:name/start` | `POST` | `/api/agents/:name/start` | JSON borné requis |
| `/api/agents/:name/perp-order` | `POST` | `/api/agents/:name/perp-order` | JSON borné requis (intention perp + entrées de garde) |
| `/api/agents/:name/stop` | `POST` | `/api/agents/:name/stop` | interdit |
| `/api/agents/:name/reset` | `POST` | `/api/agents/:name/reset` | interdit |
| `/api/agents/:name/tick` | `POST` | `/api/agents/:name/tick` | interdit |
| `/api/agents/:name/kill` | `POST` | `/api/agents/:name/kill` | interdit |

Avant l'effet réseau, le proxy doit :

1. accepter uniquement une requête same-origin et les routes/méthodes ci-dessus ;
2. comparer le Bearer dashboard à `DASHBOARD_ACCESS_TOKEN` sans branchement
   dépendant du contenu ;
3. valider et réencoder le nom d'Agent ;
4. refuser un corps supérieur à 16 KiB et tout corps inattendu ;
5. supprimer les headers entrants, puis injecter uniquement
   `Authorization: Bearer <CONTROL_API_TOKEN>` et, si nécessaire,
   `Content-Type: application/json` ;
6. borner la réponse Agent à 1 MiB et ne jamais refléter un secret.

Les statuts de frontière sont déterministes : `401` credential absent/invalide,
`403` origine navigateur étrangère, `404` route inconnue, `405` méthode
interdite, `413` requête/réponse hors limite, `502` échec du service Agent et
`503` secret interne absent ou trop faible.

### Topologie Cloudflare de production

Le déploiement conserve la frontière same-origin avec quatre Workers et trois
service bindings unidirectionnels :

```text
navigateur
  → dodash-dashboard (assets publics, /api/* seulement vers le Worker)
    → DASHBOARD_API → dodash-dashboard-api (privé)
      → AGENT_SERVICE → dodash-agent (privé)
        → MARKET_DATA → dodash-mcp-market-data (privé)
```

- `dodash-dashboard` est l'unique service exposé sur `workers.dev`. Il sert les
  assets statiques et transmet `/api/*` sans réécrire l'URL ni les headers.
- `dodash-dashboard-api`, `dodash-agent` et `dodash-mcp-market-data` ont
  `workers_dev: false` et restent joignables uniquement par service binding.
- Le cache marché utilise un namespace KV dédié `dodash-market-cache`.
- Les trois secrets de contrôle sont distincts par rôle :
  `DASHBOARD_ACCESS_TOKEN`, `CONTROL_API_TOKEN` et `INTERNAL_SERVICE_TOKEN`.
  Seules les égalités explicitement documentées entre émetteur et récepteur
  sont autorisées.
- Le mode live reste désactivé au premier déploiement. Les secrets Coinbase ne
  sont ajoutés qu'au cours d'une activation live séparée et revue.

## Invariants

1. Aucun secret ou Bearer token ne vit dans le contexte XState, l’URL ou le
   stockage persistant du navigateur.
2. Seule une réponse distante validée peut changer `remotePhase`.
3. `start` et `tick` exigent `canTrade`; `perp-order` exige `canControl`
   et `canTrade`; les autres contrôles exigent
   `canControl`.
4. Une requête en vol est représentée par un état explicite.
5. Une erreur de commande conserve le dernier état distant confirmé.
6. Le proxy ne transmet aucun header fourni par le navigateur au service Agent.
7. Le proxy n'accepte aucun chemin ou verbe libre et ne réessaie jamais une
   commande mutante.
8. Aucun Worker privé ne possède de route publique directe en production.
9. Le Worker d'assets ne décide d'aucun état métier : il route `/api/*` et sert
   le reste depuis le binding `ASSETS`.
