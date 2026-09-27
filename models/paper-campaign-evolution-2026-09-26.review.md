# Revue préparatoire — évolutions paper du 26 septembre 2026

Statut : revue documentaire locale, pas une approbation du conseil swarm-dao.
Objet : `paper-campaign-evolution-2026-09-26.draft.md`.

- Les cinq périmètres sont séparés : valorisation, diagnostic, retry,
  preuves historiques, gouvernance de campagne. Le déploiement est hors livraison.
- Les défauts confirmés par code déployé sont distingués des hypothèses :
  coût d'acquisition exposé comme équité et retry immédiat sont confirmés ;
  l'origine de chaque STALE_MARKET_DATA ne peut pas être isolée depuis AE v2.
- #56 reste ouverte. Le seuil ticker est encore 100 bps dans le Worker.
  Augmenter ce seuil ne démontre pas la fraîcheur d'un ticker : observedAt
  mérite un arbitrage distinct ; la fenêtre d'âge daily de 2 h reste à tester.
- Les événements, transitions proposées, effets et invariants sont explicités.
  Les valeurs de délai et seuils de couverture restent à justifier avant code.
- La séparation LLM/état est conservée ; les propositions ne votent ni
  ne s'approuvent elles-mêmes. Aucune transition runtime n'est modifiée.
- Les critères de vérification doivent porter sur conservation de valeur,
  causalité temporelle, reprise persistée et exactitude des preuves.
- Ne pas modifier le risque au détour d'une correction de télémétrie :
  la sémantique de dailyRisk et l'exposition consolidée nécessitent une revue
  explicite si elles sont affectées par le choix de prix.

Verdict préparatoire des sujets DIAGNOSTICS, RETRIES, HISTORY et CAMPAIGN :
propositions cadrées pour délibération; chacun attend son cycle normatif propre.

## Revue normative DAO #62 — VALUATION

La proposition #62 a reçu 8/8 votes pour, quorum de 100 %, puis passé le
dry-run et les portes de contrôle (`controlled`). Les modèles normatifs
concernés sont maintenant `paper-valuation.md`, `agent-runtime.md`,
`trading-telemetry.md`, `dashboard-pnl-history.md`,
`dashboard-portfolio-summary.md` et `daily-risk.ts`. Les décisions détaillées
et limites de risque sont consignées dans `paper-valuation.review.md` et
`daily-risk.review.md`.

Verdict de revue : prêt pour l’implémentation locale; conserver le nouveau mark
hors machine de trading, ne pas changer l’entrée de dailyRisk ou les gardes
d’admission, et publier les valeurs absentes comme `null` avec qualité.

## Implement / Verify DAO #62 — 2026-09-26

L’implémentation locale est terminée pour la valorisation datée et ses surfaces
runtime, historique, télémétrie et dashboard. Vérifications réussies :
`models` 430/430, `agent` 264/264 et `dashboard` 45/45; TypeScript des trois
paquets et lint Biome des fichiers modifiés réussis. Aucun déploiement ni
changement de `dailyRisk`, garde d’admission ou transition XState n’a eu lieu.
Les autres sujets DIAGNOSTICS, RETRIES, HISTORY et CAMPAIGN restent des
propositions distinctes; ces résultats ne les approuvent ni ne les implémentent.
