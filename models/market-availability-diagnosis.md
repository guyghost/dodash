# Diagnostic disponibilité marché — protocole du 13 octobre 2026

Statut : figé avant nouvelle collecte. Lecture seule ; aucune transition,
stratégie, permission, source runtime ou campagne économique modifiée.

## Collecte bornée

- Capture Analytics Engine de `btc-usd-paper` depuis le déploiement agent du
  7 octobre à 22:39 UTC jusqu'à l'instant de capture ; maximum 10 000 lignes,
  tout résultat atteignant cette borne est refusé comme possiblement tronqué.
- Métadonnées des déploiements agent/marché, sans secrets ni configuration.
- Journaux marché archivés du 7 octobre, lus comme une séquence JSON (sans
  modifier le fichier local préexistant qui les contient).
- Complément de diagnostic : tail marché live borné à 330 s, sans appeler
  l'API de contrôle du bot. Seuls les événements marché et leurs champs
  autorisés sont archivés ; aucun header d'authentification ni log libre.
- Sondes publiques : une requête de bougies closes BTC/ETH par fournisseur,
  Coinbase Advanced + Exchange, Hyperliquid perp et dYdX Indexer ; aucun
  retry automatique sur 429, aucune rotation d'IP, clé, proxy ou adresse.
- Chaque sonde est horodatée et indique son lieu d'exécution. Une sonde locale
  n'est pas une mesure de disponibilité depuis un Worker Cloudflare.

## Mesures et limites

- Les erreurs de cycle `RATE_LIMITED` indiquent des cycles affectés, pas un
  décompte de requêtes HTTP 429. `latency > 0` n'est pas une preuve de fetch.
- Les journaux `coinbase_market_request` permettent seuls, dans leur fenêtre,
  une ventilation exacte par endpoint, cache et statut HTTP.
- Couverture daily : calendrier indépendant des lignes reçues, BTC/ETH,
  fenêtres UTC [00:00, 02:00] entièrement incluses dans la capture.
- Une fenêtre a une **décision compatible observée** si une ligne terminale
  `NO_ACTION`, `RISK_REJECTED`, `ORDER_CONFIRMED` ou `ORDER_REJECTED`, erreur
  `NONE`/`RATE_LIMITED`, porte un mark `fresh` du close attendu et un événement
  terminé au plus tard à 02:00. Dédoublonner par produit et close.
- Ce proxy est conservateur, pas une preuve d'admission exacte : la télémétrie
  ne porte ni `cycleId`, ni `lastDecisionCandleClosedAt`, ni `triggeredAt`.
  Sans ligne compatible, classer **non démontré**, pas « aucune décision ».
- La fraction compatible / fenêtres attendues est un taux d'observation.
  L'échantillonnage AE > 1 interdit de déclarer une absence exacte ; afficher
  les poids sans multiplier le nombre de décisions distinctes.
- `decision.missed` est compté séparément, jamais attribué à une bougie par
  le jour d'émission seul (une reprise peut franchir minuit).
- Aucun résultat de cette collecte ne valide un edge économique ou le
  fonctionnement des correctifs locaux non déployés.

## Revue avant collecte

Revue locale : critères préfixés, fenêtres manquantes conservées au
dénominateur, pas de biais « seuls les jours avec cycle », pas de remplacement
silencieux spot USD par perp/USDC. APPROUVÉ POUR DIAGNOSTIC LECTURE SEULE.

Les alternatives seront évaluées sur la disponibilité, profondeur historique,
type de prix, devise, coût API et coût d'intégration. Base est traité comme
réseau/route de fonds éventuelle, pas présumé héberger le carnet Hyperliquid.

## Annexe de diagnostic des bornes (avant sondes supplémentaires)

Les premières sondes ne retournent pas toutes les mêmes dernières bougies.
Tester une seule fois par actif Coinbase Advanced avec `end = minuit UTC`
et `start = end − 3 jours`, en conservant l'autre réponse obtenue avec
`end = début de la dernière bougie close`. Comparer les timestamps retournés,
pas la rentabilité. La doc ne précise pas explicitement l'inclusivité de `end`.
Une bougie en cours éventuellement renvoyée par Exchange est exclue.
