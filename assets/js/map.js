/* ---------------------------------------------------------------------------
   Lazy MapLibre.

   - Laddar biblioteket EN gång, först när kartan är på väg in i vyn.
   - Respekterar Data Saver / dyr uppkoppling: då krävs ett knapptryck.
   - Kraschar inte sidan om nätet fallerar.
   - Lagerpanel: vattenområden och SMHI:s djupkartor kan slås av och på.
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

// Returnerar ett löfte om lagerpanelen (eller null om kartan inte kunde laddas).
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

  const layers = new LayerControl(map);
  map.addControl(layers, 'top-left');

  await new Promise((resolve) => map.once('load', resolve));

  // Den kompakta källhänvisningen startar utfälld och täcker en stor del av
  // kartan på mobil. Fäll ihop den – ⓘ-knappen visar den igen.
  const attribution = container.querySelector('.maplibregl-ctrl-attrib');
  attribution?.removeAttribute('open');
  attribution?.classList.remove('maplibregl-compact-show');

  await loadAreas(map);
  return layers;
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
   Bilderna hämtas först när någon slår på lagret. */

const DEPTH_MANIFEST = '/maps/djupkartor/djupkartor.json';

const DEPTH_CHARTS = [
  { id: 'torn', label: 'Djupkarta Törn (1981)' },
  { id: 'torngol', label: 'Djupkarta Törngöl (1988)' },
];

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

class LayerControl {
  constructor(map) {
    this.map = map;
    this.opacity = 0.9;
    this.inputs = new Map();
  }

  onAdd() {
    const root = document.createElement('details');
    root.className = 'maplibregl-ctrl maplibregl-ctrl-group map-layers';

    const summary = document.createElement('summary');
    summary.className = 'map-layers__toggle';
    summary.textContent = 'Lager';
    root.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'map-layers__body';
    root.appendChild(body);

    body.appendChild(this.checkbox('areas', 'Vattenområden', true, (on) => this.setAreas(on)));
    DEPTH_CHARTS.forEach((chart) => {
      body.appendChild(this.checkbox(chart.id, chart.label, false, (on) => this.setDepth(chart.id, on)));
    });

    const slider = document.createElement('label');
    slider.className = 'map-layers__range';
    const caption = document.createElement('span');
    caption.textContent = 'Djupkartans styrka';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0.2';
    range.max = '1';
    range.step = '0.05';
    range.value = String(this.opacity);
    range.addEventListener('input', () => {
      this.opacity = Number(range.value);
      DEPTH_CHARTS.forEach(({ id }) => {
        if (this.map.getLayer(`djup-${id}`)) {
          this.map.setPaintProperty(`djup-${id}`, 'raster-opacity', this.opacity);
        }
      });
    });
    slider.append(caption, range);
    body.appendChild(slider);

    // Öppen från början på stora skärmar, hopfälld på mobil.
    root.open = window.matchMedia('(min-width: 48rem)').matches;
    this.root = root;
    return root;
  }

  onRemove() {
    this.root.remove();
  }

  checkbox(id, text, checked, onChange) {
    const label = document.createElement('label');
    label.className = 'map-layers__item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    label.append(input, document.createTextNode(text));
    this.inputs.set(id, input);
    return label;
  }

  setAreas(visible) {
    const value = visible ? 'visible' : 'none';
    ['vattenomrade', 'vattenomrade-kant', 'vattenomrade-namn'].forEach((id) => {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', value);
    });
  }

  anyDepthVisible() {
    return DEPTH_CHARTS.some(({ id }) => this.inputs.get(id)?.checked);
  }

  async setDepth(id, visible) {
    const layerId = `djup-${id}`;
    if (visible && !this.map.getSource(layerId)) {
      let chart;
      try {
        chart = (await loadDepthManifest()).find((item) => item.id === id);
      } catch (error) {
        console.error('Kunde inte ladda djupkartorna', error);
        this.inputs.get(id).checked = false;
        return;
      }
      if (!chart || this.map.getSource(layerId)) return;
      this.map.addSource(layerId, { type: 'image', url: chart.url, coordinates: chart.coordinates });
      // Under namnen så att områdesnamnen fortfarande går att läsa.
      const before = this.map.getLayer('vattenomrade-namn') ? 'vattenomrade-namn' : undefined;
      this.map.addLayer(
        {
          id: layerId,
          type: 'raster',
          source: layerId,
          paint: { 'raster-opacity': this.opacity, 'raster-fade-duration': 0 },
        },
        before
      );
    }
    // Läs kryssrutan igen: användaren kan ha hunnit ändra sig under laddningen.
    const shown = this.inputs.get(id).checked;
    if (this.map.getLayer(layerId)) {
      this.map.setLayoutProperty(layerId, 'visibility', shown ? 'visible' : 'none');
    }
    if (this.map.getLayer('vattenomrade')) {
      this.map.setPaintProperty(
        'vattenomrade',
        'fill-opacity',
        this.anyDepthVisible() ? AREA_FILL_OPACITY_WITH_DEPTH : AREA_FILL_OPACITY
      );
    }
  }

  // Används av knappar utanför kartan, t.ex. i avsnittet Djupkartor.
  async showDepth(id) {
    const input = this.inputs.get(id);
    if (!input) return;
    input.checked = true;
    await this.setDepth(id, true);
    const chart = (await loadDepthManifest()).find((item) => item.id === id);
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
    const layers = await initMap(container);
    layers?.showDepth(button.dataset.mapOverlay);
  });
});
