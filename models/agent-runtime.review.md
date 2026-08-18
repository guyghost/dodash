# Revue du modèle d’exécution Agent

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Démarrage sans permission | événement refusé par XState | Couvert |
| Commande non authentifiée | refus HTTP avant RPC | Couvert |
| Modification directe du state | `validateStateChange` lève une erreur | Couvert |
| Réveil dupliqué | `ALARM_FIRED` dupliqué est ignoré | Couvert |
| Retry | phase `retrying*`, reprise au réveil suivant | Couvert |
| Crash avant soumission | phase et intention déjà persistées | Couvert |
| Crash après soumission possible | réconciliation obligatoire | Couvert |
| Kill pendant un cycle | annulation ou réconciliation selon la phase | Couvert |
| Échec de persistance | aucun rescheduling avant succès | Couvert |
| État terminal | `failed`/`halted`, reprise uniquement par `RESET` | Couvert |
| Secret/JWT | jamais dans state, SQL ou logs | Couvert |

La projection phase → effet est totale pour les phases actives et ne contient
aucune branche pilotée par un texte libre. Le mode paper et le mode live
partagent les mêmes événements ; seuls leurs adapters d’autorisation,
d’exécution et de réconciliation diffèrent.
