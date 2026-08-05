(() => {
  "use strict";

  if (!window.L) {
    document.getElementById("statusBar").textContent =
      "Kartenbibliothek konnte nicht geladen werden. Bitte Internetverbindung prüfen.";
    return;
  }

  const STORAGE_KEY = "spurenatlas-settings-v5";
  const data = window.SPURENATLAS_DATA || [];
  const standardData = data.filter(item => item.region !== "achenkirch");
  const achenkirchData = data.filter(item => item.region === "achenkirch");
  const CATEGORY_COLORS = {
    "Schlachtfeld": "#9f2d2d",
    "Lager": "#2864ad",
    "Bereitstellung": "#168f81",
    "Handelsstraße": "#cf8b2a",
    "Altweg": "#2b8b52"
  };

  const map = L.map("map", { zoomControl: true }).setView([50.72, 10.85], 8);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap-Mitwirkende"
  }).addTo(map);

  map.createPane("stateBorderPane");
  map.getPane("stateBorderPane").style.zIndex = 355;
  map.getPane("stateBorderPane").style.pointerEvents = "none";
  map.createPane("countryBorderPane");
  map.getPane("countryBorderPane").style.zIndex = 365;
  map.getPane("countryBorderPane").style.pointerEvents = "none";

  const monumentsLayer = L.tileLayer.wms(
    "https://geoservices.bayern.de/od/wms/gdi/v1/denkmal",
    {
      layers: "bodendenkmalO",
      format: "image/png",
      transparent: true,
      version: "1.3.0",
      minZoom: 9,
      maxZoom: 19,
      opacity: 0.75,
      attribution: "Bodendenkmäler © Bayerisches Landesamt für Denkmalpflege"
    }
  );

  L.control.scale({ imperial: false }).addTo(map);

  const layerById = new Map();
  const rowById = new Map();
  let gpsMarker = null;
  let gpsAccuracy = null;
  let watchId = null;
  let centerOnNextFix = false;
  let activePanelTab = "layers";
  let countryBorderLayer = null;
  let stateBordersLayer = null;
  let boundaryAttributionAdded = false;
  const boundaryLoadPromises = {};

  const statusBar = document.getElementById("statusBar");
  const locateButton = document.getElementById("locateButton");
  const panel = document.getElementById("layersPanel");
  const entryList = document.getElementById("entryList");
  const achenkirchEntryList = document.getElementById("achenkirchEntryList");
  const entrySearch = document.getElementById("entrySearch");
  const entryCount = document.getElementById("entryCount");
  const achenkirchCount = document.getElementById("achenkirchCount");
  const epochFilter = document.getElementById("epochFilter");
  const confidenceFilter = document.getElementById("confidenceFilter");
  const toggleAllButton = document.getElementById("toggleAll");
  const monumentsToggle = document.getElementById("monumentsToggle");
  const monumentsOpacity = document.getElementById("monumentsOpacity");
  const monumentsOpacityValue = document.getElementById("monumentsOpacityValue");
  const achenkirchToggle = document.getElementById("achenkirchToggle");
  const countryBorderToggle = document.getElementById("countryBorderToggle");
  const stateBordersToggle = document.getElementById("stateBordersToggle");
  const boundaryStatus = document.getElementById("boundaryStatus");

  const confidenceLabel = level =>
    ({ 1: "rekonstruiert", 2: "wahrscheinlich", 3: "gut belegt" }[level] || "offen");

  const confidenceDash = level => {
    if (level === 1) return "2 9";
    if (level === 2) return "12 6";
    return null;
  };

  const popupHtml = item => {
    const source = item.sourceUrl
      ? `<div class="popup-source"><a href="${item.sourceUrl}" target="_blank" rel="noopener">Quelle: ${item.sourceLabel || "Dokument"} ↗</a></div>`
      : "";
    return `
      <strong>${item.name}</strong>
      <div class="popup-badges">
        <span class="popup-badge">${item.category}</span>
        <span class="popup-badge">${item.year}</span>
        <span class="popup-badge">${item.epoch}</span>
        <span class="popup-badge">${confidenceLabel(item.confidence)}</span>
      </div>
      <div class="popup-note">${item.note}</div>
      ${source}`;
  };

  [...new Set(standardData.map(item => item.epoch))]
    .sort((a, b) => a.localeCompare(b, "de"))
    .forEach(epoch => {
      const option = document.createElement("option");
      option.value = epoch;
      option.textContent = epoch;
      epochFilter.appendChild(option);
    });

  data.forEach(item => {
    const color = CATEGORY_COLORS[item.category] || item.color || "#666";
    const options = {
      color,
      weight: item.kind === "line" ? 5 : 3,
      opacity: 0.9,
      fillColor: color,
      fillOpacity: item.kind === "polygon" ? 0.24 : 0,
      dashArray: confidenceDash(item.confidence),
      lineCap: "round",
      lineJoin: "round"
    };

    const layer = item.kind === "line"
      ? L.polyline(item.coords, options)
      : L.polygon(item.coords, options);

    layer.bindPopup(popupHtml(item), { maxWidth: 340 });
    layerById.set(item.id, layer);

    const regional = item.region === "achenkirch";
    const row = document.createElement("div");
    row.className = "entry";
    row.dataset.id = item.id;
    row.dataset.search = `${item.name} ${item.year} ${item.epoch} ${item.category}`.toLowerCase();
    row.innerHTML = `
      <label>
        <input class="${regional ? "achenkirch-entry-filter" : "entry-filter"}" type="checkbox" value="${item.id}" checked>
        <span>
          <span class="entry-title">${item.name}</span>
          <span class="entry-meta">${item.year} · ${item.category} · ${confidenceLabel(item.confidence)}</span>
        </span>
      </label>
      <button class="entry-focus" type="button" data-focus="${item.id}" aria-label="${item.name} auf der Karte anzeigen">⌖</button>`;

    (regional ? achenkirchEntryList : entryList).appendChild(row);
    rowById.set(item.id, row);
  });

  const categoryEnabled = category =>
    [...document.querySelectorAll(".category-filter:checked")]
      .some(box => box.value === category);

  const standardEntryEnabled = id =>
    document.querySelector(`.entry-filter[value="${CSS.escape(id)}"]`)?.checked ?? true;

  const regionalEntryEnabled = id =>
    document.querySelector(`.achenkirch-entry-filter[value="${CSS.escape(id)}"]`)?.checked ?? true;

  const confidenceEnabled = level => {
    const filter = confidenceFilter.value;
    return filter === "all" ||
      (filter === "medium" && level >= 2) ||
      (filter === "high" && level >= 3);
  };

  const epochEnabled = epoch =>
    epochFilter.value === "all" || epochFilter.value === epoch;

  function itemVisible(item) {
    if (item.region === "achenkirch") {
      return achenkirchToggle.checked && regionalEntryEnabled(item.id);
    }
    return categoryEnabled(item.category) &&
      standardEntryEnabled(item.id) &&
      confidenceEnabled(item.confidence) &&
      epochEnabled(item.epoch);
  }

  function saveSettings() {
    try {
      const settings = {
        confidence: confidenceFilter.value,
        epoch: epochFilter.value,
        categories: Object.fromEntries(
          [...document.querySelectorAll(".category-filter")]
            .map(box => [box.value, box.checked])
        ),
        entries: Object.fromEntries(
          [...document.querySelectorAll(".entry-filter")]
            .map(box => [box.value, box.checked])
        ),
        achenkirchEntries: Object.fromEntries(
          [...document.querySelectorAll(".achenkirch-entry-filter")]
            .map(box => [box.value, box.checked])
        ),
        achenkirchEnabled: achenkirchToggle.checked,
        countryBorder: countryBorderToggle.checked,
        stateBorders: stateBordersToggle.checked,
        monuments: monumentsToggle.checked,
        monumentsOpacity: Number(monumentsOpacity.value),
        activePanelTab
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (_) {}
  }

  function restoreSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!settings) return;

      if ([...confidenceFilter.options].some(o => o.value === settings.confidence)) {
        confidenceFilter.value = settings.confidence;
      }
      if ([...epochFilter.options].some(o => o.value === settings.epoch)) {
        epochFilter.value = settings.epoch;
      }
      document.querySelectorAll(".category-filter").forEach(box => {
        if (typeof settings.categories?.[box.value] === "boolean") {
          box.checked = settings.categories[box.value];
        }
      });
      document.querySelectorAll(".entry-filter").forEach(box => {
        if (typeof settings.entries?.[box.value] === "boolean") {
          box.checked = settings.entries[box.value];
        }
      });
      document.querySelectorAll(".achenkirch-entry-filter").forEach(box => {
        if (typeof settings.achenkirchEntries?.[box.value] === "boolean") {
          box.checked = settings.achenkirchEntries[box.value];
        }
      });
      if (typeof settings.achenkirchEnabled === "boolean") achenkirchToggle.checked = settings.achenkirchEnabled;
      if (typeof settings.countryBorder === "boolean") countryBorderToggle.checked = settings.countryBorder;
      if (typeof settings.stateBorders === "boolean") stateBordersToggle.checked = settings.stateBorders;
      if (typeof settings.monuments === "boolean") monumentsToggle.checked = settings.monuments;
      if (Number.isFinite(settings.monumentsOpacity)) monumentsOpacity.value = settings.monumentsOpacity;
      if (["layers", "achenkirch", "protection", "legend"].includes(settings.activePanelTab)) {
        activePanelTab = settings.activePanelTab;
      }
    } catch (_) {}
  }

  function updateEntryCount() {
    const visibleCount = standardData.filter(item => map.hasLayer(layerById.get(item.id))).length;
    const searchCount = [...rowById.entries()]
      .filter(([id, row]) => standardData.some(item => item.id === id) && !row.classList.contains("is-search-hidden"))
      .length;
    entryCount.textContent = entrySearch.value.trim()
      ? `${searchCount} Suchtreffer · ${visibleCount} auf Karte`
      : `${visibleCount} von ${standardData.length} auf Karte`;
  }

  function updateAchenkirchCount() {
    const visibleCount = achenkirchData.filter(item => map.hasLayer(layerById.get(item.id))).length;
    achenkirchCount.textContent = achenkirchToggle.checked
      ? `${visibleCount} von ${achenkirchData.length} auf Karte`
      : `${achenkirchData.length} Einträge vorbereitet · derzeit ausgeblendet`;
  }

  function updateToggleAllLabel() {
    const boxes = [...document.querySelectorAll(".entry-filter")];
    const allChecked = boxes.length > 0 && boxes.every(box => box.checked);
    toggleAllButton.textContent = allChecked ? "Alle aus" : "Alle an";
  }

  function refreshMonuments({ save = true } = {}) {
    const opacity = Number(monumentsOpacity.value) / 100;
    monumentsLayer.setOpacity(opacity);
    monumentsOpacityValue.textContent = `${monumentsOpacity.value} %`;

    if (monumentsToggle.checked && !map.hasLayer(monumentsLayer)) {
      monumentsLayer.addTo(map);
      statusBar.textContent = map.getZoom() < 9
        ? "Bodendenkmäler aktiviert. Bitte näher heranzoomen (ab Kartenstufe 9)."
        : "Amtliche Bodendenkmäler aktiviert – Schutz- und Vermeidungsinformation.";
    }
    if (!monumentsToggle.checked && map.hasLayer(monumentsLayer)) {
      map.removeLayer(monumentsLayer);
      statusBar.textContent = "Amtliche Bodendenkmäler ausgeblendet.";
    }
    if (save) saveSettings();
  }

  function refreshLayers({ save = true } = {}) {
    data.forEach(item => {
      const show = itemVisible(item);
      const layer = layerById.get(item.id);
      if (show && !map.hasLayer(layer)) layer.addTo(map);
      if (!show && map.hasLayer(layer)) map.removeLayer(layer);
    });
    updateEntryCount();
    updateAchenkirchCount();
    updateToggleAllLabel();
    if (save) saveSettings();
  }

  function fitVisible() {
    const visible = [...layerById.values()].filter(layer => map.hasLayer(layer));
    if (!visible.length) {
      statusBar.textContent = "Keine aktive Arbeitsfläche zum Anzeigen.";
      return;
    }
    map.fitBounds(L.featureGroup(visible).getBounds().pad(0.08));
  }

  function setPanelTab(tabName) {
    activePanelTab = tabName;
    document.querySelectorAll("[data-panel-tab]").forEach(button => {
      const active = button.dataset.panelTab === tabName;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("[data-tab-pane]").forEach(pane => {
      pane.classList.toggle("is-active", pane.dataset.tabPane === tabName);
    });
    saveSettings();
  }

  function openPanel(tabName = activePanelTab) {
    setPanelTab(tabName);
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    if (tabName === "layers") {
      window.setTimeout(() => entrySearch.focus({ preventScroll: true }), 150);
    }
  }

  function closePanel() {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }

  function focusItem(id) {
    const item = data.find(entry => entry.id === id);
    const layer = layerById.get(id);
    if (!item || !layer) return;

    if (item.region === "achenkirch") {
      achenkirchToggle.checked = true;
      const regionalBox = document.querySelector(`.achenkirch-entry-filter[value="${CSS.escape(id)}"]`);
      if (regionalBox) regionalBox.checked = true;
    } else {
      const itemBox = document.querySelector(`.entry-filter[value="${CSS.escape(id)}"]`);
      const categoryBox = [...document.querySelectorAll(".category-filter")]
        .find(box => box.value === item.category);
      if (itemBox) itemBox.checked = true;
      if (categoryBox) categoryBox.checked = true;
      confidenceFilter.value = "all";
      epochFilter.value = "all";
    }

    refreshLayers();
    closePanel();

    const bounds = layer.getBounds();
    map.fitBounds(bounds.pad(item.kind === "line" ? 0.12 : 0.35), {
      animate: true,
      duration: 0.45,
      maxZoom: 15
    });
    window.setTimeout(() => layer.openPopup(bounds.getCenter()), 500);
  }

  function applySearch() {
    const query = entrySearch.value.trim().toLowerCase();
    standardData.forEach(item => {
      const row = rowById.get(item.id);
      row?.classList.toggle("is-search-hidden", Boolean(query) && !row.dataset.search.includes(query));
    });
    updateEntryCount();
  }

  function boundaryUrls(kind) {
    const typeName = kind === "country" ? "vg250_sta" : "vg250_lan";
    const names = [typeName, `vg250:${typeName}`];
    const urls = [];
    names.forEach(name => {
      const params = new URLSearchParams({
        service: "WFS",
        version: "2.0.0",
        request: "GetFeature",
        TYPENAMES: name,
        outputFormat: "json",
        srsName: "urn:ogc:def:crs:EPSG::4326"
      });
      urls.push(`https://sgx.geodatenzentrum.de/wfs_vg250?${params}`);
    });
    if (kind === "states") {
      urls.push("https://tigis.bkg.bund.de/hosting/rest/services/Basemap_light/MapServer/3/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson");
    } else {
      urls.push("https://services-eu1.arcgis.com/U09msXRZoxesNntH/ArcGIS/rest/services/VG250_STA_Deutschland/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson");
    }
    return urls;
  }

  function validGeoJson(json) {
    return json && json.type === "FeatureCollection" && Array.isArray(json.features) && json.features.length > 0;
  }

  async function fetchBoundaryGeoJson(kind) {
    let lastError = null;
    for (const url of boundaryUrls(kind)) {
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 18000);
        const response = await fetch(url, { mode: "cors", signal: controller.signal });
        window.clearTimeout(timer);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (!validGeoJson(json)) throw new Error("keine GeoJSON-Features");
        return json;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Grenzdaten nicht verfügbar");
  }

  function addBoundaryAttribution() {
    if (boundaryAttributionAdded) return;
    map.attributionControl.addAttribution(
      '<a href="https://www.bkg.bund.de" target="_blank" rel="noopener">© BKG 2025</a> · <a href="https://www.govdata.de/dl-de/by-2-0" target="_blank" rel="noopener">dl-de/by-2-0</a> · Darstellung in SpurenAtlas verändert'
    );
    boundaryAttributionAdded = true;
  }

  async function ensureBoundaryLayer(kind) {
    const existing = kind === "country" ? countryBorderLayer : stateBordersLayer;
    if (existing) return existing;
    if (boundaryLoadPromises[kind]) return boundaryLoadPromises[kind];

    boundaryLoadPromises[kind] = (async () => {
      boundaryStatus.textContent = "Amtliche Verwaltungsgrenzen werden geladen …";
      const json = await fetchBoundaryGeoJson(kind);
      const layer = L.geoJSON(json, {
        pane: kind === "country" ? "countryBorderPane" : "stateBorderPane",
        interactive: false,
        style: kind === "country"
          ? { color: "#16191b", weight: 5.5, opacity: 0.88, fillOpacity: 0, lineCap: "round", lineJoin: "round" }
          : { color: "#6d7780", weight: 1.35, opacity: 0.78, fillOpacity: 0, lineCap: "round", lineJoin: "round" }
      });
      if (kind === "country") countryBorderLayer = layer;
      else stateBordersLayer = layer;
      addBoundaryAttribution();
      return layer;
    })();

    try {
      return await boundaryLoadPromises[kind];
    } finally {
      boundaryLoadPromises[kind] = null;
    }
  }

  async function refreshBorders({ save = true } = {}) {
    const requested = [];
    if (countryBorderToggle.checked) requested.push("country");
    if (stateBordersToggle.checked) requested.push("states");

    try {
      for (const kind of requested) {
        const layer = await ensureBoundaryLayer(kind);
        if (!map.hasLayer(layer)) layer.addTo(map);
      }
      if (!countryBorderToggle.checked && countryBorderLayer && map.hasLayer(countryBorderLayer)) {
        map.removeLayer(countryBorderLayer);
      }
      if (!stateBordersToggle.checked && stateBordersLayer && map.hasLayer(stateBordersLayer)) {
        map.removeLayer(stateBordersLayer);
      }
      boundaryStatus.textContent = requested.length
        ? "Amtliche Grenzen aktiv: Staatsgrenze dick, Ländergrenzen dünn."
        : "Amtliche Verwaltungsgrenzen ausgeblendet.";
    } catch (_) {
      boundaryStatus.textContent = "Grenzdaten konnten gerade nicht geladen werden. Bitte später erneut einschalten.";
    }
    if (save) saveSettings();
  }

  document.querySelectorAll(".category-filter, .entry-filter, .achenkirch-entry-filter, #confidenceFilter, #epochFilter")
    .forEach(el => el.addEventListener("change", () => refreshLayers()));

  entrySearch.addEventListener("input", applySearch);
  monumentsToggle.addEventListener("change", () => refreshMonuments());
  monumentsOpacity.addEventListener("input", () => refreshMonuments());
  achenkirchToggle.addEventListener("change", () => refreshLayers());
  countryBorderToggle.addEventListener("change", () => refreshBorders());
  stateBordersToggle.addEventListener("change", () => refreshBorders());

  [entryList, achenkirchEntryList].forEach(list => {
    list.addEventListener("click", event => {
      const button = event.target.closest("[data-focus]");
      if (button) focusItem(button.dataset.focus);
    });
  });

  document.querySelectorAll("[data-panel-tab]").forEach(button => {
    button.addEventListener("click", () => setPanelTab(button.dataset.panelTab));
  });

  document.getElementById("layersButton").addEventListener("click", () => openPanel("layers"));
  document.getElementById("legendButton").addEventListener("click", () => openPanel("legend"));
  document.getElementById("closePanel").addEventListener("click", closePanel);
  document.getElementById("fitButton").addEventListener("click", fitVisible);

  document.getElementById("focusMellrichstadt").addEventListener("click", () => {
    map.setView([50.43, 10.31], 12, { animate: true });
    closePanel();
    statusBar.textContent = monumentsToggle.checked
      ? "Raum Mellrichstadt – amtliche Bodendenkmäler und historische Arbeitsdaten."
      : "Raum Mellrichstadt. Unter Schutz kannst du die amtlichen Bodendenkmäler aktivieren.";
  });

  document.getElementById("focusAchenkirch").addEventListener("click", () => {
    achenkirchToggle.checked = true;
    refreshLayers();
    map.setView([47.535, 11.700], 11, { animate: true });
    closePanel();
    statusBar.textContent = "Raum Achenkirch – Gefechtsräume, Sperrstellungen und Handelswege aktiviert.";
  });

  toggleAllButton.addEventListener("click", () => {
    const boxes = [...document.querySelectorAll(".entry-filter")];
    const turnOn = !boxes.every(box => box.checked);
    boxes.forEach(box => { box.checked = turnOn; });
    refreshLayers();
  });

  const distanceKm = (lat1, lon1, lat2, lon2) => {
    const r = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  };

  const centerOf = coords => {
    const sums = coords.reduce((acc, coord) => [acc[0] + coord[0], acc[1] + coord[1]], [0, 0]);
    return [sums[0] / coords.length, sums[1] / coords.length];
  };

  function nearestVisible(lat, lon) {
    return data
      .filter(item => map.hasLayer(layerById.get(item.id)))
      .map(item => {
        const center = centerOf(item.coords);
        return { item, distance: distanceKm(lat, lon, center[0], center[1]) };
      })
      .sort((a, b) => a.distance - b.distance)[0];
  }

  function updateLocation(position) {
    const { latitude, longitude, accuracy } = position.coords;
    const point = [latitude, longitude];

    if (!gpsMarker) {
      gpsMarker = L.circleMarker(point, {
        radius: 8, color: "#ffffff", weight: 3,
        fillColor: "#3aa0ff", fillOpacity: 1
      }).addTo(map).bindPopup("Dein Standort");
      gpsAccuracy = L.circle(point, {
        radius: accuracy, color: "#3aa0ff", weight: 1, fillOpacity: 0.08
      }).addTo(map);
    } else {
      gpsMarker.setLatLng(point);
      gpsAccuracy.setLatLng(point).setRadius(accuracy);
    }

    if (centerOnNextFix) {
      map.setView(point, Math.max(map.getZoom(), 14));
      centerOnNextFix = false;
    }

    locateButton.classList.add("is-active");
    locateButton.textContent = "◎ Zentrieren";
    const nearest = nearestVisible(latitude, longitude);
    statusBar.textContent = nearest
      ? `GPS ±${Math.round(accuracy)} m · ${nearest.item.name}: ca. ${nearest.distance.toFixed(1)} km · Karte frei verschiebbar`
      : `GPS ±${Math.round(accuracy)} m · Karte frei verschiebbar`;
  }

  function locationError(error) {
    const messages = {
      1: "Standort wurde nicht erlaubt. Bitte in Safari unter Website-Einstellungen → Standort freigeben.",
      2: "Standort ist derzeit nicht verfügbar.",
      3: "Die Standortabfrage hat zu lange gedauert."
    };
    statusBar.textContent = messages[error.code] || `GPS-Fehler: ${error.message}`;
  }

  locateButton.addEventListener("click", () => {
    if (!window.isSecureContext) {
      statusBar.textContent = "GPS benötigt HTTPS.";
      return;
    }
    if (!navigator.geolocation) {
      statusBar.textContent = "Dieser Browser unterstützt keine Standortabfrage.";
      return;
    }
    centerOnNextFix = true;
    if (watchId === null) {
      statusBar.textContent = "Standortfreigabe wird angefragt …";
      watchId = navigator.geolocation.watchPosition(updateLocation, locationError, {
        enableHighAccuracy: true, maximumAge: 3000, timeout: 18000
      });
    } else if (gpsMarker) {
      map.setView(gpsMarker.getLatLng(), Math.max(map.getZoom(), 14));
      centerOnNextFix = false;
    }
  });

  map.on("dragstart zoomstart", () => { centerOnNextFix = false; });
  map.on("zoomend", () => {
    if (monumentsToggle.checked && map.getZoom() < 9) {
      statusBar.textContent = "Bodendenkmäler sind aktiviert, werden aber erst ab Kartenstufe 9 angezeigt.";
    }
  });

  restoreSettings();
  refreshLayers({ save: false });
  refreshMonuments({ save: false });
  applySearch();
  setPanelTab(activePanelTab);
  fitVisible();
  refreshBorders({ save: false });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () =>
      navigator.serviceWorker.register("./sw.js").catch(() => {})
    );
  }
})();
