package main

import "testing"

func TestEvaluateCountsPassAndOther(t *testing.T) {
	rf := ResultsFile{
		Suite: "IS-04-02",
		Results: []TestResult{
			{Name: "test_01", State: "Pass"},
			{Name: "test_02", State: "Pass"},
			{Name: "__init__", State: "Not Applicable"},
			{Name: "test_25_1", State: "Manual"},
		},
	}
	out := Evaluate(rf, nil)
	if out.PassCount != 2 {
		t.Errorf("PassCount = %d, want 2", out.PassCount)
	}
	if out.OtherCount != 2 {
		t.Errorf("OtherCount = %d, want 2", out.OtherCount)
	}
	if !out.Passed() {
		t.Error("Passed() = false, want true (no Fail states at all)")
	}
}

func TestEvaluateAllowedFailureDoesNotFailGate(t *testing.T) {
	rf := ResultsFile{
		Results: []TestResult{
			{Name: "test_01", State: "Fail", Detail: "mDNS not found"},
			{Name: "test_27", State: "Fail", Detail: "heartbeat timing"},
		},
	}
	allow := map[string]string{
		"test_01": "mDNS bewusst nicht implementiert",
		"test_27": "expiry interval bewusst 60s",
	}
	out := Evaluate(rf, allow)
	if !out.Passed() {
		t.Errorf("Passed() = false, want true (both fails are allow-listed): %+v", out.UnexpectedFailures)
	}
	if len(out.IgnoredFailures) != 2 {
		t.Errorf("IgnoredFailures = %+v, want 2 entries", out.IgnoredFailures)
	}
}

func TestEvaluateUnexpectedFailureFailsGate(t *testing.T) {
	rf := ResultsFile{
		Results: []TestResult{
			{Name: "test_01", State: "Fail", Detail: "mDNS not found"},
			{Name: "test_99", State: "Fail", Detail: "something unexpected broke"},
		},
	}
	allow := map[string]string{"test_01": "mDNS bewusst nicht implementiert"}
	out := Evaluate(rf, allow)
	if out.Passed() {
		t.Fatal("Passed() = true, want false (test_99 is not allow-listed)")
	}
	if len(out.UnexpectedFailures) != 1 || out.UnexpectedFailures[0].Name != "test_99" {
		t.Errorf("UnexpectedFailures = %+v, want exactly [test_99]", out.UnexpectedFailures)
	}
}

func TestParseResultsFileRoundTrips(t *testing.T) {
	data := []byte(`{"suite":"IS-04-02","results":[{"name":"test_01","state":"Pass","detail":""}]}`)
	rf, err := ParseResultsFile(data)
	if err != nil {
		t.Fatalf("ParseResultsFile() error = %v", err)
	}
	if rf.Suite != "IS-04-02" || len(rf.Results) != 1 || rf.Results[0].Name != "test_01" {
		t.Errorf("ParseResultsFile() = %+v, want parsed suite/results", rf)
	}
}

func TestParseResultsFileInvalidJSON(t *testing.T) {
	if _, err := ParseResultsFile([]byte("not json")); err == nil {
		t.Fatal("ParseResultsFile(invalid) error = nil, want error")
	}
}

func TestAllowFlagsSetRejectsMissingEquals(t *testing.T) {
	a := allowFlags{}
	if err := a.Set("no-equals-sign"); err == nil {
		t.Fatal("Set() error = nil, want error for missing '='")
	}
}

func TestAllowFlagsSetParsesNameAndReason(t *testing.T) {
	a := allowFlags{}
	if err := a.Set("test_27=known timing mismatch"); err != nil {
		t.Fatalf("Set() error = %v", err)
	}
	if a["test_27"] != "known timing mismatch" {
		t.Errorf("a[test_27] = %q, want %q", a["test_27"], "known timing mismatch")
	}
}
