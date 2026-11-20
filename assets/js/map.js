/* ---------------------------------------------------------------------------
   Lazy MapLibre.

   - Laddar biblioteket EN gång, först när kartan är på väg in i vyn.
   - Respekterar Data Saver / dyr uppkoppling: då krävs ett knapptryck.
   - Kraschar inte sidan om nätet fallerar.
   - Knapp under GPS-knappen slår av och på SMHI:s djupkartor.
   --------------------------------------------------------------------------- */

// MapLibre 6 ges bara ut som ES-modul. Versionen är låst så att inget ändras
// under fötterna på oss – uppdatera numret här för att byta version.
const MAPLIBRE_VERSION = '6.19.0';
const MAPLIBRE_BASE = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist`;

let libraryPromise = null;
let maplibregl = null;

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

function loadMapLibre() {
  if (!libraryPromise) {
    // URL:en ligger i en variabel så att Hugos esbuild (js.Build) inte
    // försöker bunta in biblioteket – det ska hämtas från CDN först när
    // kartan behövs. Webbarbetaren (maplibre-gl-worker.mjs) hämtar
    // MapLibre själv från samma adress.
    const moduleUrl = `${MAPLIBRE_BASE}/maplibre-gl.mjs`;
    libraryPromise = Promise.all([
      loadStylesheet(`${MAPLIBRE_BASE}/maplibre-gl.css`),
      import(moduleUrl),
    ]).then(([, library]) => {
      maplibregl = library;
      return library;
    });
    // Ett misslyckat försök ska kunna göras om (t.ex. tappad uppkoppling).
    libraryPromise.catch(() => {
      libraryPromise = null;
    });
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

// Returnerar ett löfte om djupkartsknappen (eller null om kartan inte kunde laddas).
function initMap(container) {
  if (!container.mapReady) container.mapReady = createMap(container);
  return container.mapReady;
}

async function createMap(container) {
  try {
    await loadMapLibre();
  } catch (error) {
    const placeholder = container.querySelector('.map__placeholder');
    if (placeholder) placeholder.querySelector('p').textContent = 'Kartan kunde inte laddas just nu.';
    container.mapReady = null; // knappen får försöka igen
    console.error(error);
    return null;
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
    // Egen attributionsruta nedan – annars blir det två.
    attributionControl: false,
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
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution: [
        'Vattenområden baserade på Lantmäteriets Topografi 10 och Fastighetsindelning, bearbetade. CC BY 4.0',
        'Djupkartor © <a href="https://vattenwebb.smhi.se/">SMHI Vattenwebb</a>, georefererade och omfärgade, <a href="https://creativecommons.org/licenses/by/4.0/deed.sv">CC BY 4.0</a>',
      ],
    })
  );

  // Djupkartsknappen hamnar direkt under GPS-knappen (samma hörn, lagd efter).
  const depth = new DepthControl(map);
  map.addControl(depth, 'top-right');

  await new Promise((resolve) => map.once('load', resolve));

  // Den kompakta källhänvisningen startar utfälld och täcker en stor del av
  // kartan på mobil. Fäll ihop den – ⓘ-knappen visar den igen.
  const attribution = container.querySelector('.maplibregl-ctrl-attrib');
  attribution?.removeAttribute('open');
  attribution?.classList.remove('maplibregl-compact-show');

  await loadAreas(map);
  depth.markReady();
  return depth;
}

/* --- Vattenområden: fyllnad, namn i mitten och popup -----------------------

   Varje område bär sin egen färg i geojson-filens color-egenskap.
   Färgerna kommer ur QGIS-projektet och är exakt desamma som i den
   publicerade SVG-kartan, så webbkartan och den tryckta kartan matchar. */

const AREA_FILL_OPACITY = 0.45;
const AREA_FILL_OPACITY_WITH_DEPTH = 0.12; // låt djupkurvorna synas

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

  const colorExpr = ['coalesce', ['get', 'color'], '#088'];

  map.addSource('vattenomrade', { type: 'geojson', data });

  map.addLayer({
    id: 'vattenomrade',
    type: 'fill',
    source: 'vattenomrade',
    paint: {
      'fill-color': colorExpr,
      'fill-opacity': AREA_FILL_OPACITY,
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

/* --- Djupkartor som lager -------------------------------------------------

   SMHI:s inskannade djupkartor, georefererade mot Lantmäteriets strandlinje
   (se tools/georef_depth_charts.py). Bilderna ligger i Web Mercator med
   norr uppåt, så de fyra hörnen räcker för att placera dem exakt.

   En enda knapp under GPS-knappen slår av och på båda djupkartorna. När de
   är på fälls ett reglage för styrkan ut bredvid knappen. Bilderna hämtas
   först första gången någon slår på dem. */

const DEPTH_MANIFEST = '/maps/djupkartor/djupkartor.json';

let depthManifestPromise = null;

function loadDepthManifest() {
  if (!depthManifestPromise) {
    depthManifestPromise = fetch(DEPTH_MANIFEST).then((response) => {
      if (!response.ok) throw new Error(`${DEPTH_MANIFEST}: ${response.status}`);
      return response.json();
    });
    depthManifestPromise.catch(() => {
      depthManifestPromise = null;
    });
  }
  return depthManifestPromise;
}

class DepthControl {
  constructor(map) {
    this.map = map;
    this.enabled = false;
    this.opacity = 0.9;
    this.layerIds = [];
    // Djupkartorna ska ligga ovanför vattenområdena – vänta tills de finns.
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  onAdd() {
    const root = document.createElement('div');
    root.className = 'maplibregl-ctrl maplibregl-ctrl-group map-depth';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-depth__button';
    button.title = 'Visa djupkartor';
    button.setAttribute('aria-label', 'Visa djupkartor');
    button.setAttribute('aria-pressed', 'false');
    const icon = document.createElement('span');
    icon.className = 'maplibregl-ctrl-icon map-depth__icon';
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    button.addEventListener('click', () => this.setEnabled(!this.enabled));

    const panel = document.createElement('label');
    panel.className = 'map-depth__slider';
    panel.hidden = true;
    const caption = document.createElement('span');
    caption.className = 'map-depth__caption';
    caption.textContent = 'Styrka';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0.2';
    range.max = '1';
    range.step = '0.05';
    range.value = String(this.opacity);
    range.setAttribute('aria-label', 'Djupkartans styrka');
    range.addEventListener('input', () => {
      this.opacity = Number(range.value);
      this.layerIds.forEach((id) => this.map.setPaintProperty(id, 'raster-opacity', this.opacity));
    });
    panel.append(caption, range);

    root.append(button, panel);
    this.root = root;
    this.button = button;
    this.panel = panel;
    return root;
  }

  onRemove() {
    this.root.remove();
  }

  async addLayers() {
    if (this.layerIds.length) return true;
    let manifest;
    try {
      manifest = await loadDepthManifest();
    } catch (error) {
      console.error('Kunde inte ladda djupkartorna', error);
      return false;
    }
    await this.ready;
    if (this.layerIds.length) return true; // två snabba klick
    // Under områdesnamnen så att de fortfarande går att läsa.
    const before = this.map.getLayer('vattenomrade-namn') ? 'vattenomrade-namn' : undefined;
    manifest.forEach((chart) => {
      const id = `djup-${chart.id}`;
      this.map.addSource(id, { type: 'image', url: chart.url, coordinates: chart.coordinates });
      this.map.addLayer(
        {
          id,
          type: 'raster',
          source: id,
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': this.opacity, 'raster-fade-duration': 0 },
        },
        before
      );
      this.layerIds.push(id);
    });
    this.manifest = manifest;
    return true;
  }

  async setEnabled(enabled) {
    this.enabled = enabled;
    this.button.setAttribute('aria-pressed', String(enabled));
    this.button.title = enabled ? 'Dölj djupkartor' : 'Visa djupkartor';
    this.button.setAttribute('aria-label', this.button.title);
    this.root.classList.toggle('is-active', enabled);
    this.panel.hidden = !enabled;

    if (enabled && !(await this.addLayers())) {
      this.enabled = false;
      this.root.classList.remove('is-active');
      this.button.setAttribute('aria-pressed', 'false');
      this.panel.hidden = true;
      return;
    }
    // Läs om läget: användaren kan ha klickat igen under laddningen.
    const visibility = this.enabled ? 'visible' : 'none';
    this.layerIds.forEach((id) => this.map.setLayoutProperty(id, 'visibility', visibility));
    if (this.map.getLayer('vattenomrade')) {
      this.map.setPaintProperty(
        'vattenomrade',
        'fill-opacity',
        this.enabled ? AREA_FILL_OPACITY_WITH_DEPTH : AREA_FILL_OPACITY
      );
    }
  }

  // Används av knapparna i avsnittet Djupkartor: slå på och zooma till sjön.
  async showDepth(chartId) {
    await this.setEnabled(true);
    const chart = this.manifest?.find((item) => item.id === chartId);
    if (!chart) return;
    const [[west, north], , [east, south]] = chart.coordinates;
    this.map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 24, duration: 800 }
    );
  }
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

// Knappar som "Visa på kartan" i avsnittet Djupkartor: scrolla till kartan
// och slå på rätt djupkarta.
document.querySelectorAll('[data-map-overlay]').forEach((button) => {
  button.addEventListener('click', async (event) => {
    const container = document.querySelector('[data-map]');
    if (!container) return;
    event.preventDefault();
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const depth = await initMap(container);
    depth?.showDepth(button.dataset.mapOverlay);
  });
});
