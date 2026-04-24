// Pure data-transform layer: turn the OurAirports CSVs into the positional-array
// JSON shape the browser consumes. No I/O lives here so it stays test-friendly.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	defaultMinRows = 60000
	defaultMaxRows = 120000
)

// Output fields. Order matters: the browser references them via index
// constants (AIRPORT_IDX) in script.js.
var outputFields = []string{
	"ident",
	"type",
	"name",
	"lat",
	"lon",
	"elev_ft",
	"iso_country",
	"municipality",
	"iata",
	"runways",
}

// Per-runway sub-array shape (must mirror RUNWAY_IDX in script.js).
var runwayFields = []string{"le", "he", "length_ft", "width_ft", "surface", "lit"}

var requiredSourceColumns = []string{
	"ident",
	"type",
	"name",
	"latitude_deg",
	"longitude_deg",
	"elevation_ft",
	"iso_country",
	"municipality",
	"iata_code",
	"icao_code",
}

var requiredRunwayColumns = []string{
	"airport_ident",
	"length_ft",
	"width_ft",
	"surface",
	"lighted",
	"closed",
	"le_ident",
	"he_ident",
}

// OurAirports assigns synthetic idents of the form XX-NNNN to airports that
// have no official code (no ICAO, no FAA, no local). In practice these are
// ULM / altisurface strips, private ranches, informal hospital helipads, and
// closed airports — the kind of points that clutter the map without adding
// useful context to a NOTAM viewer.
var syntheticIdentRE = regexp.MustCompile(`^[A-Z]{2}-[0-9]+$`)

// Secondary records OurAirports keeps for airports that already have a
// canonical entry under their real ICAO ident — names literally start with
// "(Duplicate)" or "(??Duplicate??)".
var duplicateNameRE = regexp.MustCompile(`^\(\?*[Dd]uplicate`)

// Artifact is the top-level shape written to data/airports.json. Field order
// here determines key order in the compact JSON output.
type Artifact struct {
	Fields       []string `json:"fields"`
	RunwayFields []string `json:"runwayFields"`
	Rows         []any    `json:"rows"`
}

// Meta is the shape written to data/airports.meta.json. Field declaration
// order is the on-disk key order.
type Meta struct {
	GeneratedAt   string   `json:"generatedAt"`
	SourceSha256  string   `json:"sourceSha256"`
	RawRowCount   int      `json:"rawRowCount"`
	RowCount      int      `json:"rowCount"`
	RunwayCount   int      `json:"runwayCount"`
	UnknownTypes  []string `json:"unknownTypes"`
}

// Result is the combined artifact + meta returned by buildArtifact.
type Result struct {
	Airports Artifact
	Meta     Meta
}

// Options tunes the build: the sanity-window bounds and, optionally, a parsed
// runways map to avoid re-parsing during tests.
type Options struct {
	MinRows         int
	MaxRows         int
	RunwaysCsv      string
	RunwaysByIdent  map[string][]any
	Now             func() time.Time // overridable for tests
}

// parseCsvLine splits a single CSV line from the OurAirports dataset.
//
// Handles quoted fields that may contain commas, and RFC-4180 "" escapes
// inside quoted fields. The source file does not contain embedded newlines,
// so line-based parsing is safe.
func parseCsvLine(line string) []string {
	fields := []string{}
	var current strings.Builder
	inQuotes := false
	i := 0
	for i < len(line) {
		ch := line[i]
		switch {
		case inQuotes:
			if ch == '"' {
				if i+1 < len(line) && line[i+1] == '"' {
					current.WriteByte('"')
					i += 2
				} else {
					inQuotes = false
					i++
				}
			} else {
				current.WriteByte(ch)
				i++
			}
		case ch == ',':
			fields = append(fields, current.String())
			current.Reset()
			i++
		case ch == '"' && current.Len() == 0:
			inQuotes = true
			i++
		default:
			current.WriteByte(ch)
			i++
		}
	}
	fields = append(fields, current.String())
	return fields
}

// round5 rounds to 5 decimals (matches JS Math.round(x*1e5)/1e5). Keeps JSON
// short (e.g. 40.07099 not 40.07099000000001) and gives ~1.1 m precision at
// the equator — ample for an airport icon.
func round5(x float64) float64 {
	return math.Round(x*1e5) / 1e5
}

// nullableInt returns nil if s is empty or unparseable, otherwise an int.
// Marshals to JSON null vs. integer respectively.
func nullableInt(s string) any {
	if s == "" {
		return nil
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return nil
	}
	return n
}

// positiveInt is nullableInt but also rejects zero/negative (used for runway
// length_ft and width_ft, where 0 means "missing" rather than "valid").
func positiveInt(s string) any {
	if s == "" {
		return nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return nil
	}
	return n
}

// indexHeader builds a column-name -> column-index map and verifies every
// required column is present.
func indexHeader(header []string, required []string, kind string) (map[string]int, error) {
	idx := map[string]int{}
	for i, name := range header {
		idx[name] = i
	}
	for _, col := range required {
		if _, ok := idx[col]; !ok {
			return nil, fmt.Errorf("missing required %s CSV column: %s", kind, col)
		}
	}
	return idx, nil
}

// splitCsvLines normalises CRLF and drops empty lines, matching the JS preproc.
func splitCsvLines(csv string) []string {
	csv = strings.ReplaceAll(csv, "\r\n", "\n")
	raw := strings.Split(csv, "\n")
	out := raw[:0]
	for _, l := range raw {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// parseRunways turns runways.csv into a Map<airport_ident, []runway-row> where
// each runway-row is a positional []any matching runwayFields. Closed runways
// are excluded.
func parseRunways(csv string) (map[string][]any, error) {
	if csv == "" {
		return map[string][]any{}, nil
	}
	lines := splitCsvLines(csv)
	if len(lines) < 2 {
		return map[string][]any{}, nil
	}
	header := parseCsvLine(lines[0])
	idx, err := indexHeader(header, requiredRunwayColumns, "runways")
	if err != nil {
		return nil, err
	}
	byIdent := map[string][]any{}
	for _, line := range lines[1:] {
		cells := parseCsvLine(line)
		if cells[idx["closed"]] == "1" {
			continue
		}
		ident := cells[idx["airport_ident"]]
		if ident == "" {
			continue
		}
		entry := []any{
			cells[idx["le_ident"]],
			cells[idx["he_ident"]],
			positiveInt(cells[idx["length_ft"]]),
			positiveInt(cells[idx["width_ft"]]),
			cells[idx["surface"]],
			boolFlag(cells[idx["lighted"]]),
		}
		byIdent[ident] = append(byIdent[ident], entry)
	}
	return byIdent, nil
}

// boolFlag matches the JS pattern `x === '1' ? 1 : 0` — keep it as a JSON
// integer, not a JSON bool, to match the existing on-disk shape.
func boolFlag(s string) int {
	if s == "1" {
		return 1
	}
	return 0
}

// buildArtifact builds the JSON artefacts from a raw airports.csv string.
//
// opts.MinRows / opts.MaxRows override the row-count sanity window; tests use
// this to exercise the throw path with small fixtures.
func buildArtifact(csv string, opts Options) (Result, error) {
	minRows := opts.MinRows
	if minRows == 0 {
		minRows = defaultMinRows
	}
	maxRows := opts.MaxRows
	if maxRows == 0 {
		maxRows = defaultMaxRows
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	runways := opts.RunwaysByIdent
	if opts.RunwaysCsv != "" {
		parsed, err := parseRunways(opts.RunwaysCsv)
		if err != nil {
			return Result{}, err
		}
		runways = parsed
	}
	if runways == nil {
		runways = map[string][]any{}
	}

	lines := splitCsvLines(csv)
	if len(lines) < 2 {
		return Result{}, fmt.Errorf("CSV contains fewer than 2 non-empty lines")
	}
	header := parseCsvLine(lines[0])
	idx, err := indexHeader(header, requiredSourceColumns, "")
	if err != nil {
		return Result{}, err
	}

	unknownTypes := map[string]struct{}{}
	rows := []any{}
	rawParsedCount := 0
	for _, line := range lines[1:] {
		cells := parseCsvLine(line)
		ident := cells[idx["ident"]]
		typ := cells[idx["type"]]
		name := cells[idx["name"]]
		if ident == "" || typ == "" || name == "" {
			continue
		}
		rawParsedCount++

		// Drop uncoded ULM/altisurface/private/closed points.
		if syntheticIdentRE.MatchString(ident) && cells[idx["icao_code"]] == "" {
			continue
		}
		// Drop explicit duplicate records.
		if duplicateNameRE.MatchString(name) {
			continue
		}

		latStr := cells[idx["latitude_deg"]]
		lonStr := cells[idx["longitude_deg"]]
		if latStr == "" || lonStr == "" {
			continue
		}
		lat, err1 := strconv.ParseFloat(latStr, 64)
		lon, err2 := strconv.ParseFloat(lonStr, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		if math.IsNaN(lat) || math.IsNaN(lon) || math.IsInf(lat, 0) || math.IsInf(lon, 0) {
			continue
		}
		if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			continue
		}
		// (0, 0) is the classic missing-coordinate sentinel.
		if lat == 0 && lon == 0 {
			continue
		}

		if !isKnownType(typ) {
			unknownTypes[typ] = struct{}{}
		}

		rws := runways[ident]
		if rws == nil {
			rws = []any{}
		}

		rows = append(rows, []any{
			ident,
			typ,
			name,
			round5(lat),
			round5(lon),
			nullableInt(cells[idx["elevation_ft"]]),
			cells[idx["iso_country"]],
			cells[idx["municipality"]],
			cells[idx["iata_code"]],
			rws,
		})
	}

	if rawParsedCount < minRows || rawParsedCount > maxRows {
		return Result{}, fmt.Errorf(
			"raw parsed count %d outside sanity window [%d, %d] - source format may have changed",
			rawParsedCount, minRows, maxRows,
		)
	}

	runwayCount := 0
	for _, rws := range runways {
		runwayCount += len(rws)
	}

	sortedUnknown := make([]string, 0, len(unknownTypes))
	for t := range unknownTypes {
		sortedUnknown = append(sortedUnknown, t)
	}
	sort.Strings(sortedUnknown)

	sum := sha256.Sum256([]byte(csv))

	return Result{
		Airports: Artifact{
			Fields:       outputFields,
			RunwayFields: runwayFields,
			Rows:         rows,
		},
		Meta: Meta{
			GeneratedAt:  now().UTC().Format("2006-01-02T15:04:05.000Z"),
			SourceSha256: hex.EncodeToString(sum[:]),
			RawRowCount:  rawParsedCount,
			RowCount:     len(rows),
			RunwayCount:  runwayCount,
			UnknownTypes: sortedUnknown,
		},
	}, nil
}

var knownTypes = map[string]struct{}{
	"large_airport":  {},
	"medium_airport": {},
	"small_airport":  {},
	"heliport":       {},
	"seaplane_base":  {},
	"balloonport":    {},
	"closed":         {},
}

func isKnownType(t string) bool {
	_, ok := knownTypes[t]
	return ok
}
