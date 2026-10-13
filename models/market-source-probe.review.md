# Revue — comparateur de sources

Revue locale préalable. **APPROUVÉ POUR IMPLÉMENTATION ET DÉPLOIEMENT DIAGNOSTIC
ISOLÉ**, conformément à l'autorisation explicite de l'opérateur.

- Le plan fixe empêche SSRF et sondes arbitraires ; pas de clé exchange.
- Un 429 ne déclenche ni retry immédiat ni contournement ; le modèle bloque
  les autres appels au même fournisseur dans le lot.
- 240 daily closes reproduisent la profondeur utile de la campagne P7 sans
  en choisir les signaux ou changer ses prix.
- Différences spot/perp et prix last/mid/book gardées explicites.
- Expiration de 24 h et configuration fermée par défaut ; le cron peut rester
  installé mais n'effectue plus de sondes après expiration.
- Pas de stockage supplémentaire ; rapports HTTP archivés et logs résumés.
- Limites : pas de quota global durable, pas d'IP de sortie prouvée identique
  au DO du bot, pas de SLA conclue sur un lot ni de réconciliation d'ordres.
- Le cron est décalé à HH:11 pour ne pas sonder sur le réveil HH:01 du bot.
  L'influence d'un éventuel quota de sortie partagé ne peut pas être exclue.
- Vérification runtime : Cloudflare peut fournir un stream vide pour POST.
  Le shell accepte uniquement un stream terminé dès la première lecture et
  annule tout stream contenant un chunk ; aucun contenu client n'est utilisé.
- Workerd refuse `redirect: error` avant tout appel réseau. Utiliser `manual`
  sans suivre le Location : les 3xx deviennent HTTP_ERROR. Smoke test du bundle
  dans le runtime Wrangler avec amont remplacé et redirects hostiles.
- Première capture : dYdX retourne 239 starts et manque exactement le dernier
  lorsque toISO = dernier start. Correction revue : toISO = closedAt, avec
  filtrage strict des bougies en cours. User-Agent diagnostic fixe ajouté
  pour identifier le client ; les 400 Exchange initiaux restent des résultats
  non concluants, sans diagnostic de panne ni cause affirmée.

## Revue de l'implémentation / Verify

- Correctness : plan de 15 requêtes, bougies UTC closes validées par le domaine,
  tests des quatre formats, fenêtre complète/ouverte/trou/doublon, blocage 429,
  timeout et taille de réponse. Vérification réelle BTC/ETH archivée.
- Architecture : XState décide ouverture/fin/blocage du lot ; shell séparé
  pour fetch et auth, normalisation pure. Aucun lien de décision avec le bot.
- Security : URLs fixes, redirects non suivis, token distinct, auth avant I/O,
  aucun body amont/erreur libre/token dans les rapports. Captures tail filtrées.
- Performance : séquentiel, ≤15 appels/lot, body ≤2 MiB, timeout ≤10 s borné
  par la fenêtre. Dépendances déjà présentes dans le workspace ; bundle gzip
  ≈136 KiB. Pas de nouveau stockage distant.
- Lisibilité : plan, normalisation, shell et route distincts ; protocole et
  limites décrits. Pas de code de trading ou de fallback automatique ajouté.
- Vérifications : 526 tests modèles, 313 agent, 15 comparateur, smoke workerd,
  TypeScript/global build, lint ciblé, scan secrets. Audit sans high/critical
  (11 moderate). Lint global bloqué par un JSON préexistant laissé intact.

**Verdict : accepté pour le diagnostic borné uniquement.** Observations réelles
429 Advanced puis Exchange, sans Retry-After ; aucune cause du quota affirmée.
Cron installé mais non observé dans le tail initial de 150 s ; propagation
possible, pas de preuve de SLA. Expiration non prolongée après les corrections.
