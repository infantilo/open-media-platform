package auth

import (
	"context"
	"errors"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/directory"
)

type fakeDir struct {
	users map[string]string // Anmeldename -> Passwort
	canon map[string]string // Anmeldename -> kanonischer Name
	err   error
	calls int
}

func (f *fakeDir) Authenticate(_ context.Context, u, p string) (directory.Identity, error) {
	f.calls++
	if f.err != nil {
		return directory.Identity{}, f.err
	}
	if pw, ok := f.users[u]; !ok || pw != p {
		return directory.Identity{}, directory.ErrInvalidCredentials
	}
	name := f.canon[u]
	if name == "" {
		name = u
	}
	return directory.Identity{Username: name, DN: "CN=" + name}, nil
}

type fakeSync struct{ got []string }

func (f *fakeSync) Sync(_ context.Context, u string, _ directory.Identity) (bool, error) {
	f.got = append(f.got, u)
	return true, nil
}

func TestDirectoryLogin(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()
	suffix := mustNewID(t)[:8]
	admin, ad, local := "adm-"+suffix, "ad-"+suffix, "loc-"+suffix
	t.Cleanup(func() {
		for _, n := range []string{admin, ad, local, "Typed-" + suffix} {
			_ = svc.DeleteUser(ctx, n)
		}
	})
	d := &fakeDir{users: map[string]string{ad: "ad-pass-1234", "Typed-" + suffix: "ad-pass-1234", local: "ad-pass-1234"}, canon: map[string]string{"Typed-" + suffix: ad}}
	syn := &fakeSync{}
	svc.SetDirectory(d, syn)

	// Bootstrap (kein Nutzer): Verzeichnisanmeldung aus.
	n, _ := svc.UserCount(ctx)
	if n == 0 {
		if _, _, err := svc.Login(ctx, ad, "ad-pass-1234"); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("Bootstrap: %v", err)
		}
		if d.calls != 0 {
			// Verzeichnis wird gefragt, aber niemand angelegt
		}
		if u, ok, _ := svc.store.ByUsername(ctx, ad); ok {
			t.Fatalf("Nutzer im Bootstrap angelegt: %+v", u)
		}
	}
	if _, err := svc.CreateUser(ctx, admin, "admin-pass-1234", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateUser(ctx, local, "local-pass-1234", ""); err != nil {
		t.Fatal(err)
	}

	// Erstanmeldung legt den Nutzer an, gleicht Gruppen ab, Token funktioniert.
	tok, _, err := svc.Login(ctx, ad, "ad-pass-1234")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	p, err := svc.Authenticate(ctx, tok)
	if err != nil || p.Username != ad {
		t.Fatalf("Authenticate: %+v %v", p, err)
	}
	u, _, _ := svc.store.ByUsername(ctx, ad)
	if u.Source != SourceLDAP || u.PasswordHash != ExternalPasswordHash {
		t.Fatalf("Quelle: %+v", u)
	}
	if len(syn.got) != 1 || syn.got[0] != ad {
		t.Fatalf("Sync: %v", syn.got)
	}
	// Zweite Anmeldung (Nutzer existiert, source ldap) und Anmeldung unter abweichender Schreibweise: gleicher Nutzer.
	if _, _, err := svc.Login(ctx, ad, "ad-pass-1234"); err != nil {
		t.Fatal(err)
	}
	tok2, _, err := svc.Login(ctx, "Typed-"+suffix, "ad-pass-1234")
	if err != nil {
		t.Fatal(err)
	}
	if p2, _ := svc.Authenticate(ctx, tok2); p2.UserID != u.ID {
		t.Fatalf("anderes Konto: %+v", p2)
	}
	// Falsches Passwort.
	if _, _, err := svc.Login(ctx, ad, "falsch"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("falsch: %v", err)
	}
	// Verzeichnis nicht erreichbar: nach außen "ungültig", kein Absturz.
	d.err = errors.New("dial tcp: refused")
	if _, _, err := svc.Login(ctx, ad, "ad-pass-1234"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Ausfall: %v", err)
	}
	d.err = nil
	// Lokales Konto gleichen Namens: Verzeichnis wird gar nicht gefragt, das lokale Passwort gilt.
	calls := d.calls
	if _, _, err := svc.Login(ctx, local, "ad-pass-1234"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("lokales Konto per Verzeichnispasswort: %v", err)
	}
	if d.calls != calls {
		t.Fatal("Verzeichnis für lokales Konto befragt")
	}
	if _, _, err := svc.Login(ctx, local, "local-pass-1234"); err != nil {
		t.Fatal(err)
	}
	// Kanonischer Name eines Verzeichniskontos kollidiert mit lokalem Konto: abgewiesen (keine Übernahme).
	d.users["x-"+suffix], d.canon["x-"+suffix] = "ad-pass-1234", local
	if _, _, err := svc.Login(ctx, "x-"+suffix, "ad-pass-1234"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Namenskollision: %v", err)
	}
	// Passwort eines Verzeichnisnutzers lässt sich in OMP nicht setzen.
	if err := svc.SetPassword(ctx, ad, "irgendwas-12345"); !errors.Is(err, ErrExternalUser) {
		t.Fatalf("SetPassword: %v", err)
	}
	// Ohne Verzeichnis: Verzeichnisnutzer kann sich nicht mehr anmelden.
	svc.SetDirectory(nil, nil)
	if _, _, err := svc.Login(ctx, ad, "ad-pass-1234"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("ohne Verzeichnis: %v", err)
	}
}
