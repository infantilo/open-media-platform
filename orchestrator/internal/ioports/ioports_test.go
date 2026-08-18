package ioports

import (
	"database/sql"
	"fmt"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
)

// cleanTables leert io_port_claims/host_io_ports/hosts vor UND nach dem
// Test (gleiches Muster wie internal/launcher/store_test.go) — Claim()
// sucht ohne preferredHostID absichtlich über ALLE Hosts hinweg, ein
// stehengebliebener Port aus einem früheren Test in derselben isolierten
// "_test"-Datenbank (dbtest.Open, s. dortiger Paketkommentar) würde sonst
// fälschlich als Treffer gefunden.
func cleanTables(t *testing.T, database interface {
	Exec(query string, args ...any) (sql.Result, error)
}) {
	t.Helper()
	clean := func() {
		_, _ = database.Exec(`DELETE FROM io_port_claims`)
		_, _ = database.Exec(`DELETE FROM host_io_ports`)
		_, _ = database.Exec(`DELETE FROM hosts`)
	}
	clean()
	t.Cleanup(clean)
}

// newTestHost legt einen Host an — host_io_ports/io_port_claims
// referenzieren hosts.id per Fremdschlüssel, jeder Test braucht also
// mindestens einen echten Host-Datensatz.
func newTestHost(t *testing.T, hostStore *hosts.Store) string {
	t.Helper()
	h, err := hostStore.CreateHost("test-host", "test-host.local", nil)
	if err != nil {
		t.Fatalf("CreateHost() error = %v", err)
	}
	return h.ID
}

func TestSetInventoryAndListInventory(t *testing.T) {
	database := dbtest.Open(t)
	cleanTables(t, database)
	hostStore := hosts.NewStore(database)
	store := NewStore(database)
	hostID := newTestHost(t, hostStore)

	ports := []Port{
		{HostID: hostID, PortID: "decklink-0-in", CardType: "decklink", Direction: "in", Label: "DeckLink 1 In"},
		{HostID: hostID, PortID: "decklink-0-out", CardType: "decklink", Direction: "out", Label: "DeckLink 1 Out"},
	}
	if err := store.SetInventory(hostID, ports); err != nil {
		t.Fatalf("SetInventory() error = %v", err)
	}

	got, err := store.ListInventory(hostID)
	if err != nil {
		t.Fatalf("ListInventory() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("ListInventory() = %+v, want 2 ports", got)
	}
	if got[0].PortID != "decklink-0-in" || got[0].Direction != "in" {
		t.Errorf("ports[0] = %+v, want decklink-0-in/in", got[0])
	}
}

func TestSetInventoryRemovesStaleUnclaimedPorts(t *testing.T) {
	database := dbtest.Open(t)
	cleanTables(t, database)
	hostStore := hosts.NewStore(database)
	store := NewStore(database)
	hostID := newTestHost(t, hostStore)

	if err := store.SetInventory(hostID, []Port{
		{HostID: hostID, PortID: "p1", CardType: "decklink", Direction: "in"},
		{HostID: hostID, PortID: "p2", CardType: "decklink", Direction: "in"},
	}); err != nil {
		t.Fatalf("SetInventory() error = %v", err)
	}

	// Re-Register meldet nur noch p1 — p2 muss verschwinden.
	if err := store.SetInventory(hostID, []Port{
		{HostID: hostID, PortID: "p1", CardType: "decklink", Direction: "in"},
	}); err != nil {
		t.Fatalf("SetInventory() (second call) error = %v", err)
	}

	got, err := store.ListInventory(hostID)
	if err != nil {
		t.Fatalf("ListInventory() error = %v", err)
	}
	if len(got) != 1 || got[0].PortID != "p1" {
		t.Fatalf("ListInventory() after re-register = %+v, want only p1", got)
	}
}

func TestSetInventoryKeepsClaimedPortsEvenIfNotReReported(t *testing.T) {
	database := dbtest.Open(t)
	cleanTables(t, database)
	hostStore := hosts.NewStore(database)
	store := NewStore(database)
	hostID := newTestHost(t, hostStore)

	if err := store.SetInventory(hostID, []Port{
		{HostID: hostID, PortID: "p1", CardType: "decklink", Direction: "in"},
	}); err != nil {
		t.Fatalf("SetInventory() error = %v", err)
	}
	if _, _, ok, err := store.Claim("decklink", "in", hostID, "wf1", "ingest", "inst1"); err != nil || !ok {
		t.Fatalf("Claim() = (ok=%v, err=%v), want ok=true", ok, err)
	}

	// Re-Register meldet p1 nicht mehr — der Claim existiert weiterhin,
	// darf nicht stillschweigend verschwinden (s. SetInventory-Doku).
	if err := store.SetInventory(hostID, []Port{}); err != nil {
		t.Fatalf("SetInventory() (empty) error = %v", err)
	}

	got, err := store.ListInventory(hostID)
	if err != nil {
		t.Fatalf("ListInventory() error = %v", err)
	}
	if len(got) != 1 || got[0].PortID != "p1" {
		t.Fatalf("ListInventory() after empty re-register = %+v, want p1 to survive (claimed)", got)
	}
}

func TestClaimIsExclusiveAndReleaseFreesIt(t *testing.T) {
	database := dbtest.Open(t)
	cleanTables(t, database)
	hostStore := hosts.NewStore(database)
	store := NewStore(database)
	hostID := newTestHost(t, hostStore)

	if err := store.SetInventory(hostID, []Port{
		{HostID: hostID, PortID: "p1", CardType: "decklink", Direction: "in"},
	}); err != nil {
		t.Fatalf("SetInventory() error = %v", err)
	}

	gotHost, gotPort, ok, err := store.Claim("decklink", "in", "", "wf1", "ingest", "inst1")
	if err != nil || !ok || gotHost != hostID || gotPort != "p1" {
		t.Fatalf("first Claim() = (%q, %q, %v, %v), want (%q, p1, true, nil)", gotHost, gotPort, ok, err, hostID)
	}

	// Zweiter Claim auf denselben Typ/Richtung/Host: kein freier Port mehr.
	_, _, ok, err = store.Claim("decklink", "in", "", "wf2", "ingest", "inst2")
	if err != nil {
		t.Fatalf("second Claim() error = %v", err)
	}
	if ok {
		t.Fatal("second Claim() = ok=true, want false — port is already claimed")
	}

	if err := store.Release("wf1", "ingest"); err != nil {
		t.Fatalf("Release() error = %v", err)
	}

	// Nach Release muss der Port wieder claimbar sein.
	gotHost, gotPort, ok, err = store.Claim("decklink", "in", "", "wf2", "ingest", "inst2")
	if err != nil || !ok || gotHost != hostID || gotPort != "p1" {
		t.Fatalf("Claim() after Release = (%q, %q, %v, %v), want (%q, p1, true, nil)", gotHost, gotPort, ok, err, hostID)
	}
}

func TestUpdateInstanceID(t *testing.T) {
	database := dbtest.Open(t)
	cleanTables(t, database)
	hostStore := hosts.NewStore(database)
	store := NewStore(database)
	hostID := newTestHost(t, hostStore)

	if err := store.SetInventory(hostID, []Port{
		{HostID: hostID, PortID: "p1", CardType: "decklink", Direction: "in"},
	}); err != nil {
		t.Fatalf("SetInventory() error = %v", err)
	}
	if _, _, ok, err := store.Claim("decklink", "in", "", "wf1", "ingest", ""); err != nil || !ok {
		t.Fatalf("Claim() = (ok=%v, err=%v), want ok=true", ok, err)
	}

	if err := store.UpdateInstanceID("wf1", "ingest", "inst-42"); err != nil {
		t.Fatalf("UpdateInstanceID() error = %v", err)
	}

	claims, err := store.ListClaims()
	if err != nil {
		t.Fatalf("ListClaims() error = %v", err)
	}
	if len(claims) != 1 || claims[0].InstanceID != "inst-42" {
		t.Fatalf("ListClaims() = %+v, want one claim with instanceId=inst-42", claims)
	}
}

// TestGetClaimAndReleasePortDuringMigration belegt genau das Szenario,
// für das GetClaim/ReleasePort gebraucht werden (migration.go): zwei
// gleichzeitig bestehende Claims für dasselbe (workflowID, role) — der
// alte auf dem Quell-, der neue auf dem Zielhost — ReleasePort darf nur
// den gezielt benannten treffen, nicht den anderen.
func TestGetClaimAndReleasePortDuringMigration(t *testing.T) {
	database := dbtest.Open(t)
	cleanTables(t, database)
	hostStore := hosts.NewStore(database)
	store := NewStore(database)
	hostA := newTestHost(t, hostStore)
	hostB, err := hostStore.CreateHost("host-b", "host-b.local", nil)
	if err != nil {
		t.Fatalf("CreateHost(host-b) error = %v", err)
	}

	if err := store.SetInventory(hostA, []Port{{HostID: hostA, PortID: "pa", CardType: "decklink", Direction: "in"}}); err != nil {
		t.Fatalf("SetInventory(hostA) error = %v", err)
	}
	if err := store.SetInventory(hostB.ID, []Port{{HostID: hostB.ID, PortID: "pb", CardType: "decklink", Direction: "in"}}); err != nil {
		t.Fatalf("SetInventory(hostB) error = %v", err)
	}

	if _, _, ok, err := store.Claim("decklink", "in", hostA, "wf1", "ingest", "inst-old"); err != nil || !ok {
		t.Fatalf("Claim(hostA) = (ok=%v, err=%v), want ok=true", ok, err)
	}
	oldClaim, found, err := store.GetClaim("wf1", "ingest")
	if err != nil || !found || oldClaim.HostID != hostA || oldClaim.PortID != "pa" {
		t.Fatalf("GetClaim() = (%+v, found=%v, err=%v), want the hostA claim", oldClaim, found, err)
	}

	// Migration: neuer Claim auf hostB, während der alte auf hostA noch
	// besteht — beide teilen sich (workflowID="wf1", role="ingest").
	if _, _, ok, err := store.Claim("decklink", "in", hostB.ID, "wf1", "ingest", "inst-new"); err != nil || !ok {
		t.Fatalf("Claim(hostB) = (ok=%v, err=%v), want ok=true", ok, err)
	}

	claims, err := store.ListClaims()
	if err != nil || len(claims) != 2 {
		t.Fatalf("ListClaims() = %+v (err=%v), want 2 claims coexisting during migration", claims, err)
	}

	// Cutover abgeschlossen: nur den ALTEN Claim gezielt freigeben.
	if err := store.ReleasePort(oldClaim.HostID, oldClaim.PortID); err != nil {
		t.Fatalf("ReleasePort() error = %v", err)
	}

	claims, err = store.ListClaims()
	if err != nil {
		t.Fatalf("ListClaims() error = %v", err)
	}
	if len(claims) != 1 || claims[0].HostID != hostB.ID || claims[0].PortID != "pb" {
		t.Fatalf("ListClaims() after ReleasePort(old) = %+v, want only the hostB claim to remain", claims)
	}
}

func TestClaimHonorsPreferredHostAndDoesNotFallBackSilently(t *testing.T) {
	database := dbtest.Open(t)
	cleanTables(t, database)
	hostStore := hosts.NewStore(database)
	store := NewStore(database)
	hostA := newTestHost(t, hostStore)
	hostB, err := hostStore.CreateHost("host-b", "host-b.local", nil)
	if err != nil {
		t.Fatalf("CreateHost(host-b) error = %v", err)
	}

	// Nur Host B hat einen passenden freien Port.
	if err := store.SetInventory(hostB.ID, []Port{
		{HostID: hostB.ID, PortID: "p1", CardType: "decklink", Direction: "in"},
	}); err != nil {
		t.Fatalf("SetInventory(hostB) error = %v", err)
	}

	// Claim mit preferredHostID=hostA (kein Port dort) darf NICHT
	// still auf hostB ausweichen.
	_, _, ok, err := store.Claim("decklink", "in", hostA, "wf1", "ingest", "inst1")
	if err != nil {
		t.Fatalf("Claim(preferred=hostA) error = %v", err)
	}
	if ok {
		t.Fatal("Claim(preferred=hostA) = ok=true, want false — no silent fallback to a different host")
	}

	// Ohne preferredHostID (leer) wird hostB gefunden.
	gotHost, _, ok, err := store.Claim("decklink", "in", "", "wf1", "ingest", "inst1")
	if err != nil || !ok || gotHost != hostB.ID {
		t.Fatalf("Claim(preferred=\"\") = (%q, ok=%v, err=%v), want (%q, true, nil)", gotHost, ok, err, hostB.ID)
	}
}

func TestClaimReturnsFalseWhenNoMatchingPortExists(t *testing.T) {
	database := dbtest.Open(t)
	cleanTables(t, database)
	hostStore := hosts.NewStore(database)
	store := NewStore(database)
	hostID := newTestHost(t, hostStore)

	if err := store.SetInventory(hostID, []Port{
		{HostID: hostID, PortID: "p1", CardType: "decklink", Direction: "out"},
	}); err != nil {
		t.Fatalf("SetInventory() error = %v", err)
	}

	// Richtung passt nicht (Port ist "out", gesucht wird "in").
	_, _, ok, err := store.Claim("decklink", "in", "", "wf1", "ingest", "inst1")
	if err != nil {
		t.Fatalf("Claim() error = %v", err)
	}
	if ok {
		t.Fatal("Claim() = ok=true, want false — no port with the requested direction exists")
	}
}

// TestClaimIsAtomicUnderRealConcurrency ist der eigentliche Nachweis für
// den Paketkommentar ("Postgres' eigene Atomarität reicht, keine
// Anwendungs-Sperre nötig") — echte, gleichzeitig laufende Goroutinen
// gegen dieselbe echte Postgres-Verbindung (kein Mock, kein simulierter
// Zeitversatz), nicht nur sequenzielle Aufrufe wie in den Tests oben.
func TestClaimIsAtomicUnderRealConcurrency(t *testing.T) {
	database := dbtest.Open(t)
	cleanTables(t, database)
	hostStore := hosts.NewStore(database)
	store := NewStore(database)
	hostID := newTestHost(t, hostStore)

	if err := store.SetInventory(hostID, []Port{
		{HostID: hostID, PortID: "p1", CardType: "decklink", Direction: "in"},
	}); err != nil {
		t.Fatalf("SetInventory() error = %v", err)
	}

	const attempts = 20
	results := make(chan bool, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			_, _, ok, err := store.Claim("decklink", "in", "", "wf1", fmt.Sprintf("ingest-%d", n), fmt.Sprintf("inst-%d", n))
			if err != nil {
				t.Errorf("Claim() goroutine %d error = %v", n, err)
				results <- false
				return
			}
			results <- ok
		}(i)
	}
	wg.Wait()
	close(results)

	wins := 0
	for ok := range results {
		if ok {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("wins = %d across %d concurrent Claim() attempts on the same single port, want exactly 1", wins, attempts)
	}
}
