# Revue du modèle de preuve de release live-OFF

Statut : APPROUVÉ POUR IMPLÉMENTATION

## Couverture exigée

| Cas | Décision attendue |
| --- | --- |
| SHA complet, UTC, live OFF et tous les gates verts | preuve acceptée |
| SHA court, majuscule ou non hexadécimal | `INVALID_RELEASE_SHA` |
| instant absent, invalide ou non UTC canonique | `INVALID_GENERATED_AT` |
| live activé ou valeur ambiguë | `LIVE_TRADING_NOT_DISABLED` |
| gate absent, inconnu ou non réussi | refus fail-closed |
| JSON mal formé ou champs supplémentaires | `INVALID_EVIDENCE` |
| preuve nominale sérialisée puis relue | validation identique |

## Corrections imposées à l'implémentation

1. Garder la décision dans `models/`, sans I/O, horloge ou lecture Git.
2. Utiliser un résultat discriminé et ne pas lever d'exception métier.
3. Construire une nouvelle valeur gelée sans muter l'entrée.
4. Refuser les propriétés supplémentaires pour éviter une preuve ambiguë.
5. Tester le modèle avant d'implémenter le générateur.
6. Le CLI doit valider après sérialisation et refuser d'écraser un fichier.
7. L'intégration CI s'exécute après le gate existant, avec live explicitement
   OFF, et publie uniquement l'artefact JSON ; elle ne déploie rien.

## Verdict

Le modèle rend explicites la décision, les invariants et la frontière d'effets.
Il n'introduit pas de workflow d'état long : une machine XState n'apporterait
aucune transition utile pour cette validation atomique. **GO pour
implémentation**, sous réserve d'un cycle TDD rouge → vert.
