package fixture

// Testdaten für routetable: sieht aus wie ein Modul, wird nie gebaut (liegt unter testdata/).

func Mount(r Routes) {
	r.Handle("GET /api/v1/cloud/hosts", module.Authenticated(), h)
	r.Handle("POST /api/v1/cloud/reservations", module.Verb(authz.VerbAdmin), h)
	r.Handle("GET /api/v1/audio-rules/default", module.Anonymous(), h)
	r.Handle("POST /api/v1/playout/x/{id}/call", module.VerbOnNode(authz.VerbOperate), h)
	other.Handle("not a route", 1, 2) // darf nicht zählen
	r.Handle("GET /api/v1/ignored", somethingElse(), h)
}
