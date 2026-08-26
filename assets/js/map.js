/* ---------------------------------------------------------------------------
   Lazy MapLibre.

   - Laddar biblioteket EN gång, först när kartan är på väg in i vyn.
   - Respekterar Data Saver / dyr uppkoppling: då krävs ett knapptryck.
   - Kraschar inte sidan om nätet fallerar.
   --------------------------------------------------------------------------- */

const MAPLIBRE_BASE = 'https://tiles.versatiles.org/assets/lib/maplibre-gl';

let libraryPromise = null;

function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = resolve;
    link.onerror = () => reject(new Error(`Kunde inte ladda ${href}`));
    document.head.appendChild(link);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Kunde inte ladda ${src}`));
    document.head.appendChild(script);
  });
}

function loadMapLibre() {
  if (!libraryPromise) {
    libraryPromise = Promise.all([
      loadStylesheet(`${MAPLIBRE_BASE}/maplibre-gl.css`),
      loadScript(`${MAPLIBRE_BASE}/maplibre-gl.js`),
    ]);
  }
  return libraryPromise;
}

function parseBounds(value) {
  const [west, south, east, north] = value.split(',').map(Number);
  return [
    [west, south],
    [east, north],
  ];
}

async function initMap(container) {
  if (container.dataset.mapReady) return;
  container.dataset.mapReady = 'true';

  try {
    await loadMapLibre();
  } catch (error) {
    container.querySelector('.map__placeholder').textContent =
      'Kartan kunde inte laddas just nu.';
    console.error(error);
    return;
  }

  const placeholder = container.querySelector('.map__placeholder');
  if (placeholder) placeholder.remove();

  const [lng, lat] = container.dataset.center.split(',').map(Number);

  const map = new maplibregl.Map({
    container,
    style: container.dataset.style,
    center: [lng, lat],
    zoom: Number(container.dataset.zoom),
    maxBounds: parseBounds(container.dataset.bounds),
    // Fingret ska kunna scrolla förbi kartan på mobil utan att fastna i den.
    cooperativeGestures: true,
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  // Samma geolokalisering som på gamla sidan – visa var jag är på sjön.
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }),
    'top-right'
  );
  map.addControl(
    new maplibregl.AttributionControl({
      customAttribution:
        'Vattenområden baserade på Lantmäteriets Topografi 10 och Fastighetsindelning, bearbetade. CC BY 4.0',
    })
  );

  map.on('load', () => loadAreas(map));
}

/* --- Vattenområden: fyllnad, namn i mitten och popup ----------------------- */

const AREA_PALETTE = [
  '#0a7ea4', '#7c9a3d', '#b0651f', '#7261a3', '#2a8f77',
  '#b4536e', '#5b7fbf', '#8a7a25', '#c07840', '#4f9457',
  '#a25b9c', '#3b8fa3', '#996c33', '#5f8a52', '#b04a4a',
  '#4a6fa0', '#8f8f2e',
];

// Tyngdpunkt för en ring (shoelace). Tillräckligt bra som etikettpunkt
// för dessa områden – ingen extra geometribibliotek behövs.
function ringCentroid(ring) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = ring.length - 1; i < n; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (area === 0) return ring[0];
  return [cx / (3 * area), cy / (3 * area)];
}

// Namnet placeras i mitten av områdets största delpolygon.
function labelPoint(feature) {
  let best = null;
  let bestArea = -1;
  feature.geometry.coordinates.forEach((polygon) => {
    const ring = polygon[0]; // yttre ringen
    let area = 0;
    for (let i = 0, n = ring.length - 1; i < n; i += 1) {
      area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    area = Math.abs(area);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  });
  return ringCentroid(best);
}

async function loadAreas(map) {
  let data;
  try {
    const response = await fetch('/maps/vattenomraden.geojson');
    data = await response.json();
  } catch (error) {
    console.error('Kunde inte ladda vattenområdena', error);
    return;
  }

  // En färg per område, byggt som ett match-uttryck på namnet.
  const colorExpr = ['match', ['get', 'name']];
  data.features.forEach((feature, i) => {
    colorExpr.push(feature.properties.name, AREA_PALETTE[i % AREA_PALETTE.length]);
  });
  colorExpr.push('#088');

  map.addSource('vattenomrade', { type: 'geojson', data });

  map.addLayer({
    id: 'vattenomrade',
    type: 'fill',
    source: 'vattenomrade',
    paint: {
      'fill-color': colorExpr,
      'fill-opacity': 0.45,
    },
  });

  map.addLayer({
    id: 'vattenomrade-kant',
    type: 'line',
    source: 'vattenomrade',
    paint: {
      'line-color': colorExpr,
      'line-width': 1.5,
    },
  });

  // Namnen som egen punktkälla i områdenas mitt.
  map.addSource('vattenomrade-namn', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: data.features.map((feature) => ({
        type: 'Feature',
        properties: { name: feature.properties.name },
        geometry: { type: 'Point', coordinates: labelPoint(feature) },
      })),
    },
  });

  map.addLayer({
    id: 'vattenomrade-namn',
    type: 'symbol',
    source: 'vattenomrade-namn',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['noto_sans_bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 16],
    },
    paint: {
      'text-color': '#12303c',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.5,
    },
  });

  // Klick på ett område visar namnet – bra på mobil där ytorna är små.
  map.on('click', 'vattenomrade', (e) => {
    new maplibregl.Popup()
      .setLngLat(e.lngLat)
      .setText(e.features[0].properties.name)
      .addTo(map);
  });

  // Pekare över områdena, som på gamla sidan.
  map.on('mouseenter', 'vattenomrade', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'vattenomrade', () => {
    map.getCanvas().style.cursor = '';
  });
}

function saveDataMode() {
  const connection = navigator.connection;
  if (!connection) return false;
  return connection.saveData === true || /2g/.test(connection.effectiveType || '');
}

document.querySelectorAll('[data-map]').forEach((container) => {
  container
    .querySelector('[data-map-load]')
    ?.addEventListener('click', () => initMap(container));

  // Vid sparläge för data laddar vi inget automatiskt – knappen får bestämma.
  if (saveDataMode() || !('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        initMap(container);
      });
    },
    { rootMargin: '200px' } // börja ladda strax innan kartan syns
  );

  observer.observe(container);
});
