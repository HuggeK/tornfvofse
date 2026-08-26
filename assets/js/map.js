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

  map.on('load', () => {
    map.addSource('vattenomrade', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        name: 'vattenomrade-torn',
        features: [],
      },
    });

    map.addLayer({
      id: 'vattenomrade',
      type: 'fill',
      source: 'vattenomrade',
      paint: {
        'fill-color': '#088',
        'fill-opacity': 0.8,
      },
    });
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
