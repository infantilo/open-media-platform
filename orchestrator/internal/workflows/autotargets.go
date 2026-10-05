package workflows

// Automations-Ziele automatisch aus den Rollen des Workflows ableiten.
//
// Die Playout-Automation steuert ihre Player/Mischer über deren Label (Operator-Parameter
// `targetPlayerALabel` usw.). In einem Workflow ist das Label einer Instanz ihr Rollenname — die Ziele
// lassen sich deshalb beim Start vorbelegen, ohne dass der Bediener sie von Hand wählen muss:
// erster Kanal-Player = Kanal A, zweiter = Kanal B, erster Bildmischer = Mischer, erster Audiomischer,
// erste Grafik. Nur eine Vorbelegung (Umgebungsvariablen beim Start) — der Bediener kann sie im Panel
// jederzeit ändern. Standby-Rollen zählen nicht.

const automationNodeType = "omp-playout-automation"

// automationTargetEnv liefert die Start-Umgebung für eine Automations-Rolle; für jede andere Rolle nil.
func automationTargetEnv(def Definition, role Role) map[string]string {
	if role.NodeType != automationNodeType {
		return nil
	}
	env := map[string]string{}
	players := 0
	set := func(key, label string) {
		if _, taken := env[key]; !taken {
			env[key] = label
		}
	}
	for _, r := range def.Roles {
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

// withAutomationTargets ergänzt `base` um die Automations-Ziele (neue Map, `base` bleibt unverändert;
// ausdrücklich gesetzte Werte in `base` gewinnen).
func withAutomationTargets(base map[string]string, def Definition, role Role) map[string]string {
	add := automationTargetEnv(def, role)
	if add == nil {
		return base
	}
	merged := make(map[string]string, len(base)+len(add))
	for k, v := range add {
		merged[k] = v
	}
	for k, v := range base {
		merged[k] = v
	}
	return merged
}
