(() => {
  "use strict";

  if (!window.L) {
    document.getElementById("statusBar").textContent = "Kartenbibliothek konnte nicht geladen werden. Bitte Internetverbindung prüfen.";
    return;
  }

  const data = window.SPURENATLAS_DATA || [];
  const map = L.map("map", { zoomControl: true }).setView([50.72, 10.85], 8);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap-Mitwirkende"
  }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  const layerById = new Map();
  let gpsMarker = null;
  let gpsAccuracy = null;
  let watchId = null;
  let centerOnNextFix = false;
  let allEnabled = true;

  const statusBar = document.getElementById("statusBar");
  const locateButton = document.getElementById("locateButton");
  const panel = document.getElementById("layersPanel");
  const entryList = document.getElementById("entryList");

  const confidenceLabel = level => ({1: "rekonstruiert", 2: "wahrscheinlich", 3: "gut belegt"}[level] || "offen");

  const popupHtml = item => `
    <strong>${item.name}</strong>
    <div class="popup-badges">
      <span class="popup-badge">${item.category}</span>
      <span class="popup-badge">${item.year}</span>
      <span class="popup-badge">${confidenceLabel(item.confidence)}</span>
    </div>
    <div class="popup-note">${item.note}</div>`;

  data.forEach(item => {
    const options = {
      color: item.color,
      weight: item.kind === "line" ? 5 : 3,
      opacity: .88,
      fillColor: item.color,
      fillOpacity: item.kind === "polygon" ? .27 : 0,
      dashArray: item.confidence === 1 ? "9 8" : null
    };
    const layer = item.kind === "line" ? L.polyline(item.coords, options) : L.polygon(item.coords, options);
    layer.bindPopup(popupHtml(item), { maxWidth: 320 });
    layerById.set(item.id, layer);

    const row = document.createElement("div");
    row.className = "entry";
    row.innerHTML = `<label>
      <input class="entry-filter" type="checkbox" value="${item.id}" checked>
      <span><span class="entry-title">${item.name}</span><span class="entry-meta">${item.year} · ${item.category} · ${confidenceLabel(item.confidence)}</span></span>
    </label>`;
    entryList.appendChild(row);
  });

  const categoryEnabled = category => [...document.querySelectorAll(".category-filter:checked")].some(box => box.value === category);
  const entryEnabled = id => document.querySelector(`.entry-filter[value="${id}"]`)?.checked ?? true;
  const confidenceEnabled = level => {
    const filter = document.getElementById("confidenceFilter").value;
    return filter === "all" || (filter === "medium" && level >= 2) || (filter === "high" && level >= 3);
  };

  function refreshLayers() {
    data.forEach(item => {
      const show = categoryEnabled(item.category) && entryEnabled(item.id) && confidenceEnabled(item.confidence);
      const layer = layerById.get(item.id);
      if (show && !map.hasLayer(layer)) layer.addTo(map);
      if (!show && map.hasLayer(layer)) map.removeLayer(layer);
    });
  }

  function fitVisible() {
    const visible = [...layerById.values()].filter(layer => map.hasLayer(layer));
    if (!visible.length) return;
    const group = L.featureGroup(visible);
    map.fitBounds(group.getBounds().pad(.08));
  }

  document.querySelectorAll(".category-filter, .entry-filter, #confidenceFilter").forEach(el => el.addEventListener("change", refreshLayers));
  refreshLayers();
  fitVisible();

  document.getElementById("layersButton").addEventListener("click", () => {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
  });
  document.getElementById("closePanel").addEventListener("click", () => {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  });
  document.getElementById("fitButton").addEventListener("click", fitVisible);
  document.getElementById("toggleAll").addEventListener("click", event => {
    allEnabled = !allEnabled;
    document.querySelectorAll(".entry-filter").forEach(box => { box.checked = allEnabled; });
    event.currentTarget.textContent = allEnabled ? "Alle aus" : "Alle an";
    refreshLayers();
  });

  const distanceKm = (lat1, lon1, lat2, lon2) => {
    const r = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) ** 2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  };

  const centerOf = coords => {
    const sums = coords.reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1]], [0,0]);
    return [sums[0] / coords.length, sums[1] / coords.length];
  };

  function nearestVisible(lat, lon) {
    return data
      .filter(item => map.hasLayer(layerById.get(item.id)))
      .map(item => {
        const center = centerOf(item.coords);
        return { item, distance: distanceKm(lat, lon, center[0], center[1]) };
      })
      .sort((a,b) => a.distance - b.distance)[0];
  }

  function updateLocation(position) {
    const { latitude, longitude, accuracy } = position.coords;
    const point = [latitude, longitude];
    if (!gpsMarker) {
      gpsMarker = L.circleMarker(point, { radius: 8, color: "#ffffff", weight: 3, fillColor: "#3aa0ff", fillOpacity: 1 }).addTo(map).bindPopup("Dein Standort");
      gpsAccuracy = L.circle(point, { radius: accuracy, color: "#3aa0ff", weight: 1, fillOpacity: .08 }).addTo(map);
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
      statusBar.textContent = "GPS benötigt HTTPS. Auf GitHub Pages funktioniert es nach der Veröffentlichung.";
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
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 18000
      });
    } else if (gpsMarker) {
      map.setView(gpsMarker.getLatLng(), Math.max(map.getZoom(), 14));
      centerOnNextFix = false;
    }
  });

  map.on("dragstart zoomstart", () => {
    centerOnNextFix = false;
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
})();
