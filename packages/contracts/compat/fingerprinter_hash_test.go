// Copied into a temporary Fingerprinter checkout by verify-fingerprinter-hash.py.
// Exercise upstream production functions with synthetic CDP responses, without Chrome or network.
package browser

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/cdp"
	"github.com/go-rod/rod/lib/proto"
)

type hashFixtureCDP struct {
	body        string
	encoded     bool
	unavailable bool
}

func (c hashFixtureCDP) Event() <-chan *cdp.Event { return nil }
func (c hashFixtureCDP) Call(_ context.Context, _, method string, _ interface{}) ([]byte, error) {
	if method != "Network.getResponseBody" {
		return nil, fmt.Errorf("unexpected CDP call: %s", method)
	}
	if c.unavailable {
		return nil, fmt.Errorf("fixture body unavailable")
	}
	return json.Marshal(map[string]interface{}{"body": c.body, "base64Encoded": c.encoded})
}

func fixtureScriptHash(t *testing.T, c hashFixtureCDP) string {
	t.Helper()
	page := rod.New().Client(c).PageFromSession("fixture")
	capture := NewNetworkCapture("example.invalid", "https://example.invalid", "frame")
	capture.HandleResponseReceived(&proto.NetworkResponseReceived{RequestID: "fixture", Type: proto.NetworkResourceTypeScript, Response: &proto.NetworkResponse{URL: "https://example.invalid/bundle.js"}})
	capture.HandleLoadingFinished(&proto.NetworkLoadingFinished{RequestID: "fixture"})
	results := (&Pool{}).buildScripts(page, capture, "example.invalid")
	if len(results) != 1 {
		t.Fatalf("expected one script, got %d", len(results))
	}
	return results[0].Hash
}

func TestJSMinerHashCompatibility(t *testing.T) {
	data, err := os.ReadFile(os.Getenv("JSMINER_HASH_VECTORS"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Vectors []struct {
			Name   string
			Hex    string `json:"utf8_hex"`
			SHA256 string
		}
		Boundaries []struct {
			Name        string
			RepeatCount int `json:"repeat_count"`
			Suffix      string
			Expected    string `json:"fingerprinter_sha256"`
		} `json:"boundary_vectors"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	if maxScriptHashBytes != 32<<20 {
		t.Fatalf("upstream hashing safety limit changed: %d", maxScriptHashBytes)
	}
	if MaxBodyBytes != 2097152 {
		t.Fatalf("upstream body limit changed: %d", MaxBodyBytes)
	}
	check := func(name string, body []byte, expected string) {
		for _, encoded := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/base64=%t", name, encoded), func(t *testing.T) {
				text := string(body)
				if encoded {
					text = base64.StdEncoding.EncodeToString(body)
				}
				if got := fixtureScriptHash(t, hashFixtureCDP{body: text, encoded: encoded}); got != expected {
					t.Fatalf("hash = %s, expected %s", got, expected)
				}
			})
		}
	}
	for _, v := range fixtures.Vectors {
		body, err := hex.DecodeString(v.Hex)
		if err != nil {
			t.Fatal(err)
		}
		check(v.Name, body, v.SHA256)
	}
	for _, v := range fixtures.Boundaries {
		check(v.Name, []byte(strings.Repeat("a", v.RepeatCount)+v.Suffix), v.Expected)
	}
	for name, c := range map[string]hashFixtureCDP{
		"empty": {}, "invalid-base64": {body: "!invalid!", encoded: true}, "unavailable": {unavailable: true},
	} {
		t.Run(name, func(t *testing.T) {
			if got := fixtureScriptHash(t, c); got != "" {
				t.Fatalf("expected omitted hash, got %q", got)
			}
		})
	}
}
