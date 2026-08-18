# Revue des effets Cloudflare

| Effet | Nominal | Erreur | Annulation / retry |
| --- | --- | --- | --- |
| MCP marché | réponse validée | rate-limit, réseau, schéma | retry borné par la machine |
| JWT | token court en mémoire | clé/claim invalide | régénération bornée |
| Ordre Coinbase | confirmation explicite | rejet ou issue inconnue | même id client ; réconciliation obligatoire |
| SQLite Agent | état/issue persisté | échec de stockage | bloque le rescheduling |
| Schedule | alarme idempotente | échec de schedule | retry borné |
| Contrôle RPC | permission validée | refus fermé | kill/stop selon la machine |

Les secrets ne figurent ni dans la configuration versionnée, ni dans les logs. Les bindings sont générés par Wrangler. Aucun adapter ne contient de logique de stratégie, allocation, risque ou transition d’état.

