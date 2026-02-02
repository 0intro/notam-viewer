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

let markers = [];

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

	const latStr = match[1];
	const latDir = (match[2] || 'N').toUpperCase(); // Default to North
	const lonStr = match[3];
	const lonDir = (match[4] || 'E').toUpperCase(); // Default to East

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
					lon: coords.lon
				});
			}
		}

		// Only keep NOTAMs with valid coordinates
		if (coordinates.length > 0) {
			notams.push({
				id: notamId,
				fullContent: cleanNotamContent(content),
				coordinates: coordinates
			});
		}
	}

	return notams;
}

// Clear existing markers
function clearMarkers() {
	markers.forEach(marker => map.removeLayer(marker));
	markers = [];
}

// Main function to parse and display
function parseAndDisplay() {
	const input = document.getElementById('notamInput').value;
	const notams = parseNotams(input);
	const listEl = document.getElementById('coordinatesList');

	clearMarkers();
	listEl.innerHTML = '';

	if (notams.length === 0) {
		listEl.innerHTML = '<li class="no-results">No NOTAMs with PSN coordinates found.</li>';
		return;
	}

	const bounds = [];
	let posIndex = 1;

	notams.forEach((notam) => {
		notam.coordinates.forEach((coord) => {
			// Add marker to map
			const marker = L.marker([coord.lat, coord.lon]).addTo(map);
			marker.bindPopup(`
				<div class="notam-popup">
					<strong>${notam.id}</strong>
					<div class="popup-coords">${coord.lat.toFixed(6)}, ${coord.lon.toFixed(6)}</div>
					<pre class="popup-content">${notam.fullContent}</pre>
				</div>
			`, { maxWidth: 600, maxHeight: 400 });
			markers.push(marker);
			bounds.push([coord.lat, coord.lon]);

			// Add to list
			const li = document.createElement('li');
			li.innerHTML = `
				<div class="notam-header">
					<span class="coord-label">#${posIndex}</span>
					<strong>${notam.id}</strong>
				</div>
				<pre class="notam-content">${notam.fullContent}</pre>
			`;
			li.querySelector('.notam-header').onclick = () => {
				map.setView([coord.lat, coord.lon], 12);
				marker.openPopup();
				document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
			};
			listEl.appendChild(li);
			posIndex++;
		});
	});

	// Fit map to show all markers
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

	try {
		// Capture the map element
		const canvas = await html2canvas(mapEl, {
			useCORS: true,
			allowTaint: true,
			logging: false
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
