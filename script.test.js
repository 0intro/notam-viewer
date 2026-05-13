import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';

// Load script.js in a vm context with mocked browser globals
const mockLayer = {
	addTo() { return this; },
	on() { return this; },
	bindPopup() { return this; },
	setView() { return this; },
	addLayer() { return this; },
	addLayers() { return this; },
	removeLayer() { return this; },
	getLayers() { return []; },
	remove() { return this; },
	addOverlay() { return this; },
	openPopup() { return this; },
	createPane() {},
	getPane() { return { style: {} }; },
	hasLayer() { return false; },
	getZoom() { return 6; },
};

class MockControl {
	addTo() { return this; }
	remove() { return this; }
}

const context = createContext({
	L: {
		map() { return mockLayer; },
		tileLayer() { return { ...mockLayer }; },
		TileLayer: {
			extend() { return function() { return { ...mockLayer }; }; }
		},
		control: { layers() { return { ...mockLayer }; } },
		icon() { return {}; },
		canvas() { return {}; },
		markerClusterGroup() { return { ...mockLayer }; },
		circleMarker() { return { ...mockLayer }; },
		layerGroup() { return { ...mockLayer }; },
		Control: Object.assign(MockControl, {
			extend(proto) {
				class Extended extends MockControl {
					constructor(opts) {
						super();
						this.options = opts;
						Object.assign(this, proto);
					}
				}
				return Extended;
			}
		}),
		DomUtil: { create() { return { textContent: '' }; } },
		Browser: { touch: false },
	},
	document: {
		addEventListener() {},
		getElementById() {
			return { value: '', checked: false, addEventListener() {} };
		},
	},
	console,
	setTimeout(fn) { fn(); },
	fetch() { return Promise.resolve({ ok: false }); },
	window: {
		addEventListener() {},
		visualViewport: { addEventListener() {} },
		location: { search: "" },
	},
});

const code = readFileSync(new URL('./script.js', import.meta.url), 'utf-8');
new Script(code).runInContext(context);

const { parseNotams, parseDMSCoordinate, parseQualifierLine,
	parseNotamDates, parseSections, computePolygonArea,
	extractRadiusFromText, radiusToNM,
	buildAirportPopupHtml, airportStyleForType, escapeHtml, prettyAirportType,
	airportTypeIcon, buildRunwaysHtml, formatSurface } = context;

function findNotam(notams, id) {
	return notams.find(n => n.id === id);
}

function assertNear(actual, expected, msg) {
	assert.ok(
		Math.abs(actual - expected) < 0.01,
		`${msg}: expected ~${expected}, got ${actual}`
	);
}

const positionsText = readFileSync(new URL('./testdata/positions', import.meta.url), 'utf-8');
const areasText = readFileSync(new URL('./testdata/areas', import.meta.url), 'utf-8');

// Unit tests for qualifier line parser

describe('parseQualifierLine', () => {
	it('should parse all fields with radius', () => {
		const q = parseQualifierLine('LFFF / QWULW / IV / BO / W / 000/014 / 4840N00305E005');
		assert.equal(q.fir, 'LFFF');
		assert.equal(q.code, 'QWULW');
		assert.equal(q.traffic, 'IV');
		assert.equal(q.purpose, 'BO');
		assert.equal(q.scope, 'W');
		assert.equal(q.lower, 0);
		assert.equal(q.upper, 14);
		assertNear(q.lat, 48.6667, 'lat');
		assertNear(q.lon, 3.0833, 'lon');
		assert.equal(q.radius, 5);
	});

	it('should parse coordinate without radius', () => {
		const q = parseQualifierLine('LFFF / QOBCE / IV / M / E / 000/011 / 4839N00359E');
		assert.equal(q.fir, 'LFFF');
		assert.equal(q.scope, 'E');
		assertNear(q.lat, 48.65, 'lat');
		assertNear(q.lon, 3.9833, 'lon');
		assert.equal(q.radius, null);
	});

	it('should parse western longitude', () => {
		const q = parseQualifierLine('TTZP / QOBCE / IV / M / AE / 000/002 / 1615N06116W001');
		assert.equal(q.fir, 'TTZP');
		assert.equal(q.scope, 'AE');
		assert.equal(q.lower, 0);
		assert.equal(q.upper, 2);
		assertNear(q.lat, 16.25, 'lat');
		assertNear(q.lon, -61.2667, 'lon');
		assert.equal(q.radius, 1);
	});
});

// Unit tests for NOTAM date parser

describe('parseNotamDates', () => {
	it('should parse ICAO B/C dates', () => {
		const content = 'Q) LFFF / QRTCA / IV / BO / W / 000/195 / 4940N00135W007\nA) LFRC\nB) 2026-02-24 00:00 C) 2026-03-11 23:59\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		assert.equal(d.start.getTime(), Date.UTC(2026, 1, 24, 0, 0));
		assert.equal(d.end.getTime(), Date.UTC(2026, 2, 11, 23, 59));
		assert.equal(d.permanent, false);
		assert.equal(d.estimated, false);
	});

	it('should parse legacy YYMMDDHHMM B/C dates', () => {
		const content = 'Q) LTAA/QWMLW/IV/BO/W/000/080/3750N03038E002\nA) LTAA B) 2605110500 C) 2605201500\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		assert.equal(d.start.getTime(), Date.UTC(2026, 4, 11, 5, 0));
		assert.equal(d.end.getTime(), Date.UTC(2026, 4, 20, 15, 0));
		assert.equal(d.permanent, false);
		assert.equal(d.estimated, false);
	});

	it('should parse SOFIA DU/AU dates', () => {
		const content = 'DU: 20 01 2025 07:32 AU: 30 04 2026 19:02\nA) LFFF\nQ) LFFF / QWULW / IV / BO / W / 000/014 / 4840N00305E005\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		assert.equal(d.start.getTime(), Date.UTC(2025, 0, 20, 7, 32));
		assert.equal(d.end.getTime(), Date.UTC(2026, 3, 30, 19, 2));
		assert.equal(d.permanent, false);
		assert.equal(d.estimated, false);
	});

	it('should parse SOFIA AU: PERM', () => {
		const content = 'DU: 23 10 2025 11:46 AU: PERM\nA) LFFF\nQ) LFFF / QOBCE / IV / M / E / 000/011 / 4839N00359E001\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		assert.equal(d.start.getTime(), Date.UTC(2025, 9, 23, 11, 46));
		assert.equal(d.end, null);
		assert.equal(d.permanent, true);
	});

	it('should parse SOFIA AU with EST suffix', () => {
		const content = 'DU: 29 12 2025 16:06 AU: 30 06 2026 23:59 EST\nA) LPPT\nQ) LPPC / QFAHW / IV / BO / A / 000/999 / 3846N00908W005\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		assert.equal(d.start.getTime(), Date.UTC(2025, 11, 29, 16, 6));
		assert.equal(d.end.getTime(), Date.UTC(2026, 5, 30, 23, 59));
		assert.equal(d.estimated, true);
	});
});

// Unit tests for PSN coordinate parser

describe('parseDMSCoordinate', () => {
	it('should parse standard coordinates with space', () => {
		const c = parseDMSCoordinate('484024N 0030441E');
		assertNear(c.lat, 48.6733, 'lat');
		assertNear(c.lon, 3.0781, 'lon');
	});

	it('should parse coordinates without space', () => {
		const c = parseDMSCoordinate('161514N0611540W');
		assertNear(c.lat, 16.2539, 'lat');
		assertNear(c.lon, -61.2611, 'lon');
	});

	it('should parse 7-digit latitude (implicit decimal seconds)', () => {
		const c = parseDMSCoordinate('4908325N 0004328W');
		assertNear(c.lat, 49.1424, 'lat');
		assertNear(c.lon, -0.7244, 'lon');
	});

	it('should parse 7-digit longitude missing leading zero', () => {
		const c = parseDMSCoordinate('4638487N 1420211E');
		assertNear(c.lat, 46.6469, 'lat');
		assertNear(c.lon, 14.3392, 'lon');
	});

	it('should parse 7-digit longitude as DDDMMSS with 6-digit latitude', () => {
		const c = parseDMSCoordinate('504940N 1211510W');
		assertNear(c.lat, 50.8278, 'lat');
		assertNear(c.lon, -121.2528, 'lon');
	});

	it('should parse decimal seconds', () => {
		const c = parseDMSCoordinate('483923.17N 0035848.18E');
		assertNear(c.lat, 48.6564, 'lat');
		assertNear(c.lon, 3.9800, 'lon');
	});
});

describe('computePolygonArea', () => {
	it('should compute area of a unit square', () => {
		const coords = [
			{ lat: 0, lon: 0 },
			{ lat: 1, lon: 0 },
			{ lat: 1, lon: 1 },
			{ lat: 0, lon: 1 },
		];
		assertNear(computePolygonArea(coords), 1.0, 'area');
	});

	it('should return larger area for larger polygon', () => {
		const small = [
			{ lat: 0, lon: 0 }, { lat: 0.1, lon: 0 },
			{ lat: 0.1, lon: 0.1 }, { lat: 0, lon: 0.1 },
		];
		const large = [
			{ lat: 0, lon: 0 }, { lat: 1, lon: 0 },
			{ lat: 1, lon: 1 }, { lat: 0, lon: 1 },
		];
		assert.ok(computePolygonArea(large) > computePolygonArea(small));
	});
});

// Unit tests for radius extraction

describe('extractRadiusFromText', () => {
	it('should extract RADIUS after coordinates', () => {
		const text = 'PSN 514600N 0052622E RADIUS 1NM BTN GND/500FT';
		// "514600N 0052622E" starts at 4, length 16
		const r = extractRadiusFromText(text, 4, 20);
		assert.equal(r.radius, 1);
		assert.equal(r.radiusUnit, 'NM');
	});

	it('should extract decimal RADIUS after coordinates', () => {
		const text = 'PSN 513613N 0055239E RADIUS 1.5NM BTN GND';
		const r = extractRadiusFromText(text, 4, 20);
		assert.equal(r.radius, 1.5);
		assert.equal(r.radiusUnit, 'NM');
	});

	it('should extract RADIUS with comma decimal (KM) before coordinates', () => {
		const text = 'CIRCLE RADIUS 5,6KM CENTRED ON 482406N 0170711E';
		// "482406N 0170711E" starts at 31, length 16
		const r = extractRadiusFromText(text, 31, 47);
		assert.equal(r.radius, 5.6);
		assert.equal(r.radiusUnit, 'KM');
	});

	it('should extract M RADIUS OF before coordinates', () => {
		const text = 'UNMANNED ACFT VEHICLE FLYING WI 1000M RADIUS OF 414056N 0044930W';
		// "414056N 0044930W" starts at 49, length 16
		const r = extractRadiusFromText(text, 49, 65);
		assert.equal(r.radius, 1000);
		assert.equal(r.radiusUnit, 'M');
	});

	it('should return null when no radius present', () => {
		const text = 'PSN 484024N 0030441E RDL 031/5.4NM ARP LFAI';
		const r = extractRadiusFromText(text, 4, 20);
		assert.equal(r, null);
	});

	it('should extract French DE RAYON before coordinates', () => {
		const text = 'CERCLE DE 1NM DE RAYON CENTRE SUR PSN 482807N 0023803E';
		// "482807N 0023803E" starts at 38, length 16
		const r = extractRadiusFromText(text, 38, 54);
		assert.equal(r.radius, 1);
		assert.equal(r.radiusUnit, 'NM');
	});

	it('should extract French decimal DE RAYON before coordinates', () => {
		const text = 'CERCLE DE 0.2NM DE RAYON CENTRE SUR PSN : 434524N 0065513E';
		// "434524N 0065513E" starts at 42, length 16
		const r = extractRadiusFromText(text, 42, 58);
		assert.equal(r.radius, 0.2);
		assert.equal(r.radiusUnit, 'NM');
	});

	it('should extract French RAYON : after coordinates', () => {
		const text = 'PSN : 461043N 0064212E\nRAYON : 5NM\nRDL091/18NM LFLI';
		// "461043N 0064212E" starts at 6, length 16
		const r = extractRadiusFromText(text, 6, 22);
		assert.equal(r.radius, 5);
		assert.equal(r.radiusUnit, 'NM');
	});

	it('should extract French DANS UN RAYON DE after coordinates', () => {
		const text = 'PSN : 461620N 0065012E DANS UN RAYON DE 5NM\nRDL046/18NM';
		// "461620N 0065012E" starts at 6, length 16
		const r = extractRadiusFromText(text, 6, 22);
		assert.equal(r.radius, 5);
		assert.equal(r.radiusUnit, 'NM');
	});

	it('should not match RAYON without a separator (e.g. RAYON LASER)', () => {
		const text = 'EMISSION RAYON LASER 3M PSN 482807N 0023803E';
		// "482807N 0023803E" starts at 28, length 16
		const r = extractRadiusFromText(text, 28, 44);
		assert.equal(r, null);
	});
});

describe('radiusToNM', () => {
	it('should return NM as-is', () => {
		assert.equal(radiusToNM(5, 'NM'), 5);
	});

	it('should convert KM to NM', () => {
		assertNear(radiusToNM(1.852, 'KM'), 1.0, 'km');
	});

	it('should convert M to NM', () => {
		assertNear(radiusToNM(1852, 'M'), 1.0, 'm');
	});
});

// Integration tests: positions

describe('parseNotams - positions', () => {
	const notams = parseNotams(positionsText);

	it('should parse all position NOTAMs', () => {
		assert.equal(notams.length, 29);
	});

	it('should not mark any position NOTAM as polygon', () => {
		for (const n of notams) {
			assert.equal(n.isPolygon, false, `${n.id} should not be polygon`);
		}
	});

	it('should parse usual PSN coordinate (LFFA-W2942/24)', () => {
		const n = findNotam(notams, 'LFFA-W2942/24');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 48.6733, 'lat');
		assertNear(n.coordinates[0].lon, 3.0781, 'lon');
	});

	it('should parse decimal seconds PSN coordinates (LFFA-P3613/25)', () => {
		const n = findNotam(notams, 'LFFA-P3613/25');
		assert.ok(n);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 48.6564, 'lat');
		assertNear(n.coordinates[0].lon, 3.9800, 'lon');
	});

	it('should parse implicit decimal seconds (LFFA-P4021/25)', () => {
		const n = findNotam(notams, 'LFFA-P4021/25');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 49.1424, 'lat');
		assertNear(n.coordinates[0].lon, -0.7244, 'lon');
	});

	it('should parse spaceless PSN coordinate (TTPP-A1652/25)', () => {
		const n = findNotam(notams, 'TTPP-A1652/25');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 16.2539, 'lat');
		assertNear(n.coordinates[0].lon, -61.2611, 'lon');
	});

	it('should parse extra leading zero longitude (LEAN-R0341/26)', () => {
		const n = findNotam(notams, 'LEAN-R0341/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 28.4722, 'lat');
		assertNear(n.coordinates[0].lon, -16.2467, 'lon');
	});

	it('should parse missing leading zero longitude (LOWW-A0089/26)', () => {
		const n = findNotam(notams, 'LOWW-A0089/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 46.6469, 'lat');
		assertNear(n.coordinates[0].lon, 14.3392, 'lon');
	});

	it('should parse circle centres as separate entries (LZIB-A2755/25)', () => {
		const entries = notams.filter(n => n.id === 'LZIB-A2755/25');
		assert.equal(entries.length, 3);
		for (const n of entries) {
			assert.equal(n.isPolygon, false);
			assert.equal(n.coordinates.length, 1);
			assert.equal(n.coordinates[0].type, 'psn');
		}
		assertNear(entries[0].coordinates[0].lat, 48.4017, 'lat 1');
		assertNear(entries[0].coordinates[0].lon, 17.1197, 'lon 1');
		assertNear(entries[1].coordinates[0].lat, 48.6372, 'lat 2');
		assertNear(entries[1].coordinates[0].lon, 19.1342, 'lon 2');
		assertNear(entries[2].coordinates[0].lat, 49.0278, 'lat 3');
		assertNear(entries[2].coordinates[0].lon, 21.3031, 'lon 3');
	});

	it('should extract radius for circle centres (LZIB-A2755/25)', () => {
		const entries = notams.filter(n => n.id === 'LZIB-A2755/25');
		assert.equal(entries.length, 3);
		for (const n of entries) {
			assert.equal(n.coordinates[0].radius, 5.6, 'radius');
			assert.equal(n.coordinates[0].radiusUnit, 'KM', 'unit');
		}
	});

	it('should parse PSN with RADIUS in NM after coordinates (EHAA-A0456/26)', () => {
		const n = findNotam(notams, 'EHAA-A0456/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 51.7667, 'lat');
		assertNear(n.coordinates[0].lon, 5.4394, 'lon');
		assert.equal(n.coordinates[0].radius, 1);
		assert.equal(n.coordinates[0].radiusUnit, 'NM');
	});

	it('should parse M RADIUS OF PSN before coordinates (LEAN-R0300/26)', () => {
		const n = findNotam(notams, 'LEAN-R0300/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 40.8864, 'lat');
		assertNear(n.coordinates[0].lon, 16.035, 'lon');
		assert.equal(n.coordinates[0].radius, 500);
		assert.equal(n.coordinates[0].radiusUnit, 'M');
	});

	it('should anchor RDL <bearing>/<distance> ARP <ICAO> to airport coord', () => {
		const sample = 'R0000/26\nQ) LFRR/QOLAS/IV/M/AE/000/004/4715N00135W003\n' +
			'A) LFRS B) 2601010000 C) PERM\nE) BALISAGE D\'EOLIENNES HORS SERVICE\n' +
			'RDL 252/13NM ARP LFRS\nHAUTEUR : 400FT\n\n';
		const lookupAirport = (ident) => ident === 'LFRS' ? { lat: 47.1531, lon: -1.6107 } : null;
		const without = parseNotams(sample);
		assert.equal(without[0].coordinates[0].type, 'qualifierLine');
		const with_ = parseNotams(sample, { lookupAirport });
		assert.equal(with_[0].coordinates[0].type, 'psn');
		// 13 NM at bearing 252° from (47.1531, -1.6107)
		assertNear(with_[0].coordinates[0].lat, 47.086, 'anchored lat');
		assertNear(with_[0].coordinates[0].lon, -1.913, 'anchored lon');
	});

	it('should parse PSN with space between digits and hemisphere (P1484/26)', () => {
		const n = findNotam(notams, 'P1484/26');
		assert.ok(n);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 44.1686, 'lat');
		assertNear(n.coordinates[0].lon, 4.8642, 'lon');
	});

	it('should parse PSN with no separator and decimal seconds (P0436/26)', () => {
		const n = findNotam(notams, 'P0436/26');
		assert.ok(n);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 44.5992, 'lat');
		assertNear(n.coordinates[0].lon, 3.867, 'lon');
	});

	it('should parse French comma-as-decimal-separator (P1217/26)', () => {
		const n = findNotam(notams, 'P1217/26');
		assert.ok(n);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 48.6546, 'lat');
		assertNear(n.coordinates[0].lon, 5.4839, 'lon');
	});

	it('should parse helipad FATO with dash lat/lon and DIAMETRE keyword (H0141/26)', () => {
		const n = findNotam(notams, 'H0141/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 45.4311, 'lat');
		assertNear(n.coordinates[0].lon, 6.9933, 'lon');
		// 15M diameter → 7.5M radius
		assert.equal(n.coordinates[0].radius, 7.5);
		assert.equal(n.coordinates[0].radiusUnit, 'M');
	});

	it('should parse bare "DANS RAYON X<unit>" before coord (P1757/26)', () => {
		const n = findNotam(notams, 'P1757/26');
		assert.ok(n);
		assert.equal(n.coordinates[0].type, 'psn');
		assert.equal(n.coordinates[0].radius, 50);
		assert.equal(n.coordinates[0].radiusUnit, 'M');
	});

	it('should parse bare "RAYON X<unit>" after coord (W0470/26)', () => {
		const n = findNotam(notams, 'W0470/26');
		assert.ok(n);
		assert.equal(n.coordinates[0].type, 'psn');
		assert.equal(n.coordinates[0].radius, 2000);
		assert.equal(n.coordinates[0].radiusUnit, 'M');
	});

	it('should parse CENTREE keyword + RAYON D\'EVOLUTION DE elision (W0004/26)', () => {
		const n = findNotam(notams, 'W0004/26');
		assert.ok(n);
		assert.equal(n.isPolygon, false);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 45.5139, 'lat');
		assertNear(n.coordinates[0].lon, 3.2669, 'lon');
		assert.equal(n.coordinates[0].radius, 500);
		assert.equal(n.coordinates[0].radiusUnit, 'M');
	});

	it('should parse preamble "DANS UN RAYON DE X AUTOUR DU PSN" (P0389/26)', () => {
		const n = findNotam(notams, 'P0389/26');
		assert.ok(n);
		assert.equal(n.isPolygon, false);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 43.6506, 'lat');
		assertNear(n.coordinates[0].lon, 1.35, 'lon');
		assert.equal(n.coordinates[0].radius, 96);
		assert.equal(n.coordinates[0].radiusUnit, 'M');
	});

	it('should parse bullet-list "- RAYON: X" on line below coord (P0994/26)', () => {
		const n = findNotam(notams, 'P0994/26');
		assert.ok(n);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 47.4228, 'lat');
		assertNear(n.coordinates[0].lon, -1.184, 'lon');
		assert.equal(n.coordinates[0].radius, 5);
		assert.equal(n.coordinates[0].radiusUnit, 'KM');
	});

	it('should parse French DANS UN RAYON DE after PSN (LFFA-W2279/25)', () => {
		const n = findNotam(notams, 'LFFA-W2279/25');
		assert.ok(n);
		assert.equal(n.isPolygon, false);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 46.2722, 'lat');
		assertNear(n.coordinates[0].lon, 6.8367, 'lon');
		assert.equal(n.coordinates[0].radius, 5);
		assert.equal(n.coordinates[0].radiusUnit, 'NM');
	});

	it('should parse French CERCLE DE X DE RAYON CENTRE SUR PSN (LFFA-R1463/26)', () => {
		const n = findNotam(notams, 'LFFA-R1463/26');
		assert.ok(n);
		assert.equal(n.isPolygon, false);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 48.4686, 'lat');
		assertNear(n.coordinates[0].lon, 2.6342, 'lon');
		assert.equal(n.coordinates[0].radius, 1);
		assert.equal(n.coordinates[0].radiusUnit, 'NM');
	});

	it('should parse high-precision decimal seconds (LFFA-P4304/25)', () => {
		const n = findNotam(notams, 'LFFA-P4304/25');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 45.9319, 'lat');
		assertNear(n.coordinates[0].lon, 6.0776, 'lon');
	});

	it('should parse 6-digit longitude with decimal seconds (LFFA-P0257/26)', () => {
		const n = findNotam(notams, 'LFFA-P0257/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 48.1076, 'lat');
		assertNear(n.coordinates[0].lon, 7.3538, 'lon');
	});

	it('should parse 6-digit longitude with PSN COORD (WGS-84) (LIIC-M6131/25)', () => {
		const n = findNotam(notams, 'LIIC-M6131/25');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 44.6647, 'lat');
		assertNear(n.coordinates[0].lon, 9.1283, 'lon');
	});

	it('should parse standard PSN after descriptive text (LFFA-C4783/25)', () => {
		const n = findNotam(notams, 'LFFA-C4783/25');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 45.9531, 'lat');
		assertNear(n.coordinates[0].lon, 6.1261, 'lon');
	});

	it('should parse WITH <num><unit> RADIUS after COORD (LRBB-C1981/26)', () => {
		const n = findNotam(notams, 'LRBB-C1981/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 46.5025, 'lat');
		assertNear(n.coordinates[0].lon, 23.8861, 'lon');
		assert.equal(n.coordinates[0].radius, 6);
		assert.equal(n.coordinates[0].radiusUnit, 'NM');
	});

	it('should parse multiple NOTAMs at same position (LEAN-R0225/26, LEAN-R0226/26)', () => {
		const n1 = findNotam(notams, 'LEAN-R0225/26');
		const n2 = findNotam(notams, 'LEAN-R0226/26');
		assert.ok(n1);
		assert.ok(n2);
		assert.equal(n1.coordinates[0].type, 'qualifierLine');
		assert.equal(n2.coordinates[0].type, 'qualifierLine');
		assertNear(n1.coordinates[0].lat, 41.6667, 'lat');
		assertNear(n1.coordinates[0].lon, -4.8167, 'lon');
		assertNear(n1.coordinates[0].lat, n2.coordinates[0].lat, 'same lat');
		assertNear(n1.coordinates[0].lon, n2.coordinates[0].lon, 'same lon');
	});
});

// Integration tests: areas

describe('parseNotams - areas', () => {
	const notams = parseNotams(areasText);

	it('should parse all area NOTAMs', () => {
		assert.equal(notams.length, 32);
	});

	it('should mark area NOTAMs as polygons', () => {
		const polygons = notams.filter(n => n.isPolygon);
		assert.equal(polygons.length, 23);
	});

	it('should parse LIMITES LATERALES keyword (LFFA-R2339/25)', () => {
		const n = findNotam(notams, 'LFFA-R2339/25');
		assert.ok(n);
		assert.equal(n.coordinates.length, 4);
		assertNear(n.coordinates[0].lat, 50.0, 'lat');
		assertNear(n.coordinates[0].lon, -1.1183, 'lon');
	});

	it('should parse LATERAL LIMITS keyword (LFFA-R0311/26)', () => {
		const n = findNotam(notams, 'LFFA-R0311/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 4);
		assertNear(n.coordinates[0].lat, 49.6333, 'lat');
		assertNear(n.coordinates[0].lon, -1.4667, 'lon');
	});

	it('should parse AREA keyword with dash-separated coords (LPPP-A6116/25)', () => {
		const n = findNotam(notams, 'LPPP-A6116/25');
		assert.ok(n);
		assert.equal(n.coordinates.length, 6);
		assertNear(n.coordinates[0].lat, 40.5311, 'lat');
		assertNear(n.coordinates[0].lon, -7.4997, 'lon');
	});

	it('should parse WI COORD keyword (LEAN-D0164/26)', () => {
		const n = findNotam(notams, 'LEAN-D0164/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 15);
		assertNear(n.coordinates[0].lat, 40.7783, 'lat');
		assertNear(n.coordinates[0].lon, -1.9417, 'lon');
	});

	it('should detect closed polygon (LGGG-A0134/26)', () => {
		const n = findNotam(notams, 'LGGG-A0134/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 4);
		assertNear(n.coordinates[0].lat, 38.8333, 'lat');
		assertNear(n.coordinates[0].lon, 19.25, 'lon');
	});

	it('should detect closing coordinate in parentheses (ENGM-A0737/26)', () => {
		const n = findNotam(notams, 'ENGM-A0737/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 7);
		assertNear(n.coordinates[0].lat, 73.0, 'lat');
		assertNear(n.coordinates[0].lon, 24.0, 'lon');
	});

	it('should parse overlapping areas (LEAN-R0263/26 smaller, LEAN-R0079/26 larger)', () => {
		const small = findNotam(notams, 'LEAN-R0263/26');
		const large = findNotam(notams, 'LEAN-R0079/26');
		assert.ok(small);
		assert.ok(large);
		assert.equal(small.coordinates.length, 4);
		assert.equal(large.coordinates.length, 4);
		assert.ok(
			computePolygonArea(small.coordinates) < computePolygonArea(large.coordinates),
			'small area should be smaller than large area'
		);
	});

	it('should extract only the polygon, not the straight line (LOWW-A3153/25)', () => {
		const entries = notams.filter(n => n.id === 'LOWW-A3153/25');
		assert.equal(entries.length, 1);
		assert.equal(entries[0].isPolygon, true);
		assert.equal(entries[0].coordinates.length, 10);
		assertNear(entries[0].coordinates[0].lat, 47.8625, 'first lat');
		assertNear(entries[0].coordinates[0].lon, 14.3078, 'first lon');
	});

	it('should split multiple areas into separate entries (ENGM-A0526/26)', () => {
		const entries = notams.filter(n => n.id === 'ENGM-A0526/26');
		assert.equal(entries.length, 2);
		assert.equal(entries[0].isPolygon, true);
		assert.equal(entries[1].isPolygon, true);

		// First area: Arctic danger zone (4 coordinates)
		assert.equal(entries[0].coordinates.length, 4);
		assertNear(entries[0].coordinates[0].lat, 76.3667, 'first area lat');
		assertNear(entries[0].coordinates[0].lon, 21.9167, 'first area lon');

		// Second area: Barents Sea impact area (6 coordinates)
		assert.equal(entries[1].coordinates.length, 6);
		assertNear(entries[1].coordinates[0].lat, 70.9333, 'second area lat');
		assertNear(entries[1].coordinates[0].lon, 32.0833, 'second area lon');
	});

	it('should separate PSN before area keyword from polygon (VABB-A0190/26)', () => {
		const entries = notams.filter(n => n.id === 'VABB-A0190/26');
		// Only the polygon; parenthesized coordinate without PSN is ignored
		assert.equal(entries.length, 1);
		assert.equal(entries[0].isPolygon, true);
		assert.equal(entries[0].coordinates.length, 10);
		assertNear(entries[0].coordinates[0].lat, 23.7519, 'first lat');
		assertNear(entries[0].coordinates[0].lon, 79.7553, 'first lon');
	});

	it('should normalize antimeridian-crossing polygon (KZAK-A0546/26)', () => {
		const n = findNotam(notams, 'KZAK-A0546/26');
		assert.ok(n);
		assert.equal(n.isPolygon, true);
		assert.equal(n.coordinates.length, 10);
		// First coordinate: ~36.73°N, ~163.07°W
		assertNear(n.coordinates[0].lat, 36.7333, 'first lat');
		assertNear(n.coordinates[0].lon, -163.0667, 'first lon');
		// All consecutive longitude differences should be <= 180°
		for (let i = 1; i < n.coordinates.length; i++) {
			const diff = Math.abs(n.coordinates[i].lon - n.coordinates[i - 1].lon);
			assert.ok(diff <= 180,
				`longitude jump between vertex ${i - 1} and ${i} is ${diff}°, expected <= 180°`);
		}
	});

	it('should split polygon and circle centres into separate entries (UUUU-Q1191/26)', () => {
		const entries = notams.filter(n => n.id === 'UUUU-Q1191/26');
		assert.equal(entries.length, 9);

		// First entry: the polygon area
		assert.equal(entries[0].isPolygon, true);
		assert.equal(entries[0].coordinates.length, 14);
		assertNear(entries[0].coordinates[0].lat, 64.55, 'polygon first lat');
		assertNear(entries[0].coordinates[0].lon, 55.0831, 'polygon first lon');

		// Remaining 8 entries: individual circle centres with radius
		for (let i = 1; i < 9; i++) {
			assert.equal(entries[i].isPolygon, false, `entry ${i} should not be polygon`);
			assert.equal(entries[i].coordinates.length, 1, `entry ${i} should have 1 coord`);
			assert.equal(entries[i].coordinates[0].radius, 1, `entry ${i} radius`);
			assert.equal(entries[i].coordinates[0].radiusUnit, 'KM', `entry ${i} unit`);
		}
	});

	it('should rejoin wrapped polygon coords and split into per-PART polygons (F0212/26)', () => {
		const entries = notams.filter(n => n.id === 'F0212/26');
		assert.equal(entries.length, 5);
		for (const e of entries) assert.equal(e.isPolygon, true);
		// First polygon (BORDEAUX R1 PART 2): 16 source coords with first == last
		// → 15 unique vertices. First vertex is 470240N 0001500W.
		assert.equal(entries[0].coordinates.length, 15);
		assertNear(entries[0].coordinates[0].lat, 47.0444, 'first PART lat');
		assertNear(entries[0].coordinates[0].lon, -0.25, 'first PART lon');
		// Last polygon (BREST NS PART 1): 16 vertices with first == last → 15.
		assert.equal(entries[4].coordinates.length, 15);
		assertNear(entries[4].coordinates[0].lat, 48.4622, 'last PART first lat');
	});

	it('should parse dash-connected polygon without an area keyword (R3154/25)', () => {
		const n = findNotam(notams, 'R3154/25');
		assert.ok(n);
		assert.equal(n.isPolygon, true);
		// 34 source coords with first == last; closure pushes the 33 unique.
		assert.equal(n.coordinates.length, 33);
		assertNear(n.coordinates[0].lat, 45.9058, 'first lat');
		assertNear(n.coordinates[0].lon, -1.6636, 'first lon');
	});

	it('should expand ARC HORAIRE arc center into curved sample points (R1129/26)', () => {
		const n = findNotam(notams, 'R1129/26');
		assert.ok(n);
		assert.equal(n.isPolygon, true);
		// Source: v1, arc-center, v3, v4-closing (== v1). Closure drops v4 and
		// the arc center is expanded into k-1 = 15 sample points.
		assert.equal(n.coordinates.length, 2 + 15);
		// First and last source vertices are preserved
		assertNear(n.coordinates[0].lat, 49.1311, 'v1 lat');
		assertNear(n.coordinates[0].lon, 4.3742, 'v1 lon');
		assertNear(n.coordinates[n.coordinates.length - 1].lat, 49.1361, 'v3 lat');
		// Sample points sweep clockwise from v1 to v3 — going south first
		// (atan2 CCW-positive, HORAIRE = decreasing angle), so the first
		// intermediate sample has lower lat than v1.
		assert.ok(n.coordinates[1].lat < n.coordinates[0].lat,
			'first arc sample should be south of v1');
	});

	it('should make simple polygon from self-intersecting coords (EBBR-F0162/26)', () => {
		const n = findNotam(notams, 'EBBR-F0162/26');
		assert.ok(n);
		assert.equal(n.isPolygon, true);
		assert.equal(n.coordinates.length, 4);
		assertNear(n.coordinates[0].lat, 49.9914, 'first lat');
		assertNear(n.coordinates[0].lon, 5.4914, 'first lon');
	});

	it('should ignore parenthesized coordinate without PSN keyword (VABB-A0190/26 variant)', () => {
		const entries = notams.filter(n => n.id === 'VABB-A0191/26');
		assert.equal(entries.length, 2);

		// First entry: standalone PSN (Chhindwara airport)
		assert.equal(entries[0].isPolygon, false);
		assert.equal(entries[0].coordinates.length, 1);
		assertNear(entries[0].coordinates[0].lat, 22.0024, 'psn lat');
		assertNear(entries[0].coordinates[0].lon, 78.9174, 'psn lon');

		// Second entry: polygon area (10 unique vertices)
		assert.equal(entries[1].isPolygon, true);
		assert.equal(entries[1].coordinates.length, 10);
		assertNear(entries[1].coordinates[0].lat, 23.7519, 'first lat');
		assertNear(entries[1].coordinates[0].lon, 79.7553, 'first lon');
	});
});

// Integration tests: statistics

const statisticsTests = [
	{ file: 'Europe-20260203.txt', all: 10896, noPosition: 7168, positions: 2717, areas: 1011 },
	{ file: 'LPPT-EPWA-20260207.txt', all: 983, noPosition: 392, positions: 468, areas: 123 },
	{ file: 'EGPD-LFKC-20260207.txt', all: 676, noPosition: 226, positions: 408, areas: 42 },
	{ file: 'KJFK-KLAX-20260209.txt', all: 449, noPosition: 355, positions: 93, areas: 1 },
	{ file: 'CYQB-CYVR-20260209.txt', all: 366, noPosition: 121, positions: 243, areas: 2 },
	{ file: 'CYTZ-SAWG-20260209.txt', all: 554, noPosition: 367, positions: 166, areas: 21 },
	{ file: 'EGLL-FACT-20260209.txt', all: 761, noPosition: 377, positions: 335, areas: 49 },
	{ file: 'ENGM-YSCB-20260209.txt', all: 520, noPosition: 269, positions: 160, areas: 91 },
	{ file: 'LEMD-UHWW-20260209.txt', all: 1436, noPosition: 593, positions: 662, areas: 181 },
	{ file: 'LSHJ-ZBAA-20260209.txt', all: 1337, noPosition: 472, positions: 755, areas: 110 },
	{ file: 'SBBE-VIDP-20260209.txt', all: 315, noPosition: 257, positions: 33, areas: 25 },
	{ file: 'World-20260207.txt', all: 36725, noPosition: 25472, positions: 7575, areas: 3678 },
	{ file: 'World-20260512.txt', all: 23227, noPosition: 14293, positions: 6441, areas: 2493 },
];

// NOTAMs to be investigated: coordinates far from Q-line due to
// NOTAM data errors, Q-line imprecision, or ambiguous coordinate formats.
const coordinateExclusions = new Set([
	// 6-digit longitude ambiguity (DDMMSS vs truncated DDDMMSS)
	'LGGG-A0292/26',  // 025500E: parsed as 2.9°E, should be 25.8°E
	'LFFA-P4354/25',  // 021600E: parsed as 2.3°E, should be 21.6°E (Réunion)
	'LEAN-A7783/25',  // 035600W: parsed as 3.9°W, should be 35.9°W (Canary Islands)
	// NOTAM coordinate errors (typos in the NOTAM itself)
	'EHAM-A0321/26',  // invalid seconds (070.0), parsed coordinates far off
	'KSLC-A0386/26',  // latitude ~1° off from expected position
	'EPWW-D8111/25',  // extra digit in latitude: 5114050.57N, should be 514050.57N
	'LFFA-P0049/26',  // extra '0' in longitude: 00663101.4E, should be 0063101.4E
	// Q-line data errors (wrong Q-line centre or radius)
	'UUUU-U1184/23',  // Q-line radius too small for route extent
	'OIII-A0289/26',  // Q-line centre wrong, coordinates 241NM away
	'EPWW-D7994/25',  // Q-line centre wrong, coordinates 231NM away
	'EPWW-N7994/25',  // Q-line centre wrong, coordinates 231NM away
	'EHAM-A0324/26',  // Q-line centre wrong, coordinates 56NM away
	'KZLA-A4180/25',  // Q-line centre wrong, coordinates 162NM away
	'LIIC-M0021/25',  // Q-line centre wrong, coordinates 90NM away
	'LIIC-M2022/25',  // Q-line centre wrong, coordinates 134NM away
	'LIIC-M4598/24',  // Q-line centre wrong, coordinates 122NM away
	'LIIC-M4599/24',  // Q-line centre wrong, coordinates 122NM away
	'LIIA-W5239/25',  // Q-line centre wrong, coordinates 119NM away
	'LIIA-W0074/26',  // Q-line centre wrong, coordinates 60NM away
	'VECC-A2279/25',  // Q-line centre ~1° lon off, coordinates 50NM away
	'EDDZ-D0239/26',  // Q-line centre wrong, coordinates 23NM away
	'EDDZ-D0240/26',  // Q-line centre wrong, coordinates 43NM away
	// Arc centre parsed as PSN (parser issue)
	'RJAA-P0490/26',  // arc centre 108NM from Q-centre, Q-radius 61NM
	'RJAA-P0491/26',  // arc centre 75NM from Q-centre, Q-radius 40NM
	'RJAA-P0495/26',  // arc centre 102NM from Q-centre, Q-radius 66NM
	// Base of operations far from survey area
	'VIDP-A0122/26',  // base at Shahpura 35NM from Q-centre, Q-radius 13NM
	// Malformed source coords (DMS minutes/seconds > 60)
	'WMKK-A0016/26',  // E section lists "027437N, 1016897E" (74' minutes invalid)
	'LTAA-D2396/25',  // E section lists "399424.55N 0327544.87E" (94' minutes invalid)
	// World-20260512.txt uses bare NOTAM IDs (no FIR prefix)
	'A0434/26',       // Q-line centre wrong, coordinates 207NM away
	'A0629/26',       // Q-line centre wrong, coordinates 51NM away
	'A1446/26',       // Q-line centre wrong, coordinates 159NM away
	'D0544/26',       // 94' minutes invalid (same pattern as LTAA-D2396/25)
	'D0780/26',       // extra digit in latitude: 0670033.69N
	'E0806/26',       // Q-line centre wrong, coordinates 78NM away
	'E0893/26',       // Q-line centre wrong, coordinates 46NM away
	'G0424/26',       // invalid coordinate: 000000.0N (lat=0)
	'H3041/26',       // Q-line centre wrong, coordinates 110NM away
	'M0021/25',       // Q-line centre wrong (also as LIIC-/LIIA- variants)
	'M2022/25',       // Q-line centre wrong (also as LIIC- variant)
	'M4598/24',       // Q-line centre wrong (also as LIIC- variant)
	'M4599/24',       // Q-line centre wrong (also as LIIC- variant)
	'M5534/26',       // 94' minutes invalid (same pattern as LTAA-D2396/25)
	'P1629/26',       // Q-line centre wrong, coordinates 64NM away
	'U1184/23',       // Q-line radius too small for route extent (also as UUUU- variant)
]);

function assertCoordinatesNearQualifierLine(notams, maxDist) {
	const decoded = notams.filter(n => !n.isPolygon && n.coordinates.some(c => c.type === 'psn'));
	for (const n of decoded) {
		if (coordinateExclusions.has(n.id)) continue;
		const sections = parseSections(n.fullContent);
		if (!sections.Q) continue;
		const q = parseQualifierLine(sections.Q);
		// Skip NOTAMs with max Q-line radius (too coarse) or missing radius
		if (!q || q.radius === 999) continue;
		for (const c of n.coordinates) {
			// Skip when Q-line and coordinate are in opposite hemispheres
			// (indicates a Q-line data error, not a parsing bug)
			if ((q.lat < 0) !== (c.lat < 0)) continue;
			const dlat = (c.lat - q.lat) * 60;
			const dlon = (c.lon - q.lon) * 60 * Math.cos(q.lat * Math.PI / 180);
			const dist = Math.sqrt(dlat * dlat + dlon * dlon);
			const limit = q.radius + maxDist;
			assert.ok(dist <= limit,
				`${n.id} coordinate ${c.original} is ${dist.toFixed(0)}NM from qualifier ` +
				`centre (${q.lat.toFixed(2)}, ${q.lon.toFixed(2)}), exceeds ${limit}NM ` +
				`(Q-radius ${q.radius}NM + ${maxDist}NM)`);
		}
	}
}

for (const t of statisticsTests) {
	describe(`parseNotams - ${t.file} statistics`, () => {
		const text = readFileSync(new URL(`./testdata/${t.file}`, import.meta.url), 'utf-8');
		const notams = parseNotams(text);
		const areas = notams.filter(n => n.isPolygon).length;
		const positions = notams.filter(n => !n.isPolygon && n.coordinates.some(c => c.type === 'psn')).length;
		const noPosition = notams.filter(n => !n.isPolygon && n.coordinates.every(c => c.type === 'qualifierLine')).length;

		it('should count all NOTAMs', () => {
			assert.equal(notams.length, t.all);
		});

		it('should count NOTAMs with no position', () => {
			assert.equal(noPosition, t.noPosition);
		});

		it('should count position NOTAMs', () => {
			assert.equal(positions, t.positions);
		});

		it('should count area NOTAMs', () => {
			assert.equal(areas, t.areas);
		});

		it('should place all decoded coordinates within 20NM of qualifier line', () => {
			assertCoordinatesNearQualifierLine(notams, 20);
		});
	});
}

describe('escapeHtml', () => {
	it('escapes HTML special characters', () => {
		assert.equal(
			escapeHtml('<script>"bad" & \'evil\'</script>'),
			'&lt;script&gt;&quot;bad&quot; &amp; &#39;evil&#39;&lt;/script&gt;'
		);
	});

	it('returns empty string for null or undefined', () => {
		assert.equal(escapeHtml(null), '');
		assert.equal(escapeHtml(undefined), '');
	});

	it('coerces non-strings to strings', () => {
		assert.equal(escapeHtml(42), '42');
	});
});

describe('prettyAirportType', () => {
	it('formats underscore-separated type names', () => {
		assert.equal(prettyAirportType('large_airport'), 'Large airport');
		assert.equal(prettyAirportType('seaplane_base'), 'Seaplane base');
	});
});

describe('airportStyleForType', () => {
	it('returns a distinct style for each known type', () => {
		const large = airportStyleForType('large_airport');
		const small = airportStyleForType('small_airport');
		const heli = airportStyleForType('heliport');
		assert.ok(large.radius >= small.radius, 'large airport dot should be >= small');
		assert.notEqual(large.fillColor, heli.fillColor);
	});

	it('falls back to small_airport for unknown types', () => {
		assert.deepEqual(
			airportStyleForType('unknown_type_xyz'),
			airportStyleForType('small_airport')
		);
	});
});

describe('airportTypeIcon', () => {
	it('returns the airport SVG for the three airport sizes', () => {
		const a = airportTypeIcon('large_airport');
		assert.ok(a.startsWith('<svg'));
		assert.equal(a, airportTypeIcon('medium_airport'));
		assert.equal(a, airportTypeIcon('small_airport'));
	});

	it('returns a distinct heliport SVG', () => {
		const h = airportTypeIcon('heliport');
		const a = airportTypeIcon('large_airport');
		assert.ok(h.startsWith('<svg'));
		assert.notEqual(h, a);
	});

	it('returns a distinct seaplane-base SVG', () => {
		const s = airportTypeIcon('seaplane_base');
		assert.ok(s.startsWith('<svg'));
		assert.notEqual(s, airportTypeIcon('large_airport'));
		assert.notEqual(s, airportTypeIcon('heliport'));
	});

	it('returns empty string for unknown types', () => {
		assert.equal(airportTypeIcon('balloonport'), '');
		assert.equal(airportTypeIcon('future_type'), '');
	});
});

describe('buildAirportPopupHtml', () => {
	// Row shape: [ident, type, name, lat, lon, elev_ft, iso_country, municipality, iata]
	it('renders ICAO, IATA, name, type, city, country and elevation', () => {
		const html = buildAirportPopupHtml([
			'LFPG', 'large_airport', 'Paris Charles de Gaulle',
			49.01278, 2.55, 392, 'FR', 'Paris', 'CDG'
		]);
		assert.match(html, /LFPG/);
		assert.match(html, /\(CDG\)/);
		assert.match(html, /Paris Charles de Gaulle/);
		assert.match(html, /Large airport/);
		assert.match(html, /Paris, FR/);
		assert.match(html, /392 ft/);
		assert.match(html, /119 m/);
	});

	it('includes the type icon SVG in the title', () => {
		const html = buildAirportPopupHtml([
			'LFPG', 'large_airport', 'Paris CDG', 49, 2, null, 'FR', 'Paris', 'CDG'
		]);
		assert.match(html, /airport-popup-icon/);
		assert.match(html, /<svg/);
	});

	it('omits the icon for types without a matching glyph', () => {
		const html = buildAirportPopupHtml([
			'BAL', 'balloonport', 'Example Balloonport',
			1, 2, null, 'FR', 'City', ''
		]);
		assert.doesNotMatch(html, /airport-popup-icon/);
	});

	it('omits the IATA span when code is missing', () => {
		const html = buildAirportPopupHtml([
			'00A', 'heliport', 'Total RF Heliport',
			40.07099, -74.93369, 11, 'US', 'Bensalem', ''
		]);
		assert.doesNotMatch(html, /airport-popup-iata/);
	});

	it('omits the elevation line when elevation is null', () => {
		const html = buildAirportPopupHtml([
			'X', 'small_airport', 'Example', 1, 2, null, 'FR', 'City', ''
		]);
		assert.doesNotMatch(html, /Elevation:/);
	});

	it('escapes unsafe characters in name and location', () => {
		const html = buildAirportPopupHtml([
			'HAX', 'small_airport', '<img src=x onerror="boom">',
			0.1, 0.2, 10, 'XX', 'A & B', ''
		]);
		assert.doesNotMatch(html, /<img src=x/);
		assert.match(html, /&lt;img src=x/);
		assert.match(html, /A &amp; B/);
	});

	it('renders a runways table when runways are present', () => {
		const runways = [
			['08L', '26R', 13829, 148, 'ASP', 1],
			['09R', '27L', 13780, 148, 'CON', 1]
		];
		const html = buildAirportPopupHtml([
			'LFPG', 'large_airport', 'Paris CDG', 49, 2, 392, 'FR', 'Paris', 'CDG', runways
		]);
		assert.match(html, /airport-popup-runways/);
		assert.match(html, /08L\/26R/);
		assert.match(html, /09R\/27L/);
		// 13829 ft ≈ 4215 m
		assert.match(html, /4215/);
		assert.match(html, /Asphalt/);
		assert.match(html, /Concrete/);
		assert.match(html, /Lit/);
	});

	it('omits the runways table when the array is empty', () => {
		const html = buildAirportPopupHtml([
			'LFPG', 'large_airport', 'Paris CDG', 49, 2, 392, 'FR', 'Paris', 'CDG', []
		]);
		assert.doesNotMatch(html, /airport-popup-runways/);
	});

	it('omits the runways table when the runways slot is missing', () => {
		const html = buildAirportPopupHtml([
			'LFPG', 'large_airport', 'Paris CDG', 49, 2, 392, 'FR', 'Paris', 'CDG'
		]);
		assert.doesNotMatch(html, /airport-popup-runways/);
	});
});

describe('formatSurface', () => {
	it('maps known asphalt variants to "Asphalt"', () => {
		assert.equal(formatSurface('ASP'), 'Asphalt');
		assert.equal(formatSurface('ASPH'), 'Asphalt');
		assert.equal(formatSurface('ASPH-G'), 'Asphalt');
	});

	it('maps known grass variants to "Grass"', () => {
		assert.equal(formatSurface('TURF'), 'Grass');
		assert.equal(formatSurface('Grass'), 'Grass');
		assert.equal(formatSurface('GRS'), 'Grass');
	});

	it('maps concrete variants', () => {
		assert.equal(formatSurface('CON'), 'Concrete');
		assert.equal(formatSurface('CONC'), 'Concrete');
	});

	it('returns empty string for empty/unknown-coded input', () => {
		assert.equal(formatSurface(''), '');
		assert.equal(formatSurface('UNK'), '');
	});

	it('falls back to the raw code for unrecognised surfaces', () => {
		assert.equal(formatSurface('MYSTERYMAT'), 'MYSTERYMAT');
	});
});

describe('buildRunwaysHtml', () => {
	it('returns empty string for no runways', () => {
		assert.equal(buildRunwaysHtml([]), '');
		assert.equal(buildRunwaysHtml(null), '');
		assert.equal(buildRunwaysHtml(undefined), '');
	});

	it('skips "Lit" marker for unlit runways', () => {
		const html = buildRunwaysHtml([['04', '22', 3000, 75, 'TURF', 0]]);
		assert.match(html, /Grass/);
		assert.doesNotMatch(html, />Lit</);
	});

	it('renders length-only when width is missing', () => {
		const html = buildRunwaysHtml([['09', '27', 4921, null, 'ASP', 1]]);
		// 4921 ft ≈ 1500 m
		assert.match(html, /1500 m/);
		assert.doesNotMatch(html, /×/);
	});

	it('escapes unsafe runway designators and surface codes', () => {
		const html = buildRunwaysHtml([['<x>', '</x>', 1000, 50, '<bad>', 1]]);
		assert.doesNotMatch(html, /<x>/);
		assert.match(html, /&lt;x&gt;/);
	});
});
