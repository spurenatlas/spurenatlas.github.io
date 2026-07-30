(() => {
  "use strict";

  if (!window.L) {
    document.getElementById("statusBar").textContent =
      "Kartenbibliothek konnte nicht geladen werden. Bitte Internetverbindung prüfen.";
    return;
  }

  const STORAGE_KEY = "spurenatlas-settings-v3";
  const data = window.SPURENATLAS_DATA || [];
  const map = L.map("map", { zoomControl: true }).setView([50.72, 10.85], 8);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap-Mitwirkende"
  }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  const layerById = new Map();
  const rowById = new Map();

  let gpsMarker = null;
  let gpsAccuracy = null;
  let watchId = null;
  let centerOnNextFix = false;

  const statusBar = document.getElementById("statusBar");
  const locateButton = document.getElementById("locateButton");
  const panel = document.getElementById("layersPanel");
  const entryList = document.getElementById("entryList");
  const entrySearch = document.getElementById("entrySearch");
  const entryCount = document.getElementById("entryCount");
  const epochFilter = document.getElementById("epochFilter");
  const confidenceFilter = document.getElementById("confidenceFilter");
  const toggleAllButton = document.getElementById("toggleAll");

  const confidenceLabel = level =>
    ({ 1: "rekonstruiert", 2: "wahrscheinlich", 3: "gut belegt" }[level] || "offen");

  const popupHtml = item => `
    <strong>${item.name}</strong>
    <div class="popup-badges">
      <span class="popup-badge">${item.category}</span>
      <span class="popup-badge">${item.year}</span>
      <span class="popup-badge">${item.epoch}</span>
      <span class="popup-badge">${confidenceLabel(item.confidence)}</span>
    </div>
    <div class="popup-note">${item.note}</div>`;

  [...new Set(data.map(item => item.epoch))]
    .sort((a, b) => a.localeCompare(b, "de"))
    .forEach(epoch => {
      const option = document.createElement("option");
      option.value = epoch;
      option.textContent = epoch;
      epochFilter.appendChild(option);
    });

  data.forEach(item => {
    const options = {
      color: item.color,
      weight: item.kind === "line" ? 5 : 3,
      opacity: 0.88,
      fillColor: item.color,
      fillOpacity: item.kind === "polygon" ? 0.27 : 0,
      dashArray: item.confidence === 1 ? "9 8" : null
    };

    const layer =
      item.kind === "line"
        ? L.polyline(item.coords, options)
        : L.polygon(item.coords, options);

    layer.bindPopup(popupHtml(item), { maxWidth: 320 });
    layerById.set(item.id, layer);

    const row = document.createElement("div");
    row.className = "entry";
    row.dataset.id = item.id;
    row.dataset.search = `${item.name} ${item.year} ${item.epoch} ${item.category}`.toLowerCase();
    row.innerHTML = `
      <label>
        <input class="entry-filter" type="checkbox" value="${item.id}" checked>
        <span>
          <span class="entry-title">${item.name}</span>
          <span class="entry-meta">${item.year} · ${item.category} · ${confidenceLabel(item.confidence)}</span>
        </span>
      </label>
      <button class="entry-focus" type="button" data-focus="${item.id}" aria-label="${item.name} auf der Karte anzeigen">⌖</button>`;
    entryList.appendChild(row);
    rowById.set(item.id, row);
  });

  const categoryEnabled = category =>
    [...document.querySelectorAll(".category-filter:checked")]
      .some(box => box.value === category);

  const entryEnabled = id =>
    document.querySelector(`.entry-filter[value="${CSS.escape(id)}"]`)?.checked ?? true;

  const confidenceEnabled = level => {
    const filter = confidenceFilter.value;
    return filter === "all" ||
      (filter === "medium" && level >= 2) ||
      (filter === "high" && level >= 3);
  };

  const epochEnabled = epoch =>
    epochFilter.value === "all" || epochFilter.value === epoch;

  function itemVisible(item) {
    return categoryEnabled(item.category) &&
      entryEnabled(item.id) &&
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
        )
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
    } catch (_) {}
  }

  function updateEntryCount() {
    const visibleCount = data.filter(item => map.hasLayer(layerById.get(item.id))).length;
    const searchCount = [...rowById.values()].filter(row => !row.classList.contains("is-search-hidden")).length;
    entryCount.textContent = entrySearch.value.trim()
      ? `${searchCount} Suchtreffer · ${visibleCount} auf Karte`
      : `${visibleCount} von ${data.length} auf Karte`;
  }

  function updateToggleAllLabel() {
    const boxes = [...document.querySelectorAll(".entry-filter")];
    const allChecked = boxes.length > 0 && boxes.every(box => box.checked);
    toggleAllButton.textContent = allChecked ? "Alle aus" : "Alle an";
  }

  function refreshLayers({ save = true } = {}) {
    data.forEach(item => {
      const show = itemVisible(item);
      const layer = layerById.get(item.id);
      if (show && !map.hasLayer(layer)) layer.addTo(map);
      if (!show && map.hasLayer(layer)) map.removeLayer(layer);
    });

    updateEntryCount();
    updateToggleAllLabel();
    if (save) saveSettings();
  }

  function fitVisible() {
    const visible = [...layerById.values()].filter(layer => map.hasLayer(layer));
    if (!visible.length) {
      statusBar.textContent = "Keine aktive Fläche zum Anzeigen.";
      return;
    }
    map.fitBounds(L.featureGroup(visible).getBounds().pad(0.08));
  }

  function focusItem(id) {
    const item = data.find(entry => entry.id === id);
    const layer = layerById.get(id);
    if (!item || !layer) return;

    const itemBox = document.querySelector(`.entry-filter[value="${CSS.escape(id)}"]`);
    const categoryBox = [...document.querySelectorAll(".category-filter")]
      .find(box => box.value === item.category);

    if (itemBox) itemBox.checked = true;
    if (categoryBox) categoryBox.checked = true;
    confidenceFilter.value = "all";
    epochFilter.value = "all";
    refreshLayers();

    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");

    const bounds = layer.getBounds();
    map.fitBounds(bounds.pad(item.kind === "line" ? 0.15 : 0.35), {
      animate: true,
      duration: 0.45,
      maxZoom: 15
    });

    window.setTimeout(() => {
      layer.openPopup(bounds.getCenter());
    }, 500);
  }

  function applySearch() {
    const query = entrySearch.value.trim().toLowerCase();
    rowById.forEach(row => {
      row.classList.toggle("is-search-hidden", Boolean(query) && !row.dataset.search.includes(query));
    });
    updateEntryCount();
  }

  document.querySelectorAll(".category-filter, .entry-filter, #confidenceFilter, #epochFilter")
    .forEach(el => el.addEventListener("change", () => refreshLayers()));

  entrySearch.addEventListener("input", applySearch);

  entryList.addEventListener("click", event => {
    const button = event.target.closest("[data-focus]");
    if (button) focusItem(button.dataset.focus);
  });

  document.getElementById("layersButton").addEventListener("click", () => {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    window.setTimeout(() => entrySearch.focus({ preventScroll: true }), 150);
  });

  document.getElementById("closePanel").addEventListener("click", () => {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  });

  document.getElementById("fitButton").addEventListener("click", fitVisible);

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
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  };

  const centerOf = coords => {
    const sums = coords.reduce(
      (acc, coord) => [acc[0] + coord[0], acc[1] + coord[1]],
      [0, 0]
    );
    return [sums[0] / coords.length, sums[1] / coords.length];
  };

  function nearestVisible(lat, lon) {
    return data
      .filter(item => map.hasLayer(layerById.get(item.id)))
      .map(item => {
        const center = centerOf(item.coords);
        return {
          item,
          distance: distanceKm(lat, lon, center[0], center[1])
        };
      })
      .sort((a, b) => a.distance - b.distance)[0];
  }

  function updateLocation(position) {
    const { latitude, longitude, accuracy } = position.coords;
    const point = [latitude, longitude];

    if (!gpsMarker) {
      gpsMarker = L.circleMarker(point, {
        radius: 8,
        color: "#ffffff",
        weight: 3,
        fillColor: "#3aa0ff",
        fillOpacity: 1
      }).addTo(map).bindPopup("Dein Standort");

      gpsAccuracy = L.circle(point, {
        radius: accuracy,
        color: "#3aa0ff",
        weight: 1,
        fillOpacity: 0.08
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
      watchId = navigator.geolocation.watchPosition(
        updateLocation,
        locationError,
        {
          enableHighAccuracy: true,
          maximumAge: 3000,
          timeout: 18000
        }
      );
    } else if (gpsMarker) {
      map.setView(gpsMarker.getLatLng(), Math.max(map.getZoom(), 14));
      centerOnNextFix = false;
    }
  });

  map.on("dragstart zoomstart", () => {
    centerOnNextFix = false;
  });

  restoreSettings();
  refreshLayers({ save: false });
  applySearch();
  fitVisible();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () =>
      navigator.serviceWorker.register("./sw.js").catch(() => {})
    );
  }
})();
