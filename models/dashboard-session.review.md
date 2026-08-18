# Revue du modèle de session dashboard

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Credential absent | connexion refusée, aucun effet | Testé |
| Nom de cible vide ou trop long | connexion refusée | Testé |
| Réponse Agent invalide | `error` ou retour `ready`, état non modifié | Modélisé |
| Commande sans permission | reste `ready`, erreur typée | Testé |
| Double clic pendant une requête | état non réceptif à une seconde commande | Modélisé |
| Échec réseau au chargement | `error`, retry explicite | Modélisé |
| Échec réseau après commande | état distant précédent conservé | Testé |
| Kill accidentel | confirmation dédiée obligatoire | Testé |
| Annulation du kill | retour `ready`, aucun effet | Modélisé |
| Déconnexion pendant une requête | retour global `disconnected` | Modélisé |
| Live non activé côté serveur | échec explicite de `start`, aucun optimisme | Couvert par l’Agent |
| État terminal Agent | affiché tel quel; seul `reset` peut être demandé | Couvert par l’Agent |
| Bearer dashboard absent ou erroné | `401`, aucun appel Agent | À tester au proxy |
| Route ou méthode hors allowlist | `404`/`405`, aucun appel Agent | À tester au proxy |
| Nom Agent encodé, vide ou trop long | normalisé ou refusé avant effet | À tester au proxy |
| Corps inattendu ou supérieur à 16 KiB | `413`/`400`, aucun appel Agent | À tester au proxy |
| Headers navigateur malveillants | supprimés; seul le token interne est injecté | À tester au proxy |
| Échec service binding | `502`, aucun retry implicite d'une commande | À tester au proxy |
| Réponse Agent supérieure à 1 MiB | `413`, contenu non relayé | À tester au proxy |
| Secret interne absent ou trop faible | `503`, aucun appel Agent | À tester au proxy |
| Tentative cross-origin navigateur | absence de CORS; le déploiement doit router `/api/*` same-origin | Modélisé |

La machine ne prend aucune décision de trading. Elle autorise seulement des
effets UI typés; `tradingCycleMachine` reste l’unique arbitre des transitions du
bot et le Worker Agent reste l’unique frontière de permission métier.
