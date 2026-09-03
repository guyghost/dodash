# Modèle de notification opérateur

Status: normative
Proposal: swarm-dao #23

Le canal de notification est un effet de bord de sortie. Il ne sélectionne
jamais une transition XState, ne bloque jamais un cycle et ne modifie jamais
une décision de risque ou d'allocation. Sa seule entrée est un enregistrement
de télémétrie déjà émis ; sa seule sortie est une requête HTTP signée.

## Événements notifiables

Une notification est émise exactement quand l'une des conditions figées
ci-dessous est vraie au moment de l'émission télémétrie. Les seuils sont
identiques aux alertes figées de `trading-telemetry.md` ; les modifier exige
une revue de modèle et invalide les preuves d'opérations.

| Classe | Source | Condition |
| --- | --- | --- |
| `CYCLE_FAILED` | `cycle.completed` | `outcome === "FAILED"` |
| `ORDER_OUTCOME_UNKNOWN` | `cycle.completed` | `errorCode === "ORDER_OUTCOME_UNKNOWN"` |
| `DAILY_PNL_BREACH` | `cycle.completed` | `dailyPnl !== null && dailyPnl <= -1000` |
| `EXPOSURE_BREACH` | `cycle.completed` | `otherExposureNotional !== null && otherExposureNotional > 20000` |
| `CONTROL_FAILED` | `control.completed` | `outcome === "FAILED"` |

Une émission télémétrie peut satisfaire plusieurs classes ; chaque classe
satisfaite produit exactement une notification par enregistrement. Les classes
déduites de sondes externes (`NO_LIVE_CYCLE` à 120 minutes, santé des Workers,
taux d'échec d'authentification) restent hors du Durable Object : elles
appartiennent à la couche de supervision et ne sont pas traitées ici.

## Payload

```json
{
  "schemaVersion": 1,
  "notificationId": "<uuid v4>",
  "class": "CYCLE_FAILED",
  "timestamp": 1730000000000,
  "agentId": "…",
  "productId": "…",
  "executionMode": "paper | live | perp",
  "phase": "…",
  "outcome": "…",
  "errorCode": "… | null"
}
```

Interdits dans le payload : soldes, clés, JWT, identifiants d'ordre internes
au-delà du code d'erreur fermé. Le champ `notificationId` garantit
l'idempotence côté récepteur.

## Transport et signature

- Une seule destination : URL webhook fournie par le secret
  `OPERATOR_NOTIFY_WEBHOOK_URL` ; secret de signature
  `OPERATOR_NOTIFY_SECRET` (≥ 32 caractères). Le canal est actif si et
  seulement si les deux sont présents et valides.
- `POST` JSON, en-tête `content-type: application/json` et
  `x-dodash-signature: hex(HMAC-SHA256(secret, corps brut))`.
- Délai d'attente par tentative : 5 s (`AbortSignal.timeout`).
- Retry : au plus une seconde tentative, uniquement sur échec réseau ou
  timeout, jamais sur réponse HTTP 4xx. Aucun mécanisme de file d'attente :
  un échec définitif est perdu et journalisé.

## Discipline d'émission

- Fire-and-forget : l'appelant n'attend pas le résultat réseau et ne peut pas
  recevoir d'exception ; toute erreur est journalisée en JSON structuré
  (`operator-notification.delivery_failed`).
- Déduplication : une classe identique (agent, classe) est supprimée pendant
  60 s après la dernière notification envoyée de cette classe. La fenêtre est
  évaluée avec l'horloge injectable ; aucune horloge globale dans le cœur.
- Aucun état de notification n'entre dans le contexte XState ni dans SQLite.

## Preflight

La preuve `operatorNotificationsConfigured` rejoint `LivePreflightEvidence`.
Son absence rejette une activation live avec la raison fermée
`OPERATOR_NOTIFICATIONS_MISSING` : un mode live sans canal de notification
n'est pas déployable.

## Invariants

1. Aucune notification ne change une transition, un risque ou une allocation.
2. Une classe satisfaite produit exactement une notification par
   enregistrement de télémétrie, après déduplication.
3. Aucune exception réseau ne remonte à l'appelant.
4. Aucun secret ni solde ne quitte le process dans le payload.
5. Les seuils sont figés dans ce fichier avant implémentation ; le code ne
   contient aucune constante de seuil divergente.
