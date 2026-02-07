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
};

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
});

const code = readFileSync(new URL('./script.js', import.meta.url), 'utf-8');
new Script(code).runInContext(context);

const { parseNotams, parseDMSCoordinate, parseQualifierLineCoordinate,
	computePolygonArea } = context;

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

// Unit tests for qualifier line coordinate parser

describe('parseQualifierLineCoordinate', () => {
	it('should parse coordinate with radius', () => {
		const c = parseQualifierLineCoordinate('4840N00305E005');
		assertNear(c.lat, 48.6667, 'lat');
		assertNear(c.lon, 3.0833, 'lon');
		assert.equal(c.radius, 5);
	});

	it('should parse coordinate without radius', () => {
		const c = parseQualifierLineCoordinate('4840N00305E');
		assertNear(c.lat, 48.6667, 'lat');
		assertNear(c.lon, 3.0833, 'lon');
		assert.equal(c.radius, null);
	});

	it('should parse western longitude', () => {
		const c = parseQualifierLineCoordinate('1615N06116W001');
		assertNear(c.lat, 16.25, 'lat');
		assertNear(c.lon, -61.2667, 'lon');
		assert.equal(c.radius, 1);
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

// Integration tests: positions

describe('parseNotams - positions', () => {
	const notams = parseNotams(positionsText);

	it('should parse all position NOTAMs', () => {
		assert.equal(notams.length, 9);
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

	it('should fall back to qualifier line when space missing (TTPP-A1652/25)', () => {
		const n = findNotam(notams, 'TTPP-A1652/25');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'qualifierLine');
		assertNear(n.coordinates[0].lat, 16.25, 'lat');
		assertNear(n.coordinates[0].lon, -61.2667, 'lon');
		assert.equal(n.coordinates[0].radius, 1);
	});

	it('should parse missing leading zero longitude (LOWW-A0089/26)', () => {
		const n = findNotam(notams, 'LOWW-A0089/26');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 46.6469, 'lat');
		assertNear(n.coordinates[0].lon, 14.3392, 'lon');
	});

	it('should parse high-precision decimal seconds (LFFA-P4304/25)', () => {
		const n = findNotam(notams, 'LFFA-P4304/25');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 45.9319, 'lat');
		assertNear(n.coordinates[0].lon, 6.0776, 'lon');
	});

	it('should parse standard PSN after descriptive text (LFFA-C4783/25)', () => {
		const n = findNotam(notams, 'LFFA-C4783/25');
		assert.ok(n);
		assert.equal(n.coordinates.length, 1);
		assert.equal(n.coordinates[0].type, 'psn');
		assertNear(n.coordinates[0].lat, 45.9531, 'lat');
		assertNear(n.coordinates[0].lon, 6.1261, 'lon');
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
		assert.equal(notams.length, 11);
	});

	it('should mark all area NOTAMs as polygons', () => {
		for (const n of notams) {
			assert.equal(n.isPolygon, true, `${n.id} should be polygon`);
		}
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
});
