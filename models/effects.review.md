# Revue des effets Cloudflare

| Effet | Nominal | Erreur | Annulation / retry |
| --- | --- | --- | --- |
| MCP marché | réponse validée | rate-limit, réseau, schéma | retry borné par la machine |
| JWT | token court en mémoire | clé/claim invalide | régénération bornée |
| Ordre Coinbase | confirmation explicite | rejet ou issue inconnue | même id client ; réconciliation obligatoire |
| SQLite Agent | état/issue persisté | échec de stockage | bloque le rescheduling |
| Schedule | alarme idempotente | échec de schedule | retry borné |
| Contrôle RPC | permission validée | refus fermé | kill/stop selon la machine |

## Revue de la fenêtre Coinbase inclusive

| Cas | Fenêtre attendue | Couverture du modèle |
| --- | --- | --- |
| Alarme au milieu d'une période | `end` vise le début de la période précédente | Couvert |
| Alarme exactement sur une frontière | `end = T - D` | Couvert |
| Réponse Coinbase incluant `end` | la dernière chandelle est celle qui vient de fermer | Couvert |
| Granularité live `ONE_DAY` | la journée en cours est exclue | Couvert |
| Retry marché du même cycle | même `T`, donc même fenêtre et même clé de cache | Couvert, idempotent |
| Série absente ou mal formée | erreur typée ; aucun calcul métier | Couvert, fermé |
| Réponse trop ancienne ou future malgré la borne | la machine refuse la fraîcheur et borne les retries | Couvert |
| `429` ou panne réseau | `MARKET_DATA_FAILED`, retry selon le code typé | Couvert |
| Stop, kill ou permission révoquée pendant l'effet | la machine dirige vers annulation/persistance | Inchangé, couvert par `tradingCycleMachine` |
| Retry épuisé ou état terminal | persistance puis `NO_ACTION`/`failed`, aucune transition implicite | Inchangé, couvert |

Avis : la borne inclusive est déterministe pour chaque timeframe, ne dépend
d'aucun texte libre et ne déplace aucune décision d'état hors de la machine.

Les secrets ne figurent ni dans la configuration versionnée, ni dans les logs. Les bindings sont générés par Wrangler. Aucun adapter ne contient de logique de stratégie, allocation, risque ou transition d’état.
