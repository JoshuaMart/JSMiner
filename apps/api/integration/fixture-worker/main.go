// Deterministic process fixtures for supervisor lifecycle checks, not an analyzer.
package main

import (
	"io"
	"os"
	"strings"
	"time"
)

func main() {
	data, _ := io.ReadAll(io.LimitReader(os.Stdin, 64))
	switch string(data) {
	case "sleep":
		time.Sleep(30 * time.Second)
	case "error":
		os.Exit(2)
	case "output":
		io.WriteString(os.Stdout, strings.Repeat("x", 3<<20))
	default:
		os.Exit(2)
	}
}
