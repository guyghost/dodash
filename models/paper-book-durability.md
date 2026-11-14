# Durabilité du book paper face aux déploiements

Statut : normatif (2026-11-14). Source exécutable :
`models/paper-book-durability.ts`.

## 1. Constat

Le book paper de production (instance `btc-usd-paper`, créneaux BTC-USD et
ETH-USD) est le seul fait comptable des manches : `cash`,
`positionQuantity`, `averagePrice`. Il vit dans `portfolioSession`, elle-même
dans l'état synchronisé du Durable Object (`cf_agents_state`).

Deux chemins distincts ont été confondus lors du redéploiement du
6 novembre 2026 :

1. **`/stop` annule le cycle, il ne solde pas le book.** `STOP_REQUESTED`
   pose `shutdownMode = stop`. Depuis `waiting` (et les autres phases
   actives) la garde `shutdownRequested` entre dans `cancelling`.
   `EFFECT_CANCELLED` appelle `markCancelled` : l'issue télémétrie est
   `CANCELLED`. L'effet d'annulation paper retire l'alarme ; il ne réécrit
   ni le cash ni la position.
2. **`/start` recréait le book.** `startPortfolioAgent` remplaçait l'état
   par `INITIAL_AGENT_STATE` et `initialProductRuntime(initialCapital)` —
   10 000 $ et quantité nulle par créneau — même lorsqu'une session
   arrêtée portait déjà des positions. Le `/reset` historique ne soldait
   pas le book : il n'envoyait `RESET` qu'aux machines, transition admise
   seulement depuis `failed` / `halted`. Le retour à 10 000 $ observé après
   un stop/start venait donc du start, pas d'une remise à zéro nommée.

Le constructeur du SDK `agents` 0.21.0 recharge `cf_agents_state`. Il
n'écrit `initialState` que si la ligne est absente ou si le JSON est
illisible. `INITIAL_AGENT_STATE` a un cash top-level de 0 et
`portfolioSession: null` : ce n'est pas le book à 10 000 $ par produit.
La migration `wrangler.paper.jsonc` (`v1`, `new_sqlite_classes:
["TradingAgent"]`) est inchangée entre `8a2f391` et `d66e8da` : un deploy
ne recrée pas la classe SQLite et ne vide pas le stockage.

L'épinglage de classe (post-mortem
`docs/operations/incident-do-version-pinning-2026-10-30.md`) explique
pourquoi un deploy ne charge pas le nouveau code tant que l'isolate n'est
pas recyclé. Le stop/start utilisé pour forcer ce recyclage est le chemin
qui émet `CANCELLED` puis, au start, remplaçait le book. Les deux causes
se cumulent : l'épinglage motive le recyclage ; le start est la remise à
zéro. Le SHA déployé est `d66e8da`. Le SHA de production précédent n'est
pas un objet git (les identifiants du 30 octobre sont des versions
Cloudflare). La base `main` de ce commit est `8a2f391`. Le diff
`8a2f391..d66e8da` ne touche pas cette initialisation (PK du signal de
tendance, vars d'endurance). Le code de remise à zéro date du branchement
multi-produits (dao #28).

`decision.missed` au cycle suivant est la conséquence d'une machine neuve
(`lastDecisionCandleClosedAt` nul) qui se termine hors de la fenêtre de
fraîcheur (`models/cycle-schedule.md` §3). Ce n'est pas une seconde
remise à zéro.

## 2. Invariants

- **INV-B1** : `DEPLOY_OR_RESTART` et `START` recopient le book. Cash,
  quantité et prix moyen de chaque produit sont inchangés. Aucun audit de
  reset n'est émis.
- **INV-B2** : `RESET` n'est appliqué que si `explicit === true` et si
  `initialCapital` est fini et strictement positif. Chaque manche passe
  alors à `cash = initialCapital`, quantité 0, prix moyen 0. Le résultat
  porte un audit `portfolio.reset` avec le book avant et le book après.
  `explicit === false` est un refus `RESET_NOT_EXPLICIT` : le book
  d'entrée n'est pas réécrit.
- **INV-B3** : un blob d'état absent se résout par `paperBookAfterRestart`
  vers la copie durable, jamais vers un book synthétique à 10 000 $. Une
  copie mémoire déjà présente gagne sur la copie durable (un reset déjà
  commis n'est pas ressuscité). La reprise n'a lieu que si
  `shouldRecoverDurablePortfolio` : `portfolioSession`, `configuration` et
  `machine` sont tous absents. Une instance mono-produit configurée n'est
  pas un blob perdu.
- **INV-B4** : une charge utile illisible est un échec fermé
  (`unreadable` / `INVALID_BOOK`). Elle ne devient pas un book plat.
  `classifyDurableBookPayload` distingue une ligne absente (`missing`),
  une lecture ou un JSON en échec (`unreadable`). START sur `unreadable`
  est refusé. Une session qui ne passe pas la restauration n'est pas
  réécrite dans la copie durable.
- **INV-B5** : la décision est une fonction pure. Le shell Durable Object
  l'applique ; il ne décide pas d'une autre remise à zéro. Un LLM n'est
  pas sur ce chemin.

## 3. Effets de shell (hors de la fonction pure)

- Le shell persiste la session et le book dans SQLite
  (`dodash_paper_book`), table qui n'est pas celle du SDK, et seulement
  après `resolveRestoredPortfolioSession`. `onStart` recharge cette copie
  lorsque `shouldRecoverDurablePortfolio` est vrai. Le passage en
  mono-produit retire la ligne seulement si le portefeuille est quiescent
  et qu'un reset explicite a déverrouillé le remplacement. Un `/start`
  mono-produit ne remplace pas une session active et n'efface pas
  `dodash_paper_book`. Si la session mémoire est absente et que la copie
  durable existe ou est illisible, ce `/start` est refusé : le book SQL
  reste la seule copie.
- Une restauration de session invalide désarme l'agent
  (`portfolioRestoreError`) **sans** effacer la session ni le book.
  `/stop` et `/kill` répondent alors sans reconstruire l'acteur.
- `/start` sur les mêmes créneaux reprend les manches et
  `lastDecisionCandleClosedAt`. Si la session en mémoire est absente ou
  illisible, la session durable qui se restaure encore est cette source,
  watermark compris. Le book seul (cash, quantité, prix) ne sert que
  lorsque cette session est illisible. Un jeu de créneaux différent est
  refusé tant qu'un reset explicite n'a pas déverrouillé le remplacement.
- `/reset` exige `canControl`, refuse un portefeuille encore actif, puis
  applique `RESET` explicite, journalise `portfolio.reset` et écrit la
  ligne d'audit. L'orchestrateur qui en résulte est quiescent
  (`complete`, chaque créneau `stopped`) : la session projette encore un
  résumé. Elle n'est pas laissée `idle` sans statuts.
- Une écriture SQLite de la copie durable qui échoue est journalisée.
  Elle n'annule pas la transition d'état déjà acceptée. La copie se
  réécrit au prochain `setState` valide.
- Le mode live n'est pas concerné : `LIVE_TRADING_ENABLED` reste false et
  `resolveLiveStartContinuity` n'est pas élargi.

## 4. Vérification

- Restart et start conservent 0,1288 BTC et 4,4347 ETH.
- Reset non explicite : refus, book intact.
- Reset explicite : 10 000 $ et quantité nulle par manche, audit
  `portfolio.reset` avant/après.
- Blob absent + copie durable : la copie durable revient.
- Blob plat déjà en mémoire : il n'est pas écrasé par une copie durable
  plus ancienne.
- Charge utile tronquée : `null`, pas un book à 10 000 $.
