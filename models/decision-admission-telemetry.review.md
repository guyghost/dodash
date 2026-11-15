# Revue — admission de bougie observable

Revue locale avant implémentation, sans revue indépendante externe.
Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

- Capturer l'admission dans un artefact après la transition laisserait une
  fenêtre de crash ; le fait voyage donc avec le contexte déjà persisté.
- Le fait est écrit uniquement par la transition d'admission fraîche ; un
  snapshot reçu/checkpointé ne prouve pas à lui seul son admission.
- Le fait est distinct de `lastDecisionCandleClosedAt`, qui survit à un reset
  pour le dédoublonnage. Une nouvelle alarme efface uniquement le fait du cycle.
- Legacy/incohérent devient `UNOBSERVED`, jamais une absence affirmée.
- Les anciennes positions AE ne bougent pas ; deux doubles libres seulement,
  donc trigger décimal en blob. Les statuts servent de présence explicite.
- L'heure de fin d'une reprise ne remplace jamais l'instant d'admission ni le
  close d'origine d'une alerte manquée.
- Les erreurs de télémétrie restent non bloquantes ; aucun nouveau retry.
- Limite : l'échantillonnage AE ne permet pas une couverture exhaustive ; la
  mesure est exacte pour chaque admission observée, pas pour les absences.

## Vérification après implémentation

- RED : 3 assertions machine échouaient sur l'absence du fait ; 2 nouveaux
  tests de télémétrie échouaient sur le layout v4 et le close manqué.
- GREEN : 523 tests modèles, 313 tests agent ; les 8 scénarios shell existants
  vérifient aussi les admissions AE, doublons et alertes mono/portefeuille.
- 11 tests Python (dont 5 nouveaux) couvrent le compteur v4 : dédoublonnage,
  échantillonnage, fin de cycle tardive, legacy, admission hors fenêtre et
  close manqué d'origine. Les captures archivées n'ont pas été réécrites.
- `npm run check`, `npm run build`, `npm run scan:secrets`, lint ciblé et
  `git diff --check` passent.
- Premier `npm test` global : timeout 5 s d'un backtest préexistant pendant
  les builds/checks concurrents, pas d'échec d'assertion métier. Le fichier
  isolé passe en 2,52 s ; la suite globale relancée sans builds concurrents
  passe (19 tâches). Contention probable, pas de modification du timeout,
  de désactivation de test ni de changement du code de backtest.
- Le lint global reste bloqué par les preuves JSON concaténées préexistantes
  documentées dans les revues précédentes ; ces fichiers restent intacts.
- Relecture locale : champ jamais consulté par une garde, écrit seulement
  après l'admission fraîche, normalisé avant restauration mono/portefeuille ;
  positions AE anciennes inchangées, limite de 20 doubles respectée.
- Aucun push, déploiement, ordre réel, changement de source ni de stratégie.
  La comparaison shadow depuis Cloudflare et la preuve déployée restent à faire.
