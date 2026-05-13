// Constants
const DEFAULT_CENTER = [48.8566, 2.3522];
const DEFAULT_ZOOM = 6;
const POPUP_OPTIONS = { maxWidth: 600, maxHeight: 500 };
const FIT_BOUNDS_PADDING = { padding: [50, 50] };
const NM_TO_METERS = 1852;
const NM_TO_KILOMETERS = 1.852;

// Initialize the map centered on France
const map = L.map('map').setView(DEFAULT_CENTER, DEFAULT_ZOOM);

// Define tile layers
const openStreetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
	attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
	maxZoom: 19
});

const openTopoMap = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
	attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
	maxZoom: 17
});

const ignOrtho = L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', {
	attribution: '&copy; <a href="https://cartes.gouv.fr/">IGN</a>',
	maxZoom: 19
});

const googleSatellite = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
	attribution: '&copy; Google',
	subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
	maxZoom: 20
});

// Bing Aerial with quadkey conversion
const BingLayer = L.TileLayer.extend({
	getTileUrl: function(coords) {
		const quadkey = this._toQuadKey(coords.x, coords.y, coords.z);
		return `https://ecn.t${coords.x % 4}.tiles.virtualearth.net/tiles/a${quadkey}.jpeg?g=14028`;
	},
	_toQuadKey: function(x, y, z) {
		let quadKey = '';
		for (let i = z; i > 0; i--) {
			let digit = 0;
			const mask = 1 << (i - 1);
			if ((x & mask) !== 0) digit += 1;
			if ((y & mask) !== 0) digit += 2;
			quadKey += digit;
		}
		return quadKey;
	}
});

const bingAerial = new BingLayer('', {
	attribution: '&copy; Microsoft Bing',
	maxZoom: 19
});

// Add default layer
openStreetMap.addTo(map);

// Add layer control
const baseLayers = {
	'OpenStreetMap': openStreetMap,
	'OpenTopoMap': openTopoMap,
	'IGN Ortho': ignOrtho,
	'Google Satellite': googleSatellite,
	'Bing Aerial': bingAerial
};

const layersControl = L.control.layers(baseLayers, {}, { position: 'topright' }).addTo(map);

// Shared marker icon options
const markerIconOptions = {
	shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
	iconSize: [25, 41],
	iconAnchor: [12, 41],
	popupAnchor: [1, -34],
	shadowSize: [41, 41]
};

// Red marker icon for qualifier line coordinates
const redIcon = L.icon({
	...markerIconOptions,
	iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png'
});

// Default blue marker icon
const blueIcon = L.icon({
	...markerIconOptions,
	iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png'
});

let markers = [];
let activeRadiusCircle = null; // Current ephemeral radius circle (qualifier line, popup-bound)
let polygons = []; // Polygons for area NOTAMs
let radiusCircles = []; // Persistent radius circles for PSN NOTAMs

// Airport overlay state. Kept strictly separate from `markers` so the touch
// handler below never iterates 85k airport markers on every tap.
let airportLayer = null;
let airportLayersByType = null; // type -> L.layerGroup, toggled by zoom
let airportData = null;
let airportsLoadPromise = null;
let airportsPopulated = false;
let airportCanvasRenderer = null;
let airportsLoadingControl = null;

// On touch devices, when a tap misses a marker's DOM hit area (e.g. due to
// rendering offset on Android), the tap falls through to the map background.
// This handler catches those taps and opens the nearest marker's popup.
if (L.Browser && L.Browser.touch) {
	map.on('click', function(e) {
		let closest = null;
		let closestDist = Infinity;
		markers.forEach(function(m) {
			const pt = map.latLngToContainerPoint(m.getLatLng());
			const dist = e.containerPoint.distanceTo(pt);
			if (dist < closestDist) {
				closestDist = dist;
				closest = m;
			}
		});
		if (closest && closestDist < 40) {
			setTimeout(function() { closest.openPopup(); }, 0);
		}
	});
}

// Format decimal degrees to DMS (Degrees Minutes Seconds) format
// Example: 46.6468611, 14.3392 -> "46°38'48.7"N / 014°20'21.1"E"
function formatDMS(lat, lon) {
	// Format latitude
	const latAbs = Math.abs(lat);
	const latDeg = Math.floor(latAbs);
	const latMinDec = (latAbs - latDeg) * 60;
	const latMin = Math.floor(latMinDec);
	const latSec = ((latMinDec - latMin) * 60).toFixed(1);
	const latDir = lat >= 0 ? 'N' : 'S';

	// Format longitude (pad degrees with leading zeros to 3 digits)
	const lonAbs = Math.abs(lon);
	const lonDeg = Math.floor(lonAbs);
	const lonMinDec = (lonAbs - lonDeg) * 60;
	const lonMin = Math.floor(lonMinDec);
	const lonSec = ((lonMinDec - lonMin) * 60).toFixed(1);
	const lonDir = lon >= 0 ? 'E' : 'W';

	return `${latDeg}°${latMin.toString().padStart(2, '0')}'${latSec.padStart(4, '0')}"${latDir} / ${lonDeg.toString().padStart(3, '0')}°${lonMin.toString().padStart(2, '0')}'${lonSec.padStart(4, '0')}"${lonDir}`;
}

// Parse NOTAM validity dates from B)/C) sections or SOFIA-Briefing DU/AU line
// B)/C) format: 2026-02-24 00:00 or 2602240000 (legacy YYMMDDHHMM, 20YY assumed)
// DU/AU format: DU: 29 12 2025 16:06 AU: 30 06 2026 23:59 EST
function parseNotamDates(sections, content) {
	let start = null;
	let end = null;
	let permanent = false;
	let estimated = false;

	const parseBCDate = (str) => {
		let m = str.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
		if (m) return new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]));
		m = str.match(/\b(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\b/);
		if (m) return new Date(Date.UTC(2000 + +m[1], m[2] - 1, +m[3], +m[4], +m[5]));
		return null;
	};

	if (sections.B) {
		start = parseBCDate(sections.B);
	}
	if (sections.C) {
		if (/\bPERM\b/i.test(sections.C)) {
			permanent = true;
		} else {
			const cStr = sections.C.replace(/\s*\bEST\b/i, '');
			if (cStr !== sections.C) estimated = true;
			end = parseBCDate(cStr);
		}
	}

	// Fall back to SOFIA-Briefing DU/AU line (format: DD MM YYYY HH:MM)
	if (!start && !end && !permanent) {
		const duMatch = content.match(/DU:\s*(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{2}):(\d{2})/);
		if (duMatch) {
			start = new Date(Date.UTC(+duMatch[3], duMatch[2] - 1, +duMatch[1], +duMatch[4], +duMatch[5]));
		}

		const auMatch = content.match(/AU:\s*(.*?)(?:\n|$)/);
		if (auMatch) {
			const auStr = auMatch[1].trim();
			if (/\bPERM\b/i.test(auStr)) {
				permanent = true;
			} else {
				if (/\bEST\b/i.test(auStr)) estimated = true;
				const m = auStr.match(/(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{2}):(\d{2})/);
				if (m) {
					end = new Date(Date.UTC(+m[3], m[2] - 1, +m[1], +m[4], +m[5]));
				}
			}
		}
	}

	return { start, end, permanent, estimated };
}

// Parse Q) section content into a structured qualifier line object
// Format: FIR / CODE / TRAFFIC / PURPOSE / SCOPE / LOWER/UPPER / COORDINATES
// Example: LFFF / QWULW / IV / BO / W / 000/014 / 4840N00305E005
function parseQualifierLine(qContent) {
	const fields = qContent.split(/\s*\/\s*/);
	if (fields.length < 8) return null;

	const fir = fields[0];
	const code = fields[1];
	const traffic = fields[2];
	const purpose = fields[3];
	const scope = fields[4];
	const lower = parseInt(fields[5], 10);
	const upper = parseInt(fields[6], 10);

	// Parse coordinate: DDMMN/S DDDMME/W + optional 3-digit radius in NM
	const coordStr = fields[7];
	const coordMatch = coordStr.match(/^(\d{4})([NS])(\d{5})([EW])(\d{3})?$/i);
	if (!coordMatch) return null;

	const latDeg = parseInt(coordMatch[1].substring(0, 2), 10);
	const latMin = parseInt(coordMatch[1].substring(2, 4), 10);
	const lonDeg = parseInt(coordMatch[3].substring(0, 3), 10);
	const lonMin = parseInt(coordMatch[3].substring(3, 5), 10);

	let lat = latDeg + latMin / 60;
	let lon = lonDeg + lonMin / 60;
	if (coordMatch[2].toUpperCase() === 'S') lat = -lat;
	if (coordMatch[4].toUpperCase() === 'W') lon = -lon;

	const radius = coordMatch[5] ? parseInt(coordMatch[5], 10) : null;

	return { fir, code, traffic, purpose, scope, lower, upper, lat, lon, radius };
}

// Parse a DMS numeric string with the given number of degree digits into decimal degrees.
// Handles both integer-tenths (e.g. 7 digits for lat) and explicit decimal (e.g. "4024.5").
function parseDMSComponent(str, degDigits) {
	const deg = parseInt(str.substring(0, degDigits), 10);
	const min = parseInt(str.substring(degDigits, degDigits + 2), 10);
	const secStr = str.substring(degDigits + 2);
	const sec = (secStr.length > 2 && !secStr.includes('.'))
		? parseFloat(secStr.substring(0, 2) + '.' + secStr.substring(2))
		: parseFloat(secStr);
	return deg + min / 60 + sec / 3600;
}

// Parse DMS coordinate string to decimal degrees
function parseDMSCoordinate(coordStr) {
	// French NOTAMs (e.g. P1217/26) use comma as decimal separator inside
	// coords ("483916,433N"). Normalise to dot so downstream regex/parseFloat
	// work uniformly; a comma between lat and lon has already been consumed
	// as a separator by the caller's coord regex.
	coordStr = coordStr.trim().replace(/,/g, '.');

	// Try to match format with space first: "484024N 0030441E"
	// Then try format without space: "161514N0611540W"
	// Latitude: 6-7 digits + N/S (7th digit = tenths of seconds)
	// Longitude: 6-8 digits + E/W (6 = DDMMSS, 7 = DDDMMSS or DDMMSSs, 8 = DDDMMSSs)

	let match = coordStr.match(/(\d{6,7}(?:\.\d+)?)\s*([NS])?\s+(\d{6,8}(?:\.\d+)?)\s*([EW])?/i);

	// If no match with space, try format without space
	if (!match) {
		match = coordStr.match(/(\d{6,7}(?:\.\d+)?)([NS])?(\d{7,8}(?:\.\d+)?)([EW])?/i);
	}

	if (!match) {
		return null;
	}

	let latStr = match[1];
	const latDir = (match[2] || 'N').toUpperCase(); // Default to North
	let lonStr = match[3];
	const lonDir = (match[4] || 'E').toUpperCase(); // Default to East

	// Count digits before the decimal point (or all digits if no decimal)
	const lonIntDigits = lonStr.includes('.') ? lonStr.indexOf('.') : lonStr.length;

	// Handle 6-digit longitudes (DDMMSS): pad to DDDMMSS
	if (lonIntDigits === 6) {
		lonStr = '0' + lonStr;
	}

	// Handle 7-digit longitudes (ambiguous between DDDMMSS and DDMMSSs)
	if (lonIntDigits === 7 && !lonStr.includes('.')) {
		if (lonStr[0] === '0') {
			// Starts with 0: standard DDDMMSS, append 0 for tenths: 0022140 -> 00221400
			lonStr = lonStr + '0';
		} else if (latStr.length === 6 || latStr.includes('.')) {
			// Standard 6-digit latitude (DDMMSS) or decimal-second latitude
			// implies standard DDDMMSS longitude: 1211510 -> 12115100
			lonStr = lonStr + '0';
		} else {
			// 7-digit latitude (DDMMSSs) implies DDMMSSs longitude with
			// missing leading zero: 1420211 -> 01420211
			lonStr = '0' + lonStr;
		}
	}

	// Handle 8-digit longitudes with extra leading zero (e.g. 00161448 -> 0161448).
	// When DDDMMSSs gives invalid minutes (MM > 59), strip the leading '0' and
	// parse as 7-digit DDDMMSS.
	if (lonStr.length === 8 && lonStr[0] === '0' && !lonStr.includes('.')) {
		const mm = parseInt(lonStr.substring(3, 5), 10);
		if (mm > 59) {
			lonStr = lonStr.substring(1);
		}
	}

	let lat = parseDMSComponent(latStr, 2);
	let lon = parseDMSComponent(lonStr, 3);

	if (latDir === 'S') lat = -lat;
	if (lonDir === 'W') lon = -lon;

	return { lat, lon };
}

// Join lines that split a DMS coordinate across a wrap. French SUP AIP
// trigger NOTAMs (e.g. F0212/26) write polygons as `470240N,0001500W-...`
// and wrap at column ~80, mid-coordinate (e.g. `...0005707E-4\n55300N,...`).
// We rejoin only when:
//   * the digits before `\n` are immediately preceded by `-` (a polygon
//     separator — the strong signal that we're inside a coord run, not
//     prose that happens to end in a digit), AND
//   * the digits after `\n` form a complete `<digits>[NS]` followed by
//     `,<digits>[EW]` (a lat/lon pair), AND
//   * the joined digits are a plausible DMS latitude (4-7 digits + NS).
function rejoinSplitCoordLines(text) {
	return text.replace(
		/(-\d{0,6})\n(\d{1,7}[NS])(\s*[,\s]\s*\d{4,8}[EW])/g,
		(m, a, b, c) => /^\d{4,7}[NS]$/.test(a.slice(1) + b) ? a + b + c : m
	);
}

// Clean up NOTAM content - normalize whitespace while preserving structure
function cleanNotamContent(content) {
	return content
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.join('\n');
}

const lateralLimitsTranslations = [
	'LATERAL\\s+LIMITS?',    // English
	'LIMITES?\\s+LATERALES?', // French
	'GRANICE\\s+POZIOME',    // Polish
];
const areaTranslations = [
	'AREA', // English
	'SAHA', // Turkish
];
const areaKeywordsPattern = new RegExp('\\b(' + lateralLimitsTranslations.join('|') + '|' + areaTranslations.join('|') + '|WI\\s+COORD|FLW\\s+COORDS)\\b', 'i');
const areaExclusionPattern = /\bRESTRICTED\s+IN\s+AREA\b/i;
// Two full DMS coords joined by a dash. lat/lon may be separated by whitespace
// or by a comma (French SUP AIP format like `470240N,0001500W`).
const dashConnectedCoordsPattern = /\d{4,7}[NS](?:\s+|\s*,\s*)\d{5,8}[EW]\s*[-]\s*\d{4,7}[NS](?:\s+|\s*,\s*)\d{5,8}[EW]/i;

// Extract radius info from text surrounding a coordinate match in the E) section
function extractRadiusFromText(eContent, matchStart, matchEnd) {
	// Look after the coordinate: "RADIUS <num><unit>" or "[WITH] <num><unit> RADIUS"
	const afterText = eContent.substring(matchEnd, matchEnd + 50);
	const afterMatch = afterText.match(/^\s+RADIUS\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\b/i);
	if (afterMatch) {
		return {
			radius: parseFloat(afterMatch[1].replace(',', '.')),
			radiusUnit: afterMatch[2].toUpperCase()
		};
	}
	const afterMatch2 = afterText.match(/^\s+(?:WITH\s+)?(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+RADIUS\b/i);
	if (afterMatch2) {
		return {
			radius: parseFloat(afterMatch2[1].replace(',', '.')),
			radiusUnit: afterMatch2[2].toUpperCase()
		};
	}

	// French: " [- ]?[DANS UN ]?RAYON [:|DE] <num><unit>" after coord.
	// Examples:
	//   "PSN <coord>\nRAYON : 5NM"
	//   "PSN <coord> DANS UN RAYON DE 5NM"
	//   "- PSN : <coord>\n- RAYON: 5KM"        (bullet-list, P0994/26)
	const afterMatchFr = afterText.match(/^\s+[-*]?\s*(?:DANS\s+(?:UN\s+)?)?RAYON\s*(?::|DE\s+)\s*(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\b/i);
	if (afterMatchFr) {
		let unit = afterMatchFr[2].toUpperCase();
		if (unit === 'METRES' || unit === 'METRE') unit = 'M';
		return {
			radius: parseFloat(afterMatchFr[1].replace(',', '.')),
			radiusUnit: unit
		};
	}

	// French elision: "RAYON D'<WORD> DE <num><unit>" after coord
	// (e.g. W0004/26 "CENTREE SUR <coord> AVEC UN RAYON D'EVOLUTION DE 500M").
	const afterMatchElision = afterText.match(/^\s+(?:AVEC\s+(?:UN\s+)?)?RAYON\s+D['][A-Z]+\s+DE\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\b/i);
	if (afterMatchElision) {
		let unit = afterMatchElision[2].toUpperCase();
		if (unit === 'METRES' || unit === 'METRE') unit = 'M';
		return {
			radius: parseFloat(afterMatchElision[1].replace(',', '.')),
			radiusUnit: unit
		};
	}

	// French: "RAYON <num><unit>" with no separator (W0227/26, W0470/26).
	// `\s+\d` ensures a digit comes immediately after the whitespace,
	// so "RAYON LASER 3M" / "RAYON ENERGIE ..." still don't match.
	const afterMatchBare = afterText.match(/^[\s,]+(?:DANS\s+)?RAYON\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\b/i);
	if (afterMatchBare) {
		let unit = afterMatchBare[2].toUpperCase();
		if (unit === 'METRES' || unit === 'METRE') unit = 'M';
		return {
			radius: parseFloat(afterMatchBare[1].replace(',', '.')),
			radiusUnit: unit
		};
	}

	// Look before the coordinate (up to 50 chars)
	const beforeText = eContent.substring(Math.max(0, matchStart - 50), matchStart);

	// "<num><unit> RADIUS [OF|CENTRED ON/AT]"
	const beforeMatch1 = beforeText.match(/(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+RADIUS\b/i);
	if (beforeMatch1) {
		return {
			radius: parseFloat(beforeMatch1[1].replace(',', '.')),
			radiusUnit: beforeMatch1[2].toUpperCase()
		};
	}

	// "RADIUS <num><unit> [CENTRE/CENTRED/CENTER/CENTERED ON/AT]"
	const beforeMatch2 = beforeText.match(/\bRADIUS\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\b/i);
	if (beforeMatch2) {
		return {
			radius: parseFloat(beforeMatch2[1].replace(',', '.')),
			radiusUnit: beforeMatch2[2].toUpperCase()
		};
	}

	// French: "<num><unit> DE RAYON" (e.g. "CERCLE DE 1NM DE RAYON CENTRE SUR PSN")
	const beforeMatch3 = beforeText.match(/(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+DE\s+RAYON\b/i);
	if (beforeMatch3) {
		return {
			radius: parseFloat(beforeMatch3[1].replace(',', '.')),
			radiusUnit: beforeMatch3[2].toUpperCase()
		};
	}

	// French: "RAYON DE <num><unit>" / "RAYON : <num><unit>"
	// Separator (DE or :) required to avoid matching "RAYON LASER 3M" etc.
	const beforeMatch4 = beforeText.match(/\bRAYON\s*(?::|DE\s+)\s*(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\b/i);
	if (beforeMatch4) {
		return {
			radius: parseFloat(beforeMatch4[1].replace(',', '.')),
			radiusUnit: beforeMatch4[2].toUpperCase()
		};
	}

	// French: "RAYON <num><unit>" with no separator (W0520/26, P1757/26).
	// `\s+\d` ensures a digit comes immediately after the whitespace,
	// excluding "RAYON LASER 3M" / "RAYON ENERGIE ..." prose.
	const beforeMatch5 = beforeText.match(/\bRAYON\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\b/i);
	if (beforeMatch5) {
		let unit = beforeMatch5[2].toUpperCase();
		if (unit === 'METRES' || unit === 'METRE') unit = 'M';
		return {
			radius: parseFloat(beforeMatch5[1].replace(',', '.')),
			radiusUnit: unit
		};
	}

	// Fallback: French obstacle NOTAMs (P0389/26, P0881/26, ...) put the
	// radius in the E-section preamble (`GRUE MOBILE DANS UN RAYON DE 96M
	// AUTOUR DU PSN ...`) with the actual coord on a separate "- PSN : ..."
	// line beyond the local 50-char window. The "AUTOUR" suffix anchors this
	// to a single PSN, so applying it across the NOTAM is safe.
	const preamble = eContent.match(/\bDANS\s+(?:UN\s+)?RAYON\s+(?:DE\s+)?(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\s+AUTOUR\b/i);
	if (preamble) {
		let unit = preamble[2].toUpperCase();
		if (unit === 'METRES' || unit === 'METRE') unit = 'M';
		return {
			radius: parseFloat(preamble[1].replace(',', '.')),
			radiusUnit: unit
		};
	}

	// Diameter (helipad FATO circles in H-prefixed NOTAMs). Half it to get
	// the equivalent radius; the resulting circle has the documented extent.
	const diameter = eContent.match(/\bDIAMETRE\s*(?::|DE\s+)?\s*(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\b/i);
	if (diameter) {
		let unit = diameter[2].toUpperCase();
		if (unit === 'METRES' || unit === 'METRE') unit = 'M';
		return {
			radius: parseFloat(diameter[1].replace(',', '.')) / 2,
			radiusUnit: unit
		};
	}

	return null;
}

// Convert radius to nautical miles
function radiusToNM(radius, unit) {
	if (unit === 'KM') return radius / NM_TO_KILOMETERS;
	if (unit === 'M') return radius / NM_TO_METERS;
	return radius; // NM or default
}

// Display unit with correct casing (SI: m, km; aviation: NM)
const radiusUnitDisplay = { NM: 'NM', KM: 'km', M: 'm' };

// Parse NOTAM content into ICAO sections (Q, A, B, C, D, E, F, G)
function parseSections(content) {
	const sections = {};
	// Match ICAO NOTAM section markers preceded by start-of-string or whitespace
	// to avoid false matches on text like "2A)" or "(E)"
	// Each section letter is accepted only once; subsequent occurrences (e.g.
	// enumerated items A)...E) inside the E) section) are treated as text
	const re = /(?:^|\s)([QABCDEFG])\)\s?/g;
	const markers = [];
	const seen = new Set();
	let m;
	while ((m = re.exec(content)) !== null) {
		if (seen.has(m[1])) continue;
		seen.add(m[1]);
		markers.push({ letter: m[1], matchStart: m.index, contentStart: m.index + m[0].length });
	}
	for (let i = 0; i < markers.length; i++) {
		const start = markers[i].contentStart;
		const end = i + 1 < markers.length ? markers[i + 1].matchStart : content.length;
		sections[markers[i].letter] = content.substring(start, end).trim();
	}
	return sections;
}

// Parse NOTAMs and extract those with coordinates
function parseNotams(text) {
	const notams = [];
	const seenIds = new Set();

	// Split into individual NOTAMs using the NOTAM ID pattern
	// Support SOFIA-Briefing format (LFFF-A1234/25) and autorouter formats (LFFF A1234/25 and A1234/25)
	// Action suffixes (NOTAM, NOTAMN, NOTAMR, NOTAMC) are captured but will be stripped
	const notamPattern = /(?:^|\n)\s*((?:[A-Z]{4}[\s-])?[A-Z]\d+\/\d+)\s*(?:NOTAM[NRC]?)?/gi;
	const parts = text.split(notamPattern);

	// Process pairs: [before, id1, content1, id2, content2, ...]
	for (let i = 1; i < parts.length; i += 2) {
		// Strip any trailing action suffix from the ID
		const notamId = parts[i].replace(/\s*NOTAM[NRC]?\s*$/i, '').trim();
		if (seenIds.has(notamId)) continue;
		seenIds.add(notamId);
		let content = parts[i + 1] || '';

		// NOTAM content ends at an empty line
		const emptyLineMatch = content.match(/\n\s*\n/);
		if (emptyLineMatch) {
			content = content.substring(0, emptyLineMatch.index);
		}

		// Parse NOTAM sections
		const sections = parseSections(content);

		// Find coordinates
		const coordinates = [];
		const seenPositions = new Set(); // Track positions to deduplicate

		const dates = parseNotamDates(sections, content);
		const eContent = sections.E ? rejoinSplitCoordLines(sections.E) : null;

		const coordinateGroups = [];

		if (eContent) {
			// Check for position or area keywords
			const hasPsnKeyword = /\bPSN\b/i.test(eContent);
			// CENTRE/CENTRED/CENTREE/CENTER/CENTERED — CENTREE is the French
			// feminine past participle used in NOTAMs like W0004/26.
			const hasCentreKeyword = /\bCENTR(?:EE?D?|ER(?:ED)?)\b/i.test(eContent);
			const hasObstKeyword = /\bOBST\b/i.test(eContent);
			const hasObstQCode = sections.Q && /\/\s*QOB/.test(sections.Q);
			const hasAreaKeywords = areaKeywordsPattern.test(eContent) && !areaExclusionPattern.test(eContent);
			// Two full DMS coords joined by a dash is itself a strong polygon
			// signal — catches French SUP AIP triggers like R3154/25 that just
			// list "coord - coord - coord - ..." without an explicit keyword.
			const hasDashConnectedCoords = dashConnectedCoordsPattern.test(eContent);

			// Only extract coordinates if PSN, CENTRE/CENTER, OBST, obstruction Q-code, area keywords, or a dash-coord-chain are present
			if (hasPsnKeyword || hasCentreKeyword || hasObstKeyword || hasObstQCode || hasAreaKeywords || hasDashConnectedCoords) {
				// When area keywords are present, find the first keyword
				// directly followed by coordinates; non-PSN coordinates
				// before it are skipped
				let extractionStartIndex = 0;
				if (hasAreaKeywords) {
					const areaSearchPattern = new RegExp(areaKeywordsPattern.source, 'gi');
					let areaMatch;
					while ((areaMatch = areaSearchPattern.exec(eContent)) !== null) {
						const after = eContent.substring(areaMatch.index + areaMatch[0].length);
						if (/^.{0,40}?(?:\d{4,7}(?:\.\d+)?[NS]\s+\d{5,8}(?:\.\d+)?[EW]|\d{6}[NS]\d{7}[EW])/is.test(after)) {
							extractionStartIndex = areaMatch.index;
							break;
						}
					}
				}

				// Find all coordinate-like patterns in the E) section.
				// Supported formats:
				//   "422726N 0064355W"           space separator
				//   "470240N,0001500W"           comma between lat/lon
				//   "452552N - 0065936E"         dash between lat/lon
				//   "455554.997N 0060439.322E"   decimal seconds with space
				//   "443557.2N0035201.12E"       decimal seconds, no separator
				//   "483916,433N 0052902,045E"   French comma-as-decimal-point
				//   "161514N0611540W"            fixed 6+7 digits, no separator
				const coordPattern = /(\d{4,7}(?:[.,]\d+)?)([NS])(?:\s+|\s*[,-]\s*)?(\d{5,8}(?:[.,]\d+)?)([EW])|(\d{6})([NS])(\d{7})([EW])/gi;
				let match;
				let groupClosed = false;

				while ((match = coordPattern.exec(eContent)) !== null) {
					const coordStr = match[1]
						? match[1] + match[2] + ' ' + match[3] + match[4]
						: match[5] + match[6] + ' ' + match[7] + match[8];
					const coords = parseDMSCoordinate(coordStr);
					if (!coords) continue;

					// A standalone PSN has the keyword on the same line but is not
					// dash-connected to the next coordinate (polygon series)
					const before = eContent.substring(Math.max(0, match.index - 30), match.index);
					const sameLine = before.includes('\n') ? before.substring(before.lastIndexOf('\n') + 1) : before;
					const after = eContent.substring(match.index + match[0].length);
					const isStandalonePsn = /\bPSN\b/i.test(sameLine) &&
						!/^\s*-\s*\d{4,7}/i.test(after);

					if (isStandalonePsn) {
						const radiusInfo = extractRadiusFromText(eContent, match.index, match.index + match[0].length);
						const coord = {
							original: coordStr.trim(),
							lat: coords.lat,
							lon: coords.lon,
							type: 'psn'
						};
						if (radiusInfo) {
							coord.radius = radiusInfo.radius;
							coord.radiusUnit = radiusInfo.radiusUnit;
						}
						coordinateGroups.push([coord]);
						continue;
					}

					// Skip non-PSN coordinates before area extraction zone
					if (match.index < extractionStartIndex) {
						continue;
					}

					// Create position key for deduplication (rounded to ~1m precision)
					const posKey = `${coords.lat.toFixed(6)}_${coords.lon.toFixed(6)}`;

					if (seenPositions.has(posKey)) {
						// Duplicate coordinate signals polygon closure
						if (!groupClosed && coordinates.length > 0) {
							coordinateGroups.push([...coordinates]);
							coordinates.length = 0;
							seenPositions.clear();
							groupClosed = true;
						}
					} else {
						groupClosed = false;
						seenPositions.add(posKey);
						const radiusInfo = extractRadiusFromText(eContent, match.index, match.index + match[0].length);
						const coord = {
							original: coordStr.trim(),
							lat: coords.lat,
							lon: coords.lon,
							type: 'psn'
						};
						if (radiusInfo) {
							coord.radius = radiusInfo.radius;
							coord.radiusUnit = radiusInfo.radiusUnit;
						}
						tagArcCenter(coord, eContent, match.index);
						coordinates.push(coord);
					}
				}
			}
		}

		// Collect remaining coordinates as the last group.
		// When every coordinate carries a radius (circle centres),
		// emit each one as its own group so they become individual
		// position markers instead of a single polygon.
		if (coordinates.length > 0) {
			if (coordinates.length >= 2 && coordinates.every(c => c.radius != null)) {
				for (const c of coordinates) {
					coordinateGroups.push([c]);
				}
			} else {
				coordinateGroups.push(coordinates);
			}
		}

		// Drop polygon-shaped groups whose coord sequence is coarsely
		// identical to an earlier group — catches LOWW-A3153/25 that lists
		// the same polygon a second time as a "STRAIGHT LINE DEFINED BY" at
		// a different precision. Only polygon-shaped groups (length >= 3)
		// are candidates; standalone PSN markers for nearby obstacles
		// (e.g. P0320/26's 17 trees) are kept even when their coarse
		// positions collide.
		if (coordinateGroups.length > 1) {
			const keyOf = c => `${c.lat.toFixed(3)}_${c.lon.toFixed(3)}`;
			const seqOf = g => g.map(keyOf).join('|');
			const seenSeqs = new Set();
			const filtered = [];
			for (const group of coordinateGroups) {
				if (group.length < 3) {
					filtered.push(group);
					continue;
				}
				const seq = seqOf(group);
				if (seenSeqs.has(seq)) continue;
				seenSeqs.add(seq);
				filtered.push(group);
			}
			coordinateGroups.length = 0;
			coordinateGroups.push(...filtered);
		}

		// Find qualifier line coordinates only if no PSN coordinates found
		if (coordinateGroups.length === 0 && sections.Q) {
			const qualifier = parseQualifierLine(sections.Q);
			if (qualifier) {
				coordinateGroups.push([{
					original: sections.Q.split(/\s*\/\s*/).pop(),
					lat: qualifier.lat,
					lon: qualifier.lon,
					radius: qualifier.radius,
					type: 'qualifierLine'
				}]);
			}
		}

		// Extract ICAO codes from A) section
		let icaoCodes = [];
		if (sections.A) {
			const icaoMatch = sections.A.match(/([A-Z]{4}(?:\s+[A-Z]{4})*)/i);
			icaoCodes = icaoMatch ? icaoMatch[1].split(/\s+/) : [];
		}

		// Emit a NOTAM entry for each coordinate group
		for (const groupCoords of coordinateGroups) {
			// Determine if this is an area/polygon
			let isPolygon = false;

			if (groupCoords.length >= 3 && eContent) {
				// Check for area keywords
				const hasAreaKeywords = areaKeywordsPattern.test(eContent) && !areaExclusionPattern.test(eContent);

				// Check if it's a closed polygon by looking for parenthesized closing coordinate
				// Pattern: (DDMMSSN DDDMMSSW) including various spacing and line breaks
				const hasClosingCoord = /\(\s*\d{4,7}\s*[NS]\s+\d{5,8}\s*[EW]\s*\)/i.test(eContent);

				// Check if multiple coordinates are connected by dashes (typical area pattern)
				const hasDashConnectedCoords = dashConnectedCoordsPattern.test(eContent);

				// Also check if first and last coords in array are same (in case no parentheses used)
				const firstCoord = groupCoords[0];
				const lastCoord = groupCoords[groupCoords.length - 1];
				const isClosed = Math.abs(firstCoord.lat - lastCoord.lat) < 0.001 &&
				                 Math.abs(firstCoord.lon - lastCoord.lon) < 0.001;

				// Mark as polygon if:
				// - Area keywords present
				// - Closing coordinate in parentheses
				// - Multiple dash-connected coordinates (area pattern)
				// - First and last coords match
				isPolygon = hasAreaKeywords || hasClosingCoord || (hasDashConnectedCoords && groupCoords.length >= 4) || isClosed;
			}

			let finalCoords = isPolygon && isSelfIntersecting(groupCoords)
				? makeSimplePolygon(groupCoords) : groupCoords;
			if (isPolygon) {
				finalCoords = expandArcs(finalCoords);
				normalizePolygonLongitudes(finalCoords);
			}
			notams.push({
				id: notamId,
				fullContent: cleanNotamContent(content),
				coordinates: finalCoords,
				icaoCodes: icaoCodes,
				isPolygon: isPolygon,
				startDate: dates.start,
				endDate: dates.end,
				permanent: dates.permanent,
				estimated: dates.estimated
			});
		}
	}

	return notams;
}

// Clear existing markers, polygons and radius circles
function clearMarkers() {
	markers.forEach(marker => map.removeLayer(marker));
	markers = [];
	polygons.forEach(polygon => map.removeLayer(polygon));
	polygons = [];
	radiusCircles.forEach(circle => map.removeLayer(circle));
	radiusCircles = [];
	if (activeRadiusCircle) {
		map.removeLayer(activeRadiusCircle);
		activeRadiusCircle = null;
	}
}

// Check if two line segments (p1-p2) and (p3-p4) intersect
function segmentsIntersect(p1, p2, p3, p4) {
	const d1 = (p4.lon - p3.lon) * (p1.lat - p3.lat) - (p4.lat - p3.lat) * (p1.lon - p3.lon);
	const d2 = (p4.lon - p3.lon) * (p2.lat - p3.lat) - (p4.lat - p3.lat) * (p2.lon - p3.lon);
	const d3 = (p2.lon - p1.lon) * (p3.lat - p1.lat) - (p2.lat - p1.lat) * (p3.lon - p1.lon);
	const d4 = (p2.lon - p1.lon) * (p4.lat - p1.lat) - (p2.lat - p1.lat) * (p4.lon - p1.lon);
	return d1 * d2 < 0 && d3 * d4 < 0;
}

// Check if a polygon has any self-intersecting edges
function isSelfIntersecting(coordinates) {
	const n = coordinates.length;
	for (let i = 0; i < n; i++) {
		for (let j = i + 2; j < n; j++) {
			if (i === 0 && j === n - 1) continue; // adjacent (wrap-around)
			if (segmentsIntersect(
				coordinates[i], coordinates[(i + 1) % n],
				coordinates[j], coordinates[(j + 1) % n]
			)) return true;
		}
	}
	return false;
}

// Sort polygon vertices by angle from centroid to form a simple polygon
function makeSimplePolygon(coordinates) {
	const n = coordinates.length;
	const centroidLat = coordinates.reduce((s, c) => s + c.lat, 0) / n;
	const centroidLon = coordinates.reduce((s, c) => s + c.lon, 0) / n;
	return coordinates.slice().sort((a, b) =>
		Math.atan2(a.lat - centroidLat, a.lon - centroidLon) -
		Math.atan2(b.lat - centroidLat, b.lon - centroidLon)
	);
}

// Compute approximate polygon area using the shoelace formula
function computePolygonArea(coordinates) {
	let area = 0;
	const n = coordinates.length;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		area += coordinates[i].lat * coordinates[j].lon;
		area -= coordinates[j].lat * coordinates[i].lon;
	}
	return Math.abs(area) / 2;
}

// Mark a coord as an arc center if it's immediately preceded in the E section
// by "ARC HORAIRE DE <num><unit> DE RAYON CENTRE [SUR]" (French clockwise-arc
// notation). The center point isn't actually on the polygon boundary — the
// adjacent polygon vertices sit on the arc itself — so on finalization we
// replace the center with sampled arc points via expandArcs().
function tagArcCenter(coord, eContent, matchIndex) {
	const before = eContent.substring(Math.max(0, matchIndex - 100), matchIndex);
	const m = before.match(/\bARC\s+HORAIRE\s+DE\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\s+DE\s+RAYON\s+CENTRE[E]?\s+SUR[\s,]*$/i);
	if (!m) return;
	let unit = m[2].toUpperCase();
	if (unit === 'METRES' || unit === 'METRE') unit = 'M';
	coord.arcRadius = parseFloat(m[1].replace(',', '.'));
	coord.arcRadiusUnit = unit;
	// The center isn't a position to draw a circle around; clear any radius
	// the local "X DE RAYON" pattern may have attached.
	delete coord.radius;
	delete coord.radiusUnit;
}

// Sample K-1 intermediate points along the clockwise arc from `prev` to `next`,
// centered on `center` with the given radius. Endpoints are not duplicated —
// they're already in the polygon coord list. Planar approximation, fine at
// the few-NM scale of French ZRT arcs.
function sampleArcPoints(prev, center, next, radius, unit) {
	const r = radius * (unit === 'NM' ? NM_TO_METERS : unit === 'KM' ? 1000 : 1);
	const M_PER_DEG = 111320;
	const cosLat = Math.cos(center.lat * Math.PI / 180);
	const t1 = Math.atan2(prev.lat - center.lat, (prev.lon - center.lon) * cosLat);
	const t2 = Math.atan2(next.lat - center.lat, (next.lon - center.lon) * cosLat);
	// HORAIRE = clockwise. atan2 is CCW-positive, so a clockwise sweep is
	// modeled as a positive (t1 - t2) wrapping into (0, 2π].
	let sweep = t1 - t2;
	while (sweep <= 0) sweep += 2 * Math.PI;
	const k = 16;
	const out = [];
	for (let i = 1; i < k; i++) {
		const angle = t1 - sweep * (i / k);
		out.push({
			original: 'arc',
			lat: center.lat + Math.sin(angle) * r / M_PER_DEG,
			lon: center.lon + Math.cos(angle) * r / (cosLat * M_PER_DEG),
			type: 'psn'
		});
	}
	return out;
}

// Replace any arc-center coord in a polygon vertex list with sampled arc
// points. For closed polygons the prev/next of the first/last arc-center
// wraps around through the closure.
function expandArcs(coords) {
	if (!coords.some(c => c.arcRadius != null)) return coords;
	const n = coords.length;
	const out = [];
	for (let i = 0; i < n; i++) {
		const c = coords[i];
		if (c.arcRadius == null) {
			out.push(c);
			continue;
		}
		const prev = coords[(i - 1 + n) % n];
		const next = coords[(i + 1) % n];
		out.push(...sampleArcPoints(prev, c, next, c.arcRadius, c.arcRadiusUnit));
	}
	return out;
}

// Normalize polygon longitudes so consecutive vertices never jump more than 180°.
// This fixes rendering of polygons that cross the antimeridian (±180°).
function normalizePolygonLongitudes(coordinates) {
	for (let i = 1; i < coordinates.length; i++) {
		while (coordinates[i].lon - coordinates[i - 1].lon > 180) {
			coordinates[i].lon -= 360;
		}
		while (coordinates[i].lon - coordinates[i - 1].lon < -180) {
			coordinates[i].lon += 360;
		}
	}
}

// Canvas renderer for circles (better compatibility with html2canvas for PDF export)
const canvasRenderer = L.canvas();

// Polygon styles
const polygonDefaultStyle = {
	color: '#ff7800',
	weight: 2,
	fillColor: '#ff7800',
	fillOpacity: 0.2
};
const polygonHighlightStyle = {
	color: '#ff3300',
	weight: 3,
	fillColor: '#ff3300',
	fillOpacity: 0.4
};

// Build a radius circle (radius in NM) and add it to the map.
// Non-interactive so clicks pass through to underlying polygons (and to the
// marker pin which lives in the higher-z markerPane).
function makeRadiusCircle(lat, lon, radiusNM, color) {
	return L.circle([lat, lon], {
		radius: radiusNM * NM_TO_METERS,
		color: color,
		fillColor: color,
		fillOpacity: 0.15,
		weight: 2,
		interactive: false,
		renderer: canvasRenderer
	}).addTo(map);
}

// Show an ephemeral radius circle (used for qualifier-line markers on popup open)
function showRadiusCircle(lat, lon, radiusNM, color) {
	hideRadiusCircle();
	activeRadiusCircle = makeRadiusCircle(lat, lon, radiusNM, color || '#0078d4');
}

// Hide radius circle
function hideRadiusCircle() {
	if (activeRadiusCircle) {
		map.removeLayer(activeRadiusCircle);
		activeRadiusCircle = null;
	}
}

// Generate a location key for grouping (rounded to ~10m precision)
function locationKey(lat, lon) {
	return `${lat.toFixed(4)}_${lon.toFixed(4)}`;
}

// Group NOTAMs by location and ICAO codes
function groupNotamsByLocation(notams, showAll) {
	const locationGroups = new Map();

	notams.forEach((notam) => {
		// Skip polygon NOTAMs as they are drawn as areas, not markers
		if (notam.isPolygon) {
			return;
		}

		const filteredCoords = showAll
			? notam.coordinates
			: notam.coordinates.filter(c => c.type === 'psn');

		filteredCoords.forEach((coord) => {
			const icaoKey = notam.icaoCodes.slice().sort().join(',');
			const key = `${locationKey(coord.lat, coord.lon)}_${icaoKey}`;
			if (!locationGroups.has(key)) {
				locationGroups.set(key, {
					lat: coord.lat,
					lon: coord.lon,
					locationKey: locationKey(coord.lat, coord.lon),
					icaoCodes: notam.icaoCodes.slice(),
					notams: [],
					hasQualifierLine: false,
					radius: null
				});
			}
			const group = locationGroups.get(key);
			group.notams.push({
				id: notam.id,
				fullContent: notam.fullContent,
				type: coord.type,
				radius: coord.radius,
				radiusUnit: coord.radiusUnit
			});
			if (coord.type === 'qualifierLine') {
				group.hasQualifierLine = true;
				if (coord.radius) {
					group.radius = coord.radius;
					group.radiusUnit = 'NM';
				}
			} else if (coord.radius) {
				group.radius = coord.radius;
				group.radiusUnit = coord.radiusUnit;
			}
		});
	});

	return locationGroups;
}

// Build map of location to groups for navigation between overlapping markers
function buildLocationToGroupsMap(locationGroups) {
	const locationToGroups = new Map();
	locationGroups.forEach((group, key) => {
		const locKey = group.locationKey;
		if (!locationToGroups.has(locKey)) {
			locationToGroups.set(locKey, []);
		}
		locationToGroups.get(locKey).push({ key, group });
	});
	return locationToGroups;
}

// Build popup HTML content
function buildPopupHtml(group, navInfo) {
	const { groupIndex, totalAtLocation, hasMultipleAtLocation } = navInfo;
	const notamCount = group.notams.length;

	const navHtml = hasMultipleAtLocation ? `
		<div class="popup-nav">
			<button class="popup-nav-btn popup-nav-prev" title="Previous">&larr;</button>
			<span class="popup-nav-counter">${groupIndex + 1} / ${totalAtLocation}</span>
			<button class="popup-nav-btn popup-nav-next" title="Next">&rarr;</button>
		</div>
	` : '';

	const icaoDisplay = group.icaoCodes.length > 0
		? `<div class="popup-icao">${group.icaoCodes.join(' ')}</div>`
		: '';

	const countBadge = `<span class="popup-count">${notamCount} NOTAM${notamCount > 1 ? 's' : ''}</span>`;

	const radiusInfo = group.radius
		? `<div class="popup-radius">Radius: ${group.radius} ${radiusUnitDisplay[group.radiusUnit] || 'NM'}</div>`
		: '';

	const notamsList = group.notams.map(n => `
		<div class="popup-notam">
			<strong>${n.id}</strong>
			<pre class="popup-content">${n.fullContent}</pre>
		</div>
	`).join('<hr class="popup-divider">');

	return `
		<div class="notam-popup">
			${navHtml}
			<div class="popup-header">
				${icaoDisplay}
				<div class="popup-coords">${formatDMS(group.lat, group.lon)}</div>
				${countBadge}
			</div>
			${radiusInfo}
			<div class="popup-notams-list">
				${notamsList}
			</div>
		</div>
	`;
}

// Build list item HTML content
function buildListItemHtml(group, posIndex) {
	const notamCount = group.notams.length;
	const notamIds = group.notams.map(n => n.id).join(', ');
	const countLabel = notamCount > 1 ? ` (${notamCount} NOTAMs)` : '';
	const listIcaoDisplay = group.icaoCodes.length > 0
		? `<span class="list-icao">${group.icaoCodes.join(' ')}</span>`
		: '';

	// Show DMS position for PSN NOTAMs
	const isPsnNotam = group.notams.some(n => n.type === 'psn');
	const radiusSuffix = group.radius && isPsnNotam
		? ` with radius ${group.radius} ${radiusUnitDisplay[group.radiusUnit] || 'NM'}`
		: '';
	const positionLabel = isPsnNotam
		? `<span class="notam-position">Position (${formatDMS(group.lat, group.lon)})${radiusSuffix}</span>`
		: '';

	return `
		<div class="notam-header">
			<span class="coord-label">#${posIndex}</span>
			${listIcaoDisplay}
			<strong>${notamIds}</strong>${countLabel}
			${positionLabel}
		</div>
		<div class="notam-contents">
			${group.notams.map(n => `
				<div class="notam-entry">
					<div class="notam-entry-id">${n.id}</div>
					<pre class="notam-content">${n.fullContent}</pre>
				</div>
			`).join('<hr class="notam-divider">')}
		</div>
	`;
}

// Set up marker event handlers for popup navigation and radius circle
function setupMarkerEvents(marker, group, navInfo, markerMap) {
	const { groupIndex, totalAtLocation, hasMultipleAtLocation, groupsAtLocation } = navInfo;

	marker.on('popupopen', () => {
		// PSN radius circles are persistent (drawn alongside the marker);
		// only qualifier-line circles are ephemeral and shown here.
		if (group.radius && group.hasQualifierLine) {
			const nm = radiusToNM(group.radius, group.radiusUnit || 'NM');
			showRadiusCircle(group.lat, group.lon, nm, '#0078d4');
		}

		if (hasMultipleAtLocation) {
			const popup = marker.getPopup().getElement();
			const prevBtn = popup.querySelector('.popup-nav-prev');
			const nextBtn = popup.querySelector('.popup-nav-next');

			prevBtn.onclick = () => {
				const prevIndex = (groupIndex - 1 + totalAtLocation) % totalAtLocation;
				const prevMarker = markerMap.get(groupsAtLocation[prevIndex].key);
				marker.closePopup();
				prevMarker.openPopup();
			};

			nextBtn.onclick = () => {
				const nextIndex = (groupIndex + 1) % totalAtLocation;
				const nextMarker = markerMap.get(groupsAtLocation[nextIndex].key);
				marker.closePopup();
				nextMarker.openPopup();
			};
		}
	});

	marker.on('popupclose', () => {
		hideRadiusCircle();
	});
}

// Group polygon NOTAMs by centroid location
function groupPolygonsByLocation(notams) {
	const groups = new Map();
	notams.forEach(notam => {
		if (!notam.isPolygon) return;

		const lats = notam.coordinates.map(c => c.lat);
		const lons = notam.coordinates.map(c => c.lon);
		const centroidLat = lats.reduce((a, b) => a + b, 0) / lats.length;
		const centroidLon = lons.reduce((a, b) => a + b, 0) / lons.length;
		const centroidKey = locationKey(centroidLat, centroidLon);

		if (!groups.has(centroidKey)) {
			groups.set(centroidKey, []);
		}
		groups.get(centroidKey).push({ notam, centroidLat, centroidLon });
	});
	return groups;
}

// Build popup HTML content for a polygon NOTAM
function buildPolygonPopupHtml(notam, navInfo) {
	const { index, total, hasMultiple } = navInfo;

	const navHtml = hasMultiple ? `
		<div class="popup-nav">
			<button class="popup-nav-btn popup-nav-prev" title="Previous">&larr;</button>
			<span class="popup-nav-counter">${index + 1} / ${total}</span>
			<button class="popup-nav-btn popup-nav-next" title="Next">&rarr;</button>
		</div>
	` : '';

	const icaoDisplay = notam.icaoCodes.length > 0
		? `<div class="popup-icao">${notam.icaoCodes.join(' ')}</div>`
		: '';

	return `
		<div class="notam-popup">
			${navHtml}
			<div class="popup-header">
				${icaoDisplay}
				<div class="popup-coords">Area (${notam.coordinates.length} points)</div>
				<span class="popup-count">1 NOTAM</span>
			</div>
			<div class="popup-notams-list">
				<div class="popup-notam">
					<strong>${notam.id}</strong>
					<pre class="popup-content">${notam.fullContent}</pre>
				</div>
			</div>
		</div>
	`;
}

// Build list item HTML content for a polygon NOTAM
function buildPolygonListItemHtml(notam, posIndex) {
	const icaoDisplay = notam.icaoCodes.length > 0
		? `<span class="list-icao">${notam.icaoCodes.join(' ')}</span>`
		: '';

	return `
		<div class="notam-header">
			<span class="coord-label">#${posIndex}</span>
			${icaoDisplay}
			<strong>${notam.id}</strong>
			<span class="notam-area">Area (${notam.coordinates.length} points)</span>
		</div>
		<div class="notam-contents">
			<div class="notam-entry">
				<div class="notam-entry-id">${notam.id}</div>
				<pre class="notam-content">${notam.fullContent}</pre>
			</div>
		</div>
	`;
}

// Set up polygon event handlers for highlight and popup navigation
function setupPolygonEvents(polygon, navInfo, polygonMap, centroidKey) {
	const { index, total, hasMultiple } = navInfo;

	polygon.on('popupopen', () => {
		polygon.setStyle(polygonHighlightStyle);

		if (hasMultiple) {
			const popup = polygon.getPopup().getElement();
			const prevBtn = popup.querySelector('.popup-nav-prev');
			const nextBtn = popup.querySelector('.popup-nav-next');

			prevBtn.onclick = () => {
				const prevIndex = (index - 1 + total) % total;
				const prevPolygon = polygonMap.get(`${centroidKey}_${prevIndex}`);
				polygon.setStyle(polygonDefaultStyle);
				polygon.closePopup();
				prevPolygon.openPopup();
			};

			nextBtn.onclick = () => {
				const nextIndex = (index + 1) % total;
				const nextPolygon = polygonMap.get(`${centroidKey}_${nextIndex}`);
				polygon.setStyle(polygonDefaultStyle);
				polygon.closePopup();
				nextPolygon.openPopup();
			};
		}
	});

	polygon.on('popupclose', () => {
		polygon.setStyle(polygonDefaultStyle);
	});
}

// Main function to parse and display
function parseAndDisplay() {
	const input = document.getElementById('notamInput').value;
	const notams = parseNotams(input);
	const listEl = document.getElementById('coordinatesList');
	const showAll = document.getElementById('showAllNotams').checked;

	clearMarkers();
	listEl.innerHTML = '';

	if (notams.length === 0) {
		listEl.innerHTML = '<li class="no-results">No NOTAMs with coordinates found.</li>';
		return;
	}

	const bounds = [];
	const markerMap = new Map();
	const polygonMap = new Map();
	let posIndex = 1;

	// Draw polygon NOTAMs
	const polygonGroups = groupPolygonsByLocation(notams);

	polygonGroups.forEach((group, centroidKey) => {
		// Draw in reverse order so first polygon ends up on top
		for (let i = group.length - 1; i >= 0; i--) {
			const { notam } = group[i];
			const navInfo = { index: i, total: group.length, hasMultiple: group.length > 1 };

			const polygon = L.polygon(notam.coordinates.map(c => [c.lat, c.lon]), {
				...polygonDefaultStyle,
				renderer: canvasRenderer
			}).addTo(map);
			polygon._area = computePolygonArea(notam.coordinates);

			polygon.bindPopup(buildPolygonPopupHtml(notam, navInfo), POPUP_OPTIONS);
			setupPolygonEvents(polygon, navInfo, polygonMap, centroidKey);

			polygons.push(polygon);
			polygonMap.set(`${centroidKey}_${i}`, polygon);
			notam.coordinates.forEach(c => bounds.push([c.lat, c.lon]));

			const li = document.createElement('li');
			li.innerHTML = buildPolygonListItemHtml(notam, posIndex);
			li.querySelector('.notam-header').onclick = () => {
				map.fitBounds(polygon.getBounds(), FIT_BOUNDS_PADDING);
				polygon.openPopup();
				document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
			};
			listEl.appendChild(li);
			posIndex++;
		}
	});

	// Bring smaller polygons to front so they are clickable over larger ones
	polygons.sort((a, b) => b._area - a._area);
	polygons.forEach(p => p.bringToFront());

	const locationGroups = groupNotamsByLocation(notams, showAll);

	if (locationGroups.size === 0 && polygons.length === 0) {
		listEl.innerHTML = '<li class="no-results">No NOTAMs with PSN coordinates found. Enable "Show all NOTAMs" to include qualifier line coordinates.</li>';
		return;
	}

	const locationToGroups = buildLocationToGroupsMap(locationGroups);

	locationGroups.forEach((group, key) => {
		const groupsAtLocation = locationToGroups.get(group.locationKey);
		const groupIndex = groupsAtLocation.findIndex(g => g.key === key);
		const totalAtLocation = groupsAtLocation.length;
		const hasMultipleAtLocation = totalAtLocation > 1;
		const navInfo = { groupIndex, totalAtLocation, hasMultipleAtLocation, groupsAtLocation };

		// First marker at a location gets higher z-index so it's clickable
		const zIndexOffset = hasMultipleAtLocation ? (totalAtLocation - groupIndex) * 100 : 0;
		const icon = group.hasQualifierLine ? blueIcon : redIcon;
		const marker = L.marker([group.lat, group.lon], { icon, zIndexOffset }).addTo(map);

		marker.bindPopup(buildPopupHtml(group, navInfo), POPUP_OPTIONS);
		setupMarkerEvents(marker, group, navInfo, markerMap);

		markers.push(marker);
		bounds.push([group.lat, group.lon]);
		markerMap.set(key, marker);

		// Draw a persistent radius circle for PSN NOTAMs with a radius.
		// Qualifier-line circles stay ephemeral (drawn on popup open) since their
		// radii are coarse Q-line estimates, not operational zones.
		if (group.radius && !group.hasQualifierLine) {
			const nm = radiusToNM(group.radius, group.radiusUnit || 'NM');
			const circle = makeRadiusCircle(group.lat, group.lon, nm, '#ff7800');
			radiusCircles.push(circle);
			const cb = circle.getBounds();
			bounds.push([cb.getNorth(), cb.getEast()]);
			bounds.push([cb.getSouth(), cb.getWest()]);
		}

		const li = document.createElement('li');
		li.innerHTML = buildListItemHtml(group, posIndex);
		li.querySelector('.notam-header').onclick = () => {
			map.setView([group.lat, group.lon], 12);
			marker.openPopup();
			document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
		};
		listEl.appendChild(li);
		posIndex++;
	});

	if (bounds.length > 0) {
		map.fitBounds(bounds, FIT_BOUNDS_PADDING);
	}

	// Update statistics
	const statsEl = document.getElementById('statistics');
	const totalNotams = notams.length;
	const areaNotams = notams.filter(n => n.isPolygon).length;
	const positionNotams = notams.filter(n => !n.isPolygon && n.coordinates.some(c => c.type === 'psn')).length;
	const qualifierNotams = notams.filter(n => !n.isPolygon && n.coordinates.every(c => c.type === 'qualifierLine')).length;

	if (totalNotams > 0) {
		statsEl.innerHTML = `
			<span><strong>All NOTAMs:</strong> ${totalNotams}</span>
			<span><strong>No position:</strong> ${qualifierNotams}</span>
			<span><strong>Positions:</strong> ${positionNotams}</span>
			<span><strong>Areas:</strong> ${areaNotams}</span>
		`;
	} else {
		statsEl.innerHTML = '';
	}
}

// Load NOTAMs from a URL
async function loadNotamsFromUrl(url) {
	try {
		const response = await fetch(url);
		if (response.ok) {
			const text = await response.text();
			document.getElementById('notamInput').value = text;
			parseAndDisplay();
		}
	} catch (error) {
		console.error('Could not load NOTAMs from URL:', error);
	}
}

// Load example NOTAMs from external file
async function loadExampleNotams() {
	try {
		const response = await fetch('examples');
		if (response.ok) {
			const text = await response.text();
			document.getElementById('notamInput').value = text;
		}
	} catch (error) {
		console.error('Could not load example file:', error);
	}
}

// Handle file upload
async function handleFileUpload(event) {
	const file = event.target.files[0];
	if (!file) return;

	const textarea = document.getElementById('notamInput');

	try {
		const text = await file.text();
		textarea.value = text;
	} catch (error) {
		console.error('Error reading file:', error);
		alert('Error reading file.');
	}

	// Reset file input so same file can be selected again
	event.target.value = '';
}

async function pasteFromClipboard() {
	const textarea = document.getElementById('notamInput');
	textarea.focus();
	if (!navigator.clipboard || !navigator.clipboard.readText) {
		return;
	}
	try {
		const text = await navigator.clipboard.readText();
		if (text) {
			textarea.value = text;
		}
	} catch (error) {
		if (error.name === 'DataError' || error.name === 'NotAllowedError') {
			return;
		}
		console.error('Could not read clipboard:', error);
	}
}

// Clear all content
function clearAll() {
	document.getElementById('notamInput').value = '';
	document.getElementById('coordinatesList').innerHTML = '<li class="no-results">No NOTAM parsed yet. Enter NOTAMs and click "Display on map".</li>';
	clearMarkers();
	map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
}

// Print map to PDF
async function printMapToPdf() {
	const mapEl = document.getElementById('map');
	const btn = document.getElementById('printBtn');
	const originalText = btn.textContent;

	btn.textContent = 'Generating...';
	btn.disabled = true;

	// Hide map controls before capture
	const controls = mapEl.querySelectorAll('.leaflet-control-zoom, .leaflet-control-layers');
	controls.forEach(el => el.style.display = 'none');

	// Force map to recalculate and wait for tiles/SVG to settle
	map.invalidateSize();
	await new Promise(resolve => setTimeout(resolve, 500));

	try {
		// Capture the map element
		const canvas = await html2canvas(mapEl, {
			useCORS: true,
			allowTaint: true,
			logging: false,
			ignoreElements: (element) => {
				// Ignore elements that may cause positioning issues
				return element.classList && element.classList.contains('leaflet-control-container');
			}
		});

		// A4 landscape dimensions in mm and aspect ratio
		const a4Width = 297;
		const a4Height = 210;
		const a4Ratio = a4Width / a4Height;

		const imgWidth = canvas.width;
		const imgHeight = canvas.height;
		const imgRatio = imgWidth / imgHeight;

		// Calculate crop dimensions to match A4 ratio
		let cropWidth, cropHeight, cropX, cropY;

		if (imgRatio > a4Ratio) {
			// Image is wider than A4 ratio - crop width
			cropHeight = imgHeight;
			cropWidth = imgHeight * a4Ratio;
			cropX = (imgWidth - cropWidth) / 2;
			cropY = 0;
		} else {
			// Image is taller than A4 ratio - crop height
			cropWidth = imgWidth;
			cropHeight = imgWidth / a4Ratio;
			cropX = 0;
			cropY = (imgHeight - cropHeight) / 2;
		}

		// Create a new canvas with cropped content
		const croppedCanvas = document.createElement('canvas');
		croppedCanvas.width = cropWidth;
		croppedCanvas.height = cropHeight;
		const ctx = croppedCanvas.getContext('2d');
		ctx.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

		// Create PDF
		const { jsPDF } = window.jspdf;
		const pdf = new jsPDF({
			orientation: 'landscape',
			unit: 'mm',
			format: 'a4'
		});

		// Add the cropped image to PDF
		const imgData = croppedCanvas.toDataURL('image/jpeg', 0.95);
		pdf.addImage(imgData, 'JPEG', 0, 0, a4Width, a4Height);

		// Save the PDF
		pdf.save('notam-map.pdf');
	} catch (error) {
		console.error('Error generating PDF:', error);
		alert('Error generating PDF. Some map tiles may not support cross-origin access.');
	} finally {
		// Restore map controls
		controls.forEach(el => el.style.display = '');
		btn.textContent = originalText;
		btn.disabled = false;
	}
}

// Toggle fullscreen mode
function toggleFullscreen() {
	const mapEl = document.getElementById('map');
	const mapSection = document.querySelector('.map-section');
	const btn = document.getElementById('fullscreenBtn');

	if (mapEl.classList.contains('map-fullscreen')) {
		mapEl.classList.remove('map-fullscreen');
		mapSection.classList.remove('map-fullscreen-container');
		btn.textContent = 'Full screen';
	} else {
		mapEl.classList.add('map-fullscreen');
		mapSection.classList.add('map-fullscreen-container');
		btn.textContent = 'Exit full screen';
	}

	// Leaflet needs to recalculate size after container changes
	setTimeout(() => map.invalidateSize(), 100);
}

// Recalculate map container bounds after viewport changes (e.g. Android address bar hide/show)
let invalidateSizeTimeout = null;
function debouncedInvalidateSize() {
	if (invalidateSizeTimeout) clearTimeout(invalidateSizeTimeout);
	invalidateSizeTimeout = setTimeout(() => map.invalidateSize(), 100);
}
window.addEventListener('scroll', debouncedInvalidateSize);
window.addEventListener('resize', debouncedInvalidateSize);
if (window.visualViewport) {
	window.visualViewport.addEventListener('resize', debouncedInvalidateSize);
	window.visualViewport.addEventListener('scroll', debouncedInvalidateSize);
}

// Airport overlay
//
// Data shape: `data/airports.json` is { fields, rows } where each row is an
// array of values in the order declared by outputFields in
// cmd/airports/build.go. We access fields by index to avoid rehydrating ~85k
// rows into objects (saves ~40 MB of key-name overhead).
const AIRPORT_IDX = {
	IDENT: 0, TYPE: 1, NAME: 2, LAT: 3, LON: 4,
	ELEV: 5, COUNTRY: 6, CITY: 7, IATA: 8, RUNWAYS: 9
};

const RUNWAY_IDX = {
	LE: 0, HE: 1, LEN_FT: 2, WIDTH_FT: 3, SURFACE: 4, LIT: 5
};

// OurAirports surface codes are inconsistent (ASP / ASPH / ASPH-G / BIT all
// mean asphalt; TURF / Turf / GRS / GRE / Grass all mean grass, etc.).
// Normalise to a small set of human-readable labels.
const SURFACE_LABELS = {
	ASP: 'Asphalt', ASPH: 'Asphalt', 'ASPH-G': 'Asphalt', BIT: 'Bitumen', MAC: 'Macadam',
	CON: 'Concrete', CONC: 'Concrete', PEM: 'Concrete',
	TURF: 'Grass', 'TURF-G': 'Grass', GRS: 'Grass', GRE: 'Grass', GRA: 'Grass', GRASS: 'Grass',
	GVL: 'Gravel', GRVL: 'Gravel',
	WATER: 'Water', WTR: 'Water',
	SNOW: 'Snow', ICE: 'Ice',
	SAND: 'Sand', CORAL: 'Coral',
	DIRT: 'Dirt', EARTH: 'Dirt',
	UNK: '', UNKNOWN: ''
};

function formatSurface(raw) {
	if (!raw) return '';
	const up = String(raw).toUpperCase().trim();
	if (SURFACE_LABELS[up] !== undefined) return SURFACE_LABELS[up];
	if (up.startsWith('ASP')) return 'Asphalt';
	if (up.startsWith('CON') || up.startsWith('PEM')) return 'Concrete';
	if (up.startsWith('TURF') || up.startsWith('GRS') || up.startsWith('GRA') || up.startsWith('GRE')) return 'Grass';
	if (up.startsWith('GVL') || up.startsWith('GRV')) return 'Gravel';
	return raw;
}

function buildRunwaysHtml(runways) {
	if (!runways || runways.length === 0) return '';
	const rows = runways.map(r => {
		const le = r[RUNWAY_IDX.LE];
		const he = r[RUNWAY_IDX.HE];
		const lenFt = r[RUNWAY_IDX.LEN_FT];
		const widthFt = r[RUNWAY_IDX.WIDTH_FT];
		const surface = formatSurface(r[RUNWAY_IDX.SURFACE]);
		const lit = r[RUNWAY_IDX.LIT] === 1;

		const designator = (le && he) ? `${le}/${he}` : (le || he || '');
		let dimensions = '';
		if (lenFt != null && widthFt != null) {
			dimensions = `${Math.round(lenFt * 0.3048)} × ${Math.round(widthFt * 0.3048)} m`;
		} else if (lenFt != null) {
			dimensions = `${Math.round(lenFt * 0.3048)} m`;
		}

		return `<tr>
			<td class="rw-ident">${escapeHtml(designator)}</td>
			<td class="rw-dim">${escapeHtml(dimensions)}</td>
			<td class="rw-surface">${escapeHtml(surface)}</td>
			<td class="rw-lit">${lit ? 'Lit' : ''}</td>
		</tr>`;
	}).join('');
	return `<table class="airport-popup-runways">
		<thead><tr><th>Runway</th><th>Size</th><th>Surface</th><th></th></tr></thead>
		<tbody>${rows}</tbody>
	</table>`;
}

// Maki icons (https://github.com/mapbox/maki, CC0). Stripped of the width /
// height attributes so the consumer can size them via CSS.
const MAKI_AIRPORT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 15 15" fill="currentColor"><path d="M15,6.8182L15,8.5l-6.5-1l-0.3182,4.7727L11,14v1l-3.5-0.6818L4,15v-1l2.8182-1.7273L6.5,7.5L0,8.5V6.8182L6.5,4.5v-3c0,0,0-1.5,1-1.5s1,1.5,1,1.5v2.8182L15,6.8182z"/></svg>';
const MAKI_HELIPORT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 15 15" fill="currentColor"><path d="M4,2C3,2,3,3,4,3h4v1C7.723,4,7.5,4.223,7.5,4.5V5H5H3.9707H3.9316C3.7041,4.1201,2.9122,3.5011,2,3.5c-1.1046,0-2,0.8954-2,2s0.8954,2,2,2c0.3722-0.001,0.7368-0.1058,1.0527-0.3027L5.5,10.5C6.5074,11.9505,8.3182,12,9,12h5c0,0,1,0,1-1v-0.9941C15,9.2734,14.874,8.874,14.5,8.5l-3-3c0,0-0.5916-0.5-1.2734-0.5H9.5V4.5C9.5,4.223,9.277,4,9,4V3h4c1,0,1-1,0-1C13,2,4,2,4,2z M2,4.5c0.5523,0,1,0.4477,1,1s-0.4477,1-1,1s-1-0.4477-1-1C1,4.9477,1.4477,4.5,2,4.5z M10,6c0.5,0,0.7896,0.3231,1,0.5L13.5,9H10c0,0-1,0-1-1V7C9,7,9,6,10,6z"/></svg>';
const MAKI_HARBOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 15 15" fill="currentColor"><path d="M7.5,0C5.5,0,4,1.567,4,3.5c0.0024,1.5629,1.0397,2.902,2.5,3.3379v6.0391c-0.9305-0.1647-1.8755-0.5496-2.6484-1.2695C2.7992,10.6273,2.002,9.0676,2.002,6.498c0.0077-0.5646-0.4531-1.0236-1.0176-1.0137C0.4329,5.493-0.0076,5.9465,0,6.498c0,3.0029,1.0119,5.1955,2.4902,6.5723C3.9685,14.4471,5.8379,15,7.5,15c1.6656,0,3.535-0.5596,5.0117-1.9395S14.998,9.4868,14.998,6.498c0.0648-1.3953-2.0628-1.3953-1.998,0c0,2.553-0.7997,4.1149-1.8535,5.0996C10.3731,12.3203,9.4288,12.7084,8.5,12.875V6.8418C9.9607,6.4058,10.9986,5.0642,11,3.5C11,1.567,9.5,0,7.5,0z M7.5,2C8.3284,2,9,2.6716,9,3.5S8.3284,5,7.5,5S6,4.3284,6,3.5S6.6716,2,7.5,2z"/></svg>';

function airportTypeIcon(type) {
	switch (type) {
	case 'large_airport':
	case 'medium_airport':
	case 'small_airport':
		return MAKI_AIRPORT_SVG;
	case 'heliport':
		return MAKI_HELIPORT_SVG;
	case 'seaplane_base':
		return MAKI_HARBOR_SVG;
	default:
		return '';
	}
}

const airportStyles = {
	large_airport: { radius: 7, color: '#003d7a', fillColor: '#0066cc', fillOpacity: 0.9, weight: 1.5 },
	medium_airport: { radius: 6, color: '#145591', fillColor: '#2288dd', fillOpacity: 0.9, weight: 1.5 },
	small_airport: { radius: 5, color: '#2c6aa0', fillColor: '#66aadd', fillOpacity: 0.85, weight: 1.5 },
	heliport: { radius: 5, color: '#802040', fillColor: '#cc3366', fillOpacity: 0.85, weight: 1.5 },
	seaplane_base: { radius: 5, color: '#1e5e6a', fillColor: '#3399aa', fillOpacity: 0.85, weight: 1.5 },
	balloonport: { radius: 5, color: '#805620', fillColor: '#cc8844', fillOpacity: 0.85, weight: 1.5 }
};

function airportStyleForType(type) {
	return airportStyles[type] || airportStyles.small_airport;
}

function escapeHtml(s) {
	if (s == null) return '';
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function prettyAirportType(type) {
	const s = String(type).replace(/_/g, ' ');
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildAirportPopupHtml(row) {
	const ident = escapeHtml(row[AIRPORT_IDX.IDENT]);
	const iata = row[AIRPORT_IDX.IATA];
	const name = escapeHtml(row[AIRPORT_IDX.NAME]);
	const type = row[AIRPORT_IDX.TYPE];
	const country = row[AIRPORT_IDX.COUNTRY];
	const city = row[AIRPORT_IDX.CITY];
	const elev = row[AIRPORT_IDX.ELEV];

	const iataHtml = iata
		? ` <span class="airport-popup-iata">(${escapeHtml(iata)})</span>`
		: '';

	const iconSvg = airportTypeIcon(type);
	const iconColor = airportStyleForType(type).fillColor;
	const iconHtml = iconSvg
		? `<span class="airport-popup-icon" style="color:${iconColor}">${iconSvg}</span>`
		: '';

	const loc = [city, country].filter(Boolean).join(', ');
	const metaParts = [escapeHtml(prettyAirportType(type))];
	if (loc) metaParts.push(escapeHtml(loc));

	const elevHtml = (typeof elev === 'number')
		? `<div class="airport-popup-elev">Elevation: ${elev} ft (${Math.round(elev * 0.3048)} m)</div>`
		: '';

	const runwaysHtml = buildRunwaysHtml(row[AIRPORT_IDX.RUNWAYS]);

	return `<div class="airport-popup">
		<div class="airport-popup-title">${iconHtml}${ident}${iataHtml}</div>
		<div class="airport-popup-name">${name}</div>
		<div class="airport-popup-meta">${metaParts.join(' · ')}</div>
		${elevHtml}
		${runwaysHtml}
	</div>`;
}

// Pane for airport dots, below Leaflet's default markerPane (z-index 600)
// so NOTAM markers always sit on top.
function createAirportPane() {
	if (map.getPane('airports')) return;
	map.createPane('airports');
	map.getPane('airports').style.zIndex = 400;
}

function updateAirportsPaneVisibility() {
	const pane = map.getPane('airports');
	if (pane) pane.style.display = map.getZoom() <= 3 ? 'none' : '';
}

// Each airport type only renders at this zoom level or higher. Tighter
// thresholds at low zoom keep the map readable without resorting to clusters.
const AIRPORT_TYPE_MIN_ZOOM = {
	large_airport: 5,
	medium_airport: 6,
	small_airport: 8,
	heliport: 11,
	seaplane_base: 11,
	balloonport: 11
};

function buildAirportLayersByType(data) {
	if (!airportCanvasRenderer) {
		airportCanvasRenderer = L.canvas({ pane: 'airports' });
	}
	const byType = {};
	for (const type of Object.keys(AIRPORT_TYPE_MIN_ZOOM)) {
		byType[type] = L.layerGroup();
	}
	for (const row of data.rows) {
		const group = byType[row[AIRPORT_IDX.TYPE]];
		if (!group) continue; // skips 'closed' and any unknown types
		const cm = L.circleMarker([row[AIRPORT_IDX.LAT], row[AIRPORT_IDX.LON]], {
			renderer: airportCanvasRenderer,
			pane: 'airports',
			...airportStyleForType(row[AIRPORT_IDX.TYPE])
		});
		cm.bindPopup(() => buildAirportPopupHtml(row), POPUP_OPTIONS);
		group.addLayer(cm);
	}
	return byType;
}

// Reconcile which per-type airport layers are on the map for the current zoom.
function refreshAirportTypeVisibility() {
	if (!airportLayersByType || !airportLayer || !map.hasLayer(airportLayer)) return;
	const zoom = map.getZoom();
	for (const [type, group] of Object.entries(airportLayersByType)) {
		const shouldShow = zoom >= AIRPORT_TYPE_MIN_ZOOM[type];
		const isShown = airportLayer.hasLayer(group);
		if (shouldShow && !isShown) airportLayer.addLayer(group);
		else if (!shouldShow && isShown) airportLayer.removeLayer(group);
	}
}

async function ensureAirportsLoaded() {
	if (airportData) return airportData;
	if (airportsLoadPromise) return airportsLoadPromise;
	airportsLoadPromise = (async () => {
		const res = await fetch('data/airports.json');
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const data = await res.json();
		airportData = data;
		return data;
	})();
	airportsLoadPromise.catch(() => { airportsLoadPromise = null; });
	return airportsLoadPromise;
}

function showAirportsLoading() {
	if (airportsLoadingControl) return;
	const Ctl = L.Control.extend({
		onAdd() {
			const div = L.DomUtil.create('div', 'airport-loading-control');
			div.textContent = 'Loading airports…';
			return div;
		}
	});
	airportsLoadingControl = new Ctl({ position: 'bottomleft' });
	airportsLoadingControl.addTo(map);
}

function hideAirportsLoading() {
	if (airportsLoadingControl) {
		airportsLoadingControl.remove();
		airportsLoadingControl = null;
	}
}

async function onAirportOverlayAdd(e) {
	if (e.layer !== airportLayer) return;
	if (!airportsPopulated) {
		try {
			showAirportsLoading();
			const data = await ensureAirportsLoaded();
			airportLayersByType = buildAirportLayersByType(data);
			airportsPopulated = true;
		} catch (err) {
			console.error('Could not load airports:', err);
			alert('Could not load airports data.');
			return;
		} finally {
			hideAirportsLoading();
		}
	}
	refreshAirportTypeVisibility();
}

function setupAirportOverlay() {
	createAirportPane();
	updateAirportsPaneVisibility();
	map.on('zoomend', () => {
		updateAirportsPaneVisibility();
		refreshAirportTypeVisibility();
	});

	airportLayer = L.layerGroup();
	const overlayLabel = `<span class="airports-overlay-label">${MAKI_AIRPORT_SVG} Airports</span>`;
	layersControl.addOverlay(airportLayer, overlayLabel);
	map.on('overlayadd', onAirportOverlayAdd);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
	document.getElementById('parseBtn').addEventListener('click', parseAndDisplay);
	document.getElementById('printBtn').addEventListener('click', printMapToPdf);
	document.getElementById('fullscreenBtn').addEventListener('click', toggleFullscreen);
	document.getElementById('fileInput').addEventListener('change', handleFileUpload);
	document.getElementById('pasteBtn').addEventListener('click', pasteFromClipboard);
	document.getElementById('clearBtn').addEventListener('click', clearAll);

	setupAirportOverlay();

	const urlParam = new URLSearchParams(window.location.search).get('file');
	if (urlParam) {
		loadNotamsFromUrl(urlParam);
	} else {
		loadExampleNotams();
	}
});
