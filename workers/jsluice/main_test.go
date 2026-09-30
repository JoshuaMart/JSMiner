package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestSyntaxCoverage(t *testing.T) {
	for _, source := range []string{
		"const n = x?.5:0;",
		"const {a:b=()=>{},c:d=1} = x;",
		"class A { #x = 1; static { this.x = 2; } has(o) { return #x in o; } }",
		"const x = a?.b ?? 0;",
	} {
		if hasSyntaxError([]byte(source)) {
			t.Errorf("valid syntax rejected: %s", source)
		}
	}
	for _, source := range []string{"const x = ;", "function f( {", "const x = (1;"} {
		if !hasSyntaxError([]byte(source)) {
			t.Errorf("invalid syntax accepted: %s", source)
		}
	}
}

func TestBatchKeepsModuleBoundaries(t *testing.T) {
	var input, output bytes.Buffer
	encoder := json.NewEncoder(&input)
	for index, source := range []string{"fetch('/first');", "function broken( {", "fetch('/last');"} {
		if err := encoder.Encode(map[string]any{"index": index, "input": []byte(source)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := batch(&input, &output); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&output)
	for index := 0; index < 3; index++ {
		var item struct {
			Index  int
			Output []byte
			Error  *string
		}
		if err := decoder.Decode(&item); err != nil {
			t.Fatal(err)
		}
		if item.Index != index || item.Error != nil || !bytes.Contains(item.Output, []byte(`"type":"done"`)) {
			t.Fatalf("invalid frame %d", index)
		}
	}
	if batch(strings.NewReader(`{"index":1,"input":""}`), io.Discard) == nil {
		t.Fatal("accepted out-of-order input")
	}
}
