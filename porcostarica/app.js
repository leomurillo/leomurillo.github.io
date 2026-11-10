(function () {
  const GEODATA = window.MORAVIA_GEODATA;
  if (!GEODATA) {
    console.error("MORAVIA_GEODATA not found. Ensure data.js is loaded before app.js.");
    return;
  }

  // Build unified list of all districts in Cantón 14 Moravia for Point-in-Polygon lookup
  const ALL_DISTRICTS = [
    {
      code: "11401",
      provinciaName: "San José",
      provinciaCode: "1",
      cantonName: "Moravia",
      cantonCode: "14",
      distritoName: "San Vicente",
      distritoCode: "01",
      area_km2: GEODATA.district.area_km2,
      perimeter_km: GEODATA.district.perimeter_km,
      coordinates: GEODATA.district.coordinates,
    },
    ...GEODATA.context_districts.map((cd) => ({
      code: cd.code,
      provinciaName: "San José",
      provinciaCode: "1",
      cantonName: "Moravia",
      cantonCode: "14",
      distritoName: cd.name,
      distritoCode: cd.code.slice(3),
      area_km2: cd.area_km2,
      perimeter_km: cd.perimeter_km,
      coordinates: cd.coordinates,
    })),
  ];

  // Application State
  const state = {
    engine: "leaflet", // 'gmaps' | 'leaflet'
    apiKey: "",
    mapType: "roadmap",
    zoneMode: "pdf", // 'none' | 'pdf' | 'heatmap'
    showContextDistricts: true,
    showVertices: false,
    fillOpacity: 0.40,
    strokeWeight: 3.5,
    selectedZoneId: null,
    pin: {
      lat: 9.962166,
      lng: -84.048556,
      source: "manual", // 'gps' | 'ip' | 'manual'
      accuracyMeters: null,
      label: "Parque de Moravia",
    },
    lastResult: null,
    gmap: null,
    gmapObjects: {
      svBoundary: null,
      contextPolys: [],
      zonePolys: new Map(),
      vertexMarkers: [],
      pinMarker: null,
      accuracyCircle: null,
    },
    lmap: null,
    lmapObjects: {
      baseLayer: null,
      svBoundary: null,
      contextPolys: [],
      zonePolys: new Map(),
      vertexLayer: null,
      pinMarker: null,
      accuracyCircle: null,
    },
  };

  // ============================================================================
  // GEODESIC & GEOMETRY ENGINE (CRTM05, POINT-IN-POLYGON, BORDER DISTANCE)
  // ============================================================================
  function wgs84ToCrtm05(latDeg, lonDeg) {
    const a = 6378137.0;
    const f = 1.0 / 298.257223563;
    const k0 = 0.9999;
    const lon0 = (-84.0 * Math.PI) / 180.0;
    const x0 = 500000.0;
    const y0 = 0.0;

    const b = a * (1.0 - f);
    const e2 = (a * a - b * b) / (a * a);
    const ep2 = (a * a - b * b) / (b * b);

    const phi = (latDeg * Math.PI) / 180.0;
    const lam = (lonDeg * Math.PI) / 180.0;

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const tanPhi = Math.tan(phi);

    const N = a / Math.sqrt(1.0 - e2 * sinPhi * sinPhi);
    const T = tanPhi * tanPhi;
    const C = ep2 * cosPhi * cosPhi;
    const A = cosPhi * (lam - lon0);

    const e4 = e2 * e2;
    const e6 = e4 * e2;
    const M =
      a *
      ((1.0 - e2 / 4.0 - (3.0 * e4) / 64.0 - (5.0 * e6) / 256.0) * phi -
        ((3.0 * e2) / 8.0 + (3.0 * e4) / 32.0 + (45.0 * e6) / 1024.0) * Math.sin(2.0 * phi) +
        ((15.0 * e4) / 256.0 + (45.0 * e6) / 1024.0) * Math.sin(4.0 * phi) -
        ((35.0 * e6) / 3072.0) * Math.sin(6.0 * phi));

    const easting =
      x0 +
      k0 *
        N *
        (A +
          ((1.0 - T + C) * Math.pow(A, 3)) / 6.0 +
          ((5.0 - 18.0 * T + T * T + 72.0 * C - 58.0 * ep2) * Math.pow(A, 5)) / 120.0);

    const northing =
      y0 +
      k0 *
        (M +
          N *
            tanPhi *
            ((A * A) / 2.0 +
              ((5.0 - T + 9.0 * C + 4.0 * C * C) * Math.pow(A, 4)) / 24.0 +
              ((61.0 - 58.0 * T + T * T + 600.0 * C - 330.0 * ep2) * Math.pow(A, 6)) / 720.0));

    return { e: easting, n: northing };
  }

  // Ray-casting point-in-ring check
  function pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i].lat,
        xi = ring[i].lng;
      const yj = ring[j].lat,
        xj = ring[j].lng;
      const intersect =
        yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Point-in-polygon supporting interior holes
  function pointInPolygonRings(lat, lng, rings) {
    if (!rings || rings.length === 0) return false;
    if (!pointInRing(lat, lng, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) {
      if (pointInRing(lat, lng, rings[k])) return false;
    }
    return true;
  }

  // Minimum distance in meters from (lat, lng) to a polygon ring's segments
  function minDistanceToRingMeters(lat, lng, ring) {
    const cosLat = Math.cos((lat * Math.PI) / 180.0);
    const mPerDegLat = 110574.0;
    const mPerDegLng = 111320.0 * cosLat;

    let minDistSq = Infinity;
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = (ring[i].lng - lng) * mPerDegLng;
      const ay = (ring[i].lat - lat) * mPerDegLat;
      const bx = (ring[i + 1].lng - lng) * mPerDegLng;
      const by = (ring[i + 1].lat - lat) * mPerDegLat;

      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 1e-9) {
        t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
      }
      const px = ax + t * dx;
      const py = ay + t * dy;
      const dSq = px * px + py * py;
      if (dSq < minDistSq) minDistSq = dSq;
    }
    return Math.sqrt(minDistSq);
  }

  // Evaluate any (lat, lng) against all Moravia districts and 62 San Vicente Homogeneous Zones
  function evaluatePinLocation(lat, lng) {
    let matchedDistrict = null;
    let borderDistMeters = Infinity;

    for (const d of ALL_DISTRICTS) {
      if (pointInRing(lat, lng, d.coordinates)) {
        matchedDistrict = d;
        borderDistMeters = minDistanceToRingMeters(lat, lng, d.coordinates);
        break;
      }
    }

    if (!matchedDistrict) {
      // Find closest district border in Moravia
      for (const d of ALL_DISTRICTS) {
        const dist = minDistanceToRingMeters(lat, lng, d.coordinates);
        if (dist < borderDistMeters) {
          borderDistMeters = dist;
        }
      }
    }

    // Find matching Zona Homogénea if inside 11401 San Vicente (prefer smallest area if nested)
    let matchedZone = null;
    if (matchedDistrict && matchedDistrict.code === "11401") {
      const candidates = [];
      for (const z of GEODATA.zones) {
        if (pointInPolygonRings(lat, lng, z.rings)) {
          candidates.push(z);
        }
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => a.polygon_area_m2 - b.polygon_area_m2);
        matchedZone = candidates[0];
      }
    }

    const crtm = wgs84ToCrtm05(lat, lng);
    return {
      lat,
      lng,
      crtm,
      district: matchedDistrict,
      borderDistMeters,
      zone: matchedZone,
    };
  }

  // ============================================================================
  // LOCATION PERMISSIONS (GPS) & MULTI-PROVIDER IP FALLBACK CASCADE
  // ============================================================================
  function setStatusBanner(type, html) {
    const el = document.getElementById("loc-status-banner");
    el.className = `loc-status-banner visible ${type}`;
    el.innerHTML = html;
  }

  function requestGpsLocation(autoFallbackToIp = false) {
    if (!navigator.geolocation) {
      setStatusBanner("error", "❌ Tu navegador no soporta geolocalización GPS. Probando aproximación por IP...");
      if (autoFallbackToIp) requestIpFallbackLocation();
      return;
    }

    setStatusBanner("manual", "🛰️ Solicitando permiso de ubicación GPS de alta precisión al navegador...");

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const acc = Math.round(pos.coords.accuracy || 15);
        setStatusBanner(
          "gps",
          `✅ <strong>Ubicación GPS activa</strong> (precisión ±${acc} m). Podés arrastrar el pin para ajustar.`
        );
        setPinLocation(lat, lng, "gps", acc, "Mi ubicación GPS", true);
      },
      (err) => {
        console.warn("Geolocation error:", err.code, err.message);
        const reason =
          err.code === 1
            ? "Permiso de ubicación denegado"
            : err.code === 2
            ? "Señal GPS no disponible"
            : "Tiempo de espera GPS agotado";
        if (autoFallbackToIp) {
          setStatusBanner(
            "ip",
            `⚠️ ${reason}. Activando <strong>Fallback de Ubicación por IP</strong> automáticamente...`
          );
          requestIpFallbackLocation();
        } else {
          setStatusBanner(
            "error",
            `⚠️ <strong>${reason}</strong> (${err.message}). Usá el botón <strong>Aproximar por IP</strong> o tocá el mapa.`
          );
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 9000,
        maximumAge: 0,
      }
    );
  }

  async function requestIpFallbackLocation() {
    setStatusBanner("ip", "🌐 Consultando proveedores gratuitos de IP-a-Geolocalización (HTTPS)...");

    const providers = [
      {
        name: "ipwho.is",
        url: "https://ipwho.is/",
        parse: (d) =>
          d && d.success !== false && d.latitude && d.longitude
            ? {
                lat: Number(d.latitude),
                lng: Number(d.longitude),
                city: d.city || "",
                region: d.region || "",
                country: d.country || "",
                isp: (d.connection && d.connection.isp) || d.org || "",
                ip: d.ip || "",
              }
            : null,
      },
      {
        name: "ipapi.co",
        url: "https://ipapi.co/json/",
        parse: (d) =>
          d && d.latitude && d.longitude
            ? {
                lat: Number(d.latitude),
                lng: Number(d.longitude),
                city: d.city || "",
                region: d.region || "",
                country: d.country_name || "",
                isp: d.org || "",
                ip: d.ip || "",
              }
            : null,
      },
      {
        name: "freeipapi.com",
        url: "https://freeipapi.com/api/json",
        parse: (d) =>
          d && d.latitude && d.longitude
            ? {
                lat: Number(d.latitude),
                lng: Number(d.longitude),
                city: d.cityName || "",
                region: d.regionName || "",
                country: d.countryName || "",
                isp: "",
                ip: d.ipAddress || "",
              }
            : null,
      },
      {
        name: "geojs.io",
        url: "https://get.geojs.io/v1/ip/geo.json",
        parse: (d) =>
          d && d.latitude && d.longitude
            ? {
                lat: Number(d.latitude),
                lng: Number(d.longitude),
                city: d.city || "",
                region: d.region || "",
                country: d.country || "",
                isp: d.organization_name || "",
                ip: d.ip || "",
              }
            : null,
      },
    ];

    for (const p of providers) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(p.url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const json = await res.json();
        const info = p.parse(json);
        if (info && !isNaN(info.lat) && !isNaN(info.lng)) {
          const placeStr = [info.city, info.region, info.country].filter(Boolean).join(", ");
          setStatusBanner(
            "ip",
            `🌐 <strong>Ubicación aproximada por IP</strong> vía <code>${p.name}</code>: ${placeStr || "Detectada"} ${
              info.ip ? `(${info.ip})` : ""
            }.<br/>⚠️ <em>La geolocalización por IP es aproximada; arrastrá el pin en el mapa a tu ubicación exacta.</em>`
          );
          setPinLocation(info.lat, info.lng, "ip", 1500, `IP: ${placeStr || p.name}`, true);
          return;
        }
      } catch (e) {
        console.warn(`IP provider ${p.name} failed:`, e);
      }
    }

    setStatusBanner(
      "error",
      "❌ No se pudo obtener ubicación por IP (bloqueador de anuncios o sin red). Hacé clic directamente en el mapa."
    );
  }

  function setPinLocation(lat, lng, source = "manual", accuracyMeters = null, label = "", panMap = false) {
    state.pin = { lat, lng, source, accuracyMeters, label };
    const result = evaluatePinLocation(lat, lng);
    state.lastResult = result;

    // Update URL query string without reloading so user can bookmark/share
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("lat", lat.toFixed(6));
      url.searchParams.set("lng", lng.toFixed(6));
      window.history.replaceState({}, "", url.toString());
    } catch (_) {}

    // Update Hero UI Card
    document.getElementById("res-pin-coords").textContent = `${lat.toFixed(6)}°, ${lng.toFixed(6)}°`;
    document.getElementById("res-pin-crtm").textContent = `CRTM05: E ${result.crtm.e.toFixed(1)}, N ${result.crtm.n.toFixed(1)}`;

    const alertBox = document.getElementById("res-boundary-alert");
    const alertText = document.getElementById("res-boundary-text");
    const zoneBox = document.getElementById("res-zone-box");

    if (result.district) {
      document.getElementById("res-postal-code").textContent = result.district.code;
      document.getElementById("res-postal-code").style.color = "#38bdf8";
      document.getElementById("res-provincia").textContent = result.district.provinciaName;
      document.getElementById("res-provincia-code").textContent = `Código ${result.district.provinciaCode}`;
      document.getElementById("res-canton").textContent = result.district.cantonName;
      document.getElementById("res-canton-code").textContent = `Código ${result.district.cantonCode}`;
      document.getElementById("res-distrito").textContent = result.district.distritoName;
      document.getElementById("res-distrito-code").textContent = `Código ${result.district.distritoCode}`;

      const distM = Math.round(result.borderDistMeters);
      if (distM < 50) {
        alertBox.className = "boundary-alert near";
        alertText.textContent = `⚠️ A solo ${distM} m del límite distrital — verificá la posición exacta del pin`;
      } else {
        alertBox.className = "boundary-alert safe";
        alertText.textContent = `✓ Dentro de ${result.district.distritoName} (${result.district.code}) · A ${distM.toLocaleString()} m del borde`;
      }

      if (result.zone) {
        zoneBox.style.display = "block";
        document.getElementById("res-zone-code").textContent = result.zone.id;
        document.getElementById("res-zone-name").textContent = result.zone.name;
        document.getElementById("res-zone-val").textContent = `${formatColones(result.zone.value_crc)} / m²`;
        document.getElementById("res-zone-meta").textContent = `Tipología: ${result.zone.typology} · Lote tipo: ${result.zone.lot_m2} m² (${result.zone.front_m}m frente)`;
        state.selectedZoneId = result.zone.id;
      } else {
        zoneBox.style.display = "block";
        document.getElementById("res-zone-code").textContent = `Distrito ${result.district.code}`;
        document.getElementById("res-zone-name").textContent = `${result.district.distritoName} de Moravia`;
        document.getElementById("res-zone-val").textContent = `${result.district.area_km2} km²`;
        document.getElementById("res-zone-meta").textContent = `Seleccioná un punto en 11401 San Vicente para ver el detalle de las 62 Zonas Homogéneas`;
        state.selectedZoneId = null;
      }
    } else {
      const distKm = (result.borderDistMeters / 1000).toFixed(2);
      document.getElementById("res-postal-code").textContent = "Fuera POC";
      document.getElementById("res-postal-code").style.color = "#f59e0b";
      document.getElementById("res-provincia").textContent = "Fuera de Moravia";
      document.getElementById("res-provincia-code").textContent = "POC Cantón 14";
      document.getElementById("res-canton").textContent = "A " + distKm + " km";
      document.getElementById("res-canton-code").textContent = "de Moravia";
      document.getElementById("res-distrito").textContent = "Mové el Pin";
      document.getElementById("res-distrito-code").textContent = "o usá un Preset";

      alertBox.className = "boundary-alert near";
      alertText.textContent = `📍 Tu pin está a ${distKm} km de Cantón 14 Moravia. Hacé clic en Moravia o en un botón de prueba arriba.`;
      zoneBox.style.display = "none";
      state.selectedZoneId = null;
    }

    syncPinOnMap(panMap);
    syncMapStyles();
  }

  function syncPinOnMap(panMap = false) {
    const { lat, lng, accuracyMeters } = state.pin;
    const res = state.lastResult;
    const popupHtml =
      res && res.district
        ? `<div style="font-family:Inter,sans-serif;font-size:12px;color:#0f172a;">
             <strong style="font-size:14px;color:#0284c7;">CP ${res.district.code} — ${res.district.distritoName}</strong><br/>
             ${res.district.provinciaName}, ${res.district.cantonName}<br/>
             ${res.zone ? `Zona: <b>${res.zone.id} (${res.zone.name})</b> · ${formatColones(res.zone.value_crc)}/m²<br/>` : ""}
             <span style="font-size:10.5px;color:#64748b;">(${lat.toFixed(5)}, ${lng.toFixed(5)}) — Arrastrá el pin para ajustar</span>
           </div>`
        : `<div style="font-family:Inter,sans-serif;font-size:12px;color:#0f172a;">
             <strong>Pin fuera del área POC (Cantón 14 Moravia)</strong><br/>
             (${lat.toFixed(5)}, ${lng.toFixed(5)})<br/>
             Arrastrá el pin hacia Moravia para probar.
           </div>`;

    if (state.engine === "gmaps" && state.gmap) {
      if (!state.gmapObjects.pinMarker) {
        state.gmapObjects.pinMarker = new google.maps.Marker({
          position: { lat, lng },
          map: state.gmap,
          draggable: true,
          title: "Arrastrá para consultar Distrito y Código Postal",
          zIndex: 100,
        });
        state.gmapObjects.pinMarker.addListener("dragend", (e) => {
          if (e.latLng) {
            setStatusBanner("manual", "📌 Pin ajustado manualmente en el mapa.");
            setPinLocation(e.latLng.lat(), e.latLng.lng(), "manual", null, "Pin manual", false);
          }
        });
      } else {
        state.gmapObjects.pinMarker.setPosition({ lat, lng });
      }

      if (state.gmapObjects.accuracyCircle) {
        state.gmapObjects.accuracyCircle.setMap(null);
        state.gmapObjects.accuracyCircle = null;
      }
      if (accuracyMeters && accuracyMeters > 5) {
        state.gmapObjects.accuracyCircle = new google.maps.Circle({
          center: { lat, lng },
          radius: accuracyMeters,
          strokeColor: "#10b981",
          strokeOpacity: 0.7,
          strokeWeight: 1.5,
          fillColor: "#10b981",
          fillOpacity: 0.12,
          clickable: false,
          map: state.gmap,
        });
      }
      if (panMap) {
        state.gmap.panTo({ lat, lng });
        if (state.gmap.getZoom() < 15 && res && res.district) state.gmap.setZoom(15);
      }
    } else if (state.lmap) {
      if (!state.lmapObjects.pinMarker) {
        state.lmapObjects.pinMarker = L.marker([lat, lng], { draggable: true }).addTo(state.lmap);
        state.lmapObjects.pinMarker.on("dragend", (e) => {
          const pos = e.target.getLatLng();
          setStatusBanner("manual", "📌 Pin ajustado manualmente en el mapa.");
          setPinLocation(pos.lat, pos.lng, "manual", null, "Pin manual", false);
        });
      } else {
        state.lmapObjects.pinMarker.setLatLng([lat, lng]);
      }
      state.lmapObjects.pinMarker.bindPopup(popupHtml).openPopup();

      if (state.lmapObjects.accuracyCircle) {
        state.lmap.removeLayer(state.lmapObjects.accuracyCircle);
        state.lmapObjects.accuracyCircle = null;
      }
      if (accuracyMeters && accuracyMeters > 5) {
        state.lmapObjects.accuracyCircle = L.circle([lat, lng], {
          radius: accuracyMeters,
          color: "#10b981",
          weight: 1.5,
          fillColor: "#10b981",
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(state.lmap);
      }

      if (panMap) {
        if (res && res.district) {
          state.lmap.setView([lat, lng], Math.max(state.lmap.getZoom(), 15));
        } else {
          // Fit both the user's outside pin and San Vicente so they can see where they are relative to Moravia
          const c = GEODATA.district.centroid;
          state.lmap.fitBounds(
            [
              [lat, lng],
              [c.lat, c.lng],
            ],
            { padding: [50, 50], maxZoom: 15 }
          );
        }
      }
    }
  }

  // Heatmap color ramp for land values (CRC / m2)
  function getHeatmapColor(valCrc) {
    const minLog = Math.log10(7500);
    const maxLog = Math.log10(500000);
    const t = Math.max(0, Math.min(1, (Math.log10(Math.max(7500, valCrc)) - minLog) / (maxLog - minLog)));
    const stops = [
      [59, 130, 246],
      [16, 185, 129],
      [245, 158, 11],
      [244, 63, 94],
    ];
    const scaled = t * (stops.length - 1);
    const idx = Math.min(stops.length - 2, Math.floor(scaled));
    const frac = scaled - idx;
    const r = Math.round(stops[idx][0] + frac * (stops[idx + 1][0] - stops[idx][0]));
    const g = Math.round(stops[idx][1] + frac * (stops[idx + 1][1] - stops[idx][1]));
    const b = Math.round(stops[idx][2] + frac * (stops[idx + 1][2] - stops[idx][2]));
    return `rgb(${r}, ${g}, ${b})`;
  }

  function formatColones(val) {
    return "₡" + Number(val).toLocaleString("es-CR");
  }

  // Populate Sidebar Stats & Listeners
  function initSidebar() {
    renderZonesList("");

    document.getElementById("zone-search").addEventListener("input", (e) => {
      renderZonesList(e.target.value.trim().toLowerCase());
    });

    // GPS & IP Fallback buttons
    document.getElementById("btn-use-gps").addEventListener("click", () => {
      requestGpsLocation(true);
    });
    document.getElementById("btn-use-ip").addEventListener("click", () => {
      requestIpFallbackLocation();
    });

    // Preset chips
    document.querySelectorAll(".preset-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const lat = parseFloat(chip.dataset.lat);
        const lng = parseFloat(chip.dataset.lng);
        const label = chip.dataset.label || "Punto de prueba";
        setStatusBanner("manual", `📌 Punto de prueba seleccionado: <strong>${label}</strong>`);
        setPinLocation(lat, lng, "manual", null, label, true);
      });
    });

    // Copy & Share buttons
    document.getElementById("btn-copy-cp").addEventListener("click", (e) => {
      const cp = document.getElementById("res-postal-code").textContent;
      navigator.clipboard.writeText(cp);
      const orig = e.currentTarget.textContent;
      e.currentTarget.textContent = "✓ Copiado";
      setTimeout(() => (e.currentTarget.textContent = orig), 1500);
    });

    document.getElementById("btn-copy-addr").addEventListener("click", (e) => {
      const r = state.lastResult;
      const txt =
        r && r.district
          ? `${r.district.provinciaName}, ${r.district.cantonName}, ${r.district.distritoName} — Código Postal ${r.district.code} (${r.lat.toFixed(5)}, ${r.lng.toFixed(5)})`
          : `${state.pin.lat.toFixed(6)}, ${state.pin.lng.toFixed(6)}`;
      navigator.clipboard.writeText(txt);
      const orig = e.currentTarget.textContent;
      e.currentTarget.textContent = "✓ Copiada";
      setTimeout(() => (e.currentTarget.textContent = orig), 1500);
    });

    document.getElementById("btn-share-pin").addEventListener("click", (e) => {
      navigator.clipboard.writeText(window.location.href);
      const orig = e.currentTarget.textContent;
      e.currentTarget.textContent = "✓ Link Copiado";
      setTimeout(() => (e.currentTarget.textContent = orig), 1500);
    });

    // Color mode tabs
    document.querySelectorAll(".tab-btn[data-zonemode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn[data-zonemode]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.zoneMode = btn.dataset.zonemode;
        syncMapStyles();
      });
    });

    // Map type selector
    document.getElementById("map-type-select").addEventListener("change", (e) => {
      state.mapType = e.target.value;
      updateBaseMapType();
    });

    // Opacity & Stroke sliders
    document.getElementById("opacity-slider").addEventListener("input", (e) => {
      state.fillOpacity = parseFloat(e.target.value);
      document.getElementById("opacity-val").textContent = `${Math.round(state.fillOpacity * 100)}%`;
      syncMapStyles();
    });

    document.getElementById("stroke-slider").addEventListener("input", (e) => {
      state.strokeWeight = parseFloat(e.target.value);
      document.getElementById("stroke-val").textContent = `${state.strokeWeight}px`;
      syncMapStyles();
    });

    // Checkboxes
    document.getElementById("chk-context").addEventListener("change", (e) => {
      state.showContextDistricts = e.target.checked;
      syncMapStyles();
    });

    document.getElementById("chk-vertices").addEventListener("change", (e) => {
      state.showVertices = e.target.checked;
      syncVerticesLayer();
    });

    // Reset view button
    document.getElementById("btn-fit-sv").addEventListener("click", () => {
      fitSanVicenteBounds();
    });

    // Modals
    document.getElementById("btn-open-code").addEventListener("click", () => {
      document.getElementById("code-modal").classList.add("open");
    });
    document.getElementById("btn-open-pipeline").addEventListener("click", () => {
      document.getElementById("pipeline-modal").classList.add("open");
    });
    document.querySelectorAll(".modal-close-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.closest(".modal-backdrop").classList.remove("open");
      });
    });

    // Exports
    document.getElementById("btn-dl-geojson").addEventListener("click", downloadGeoJson);
    document.getElementById("btn-dl-kml").addEventListener("click", downloadKml);
    document.getElementById("btn-copy-snippet").addEventListener("click", copyDeveloperSnippet);

    // API Key bar
    const urlParams = new URLSearchParams(window.location.search);
    const initialKey =
      urlParams.get("apiKey") ||
      urlParams.get("key") ||
      window.GOOGLE_MAPS_API_KEY ||
      localStorage.getItem("GMAPS_API_KEY") ||
      "";

    const keyInput = document.getElementById("gmaps-key-input");
    if (initialKey) {
      keyInput.value = initialKey;
      state.apiKey = initialKey;
    }

    document.getElementById("btn-load-gmaps").addEventListener("click", () => {
      const k = keyInput.value.trim();
      if (!k) {
        alert("Pegá un Google Maps Platform API Key válido primero, o continuá usando el motor interactivo integrado.");
        return;
      }
      localStorage.setItem("GMAPS_API_KEY", k);
      state.apiKey = k;
      bootGoogleMaps(k);
    });

    populateCodeSnippet();
  }

  function renderZonesList(filter) {
    const container = document.getElementById("zones-list");
    container.innerHTML = "";
    const filtered = GEODATA.zones.filter((z) => {
      if (!filter) return true;
      return (
        z.id.toLowerCase().includes(filter) ||
        z.name.toLowerCase().includes(filter) ||
        z.typology.toLowerCase().includes(filter)
      );
    });

    filtered.forEach((z) => {
      const item = document.createElement("div");
      item.className = "zone-item" + (state.selectedZoneId === z.id ? " active" : "");
      item.dataset.zoneId = z.id;
      const swatchColor = state.zoneMode === "heatmap" ? getHeatmapColor(z.value_crc) : z.color;
      item.innerHTML = `
        <div class="zone-left">
          <span class="zone-swatch" style="background:${swatchColor}"></span>
          <div>
            <div class="zone-code">${z.id}</div>
            <div class="zone-name">${z.name}</div>
          </div>
        </div>
        <div class="zone-right">
          <div class="zone-val">${formatColones(z.value_crc)}/m²</div>
          <div class="zone-area">${z.polygon_area_ha} ha · Lote ${z.lot_m2} m²</div>
        </div>
      `;
      item.addEventListener("click", () => {
        setStatusBanner("manual", `📌 Zona seleccionada en lista: <strong>${z.id} — ${z.name}</strong>`);
        setPinLocation(z.label_pos.lat, z.label_pos.lng, "manual", null, z.name, true);
      });
      container.appendChild(item);
    });
  }

  function updateCursorCoordinates(lat, lng) {
    const crtm = wgs84ToCrtm05(lat, lng);
    document.getElementById("hud-wgs84").textContent = `${lat.toFixed(6)}° N, ${lng.toFixed(6)}° W`;
    document.getElementById("hud-crtm05").textContent = `E ${crtm.e.toFixed(1)} m, N ${crtm.n.toFixed(1)} m`;
  }

  // ============================================================================
  // ENGINE 1: GOOGLE MAPS PLATFORM JAVASCRIPT SDK
  // ============================================================================
  window.gm_authFailure = function () {
    console.warn("Google Maps authentication/billing failure detected. Falling back to interactive map engine.");
    const pill = document.getElementById("engine-status-pill");
    pill.textContent = "Google Tiles + Leaflet";
    pill.className = "engine-pill fallback";
    document.getElementById("gmap-container").style.display = "none";
    document.getElementById("leaflet-container").style.display = "block";
    state.engine = "leaflet";
    if (!state.lmap) initLeafletFallback();
  };

  function bootGoogleMaps(apiKey) {
    const pill = document.getElementById("engine-status-pill");
    pill.textContent = "Cargando SDK...";

    const oldScript = document.getElementById("gmaps-sdk-script");
    if (oldScript) oldScript.remove();

    window.__initGoogleMapsCallback = function () {
      try {
        initGoogleMapInstance();
      } catch (err) {
        console.error("Failed initializing Google Maps:", err);
        window.gm_authFailure();
      }
    };

    const script = document.createElement("script");
    script.id = "gmaps-sdk-script";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=__initGoogleMapsCallback&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onerror = function () {
      window.gm_authFailure();
    };
    document.head.appendChild(script);
  }

  function initGoogleMapInstance() {
    state.engine = "gmaps";
    document.getElementById("leaflet-container").style.display = "none";
    const container = document.getElementById("gmap-container");
    container.style.display = "block";

    const pill = document.getElementById("engine-status-pill");
    pill.textContent = "Google Maps JS SDK";
    pill.className = "engine-pill gmaps";

    const d = GEODATA.district;
    const darkStyles = [
      { elementType: "geometry", stylers: [{ color: "#1e293b" }] },
      { elementType: "labels.text.stroke", stylers: [{ color: "#0f172a" }] },
      { elementType: "labels.text.fill", stylers: [{ color: "#94a3b8" }] },
      { featureType: "road", elementType: "geometry", stylers: [{ color: "#334155" }] },
      { featureType: "water", elementType: "geometry", stylers: [{ color: "#090d16" }] },
    ];

    const gmapType =
      state.mapType === "dark" || state.mapType === "voyager" ? "roadmap" : state.mapType;

    state.gmap = new google.maps.Map(container, {
      center: { lat: state.pin.lat, lng: state.pin.lng },
      zoom: 15,
      mapTypeId: gmapType,
      styles: state.mapType === "dark" ? darkStyles : null,
      mapTypeControl: true,
      streetViewControl: true,
      fullscreenControl: true,
    });

    state.gmap.addListener("mousemove", (e) => {
      if (e.latLng) updateCursorCoordinates(e.latLng.lat(), e.latLng.lng());
    });

    state.gmap.addListener("click", (e) => {
      if (e.latLng) {
        setStatusBanner("manual", "📌 Pin colocado manualmente en el mapa.");
        setPinLocation(e.latLng.lat(), e.latLng.lng(), "manual", null, "Pin en mapa", false);
      }
    });

    state.gmapObjects.contextPolys = [];
    state.gmapObjects.zonePolys.clear();
    state.gmapObjects.vertexMarkers = [];
    state.gmapObjects.pinMarker = null;

    // 1. Context Districts (La Trinidad 11403 & San Jeronimo 11402)
    GEODATA.context_districts.forEach((cd, idx) => {
      const color = idx === 0 ? "#f59e0b" : "#a855f7";
      const poly = new google.maps.Polygon({
        paths: cd.coordinates,
        strokeColor: color,
        strokeOpacity: 0.85,
        strokeWeight: 2.2,
        fillColor: color,
        fillOpacity: 0.08,
        map: state.showContextDistricts ? state.gmap : null,
        zIndex: 1,
      });
      poly.addListener("click", (e) => {
        if (e.latLng) {
          setStatusBanner("manual", `📌 Pin colocado en <strong>${cd.code} ${cd.name}</strong>.`);
          setPinLocation(e.latLng.lat(), e.latLng.lng(), "manual", null, cd.name, false);
        }
      });
      poly.addListener("mousemove", (e) => {
        if (e.latLng) updateCursorCoordinates(e.latLng.lat(), e.latLng.lng());
      });
      state.gmapObjects.contextPolys.push(poly);
    });

    // 2. Homogeneous Zones of San Vicente (62 polygons)
    GEODATA.zones.forEach((z) => {
      const poly = new google.maps.Polygon({
        paths: z.rings,
        strokeColor: "#1e293b",
        strokeOpacity: 0.6,
        strokeWeight: 1.0,
        fillColor: z.color,
        fillOpacity: state.fillOpacity,
        map: state.zoneMode === "none" ? null : state.gmap,
        zIndex: 2,
      });
      poly.addListener("click", (e) => {
        if (e.latLng) {
          setStatusBanner("manual", `📌 Pin colocado en <strong>${z.id} — ${z.name}</strong>.`);
          setPinLocation(e.latLng.lat(), e.latLng.lng(), "manual", null, z.name, false);
        }
      });
      poly.addListener("mousemove", (e) => {
        if (e.latLng) updateCursorCoordinates(e.latLng.lat(), e.latLng.lng());
      });
      state.gmapObjects.zonePolys.set(z.id, poly);
    });

    // 3. Primary Boundary Polygon of Distrito 11401 - San Vicente de Moravia
    state.gmapObjects.svBoundary = new google.maps.Polygon({
      paths: d.coordinates,
      strokeColor: "#00f0ff",
      strokeOpacity: 1.0,
      strokeWeight: state.strokeWeight,
      fillColor: "#0ea5e9",
      fillOpacity: state.zoneMode === "none" ? 0.18 : 0.0,
      clickable: false,
      map: state.gmap,
      zIndex: 10,
    });

    syncPinOnMap(false);
    syncMapStyles();
    syncVerticesLayer();
  }

  // ============================================================================
  // ENGINE 2: BUILT-IN INTERACTIVE GEODESIC MAP ENGINE (LEAFLET + GOOGLE TILES)
  // ============================================================================
  function initLeafletFallback() {
    const d = GEODATA.district;
    const container = document.getElementById("leaflet-container");

    state.lmap = L.map(container, {
      center: [d.centroid.lat, d.centroid.lng],
      zoom: 14,
      zoomControl: true,
    });

    updateLeafletTileLayer();

    state.lmap.on("mousemove", (e) => {
      updateCursorCoordinates(e.latlng.lat, e.latlng.lng);
    });

    state.lmap.on("click", (e) => {
      setStatusBanner("manual", "📌 Pin colocado manualmente en el mapa.");
      setPinLocation(e.latlng.lat, e.latlng.lng, "manual", null, "Pin en mapa", false);
    });

    // 1. Context Districts (La Trinidad 11403 & San Jeronimo 11402)
    GEODATA.context_districts.forEach((cd, idx) => {
      const color = idx === 0 ? "#f59e0b" : "#a855f7";
      const latlngs = cd.coordinates.map((pt) => [pt.lat, pt.lng]);
      const poly = L.polygon(latlngs, {
        color,
        weight: 2.2,
        dashArray: "6, 6",
        fillColor: color,
        fillOpacity: 0.08,
      });
      poly.bindTooltip(`Distrito ${cd.code}: ${cd.name} (${cd.area_km2} km²)`, { sticky: true });
      poly.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        setStatusBanner("manual", `📌 Pin colocado en <strong>${cd.code} — ${cd.name}</strong>.`);
        setPinLocation(e.latlng.lat, e.latlng.lng, "manual", null, cd.name, false);
      });
      if (state.showContextDistricts) poly.addTo(state.lmap);
      state.lmapObjects.contextPolys.push(poly);
    });

    // 2. 62 Homogeneous Zones of San Vicente (11401)
    GEODATA.zones.forEach((z) => {
      const rings = z.rings.map((r) => r.map((pt) => [pt.lat, pt.lng]));
      const poly = L.polygon(rings, {
        color: "#0f172a",
        weight: 1,
        opacity: 0.65,
        fillColor: z.color,
        fillOpacity: state.fillOpacity,
      });
      poly.bindTooltip(
        `<strong>${z.id} — ${z.name}</strong><br/>Valor Fiscal: ${formatColones(z.value_crc)}/m²<br/>Código Postal: 11401`,
        { sticky: true }
      );
      poly.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        setStatusBanner("manual", `📌 Pin colocado en <strong>${z.id} — ${z.name}</strong>.`);
        setPinLocation(e.latlng.lat, e.latlng.lng, "manual", null, z.name, false);
      });
      if (state.zoneMode !== "none") poly.addTo(state.lmap);
      state.lmapObjects.zonePolys.set(z.id, poly);
    });

    // 3. Outer Boundary of San Vicente de Moravia (Distrito 11401)
    const svLatLngs = d.coordinates.map((pt) => [pt.lat, pt.lng]);
    state.lmapObjects.svBoundary = L.polygon(svLatLngs, {
      color: "#00e5ff",
      weight: state.strokeWeight,
      opacity: 1.0,
      fillColor: "#0ea5e9",
      fillOpacity: state.zoneMode === "none" ? 0.18 : 0.0,
      interactive: false,
    }).addTo(state.lmap);

    fitSanVicenteBounds();
  }

  function updateLeafletTileLayer() {
    if (!state.lmap) return;
    if (state.lmapObjects.baseLayer) {
      state.lmap.removeLayer(state.lmapObjects.baseLayer);
    }

    if (state.mapType === "satellite") {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}&hl=es",
        {
          subdomains: "0123",
          maxZoom: 21,
          attribution: "Map data &copy; Google",
        }
      ).addTo(state.lmap);
    } else if (state.mapType === "hybrid") {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&hl=es",
        {
          subdomains: "0123",
          maxZoom: 21,
          attribution: "Map data &copy; Google",
        }
      ).addTo(state.lmap);
    } else if (state.mapType === "terrain") {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://mt{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}&hl=es",
        {
          subdomains: "0123",
          maxZoom: 20,
          attribution: "Map data &copy; Google",
        }
      ).addTo(state.lmap);
    } else if (state.mapType === "voyager") {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        {
          subdomains: "abcd",
          maxZoom: 20,
          attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        }
      ).addTo(state.lmap);
    } else if (state.mapType === "dark") {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          subdomains: "abcd",
          maxZoom: 20,
          attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        }
      ).addTo(state.lmap);
    } else {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=es",
        {
          subdomains: "0123",
          maxZoom: 21,
          attribution: "Map data &copy; Google",
        }
      ).addTo(state.lmap);
    }
  }

  function updateBaseMapType() {
    if (state.engine === "gmaps" && state.gmap) {
      const darkStyles = [
        { elementType: "geometry", stylers: [{ color: "#1e293b" }] },
        { elementType: "labels.text.stroke", stylers: [{ color: "#0f172a" }] },
        { elementType: "labels.text.fill", stylers: [{ color: "#94a3b8" }] },
        { featureType: "road", elementType: "geometry", stylers: [{ color: "#334155" }] },
        { featureType: "water", elementType: "geometry", stylers: [{ color: "#090d16" }] },
      ];
      const gmapType =
        state.mapType === "dark" || state.mapType === "voyager" ? "roadmap" : state.mapType;
      state.gmap.setMapTypeId(gmapType);
      state.gmap.setOptions({ styles: state.mapType === "dark" ? darkStyles : null });
    } else {
      updateLeafletTileLayer();
    }
  }

  function syncMapStyles() {
    renderZonesList(document.getElementById("zone-search").value.trim().toLowerCase());

    if (state.engine === "gmaps" && state.gmap) {
      state.gmapObjects.contextPolys.forEach((p) => {
        p.setMap(state.showContextDistricts ? state.gmap : null);
      });

      GEODATA.zones.forEach((z) => {
        const poly = state.gmapObjects.zonePolys.get(z.id);
        if (!poly) return;
        if (state.zoneMode === "none") {
          poly.setMap(null);
        } else {
          poly.setMap(state.gmap);
          const isSel = state.selectedZoneId === z.id;
          const fillColor = state.zoneMode === "heatmap" ? getHeatmapColor(z.value_crc) : z.color;
          poly.setOptions({
            fillColor,
            fillOpacity: isSel ? Math.min(0.9, state.fillOpacity + 0.3) : state.fillOpacity,
            strokeColor: isSel ? "#ffffff" : "#1e293b",
            strokeWeight: isSel ? 2.5 : 1.0,
            zIndex: isSel ? 5 : 2,
          });
        }
      });

      if (state.gmapObjects.svBoundary) {
        state.gmapObjects.svBoundary.setOptions({
          strokeWeight: state.strokeWeight,
          fillOpacity: state.zoneMode === "none" ? state.fillOpacity * 0.45 : 0.0,
        });
      }
    } else if (state.lmap) {
      state.lmapObjects.contextPolys.forEach((p) => {
        if (state.showContextDistricts) {
          if (!state.lmap.hasLayer(p)) p.addTo(state.lmap);
        } else {
          if (state.lmap.hasLayer(p)) state.lmap.removeLayer(p);
        }
      });

      GEODATA.zones.forEach((z) => {
        const poly = state.lmapObjects.zonePolys.get(z.id);
        if (!poly) return;
        if (state.zoneMode === "none") {
          if (state.lmap.hasLayer(poly)) state.lmap.removeLayer(poly);
        } else {
          if (!state.lmap.hasLayer(poly)) poly.addTo(state.lmap);
          const isSel = state.selectedZoneId === z.id;
          const fillColor = state.zoneMode === "heatmap" ? getHeatmapColor(z.value_crc) : z.color;
          poly.setStyle({
            fillColor,
            fillOpacity: isSel ? Math.min(0.9, state.fillOpacity + 0.3) : state.fillOpacity,
            color: isSel ? "#ffffff" : "#0f172a",
            weight: isSel ? 2.5 : 1.0,
          });
          if (isSel) poly.bringToFront();
        }
      });

      if (state.lmapObjects.svBoundary) {
        state.lmapObjects.svBoundary.setStyle({
          weight: state.strokeWeight,
          fillOpacity: state.zoneMode === "none" ? state.fillOpacity * 0.45 : 0.0,
        });
        state.lmapObjects.svBoundary.bringToFront();
      }
    }
  }

  function syncVerticesLayer() {
    const coords = GEODATA.district.coordinates;
    const step = 6;

    if (state.engine === "gmaps" && state.gmap) {
      state.gmapObjects.vertexMarkers.forEach((m) => m.setMap(null));
      state.gmapObjects.vertexMarkers = [];
      if (!state.showVertices) return;

      for (let i = 0; i < coords.length - 1; i += step) {
        const pt = coords[i];
        const marker = new google.maps.Marker({
          position: pt,
          map: state.gmap,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 3,
            fillColor: "#f59e0b",
            fillOpacity: 1,
            strokeColor: "#000",
            strokeWeight: 1,
          },
          title: `Vertex #${i}: (${pt.lat}, ${pt.lng})`,
        });
        state.gmapObjects.vertexMarkers.push(marker);
      }
    } else if (state.lmap) {
      if (state.lmapObjects.vertexLayer) {
        state.lmap.removeLayer(state.lmapObjects.vertexLayer);
        state.lmapObjects.vertexLayer = null;
      }
      if (!state.showVertices) return;

      const group = L.layerGroup();
      for (let i = 0; i < coords.length - 1; i += step) {
        const pt = coords[i];
        const crtm = GEODATA.district.crtm05_coordinates[i];
        L.circleMarker([pt.lat, pt.lng], {
          radius: 3,
          color: "#000",
          weight: 1,
          fillColor: "#f59e0b",
          fillOpacity: 1,
        })
          .bindTooltip(`Vértice #${i}<br/>WGS84: ${pt.lat}, ${pt.lng}<br/>CRTM05: E ${crtm.e}, N ${crtm.n}`)
          .addTo(group);
      }
      group.addTo(state.lmap);
      state.lmapObjects.vertexLayer = group;
    }
  }

  function fitSanVicenteBounds() {
    const b = GEODATA.district.bbox_wgs84;
    if (state.engine === "gmaps" && state.gmap) {
      const bounds = new google.maps.LatLngBounds(
        { lat: b.south, lng: b.west },
        { lat: b.north, lng: b.east }
      );
      state.gmap.fitBounds(bounds, 35);
    } else if (state.lmap) {
      state.lmap.fitBounds(
        [
          [b.south, b.west],
          [b.north, b.east],
        ],
        { padding: [30, 30] }
      );
    }
  }

  // Developer Exports
  function downloadGeoJson() {
    const d = GEODATA.district;
    const fc = {
      type: "FeatureCollection",
      name: "San_Vicente_de_Moravia_11401",
      features: [
        {
          type: "Feature",
          id: "11401",
          properties: {
            codigo_distrito: "11401",
            codigo_postal: "11401",
            nombre: "San Vicente de Moravia",
            canton: "14 Moravia",
            provincia: "1 San José",
            area_km2: d.area_km2,
            area_ha: d.area_ha,
            perimeter_km: d.perimeter_km,
            vertex_count: d.vertex_count,
          },
          geometry: {
            type: "Polygon",
            coordinates: [d.coordinates.map((pt) => [pt.lng, pt.lat])],
          },
        },
      ],
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: "application/geo+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "san_vicente_11401.geojson";
    a.click();
  }

  function downloadKml() {
    const d = GEODATA.district;
    const coordsStr = d.coordinates.map((pt) => `${pt.lng},${pt.lat},0`).join(" ");
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Distrito 11401 - San Vicente de Moravia</name>
    <Placemark>
      <name>San Vicente de Moravia (11401)</name>
      <description>Área: ${d.area_km2} km² | Perímetro: ${d.perimeter_km} km</description>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordsStr}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;
    const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "san_vicente_11401.kml";
    a.click();
  }

  function populateCodeSnippet() {
    const d = GEODATA.district;
    const sampleCoords = d.coordinates
      .slice(0, 6)
      .map((c) => `  { lat: ${c.lat}, lng: ${c.lng} }`)
      .join(",\n");

    const snippet = `// Google Maps JavaScript API v3 — Distrito 11401: San Vicente de Moravia
// Extracted from Ministerio de Hacienda ONT (CRTM05 EPSG:5367 -> WGS84 EPSG:4326)
// Total vertices: ${d.vertex_count} | Area: ${d.area_km2} km² | Perimeter: ${d.perimeter_km} km

async function initSanVicenteMap() {
  const { Map } = await google.maps.importLibrary("maps");

  const map = new Map(document.getElementById("map"), {
    center: { lat: ${d.centroid.lat}, lng: ${d.centroid.lng} },
    zoom: 14,
    mapId: "SAN_VICENTE_11401_MAP",
  });

  // Option A: Load full GeoJSON (boundary + 62 homogeneous zones)
  map.data.loadGeoJson("./san_vicente_11401.geojson");

  // Option B: Direct google.maps.Polygon from data.js
  const sanVicenteCoords = [
${sampleCoords},
  // ... (${d.vertex_count} total vertices in data.js / san_vicente_11401.geojson)
  ];

  const sanVicentePolygon = new google.maps.Polygon({
    paths: window.MORAVIA_GEODATA.district.coordinates,
    strokeColor: "#00f0ff",
    strokeOpacity: 1.0,
    strokeWeight: 3.5,
    fillColor: "#0ea5e9",
    fillOpacity: 0.2,
    map,
  });
}`;
    document.getElementById("dev-code-snippet").textContent = snippet;
  }

  function copyDeveloperSnippet() {
    const text = document.getElementById("dev-code-snippet").textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById("btn-copy-snippet");
      const orig = btn.textContent;
      btn.textContent = "¡Copiado!";
      setTimeout(() => (btn.textContent = orig), 1800);
    });
  }

  // Boot application
  window.addEventListener("DOMContentLoaded", () => {
    initSidebar();
    initLeafletFallback();

    // Check if URL has ?lat=...&lng=... shared coordinates
    const params = new URLSearchParams(window.location.search);
    const qLat = parseFloat(params.get("lat"));
    const qLng = parseFloat(params.get("lng"));

    if (!isNaN(qLat) && !isNaN(qLng)) {
      setStatusBanner("manual", "🔗 Ubicación cargada desde enlace compartido.");
      setPinLocation(qLat, qLng, "manual", null, "Pin compartido", true);
    } else {
      // Initial default pin in San Vicente Centro while requesting GPS (with automatic IP fallback!)
      setPinLocation(9.962166, -84.048556, "manual", null, "Parque de Moravia", false);
      // Automatically test Location Permission -> IP Fallback flow on HTTPS / localhost
      if (window.location.protocol === "https:" || window.location.hostname === "localhost") {
        requestGpsLocation(true);
      }
    }

    if (state.apiKey) {
      bootGoogleMaps(state.apiKey);
    }
  });
})();
