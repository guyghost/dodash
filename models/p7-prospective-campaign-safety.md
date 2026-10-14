# P7 — machine de sûreté de campagne locale

Statut : préparation **SYNTHETIC_LOCAL_PREPARATION**, 14 octobre 2026. Aucun
START_AUTHORIZED, préflight réel, collector, déploiement ou ordre live livré.
Ce modèle est un harnais local du workflow gelé, pas son activation réelle.

## Model

XState : `registered → localObserving → suspended | stopped | invalid | ended`.
Manifest obligatoirement LOCAL_PREPARATION. Aucun événement permettant de
lever une suspension, reprendre un arrêt ou promouvoir une fixture en étude.
Le vrai workflow draft/preflight/ready/assessing et les autorisations restent
à implémenter après les baselines, sources et exports.

- `BEGIN_LOCAL_SIMULATION` : opt-in **synthétique**, dans `[T0,T1)`, clock
  vérifiée du manifest. Ne choisit ni source ni T0 et n'autorise aucun I/O.
- `CHECK_LOCAL_SAFETY` : réévalue les faits et l'heure injectée.
- `RECOVER_LOCAL` : obligatoire au bootstrap d'un futur runner ; toute quote
  ou mark requested sans réponse durable => suspended. Une demande normalement
  en vol n'est pas déclarée perdue avant cet événement de reprise.
- `STOP_LOCAL` : arrêt opérateur simulé, sticky, sans vente ou liquidation.

Faits déterministes, priorité invalidité comptable → drawdown >50 % → arrêt
déjà acquis → suspension déjà acquise → T1 → gap de preuves >2 h. Toutes les
raisons précédentes restent conservées. Les balances/positions/versions doivent
être finies, non négatives, versions entières sûres. Aucun LLM ne décide.

DD échantillonné P7 : capital initial 20 000 $, puis marks consolidés
disponibles triés par asOf. Peak = max(peak,equity), DD=(peak-equity)/peak,
maximum historique conservé. Seuil strict >50 % : stopped, sans requalification
après remontée. Marks UNAVAILABLE ignorés pour la valeur, jamais pour les
trous de preuve. Ce calcul ne valide ni B&H, ni la complétude, ni un verdict.

Intervalle de preuves : modèle marks, timestamps réels, maximum historique
incluant initial/trailing ; exactement 2 h permis, >2 h suspended. Un mark
récent ne gomme pas le trou. Une campagne suspendue ne reprend jamais
automatiquement, même après réparation ; réparation hors de ce lot.

## Frontière transactionnelle

`applyCampaign` inscrit les événements locaux dans une enveloppe V4. Toute
mise à jour ledger/marks après binding réévalue le modèle dans le replay.
`commitCampaignPricing` reçoit la même requête price-free que commitPricing.
BEGIN IMMEDIATE → replay → déduplication → safety → quote/broker si permis
→ issue/portefeuille ou refus de gate durable → contrôle final → COMMIT.

Enveloppe V5 : requête, résolution dérivée ou null, reçu `{ allowed, ... }`.
Un blocage conserve l'état/raison de campagne et la requête refusée, sans
terminer le slot de décision ni débiter le portefeuille. Même ID retourné
sans repricing/clock, quel que soit l'état courant. Nouveau prix impossible.
Au replay, safety et résolution sont recalculées ; refus et reçu non autoritaires.

Si une limite de campagne est franchie après insertion et avant COMMIT,
rollback total ; nouvelle tentative inscrit le blocage à l'heure actuelle.
Les garanties de fraîcheur restent pré-COMMIT, pas une preuve du flush disque.
Les marks diagnostiques peuvent continuer dans leurs fenêtres en suspension
ou arrêt ; aucun fill, liquidation réelle, kill/reset du bot ou prolongation.

Compatibilité : V1/V2 non liées restent des fixtures anciennes, jamais une
campagne autorisée. Après BEGIN_LOCAL_SIMULATION, commitPricing legacy est
refusé ; les fills V1 déclarés sont refusés même lorsque safety est verte.
INTENT/REQUEST_QUOTE sont refusés lorsque la campagne liée n'observe plus.
Les résolutions sans fill restent permises pour conserver les refus/proof gaps.
Le nouveau commitCampaignPricing refuse également une campagne non liée.

Les anciennes fixtures non liées restent utilisables pour leurs tests V1/V2 ;
ce n'est **pas** un mode observation autorisé. Toute future orchestration
doit utiliser le chemin lié/V5, appeler RECOVER_LOCAL au bootstrap et fournir
des CHECK_LOCAL_SAFETY sur timer même sans nouvelle donnée. Pas de runner,
timer, détection automatique de crash/lease ou réparation dans cet incrément.
Une simple réouverture de fichier n'est pas interprétée comme une perte de
réponse : elle pourrait être une seconde connexion pendant un I/O normal.

## Review

Accepté pour harnais local : frontière explicite évitant tout démarrage réel,
sticky safety indépendante du LLM, modèle source de vérité, contrôle dans
transaction et replay. Ne pas appeler legacy comme contournement après binding.
La corruption de chaîne ferme les accès, mais n'est pas réécrite en événement
invalid sur une chaîne corrompue. Ni hash signé ni durabilité distante prouvés.

## Verify requis

Gardes pures : calendrier, 2 h/50 % stricts, historique conservé, reprise sans
réponse, arrêt/invariant/T1, aucun resume/START_AUTHORIZED. SQLite : refus durable,
idempotence, anti-contournement V1/V2, marks après suspension, rollback/crash,
réouverture et collision de commande. Aucun réseau ou benchmark réel.

## Revue de livraison

- Correctness : 9 tests purs et 11 tests SQLite/broker passent. Frontières
  2 h/50 % strictes, états sticky, T1, absence de START/resume, reprise quote
  et mark sans réponse, garde durable, anti-contournement V1/V2, mark de
  drawdown puis rebond, rollback et sorties réelles avant/après COMMIT.
- Architecture : XState typé et gardes pures dans models, I/O/clock/hash dans
  shell. Aucun changement du bot, du sizing/risque P7 ou des coûts paper.
- Sécurité : événements locaux et requêtes price-free fermés, déduplication
  avant nouveau pricing/clock, reçus V4/V5 recomputés au replay. Pas d'API
  réseau ni d'auth opérateur réelle fournie ; aucune clé/autorisation live.
- Lisibilité/performance : chemin de transaction commun, fonctions explicites
  pour gate et résolution. Replay complet/tri de marks local, pas un backend
  distant optimisé ou une garantie de flush disque dans les 5 s.
- Limites : pas de verdict économique, B&H ou campagne réellement démarrable.
  RECOVER_LOCAL explicite et timers à câbler dans un futur runner. Aucun
  effacement de trou, réparation automatique ou requalification des fixtures.
- Verify global : 589 tests modèles, 313 agent et 133 backtest passent ;
  TypeScript, builds dry-run et lint ciblé passent. Les fichiers utilisateur
  et le JSON concaténé préexistant limitant le lint global sont laissés intacts.
