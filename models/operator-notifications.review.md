# Revue du modèle de notification opérateur

Le modèle respecte la frontière établie par `trading-telemetry.md` : la
notification est un signal de sortie, jamais une entrée de décision. Les cinq
classes couvrent exactement les alertes figées évaluables dans le Durable
Object ; les classes issues de sondes externes sont explicitement hors scope
pour éviter un glissement vers une couche de supervision dans le runtime.

Décisions de revue :

- **Seuils figés et localisés dans le modèle.** `-1000` USD et `20000` USD ne
  doivent apparaître nulle part ailleurs dans le code que comme projection de
  ce fichier. Toute divergence est un défaut de revue.
- **Une classe = une notification.** Un enregistrement satisfaisant plusieurs
  classes produit plusieurs notifications distinctes, ce qui garde le
  récepteur capable de compter les causes ; la déduplication 60 s ne s'applique
  qu'à une classe répétée, pas à des classes différentes d'un même
  enregistrement.
- **Pas de file d'attente ni de persistance des notifications.** Un canal
  durable transformerait l'effet en état ; le modèle exige le contraire. La
  perte d'une notification après échec définitif est assumée et compensée par
  les alertes de la couche supervision.
- **HMAC sur le corps brut.** La signature porte les octets exactement envoyés ;
  toute resérialisation entre signature et envoi invaliderait la vérification
  côté récepteur.
- **Preflight fail-closed.** `OPERATOR_NOTIFICATIONS_MISSING` s'insère après
  `TELEMETRY_MISSING` dans l'ordre des raisons : un mode live sans canal
  d'alerte est refusé au même titre qu'un mode live sans télémétrie.

Risques résiduels acceptés :

- une destination webhook unique est un point de défaillance ; la mitigation
  (runbook opérateur) reste de la responsabilité de la couche supervision ;
- la fenêtre de déduplication de 60 s peut masquer deux occurrences légitimes
  d'une même classe en moins d'une minute ; l'alternative (tempête de
  notifications sur des cycles en échec en boucle) est pire.

Le modèle est prêt pour l'implémentation.
