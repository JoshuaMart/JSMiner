// Qualification-only wrapper: measures the whole container cgroup, including children.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		os.Exit(125)
	}
	command := exec.Command(os.Args[1], os.Args[2:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := command.Run()
	peak := int64(0)
	for _, path := range []string{"/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"} {
		raw, e := os.ReadFile(path)
		if e == nil {
			peak, _ = strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
			if peak > 0 {
				break
			}
		}
	}
	payload, _ := json.Marshal(map[string]int64{"peak_bytes": peak})
	fmt.Fprintf(os.Stderr, "\nJSMINER_METRICS:%s\n", payload)
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		os.Exit(125)
	}
}
