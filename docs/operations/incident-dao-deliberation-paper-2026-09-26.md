# Incident — délibération DAO #57 rejetée sans vote

**Date** : 26 septembre 2026
**Proposition** : #57, valorisation paper
**Statut** : la machine DAO a inscrit `rejected` ; **aucun vote n'a été exprimé**.

## Symptôme

La délibération s'est terminée en 86 ms, quorum 0 % et zéro vote valable sur 8.
Les huit agents ont renvoyé :

```text
herdr workspace create failed: PermissionDenied / Operation not permitted
```

L'adaptateur Herdr a alors converti huit erreurs de lancement en abstentions et
le tally déterministe a rejeté #57. Ce rejet ne représente pas l'avis du conseil.

## Diagnostic disponible

- `.dao/audit.jsonl` confirme `deliberation_started` puis `deliberation_rejected`;
  la proposition est `rejected` au lieu de `open`.
- `swarm-dao doctor` est vert ; Herdr 0.9.1 répond et son serveur est `running`.
- La commande a été lancée depuis un shell qui n'est pas un pane Herdr géré.
  Le skill dynamique Herdr exige que `HERDR_ENV=1` avant toute commande de
  contrôle et prescrit l'arrêt quand cette condition manque. Le shell courant
  ne satisfait pas ce prérequis. Aucun nouvel agent ou workspace ne doit donc
  être lancé depuis ce contexte.
- Incident antérieur documenté :
  `docs/operations/bug-dao-deliberation-extension-e-2026-09-18.md` — les erreurs
  d'infrastructure peuvent déjà provoquer un rejet par quorum nul. Une note
  plus ancienne documente l'absence de transition de récupération d'un état
  terminal : `docs/operations/bug-dao-stuck-failed-state-2026-08-31.md`.

## Réponse sûre au moment de l'incident

Aucun autre vote n'a été tenté. Les propositions #58–#61 restent `open` et sans
vote ; elles ne sont ni délibérées, ni contrôlées, ni implémentées. Aucun vote
n'a été saisi manuellement et aucun statut DAO n'a été forcé. La #56 reste
inchangée.

Ne pas créer de proposition successeur à #57 avant d'avoir corrigé le protocole
DAO pour que zéro lancement d'agent ne puisse être compté comme un rejet. Puis
reprendre #57 par une voie de réouverture gouvernée et auditée, si elle existe ;
à défaut, obtenir une décision humaine sur la création d'un successeur qui cite
l'incident. Rejouer depuis un pane Herdr géré exige d'abord le contexte autorisé
par le skill Herdr.

## Correction à apporter au DAO

1. distinguer l'état `infrastructure failure / no tally` du vote `rejected` ;
2. ne persister aucun rejet quand zéro agent a pu participer ;
3. fournir une transition de relance auditée depuis cet état sans contourner les
gates ;
4. vérifier ces cas avec tests, puis répéter une délibération et comparer la
   présence effective de bulletins et la révision d'état.

## Mise à jour après décision autorisée — 2026-09-26

L'état ci-dessus est le relevé initial de l'incident. Après autorisation
explicite de l'utilisateur, le successeur #62 a été créé puis délibéré : 8/8
bulletins valides pour, quorum 100 %, poids `FOR` 17; son dry-run a conclu
« With Caution » et les portes de contrôle ont réussi (`controlled`). #57
reste rejetée sans vote et n'a été ni réouverte ni rejouée. #58 a également
été rejetée sur échec de quorum après une tentative dont les prompts de rôle
étaient incompatibles avec l'exécution sans outils; aucun résultat ne lui a
été substitué. #59 et #61 restent bloquées par leur dépendance à #58 (et #61
par #57); #60 demeure indépendante. Aucune transition d'état DAO n'a été
forcée et aucun vote n'a été saisi manuellement.

La décision #62 porte uniquement sur la valorisation paper datée. Son cycle
local Model → Review → Implement → Verify est documenté dans
`models/paper-valuation.review.md` et les revues liées. Elle n'autorise pas le
ship/deploy ni l'implémentation des autres propositions.
