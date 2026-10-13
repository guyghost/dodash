# P7 — registre append-only et reprise atomique (incrément local)

Statut : normatif pour la préparation locale, 14 octobre 2026. Raffine le
registre de `p7-prospective-campaign.md` sans changer ses seuils ou autoriser
une collecte. Pas de migration distante, démarrage, intégration au bot ou
choix du stockage Cloudflare. SQLite local constitue un adaptateur de test.

## Source de vérité et identités

Manifest de test/enregistrement : campaignId, manifestSha256, startAt/endAt
(180 jours UTC), profil de source et preuve de clock. Enregistrer le manifest
avant startAt ; il est immuable. L'enregistrement n'autorise aucun démarrage.
Cet incrément couvre le registre P7 BTC/ETH ; benchmarks/marks et autorisation
de campagne restent des incréments séparés, explicitement non implémentés.
Le manifest exige `purpose: LOCAL_PREPARATION` et les exports sont marqués
`SYNTHETIC_LOCAL_PREPARATION` : ce format n'autorise pas une collecte réelle.

Clé de slot : `(campaignId, productId, candleClosedAt)`. Unicité UTC daily
sur `[startAt,endAt)`, BTC/ETH uniquement. Capital initial 10 000 $ par produit,
cash/position/version propres ; pas de transfert entre produits.

Chaque commande possède un commandId unique dans la campagne. Même ID et
même JSON canonique => retourner le reçu antérieur, **sans** nouvelle écriture
ni transition, même après expiration. Même ID et contenu différent => conflit.
Un nouvel ID sur un slot terminal n'est pas une nouvelle décision autorisée.

## Workflow XState par slot

`expected → admitted → intent → requested → quoted → terminal`.

- `EXPECT` : créer le slot attendu, même si aucune donnée n'arrive ensuite.
- `ADMIT { evaluatedAt, windowSha256 }` : date valide dans la fenêtre 2 h,
  close original conservé. L'admission n'est pas un résultat stratégique.
- `INTENT { side, quantity, portfolioVersion }` : quantité positive figée,
  checkpoint après admission et avant pricing ; version du portefeuille courant.
  Un seul slot en vol avec intention par produit ; ETH reste indépendant de BTC.
- `REQUEST_QUOTE` : checkpoint **avant** l'I/O. Le shell prend l'heure courante
  injectée et inscrit cet instant ; ce n'est pas une date proposée par un LLM.
- `OBSERVE_QUOTE { book, bodySha256 }` : seul résultat de cet essai ; la garde
  quote existante vérifie le profil, dates et contenu. receivedAt ≤ heure de
  persistance, requestedAt égal au checkpoint de requête. Conserver preuve et
  éligibilité ; une quote non éligible ne peut jamais produire de fill.
- `TERMINATE` : HOLD/RISK_REJECTED depuis admitted ; MISSED depuis expected
  seulement après close+2 h ; QUOTE_REJECTED depuis quoted (ou requested en
  perte de preuve) ; résultat broker/fill depuis quoted éligible uniquement.

Les refus et terminaisons sans fill ne changent pas le portefeuille. Un fill
est un **fait simulé fourni par le futur pricer**, pas un ordre réel. Ce lot
valide quantité/side/intention, prix/frais finis, fee = prix×quantité×60 bps et
équations cash/position ; il calcule lui-même le portefeuille résultant.
Il ne valide pas encore VWAP/profondeur/slippage 2 bps : aucun collector ou
pricer réel ne peut se dire prêt sur cette seule persistance.

PortfolioVersion doit toujours correspondre à la version courante lors de
l'intention et du commit. Une vente ne dépasse pas la position ; achat ne
dépasse pas le cash (tolérance flottante du broker) ; pas de cash/quantité
négatifs. Une résolution avance la version une seule fois, même sans fill,
pour invalider les décisions concurrentes calculées sur l'ancien état.

## Transaction et journal

Un journal append-only unique contient manifest/commandes/résultats, numéro
de séquence contigu, hash du précédent et SHA-256 de l'enveloppe canonique.
Un événement terminal contient **issue et portefeuille résultant ensemble**.
Pas de table de portefeuille mutable écrite séparément du fill.

Le shell fait `BEGIN IMMEDIATE`, relit/rejoue le journal, déduplique, appelle
le core, puis insère un seul événement et committe. Toute erreur avant COMMIT
rollbacke l'ensemble. Un crash après COMMIT mais avant accusé de réception se
résout par commandId : pas de nouveau fill ou retranchement de frais.

JSON canonique : clés triées, tableaux ordonnés, types JSON finis seulement,
taille ≤2 MiB par commande. Pas de secret, URL libre ou callback sérialisé.
Le journal refuse UPDATE/DELETE via triggers. Hash/sequence et transitions
sont revérifiés à la réouverture et à l'export ; projections dérivées, jamais
un snapshot client restauré comme autorité. Une corruption ferme les writes.
Les hashes ne sont pas des signatures : un administrateur hostile peut réécrire
un fichier entier/recalculer la chaîne. Les anchors/export externes restent
un préflight séparé ; aucune complétude distante n'est démontrée par ce lot.

## Plan de reprise

- expected/admitted : continuer sur les faits existants, pas réadmettre avec
  une nouvelle heure. Avant intention, aucun portefeuille ne change.
- intent : checkpoint REQUEST_QUOTE possible dans la fenêtre autorisée.
- requested sans quote : **SUSPEND**, pas de refetch ou timestamp reconstitué.
  Une reprise ne sait pas si l'I/O a commencé ou si sa réponse a été perdue.
- quoted : reprendre avec la même quote et intention si les délais restent
  valides ; après close+2 h ou T1, résultat sans fill QUOTE_REJECTED.
- terminal : **DONE**, jamais refaire le pricing ou appliquer le fill.

Pas de garantie exactly-once réseau. Les essais SQLite démontrent atomicité et
idempotence locales ; pas la durabilité d'un futur Worker ou stockage distant.
Une correction de preuve serait un nouvel événement lié au précédent, jamais
une modification de cet historique ; API de correction hors de cet incrément.

## Verify / structure

- Core et machine : `models/p7-prospective-ledger.ts`, tests Vitest.
- Adaptateur SQLite local : `docs/analysis/p7-prospective-ledger-store.mjs` ;
  tests Node avec vrai SQLite et fichiers temporaires hors réseau.
- Tests : identité/phase/deadlines, conflit commandId, quote figée,
  crash avant/après COMMIT, réouverture, aucun double débit, version périmée,
  isolation BTC/ETH, refus conservés, hash corrompu et suppression interdite.
- Aucun nouveau dependency, schéma agent, signal/risque/sizing ou déploiement.
- Relecture complète du journal : démonstrateur local, pas une promesse de
  performance/coût pour 180 jours ou un Worker. Projection incrémentale et
  stockage de payloads/exports feront l'objet de tests et choix ultérieurs.
