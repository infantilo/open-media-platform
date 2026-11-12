package commands

import (
	"strings"
	"testing"
)

func envMapOf(list []string) map[string]string {
	m := map[string]string{}
	for _, kv := range list {
		if i := strings.IndexByte(kv, '='); i > 0 {
			m[kv[:i]] = kv[i+1:]
		}
	}
	return m
}

func TestEnvInheritedHidesSecrets(t *testing.T) {
	in := []string{
		"OMP_STORAGE_SECRET_KEY=geheim", "OMP_POSTGRES_URL=postgres://omp:pw@db/omp",
		"OMP_MINIO_SECRET_KEY=x", "OMP_MINIO_ACCESS_KEY=x", "OMP_BACKUP_PASSPHRASE=x", "OMP_BACKUP_PASSPHRASE_FILE=/p",
		"OMP_ALERT_SMTP_PASSWORD=x", "OMP_ALERT_WEBHOOK_TOKEN=x", "OMP_HOST_AGENT_BOOTSTRAP_TOKEN=x",
		"OMP_CLOUD_AWS_AMI=ami", "OMP_LAUNCH_SECRET=x", "AWS_SECRET_ACCESS_KEY=x", "AWS_ACCESS_KEY_ID=x",
		"SSH_AUTH_SOCK=/s", "PGPASSWORD=x",
		// bleibt
		"OMP_MXL_DOMAIN=/dev/shm/omp-mxl", "OMP_NODE_API_TOKEN=t", "OMP_SERVICE_TOKEN=s", "OMP_NODE_API_TOKEN_HOSTS=a.b",
		"PATH=/usr/bin", "HOME=/home/x", "LD_LIBRARY_PATH=/l", "GST_PLUGIN_PATH=/g", "XDG_RUNTIME_DIR=/run/user/1",
	}
	got := envInherited(in)
	for _, k := range []string{
		"OMP_STORAGE_SECRET_KEY", "OMP_POSTGRES_URL", "OMP_MINIO_SECRET_KEY", "OMP_MINIO_ACCESS_KEY", "OMP_BACKUP_PASSPHRASE",
		"OMP_BACKUP_PASSPHRASE_FILE", "OMP_ALERT_SMTP_PASSWORD", "OMP_ALERT_WEBHOOK_TOKEN", "OMP_HOST_AGENT_BOOTSTRAP_TOKEN",
		"OMP_CLOUD_AWS_AMI", "OMP_LAUNCH_SECRET", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "SSH_AUTH_SOCK", "PGPASSWORD",
	} {
		if _, ok := got[k]; ok {
			t.Errorf("%s darf nicht an Nodes vererbt werden", k)
		}
	}
	for _, k := range []string{"OMP_MXL_DOMAIN", "OMP_NODE_API_TOKEN", "OMP_SERVICE_TOKEN", "OMP_NODE_API_TOKEN_HOSTS", "PATH", "HOME", "LD_LIBRARY_PATH", "GST_PLUGIN_PATH", "XDG_RUNTIME_DIR"} {
		if _, ok := got[k]; !ok {
			t.Errorf("%s muss vererbt werden", k)
		}
	}
}

func TestEnvInheritedPassListExtendsButNeverSecrets(t *testing.T) {
	in := []string{"OMP_ENV_PASS=FOO,BAR_*,OMP_POSTGRES_URL", "FOO=1", "BAR_X=2", "BAZ=3", "OMP_POSTGRES_URL=geheim"}
	got := envInherited(in)
	if got["FOO"] != "1" || got["BAR_X"] != "2" {
		t.Errorf("OMP_ENV_PASS muss FOO und BAR_* durchlassen: %v", got)
	}
	if _, ok := got["BAZ"]; ok {
		t.Error("BAZ steht nicht auf der Liste")
	}
	if _, ok := got["OMP_POSTGRES_URL"]; ok {
		t.Error("die Sperrliste muss auch gegen OMP_ENV_PASS gelten")
	}
}

func TestBuildEnvDoesNotLeakSecrets(t *testing.T) {
	t.Setenv("OMP_STORAGE_SECRET_KEY", "geheim")
	t.Setenv("OMP_POSTGRES_URL", "postgres://omp:pw@db/omp")
	t.Setenv("OMP_MXL_DOMAIN", "/dev/shm/x")
	m := envMapOf(buildEnv(map[string]string{"A": "1"}, map[string]string{"B": "2"}, "id1", "lbl", "http://r", "nats://n", "http://o", ""))
	for _, k := range []string{"OMP_STORAGE_SECRET_KEY", "OMP_POSTGRES_URL", "OMP_LAUNCH_SECRET"} {
		if _, ok := m[k]; ok {
			t.Errorf("%s im Node-Environment", k)
		}
	}
	if m["OMP_MXL_DOMAIN"] != "/dev/shm/x" || m["A"] != "1" || m["B"] != "2" || m["OMP_INSTANCE_ID"] != "id1" {
		t.Errorf("Betriebswerte fehlen: %v", m)
	}
}
