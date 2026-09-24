// Package storagebackends verwaltet die S3/MinIO-Ziele, gegen die
// Asset-Representations tatsächlich hochgeladen/heruntergeladen werden
// (Nutzerauftrag 2026-09-24, im Anschluss an Kapitel 21 B5, Nachtrag
// 280). Bislang gab es genau EINE fest über OMP_MINIO_*-Umgebungs-
// variablen konfigurierte Instanz, änderbar nur per Neustart und ohne
// jede UI-Sichtbarkeit — der Nutzer wollte ausdrücklich weg davon:
// "asset folder should be able to be dynamically added/removed without
// the need of restart... only super admins may config this... i dont
// like hidden configs at all... full control (with warnings,
// protection guards, hints, wizards) and full overview."
//
// Getrennt von asset.StorageLocation (Provider+URI-Wertpaar auf jeder
// einzelnen Representation) — ein Backend hier ist die dahinterliegende,
// wiederverwaltete Infrastruktur-Ressource mit eigenem Lebenszyklus/
// Zugangsdaten, auf die mehrere Representations gleichzeitig verweisen
// (Nutzerentscheidung 2026-09-24: mehrere Backends gleichzeitig statt
// einer einzelnen austauschbaren Instanz).
//
// Secrets: AES-256-GCM-verschlüsselt in Postgres (crypto.go), nie im
// Klartext zurückgegeben (Backend.HasSecret statt eines Wertes) —
// Nutzerentscheidung 2026-09-24, "serverseitig verschlüsselt"
// gegenüber Klartext.
package storagebackends

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/objectstore"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

const (
	StatusActive     = "active"
	StatusDeprecated = "deprecated"
)

var (
	ErrNotFound    = errors.New("storagebackends: not found")
	ErrValidation  = errors.New("storagebackends: validation failed")
	ErrUnreachable = errors.New("storagebackends: could not connect")
)

// Backend ist die nach außen sichtbare, secret-freie Sicht auf eine
// verwaltete Storage-Ressource.
type Backend struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Provider  string    `json:"provider"`
	Endpoint  string    `json:"endpoint"`
	Bucket    string    `json:"bucket"`
	AccessKey string    `json:"accessKey"`
	UseSSL    bool      `json:"useSsl"`
	HasSecret bool      `json:"hasSecret"`
	Status    string    `json:"status"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Input ist der Schreib-Eingabewert für Create/TestConnection —
// SecretKey lebt bewusst nie auf Backend selbst (s. Paketdoku).
type Input struct {
	Name      string
	Provider  string
	Endpoint  string
	Bucket    string
	AccessKey string
	SecretKey string
	UseSSL    bool
}

func (in Input) validate() error {
	if in.Name == "" || in.Provider == "" || in.Endpoint == "" || in.Bucket == "" || in.AccessKey == "" {
		return fmt.Errorf("%w: name, provider, endpoint, bucket and accessKey are required", ErrValidation)
	}
	return nil
}

func (in Input) toObjectstoreConfig() objectstore.Config {
	return objectstore.Config{
		Endpoint: in.Endpoint, AccessKey: in.AccessKey, SecretKey: in.SecretKey,
		Bucket: in.Bucket, UseSSL: in.UseSSL,
	}
}

// Store persistiert Backends in Postgres UND hält einen Live-Cache
// bereits verbundener objectstore.Client-Instanzen — das ist der
// eigentliche "kein Neustart nötig"-Mechanismus: Create/UpdateMeta
// verbinden sofort und legen den Client synchron in den Cache, Delete/
// eine Zugangsdaten-Änderung entfernen den alten Eintrag daraus.
type Store struct {
	db        *sql.DB
	masterKey []byte

	mu      sync.RWMutex
	clients map[string]*objectstore.Client
}

// NewStore erstellt einen Store — err != nil, wenn masterKeyB64 keinem
// gültigen AES-256-Schlüssel entspricht. Ein leerer masterKeyB64 ist
// KEIN Fehler hier (main.go entscheidet an dieser Stelle bereits, ob
// das Feature überhaupt aktiv ist, s. dortige Doku), NewStore wird nur
// aufgerufen, wenn OMP_STORAGE_SECRET_KEY tatsächlich gesetzt ist.
func NewStore(db *sql.DB, masterKeyB64 string) (*Store, error) {
	key, err := decodeMasterKey(masterKeyB64)
	if err != nil {
		return nil, err
	}
	return &Store{db: db, masterKey: key, clients: make(map[string]*objectstore.Client)}, nil
}

func newID() (string, error) {
	id := tracing.NewID()
	if id == "" {
		return "", fmt.Errorf("storagebackends: id generation failed")
	}
	return id, nil
}

// TestConnection prüft Erreichbarkeit/Zugangsdaten OHNE zu
// persistieren — der Wizard-"Verbindung testen"-Schritt (Nutzerauftrag:
// "protection guards... wizards"). Der erzeugte Client wird nach dem
// Test verworfen.
func (s *Store) TestConnection(ctx context.Context, in Input) error {
	if err := in.validate(); err != nil {
		return err
	}
	if _, err := objectstore.NewClient(ctx, in.toObjectstoreConfig()); err != nil {
		return fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	return nil
}

// Create legt ein neues Backend an — verbindet dabei sofort (derselbe
// Schutz wie TestConnection, damit ein Aufrufer, der den separaten
// Wizard-Test übersprungen hat oder zwischenzeitlich eine Netzwerk-
// Störung hatte, kein unbrauchbares Backend persistiert bekommt) und
// legt den verbundenen Client synchron in den Live-Cache — sofort
// nutzbar, kein Neustart nötig.
func (s *Store) Create(ctx context.Context, in Input, createdBy string) (Backend, error) {
	if err := in.validate(); err != nil {
		return Backend{}, err
	}
	if in.SecretKey == "" {
		return Backend{}, fmt.Errorf("%w: secretKey is required", ErrValidation)
	}
	client, err := objectstore.NewClient(ctx, in.toObjectstoreConfig())
	if err != nil {
		return Backend{}, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}

	id, err := newID()
	if err != nil {
		return Backend{}, err
	}
	encSecret, err := encryptSecret(s.masterKey, in.SecretKey)
	if err != nil {
		return Backend{}, err
	}
	now := time.Now().UTC()
	b := Backend{
		ID: id, Name: in.Name, Provider: in.Provider, Endpoint: in.Endpoint, Bucket: in.Bucket,
		AccessKey: in.AccessKey, UseSSL: in.UseSSL, HasSecret: true, Status: StatusActive,
		CreatedBy: createdBy, CreatedAt: now, UpdatedAt: now,
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO storage_backends (id, name, provider, endpoint, bucket, access_key, secret_key, use_ssl, status, created_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
	`, b.ID, b.Name, b.Provider, b.Endpoint, b.Bucket, b.AccessKey, encSecret, b.UseSSL, b.Status, b.CreatedBy, b.CreatedAt)
	if err != nil {
		return Backend{}, err
	}

	s.mu.Lock()
	s.clients[b.ID] = client
	s.mu.Unlock()
	return b, nil
}

func scanBackend(row interface{ Scan(...any) error }) (Backend, []byte, error) {
	var b Backend
	var secret []byte
	err := row.Scan(&b.ID, &b.Name, &b.Provider, &b.Endpoint, &b.Bucket, &b.AccessKey, &secret,
		&b.UseSSL, &b.Status, &b.CreatedBy, &b.CreatedAt, &b.UpdatedAt)
	if err != nil {
		return Backend{}, nil, err
	}
	b.HasSecret = len(secret) > 0
	return b, secret, err
}

const backendSelectColumns = `id, name, provider, endpoint, bucket, access_key, secret_key, use_ssl, status, created_by, created_at, updated_at`

// Get liest ein einzelnes Backend (ohne Secret — s. Paketdoku).
func (s *Store) Get(id string) (Backend, error) {
	row := s.db.QueryRow(`SELECT `+backendSelectColumns+` FROM storage_backends WHERE id = $1`, id)
	b, _, err := scanBackend(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Backend{}, ErrNotFound
	}
	return b, err
}

// List liefert alle Backends, neueste zuerst — Nutzerauftrag "full
// overview", daher immer die volle Liste (kein Filter, keine
// Pagination: die erwartete Größenordnung sind Handvoll Einträge, kein
// Katalog).
func (s *Store) List() ([]Backend, error) {
	rows, err := s.db.Query(`SELECT ` + backendSelectColumns + ` FROM storage_backends ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Backend{}
	for rows.Next() {
		b, _, err := scanBackend(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// UpdateMeta ändert Endpoint/Bucket/AccessKey/UseSSL und optional den
// Secret Key (leer = unverändert lassen — "Zugangsdaten rotieren" ist
// ein bewusster, expliziter Schritt, kein Nebeneffekt eines normalen
// Speicherns). Verbindet mit der NEUEN Konfiguration, bevor irgendetwas
// geschrieben wird (derselbe Schutz wie Create) und tauscht danach den
// Live-Cache-Eintrag aus.
func (s *Store) UpdateMeta(ctx context.Context, id string, in Input) (Backend, error) {
	if err := in.validate(); err != nil {
		return Backend{}, err
	}
	current, err := s.Get(id)
	if err != nil {
		return Backend{}, err
	}
	secretToUse := in.SecretKey
	if secretToUse == "" {
		// Bestehendes Secret unverändert lassen — dafür entschlüsseln,
		// damit die Verbindungsprüfung unten gegen die tatsächlich
		// künftig gültige Konfiguration läuft, nicht gegen ein leeres
		// Passwort.
		secretToUse, err = s.decryptedSecret(id)
		if err != nil {
			return Backend{}, err
		}
	}
	testIn := in
	testIn.SecretKey = secretToUse
	client, err := objectstore.NewClient(ctx, testIn.toObjectstoreConfig())
	if err != nil {
		return Backend{}, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}

	now := time.Now().UTC()
	if in.SecretKey == "" {
		_, err = s.db.ExecContext(ctx, `
			UPDATE storage_backends SET name=$2, provider=$3, endpoint=$4, bucket=$5, access_key=$6, use_ssl=$7, updated_at=$8
			WHERE id=$1
		`, id, in.Name, in.Provider, in.Endpoint, in.Bucket, in.AccessKey, in.UseSSL, now)
	} else {
		var encSecret []byte
		encSecret, err = encryptSecret(s.masterKey, in.SecretKey)
		if err == nil {
			_, err = s.db.ExecContext(ctx, `
				UPDATE storage_backends SET name=$2, provider=$3, endpoint=$4, bucket=$5, access_key=$6, secret_key=$7, use_ssl=$8, updated_at=$9
				WHERE id=$1
			`, id, in.Name, in.Provider, in.Endpoint, in.Bucket, in.AccessKey, encSecret, in.UseSSL, now)
		}
	}
	if err != nil {
		return Backend{}, err
	}

	s.mu.Lock()
	s.clients[id] = client
	s.mu.Unlock()
	current.Name, current.Provider, current.Endpoint, current.Bucket = in.Name, in.Provider, in.Endpoint, in.Bucket
	current.AccessKey, current.UseSSL, current.UpdatedAt = in.AccessKey, in.UseSSL, now
	return current, nil
}

// UpdateStatus schaltet zwischen "active" (nimmt neue Uploads an) und
// "deprecated" (liefert bestehende Dateien weiter aus, keine neuen
// mehr) — der abgestufte Zwischenschritt vor einem harten Delete, den
// der Nutzerauftrag mit "protection guards" verlangt: ein Admin kann
// ein Backend erst "auslaufen lassen" und beobachten, bevor er es
// tatsächlich entfernt.
func (s *Store) UpdateStatus(id, status string) (Backend, error) {
	if status != StatusActive && status != StatusDeprecated {
		return Backend{}, fmt.Errorf("%w: status must be %q or %q", ErrValidation, StatusActive, StatusDeprecated)
	}
	res, err := s.db.Exec(`UPDATE storage_backends SET status=$2, updated_at=now() WHERE id=$1`, id, status)
	if err != nil {
		return Backend{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Backend{}, ErrNotFound
	}
	return s.Get(id)
}

// CountRepresentations liefert, wie viele Representations noch auf
// dieses Backend verweisen — genutzt, um VOR einem Löschversuch eine
// konkrete, hilfreiche Fehlermeldung zu geben ("wird noch von 3 Dateien
// verwendet") statt nur den rohen Fremdschlüssel-Fehler nach dem
// Versuch zu übersetzen.
func (s *Store) CountRepresentations(id string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM representations WHERE storage_backend_id = $1`, id).Scan(&n)
	return n, err
}

// Delete entfernt ein Backend — echter Fremdschlüssel-Schutz
// (representations.storage_backend_id REFERENCES ohne CASCADE, s.
// Migration) verhindert das Löschen, solange noch Representations
// darauf verweisen; der Aufrufer (httpapi) prüft CountRepresentations
// vorher für eine konkrete Fehlermeldung, dieser Fremdschlüssel bleibt
// trotzdem die letzte, verlässliche Instanz gegen eine Race-Bedingung
// zwischen Zählen und Löschen.
func (s *Store) Delete(id string) error {
	res, err := s.db.Exec(`DELETE FROM storage_backends WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	s.mu.Lock()
	delete(s.clients, id)
	s.mu.Unlock()
	return nil
}

func (s *Store) decryptedSecret(id string) (string, error) {
	var raw []byte
	err := s.db.QueryRow(`SELECT secret_key FROM storage_backends WHERE id = $1`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return decryptSecret(s.masterKey, raw)
}

// Resolve liefert den verbundenen objectstore.Client für ein Backend —
// Cache-Treffer im Normalfall (nach Create/UpdateMeta bereits warm);
// sonst (z. B. frischer Orchestrator-Neustart, Backend existierte schon
// vor diesem Prozessstart) verbindet es hier lazy nach und cached das
// Ergebnis. Das ist der eigentliche "kein Neustart nötig"-Pfad für den
// LESE-/Upload-Fall.
func (s *Store) Resolve(ctx context.Context, id string) (*objectstore.Client, error) {
	s.mu.RLock()
	c, ok := s.clients[id]
	s.mu.RUnlock()
	if ok {
		return c, nil
	}

	b, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	secret, err := s.decryptedSecret(id)
	if err != nil {
		return nil, err
	}
	client, err := objectstore.NewClient(ctx, objectstore.Config{
		Endpoint: b.Endpoint, AccessKey: b.AccessKey, SecretKey: secret, Bucket: b.Bucket, UseSSL: b.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	s.mu.Lock()
	s.clients[id] = client
	s.mu.Unlock()
	return client, nil
}

// WarmAll verbindet alle bestehenden Backends beim Orchestrator-Start
// vor — best effort (ein einzelnes gerade nicht erreichbares Backend
// blockiert nicht den Start, es wird beim nächsten Resolve()-Aufruf
// einfach erneut versucht). Gibt die Namen der fehlgeschlagenen
// Backends zurück, damit main.go sie klar loggen kann (Nutzerauftrag
// "full overview", nicht stillschweigend).
func (s *Store) WarmAll(ctx context.Context) (failed []string, err error) {
	backends, err := s.List()
	if err != nil {
		return nil, err
	}
	for _, b := range backends {
		if _, resolveErr := s.Resolve(ctx, b.ID); resolveErr != nil {
			failed = append(failed, fmt.Sprintf("%s (%s): %v", b.Name, b.ID, resolveErr))
		}
	}
	return failed, nil
}
