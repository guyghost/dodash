# Revue du modèle d'orchestration Hyperliquid

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Admission hors enveloppe | `REFUSED` avant tout événement de machine | Testé |
| Garde de risque en échec à la réémission | machine reste `idle`, résultat `REFUSED` avec code de la machine | Testé |
| Échec de persistance d'intention | `SIGN_FAILED` jamais atteint ; `FAILED` fermé | Testé |
| Échec de signature | `FAILED` après intent persisté | Testé |
| Soumission confirmée / rejetée | issue persistée puis `SETTLED` | Testé |
| Soumission inconnue → réconciliation résolue | issue persistée puis `SETTLED` | Testé |
| Soumission inconnue → réconciliation impossible | `FAILED` ; intention reste non résolue | Testé |
| Échec de persistance de l'issue | `FAILED` ; intention reste non résolue | Testé |
| Crash entre persistance et issue | reprise par alarme : `ORDER_RECOVERY_REQUESTED` → `reconciling` | Testé |
| Reprise d'une intention résolue entre-temps | réconciliation renvoie l'issue réelle, pas une supposition | Testé |
| Double exécution d'un même `clientOrderId` | même cloid déterministe ; la réconciliation est idempotente | Testé |
| Deux ordres simultanés | séquentiels : un runner = un ordre | Modélisé |
| Clé ou signature dans le résultat | impossibles : le type du résultat ne les contient pas | Modélisé (types) |
| Signaux de stratégie | hors jalon : le runner consomme une intention construite | Modélisé (périmètre) |
| Store mémoire vs SQLite | le port est unique ; l'implémentation SQLite viendra au câblage DO | Modélisé |
| Horloge injectée | nonce et horodatages déterministes sous test | Testé |

Le runner n'ouvre aucune voie d'ordre par lui-même : il transforme une
intention déjà validée en issue persistée, et une intention en vol en issue
réconciliée. `hyperliquidPerpOrderMachine` reste l'unique arbitre des
transitions.
