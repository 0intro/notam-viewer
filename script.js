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

// Parse qualifier line coordinate string to decimal degrees
// Format: 4840N00305E005 = 48°40'N, 003°05'E, 5NM radius
function parseQualifierLineCoordinate(qualifierLineCoord) {
	// Match format: DDMMN/S + DDDMME/W + optional radius
	const match = qualifierLineCoord.match(/^(\d{4})([NS])(\d{5})([EW])(\d{3})?$/i);
	if (!match) {
		return null;
	}

	const latStr = match[1]; // DDMM
	const latDir = match[2].toUpperCase();
	const lonStr = match[3]; // DDDMM
	const lonDir = match[4].toUpperCase();
	const radius = match[5] ? parseInt(match[5], 10) : null;

	// Parse latitude: DDMM
	const latDeg = parseInt(latStr.substring(0, 2), 10);
	const latMin = parseInt(latStr.substring(2, 4), 10);

	// Parse longitude: DDDMM
	const lonDeg = parseInt(lonStr.substring(0, 3), 10);
	const lonMin = parseInt(lonStr.substring(3, 5), 10);

	let lat = latDeg + latMin / 60;
	let lon = lonDeg + lonMin / 60;

	if (latDir === 'S') lat = -lat;
	if (lonDir === 'W') lon = -lon;

	return { lat, lon, radius };
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

	// Handle 7-digit longitudes (missing either leading zero or tenths of seconds)
	if (lonStr.length === 7 && !lonStr.includes('.')) {
		// If starts with 0, append zero for tenths of seconds: 0022140 -> 00221400
		// If doesn't start with 0, prepend zero for degrees: 1420211 -> 01420211
		if (lonStr[0] === '0') {
			lonStr = lonStr + '0';
		} else {
			lonStr = '0' + lonStr;
		}
	}

	// Parse latitude: DDMMSS or DDMMSSs (7th digit is tenths of seconds)
	let latDeg, latMin, latSec;
	if (latStr.includes('.')) {
		latDeg = parseInt(latStr.substring(0, 2), 10);
		latMin = parseInt(latStr.substring(2, 4), 10);
		latSec = parseFloat(latStr.substring(4));
	} else if (latStr.length === 7) {
		latDeg = parseInt(latStr.substring(0, 2), 10);
		latMin = parseInt(latStr.substring(2, 4), 10);
		latSec = parseFloat(latStr.substring(4, 6) + '.' + latStr.substring(6));
	} else {
		latDeg = parseInt(latStr.substring(0, 2), 10);
		latMin = parseInt(latStr.substring(2, 4), 10);
		latSec = parseFloat(latStr.substring(4));
	}

	// Parse longitude: DDDMMSS or DDDMMSSs (8th digit is tenths of seconds)
	let lonDeg, lonMin, lonSec;
	if (lonStr.includes('.')) {
		lonDeg = parseInt(lonStr.substring(0, 3), 10);
		lonMin = parseInt(lonStr.substring(3, 5), 10);
		lonSec = parseFloat(lonStr.substring(5));
	} else if (lonStr.length === 8) {
		lonDeg = parseInt(lonStr.substring(0, 3), 10);
		lonMin = parseInt(lonStr.substring(3, 5), 10);
		lonSec = parseFloat(lonStr.substring(5, 7) + '.' + lonStr.substring(7));
	} else {
		lonDeg = parseInt(lonStr.substring(0, 3), 10);
		lonMin = parseInt(lonStr.substring(3, 5), 10);
		lonSec = parseFloat(lonStr.substring(5));
	}

	let lat = latDeg + latMin / 60 + latSec / 3600;
	let lon = lonDeg + lonMin / 60 + lonSec / 3600;

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

// Parse NOTAMs and extract those with coordinates
function parseNotams(text) {
	const notams = [];

	// Split into individual NOTAMs using the NOTAM ID pattern
	// Support SOFIA-Briefing format (LFFF-A1234/25) and autorouter formats (LFFF A1234/25 and A1234/25)
	const notamPattern = /(?:^|\n)\s*((?:[A-Z]{4}[\s-])?[A-Z]\d+\/\d+)/g;
	const parts = text.split(notamPattern);

	// Process pairs: [before, id1, content1, id2, content2, ...]
	for (let i = 1; i < parts.length; i += 2) {
		const notamId = parts[i];
		let content = parts[i + 1] || '';

		// NOTAM content ends at an empty line
		const emptyLineMatch = content.match(/\n\s*\n/);
		if (emptyLineMatch) {
			content = content.substring(0, emptyLineMatch.index);
		}

		// Find all PSN coordinates in this NOTAM
		const psnMatches = content.matchAll(/PSN\s*:?\s*([^\n]+)/gi);
		const coordinates = [];

		for (const match of psnMatches) {
			const coordStr = match[1];
			const coords = parseDMSCoordinate(coordStr);
			if (coords) {
				coordinates.push({
					original: coordStr.trim().split(/\s{2,}/)[0], // Clean up extra spaces
					lat: coords.lat,
					lon: coords.lon,
					type: 'psn'
				});
			}
		}

		// Find qualifier line coordinates only if no PSN coordinates found
		// Format: Q) LFFF / QOBCE / IV / M / A / 000/999 / 4845N00207E005
		// Radius (last 3 digits) is optional: 4845N00207E or 4845N00207E005
		// Note: altitude field (000/999) contains a slash, so we just match the coordinate at the end
		if (coordinates.length === 0) {
			const qualifierLineMatches = content.matchAll(/Q\).*?(\d{4}[NS]\d{5}[EW](?:\d{3})?)/gi);

			for (const match of qualifierLineMatches) {
				const qualifierCoordStr = match[1];
				const coords = parseQualifierLineCoordinate(qualifierCoordStr);
				if (coords) {
					coordinates.push({
						original: qualifierCoordStr,
						lat: coords.lat,
						lon: coords.lon,
						radius: coords.radius,
						type: 'qualifierLine'
					});
				}
			}
		}

		// Extract ICAO codes from A) line
		const icaoMatch = content.match(/A\)\s*([A-Z]{4}(?:\s+[A-Z]{4})*)/i);
		const icaoCodes = icaoMatch ? icaoMatch[1].split(/\s+/) : [];

		// Only keep NOTAMs with valid coordinates
		if (coordinates.length > 0) {
			notams.push({
				id: notamId,
				fullContent: cleanNotamContent(content),
				coordinates: coordinates,
				icaoCodes: icaoCodes
			});
		}
	}

	return notams;
}

// Clear existing markers and radius circle
function clearMarkers() {
	markers.forEach(marker => map.removeLayer(marker));
	markers = [];
	if (radiusCircle) {
		map.removeLayer(radiusCircle);
		radiusCircle = null;
	}
}

// Canvas renderer for circles (better compatibility with html2canvas for PDF export)
const canvasRenderer = L.canvas();

// Show radius circle for a location (radius in NM)
function showRadiusCircle(lat, lon, radiusNM) {
	if (radiusCircle) {
		map.removeLayer(radiusCircle);
	}
	// Convert NM to meters (1 NM = 1852 m)
	const radiusMeters = radiusNM * 1852;
	radiusCircle = L.circle([lat, lon], {
		radius: radiusMeters,
		color: '#0078d4',
		fillColor: '#0078d4',
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
				radius: coord.radius
			});
			if (coord.type === 'qualifierLine') {
				group.hasQualifierLine = true;
				if (coord.radius) group.radius = coord.radius;
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
		? `<div class="popup-radius">Radius: ${group.radius} NM</div>`
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
				<div class="popup-coords">${group.lat.toFixed(6)}, ${group.lon.toFixed(6)}</div>
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

	return `
		<div class="notam-header">
			<span class="coord-label">#${posIndex}</span>
			${listIcaoDisplay}
			<strong>${notamIds}</strong>${countLabel}
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
		if (group.hasQualifierLine && group.radius) {
			showRadiusCircle(group.lat, group.lon, group.radius);
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

	const locationGroups = groupNotamsByLocation(notams, showAll);

	if (locationGroups.size === 0) {
		listEl.innerHTML = '<li class="no-results">No NOTAMs with PSN coordinates found. Enable "Show all NOTAMs" to include qualifier line coordinates.</li>';
		return;
	}

	const locationToGroups = buildLocationToGroupsMap(locationGroups);
	const bounds = [];
	const markerMap = new Map();
	let posIndex = 1;

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

	loadExampleNotams();
});
