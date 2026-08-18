# Revue du modèle du domaine

## Cas nominaux

- Les constructeurs produisent des valeurs immuables pour produit, chandelle, signal, ordre et fill.
- Les séries OHLCV propres sont acceptées dans l’ordre chronologique.
- Les identifiants d’ordre sont reproductibles à entrée identique.

## Erreurs et permissions

- Toute violation renvoie un `Result` avec un code d’erreur fermé ; aucune exception n’est nécessaire au chemin nominal.
- Les permissions ne vivent pas dans les entités : la machine XState les contrôle avant de créer ou soumettre une intention.

## Annulations, retries et terminaux

- Le domaine ne possède aucun effet annulable ni retry. Ceux-ci restent entièrement dans `trading-cycle.machine.ts`.
- Les statuts terminaux d’exécution sont représentés par les issues de cycle, pas par des mutations d’entité.

## Conclusion

Le modèle couvre les valeurs et invariants nécessaires aux stratégies, au risque, à l’allocation, au backtest et aux adapters. Il n’introduit aucune transition implicite et ne dépend d’aucun texte libre.

