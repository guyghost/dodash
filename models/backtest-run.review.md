# Revue du modèle du backtest

Le chemin nominal, l’absence de permission, le dataset invalide, les retries de chargement, l’erreur déterministe, l’annulation et les trois états terminaux sont explicites. Aucun événement texte libre n’existe et aucun LLM ne participe au workflow.

Le modèle interdit une progression décroissante ou supérieure au dataset. Les métriques ne démarrent qu’après `REPLAY_COMPLETED`, et aucun retry ne masque une divergence du cœur pur.

La revue anti-biais couvre désormais les erreurs classiques d’un backtest de
bougies : la décision ne peut utiliser que l’historique clos jusqu’à `t`, le
fill est différé à l’ouverture de `t+1`, la dernière décision n’est pas remplie
sans prix futur et la bougie courante incomplète est exclue. Le chargeur rejette
les pages incohérentes, les timestamps dupliqués, les trous de granularité et
toute donnée hors fenêtre. Le checksum et le manifeste rendent le run
reproductible.

Le marché modélisé est Coinbase Spot long-only. Les ventes sont bornées par la
position et les achats par le cash frais inclus ; le broker papier ne peut donc
introduire ni short ni levier absents de l’exécution cible. Les frais et le
slippage sont identiques entre scénarios et explicitement reportés.

La comptabilité des positions intègre les frais d’achat au prix de revient. Un
fill d’ouverture n’est pas une perte clôturée : win rate et profit factor ne
consomment que les fills réduisant une position. Le PnL total est rapproché du
PnL réalisé et latent, et la somme des frais est exposée séparément. Cette revue
interdit ainsi qu’un profit factor apparemment favorable masque une position
ouverte fortement perdante.

La comparaison couvre chaque stratégie seule, leur ensemble et un buy-and-hold
sur le même dataset. Un run réussi n’est qu’un signal d’évaluation : aucune
métrique ni classement ne déclenche `LIVE_TRADING_ENABLED`, ne démarre l’Agent
ou ne crée un ordre. Erreurs, retries et annulation restent pilotés par la
machine XState ; le LLM ne décide d’aucune transition.

La politique protectrice est revue séparément dans
`protective-order.review.md`. Le mode `NONE` est le chemin de compatibilité et
doit rester identique aux rapports existants. Les modes actifs rendent explicite
la convention pessimiste lorsque high et low touchent les deux seuils, les gaps,
l’ordre entre trigger et ordre de stratégie, le réarmement après ajout et
l’annulation après clôture. Aucun high/low ne peut déclencher un bracket qui
n’était pas armé avant la phase correspondante.

La résolution multi-timeframe est revue dans `execution-resolution.review.md`.
La série fine n’est jamais une seconde série de décision : elle ne peut produire
que les événements `CANDLE_OPENED` et `CANDLE_RANGE_REPLAYED` d’un acteur
protecteur déjà gouverné par le modèle. Alignement, couverture et agrégation
sont validés avant replay ; toute incohérence est terminale et sans retry.

L’entrée CLI couvre les combinaisons nominales et invalides : compatibilité
historique sans option, résolution strictement plus fine à ratio entier,
politique `FIXED_BPS` avec deux seuils valides, seuil manquant, seuil fourni avec
`NONE`, timeframe égal ou plus grossier et ratio non entier. Le parseur reste un
cœur pur ; le chargement Coinbase et l’écriture du rapport restent dans le shell.
Le séparateur initial `--` des lanceurs de scripts est accepté sans élargir la
grammaire : un séparateur répété ou placé au milieu des options est rejeté.

La provenance secondaire ne crée ni nouvel état ni transition implicite. La
garde de `HISTORICAL_DATA_READY` accepte uniquement une paire secondaire absente
(`null/0`) ou complète (identifiant non vide/compteur positif). Le contexte
terminal mémorise cette paire, tandis que le rapport restitue les métadonnées et
l’empreinte complètes. L’échec de chargement de l’un des datasets emprunte le
chemin `HISTORICAL_DATA_FAILED` existant ; aucun fallback vers la résolution
primaire seule n’est permis.
