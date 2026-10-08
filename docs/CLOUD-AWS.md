# Cloud-Hosts auf AWS (Kapitel 35.6)

Der AWS-Adapter spricht die EC2-, Price-List- und Cost-Explorer-HTTP-APIs direkt (Signature V4 in
`orchestrator/internal/cloud/aws_sigv4.go`, gegen das veröffentlichte AWS-Beispiel geprüft) — **ohne AWS-SDK**.
Er ist nur aktiv, wenn `OMP_CLOUD_PROVIDER=aws` gesetzt ist. Entwurf und Regeln: `ARCHITECTURE.md` §27.

## Sicherheitsnetz: standardmäßig nur Trockenlauf

Ohne `OMP_CLOUD_AWS_ALLOW_LAUNCH=1` sendet der Adapter bei jedem Start nur `RunInstances` mit `DryRun=true`: AWS
prüft Rechte und Parameter, **startet aber nichts und es entstehen keine Kosten**. Erst mit dem Schalter werden
echte Instanzen gestartet. Zusätzlich gelten Pool-Maximum, Budgetdeckel (Tag/Monat) und die Höchstlebensdauer.

## Konfiguration (Umgebung des Orchestrators)

| Variable | Bedeutung |
|---|---|
| `OMP_CLOUD_PROVIDER=aws` | Adapter einschalten |
| `OMP_CLOUD_AWS_REGION` | z. B. `eu-central-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN` (oder dieselben mit Präfix `OMP_CLOUD_AWS_`) | Zugangsdaten; nie in Datenbank oder Repo |
| `OMP_CLOUD_AWS_AMI` | Image mit installiertem `omp-host-agent` |
| `OMP_CLOUD_AWS_SUBNET`, `OMP_CLOUD_AWS_SECURITY_GROUPS` (Komma-Liste), `OMP_CLOUD_AWS_KEY_NAME` | Netz/Zugang |
| `OMP_CLOUD_POOLS` | JSON-Liste, z. B. `[{"name":"burst","region":"eu-central-1","instanceType":"t3.medium","min":0,"max":2,"idleAfterSec":300,"maxLifetimeSec":43200}]` |
| `OMP_CLOUD_USERDATA_FILE` | Bootstrap-Vorlage mit `{{token}}`/`{{host}}`, Beispiel `deploy/cloud/userdata-example.sh` |
| `OMP_CLOUD_DEPLOYMENT` | Markierung dieses Orchestrators an allen Ressourcen (Standard `omp`) |
| `OMP_CLOUD_AWS_ALLOW_LAUNCH=1` | **echte** Starts erlauben (kostet Geld) |

## Was der Adapter tut

- Jede Instanz bekommt die Tags `omp-deployment`, `omp-pool`, `omp-host` und `Name`; IMDSv2 ist Pflicht
  (`HttpTokens=required`), `InstanceInitiatedShutdownBehavior=terminate`, und ein `ClientToken` verhindert doppelte
  Starts derselben Anforderung.
- Abgleich verwaister Instanzen über die Tags (`DescribeInstances` mit Tag-Filter).
- Preise (USD, Linux, On-Demand, Shared) aus der Price-List-API für die Instanztypen der Pools.
- **Ist-Kosten** (`ActualCost`) über Cost Explorer: der Tag `omp-deployment` muss in der Fakturierung als
  Kostenverteilungs-Tag **aktiviert** sein, die Daten kommen mit Verzögerung, und **jede Abfrage kostet selbst Geld**
  — der Orchestrator ruft sie deshalb nie automatisch auf.

## Mindest-Rechte (Ausgangspunkt, vor dem Einsatz im eigenen Konto prüfen)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["ec2:DescribeInstances"], "Resource": "*"},
    {"Effect": "Allow", "Action": ["ec2:RunInstances"], "Resource": [
      "arn:aws:ec2:*::image/*", "arn:aws:ec2:*:*:subnet/*", "arn:aws:ec2:*:*:security-group/*",
      "arn:aws:ec2:*:*:network-interface/*", "arn:aws:ec2:*:*:volume/*", "arn:aws:ec2:*:*:key-pair/*"]},
    {"Effect": "Allow", "Action": ["ec2:RunInstances", "ec2:CreateTags"], "Resource": "arn:aws:ec2:*:*:instance/*",
     "Condition": {"StringEquals": {"aws:RequestTag/omp-deployment": "omp"}}},
    {"Effect": "Allow", "Action": ["ec2:TerminateInstances"], "Resource": "arn:aws:ec2:*:*:instance/*",
     "Condition": {"StringEquals": {"ec2:ResourceTag/omp-deployment": "omp"}}},
    {"Effect": "Allow", "Action": ["pricing:GetProducts"], "Resource": "*"},
    {"Effect": "Allow", "Action": ["ce:GetCostAndUsage"], "Resource": "*"}
  ]
}
```

(`omp` durch den Wert von `OMP_CLOUD_DEPLOYMENT` ersetzen.)

## Erster Test (kostet Geld, nur mit Freigabe)

1. Mit `OMP_CLOUD_AWS_ALLOW_LAUNCH` ungesetzt starten: Preise unter `GET /api/v1/cloud/pricing` prüfen, eine
   Reservierung anlegen — im Log erscheint der Trockenlauf-Befund je Host.
2. Erst danach mit `=1`, kleinster Instanztyp, Reservierung von wenigen Minuten, Pool-Max 1, Tagesdeckel klein.
3. Danach in der AWS-Konsole prüfen, dass **keine** Instanz mit dem Tag `omp-deployment` mehr läuft.

## Nicht geprüft (Stand der Umsetzung)

Alle Aufrufe sind gegen simulierte Antworten und die veröffentlichte Signatur-Testdatei geprüft, **nicht gegen echtes AWS**
(kein Konto/keine Freigabe). Echte Antwortformate (z. B. Price-List-Felder) können abweichen.
