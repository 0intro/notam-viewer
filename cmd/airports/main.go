// Command airports fetches the OurAirports CSVs and emits the JSON artefacts
// the browser client consumes (data/airports.json and data/airports.meta.json).
// Run directly or via the update-airports GitHub workflow.

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	airportsURL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
	runwaysURL  = "https://davidmegginson.github.io/ourairports-data/runways.csv"
	fetchTimeout = 60 * time.Second
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	outDir := flag.String("out", "../../data", "output directory for airports.json and airports.meta.json")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	airportsCsv, runwaysCsv, err := fetchAll(ctx, airportsURL, runwaysURL)
	if err != nil {
		return err
	}

	res, err := buildArtifact(airportsCsv, Options{RunwaysCsv: runwaysCsv})
	if err != nil {
		return err
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	if err := writeCompactJSON(filepath.Join(*outDir, "airports.json"), res.Airports); err != nil {
		return err
	}
	if err := writePrettyJSON(filepath.Join(*outDir, "airports.meta.json"), res.Meta); err != nil {
		return err
	}

	fmt.Printf("wrote %d airports and %d runways (from %d source rows; %d unknown type(s): %s)\n",
		len(res.Airports.Rows), res.Meta.RunwayCount, res.Meta.RawRowCount,
		len(res.Meta.UnknownTypes), joinOrNone(res.Meta.UnknownTypes))
	return nil
}

// fetchAll fetches two URLs concurrently. Returns the bodies in the same
// order, or the first error encountered.
func fetchAll(ctx context.Context, urls ...string) (string, string, error) {
	bodies := make([]string, len(urls))
	errs := make(chan error, len(urls))
	var wg sync.WaitGroup
	for i, u := range urls {
		wg.Add(1)
		go func(i int, u string) {
			defer wg.Done()
			body, err := fetch(ctx, u)
			if err != nil {
				errs <- err
				return
			}
			bodies[i] = body
		}(i, u)
	}
	wg.Wait()
	close(errs)
	if err, ok := <-errs; ok {
		return "", "", err
	}
	return bodies[0], bodies[1], nil
}

func fetch(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch %s: %w", url, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch %s: HTTP %d", url, res.StatusCode)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", url, err)
	}
	return string(body), nil
}

func writeCompactJSON(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func writePrettyJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o644)
}

func joinOrNone(s []string) string {
	if len(s) == 0 {
		return "none"
	}
	out := s[0]
	for _, v := range s[1:] {
		out += ", " + v
	}
	return out
}
