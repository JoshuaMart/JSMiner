// A single offline analysis. Resource isolation and deadlines belong to the supervisor.
package main

import (
	"encoding/json"
	"github.com/BishopFox/jsluice"
	"io"
	"os"

	sitter "github.com/smacker/go-tree-sitter"
	"github.com/smacker/go-tree-sitter/javascript"
)

const version = "0ddfab153e060a9eeaded4d8669233f7c071e7e4"
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

func main() {
	// Never print a panic or parser context containing source text.
	defer func() {
		if recover() != nil {
			os.Exit(2)
		}
	}()
	source, err := io.ReadAll(io.LimitReader(os.Stdin, (10<<20)+1))
	if err != nil || len(source) == 0 || len(source) > 10<<20 {
		os.Exit(2)
	}
	syntaxError := hasSyntaxError(source)
	analyzer := jsluice.NewAnalyzer(source)
	total, count := 0, 0
	truncated := false
	emit := func(value any) bool {
		data, err := json.Marshal(value)
		if err != nil {
			os.Exit(2)
		}
		if total+len(data)+1 > outputLimit-1024 {
			truncated = true
			return false
		}
		if _, err = os.Stdout.Write(append(data, '\n')); err != nil {
			os.Exit(2)
		}
		total += len(data) + 1
		return true
	}
	// Secrets precede endpoints, so the API can redact their values before publication.
	for _, secret := range analyzer.GetSecrets() {
		if count >= 200 {
			truncated = true
			break
		}
		// Firebase's upstream Data contains an entire configuration object. Keep
		// only the credential fields, never unrelated objects or source context.
		data := secret.Data
		if secret.Kind == "firebase" {
			encoded, err := json.Marshal(secret.Data)
			if err != nil {
				os.Exit(2)
			}
			var object map[string]any
			if json.Unmarshal(encoded, &object) != nil {
				os.Exit(2)
			}
			key, ok := object["apiKey"].(string)
			if !ok {
				os.Exit(2)
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
		if count >= 200 {
			truncated = true
			break
		}
		if !emit(map[string]any{"type": "endpoint", "url": endpoint.URL, "method": endpoint.Method, "kind": endpoint.Type, "query_params": endpoint.QueryParams, "body_params": endpoint.BodyParams}) {
			break
		}
		count++
	}
	emit(map[string]any{"type": "done", "version": version, "truncated": truncated, "secrets_truncated": secretsTruncated, "syntax_error": syntaxError})
}
