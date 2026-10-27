package profile

import (
	"strings"
	"testing"
)

func ids(f []Finding) string {
	var s []string
	for _, x := range f {
		s = append(s, x.ID)
	}
	return strings.Join(s, ",")
}

func hardened() Inputs {
	return Inputs{
		PostgresURL: "postgres://omp:S3cure-und-lang@db1,db2/omp", NatsURL: "tls://nats:4222", NatsTLS: true, RegistryTLS: true, NodeMTLS: true,
		MetricsToken: "t", BackupPassphrase: "p", BackupCopyDir: "/mnt/far", ClusterPeers: "b=1.2.3.4:7000,c=1.2.3.5:7000",
	}
}

func TestHardenedConfigHasNoFindings(t *testing.T) {
	if f := Evaluate(hardened()); len(f) != 0 {
		t.Fatalf("%s", ids(f))
	}
}

func TestDevStackIsFlaggedCriticalFirst(t *testing.T) {
	f := Evaluate(Inputs{PostgresURL: "postgres://omp:omp@localhost:5432,localhost:5442/omp?sslmode=disable", NatsURL: "nats://localhost:4222", ClusterPeers: "b=x"})
	if len(f) < 5 || f[0].Severity != Critical {
		t.Fatalf("%s", ids(f))
	}
	have := ids(f)
	for _, want := range []string{"postgres-default-credentials", "nats-plain", "cluster-quorum", "node-mtls-off", "backup-no-keys"} {
		if !strings.Contains(have, want) {
			t.Errorf("fehlt: %s in %s", want, have)
		}
	}
	// Kritische stehen vor Warnungen.
	seenWarn := false
	for _, x := range f {
		if x.Severity == Warning {
			seenWarn = true
		} else if seenWarn {
			t.Fatalf("kritisch nach Warnung: %s", ids(f))
		}
	}
}

func TestPostgresPasswordRules(t *testing.T) {
	for dsn, want := range map[string]bool{
		"postgres://omp:omp@h/omp": true, "postgres://omp@h/omp": true, "postgres://u:u@h/db": true, "postgres://u:%73ecret-und-lang@h/db": false,
		"postgres://omp:@h/omp": true, "": false,
	} {
		if got := postgresDefaultCreds(dsn); got != want {
			t.Errorf("%q: %v", dsn, got)
		}
	}
}

func TestClusterSize(t *testing.T) {
	cases := map[string]string{"": "cluster-single", "b=x": "cluster-quorum"}
	for peers, want := range cases {
		in := hardened()
		in.ClusterPeers = peers
		if !strings.Contains(ids(Evaluate(in)), want) {
			t.Errorf("%q: %s", peers, ids(Evaluate(in)))
		}
	}
	in := hardened()
	in.ClusterPeers = "b=x,c=y"
	if strings.Contains(ids(Evaluate(in)), "cluster") {
		t.Fatal("drei Knoten sind ausreichend")
	}
}

func TestEnforceOnlyInProductionAndHonoursAccept(t *testing.T) {
	f := Evaluate(Inputs{PostgresURL: "postgres://omp:omp@h/omp", NatsURL: "nats://x", ClusterPeers: "a=1,b=2"})
	if err := Enforce("dev", f, nil); err != nil {
		t.Fatal("Entwicklungsprofil blockiert nie")
	}
	err := Enforce("production", f, nil)
	if err == nil || !strings.Contains(err.Error(), "postgres-default-credentials") || !strings.Contains(err.Error(), "nats-plain") {
		t.Fatalf("%v", err)
	}
	if err := Enforce("Production", f, Accepted("postgres-default-credentials, nats-plain")); err != nil {
		t.Fatalf("alles Kritische akzeptiert: %v", err)
	}
	if err := Enforce("production", f, Accepted("nats-plain")); err == nil {
		t.Fatal("Postgres ist noch offen")
	}
}
