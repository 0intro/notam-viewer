# NOTAM Viewer

A web-based tool to parse NOTAMs (Notice to Airmen) and display their geographic coordinates on an interactive map.

## Features

- Parse NOTAMs and extract coordinates from PSN (position) and qualifier line
- Display NOTAM locations on an interactive map
- Multiple layers available: OpenStreetMap, OpenTopoMap, IGN Ortho, Google Satellite and Bing Aerial
- Direct copy/paste from [SOFIA-Briefing](https://sofia-briefing.aviation-civile.gouv.fr/) and [autorouter](https://www.autorouter.aero/notam)
- Export map to PDF

## Supported NOTAM format

The parser extracts coordinates from two sources:

### PSN coordinates (shown by default)

Lines containing `PSN :` followed by coordinates in DMS format:

- Latitude: DDMMSS[.ss]N/S (e.g., 484024N, 483923.17N)
- Longitude: DDDMMSS[.ss]E/W (e.g., 0030441E, 0035848.18E)

### Qualifier line coordinates (enable "Show all NOTAMs")

Coordinates from the Q) line in format DDMMN/SDDDMME/WRRR (e.g., 4845N00207E005), which includes a radius in nautical miles.

## Demo

Try it online: [https://0intro.github.io/notam-viewer](https://0intro.github.io/notam-viewer)

## License

MIT License - Copyright (c) 2026 David du Colombier

See [LICENSE](LICENSE) for details.
