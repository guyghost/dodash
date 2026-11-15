# Revue — fraîcheur marché lors d'une reprise (13 octobre 2026)

Revue locale du contrat avant implémentation, sans revue indépendante externe.
Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

| Risque / cas | Conclusion |
| --- | --- |
| Âge réel masqué par l'heure du trigger | `evaluatedAt` obligatoire, garde pure sur l'âge courant |
| Latence du checkpoint | Horloge lue après checkpoint, juste avant l'événement |
| Frontière de 2 h | Inclusive, seuil inchangé ; +1 ms rejeté |
| Reprise après minuit | `candleClosedAt ≤ triggeredAt` préserve l'identité du cycle |
| Snapshot legacy en retry | Nouveau fetch émet le nouvel instant, pas de migration d'état |
| Événement legacy / temps invalide | Refus de calcul, voie stale existante |
| Bougie déjà décidée | Dédoublonnage prioritaire conservé, aucun recalcul |
| Stop/kill | Garde prioritaire existante, pas de nouvelle transition |
| Retries stale hors fenêtre | Refetchs bornés existants conservés, pas de boucle nouvelle |

Limite explicite : pas de réévaluation des phases déjà passées au calcul,
ni de garantie de soumission avant l'échéance. Ce lot corrige l'admission de
données expirées ; il ne constitue pas un gate de lancement live.

## Vérification après implémentation

- RED : 9 nouveaux cas du modèle et la reproduction dans l'interpréteur
  échouaient avant correction (entrée indue en calcul).
- GREEN : 500 tests modèles et 299 tests agent passent ; 16 nouveaux cas
  couvrent frontières, horloge invalide/legacy, minuit, reprise tardive,
  latence fetch/checkpoint et stop pendant l'attente.
- `npm test`, `npm run check`, `npm run build` du monorepo passent
  (Turborepo réutilise aussi les résultats des paquets inchangés).
- Lint ciblé des 9 fichiers TypeScript modifiés et `git diff --check` passent.
- `npm run scan:secrets` passe (tests de frontières, CI et scan inclus).
- **Lint global bloqué** : le fichier local préexistant non suivi
  `docs/analysis/evidence-paper-2026-10-08/market-data-tail-2026-10-07T2240-2308.json`
  contient des objets JSON concaténés ; aucune correction de ces preuves ni
  exclusion de lint n'a été faite. Des avertissements existants subsistent.
- Les fixtures temporelles injectent désormais leur horloge synthétique.
  La fixture funding paper utilisait des bougies daily avec le timeframe
  minute par défaut : elle indique maintenant `ONE_DAY` explicitement.
- Relecture locale : garde pure, lecture temporelle après checkpoint,
  dédoublonnage et priorité stop inchangés, aucune migration ni dépendance.
  Pas de revue indépendante, de test SDK Durable Object ni de preuve de
  fonctionnement déployé revendiqués pour ce lot.
- Aucun déploiement, ordre réel, changement de stratégie, seuil ou dashboard.
