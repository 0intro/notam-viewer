// Initialize the map centered on France
const map = L.map('map').setView([48.8566, 2.3522], 6);

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

L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);

// Red marker icon for qualifier line coordinates
const redIcon = L.icon({
	iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
	shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
	iconSize: [25, 41],
	iconAnchor: [12, 41],
	popupAnchor: [1, -34],
	shadowSize: [41, 41]
});

// Default blue marker icon
const blueIcon = L.icon({
	iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
	shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
	iconSize: [25, 41],
	iconAnchor: [12, 41],
	popupAnchor: [1, -34],
	shadowSize: [41, 41]
});

let markers = [];
let radiusCircle = null; // Current radius circle on map
let polygons = []; // Polygons for area NOTAMs

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
// B)/C) format: 2026-02-24 00:00
// DU/AU format: DU: 29 12 2025 16:06 AU: 30 06 2026 23:59 EST
function parseNotamDates(sections, content) {
	let start = null;
	let end = null;
	let permanent = false;
	let estimated = false;

	// Try B) and C) sections first (ICAO format: YYYY-MM-DD HH:MM)
	if (sections.B) {
		const m = sections.B.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
		if (m) {
			start = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]));
		}
	}
	if (sections.C) {
		if (/\bPERM\b/i.test(sections.C)) {
			permanent = true;
		} else {
			const cStr = sections.C.replace(/\s*\bEST\b/i, '');
			if (cStr !== sections.C) estimated = true;
			const m = cStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
			if (m) {
				end = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]));
			}
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
	coordStr = coordStr.trim();

	// Try to match format with space first: "484024N 0030441E"
	// Then try format without space: "161514N0611540W"
	// Latitude: 6-7 digits + N/S (7th digit = tenths of seconds)
	// Longitude: 7-8 digits + E/W (8th digit = tenths of seconds)

	let match = coordStr.match(/(\d{6,7}(?:\.\d+)?)\s*([NS])?\s+(\d{7,8}(?:\.\d+)?)\s*([EW])?/i);

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

	// Handle 7-digit longitudes (ambiguous between DDDMMSS and DDMMSSs)
	if (lonStr.length === 7 && !lonStr.includes('.')) {
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

	let lat = parseDMSComponent(latStr, 2);
	let lon = parseDMSComponent(lonStr, 3);

	if (latDir === 'S') lat = -lat;
	if (lonDir === 'W') lon = -lon;

	return { lat, lon };
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
const areaKeywordsPattern = new RegExp('\\b(' + lateralLimitsTranslations.join('|') + '|AREA|WI\\s+COORD)\\b', 'i');
const areaExclusionPattern = /\bRESTRICTED\s+IN\s+AREA\b/i;

// Extract radius info from text surrounding a coordinate match in the E) section
function extractRadiusFromText(eContent, matchStart, matchEnd) {
	// Look after the coordinate: "RADIUS <num><unit>"
	const afterText = eContent.substring(matchEnd, matchEnd + 50);
	const afterMatch = afterText.match(/^\s+RADIUS\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\b/i);
	if (afterMatch) {
		return {
			radius: parseFloat(afterMatch[1].replace(',', '.')),
			radiusUnit: afterMatch[2].toUpperCase()
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

	return null;
}

// Convert radius to nautical miles
function radiusToNM(radius, unit) {
	if (unit === 'KM') return radius / 1.852;
	if (unit === 'M') return radius / 1852;
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
		const eContent = sections.E || null;

		const coordinateGroups = [];

		if (eContent) {
			// Check for position or area keywords
			const hasPsnKeyword = /\bPSN\b/i.test(eContent);
			const hasCentreKeyword = /\bCENTR(?:ED?|ER(?:ED)?)\b/i.test(eContent);
			const hasObstKeyword = /\bOBST\b/i.test(eContent);
			const hasObstQCode = sections.Q && /\/\s*QOB/.test(sections.Q);
			const hasAreaKeywords = areaKeywordsPattern.test(eContent) && !areaExclusionPattern.test(eContent);

			// Only extract coordinates if PSN, CENTRE/CENTER, OBST, obstruction Q-code, or area keywords are present
			if (hasPsnKeyword || hasCentreKeyword || hasObstKeyword || hasObstQCode || hasAreaKeywords) {
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

				// Find all coordinate-like patterns in the E) section
				// Matches patterns like: 422726N 0064355W, 4227N 00643W or 455554.997N 0060439.322E
				const coordPattern = /(\d{4,7}(?:\.\d+)?)([NS])\s+(\d{5,8}(?:\.\d+)?)([EW])|(\d{6})([NS])(\d{7})([EW])/gi;
				let match;
				let groupClosed = false;
				// Coarse positions (~111m) from closed groups, used to skip
				// approximate duplicates (e.g. high-precision vs standard coords)
				const closedGroupPositions = new Set();

				while ((match = coordPattern.exec(eContent)) !== null) {
					const coordStr = match[1]
						? match[1] + match[2] + ' ' + match[3] + match[4]
						: match[5] + match[6] + ' ' + match[7] + match[8];
					const coords = parseDMSCoordinate(coordStr);
					if (!coords) continue;

					// A standalone PSN has the keyword nearby but is not
					// dash-connected to the next coordinate (polygon series)
					const before = eContent.substring(Math.max(0, match.index - 10), match.index);
					const after = eContent.substring(match.index + match[0].length);
					const isStandalonePsn = /\bPSN\b/i.test(before) &&
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
					const coarsePosKey = `${coords.lat.toFixed(3)}_${coords.lon.toFixed(3)}`;

					// Skip coordinates that approximately match a closed group
					if (closedGroupPositions.has(coarsePosKey)) {
						continue;
					}

					if (seenPositions.has(posKey)) {
						// Duplicate coordinate signals polygon closure
						if (!groupClosed && coordinates.length > 0) {
							coordinateGroups.push([...coordinates]);
							for (const coord of coordinates) {
								closedGroupPositions.add(`${coord.lat.toFixed(3)}_${coord.lon.toFixed(3)}`);
							}
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
						coordinates.push(coord);
					}
				}
			}
		}

		// Collect remaining coordinates as the last group
		if (coordinates.length > 0) {
			coordinateGroups.push(coordinates);
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
				const hasDashConnectedCoords = /\d{4,7}[NS]\s+\d{5,8}[EW]\s*[-]\s*\d{4,7}[NS]\s+\d{5,8}[EW]/i.test(eContent);

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

			const finalCoords = isPolygon && isSelfIntersecting(groupCoords)
				? makeSimplePolygon(groupCoords) : groupCoords;
			if (isPolygon) {
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

// Clear existing markers, polygons and radius circle
function clearMarkers() {
	markers.forEach(marker => map.removeLayer(marker));
	markers = [];
	polygons.forEach(polygon => map.removeLayer(polygon));
	polygons = [];
	if (radiusCircle) {
		map.removeLayer(radiusCircle);
		radiusCircle = null;
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

// Show radius circle for a location (radius in NM)
function showRadiusCircle(lat, lon, radiusNM, color) {
	if (radiusCircle) {
		map.removeLayer(radiusCircle);
	}
	// Convert NM to meters (1 NM = 1852 m)
	const radiusMeters = radiusNM * 1852;
	const circleColor = color || '#0078d4';
	radiusCircle = L.circle([lat, lon], {
		radius: radiusMeters,
		color: circleColor,
		fillColor: circleColor,
		fillOpacity: 0.15,
		weight: 2,
		renderer: canvasRenderer
	}).addTo(map);
}

// Hide radius circle
function hideRadiusCircle() {
	if (radiusCircle) {
		map.removeLayer(radiusCircle);
		radiusCircle = null;
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
		if (group.radius) {
			const nm = radiusToNM(group.radius, group.radiusUnit || 'NM');
			const color = group.hasQualifierLine ? '#0078d4' : '#ff7800';
			showRadiusCircle(group.lat, group.lon, nm, color);
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

			polygon.bindPopup(buildPolygonPopupHtml(notam, navInfo), { maxWidth: 600, maxHeight: 500 });
			setupPolygonEvents(polygon, navInfo, polygonMap, centroidKey);

			polygons.push(polygon);
			polygonMap.set(`${centroidKey}_${i}`, polygon);
			notam.coordinates.forEach(c => bounds.push([c.lat, c.lon]));

			const li = document.createElement('li');
			li.innerHTML = buildPolygonListItemHtml(notam, posIndex);
			li.querySelector('.notam-header').onclick = () => {
				map.fitBounds(polygon.getBounds(), { padding: [50, 50] });
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

		marker.bindPopup(buildPopupHtml(group, navInfo), { maxWidth: 600, maxHeight: 500 });
		setupMarkerEvents(marker, group, navInfo, markerMap);

		markers.push(marker);
		bounds.push([group.lat, group.lon]);
		markerMap.set(key, marker);

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
		map.fitBounds(bounds, { padding: [50, 50] });
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
		console.log('Could not load example file:', error);
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

// Clear all content
function clearAll() {
	document.getElementById('notamInput').value = '';
	document.getElementById('coordinatesList').innerHTML = '<li class="no-results">No NOTAM parsed yet. Enter NOTAMs and click "Display on map".</li>';
	clearMarkers();
	map.setView([48.8566, 2.3522], 6);
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

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
	document.getElementById('parseBtn').addEventListener('click', parseAndDisplay);
	document.getElementById('printBtn').addEventListener('click', printMapToPdf);
	document.getElementById('fullscreenBtn').addEventListener('click', toggleFullscreen);
	document.getElementById('fileInput').addEventListener('change', handleFileUpload);
	document.getElementById('clearBtn').addEventListener('click', clearAll);

	const urlParam = new URLSearchParams(window.location.search).get('file');
	if (urlParam) {
		loadNotamsFromUrl(urlParam);
	} else {
		loadExampleNotams();
	}
});
