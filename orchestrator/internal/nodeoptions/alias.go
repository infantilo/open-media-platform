package nodeoptions

// Die reine Schema-/Prüflogik liegt im gemeinsamen Modul `nodeoptions` (Repo-Wurzel), weil
// auch der Host-Agent sie braucht: er prüft Optionen für seinen Host selbst (Sicherheitsgrenze).
// Hier nur Aliase, damit der Orchestrator-Code unverändert „nodeoptions.X“ schreibt.

import shared "github.com/infantilo/openmediaplatform/nodeoptions"

type (
	Type     = shared.Type
	Choice   = shared.Choice
	Option   = shared.Option
	PathInfo = shared.PathInfo
)

const (
	TypeString = shared.TypeString
	TypePath   = shared.TypePath
	TypeInt    = shared.TypeInt
	TypeFloat  = shared.TypeFloat
	TypeEnum   = shared.TypeEnum
	TypeHost   = shared.TypeHost
	TypePort   = shared.TypePort
	TypeURL    = shared.TypeURL
	PathDir    = shared.PathDir
	PathFile   = shared.PathFile
)

var (
	ErrInvalid     = shared.ErrInvalid
	ValidateSchema = shared.ValidateSchema
	Find           = shared.Find
	Validate       = shared.Validate
	ValidateWith   = shared.ValidateWith
	CheckPath      = shared.CheckPath
	LoadFile       = shared.LoadFile
)
