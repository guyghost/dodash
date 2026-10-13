# Mesurer les admissions de bougies — schéma 4

Contrat : `models/decision-admission-telemetry.md`. Instrumentation locale,
non déployée par ce lot. Ne pas reclasser les anciens marks `fresh` comme des
admissions exactes. Une admission est l'entrée autorisée dans le calcul,
pas une stratégie terminée avec succès ni un ordre.

## Champs Analytics Engine

Positions anciennes figées : `blob1` type, `blob2` produit, `blob3` mode,
`double1` heure de publication. Nouvelles positions :

- `blob11` identité de cycle ; `blob12` heure de déclenchement en ms décimales ;
- `blob13` `ADMITTED`, `UNOBSERVED` ou `MISSED` ;
- `double19` close de la bougie admise/manquée ;
- `double20` instant d'évaluation à l'admission, seulement pour `ADMITTED`.

Le JSON structuré conserve les horodatages absents comme null. Dans AE, le
statut fait office de présence pour les deux doubles : zéro est aussi un
timestamp valide, jamais une absence lorsque le statut est `ADMITTED`/`MISSED`.

## Lecture bornée

Après un déploiement paper autorisé séparément, choisir `START_MS` et `END_MS`
pour un seul segment/cadence. Exemple de requête (paramètres à remplacer) :

```sql
SELECT _sample_interval AS w, blob1 AS ev, blob2 AS p, blob3 AS mode,
       blob5 AS o, blob6 AS e, blob8 AS vq,
       double1 AS ts, double2 AS lat, double12 AS vobs,
       blob11 AS cid, blob12 AS trigger, blob13 AS admission,
       double19 AS dclose, double20 AS deval
FROM dodash_paper_trading
WHERE index1 = 'btc-usd-paper'
  AND double1 >= START_MS AND double1 < END_MS
ORDER BY ts ASC LIMIT 10000
```

Refuser une capture atteignant 10 000 lignes comme potentiellement tronquée.
Pour les admissions, sélectionner `cycle.completed` + `ADMITTED`, valider
`close ≤ trigger ≤ evaluatedAt ≤ close + seuil`, puis dédupliquer
`(agent, produit, close)`. Une reprise peut republier le même fait durable.

Les `MISSED` sont lus par leur `dclose`, jamais par le jour de `ts` ou le mark.
Ils peuvent coexister avec une ancienne admission hors de la fenêtre attendue :
garder les deux observations, ne pas les soustraire mécaniquement.

## Outil hors réseau

`docs/analysis/market-availability-2026-10-13.py` lit désormais ces colonnes.
Son champ `admissionEvidenceV4` est séparé du proxy historique de mark frais.

- Analyse daily BTC/ETH uniquement, fenêtre 2 h : ne pas utiliser ce compteur
  pour une autre configuration sans protocole adapté.
- `v4-not-observable` et taux null pour les captures legacy sans ces champs.
- `observedLowerBoundRate` : admissions distinctes observées / fenêtres-produit
  calendaires entièrement écoulées, y compris les fenêtres sans ligne.
- `notDemonstratedWindows` ne signifie pas « aucune admission ».
- Ne jamais multiplier le nombre de décisions par `_sample_interval`.

L'échantillonnage et les écritures manquantes interdisent une preuve exhaustive
de couverture depuis AE seul. Un ledger durable complet, lu séparément, serait
nécessaire pour prouver les absences. Aucun lecteur ne pilote le trading.

Les preuves archivées du 13 octobre restent intactes : elles décrivent le
schéma précédent et ne sont pas recalculées sous une nouvelle étiquette.
