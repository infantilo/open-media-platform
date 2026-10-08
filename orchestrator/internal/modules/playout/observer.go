package playout

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asrun"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
)

// operatorObserver hält nach einer erfolgreichen manuellen Aktion an einem Automator-Node Benutzer, Aktion und Event im As-Run
// fest (§119) und legt sie im Domänen-Audit ab. Fehlschläge am Protokoll beeinflussen die Aktion nie (der Kern ruft den Beobachter
// erst nach dem Aufruf und fängt Panik ab).
func (m *Module) operatorObserver(audit module.DomainAudit) func(module.MethodCall) {
	return func(c module.MethodCall) {
		if c.InstanceID == "" {
			return
		}
		ch, err := m.playout.ChannelByInstance(c.InstanceID)
		if errors.Is(err, playout.ErrNotFound) && m.svc.Roles != nil {
			if wf, role, found := m.svc.Roles.FindRoleForInstance(c.InstanceID); found {
				ch, err = m.playout.ChannelByRole(wf, role)
			}
		}
		if err != nil {
			return // kein Playout-Channel an diesem Node
		}
		var args map[string]any
		_ = json.Unmarshal(c.Body, &args)
		eventID, _ := args["itemId"].(string)
		now := time.Now().UTC()
		detail, _ := json.Marshal(summarizeArgs(args))
		_ = m.asrun.Upsert(context.WithoutCancel(c.Request.Context()), ch.ID, []asrun.Record{{
			Key: "op:" + strconv.FormatInt(now.UnixNano(), 36) + ":" + c.Name, Kind: asrun.KindOperator, RecordedAt: now,
			EventID: eventID, Operator: c.Actor, Action: c.Name, Detail: detail,
		}})
		logDomainAudit(audit, c.Actor, "playout.channel", ch.ID, "operator_"+c.Name, map[string]any{"eventId": eventID})
	}
}
