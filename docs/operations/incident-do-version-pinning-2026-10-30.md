# Post-mortem — DO épinglé à une ancienne version de classe (2026-10-30)

## Symptômes

Après trois déploiements directs de `dodash-paper-agent` (b42f5930 → 3d3f7fb6
→ e0ea9937), l'instance Durable Object `btc-usd-paper` continuait d'exécuter
la classe de `b42f5930` :

- les commandes `ai-trend-retrospective` avec `questionVersion: "v2"`
  étaient exécutées en v1 (le zod ancien éliminait le champ) ;
- la lecture calibration renvoyait bien les colonnes v2 (présentes dès
  b42f5930) — d'où un diagnostic déroutant « lecture neuve, écriture
  ancienne » ;
- les lots tombés sur la nouvelle code face à l'ancien schéma SQL
  (colonnes/`ON CONFLICT` de la nouvelle PK) ont produit des `error 1101`.

Coût : ~1 h de diagnostic comportemental, un balayage « v2 » en réalité v1
(1 125 lignes v1 recyclées), et un stop/start de l'agent qui a réinitialisé
le book paper (d'où le script d'archive ci-dessous).

## Cause

Sémantique des déploiements graduels : un Durable Object en cours
d'exécution **reste épinglé à la version de classe avec laquelle il a
démarré** ; un `wrangler deploy` (même à 100 %) ne le redémarre pas. Le DO
ne prend la nouvelle classe qu'à sa re-création (éviction complète /
drain). Un agent à réveils horaires reste chaud indéfiniment.

## Mesures retenues

1. **Sonde de version** : `GET /api/agents/:name/build-info` expose
   `{sha, agentVersion}` depuis la classe du DO ; un DO épinglé ne connaît
   pas la méthode → `503 STALE_DURABLE_OBJECT`. Un log `agent_boot` avec le
   SHA est émis à chaque construction. **Vérifier après chaque déploiement.**
2. **Déployer avec le SHA** : `npx wrangler deploy --var BUILD_SHA:$(git
   rev-parse --short HEAD)` (paper et prod).
3. **Archive avant contrôle destructif** : `scripts/archive-paper-state.mjs`
   (le stop/start a réinitialisé le book runtime sans trace).
4. **Contournement si DO épinglé** : la collecte rétrospective v2 peut
   tourner entièrement en local (`scripts/v2-local-sweep.mts` — candles
   Coinbase publiques + Jev via gateway + fonctions pures du dépôt), le DO
   n'étant que le stockage ; les signaux locaux se rejouent dans la base
   une fois le DO à jour.

## Leçons secondaires (même incident)

- La limite de 300 bougies du service marché tronquait les fenêtres
  d'issues (288 + horizon + 2) : fetch chunké ≤ 290 + comblement ciblé des
  PENDING (implémenté).
- Un 429 instantané vidait un lot entier : retry unique après 750 ms dans
  `fetchCandlesViaMarketService` (implémenté).
- L'API Coinbase v3 renvoie des chaînes, pas des nombres : le service MCP
  normalisait ; tout client direct doit coercer (script local corrigé).
