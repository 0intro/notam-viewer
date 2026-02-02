# NOTAM Viewer

A web-based tool to parse NOTAMs (Notice to Airmen) and display their geographic coordinates on an interactive map.

## Features

- Parse NOTAMs and extract PSN (position) coordinates
- Display NOTAM locations on an interactive map
- Multiple layers available: OpenStreetMap, OpenTopoMap, IGN Ortho, Google Satellite and Bing Aerial
- Direct copy/paste from [SOFIA-Briefing](https://sofia-briefing.aviation-civile.gouv.fr/) and [autorouter](https://www.autorouter.aero/notam)
- Export map to PDF

## Supported NOTAM format

The parser extracts coordinates from lines containing `PSN :` followed by coordinates in DMS format:

- Latitude: DDMMSS[.ss]N/S (e.g., 484024N, 483923.17N)
- Longitude: DDDMMSS[.ss]E/W (e.g., 0030441E, 0035848.18E)

NOTAMs without PSN coordinates are ignored.

## Demo

Try it online: [https://0intro.github.io/notam-viewer](https://0intro.github.io/notam-viewer)

## License

MIT License - Copyright (c) 2026 David du Colombier

See [LICENSE](LICENSE) for details.
