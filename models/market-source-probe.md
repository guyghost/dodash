# Comparateur de sources depuis Cloudflare — 13 octobre 2026

Statut : normatif, modélisé et revu avant implémentation. Worker diagnostic distinct autorisé
par l'opérateur ; aucune intégration au bot, aucun ordre, aucun transfert,
aucun secret de trading ni binding vers les Workers existants.

## Workflow XState

États `ready → running → completed`, ou `inactive` si configuration/fenêtre
invalide. `START { now }` ouvre le lot uniquement si enabled, timestamps sûrs,
`startedAt ≤ now < expiresAt ≤ startedAt + 24 h`. `RESULT { provider, status }`
compte une observation ; un HTTP 429 bloque le fournisseur pour la suite du
lot. Une observation ignorée est comptée explicitement sans appel réseau.
`EXPIRE` termine un lot en cours : aucun nouvel appel après expiration.
Les résultats n'autorisent aucune transition de trading. Aucun LLM.

Le shell exécute le plan figé séquentiellement, jamais de retry ni rotation
d'adresse/proxy. 15 appels au maximum par lot : 8 fenêtres daily et 7 prix.
Le plan n'accepte aucun URL, actif, méthode ou période fournis par le client.

## Sondes figées

BTC et ETH uniquement ; 240 bougies `ONE_DAY` entièrement closes à l'instant
de début du lot. Exclure les bougies en cours et hors fenêtre ; valider les
OHLCV, alignement UTC, identités et granularité retournées. Compter manquants
et doublons. Une fenêtre n'est prête que si les 240 starts attendus sont
présents exactement une fois.

- Coinbase Advanced public : bougies et produit (`price` = dernier prix fourni).
- Coinbase Exchange public : bougies et ticker (`price`, `time`).
- Hyperliquid perp : `candleSnapshot`, puis un `allMids` partagé BTC/ETH
  (mid ou dernier trade si carnet vide). Ce n'est pas du spot Coinbase.
- dYdX perp : bougies et carnet ; prix = moyenne du meilleur bid/ask non croisé.
  `toISO` est fixé à la clôture de fenêtre (borne de start exclusive observée),
  pas au dernier start attendu ; les bougies en cours sont toujours exclues.

Les appels annoncent un User-Agent diagnostic fixe et transparent. Pas de
rotation du User-Agent ni d'identité pour contourner un limiteur.

Pas de mélange des données de fournisseurs. Les prix de ticker, mid et carnet
sont des mesures distinctes, jamais des prix d'exécution interchangeables.
L'absence d'horodatage de prix amont reste null ; l'heure du fetch ne le remplace
pas. La comparaison de closes utilise le même start de bougie, pas le ticker.
Hyperliquid via Base concerne les fonds et reste hors périmètre.

## Bornes et sécurité

- `GET /health` sans effets ; `POST /probe` exige un token diagnostic ≥ 32
  caractères, aucun paramètre/query/body ; secret distinct du bot.
- Cron `11 * * * *`, inactif par défaut ; fenêtre autorisée de 24 h maximum.
  Le décalage évite le réveil `HH:01` du bot et ses premiers retries : ces
  requêtes peuvent néanmoins partager un quota de sortie, à signaler comme
  influence possible, pas comme une expérience parfaitement indépendante.
  Aucun état de compte, secret broker, stockage KV/DO ou endpoint d'ordre.
- URLs amont fixes, redirects refusés, réponse ≤ 2 MiB, timeout ≤ 10 s et
  borné par la durée restante. Journaux : résumés uniquement, pas de headers
  d'authentification, bodies amont ou erreurs libres.
- Rapports horodatés, runId, version de protocole, lieu `cloudflare-workers`,
  colo d'entrée si connu (pas une preuve d'IP de sortie identique au bot),
  statuts HTTP, latence, Retry-After, cache amont, empreinte du body, qualité.
- Protection globale persistante par quota non implémentée : token détenu
  seulement par l'opérateur ; pas d'accès public aux sondes coûteuses.
- L'expiration coupe les appels amont, pas la ressource Worker/cron. Suppression
  requiert autorisation distincte ; aucun déploiement du bot n'est permis.

## Critères de vérification

Tests : expiration/default fermé, HTTP sans authentification ne fetch pas,
requêtes fixes, 429 bloque le même fournisseur, bornes/contiguïté/identités,
body trop grand, JSON invalide, timeout, aucun trade/binding. Déployer d'abord
inactif, poser le token diagnostic, activer avec bornes, vérifier health et
une sonde manuelle. Les résultats ponctuels ne constituent pas une SLA ;
la première fenêtre daily est attendue à 00:11 sur le cron, pas prétendue mesurée.
