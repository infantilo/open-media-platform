package cloud

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeAWS struct {
	mu       sync.Mutex
	srv      *httptest.Server
	ec2Calls []url.Values
	auth     []string
	// Antworten
	runXML      string
	runStatus   int
	describeXML []string // je Seite
	pricing     string
	cost        string
}

func newFakeAWS(t *testing.T) *fakeAWS {
	t.Helper()
	f := &fakeAWS{runStatus: 200}
	mux := http.NewServeMux()
	mux.HandleFunc("/ec2/", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		v, _ := url.ParseQuery(string(b))
		f.mu.Lock()
		defer f.mu.Unlock()
		f.ec2Calls = append(f.ec2Calls, v)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		switch v.Get("Action") {
		case "RunInstances":
			w.WriteHeader(f.runStatus)
			_, _ = w.Write([]byte(f.runXML))
		case "DescribeInstances":
			page := 0
			if v.Get("NextToken") != "" {
				page = 1
			}
			if len(f.describeXML) == 0 {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`<Response><Errors><Error><Code>InvalidInstanceID.NotFound</Code><Message>gone</Message></Error></Errors></Response>`))
				return
			}
			_, _ = w.Write([]byte(f.describeXML[min(page, len(f.describeXML)-1)]))
		case "TerminateInstances":
			if v.Get("InstanceId.1") == "i-gone" {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`<Response><Errors><Error><Code>InvalidInstanceID.NotFound</Code><Message>x</Message></Error></Errors></Response>`))
				return
			}
			_, _ = w.Write([]byte(`<TerminateInstancesResponse/>`))
		}
	})
	mux.HandleFunc("/pricing/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("X-Amz-Target") != "AWSPriceListService.GetProducts" || r.Header.Get("Authorization") == "" {
			w.WriteHeader(400)
			return
		}
		_, _ = w.Write([]byte(f.pricing))
	})
	mux.HandleFunc("/ce/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		_, _ = w.Write([]byte(f.cost))
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAWS) adapter(t *testing.T, allow bool) *AWS {
	t.Helper()
	a, err := NewAWS(AWSConfig{
		Region: "eu-central-1", AccessKeyID: "AK", SecretAccessKey: "SK", ImageID: "ami-123", SubnetID: "subnet-1",
		SecurityGroupIDs: []string{"sg-1", "sg-2"}, KeyName: "key", InstanceTypes: []string{"t3.medium"}, AllowLaunch: allow,
		EC2Endpoint: f.srv.URL + "/ec2/", PricingEndpoint: f.srv.URL + "/pricing/", CostEndpoint: f.srv.URL + "/ce/",
		Now: func() time.Time { return time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return a
}

const runOK = `<RunInstancesResponse><instancesSet><item><instanceId>i-0abc</instanceId><instanceState><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`

func TestAWSLaunchSendsTaggedHardenedRequest(t *testing.T) {
	f := newFakeAWS(t)
	f.runXML = runOK
	a := f.adapter(t, true)
	ref, err := a.Launch(context.Background(), LaunchRequest{InstanceType: "t3.medium", UserData: "hello", Label: "host-1",
		Tags: map[string]string{TagDeployment: "dep", TagHost: "host-1", TagPool: "burst"}})
	if err != nil || ref.ID != "i-0abc" || ref.Provider != "aws" {
		t.Fatalf("%+v %v", ref, err)
	}
	v := f.ec2Calls[0]
	checks := map[string]string{
		"Action": "RunInstances", "ImageId": "ami-123", "InstanceType": "t3.medium", "MinCount": "1", "MaxCount": "1",
		"InstanceInitiatedShutdownBehavior": "terminate", "MetadataOptions.HttpTokens": "required", "SubnetId": "subnet-1",
		"SecurityGroupId.1": "sg-1", "SecurityGroupId.2": "sg-2", "KeyName": "key", "TagSpecification.1.ResourceType": "instance",
	}
	for k, want := range checks {
		if v.Get(k) != want {
			t.Errorf("%s = %q, want %q", k, v.Get(k), want)
		}
	}
	if ud, _ := base64.StdEncoding.DecodeString(v.Get("UserData")); string(ud) != "hello" {
		t.Errorf("user data %q", ud)
	}
	if v.Get("DryRun") != "" {
		t.Error("a real launch must not carry DryRun")
	}
	if v.Get("ClientToken") == "" {
		t.Error("missing idempotency token")
	}
	// Tags sortiert: Name, omp-deployment, omp-host, omp-pool.
	got := map[string]string{}
	for i := 1; i <= 4; i++ {
		got[v.Get("TagSpecification.1.Tag."+itoa(i)+".Key")] = v.Get("TagSpecification.1.Tag." + itoa(i) + ".Value")
	}
	if got["omp-deployment"] != "dep" || got["omp-host"] != "host-1" || got["Name"] != "host-1" {
		t.Errorf("tags %v", got)
	}
	if !strings.HasPrefix(f.auth[0], "AWS4-HMAC-SHA256 Credential=AK/20261008/eu-central-1/ec2/aws4_request") {
		t.Errorf("auth %q", f.auth[0])
	}
}

func itoa(i int) string { return string(rune('0' + i)) }

func TestAWSLaunchIsDryRunUnlessAllowed(t *testing.T) {
	f := newFakeAWS(t)
	f.runStatus = 412
	f.runXML = `<Response><Errors><Error><Code>DryRunOperation</Code><Message>Request would have succeeded</Message></Error></Errors></Response>`
	a := f.adapter(t, false)
	_, err := a.Launch(context.Background(), LaunchRequest{InstanceType: "t3.medium", Tags: map[string]string{TagHost: "h"}})
	if err == nil || !strings.Contains(err.Error(), "launching is disabled") {
		t.Fatalf("must refuse to launch: %v", err)
	}
	if f.ec2Calls[0].Get("DryRun") != "true" {
		t.Fatal("must send DryRun=true so nothing is started")
	}
	// Fehlende Rechte werden als Fehler des Trockenlaufs gemeldet.
	f.runXML = `<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>no</Message></Error></Errors></Response>`
	f.runStatus = 403
	if _, err := a.Launch(context.Background(), LaunchRequest{InstanceType: "t3.medium"}); err == nil || !strings.Contains(err.Error(), "dry run failed") {
		t.Fatalf("%v", err)
	}
}

const describePage1 = `<DescribeInstancesResponse><reservationSet><item><instancesSet>
<item><instanceId>i-1</instanceId><instanceType>t3.medium</instanceType><instanceState><name>running</name></instanceState>
<tagSet><item><key>omp-host</key><value>h1</value></item><item><key>omp-pool</key><value>burst</value></item></tagSet></item>
</instancesSet></item></reservationSet><nextToken>tok</nextToken></DescribeInstancesResponse>`
const describePage2 = `<DescribeInstancesResponse><reservationSet><item><instancesSet>
<item><instanceId>i-2</instanceId><instanceType>t3.large</instanceType><instanceState><name>shutting-down</name></instanceState><tagSet><item><key>omp-host</key><value>h2</value></item></tagSet></item>
</instancesSet></item></reservationSet></DescribeInstancesResponse>`

func TestAWSListFollowsPagesAndFiltersByTag(t *testing.T) {
	f := newFakeAWS(t)
	f.describeXML = []string{describePage1, describePage2}
	list, err := f.adapter(t, true).List(context.Background(), map[string]string{TagDeployment: "dep"})
	if err != nil || len(list) != 2 {
		t.Fatalf("%v %v", list, err)
	}
	if list[0].Ref.ID != "i-1" || list[0].State != StateRunning || list[0].Tags[TagHost] != "h1" || list[0].Type != "t3.medium" {
		t.Fatalf("%+v", list[0])
	}
	if list[1].State != StateStopping {
		t.Fatalf("shutting-down must map to stopping: %v", list[1].State)
	}
	if f.ec2Calls[0].Get("Filter.1.Name") != "tag:omp-deployment" || f.ec2Calls[0].Get("Filter.1.Value.1") != "dep" {
		t.Fatalf("filter %v", f.ec2Calls[0])
	}
	if f.ec2Calls[1].Get("NextToken") != "tok" {
		t.Fatal("must follow nextToken")
	}
}

func TestAWSDescribeAndTerminateMapNotFound(t *testing.T) {
	f := newFakeAWS(t)
	a := f.adapter(t, true)
	if _, err := a.Describe(context.Background(), InstanceRef{ID: "i-x"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("describe: %v", err)
	}
	if err := a.Terminate(context.Background(), InstanceRef{ID: "i-gone"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("terminate: %v", err)
	}
	if err := a.Terminate(context.Background(), InstanceRef{ID: "i-ok"}); err != nil {
		t.Fatal(err)
	}
	f.describeXML = []string{describePage1}
	f.mu.Lock()
	f.mu.Unlock()
	st, err := a.Describe(context.Background(), InstanceRef{ID: "i-1"})
	if err != nil || st != StateRunning {
		t.Fatalf("%v %v", st, err)
	}
}

func TestAWSCatalogParsesPriceListAndMemory(t *testing.T) {
	f := newFakeAWS(t)
	item := `{"product":{"attributes":{"instanceType":"t3.medium","vcpu":"2","memory":"4 GiB"}},"terms":{"OnDemand":{"X.JRTCKXETXF":{"priceDimensions":{"X.JRTCKXETXF.6YS6EN2CT7":{"unit":"Hrs","pricePerUnit":{"USD":"0.0456000000"}}}}}}}`
	enc, _ := json.Marshal(item) // Price-List-Einträge sind JSON-Strings
	f.pricing = `{"PriceList":[` + string(enc) + `]}`
	types, err := f.adapter(t, true).Catalog(context.Background(), "")
	if err != nil || len(types) != 1 {
		t.Fatalf("%v %v", types, err)
	}
	it := types[0]
	if it.Name != "t3.medium" || it.VCPU != 2 || it.MemGB != 4 || it.Currency != "USD" || it.PricePerHour != 0.0456 {
		t.Fatalf("%+v", it)
	}
	f.pricing = `{"PriceList":[]}`
	if _, err := f.adapter(t, true).Catalog(context.Background(), ""); err == nil {
		t.Fatal("missing price must be an error, not a silent 0")
	}
	if _, err := f.adapter(t, true).Catalog(context.Background(), "mars-1"); err == nil {
		t.Fatal("unknown region must be an error")
	}
}

func TestAWSActualCostSumsDaysAndReportsFreshness(t *testing.T) {
	f := newFakeAWS(t)
	f.cost = `{"ResultsByTime":[
	 {"TimePeriod":{"Start":"2026-10-06","End":"2026-10-07"},"Total":{"UnblendedCost":{"Amount":"1.25","Unit":"USD"}},"Estimated":false},
	 {"TimePeriod":{"Start":"2026-10-07","End":"2026-10-08"},"Total":{"UnblendedCost":{"Amount":"0.75","Unit":"USD"}},"Estimated":true}]}`
	rep, err := f.adapter(t, true).ActualCost(context.Background(), time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC), map[string]string{TagDeployment: "dep"})
	if err != nil || rep.Amount != 2.0 || rep.Currency != "USD" {
		t.Fatalf("%+v %v", rep, err)
	}
	if !rep.AsOf.Equal(time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("AsOf must be the end of the last final (non-estimated) day, got %v", rep.AsOf)
	}
}

func TestNewAWSValidatesConfig(t *testing.T) {
	for name, cfg := range map[string]AWSConfig{
		"region": {AccessKeyID: "a", SecretAccessKey: "b", ImageID: "ami"},
		"creds":  {Region: "eu-central-1", ImageID: "ami"},
		"ami":    {Region: "eu-central-1", AccessKeyID: "a", SecretAccessKey: "b"},
	} {
		if _, err := NewAWS(cfg); err == nil {
			t.Errorf("%s must be rejected", name)
		}
	}
}
