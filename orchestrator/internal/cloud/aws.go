package cloud

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// AWSConfig konfiguriert den AWS-Adapter. Der Adapter spricht die EC2-, Pricing- und Cost-Explorer-HTTP-APIs
// direkt (Signature V4 in aws_sigv4.go) — bewusst ohne AWS-SDK (ARCHITECTURE.md §27.2: kein Cloud-SDK im Kern).
type AWSConfig struct {
	Region string
	// Zugangsdaten kommen aus der Umgebung (nie aus der Datenbank), s. AWSConfigFromEnv.
	AccessKeyID, SecretAccessKey, SessionToken string
	ImageID                                    string
	SubnetID                                   string
	SecurityGroupIDs                           []string
	KeyName                                    string
	// InstanceTypes: Typen, deren Preis `Catalog` abfragt (üblicherweise die der konfigurierten Pools).
	InstanceTypes []string
	// AllowLaunch=false (Standard): `Launch` sendet nur einen DryRun (prüft Rechte/Parameter), startet nichts und
	// kostet nichts. Erst `OMP_CLOUD_AWS_ALLOW_LAUNCH=1` erlaubt echte Starts.
	AllowLaunch bool
	// Endpunkte (nur für Tests überschreibbar).
	EC2Endpoint, PricingEndpoint, CostEndpoint string
	HTTP                                       *http.Client
	Now                                        func() time.Time
}

// AWS ist der Anbieter-Adapter für Amazon EC2.
type AWS struct{ cfg AWSConfig }

func NewAWS(cfg AWSConfig) (*AWS, error) {
	switch {
	case cfg.Region == "":
		return nil, fmt.Errorf("aws: region missing")
	case cfg.AccessKeyID == "" || cfg.SecretAccessKey == "":
		return nil, fmt.Errorf("aws: credentials missing")
	case cfg.ImageID == "":
		return nil, fmt.Errorf("aws: image id (AMI) missing")
	}
	if cfg.EC2Endpoint == "" {
		cfg.EC2Endpoint = "https://ec2." + cfg.Region + ".amazonaws.com/"
	}
	if cfg.PricingEndpoint == "" {
		cfg.PricingEndpoint = "https://api.pricing.us-east-1.amazonaws.com/"
	}
	if cfg.CostEndpoint == "" {
		cfg.CostEndpoint = "https://ce.us-east-1.amazonaws.com/"
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &AWS{cfg: cfg}, nil
}

func (a *AWS) Name() string { return "aws" }

func (a *AWS) creds() awsCreds {
	return awsCreds{AccessKeyID: a.cfg.AccessKeyID, SecretAccessKey: a.cfg.SecretAccessKey, SessionToken: a.cfg.SessionToken}
}

// do sendet eine signierte Anfrage und liefert Status und Body (Body auf 8 MiB begrenzt).
func (a *AWS) do(ctx context.Context, endpoint, region, service, contentType, target string, body []byte) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", contentType)
	if target != "" {
		req.Header.Set("X-Amz-Target", target)
	}
	signV4(req, body, a.creds(), region, service, a.cfg.Now())
	resp, err := a.cfg.HTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return resp.StatusCode, b, err
}

// ---- EC2 (Query-API, XML) ----

type ec2Error struct {
	Code, Message string
	Status        int
}

func (e *ec2Error) Error() string {
	return fmt.Sprintf("aws ec2: %s: %s (HTTP %d)", e.Code, e.Message, e.Status)
}

func parseEC2Error(status int, body []byte) error {
	var x struct {
		Errors []struct {
			Code    string `xml:"Code"`
			Message string `xml:"Message"`
		} `xml:"Errors>Error"`
	}
	if xml.Unmarshal(body, &x) == nil && len(x.Errors) > 0 {
		return &ec2Error{Code: x.Errors[0].Code, Message: x.Errors[0].Message, Status: status}
	}
	return &ec2Error{Code: "Unknown", Message: strings.TrimSpace(string(body[:min(len(body), 200)])), Status: status}
}

func (a *AWS) ec2(ctx context.Context, action string, params url.Values) ([]byte, error) {
	params.Set("Action", action)
	params.Set("Version", "2016-11-15")
	status, body, err := a.do(ctx, a.cfg.EC2Endpoint, a.cfg.Region, "ec2", "application/x-www-form-urlencoded; charset=utf-8", "", []byte(params.Encode()))
	if err != nil {
		return nil, fmt.Errorf("aws ec2 %s: %w", action, err)
	}
	if status/100 != 2 {
		return nil, parseEC2Error(status, body)
	}
	return body, nil
}

func awsState(name string) State {
	switch name {
	case "pending":
		return StatePending
	case "running":
		return StateRunning
	case "shutting-down", "stopping", "stopped":
		return StateStopping
	case "terminated":
		return StateTerminated
	}
	return StateUnknown
}

type ec2Instance struct {
	ID    string `xml:"instanceId"`
	Type  string `xml:"instanceType"`
	State struct {
		Name string `xml:"name"`
	} `xml:"instanceState"`
	Tags []struct {
		Key   string `xml:"key"`
		Value string `xml:"value"`
	} `xml:"tagSet>item"`
}

func (i ec2Instance) info() InstanceInfo {
	tags := map[string]string{}
	for _, t := range i.Tags {
		tags[t.Key] = t.Value
	}
	return InstanceInfo{Ref: InstanceRef{Provider: "aws", ID: i.ID}, State: awsState(i.State.Name), Tags: tags, Type: i.Type}
}

type ec2Describe struct {
	Instances []ec2Instance `xml:"reservationSet>item>instancesSet>item"`
	NextToken string        `xml:"nextToken"`
}

func (a *AWS) Launch(ctx context.Context, req LaunchRequest) (InstanceRef, error) {
	p := url.Values{}
	p.Set("ImageId", a.cfg.ImageID)
	p.Set("InstanceType", req.InstanceType)
	p.Set("MinCount", "1")
	p.Set("MaxCount", "1")
	p.Set("InstanceInitiatedShutdownBehavior", "terminate")
	p.Set("MetadataOptions.HttpTokens", "required") // IMDSv2
	if req.UserData != "" {
		p.Set("UserData", base64.StdEncoding.EncodeToString([]byte(req.UserData)))
	}
	if a.cfg.SubnetID != "" {
		p.Set("SubnetId", a.cfg.SubnetID)
	}
	for i, sg := range a.cfg.SecurityGroupIDs {
		p.Set(fmt.Sprintf("SecurityGroupId.%d", i+1), sg)
	}
	if a.cfg.KeyName != "" {
		p.Set("KeyName", a.cfg.KeyName)
	}
	// Idempotenz: dieselbe Anforderung (gleiche Host-ID) startet nie zwei Instanzen.
	sum := sha256.Sum256([]byte(req.Tags[TagHost] + "|" + req.Label))
	p.Set("ClientToken", hex.EncodeToString(sum[:16]))
	p.Set("TagSpecification.1.ResourceType", "instance")
	keys := make([]string, 0, len(req.Tags)+1)
	tags := map[string]string{"Name": req.Label}
	for k, v := range req.Tags {
		tags[k] = v
	}
	for k := range tags {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for i, k := range keys {
		p.Set(fmt.Sprintf("TagSpecification.1.Tag.%d.Key", i+1), k)
		p.Set(fmt.Sprintf("TagSpecification.1.Tag.%d.Value", i+1), tags[k])
	}
	if !a.cfg.AllowLaunch {
		// Nur prüfen: AWS antwortet bei ausreichenden Rechten mit DryRunOperation und startet nichts.
		p.Set("DryRun", "true")
		_, err := a.ec2(ctx, "RunInstances", p)
		var e *ec2Error
		if errors.As(err, &e) && e.Code == "DryRunOperation" {
			return InstanceRef{}, fmt.Errorf("aws: dry run succeeded, launching is disabled (set OMP_CLOUD_AWS_ALLOW_LAUNCH=1 to start instances)")
		}
		if err == nil {
			return InstanceRef{}, fmt.Errorf("aws: launching is disabled")
		}
		return InstanceRef{}, fmt.Errorf("aws: dry run failed: %w", err)
	}
	body, err := a.ec2(ctx, "RunInstances", p)
	if err != nil {
		return InstanceRef{}, err
	}
	var out struct {
		Instances []ec2Instance `xml:"instancesSet>item"`
	}
	if err := xml.Unmarshal(body, &out); err != nil || len(out.Instances) == 0 || out.Instances[0].ID == "" {
		return InstanceRef{}, fmt.Errorf("aws: unexpected RunInstances response")
	}
	return InstanceRef{Provider: "aws", ID: out.Instances[0].ID}, nil
}

func (a *AWS) describe(ctx context.Context, p url.Values) ([]InstanceInfo, error) {
	var out []InstanceInfo
	for page := 0; page < 50; page++ {
		body, err := a.ec2(ctx, "DescribeInstances", p)
		if err != nil {
			return nil, err
		}
		var d ec2Describe
		if err := xml.Unmarshal(body, &d); err != nil {
			return nil, fmt.Errorf("aws: DescribeInstances response: %w", err)
		}
		for _, i := range d.Instances {
			out = append(out, i.info())
		}
		if d.NextToken == "" {
			return out, nil
		}
		p.Set("NextToken", d.NextToken)
	}
	return out, nil
}

func (a *AWS) Describe(ctx context.Context, ref InstanceRef) (State, error) {
	p := url.Values{}
	p.Set("InstanceId.1", ref.ID)
	list, err := a.describe(ctx, p)
	var e *ec2Error
	if errors.As(err, &e) && strings.HasPrefix(e.Code, "InvalidInstanceID") {
		return StateUnknown, ErrNotFound
	}
	if err != nil {
		return StateUnknown, err
	}
	if len(list) == 0 {
		return StateUnknown, ErrNotFound
	}
	return list[0].State, nil
}

func (a *AWS) Terminate(ctx context.Context, ref InstanceRef) error {
	p := url.Values{}
	p.Set("InstanceId.1", ref.ID)
	_, err := a.ec2(ctx, "TerminateInstances", p)
	var e *ec2Error
	if errors.As(err, &e) && strings.HasPrefix(e.Code, "InvalidInstanceID") {
		return ErrNotFound
	}
	return err
}

func (a *AWS) List(ctx context.Context, filter map[string]string) ([]InstanceInfo, error) {
	p := url.Values{}
	keys := make([]string, 0, len(filter))
	for k := range filter {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for i, k := range keys {
		p.Set(fmt.Sprintf("Filter.%d.Name", i+1), "tag:"+k)
		p.Set(fmt.Sprintf("Filter.%d.Value.1", i+1), filter[k])
	}
	return a.describe(ctx, p)
}

// ---- Preise (AWS Price List API) ----

// awsLocations bildet Regionscodes auf die Ortsnamen der Preisliste ab.
var awsLocations = map[string]string{
	"us-east-1": "US East (N. Virginia)", "us-east-2": "US East (Ohio)", "us-west-1": "US West (N. California)",
	"us-west-2": "US West (Oregon)", "eu-central-1": "EU (Frankfurt)", "eu-west-1": "EU (Ireland)",
	"eu-west-2": "EU (London)", "eu-west-3": "EU (Paris)", "eu-north-1": "EU (Stockholm)", "eu-south-1": "EU (Milan)",
	"ap-southeast-1": "Asia Pacific (Singapore)", "ap-southeast-2": "Asia Pacific (Sydney)", "ap-northeast-1": "Asia Pacific (Tokyo)",
	"ca-central-1": "Canada (Central)", "sa-east-1": "South America (Sao Paulo)",
}

func (a *AWS) price(ctx context.Context, region, typ string) (InstanceType, error) {
	loc, ok := awsLocations[region]
	if !ok {
		return InstanceType{}, fmt.Errorf("aws: no price-list location known for region %q", region)
	}
	filters := []map[string]string{
		{"Type": "TERM_MATCH", "Field": "instanceType", "Value": typ},
		{"Type": "TERM_MATCH", "Field": "location", "Value": loc},
		{"Type": "TERM_MATCH", "Field": "operatingSystem", "Value": "Linux"},
		{"Type": "TERM_MATCH", "Field": "tenancy", "Value": "Shared"},
		{"Type": "TERM_MATCH", "Field": "preInstalledSw", "Value": "NA"},
		{"Type": "TERM_MATCH", "Field": "capacitystatus", "Value": "Used"},
	}
	req, _ := json.Marshal(map[string]any{"ServiceCode": "AmazonEC2", "Filters": filters, "MaxResults": 5})
	status, body, err := a.do(ctx, a.cfg.PricingEndpoint, "us-east-1", "pricing", "application/x-amz-json-1.1", "AWSPriceListService.GetProducts", req)
	if err != nil {
		return InstanceType{}, fmt.Errorf("aws pricing: %w", err)
	}
	if status/100 != 2 {
		return InstanceType{}, fmt.Errorf("aws pricing: HTTP %d: %s", status, strings.TrimSpace(string(body[:min(len(body), 200)])))
	}
	var resp struct {
		PriceList []json.RawMessage `json:"PriceList"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return InstanceType{}, fmt.Errorf("aws pricing: response: %w", err)
	}
	for _, raw := range resp.PriceList {
		// Jeder Eintrag ist ein JSON-String (doppelt kodiert).
		var s string
		doc := []byte(raw)
		if json.Unmarshal(raw, &s) == nil {
			doc = []byte(s)
		}
		var item struct {
			Product struct {
				Attributes map[string]string `json:"attributes"`
			} `json:"product"`
			Terms struct {
				OnDemand map[string]struct {
					PriceDimensions map[string]struct {
						Unit         string            `json:"unit"`
						PricePerUnit map[string]string `json:"pricePerUnit"`
					} `json:"priceDimensions"`
				} `json:"OnDemand"`
			} `json:"terms"`
		}
		if json.Unmarshal(doc, &item) != nil {
			continue
		}
		for _, term := range item.Terms.OnDemand {
			for _, dim := range term.PriceDimensions {
				if dim.Unit != "Hrs" {
					continue
				}
				for cur, v := range dim.PricePerUnit {
					price, err := strconv.ParseFloat(v, 64)
					if err != nil || price <= 0 {
						continue
					}
					it := InstanceType{Name: typ, PricePerHour: price, Currency: cur}
					it.VCPU, _ = strconv.Atoi(item.Product.Attributes["vcpu"])
					it.MemGB = parseGiB(item.Product.Attributes["memory"])
					if g, err := strconv.Atoi(item.Product.Attributes["gpu"]); err == nil {
						it.GPU = g
					}
					return it, nil
				}
			}
		}
	}
	return InstanceType{}, fmt.Errorf("aws pricing: no on-demand Linux price found for %s in %s", typ, region)
}

func parseGiB(s string) float64 {
	f := strings.Fields(strings.ReplaceAll(s, ",", ""))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

// Catalog liefert die Preise der konfigurierten Instanztypen (nicht des ganzen Katalogs: das wären Tausende Einträge).
func (a *AWS) Catalog(ctx context.Context, region string) ([]InstanceType, error) {
	if region == "" {
		region = a.cfg.Region
	}
	var out []InstanceType
	for _, t := range a.cfg.InstanceTypes {
		it, err := a.price(ctx, region, t)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, nil
}

// ---- Ist-Kosten (Cost Explorer) ----

// ActualCost fragt die vom Anbieter abgerechneten Kosten der mit `omp-deployment` (o. Ä.) markierten Ressourcen ab.
// Voraussetzungen: Der Tag-Schlüssel muss in der AWS-Fakturierung als Kostenverteilungs-Tag aktiviert sein, und jede
// Abfrage kostet beim Anbieter selbst Geld (derzeit 0,01 USD) — deshalb nur auf ausdrücklichen Wunsch aufrufen.
func (a *AWS) ActualCost(ctx context.Context, from, to time.Time, filter map[string]string) (CostReport, error) {
	req := map[string]any{
		"TimePeriod":  map[string]string{"Start": from.UTC().Format("2006-01-02"), "End": to.UTC().Format("2006-01-02")},
		"Granularity": "DAILY",
		"Metrics":     []string{"UnblendedCost"},
	}
	var tagFilters []map[string]any
	keys := make([]string, 0, len(filter))
	for k := range filter {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		tagFilters = append(tagFilters, map[string]any{"Tags": map[string]any{"Key": k, "Values": []string{filter[k]}}})
	}
	switch len(tagFilters) {
	case 0:
	case 1:
		req["Filter"] = tagFilters[0]
	default:
		req["Filter"] = map[string]any{"And": tagFilters}
	}
	b, _ := json.Marshal(req)
	status, body, err := a.do(ctx, a.cfg.CostEndpoint, "us-east-1", "ce", "application/x-amz-json-1.1", "AWSInsightsIndexService.GetCostAndUsage", b)
	if err != nil {
		return CostReport{}, fmt.Errorf("aws cost explorer: %w", err)
	}
	if status/100 != 2 {
		return CostReport{}, fmt.Errorf("aws cost explorer: HTTP %d: %s", status, strings.TrimSpace(string(body[:min(len(body), 200)])))
	}
	var resp struct {
		ResultsByTime []struct {
			TimePeriod struct{ End string } `json:"TimePeriod"`
			Total      map[string]struct {
				Amount string `json:"Amount"`
				Unit   string `json:"Unit"`
			} `json:"Total"`
			Estimated bool `json:"Estimated"`
		} `json:"ResultsByTime"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return CostReport{}, fmt.Errorf("aws cost explorer: response: %w", err)
	}
	rep := CostReport{From: from, To: to}
	for _, r := range resp.ResultsByTime {
		c := r.Total["UnblendedCost"]
		v, err := strconv.ParseFloat(c.Amount, 64)
		if err != nil {
			continue
		}
		rep.Amount += v
		rep.Currency = c.Unit
		if end, err := time.Parse("2006-01-02", r.TimePeriod.End); err == nil && !r.Estimated && end.After(rep.AsOf) {
			rep.AsOf = end
		}
	}
	rep.Amount = round6(rep.Amount)
	return rep, nil
}

var _ Provider = (*AWS)(nil)
