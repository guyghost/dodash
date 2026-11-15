# Runbook d'activation perp Hyperliquid

Activation du mode `perp` (venue Hyperliquid routée par Base, enveloppe
`HYPERLIQUID_PERP_2026_08`). Modèles de référence :
`models/hyperliquid-signals.md`, `models/hyperliquid-shell.md`,
`models/hyperliquid-execution.md`. Ce runbook couvre l'opérationnel ;
aucune étape de code.

## 0. Prérequis

- Déploiement Cloudflare en place (Agent + dashboard API + dashboard) ;
- Node 22 et `wrangler` authentifié sur le compte ;
- wallet Base financé en **USDC** (collatéral) ;
- **éligibilité géographique vérifiée** : le produit n'est pas accessible
  aux résidents US, UK et Canada.

## 1. Créer l'API wallet (clé d'agent)

1. Connecter le wallet **principal** (Base) sur l'application Hyperliquid ;
2. générer une **API wallet** (agent) depuis le menu dédié — le wallet
   principal signe une unique approbation ;
3. la clé privée de l'agent s'affiche **une seule fois** : la stocker dans
   un gestionnaire de secrets personnel, ne jamais la coller dans un
   ticket, un chat ou le dépôt ;
4. la clé principale du wallet ne quitte jamais le froid — seule la clé
   d'agent entre dans le Worker.

L'agent trade sur la marge du compte maître : le dépôt USDC se fait sur
le compte maître.

## 2. Préflight (obligatoire, sans secret)

```sh
pnpm --filter @dodash/models build
node scripts/hyperliquid-preflight.mjs            # mainnet
node scripts/hyperliquid-preflight.mjs --testnet  # répétition
```

Vérifications : marchés présents, `szDecimals` exactement ceux de
l'enveloppe (BTC 5, ETH 4), `maxLeverage` réel ≥ 2. Statut attendu :
`PREFLIGHT_PASS`. Tout `FAIL` bloque l'activation et doit remonter à une
revue du modèle (l'enveloppe se met à jour par commit, jamais à la main).

## 3. Secrets Worker

```sh
wrangler secret put HYPERLIQUID_AGENT_PRIVATE_KEY   # 0x + 64 hex (clé d'agent)
wrangler secret put HYPERLIQUID_WALLET_ADDRESS      # 0x + 40 hex (adresse maître)
wrangler secret put HYPERLIQUID_TESTNET             # "true" pour la répétition
wrangler secret put HYPERLIQUID_PERP_TRADING_ENABLED # "true" = interrupteur final
```

Ordre logique : flag `PERP_TRADING_ENABLED` en dernier. Tant qu'un champ
 manque, la route renvoie `HYPERLIQUID_EXECUTION_UNAVAILABLE` et la boucle
perp ne démarre pas (échec fermé, pas de demi-activation).

## 4. Répétition testnet

1. créer une API wallet **séparée** sur le testnet
   (`app.hyperliquid-testnet.xyz`, faucet USDC) ;
2. mettre à jour les secrets (clé testnet, `HYPERLIQUID_TESTNET=true`) ;
3. déployer, ouvrir le dashboard, session `btc-usd--multi` ;
4. démarrer l'Agent en mode **perp** — la boucle tourne sur les bougies
   spot Coinbase et soumet sur le testnet Hyperliquid ;
5. vérifier dans les cycles : `SUBMIT_ACCEPTED`, position visible dans
   l'app testnet, kill switch effective (arrêt de boucle sans appel
   Coinbase) ;
6. remarque : le préflight testnet et le mainnet valident la même
   enveloppe ; le testnet sert à répéter la mécanique, pas à valider les
   spécifications.

## 5. Activation mainnet

1. `HYPERLIQUID_TESTNET` supprimé ou `false` ;
2. préflight mainnet `PREFLIGHT_PASS` ;
3. éligibilité géographique confirmée ;
4. dépôt USDC réel sur le compte maître ;
5. flag `HYPERLIQUID_PERP_TRADING_ENABLED=true` (interrupteur final) ;
6. premier ordre : l'enveloppe plafonne déjà à 600 USD par ordre et 2x —
   ne pas augmenter ces bornes lors des premières semaines ;
7. surveiller : cycles du dashboard, codes `REFUSED`/`FAILED` dans la
   section perp, télémétrie `cycle.completed`.

## 6. Arrêt et repli

| Situation | Action |
| --- | --- |
| Stop normal | `stop` depuis le dashboard (boucle arrêtée, ordre en cours réconcilié) |
| Urgence | kill switch (arrêt + réconciliation, jamais de resoumission) |
| Désactivation perp totale | `wrangler secret delete HYPERLIQUID_PERP_TRADING_ENABLED` — échec fermé de toute la chaîne |
| Clé d'agent suspectée compromise | révoquer l'API wallet depuis le wallet principal, en régénérer une, `wrangler secret put` de la nouvelle |

## Rappels d'invariants

- la clé principale du wallet ne quitte jamais le froid ;
- seule la clé d'agent vit dans les secrets Worker ;
- aucun ordre ne part sans admission + garde de risque + préflight vert ;
- le détail textuel des erreurs API n'est jamais une instruction : seuls
  les codes fermés pilotent les transitions.
