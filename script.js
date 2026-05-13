// Constants
const DEFAULT_CENTER = [48.8566, 2.3522];
const DEFAULT_ZOOM = 6;
const POPUP_OPTIONS = { maxWidth: 600, maxHeight: 500 };
const NOTAM_POPUP_OPTIONS = { ...POPUP_OPTIONS, minWidth: 580 };
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

const MARKER_RED_URL = 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png';
const MARKER_BLUE_URL = 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png';

// Red marker icon for qualifier line coordinates
const redIcon = L.icon({ ...markerIconOptions, iconUrl: MARKER_RED_URL });

// Default blue marker icon
const blueIcon = L.icon({ ...markerIconOptions, iconUrl: MARKER_BLUE_URL });

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

// Classify the NOTAM E) section into a coarse obstacle / activity type.
// Returns one of crane|turbine|metmast|antenna|chimney|powerline|trees|balloon|
// voltige|aeromodelisme|paragliding|glider|parachute|drone|firing|blasting|
// bird|laser|balisage, or ''. Every alternation matches real NOTAM text in
// testdata/World-20260512.txt; `?` plural endings are kept only when both
// forms actually appear in data.
// Order matters: when keywords overlap, the first match wins.
function classifyObstacle(eText) {
	if (!eText) return '';
	const t = eText.toUpperCase();
	if (/\b(GRUES?|CRANES?)\b/.test(t)) return 'crane';
	if (/\b(EOLIENNES?|WIND\s+TURBINES?|WTG|WIND\s+FARM)\b/.test(t)) return 'turbine';
	if (/\bMAT\s+DE\s+MESURE\b|\bMET\s+MAST\b|\bMEASUREMENT\s+MAST\b/.test(t)) return 'metmast';
	if (/\b(ANTENNES?|ANTENNAS?|PYLONE|PYLONS?)\b/.test(t)) return 'antenna';
	if (/\b(CHEMINEE|CHIMNEYS?)\b/.test(t)) return 'chimney';
	if (/\bLIGNE\s+(TRES\s+)?HAUTE\s+TENSION\b|\bPOWER\s+LINES?\b/.test(t)) return 'powerline';
	if (/\b(ARBRES?|TREES?|VEGETAL|VEGETAUX|VEGETATION|FOREST|FORET)\b/.test(t)) return 'trees';
	if (/\bBALLOONS?\b|\bBALLON\b/.test(t)) return 'balloon';
	if (/\bVOLTIGE\b|\bAEROBATICS?\b/.test(t)) return 'voltige';
	if (/\bAEROMODELISME\b|\bMODEL\s+AIRCRAFT\b|\bMODEL\s+FLYING\b/.test(t)) return 'aeromodelisme';
	if (/\b(PARAPENTES?|PARAGLIDERS?|PARAGLIDING|HANG\s+GLIDING)\b/.test(t)) return 'paragliding';
	if (/\b(PLANEURS?|VOL\s+A\s+VOILE|GLIDERS?|GLIDING)\b/.test(t)) return 'glider';
	if (/\bPARACHUTE\b|\bPARACHUTING\b|\bPARACHUTAGES?\b|\bPARACHUTISTES?\b|\bSKYDIVING\b/.test(t)) return 'parachute';
	if (/\b(UAS|UAV|RPAS?|DRONES?|UNMANNED\s+AIRCRAFT|UNMANNED\s+AERIAL|REMOTELY\s+PILOTED|AERONEFS?\s+SANS\s+EQUIPAGE|TELEPILOTES)\b/.test(t)) return 'drone';
	if (/\bGUNS?\b|\bFIRING\b|\bROCKETS?\b|\bMISSILES?\b|\bTIRS?\b/.test(t)) return 'firing';
	if (/\bBLASTING\b|\bDEMOLITION\b|\bEXPLOSIVES?\b|\bFIREWORKS\b|\bPYROTECHNIQUE\b/.test(t)) return 'blasting';
	if (/\bBIRDS?\b|\bWILDLIFE\s+HAZARD\b|\bOISEAUX\b/.test(t)) return 'bird';
	if (/\bLASER\b/.test(t)) return 'laser';
	// BALISAGE/OBSTACLE LIGHT is a fallback: NOTAMs about obstacle lighting
	// usually also name the obstacle (crane, mast, ...), which an earlier rule
	// will have matched. This catches lighting NOTAMs with no obstacle keyword.
	// BALISAGE followed by ':' or '=' is a descriptive attribute on an
	// obstacle NOTAM ("BALISAGE : JOUR ET NUIT"), not the subject — skip it.
	if (/\bBALISAGE\b(?!\s*[:=])|\bPHARE\s+DE\s+DANGER\b|\bOBST(?:ACLE)?\s+(?:LIGHTS?|LGTS?|LIGHTING)\b/.test(t)) return 'balisage';
	return '';
}

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

// ICAO Doc 8126 § 5.1 subject codes (second and third letters of the Q-code).
const Q_SUBJECTS = {
	AA: 'Minimum altitude',
	AC: 'Class B, C, D or E surface area',
	AD: 'Air defence identification zone',
	AE: 'Control area',
	AF: 'Flight information region',
	AH: 'Upper control area',
	AL: 'Minimum usable flight level',
	AN: 'Area navigation route',
	AO: 'Oceanic control area',
	AP: 'Reporting point',
	AR: 'ATS route',
	AT: 'Terminal control area',
	AU: 'Upper flight information region',
	AV: 'Upper advisory area',
	AX: 'Intersection',
	AZ: 'Aerodrome traffic zone',
	BU: 'Bird/wildlife hazard',
	CA: 'Air/ground facility',
	CB: 'Automatic dependent surveillance — broadcast',
	CC: 'Automatic dependent surveillance — contract',
	CD: 'Controller-pilot data link communications',
	CE: 'En route surveillance radar',
	CG: 'Ground controlled approach system',
	CL: 'Selective calling system',
	CM: 'Surface movement radar',
	CP: 'Precision approach radar',
	CR: 'Surveillance radar',
	CS: 'Secondary surveillance radar',
	CT: 'Terminal area surveillance radar',
	EB: 'Obstacle lights',
	FA: 'Aerodrome',
	FB: 'Friction measuring device',
	FC: 'Ceiling measurement equipment',
	FD: 'Docking system',
	FE: 'Oxygen',
	FF: 'Firefighting and rescue',
	FG: 'Ground movement control',
	FH: 'Helicopter alighting area or platform',
	FI: 'Aircraft de-icing',
	FJ: 'Oils',
	FL: 'Landing direction indicator',
	FM: 'Meteorological service',
	FO: 'Fog dispersal system',
	FP: 'Heliport',
	FS: 'Snow removal equipment',
	FT: 'Transmissometer',
	FU: 'Fuel availability',
	FW: 'Wind direction indicator',
	FZ: 'Customs/immigration',
	GA: 'GNSS airfield-specific operations',
	GW: 'GNSS area-wide operations',
	IA: 'DME',
	IC: 'Locator',
	ID: 'DME associated with ILS',
	IG: 'Glide path',
	II: 'Inner marker',
	IJ: 'NDB associated with ILS',
	IK: 'Inner approach surveillance',
	IL: 'Instrument landing system (ILS)',
	IM: 'Middle marker',
	IN: 'Localizer',
	IO: 'ILS Category I',
	IS: 'ILS Category II',
	IT: 'ILS Category III',
	IU: 'Microwave landing system (MLS)',
	IW: 'MLS Category I',
	IX: 'Locator, outer',
	IY: 'Locator, middle',
	LA: 'Approach lighting system',
	LB: 'Aerodrome beacon',
	LC: 'Runway centre line lights',
	LD: 'Landing direction indicator lights',
	LE: 'Runway edge lights',
	LF: 'Sequenced flashing lights',
	LG: 'Pilot-controlled lighting',
	LH: 'High intensity runway lights',
	LI: 'Runway end identifier lights',
	LJ: 'Runway alignment indicator lights',
	LK: 'Category II lighting system',
	LL: 'Low intensity runway lights',
	LM: 'Medium intensity runway lights',
	LP: 'Precision approach path indicator',
	LR: 'All landing area lighting facilities',
	LS: 'Stopway lights',
	LT: 'Threshold lights',
	LU: 'Helicopter approach path indicator',
	LV: 'Visual approach slope indicator system',
	LW: 'Heliport lighting',
	LX: 'Taxiway centre line lights',
	LY: 'Taxiway edge lights',
	LZ: 'Runway touchdown zone lights',
	MA: 'Movement area',
	MB: 'Bearing strength',
	MC: 'Clearway',
	MD: 'Declared distances',
	MG: 'Taxiing guidance system',
	MH: 'Runway arresting gear',
	MK: 'Parking area',
	MM: 'Daylight markings',
	MN: 'Apron',
	MO: 'Stopbar',
	MP: 'Aircraft stands',
	MR: 'Runway',
	MS: 'Stopway',
	MT: 'Threshold',
	MU: 'Runway turning bay',
	MW: 'Strip/shoulder',
	MX: 'Taxiway(s)',
	MY: 'Rapid exit taxiway',
	NA: 'All radio navigation facilities',
	NB: 'Non-directional radio beacon',
	ND: 'Distance measuring equipment',
	NF: 'Fan marker',
	NL: 'Locator',
	NM: 'VOR/DME',
	NN: 'TACAN',
	NO: 'OMEGA',
	NT: 'VORTAC',
	NV: 'VOR',
	NX: 'Direction finding station',
	OA: 'Aeronautical information service',
	OB: 'Obstacle',
	OE: 'Aircraft entry requirements',
	OL: 'Obstacle lights',
	OR: 'Rescue coordination centre',
	PA: 'Standard instrument arrival',
	PB: 'Standard VFR arrival',
	PC: 'Contingency procedures',
	PD: 'Standard instrument departure',
	PE: 'Standard VFR departure',
	PF: 'Flow control procedure',
	PH: 'Holding procedure',
	PI: 'Instrument approach procedure',
	PK: 'VFR approach procedure',
	PL: 'Flight plan processing',
	PM: 'Aerodrome operating minima',
	PN: 'Noise operating restriction',
	PO: 'Obstacle clearance altitude or height',
	PP: 'Obstacle clearance limit',
	PR: 'Radio failure procedure',
	PT: 'Transition altitude or transition level',
	PU: 'Missed approach procedure',
	PX: 'Minimum holding altitude',
	PZ: 'ADIZ procedure',
	RA: 'Airspace reservation',
	RD: 'Danger area',
	RM: 'Military operating area',
	RO: 'Overflying of',
	RP: 'Prohibited area',
	RR: 'Restricted area',
	RT: 'Temporary restricted area',
	SA: 'Automatic terminal information service',
	SB: 'ATS reporting office',
	SC: 'Area control centre',
	SE: 'Flight information service',
	SF: 'Aerodrome flight information service',
	SL: 'Flow control centre',
	SO: 'Oceanic area control centre',
	SP: 'Approach control service',
	SS: 'Flight service station',
	ST: 'Aerodrome control tower',
	SU: 'Upper area control centre',
	SV: 'VOLMET broadcast',
	SY: 'Upper advisory service',
	UA: 'Air traffic control centre',
	UB: 'ATS reporting office',
	UE: 'Flight information service',
	UI: 'AFIS',
	UO: 'Approach control',
	UR: 'Aerodrome control tower',
	WA: 'Air display',
	WB: 'Aerobatics',
	WC: 'Captive balloon or kite',
	WD: 'Demolition of explosives',
	WE: 'Exercises',
	WF: 'Air refuelling',
	WG: 'Glider flying',
	WH: 'Blasting',
	WJ: 'Banner/target towing',
	WL: 'Ascent of free balloon',
	WM: 'Missile, gun or rocket firing',
	WP: 'Parachute jumping exercise',
	WR: 'Radioactive materials or toxic chemicals',
	WS: 'Burning or blowing gas',
	WT: 'Mass movement of aircraft',
	WU: 'Unmanned aircraft',
	WV: 'Formation flight',
	WW: 'Significant volcanic activity',
	WY: 'Aerial survey',
	WZ: 'Model flying',
	XX: 'Other',
};

// ICAO Doc 8126 § 5.2 condition codes (fourth and fifth letters of the Q-code).
const Q_CONDITIONS = {
	AC: 'withdrawn for maintenance',
	AD: 'available for daylight operation',
	AF: 'flight checked and found reliable',
	AG: 'operating but ground checked only',
	AH: 'hours of service now',
	AK: 'resumed normal operations',
	AL: 'operative subject to previously published limitations',
	AM: 'military operations only',
	AN: 'available for night operation',
	AO: 'operational',
	AP: 'available, prior permission required',
	AR: 'available on request',
	AS: 'unserviceable',
	AU: 'not available',
	AW: 'completely withdrawn',
	AX: 'previously promulgated shutdown cancelled',
	BD: 'beacon decommissioned',
	BE: 'beacon established',
	CA: 'activated',
	CC: 'completed',
	CD: 'deactivated',
	CE: 'erected, exists',
	CF: 'operating frequency changed',
	CG: 'downgraded',
	CH: 'changed',
	CI: 'identification or radio call sign changed',
	CK: 'operating on reduced power',
	CL: 'operating on test, do not use',
	CM: 'displaced',
	CN: 'cancelled',
	CO: 'operating',
	CP: 'operating as a fixed obstacle',
	CR: 'temporarily replaced',
	CS: 'installed',
	CT: 'on test, do not use',
	CU: 'discontinued',
	CY: 'reclassified',
	DC: 'distance changed',
	DI: 'dimensions increased',
	DR: 'reduced',
	EI: 'initial operating capability',
	EL: 'limited',
	EN: 'now usable on radio',
	ER: 'restored',
	ES: 'reserved for further operations',
	GA: 'activated',
	GD: 'deactivated',
	GE: 'established',
	GS: 'suspended',
	HG: 'hijacked',
	HU: 'unsafe',
	HW: 'hazard warning',
	HX: 'no specific working hours',
	IA: 'identification temporarily withdrawn',
	IE: 'identification of',
	IN: 'inoperative',
	IQ: 'inoperative for daylight only',
	IS: 'inoperative for night use',
	JO: 'jettisoned',
	KY: 'key/access',
	LA: 'limited to',
	LB: 'reserved for',
	LC: 'closed',
	LE: 'operating without auxiliary power',
	LF: 'reduced interference',
	LG: 'operating without identification',
	LH: 'operating without monitoring',
	LI: 'closed to IFR',
	LL: 'usable for limited periods',
	LN: 'available for',
	LO: 'operating',
	LP: 'prohibited',
	LQ: 'closed to VFR',
	LR: 'restricted',
	LS: 'subject to interruption',
	LT: 'limited to specific bearings',
	LW: 'restricted area created',
	MB: 'identification or call sign changed',
	ME: 'frequency changed',
	MI: 'modified as follows',
	MP: 'power changed',
	MS: 'schedule of operating modified',
	NA: 'new operations now scheduled',
	NC: 'new course',
	ND: 'new distance',
	NE: 'reorganised facilities',
	NH: 'new hours of service',
	NI: 'now identified as',
	NN: 'now available',
	NO: 'operating on standby',
	NT: 'test transmissions',
	NZ: 'newly commissioned',
	PA: 'prohibited to aircraft',
	PE: 'permission required',
	PM: 'parts missing',
	PO: 'prohibited operating',
	PP: 'prohibited, permission required',
	PT: 'time of operation changed',
	QU: 'questionable',
	RA: 'reactivated',
	RE: 'released',
	RI: 'replaced by',
	RK: 'remarked',
	RM: 'removed',
	RO: 'reopened',
	RQ: 'reissued',
	RR: 'refer',
	RT: 'trigger NOTAM',
	RY: 'newly published',
	SA: 'safety advisory',
	SE: 'available subject to prior conditions',
	SI: 'special instructions',
	SQ: 'state of equipment',
	ST: 'suspended',
	TA: 'aircraft caught by arresting gear',
	TE: 'temporarily extended',
	TI: 'item of equipment',
	TL: 'limited maintenance work in progress',
	TO: 'transferred to',
	TR: 'resumed',
	TS: 'schedule of operations',
	TT: 'closed temporarily',
	UI: 'out of service for operational reasons',
	UM: 'out of service for maintenance',
	UR: 'out of service for repair',
	VA: 'information available',
	VI: 'verified',
	WA: 'withdrawn',
	WK: 'work in progress',
	XX: 'plain language',
};

// Decode a 5-letter ICAO Q-code (e.g. "QOBCE") into a human-readable phrase
// "<subject>, <condition>". Returns '' for invalid input or when neither
// half is known; falls back to the raw 2-letter half when only one matches.
function decodeQCode(code) {
	if (typeof code !== 'string' || !/^Q[A-Z]{4}$/.test(code)) return '';
	const subject = Q_SUBJECTS[code.substring(1, 3)];
	const condition = Q_CONDITIONS[code.substring(3, 5)];
	if (!subject && !condition) return '';
	return `${subject || code.substring(1, 3)}, ${condition || code.substring(3, 5)}`;
}

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

// Extract an airport-anchored position spec from the E section, e.g.
// "RDL 031/5.4NM ARP LFAI" (bearing 31°, 5.4 NM from airport reference
// point of LFAI). Used as a fallback when no DMS coord is present.
function extractAirportAnchor(eContent) {
	const m = eContent.match(/\bRDL\s*(\d{1,3})(?:DEG)?\s*\/\s*(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+ARP\s+([A-Z]{4})\b/i);
	if (!m) return null;
	return {
		bearing: parseFloat(m[1]),
		distance: parseFloat(m[2].replace(',', '.')),
		distanceUnit: m[3].toUpperCase(),
		ident: m[4].toUpperCase()
	};
}

// Move `distance` (in `unit`) along true bearing `bearing` (degrees from
// north, clockwise) from the airport coord. Planar approximation — good to
// ~50 m at the few-NM scale typical of RDL specs. French RDLs are technically
// magnetic; the resulting error in France is ~1-2° of bearing, well within
// other NOTAM-source noise.
function computeAirportAnchoredPosition(anchor, airportCoord) {
	const dist = anchor.distance * (
		anchor.distanceUnit === 'NM' ? NM_TO_METERS :
			anchor.distanceUnit === 'KM' ? 1000 : 1
	);
	const bearingRad = anchor.bearing * Math.PI / 180;
	const dy = dist * Math.cos(bearingRad);
	const dx = dist * Math.sin(bearingRad);
	const M_PER_DEG = 111320;
	const cosLat = Math.cos(airportCoord.lat * Math.PI / 180);
	return {
		lat: airportCoord.lat + dy / M_PER_DEG,
		lon: airportCoord.lon + dx / (cosLat * M_PER_DEG)
	};
}

// Parse NOTAMs and extract those with coordinates.
// opts.lookupAirport: optional (ident) => {lat, lon} | null. When provided,
// NOTAMs that produce no DMS coord but contain "RDL <bearing>/<distance>
// ARP <ICAO>" gain a position computed from the airport coord.
function parseNotams(text, opts = {}) {
	const lookupAirport = opts.lookupAirport;
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
				//   "441007 N 0045151 E"         space between digits and hemisphere letter
				//   "161514N0611540W"            fixed 6+7 digits, no separator
				const coordPattern = /(\d{4,7}(?:[.,]\d+)?)\s*([NS])(?:\s+|\s*[,-]\s*)?(\d{5,8}(?:[.,]\d+)?)\s*([EW])|(\d{6})([NS])(\d{7})([EW])/gi;
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

		// Try an airport-anchored position before falling back to the Q-line:
		// "RDL <bearing>/<distance> ARP <ICAO>" can pin a NOTAM that lacks a
		// DMS coord (e.g. obstacle NOTAMs referenced only by airport bearing).
		if (coordinateGroups.length === 0 && eContent && lookupAirport) {
			const anchor = extractAirportAnchor(eContent);
			if (anchor) {
				const ap = lookupAirport(anchor.ident);
				if (ap) {
					const pos = computeAirportAnchoredPosition(anchor, ap);
					coordinateGroups.push([{
						original: `RDL ${anchor.bearing}/${anchor.distance}${anchor.distanceUnit} ARP ${anchor.ident}`,
						lat: pos.lat,
						lon: pos.lon,
						type: 'psn'
					}]);
				}
			}
		}

		// Parse Q-line once for qCode (and as fallback coord source)
		const qualifier = sections.Q ? parseQualifierLine(sections.Q) : null;

		// Find qualifier line coordinates only if no PSN coordinates found
		if (coordinateGroups.length === 0 && qualifier) {
			coordinateGroups.push([{
				original: sections.Q.split(/\s*\/\s*/).pop(),
				lat: qualifier.lat,
				lon: qualifier.lon,
				radius: qualifier.radius,
				type: 'qualifierLine'
			}]);
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
				estimated: dates.estimated,
				qCode: qualifier ? qualifier.code : '',
				obstacleType: classifyObstacle(eContent)
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
				radiusUnit: coord.radiusUnit,
				qCode: notam.qCode,
				obstacleType: notam.obstacleType
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

	const notamsList = group.notams.map(n => {
		const decoded = decodeQCode(n.qCode);
		const qLine = decoded ? `<div class="popup-qcode">${decoded}</div>` : '';
		return `
			<div class="popup-notam">
				${qLine}
				<strong>${n.id}</strong>
				<pre class="popup-content">${n.fullContent}</pre>
			</div>
		`;
	}).join('<hr class="popup-divider">');

	return `
		<div class="notam-popup">
			${navHtml}
			<div class="popup-header">
				${icaoDisplay}
				<div class="popup-coords">${formatDMS(group.lat, group.lon)}</div>
				<div class="popup-header-right">
					${radiusInfo}
					${countBadge}
				</div>
			</div>
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

	const notamEntries = group.notams.map(n => {
		const decoded = decodeQCode(n.qCode);
		const qLine = decoded ? `<div class="list-qcode">${decoded}</div>` : '';
		return `
			<div class="notam-entry">
				${qLine}
				<div class="notam-entry-id">${n.id}</div>
				<pre class="notam-content">${n.fullContent}</pre>
			</div>
		`;
	}).join('<hr class="notam-divider">');

	return `
		<div class="notam-header">
			<span class="coord-label">#${posIndex}</span>
			${listIcaoDisplay}
			<strong>${notamIds}</strong>${countLabel}
			${positionLabel}
		</div>
		<div class="notam-contents">
			${notamEntries}
		</div>
	`;
}

// Insert visible ↩ markers at soft-wrap points within a <pre> block.
// Markers are absolutely positioned and `user-select: none` so they appear
// in the view but never end up in the clipboard when text is copied.
function decorateWrapPoints(pre) {
	const original = pre.textContent;
	if (!original) return;
	const lines = original.split('\n');
	pre.textContent = '';

	const lineSpans = [];
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) pre.appendChild(document.createTextNode('\n'));
		const line = lines[i];
		if (!line) { lineSpans.push(null); continue; }
		const span = document.createElement('span');
		span.textContent = line;
		pre.appendChild(span);
		lineSpans.push(span);
	}

	const preRect = pre.getBoundingClientRect();
	for (const span of lineSpans) {
		if (!span) continue;
		const range = document.createRange();
		range.selectNodeContents(span);
		const rects = range.getClientRects();
		if (rects.length < 2) continue;
		for (let r = 0; r < rects.length - 1; r++) {
			const marker = document.createElement('span');
			marker.className = 'wrap-marker';
			marker.textContent = '↩';
			marker.style.top = (rects[r].top - preRect.top) + 'px';
			marker.style.left = (rects[r].right - preRect.left) + 'px';
			pre.appendChild(marker);
		}
	}
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

		const popupEl = marker.getPopup().getElement();
		if (popupEl) popupEl.querySelectorAll('.popup-content').forEach(decorateWrapPoints);

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

	const decoded = decodeQCode(notam.qCode);
	const qLine = decoded ? `<div class="popup-qcode">${decoded}</div>` : '';

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
					${qLine}
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

	const decoded = decodeQCode(notam.qCode);
	const qLine = decoded ? `<div class="list-qcode">${decoded}</div>` : '';

	return `
		<div class="notam-header">
			<span class="coord-label">#${posIndex}</span>
			${icaoDisplay}
			<strong>${notam.id}</strong>
			<span class="notam-area">Area (${notam.coordinates.length} points)</span>
		</div>
		<div class="notam-contents">
			<div class="notam-entry">
				${qLine}
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

		const popupEl = polygon.getPopup().getElement();
		if (popupEl) popupEl.querySelectorAll('.popup-content').forEach(decorateWrapPoints);

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
// Build a fast ICAO-ident → {lat, lon} lookup over the loaded airport data,
// or null if airports haven't been loaded yet. Lazy: the index is built on
// first call and cached on airportData.
function buildAirportLookup() {
	if (!airportData) return null;
	if (!airportData._byIdent) {
		const m = new Map();
		for (const row of airportData.rows) m.set(row[AIRPORT_IDX.IDENT], row);
		airportData._byIdent = m;
	}
	return (ident) => {
		const row = airportData._byIdent.get(ident);
		return row ? { lat: row[AIRPORT_IDX.LAT], lon: row[AIRPORT_IDX.LON] } : null;
	};
}

function parseAndDisplay() {
	const input = document.getElementById('notamInput').value;
	const notams = parseNotams(input, { lookupAirport: buildAirportLookup() });
	const listEl = document.getElementById('coordinatesList');
	const showAll = document.getElementById('showAllNotams').checked;
	const useTypeIcons = document.getElementById('typeIcons').checked;

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

			polygon.bindPopup(buildPolygonPopupHtml(notam, navInfo), NOTAM_POPUP_OPTIONS);
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
		// Pick a representative obstacle type for the group; the most common,
		// first on tie. Type icons are only shown on red (PSN) markers; blue
		// qualifier-line markers keep the plain pin since the location is
		// coarse. Empty when no NOTAM in the group has a known type or when
		// type icons are disabled.
		const types = (useTypeIcons && !group.hasQualifierLine)
			? group.notams.map(n => n.obstacleType).filter(Boolean) : [];
		const dominantType = types.length ? mode(types) : '';
		const icon = dominantType
			? obstacleMarkerIcon(dominantType)
			: (group.hasQualifierLine ? blueIcon : redIcon);
		const marker = L.marker([group.lat, group.lon], { icon, zIndexOffset }).addTo(map);

		marker.bindPopup(buildPopupHtml(group, navInfo), NOTAM_POPUP_OPTIONS);
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
// Obstacle / activity glyph path data, 24x24 viewBox. Most paths are from
// Material Design Icons (Apache 2.0); glider is hand-drawn since MDI has no
// glider icon.
const OBSTACLE_GLYPH_PATHS = {
	crane: 'M20,6V5A1,1 0 0,0 19,4H9V3H6V4H5V6H6V15H5V13H3V15H2V17H3V21H5V17H10V21H12V19.92L12,17H13V15H12V13H10V15H9V6H17V10.62C16.53,10.79 16.19,11.23 16.19,11.76C16.19,12.2 16.43,12.6 16.8,12.82V14H17.42C17.76,14 18.03,14.28 18.03,14.62C18.03,14.96 17.76,15.24 17.42,15.24C17.2,15.24 17,15.12 16.89,14.93C16.71,14.64 16.34,14.54 16.05,14.71C15.75,14.87 15.65,15.25 15.82,15.55C16.15,16.11 16.76,16.47 17.42,16.47C18.43,16.47 19.26,15.64 19.26,14.62C19.26,13.84 18.76,13.14 18.03,12.88V12.82C18.41,12.6 18.65,12.2 18.65,11.76C18.65,11.3 18.38,10.91 18,10.7V6H20M8,13.66L7,14.66V13.24L8,12.24V13.66M8,10.71L7,11.71V10.29L8,9.29V10.71M7,8.71V7.29L8,6.29V7.71L7,8.71Z',
	turbine: 'M13.33,11.67L16.21,14.58C17.62,13.16 16.21,11.75 16.21,11.75L14.72,10.24C14.9,9.86 15,9.44 15,9C15,7.95 14.46,7.03 13.64,6.5L15,2.11C13.09,1.53 12.5,3.44 12.5,3.44L11.69,6.03C10.46,6.16 9.46,7 9.13,8.18L4.67,9.63C5.31,11.53 7.2,10.9 7.2,10.9L9.27,10.23C9.61,10.97 10.23,11.54 11,11.82V19C11,19 9,19 9,21C9,21.5 9,21.81 9,22H15V21C15,21 15,19 13,19V11.82C13.12,11.78 13.23,11.72 13.33,11.67M10.5,9A1.5,1.5 0 0,1 12,7.5A1.5,1.5 0 0,1 13.5,9A1.5,1.5 0 0,1 12,10.5A1.5,1.5 0 0,1 10.5,9Z',
	metmast: 'M7 5V13L22 11V7L7 5M10 6.91L13 7.31V10.69L10 11.09V6.91M16 7.71L19 8.11V9.89L16 10.29V7.71M5 10V11H6V12H5V21H3V4C3 3.45 3.45 3 4 3S5 3.45 5 4V6H6V7H5V10Z',
	antenna: 'M12 7.5C12.69 7.5 13.27 7.73 13.76 8.2S14.5 9.27 14.5 10C14.5 11.05 14 11.81 13 12.28V21H11V12.28C10 11.81 9.5 11.05 9.5 10C9.5 9.27 9.76 8.67 10.24 8.2S11.31 7.5 12 7.5M16.69 5.3C17.94 6.55 18.61 8.11 18.7 10C18.7 11.8 18.03 13.38 16.69 14.72L15.5 13.5C16.5 12.59 17 11.42 17 10C17 8.67 16.5 7.5 15.5 6.5L16.69 5.3M6.09 4.08C4.5 5.67 3.7 7.64 3.7 10S4.5 14.3 6.09 15.89L4.92 17.11C3 15.08 2 12.7 2 10C2 7.3 3 4.94 4.92 2.91L6.09 4.08M19.08 2.91C21 4.94 22 7.3 22 10C22 12.8 21 15.17 19.08 17.11L17.91 15.89C19.5 14.3 20.3 12.33 20.3 10S19.5 5.67 17.91 4.08L19.08 2.91M7.31 5.3L8.5 6.5C7.5 7.42 7 8.58 7 10C7 11.33 7.5 12.5 8.5 13.5L7.31 14.72C5.97 13.38 5.3 11.8 5.3 10C5.3 8.2 5.97 6.64 7.31 5.3Z',
	chimney: 'M4,18V20H8V18H4M4,14V16H14V14H4M10,18V20H14V18H10M16,14V16H20V14H16M16,18V20H20V18H16M2,22V8L7,12V8L12,12V8L17,12L18,2H21L22,12V22H2Z',
	powerline: 'M8.28,5.45L6.5,4.55L7.76,2H16.23L17.5,4.55L15.72,5.44L15,4H9L8.28,5.45M18.62,8H14.09L13.3,5H10.7L9.91,8H5.38L4.1,10.55L5.89,11.44L6.62,10H17.38L18.1,11.45L19.89,10.56L18.62,8M17.77,22H15.7L15.46,21.1L12,15.9L8.53,21.1L8.3,22H6.23L9.12,11H11.19L10.83,12.35L12,14.1L13.16,12.35L12.81,11H14.88L17.77,22M11.4,15L10.5,13.65L9.32,18.13L11.4,15M14.68,18.12L13.5,13.64L12.6,15L14.68,18.12Z',
	trees: 'M10,21V18H3L8,13H5L10,8H7L12,3L17,8H14L19,13H16L21,18H14V21H10Z',
	balloon: 'M13.16,12.74L14,14H12.5C12.35,16.71 12,19.41 11.5,22.08L10.5,21.92C11,19.3 11.34,16.66 11.5,14H10L10.84,12.74C8.64,11.79 7,8.36 7,6A5,5 0 0,1 12,1A5,5 0 0,1 17,6C17,8.36 15.36,11.79 13.16,12.74Z',
	voltige: 'M20.56 3.91C21.15 4.5 21.15 5.45 20.56 6.03L16.67 9.92L18.79 19.11L17.38 20.53L13.5 13.1L9.6 17L9.96 19.47L8.89 20.53L7.13 17.35L3.94 15.58L5 14.5L7.5 14.87L11.37 11L3.94 7.09L5.36 5.68L14.55 7.8L18.44 3.91C19 3.33 20 3.33 20.56 3.91Z',
	aeromodelisme: 'M13.69 3.46C13.35 3.15 12.96 3 12.5 3C12.05 3 11.66 3.15 11.33 3.46L5.54 9.08C5.23 9.38 5.06 9.75 5 10.2C5 10.64 5.08 11.04 5.33 11.4L11.45 19.83C11.2 20.36 10.75 20.62 10.09 20.62C9.29 20.62 8.79 20.25 8.6 19.5C8.4 18.84 8 18.27 7.38 17.8C6.76 17.34 6.1 17.1 5.41 17.1C4.36 17.1 3.5 17.5 2.85 18.3L4.21 19.42C4.5 19.03 4.92 18.84 5.41 18.84C6.21 18.84 6.71 19.21 6.9 19.95C7.09 20.62 7.5 21.19 8.12 21.67C8.74 22.15 9.4 22.4 10.09 22.4C11.33 22.4 12.28 21.83 12.94 20.7L19.68 11.39C19.93 11.04 20.03 10.64 20 10.2C19.95 9.75 19.77 9.38 19.47 9.08L13.69 3.46Z',
	paragliding: 'M12 17C10.9 17 10 16.11 10 15S10.9 13 12 13 14 13.9 14 15 13.11 17 12 17M19 14H17C17 16.76 14.76 19 12 19S7 16.76 7 14H5C5 16.79 6.64 19.19 9 20.32V23H15V20.32C17.36 19.19 19 16.79 19 14M23 7.76C23.04 8.56 22.05 9.06 21.41 8.6C21.27 8.46 21.16 8.44 21 8.32L18.97 13H17L15.5 6.73C13.21 6.5 10.79 6.5 8.5 6.73L7 13H5.03L3 8.32C2.84 8.44 2.73 8.46 2.59 8.6C1.95 9.06 .959 8.56 1 7.76V4C1 4 1 1 12 1S23 4 23 4M6.9 7C6 7.2 5.15 7.43 4.37 7.71L5.87 11.27L6.9 7M19.63 7.71C18.85 7.43 18 7.2 17.1 7L18.13 11.27L19.63 7.71Z',
	parachute: 'M21.2,10.95L12,23L2.78,10.96L2.87,10.88C3.08,10.67 3.33,10.5 3.58,10.36L10.73,19.69L8.58,13L9.24,11.81L12,20.38L14.73,11.8L15.4,13L13.27,19.69L20.41,10.35C20.66,10.5 20.9,10.64 21.1,10.85L21.2,10.95M5,9C6.5,9 7.81,9.86 8.5,11.1C9.17,9.86 10.47,9 12,9C13.5,9 14.8,9.85 15.5,11.09C16.16,9.84 17.47,9 19,9C20.09,9 21.09,9.42 21.81,10.14C20.94,5.5 16.88,2 12,2C7.09,2 3.03,5.5 2.16,10.17C2.89,9.45 3.89,9 5,9Z',
	balisage: 'M12,6A6,6 0 0,1 18,12C18,14.22 16.79,16.16 15,17.2V19A1,1 0 0,1 14,20H10A1,1 0 0,1 9,19V17.2C7.21,16.16 6,14.22 6,12A6,6 0 0,1 12,6M14,21V22A1,1 0 0,1 13,23H11A1,1 0 0,1 10,22V21H14M20,11H23V13H20V11M1,11H4V13H1V11M13,1V4H11V1H13M4.92,3.5L7.05,5.64L5.63,7.05L3.5,4.93L4.92,3.5M16.95,5.63L19.07,3.5L20.5,4.93L18.37,7.05L16.95,5.63Z',
	drone: 'M5.5,1C8,1 10,3 10,5.5C10,6.38 9.75,7.2 9.31,7.9L9.41,8H14.59L14.69,7.9C14.25,7.2 14,6.38 14,5.5C14,3 16,1 18.5,1C21,1 23,3 23,5.5C23,8 21,10 18.5,10C17.62,10 16.8,9.75 16.1,9.31L15,10.41V13.59L16.1,14.69C16.8,14.25 17.62,14 18.5,14C21,14 23,16 23,18.5C23,21 21,23 18.5,23C16,23 14,21 14,18.5C14,17.62 14.25,16.8 14.69,16.1L14.59,16H9.41L9.31,16.1C9.75,16.8 10,17.62 10,18.5C10,21 8,23 5.5,23C3,23 1,21 1,18.5C1,16 3,14 5.5,14C6.38,14 7.2,14.25 7.9,14.69L9,13.59V10.41L7.9,9.31C7.2,9.75 6.38,10 5.5,10C3,10 1,8 1,5.5C1,3 3,1 5.5,1M5.5,3A2.5,2.5 0 0,0 3,5.5A2.5,2.5 0 0,0 5.5,8A2.5,2.5 0 0,0 8,5.5A2.5,2.5 0 0,0 5.5,3M5.5,16A2.5,2.5 0 0,0 3,18.5A2.5,2.5 0 0,0 5.5,21A2.5,2.5 0 0,0 8,18.5A2.5,2.5 0 0,0 5.5,16M18.5,3A2.5,2.5 0 0,0 16,5.5A2.5,2.5 0 0,0 18.5,8A2.5,2.5 0 0,0 21,5.5A2.5,2.5 0 0,0 18.5,3M18.5,16A2.5,2.5 0 0,0 16,18.5A2.5,2.5 0 0,0 18.5,21A2.5,2.5 0 0,0 21,18.5A2.5,2.5 0 0,0 18.5,16Z',
	firing: 'M11,2V4.07C7.38,4.53 4.53,7.38 4.07,11H2V13H4.07C4.53,16.62 7.38,19.47 11,19.93V22H13V19.93C16.62,19.47 19.47,16.62 19.93,13H22V11H19.93C19.47,7.38 16.62,4.53 13,4.07V2M11,6.08V8H13V6.09C15.5,6.5 17.5,8.5 17.92,11H16V13H17.91C17.5,15.5 15.5,17.5 13,17.92V16H11V17.91C8.5,17.5 6.5,15.5 6.08,13H8V11H6.09C6.5,8.5 8.5,6.5 11,6.08M12,11A1,1 0 0,0 11,12A1,1 0 0,0 12,13A1,1 0 0,0 13,12A1,1 0 0,0 12,11Z',
	blasting: 'M11.25,6A3.25,3.25 0 0,1 14.5,2.75A3.25,3.25 0 0,1 17.75,6C17.75,6.42 18.08,6.75 18.5,6.75C18.92,6.75 19.25,6.42 19.25,6V5.25H20.75V6A2.25,2.25 0 0,1 18.5,8.25A2.25,2.25 0 0,1 16.25,6A1.75,1.75 0 0,0 14.5,4.25A1.75,1.75 0 0,0 12.75,6H14V7.29C16.89,8.15 19,10.83 19,14A7,7 0 0,1 12,21A7,7 0 0,1 5,14C5,10.83 7.11,8.15 10,7.29V6H11.25M22,6H24V7H22V6M19,4V2H20V4H19M20.91,4.38L22.33,2.96L23.04,3.67L21.62,5.09L20.91,4.38Z',
	bird: 'M23 11.5L19.95 10.37C19.69 9.22 19.04 8.56 19.04 8.56C17.4 6.92 14.75 6.92 13.11 8.56L11.63 10.04L5 3C4 7 5 11 7.45 14.22L2 19.5C2 19.5 10.89 21.5 16.07 17.45C18.83 15.29 19.45 14.03 19.84 12.7L23 11.5M17.71 11.72C17.32 12.11 16.68 12.11 16.29 11.72C15.9 11.33 15.9 10.7 16.29 10.31C16.68 9.92 17.32 9.92 17.71 10.31C18.1 10.7 18.1 11.33 17.71 11.72Z',
	laser: 'M9 13L5 16C4 16.88 3.86 18.12 4 19C4.13 20 4.91 21.22 6 21.68C7.57 22.35 9.09 21.9 10.04 20.92L19 13C20.86 11.62 20 9 18 9H12L19.46 4.61C19.9 4.29 20.08 3.82 20.06 3.37C20 2.67 19.46 2 18.6 2H18.54C18.19 2 17.86 2.11 17.56 2.29L5 9C4.19 9.46 3.94 10.24 4 11C4.05 12.03 4.74 13 6 13M5 18.5C5 17.12 6.12 16 7.5 16S10 17.12 10 18.5 8.88 21 7.5 21 5 19.88 5 18.5Z',
	glider: 'M2 12.5h20v1.5H2zM11.5 3h1.5v18h-1.5zM9 19h6v1.5H9z',
};

const PIN_BODY_PATH = 'M12.5 0 C5.6 0 0 5.6 0 12.5 C0 21.9 12.5 41 12.5 41 C12.5 41 25 21.9 25 12.5 C25 5.6 19.4 0 12.5 0 Z';

// Build a self-contained SVG marker: teardrop pin + white inner disc + glyph,
// all in one image so a single <img> per marker is all the DOM needs.
function obstacleMarkerSvg(type, color) {
	const glyph = OBSTACLE_GLYPH_PATHS[type];
	return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 41" width="25" height="41">' +
		`<path d="${PIN_BODY_PATH}" fill="${color}"/>` +
		'<circle cx="12.5" cy="12.5" r="9" fill="#fff"/>' +
		(glyph
			? `<svg x="4.5" y="4.5" width="16" height="16" viewBox="0 0 24 24" fill="${color}"><path d="${glyph}"/></svg>`
			: '') +
		'</svg>';
}

// Cache one L.icon per type — all PSN markers of the same kind share it.
// Type icons are only used on red (PSN) markers, not blue qualifier-line ones,
// where the coarse location makes a precise type icon misleading.
const obstacleIconCache = new Map();
function obstacleMarkerIcon(type) {
	let icon = obstacleIconCache.get(type);
	if (!icon) {
		const svg = obstacleMarkerSvg(type, '#cb2026');
		icon = L.icon({
			...markerIconOptions,
			iconUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
		});
		obstacleIconCache.set(type, icon);
	}
	return icon;
}

// Return the most frequent element of an array, falling back to the first
// on ties. Used to pick a representative obstacle type for a group of
// NOTAMs at the same location.
function mode(arr) {
	const counts = new Map();
	for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
	let best = arr[0];
	let bestCount = 0;
	for (const [v, c] of counts) {
		if (c > bestCount) { best = v; bestCount = c; }
	}
	return best;
}

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
	const wasPopulated = airportsPopulated;
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
	// Re-render now that airport coords are available — NOTAMs anchored
	// via "RDL <bearing>/<distance> ARP <ICAO>" can now resolve positions.
	if (!wasPopulated && document.getElementById('notamInput').value.trim()) {
		parseAndDisplay();
	}
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
