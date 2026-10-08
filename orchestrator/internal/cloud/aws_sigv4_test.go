package cloud

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// Das Beispiel aus der AWS-Dokumentation „Create a signed request“ (IAM ListUsers, 30.08.2015): der erwartete
// Signaturwert ist dort veröffentlicht.
func TestSignV4MatchesPublishedAWSExample(t *testing.T) {
	req, _ := http.NewRequest("GET", "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08", nil)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
	now := time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)
	signV4(req, nil, awsCreds{AccessKeyID: "AKIDEXAMPLE", SecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"}, "us-east-1", "iam", now)
	got := req.Header.Get("Authorization")
	want := "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
	if got != want {
		t.Fatalf("\n got %s\nwant %s", got, want)
	}
}

func TestSignV4AddsSessionTokenAndTargetToSignedHeaders(t *testing.T) {
	req, _ := http.NewRequest("POST", "https://ce.us-east-1.amazonaws.com/", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "AWSInsightsIndexService.GetCostAndUsage")
	signV4(req, []byte("{}"), awsCreds{AccessKeyID: "A", SecretAccessKey: "S", SessionToken: "TOK"}, "us-east-1", "ce", time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC))
	a := req.Header.Get("Authorization")
	if !strings.Contains(a, "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target") {
		t.Fatal(a)
	}
	if req.Header.Get("X-Amz-Security-Token") != "TOK" || req.Header.Get("X-Amz-Date") != "20261008T100000Z" {
		t.Fatal("headers")
	}
}
