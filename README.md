# NOTAM Viewer

A web-based tool to parse NOTAMs (Notice to Airmen) and display their geographic coordinates on an interactive map.

## Features

- Parse NOTAMs and extract coordinates from PSN (position), areas, and qualifier line
- Display NOTAM positions as markers and areas as polygons on an interactive map
- Multiple layers available: OpenStreetMap, OpenTopoMap, IGN Ortho, Google Satellite and Bing Aerial
- Direct copy/paste from [SOFIA-Briefing](https://sofia-briefing.aviation-civile.gouv.fr/) and [autorouter](https://www.autorouter.aero/notam)
- Export map to PDF

## Supported NOTAM format

The parser extracts coordinates from three sources:

### 1. Position coordinates (red markers)

Positions are detected when the E) section contains the `PSN` keyword followed by one or two coordinates in DMS format:

- Latitude: DDMMSS[.ss]N/S (e.g., 484024N, 483923.17N)
- Longitude: DDDMMSS[.ss]E/W (e.g., 0030441E, 0035848.18E)

Example:
```
E) OBSTACLE AT PSN 490204N 0022140E
```

### 2. Area coordinates (orange polygons)

Areas are detected when the E) section contains multiple coordinates (3+) that define a boundary. The parser recognizes areas through:

**Area keywords (non-exhaustive):**
- `LIMITES LATERALES` / `LATERAL LIMITS`
- `AREA`
- `WI COORD`

**Closed polygons:**
- Multiple coordinates where the last coordinate (often in parentheses) matches the first
- Example: `730000N 0240000E - 711608N 0240000E - ... - (730000N 0240000E)`

**Dash-connected coordinates:**
- 4+ coordinates connected by dashes, forming an area boundary

Example:
```
E) TEMPORARY SEGREGATED AREA ACTIVATED WI 422726N 0064355W,
423905N 0061544W, 423021N 0060859W, 422121N 0062349W,
421840N 0061723W, 422256N 0060213W, 420536N 0054903W,
415951N 0060938W, 422726N 0064355W
```

### 3. Qualifier line coordinates (blue markers)

Coordinates from the Q) line (e.g., 4845N00207E005), which includes a radius in nautical miles. These are shown only when no coordinates are found in the E) section and "Show all NOTAMs" is enabled.

## Demo

Try it online: [https://0intro.github.io/notam-viewer](https://0intro.github.io/notam-viewer)

## License

MIT License - Copyright (c) 2026 David du Colombier

See [LICENSE](LICENSE) for details.
