# Revue du modèle de session wallet Base

| Cas | Comportement fermé | Couverture |
| --- | --- | --- |
| Aucun provider injecté | `disconnected`, erreur typée, aucun effet | Testé |
| Refus utilisateur dans le wallet | `failed`, `WALLET_REQUEST_REJECTED`, retry explicite | Testé |
| Adresse retournée en majuscules ou checksum | refusée : seul le format canonique minuscules passe | Testé |
| Payload provider malformé (`chainId` non entier, adresse courte) | `failed`, `WALLET_INVALID_RESPONSE` | Testé |
| Connexion sur une autre chaîne | `wrongChain` explicite, adresse conservée | Testé |
| Retour sur Base après `wrongChain` | `connected` sans redemander les comptes | Testé |
| Changement de compte pendant la session | rotation typée, même état | Testé |
| Révocation des comptes (`[]`) | retour `disconnected` | Testé |
| Changement de chaîne pendant la session | bascule `connected`/`wrongChain` déterministe | Testé |
| Double clic sur connecter pendant `connecting` | `connecting` non réceptif à un second `CONNECT_REQUESTED` | Modélisé |
| Échec provider après connexion établie | `failed`, adresse purgée du contexte | Testé |
| Retry depuis `failed` | seule `CONNECT_REQUESTED` rouvre ; `failed` reste stable sinon | Testé |
| Déconnexion pendant `connecting` | `DISCONNECT_REQUESTED` global ramène à `disconnected` | Testé |
| Session connectée sur Base | capacité perp `LOCKED: ADMISSION_CLOSED` (admission fermée) | Testé |
| Ouverture future de l'admission | chemin `APPROVED` exige `OPEN` + venue nommée ; fermé par la constante figée | Testé |
| Clé privée ou signature dans le contexte | impossible : le type du contexte ne les contient pas | Modélisé (types) |
| Événements wallet après déconnexion | souscriptions retirées par le shell ; événements ignorés | À tester au shell navigateur |
| Wallet sans support d'événements | shell neutralise l'absence de `on`/`removeListener` | À tester au shell navigateur |
| Provider malveillant (réponse lente, double réponse) | la machine n'applique que le premier payload valide ; les suivants sont hors états réceptifs | Modélisé |
| Session wallet et session proxy | machines distinctes : déconnecter le wallet n'affecte pas le proxy et réciproquement | Testé |

La machine ne prend aucune décision de trading et ne parle à aucun réseau
métier. Elle borne uniquement le principal wallet et expose une capacité perp
verrouillée tant que l'exécution Hyperliquid (venue retenue, routée par
l'app Base) n'est pas modélisée : enveloppe de risque figée, machine
d'exécution et clé d'agent revues séparément.
