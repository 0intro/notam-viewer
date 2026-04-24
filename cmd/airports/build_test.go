package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var updateWant = flag.Bool("update", false, "update *.want.json files in testdata/")

// TestAirports runs the full transform on a France-only fixture and compares
// the serialised JSON byte-for-byte against checked-in *.want.json files.
// This is the actual contract with the browser: any format drift (key order,
// float printing, `null` vs `[]`, trailing newline) breaks the consumer
// silently in production but loudly here.
//
// Run `go test -update` to refresh the *.want.json files after an intentional
// change to fixtures or output format.
func TestAirports(t *testing.T) {
	airportsCsv, err := os.ReadFile(filepath.Join("testdata", "airports.csv"))
	if err != nil {
		t.Fatal(err)
	}
	runwaysCsv, err := os.ReadFile(filepath.Join("testdata", "runways.csv"))
	if err != nil {
		t.Fatal(err)
	}

	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	res, err := buildArtifact(string(airportsCsv), Options{
		MinRows:    1,
		MaxRows:    100,
		RunwaysCsv: string(runwaysCsv),
		Now:        fixedNow,
	})
	if err != nil {
		t.Fatal(err)
	}

	gotAirports, err := json.Marshal(res.Airports)
	if err != nil {
		t.Fatal(err)
	}
	gotMeta, err := json.MarshalIndent(res.Meta, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	gotMeta = append(gotMeta, '\n')

	checkWant(t, filepath.Join("testdata", "airports.want.json"), gotAirports)
	checkWant(t, filepath.Join("testdata", "airports.meta.want.json"), gotMeta)
}

func checkWant(t *testing.T, path string, got []byte) {
	t.Helper()
	if *updateWant {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("updated %s", path)
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run `go test -update` to create it)", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s mismatch (run `go test -update` to refresh)\n--- got ---\n%s\n--- want ---\n%s",
			path, got, want)
	}
}
