// A single offline analysis. Resource isolation and deadlines belong to the supervisor.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/BishopFox/jsluice"
	"io"
	"os"
	"runtime"
	"strconv"

	sitter "github.com/smacker/go-tree-sitter"
	"github.com/smacker/go-tree-sitter/javascript"
)

const version = "0ddfab153e060a9eeaded4d8669233f7c071e7e4-treesitterdd81d9e9be82-v5"
const outputLimit = 2 << 20

func hasSyntaxError(source []byte) bool {
	parser := sitter.NewParser()
	defer parser.Close()
	parser.SetLanguage(javascript.GetLanguage())
	tree := parser.Parse(nil, source)
	defer tree.Close()
	// HasError includes missing punctuation; querying only ERROR nodes does not.
	return tree.RootNode().HasError()
}

func analyze(source []byte) (output []byte, err error) {
	defer func() {
		if recover() != nil {
			output = nil
			err = errors.New("analysis failed")
		}
	}()
	if len(source) > 10<<20 {
		return nil, errors.New("input limit")
	}
	var buffer bytes.Buffer
	maxFindings := 200
	if value := os.Getenv("JSMINER_MAX_FINDINGS"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 2000 {
			panic("analysis failed")
		}
		maxFindings = limit
	}
	syntaxError := hasSyntaxError(source)
	analyzer := jsluice.NewAnalyzer(source)
	total, count := 0, 0
	truncated := false
	emit := func(value any) bool {
		data, err := json.Marshal(value)
		if err != nil {
			panic("analysis failed")
		}
		if total+len(data)+1 > outputLimit-1024 {
			truncated = true
			return false
		}
		if _, err = buffer.Write(append(data, '\n')); err != nil {
			panic("analysis failed")
		}
		total += len(data) + 1
		return true
	}
	// Secrets precede endpoints, so the API can redact their values before publication.
	for _, secret := range analyzer.GetSecrets() {
		if count >= maxFindings {
			truncated = true
			break
		}
		// Firebase's upstream Data contains an entire configuration object. Keep
		// only the credential fields, never unrelated objects or source context.
		data := secret.Data
		if secret.Kind == "firebase" {
			encoded, err := json.Marshal(secret.Data)
			if err != nil {
				panic("analysis failed")
			}
			var object map[string]any
			if json.Unmarshal(encoded, &object) != nil {
				panic("analysis failed")
			}
			key, ok := object["apiKey"].(string)
			if !ok {
				panic("analysis failed")
			}
			data = map[string]string{"key": key}
		}
		if !emit(map[string]any{"type": "secret", "kind": secret.Kind, "data": data}) {
			break
		}
		count++
	}
	secretsTruncated := truncated
	count = 0
	for _, endpoint := range analyzer.GetURLs() {
		if count >= maxFindings {
			truncated = true
			break
		}
		if !emit(map[string]any{"type": "endpoint", "url": endpoint.URL, "method": endpoint.Method, "kind": endpoint.Type, "query_params": endpoint.QueryParams, "body_params": endpoint.BodyParams}) {
			break
		}
		count++
	}
	emit(map[string]any{"type": "done", "version": version, "truncated": truncated, "secrets_truncated": secretsTruncated, "syntax_error": syntaxError})

	return buffer.Bytes(), nil
}

func batch(input io.Reader, output io.Writer) error {
	decoder := json.NewDecoder(io.LimitReader(input, (128<<20)+1))
	decoder.DisallowUnknownFields()
	encoder := json.NewEncoder(output)
	total := 0
	for index := 0; ; index++ {
		var item struct {
			Index *int   `json:"index"`
			Input []byte `json:"input"`
		}
		err := decoder.Decode(&item)
		if err == io.EOF {
			return nil
		}
		if err != nil || item.Index == nil || *item.Index != index || index >= 2000 || decoder.InputOffset() > 128<<20 || item.Input == nil {
			return errors.New("invalid batch")
		}
		data, err := analyze(item.Input)
		var failure *string
		if err != nil {
			code := "worker_failed"
			failure = &code
		}
		if err := encoder.Encode(struct {
			Index  int     `json:"index"`
			Output []byte  `json:"output"`
			Error  *string `json:"error"`
		}{index, data, failure}); err != nil {
			return err
		}
		// Native tree-sitter allocations are not accounted for by the Go heap trigger.
		total += len(item.Input)
		if index%16 == 15 || total >= 1<<20 {
			runtime.GC()
			total = 0
		}
	}
}
func main() {
	defer func() {
		if recover() != nil {
			os.Exit(2)
		}
	}()
	if len(os.Args) == 2 && os.Args[1] == "--batch" {
		if batch(os.Stdin, os.Stdout) != nil {
			os.Exit(2)
		}
		return
	}
	source, err := io.ReadAll(io.LimitReader(os.Stdin, (10<<20)+1))
	if err != nil {
		os.Exit(2)
	}
	output, err := analyze(source)
	if err != nil {
		os.Exit(2)
	}
	if _, err = os.Stdout.Write(output); err != nil {
		os.Exit(2)
	}
}
