// Package playout ist das Playout-Modul des Orchestrators (UMSETZUNG.md Kapitel 36). Übergangsstand 36.5: bisher nur das
// Wissen über die Playout-Automation (Automations-Ziele, Control-Plane-Typ), das früher in `workflows` stand; Channels,
// Trigger, As-Run und Preflight folgen mit 36.8.
package playout

import (
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// Automations-Ziele automatisch aus den Rollen des Workflows ableiten.
//
// Die Playout-Automation steuert ihre Player/Mischer über deren Label (Operator-Parameter
// `targetPlayerALabel` usw.). In einem Workflow ist das Label einer Instanz ihr Rollenname — die Ziele
// lassen sich deshalb beim Start vorbelegen, ohne dass der Bediener sie von Hand wählen muss:
// erster Kanal-Player = Kanal A, zweiter = Kanal B, erster Bildmischer = Mischer, erster Audiomischer,
// erste Grafik. Nur eine Vorbelegung (Umgebungsvariablen beim Start) — der Bediener kann sie im Panel
// jederzeit ändern. Standby-Rollen zählen nicht.
//
// Mehrere Automationen in EINEM Workflow (Mehrkanal): Rollen, deren Name mit dem Namen der Automation beginnt
// („channel-a“ → „channel-a-player-1“, „channel-a mixer“), gehören zu ihr; nur aus ihnen wird dann abgeleitet.

// AutomationNodeType ist der Node-Typ der Playout-Automation (reiner Control-Plane-Node, steuert Player/Mischer fern).
const AutomationNodeType = "omp-playout-automation"

// AutomationTargetEnv liefert die Start-Umgebung für eine Automations-Rolle; für jede andere Rolle nil.
func AutomationTargetEnv(def workflows.Definition, role workflows.Role) map[string]string {
	if role.NodeType != AutomationNodeType {
		return nil
	}
	env := map[string]string{}
	players := 0
	set := func(key, label string) {
		if _, taken := env[key]; !taken {
			env[key] = label
		}
	}
	for _, r := range automationRoles(def, role) {
		if r.StandbyFor != "" {
			continue
		}
		switch r.NodeType {
		case "omp-channel-player":
			players++
			switch players {
			case 1:
				set("OMP_PLAYOUT_TARGET_PLAYER_A_LABEL", r.Name)
			case 2:
				set("OMP_PLAYOUT_TARGET_PLAYER_B_LABEL", r.Name)
			}
		case "omp-video-mixer-me":
			set("OMP_PLAYOUT_TARGET_MIXER_LABEL", r.Name)
		case "omp-audio-mixer":
			set("OMP_PLAYOUT_TARGET_AUDIO_MIXER_LABEL", r.Name)
		case "omp-ograf":
			set("OMP_PLAYOUT_TARGET_GRAPHICS_LABEL", r.Name)
		}
	}
	if len(env) == 0 {
		return nil
	}
	return env
}

// automationRoles liefert die Rollen, aus denen die Ziele von `automation` abgeleitet werden: bei mehreren
// Automationen die mit ihrem Namen als Präfix (falls vorhanden), sonst alle.
func automationRoles(def workflows.Definition, automation workflows.Role) []workflows.Role {
	automations := 0
	var own []workflows.Role
	for _, r := range def.Roles {
		if r.NodeType == AutomationNodeType && r.StandbyFor == "" {
			automations++
		}
		if strings.HasPrefix(r.Name, automation.Name+"-") || strings.HasPrefix(r.Name, automation.Name+" ") {
			own = append(own, r)
		}
	}
	if automations < 2 || len(own) == 0 {
		return def.Roles
	}
	return own
}

// Register hängt die Playout-Fachlichkeit an den Workflow-Dienst: Automations-Ziele als Start-Umgebung und der
// Automations-Node als Control-Plane-Typ.
func Register(svc interface {
	RegisterRoleEnvHook(workflows.RoleEnvHook)
	RegisterControlPlaneType(string)
}) {
	svc.RegisterRoleEnvHook(AutomationTargetEnv)
	svc.RegisterControlPlaneType(AutomationNodeType)
}
