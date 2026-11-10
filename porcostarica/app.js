(function () {
  const CR_DATA = window.CR_DISTRICTS_DATA;
  const PDF_GEODATA = window.MORAVIA_GEODATA;

  if (!CR_DATA || !CR_DATA.districts) {
    console.error("CR_DISTRICTS_DATA not found. Ensure cr_districts_data.js is loaded before app.js.");
    return;
  }

  const INV_SCALE = 1.0 / (CR_DATA.scale || 100000);

  // Province color palette for national view
  const PROVINCE_COLORS = {
    1: "#38bdf8", // San José (Sky Blue)
    2: "#f59e0b", // Alajuela (Amber)
    3: "#10b981", // Cartago (Emerald)
    4: "#a855f7", // Heredia (Purple)
    5: "#fb7185", // Guanacaste (Rose)
    6: "#2dd4bf", // Puntarenas (Teal)
    7: "#84cc16", // Limón (Lime)
  };

  // Decode delta-encoded integer ring [lon0, lat0, dlon1, dlat1, ...] -> [{lat, lng}, ...]
  function decodeDeltaRing(enc) {
    const n = enc.length >> 1;
    const ring = new Array(n);
    let curLon = enc[0];
    let curLat = enc[1];
    ring[0] = { lat: curLat * INV_SCALE, lng: curLon * INV_SCALE };
    for (let i = 1; i < n; i++) {
      curLon += enc[i * 2];
      curLat += enc[i * 2 + 1];
      ring[i] = { lat: curLat * INV_SCALE, lng: curLon * INV_SCALE };
    }
    return ring;
  }

  // Decode delta-encoded integer ring directly to Leaflet [lat, lng] tuples for fast Canvas rendering
  function decodeDeltaRingLatLngs(enc) {
    const n = enc.length >> 1;
    const ring = new Array(n);
    let curLon = enc[0];
    let curLat = enc[1];
    ring[0] = [curLat * INV_SCALE, curLon * INV_SCALE];
    for (let i = 1; i < n; i++) {
      curLon += enc[i * 2];
      curLat += enc[i * 2 + 1];
      ring[i] = [curLat * INV_SCALE, curLon * INV_SCALE];
    }
    return ring;
  }

  // Prepare 487 districts with decoded LOD-Low for instant national zoom-out, and lazy LOD-High cache
  const ALL_DISTRICTS = CR_DATA.districts.map((d) => ({
    code: d.c,
    provinciaCode: String(d.p),
    provinciaName: d.pn,
    cantonCode: d.ca,
    cantonName: d.can,
    distritoCode: d.d,
    distritoName: d.dn,
    area_km2: d.a,
    perimeter_km: d.pe,
    centroid: { lat: d.ct[0], lng: d.ct[1] },
    bbox: d.bb, // [minLng, minLat, maxLng, maxLat]
    color: PROVINCE_COLORS[d.p] || "#38bdf8",
    _rawLo: d.lo,
    _rawHi: d.hi,
    _loLatLngs: d.lo.map(decodeDeltaRingLatLngs),
    _hiRings: null,      // Lazy decoded [{lat, lng}, ...]
    _hiLatLngs: null,    // Lazy decoded [[lat, lng], ...]
    _searchKey: `${d.c} ${d.dn} ${d.can} ${d.pn}`.toLowerCase(),
  }));

  const DISTRICT_BY_CODE = new Map();
  ALL_DISTRICTS.forEach((d) => DISTRICT_BY_CODE.set(d.code, d));

  function getHighResRings(d) {
    if (!d._hiRings) {
      d._hiRings = d._rawHi.map(decodeDeltaRing);
    }
    return d._hiRings;
  }

  function getHighResLatLngs(d) {
    if (!d._hiLatLngs) {
      d._hiLatLngs = d._rawHi.map(decodeDeltaRingLatLngs);
    }
    return d._hiLatLngs;
  }

  // Build Hacienda PDF Moravia dictionary (11401, 11402, 11403) for direct comparison
  const PDF_MORAVIA = {};
  if (PDF_GEODATA && PDF_GEODATA.district) {
    PDF_MORAVIA["11401"] = {
      code: "11401",
      name: "San Vicente",
      area_km2: PDF_GEODATA.district.area_km2,
      perimeter_km: PDF_GEODATA.district.perimeter_km,
      vertex_count: PDF_GEODATA.district.vertex_count,
      median_diff_m: 0.51,
      p90_diff_m: 1.01,
      max_diff_m: 49.22,
      coordinates: PDF_GEODATA.district.coordinates,
    };
    (PDF_GEODATA.context_districts || []).forEach((cd) => {
      PDF_MORAVIA[cd.code] = {
        code: cd.code,
        name: cd.name,
        area_km2: cd.area_km2,
        perimeter_km: cd.perimeter_km,
        vertex_count: cd.coordinates.length,
        median_diff_m: cd.code === "11403" ? 0.53 : 0.67,
        p90_diff_m: cd.code === "11403" ? 1.02 : 38.02,
        max_diff_m: cd.code === "11403" ? 1.67 : 91.42,
        coordinates: cd.coordinates,
      };
    });
  }

  // Application State
  const state = {
    engine: "leaflet", // 'gmaps' | 'leaflet'
    apiKey: "",
    mapType: "roadmap",
    showNationalDistricts: true,
    showPdfOverlay: true,
    fillOpacity: 0.20,
    strokeWeight: 3.5,
    selectedDistrictCode: "11401",
    currentLod: "LOD-High",
    pin: {
      lat: 9.962166,
      lng: -84.048556,
      source: "manual",
      accuracyMeters: null,
      label: "Parque de Moravia",
    },
    lastResult: null,
    gmap: null,
    gmapObjects: {
      districtPolys: new Map(), // code -> google.maps.Polygon
      pdfPolys: [],
      pinMarker: null,
      accuracyCircle: null,
    },
    lmap: null,
    lmapObjects: {
      canvasRenderer: null,
      baseLayer: null,
      districtPolys: new Map(), // code -> { poly, isHighRes }
      activeHighlightPoly: null,
      pdfPolys: [],
      pinMarker: null,
      accuracyCircle: null,
    },
  };

  // ============================================================================
  // GEODESIC & GEOMETRY ENGINE (CRTM05, 2-STAGE BBOX + RAY-CASTING PIP)
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

  function pointInMultiRings(lat, lng, rings) {
    for (let r = 0; r < rings.length; r++) {
      if (pointInRing(lat, lng, rings[r])) return true;
    }
    return false;
  }

  function minDistanceToRingsMeters(lat, lng, rings) {
    const cosLat = Math.cos((lat * Math.PI) / 180.0);
    const mPerDegLat = 110574.0;
    const mPerDegLng = 111320.0 * cosLat;

    let minDistSq = Infinity;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
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
    }
    return Math.sqrt(minDistSq);
  }

  // Fast 2-Stage National Point-in-Polygon across all 487 districts + Hacienda PDF cross-check
  function evaluatePinLocation(lat, lng) {
    const t0 = performance.now();
    let matchedDistrict = null;
    let borderDistMeters = Infinity;
    let bboxCandidates = 0;

    // Stage 1: AABB Bounding-Box Filter across 487 districts
    for (let i = 0; i < ALL_DISTRICTS.length; i++) {
      const d = ALL_DISTRICTS[i];
      const bb = d.bbox;
      if (lng >= bb[0] && lat >= bb[1] && lng <= bb[2] && lat <= bb[3]) {
        bboxCandidates++;
        // Stage 2: Exact High-Res Ray-Casting
        const hiRings = getHighResRings(d);
        if (pointInMultiRings(lat, lng, hiRings)) {
          matchedDistrict = d;
          borderDistMeters = minDistanceToRingsMeters(lat, lng, hiRings);
          break;
        }
      }
    }

    // Also check Hacienda PDF Moravia polygons (11401, 11402, 11403)
    let matchedPdfMoravia = null;
    let pdfDistMeters = null;
    for (const code of ["11401", "11403", "11402"]) {
      const pm = PDF_MORAVIA[code];
      if (pm && pointInRing(lat, lng, pm.coordinates)) {
        matchedPdfMoravia = pm;
        pdfDistMeters = minDistanceToRingsMeters(lat, lng, [pm.coordinates]);
        break;
      }
    }

    const elapsedMs = performance.now() - t0;
    const crtm = wgs84ToCrtm05(lat, lng);

    return {
      lat,
      lng,
      crtm,
      district: matchedDistrict,
      borderDistMeters,
      pdfMoravia: matchedPdfMoravia,
      pdfDistMeters,
      elapsedMs,
      bboxCandidates,
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

    // Update URL query string without reloading
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("lat", lat.toFixed(6));
      url.searchParams.set("lng", lng.toFixed(6));
      window.history.replaceState({}, "", url.toString());
    } catch (_) {}

    // Update HUD performance stats
    const perfEl = document.getElementById("hud-perf-stats");
    if (perfEl) {
      perfEl.textContent = `⚡ PIP 487 Distritos: ${result.elapsedMs.toFixed(2)} ms (${result.bboxCandidates} cand. AABB) · ${state.currentLod}`;
    }

    // Update Hero UI Card
    document.getElementById("res-pin-coords").textContent = `${lat.toFixed(6)}°, ${lng.toFixed(6)}°`;
    document.getElementById("res-pin-crtm").textContent = `CRTM05: E ${result.crtm.e.toFixed(1)}, N ${result.crtm.n.toFixed(1)}`;

    const alertBox = document.getElementById("res-boundary-alert");
    const alertText = document.getElementById("res-boundary-text");
    const cmpBox = document.getElementById("res-compare-box");
    const cmpBadge = document.getElementById("res-compare-badge");
    const cmpDetail = document.getElementById("res-compare-detail");

    if (result.district) {
      state.selectedDistrictCode = result.district.code;
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

      // Check if in Moravia or if PDF Moravia polygon also matched
      const pdfMatch = result.pdfMoravia;
      const gtIsMoravia = result.district.code.startsWith("114");
      if (gtIsMoravia || pdfMatch) {
        cmpBox.style.display = "block";
        const pm = PDF_MORAVIA[result.district.code] || pdfMatch;
        if (pdfMatch && pdfMatch.code === result.district.code) {
          cmpBadge.textContent = "✓ 100% Coincidente";
          cmpBadge.style.color = "#34d399";
          cmpDetail.innerHTML = `GeoTEC/IGN: <strong>${result.district.code} ${result.district.distritoName}</strong> (${result.district.area_km2} km²) · PDF Hacienda: <strong>${pm.code} ${pm.name}</strong> (${pm.area_km2} km² · desv. mediana <strong>${pm.median_diff_m} m</strong>)`;
        } else if (pdfMatch && pdfMatch.code !== result.district.code) {
          cmpBadge.textContent = "⚠️ Franja Limítrofe PDF vs GeoTEC";
          cmpBadge.style.color = "#f59e0b";
          cmpDetail.innerHTML = `En GeoTEC/IGN este punto cae en <strong>${result.district.code} ${result.district.distritoName}</strong>, mientras que en el PDF de Hacienda cae en <strong>${pdfMatch.code} ${pdfMatch.name}</strong> (a ${Math.round(result.borderDistMeters)} m del borde).`;
        } else {
          cmpBadge.textContent = "⚠️ Franja Borde (GeoTEC vs PDF)";
          cmpBadge.style.color = "#f59e0b";
          cmpDetail.innerHTML = `Dentro de <strong>${result.district.code} ${result.district.distritoName}</strong> en GeoTEC/IGN, pero a pocos metros fuera del polígono del PDF de Hacienda.`;
        }
      } else {
        cmpBox.style.display = "block";
        cmpBadge.textContent = "Cobertura Nacional IGN/GeoTEC";
        cmpBadge.style.color = "#38bdf8";
        cmpDetail.innerHTML = `Distrito <strong>${result.district.code} ${result.district.distritoName}</strong> (${result.district.cantonName}, ${result.district.provinciaName}) · Área oficial: <strong>${result.district.area_km2} km²</strong> · Perímetro: ${result.district.perimeter_km} km`;
      }
    } else {
      state.selectedDistrictCode = null;
      document.getElementById("res-postal-code").textContent = "Fuera CR";
      document.getElementById("res-postal-code").style.color = "#f59e0b";
      document.getElementById("res-provincia").textContent = "Fuera de Costa Rica";
      document.getElementById("res-provincia-code").textContent = "Sin provincia";
      document.getElementById("res-canton").textContent = "Océano / Exterior";
      document.getElementById("res-canton-code").textContent = "—";
      document.getElementById("res-distrito").textContent = "Mové el Pin";
      document.getElementById("res-distrito-code").textContent = "a territorio CR";

      alertBox.className = "boundary-alert near";
      alertText.textContent = `📍 El pin está fuera del territorio continental/insular de los 487 distritos de Costa Rica.`;
      cmpBox.style.display = "none";
    }

    syncPinOnMap(panMap);
    syncMapStyles();
    populateCodeSnippet();
  }

  function syncPinOnMap(panMap = false) {
    const { lat, lng, accuracyMeters } = state.pin;
    const res = state.lastResult;
    const popupHtml =
      res && res.district
        ? `<div style="font-family:Inter,sans-serif;font-size:12px;color:#0f172a;">
             <strong style="font-size:14px;color:#0284c7;">CP ${res.district.code} — ${res.district.distritoName}</strong><br/>
             Cantón ${res.district.cantonName}, Provincia ${res.district.provinciaName}<br/>
             Área: ${res.district.area_km2} km² · A ${Math.round(res.borderDistMeters).toLocaleString()} m del borde<br/>
             <span style="font-size:10.5px;color:#64748b;">(${lat.toFixed(5)}, ${lng.toFixed(5)}) — Arrastrá el pin para ajustar</span>
           </div>`
        : `<div style="font-family:Inter,sans-serif;font-size:12px;color:#0f172a;">
             <strong>Pin fuera del territorio de Costa Rica</strong><br/>
             (${lat.toFixed(5)}, ${lng.toFixed(5)})
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
        if (state.gmap.getZoom() < 13 && res && res.district) state.gmap.setZoom(14);
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
          state.lmap.setView([lat, lng], Math.max(state.lmap.getZoom(), 14));
        } else {
          state.lmap.setView([lat, lng], 8);
        }
      }
    }
  }

  // ============================================================================
  // SIDEBAR & CONTROLS
  // ============================================================================
  function initSidebar() {
    renderDistrictsList("");

    document.getElementById("district-search").addEventListener("input", (e) => {
      renderDistrictsList(e.target.value.trim().toLowerCase());
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
        setStatusBanner("manual", `📌 Punto seleccionado: <strong>${label}</strong>`);
        setPinLocation(lat, lng, "manual", null, label, true);
        if (label.includes("49m") && state.lmap) {
          state.lmap.setView([lat, lng], 17);
        }
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
    document.getElementById("chk-national").addEventListener("change", (e) => {
      state.showNationalDistricts = e.target.checked;
      syncMapStyles();
    });

    document.getElementById("chk-pdf-overlay").addEventListener("change", (e) => {
      state.showPdfOverlay = e.target.checked;
      syncMapStyles();
    });

    // Camera fit buttons
    document.getElementById("btn-fit-sv").addEventListener("click", () => {
      fitMoraviaBounds();
    });
    document.getElementById("btn-fit-cr").addEventListener("click", () => {
      fitCostaRicaBounds();
    });

    // Modals
    document.getElementById("btn-open-compare").addEventListener("click", () => {
      document.getElementById("compare-modal").classList.add("open");
    });
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

  function renderDistrictsList(filter) {
    const container = document.getElementById("districts-list");
    const countLabel = document.getElementById("districts-count-label");
    if (!container) return;
    container.innerHTML = "";

    let filtered;
    if (!filter) {
      // Put Moravia districts first, then active district, then rest of Costa Rica
      const moravia = ALL_DISTRICTS.filter((d) => d.code.startsWith("114"));
      const others = ALL_DISTRICTS.filter((d) => !d.code.startsWith("114"));
      filtered = [...moravia, ...others];
      if (countLabel) countLabel.textContent = `487 distritos (mostrando 60)`;
    } else {
      filtered = ALL_DISTRICTS.filter((d) => d._searchKey.includes(filter));
      if (countLabel) countLabel.textContent = `${filtered.length} de 487 distritos`;
    }

    const slice = filtered.slice(0, 60);
    slice.forEach((d) => {
      const item = document.createElement("div");
      const isMoravia = d.code.startsWith("114");
      item.className = "zone-item" + (state.selectedDistrictCode === d.code ? " active" : "");
      item.innerHTML = `
        <div class="zone-left">
          <span class="zone-swatch" style="background:${d.color}"></span>
          <div>
            <div class="zone-code">CP ${d.code} ${isMoravia ? "· ★ Moravia" : ""}</div>
            <div class="zone-name">${d.distritoName} (${d.cantonName})</div>
          </div>
        </div>
        <div class="zone-right">
          <div class="zone-val">${d.provinciaName}</div>
          <div class="zone-area">${d.area_km2} km²</div>
        </div>
      `;
      item.addEventListener("click", () => {
        setStatusBanner(
          "manual",
          `📌 Distrito seleccionado: <strong>${d.code} — ${d.distritoName} (${d.cantonName}, ${d.provinciaName})</strong>`
        );
        setPinLocation(d.centroid.lat, d.centroid.lng, "manual", null, d.distritoName, true);
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
  // MULTI-LOD GEOMETRIC TRICK: VIEWPORT & ZOOM-DEPENDENT GEOMETRY SWAPPING
  // ============================================================================
  function bboxIntersectsBounds(bb, west, south, east, north) {
    // bb = [minLng, minLat, maxLng, maxLat]
    return !(bb[2] < west || bb[0] > east || bb[3] < south || bb[1] > north);
  }

  function updateLeafletLodGeometries() {
    if (!state.lmap) return;
    const zoom = state.lmap.getZoom();
    const bounds = state.lmap.getBounds();
    const west = bounds.getWest();
    const south = bounds.getSouth();
    const east = bounds.getEast();
    const north = bounds.getNorth();

    const useHighResInViewport = zoom >= 12;
    let highResCount = 0;

    ALL_DISTRICTS.forEach((d) => {
      const entry = state.lmapObjects.districtPolys.get(d.code);
      if (!entry) return;
      const shouldBeHigh =
        d.code === state.selectedDistrictCode ||
        (useHighResInViewport && bboxIntersectsBounds(d.bbox, west, south, east, north));

      if (shouldBeHigh && !entry.isHighRes) {
        entry.poly.setLatLngs(getHighResLatLngs(d));
        entry.isHighRes = true;
      } else if (!shouldBeHigh && entry.isHighRes) {
        entry.poly.setLatLngs(d._loLatLngs);
        entry.isHighRes = false;
      }
      if (entry.isHighRes) highResCount++;
    });

    state.currentLod = useHighResInViewport
      ? `LOD-High (${highResCount} dist. en vista)`
      : `LOD-Low (Vista Nacional 60fps)`;
    const badge = document.getElementById("lod-status-badge");
    if (badge) {
      badge.textContent = useHighResInViewport ? `LOD-High (z=${zoom})` : `LOD-Low (z=${zoom})`;
      badge.style.color = useHighResInViewport ? "#34d399" : "#38bdf8";
    }
  }

  // ============================================================================
  // ENGINE 1: GOOGLE MAPS PLATFORM JAVASCRIPT SDK
  // ============================================================================
  window.gm_authFailure = function () {
    console.warn("Google Maps authentication/billing failure detected. Falling back to interactive map engine.");
    const pill = document.getElementById("engine-status-pill");
    pill.textContent = "Google Tiles + Canvas LOD";
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

    const gmapType =
      state.mapType === "dark" || state.mapType === "voyager" ? "roadmap" : state.mapType;

    state.gmap = new google.maps.Map(container, {
      center: { lat: state.pin.lat, lng: state.pin.lng },
      zoom: 14,
      mapTypeId: gmapType,
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

    state.gmapObjects.districtPolys.clear();
    state.gmapObjects.pdfPolys = [];
    state.gmapObjects.pinMarker = null;

    // Create 487 District Polygons using LOD-Low initially
    ALL_DISTRICTS.forEach((d) => {
      const loPaths = d._rawLo.map(decodeDeltaRing);
      const poly = new google.maps.Polygon({
        paths: loPaths,
        strokeColor: d.color,
        strokeOpacity: 0.75,
        strokeWeight: 1.2,
        fillColor: d.color,
        fillOpacity: state.fillOpacity * 0.65,
        map: state.showNationalDistricts ? state.gmap : null,
        zIndex: 2,
      });
      poly.addListener("click", (e) => {
        if (e.latLng) {
          setStatusBanner("manual", `📌 Pin colocado en <strong>${d.code} — ${d.distritoName} (${d.cantonName})</strong>.`);
          setPinLocation(e.latLng.lat(), e.latLng.lng(), "manual", null, d.distritoName, false);
        }
      });
      poly.addListener("mousemove", (e) => {
        if (e.latLng) updateCursorCoordinates(e.latLng.lat(), e.latLng.lng());
      });
      state.gmapObjects.districtPolys.set(d.code, poly);
    });

    // Hacienda PDF Moravia Overlay Polygons
    Object.values(PDF_MORAVIA).forEach((pm) => {
      const poly = new google.maps.Polygon({
        paths: pm.coordinates,
        strokeColor: "#f43f5e",
        strokeOpacity: 0.95,
        strokeWeight: 2.2,
        fillOpacity: 0.0,
        clickable: false,
        map: state.showPdfOverlay ? state.gmap : null,
        zIndex: 12,
      });
      state.gmapObjects.pdfPolys.push(poly);
    });

    syncPinOnMap(false);
    syncMapStyles();
  }

  // ============================================================================
  // ENGINE 2: HARDWARE-ACCELERATED CANVAS MULTI-LOD ENGINE (LEAFLET + GOOGLE TILES)
  // ============================================================================
  function initLeafletFallback() {
    const container = document.getElementById("leaflet-container");

    // Shared HTML5 Canvas renderer so all 487 districts draw in < 6ms on a single canvas!
    const canvasRenderer = L.canvas({ padding: 0.5 });
    state.lmapObjects.canvasRenderer = canvasRenderer;

    state.lmap = L.map(container, {
      center: [state.pin.lat, state.pin.lng],
      zoom: 14,
      zoomControl: true,
      preferCanvas: true,
      renderer: canvasRenderer,
    });

    updateLeafletTileLayer();

    state.lmap.on("mousemove", (e) => {
      updateCursorCoordinates(e.latlng.lat, e.latlng.lng);
    });

    state.lmap.on("click", (e) => {
      setStatusBanner("manual", "📌 Pin colocado manualmente en el mapa.");
      setPinLocation(e.latlng.lat, e.latlng.lng, "manual", null, "Pin en mapa", false);
    });

    state.lmap.on("zoomend moveend", () => {
      updateLeafletLodGeometries();
      syncMapStyles(false);
    });

    // 1. Render all 487 Costa Rica districts on the shared Canvas layer
    ALL_DISTRICTS.forEach((d) => {
      const poly = L.polygon(d._loLatLngs, {
        renderer: canvasRenderer,
        color: d.color,
        weight: 1.2,
        opacity: 0.75,
        fillColor: d.color,
        fillOpacity: state.fillOpacity * 0.65,
      });
      poly.bindTooltip(
        `<strong>CP ${d.code} — ${d.distritoName}</strong><br/>Cantón ${d.cantonName}, ${d.provinciaName} (${d.area_km2} km²)`,
        { sticky: true }
      );
      poly.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        setStatusBanner(
          "manual",
          `📌 Pin colocado en <strong>${d.code} — ${d.distritoName} (${d.cantonName})</strong>.`
        );
        setPinLocation(e.latlng.lat, e.latlng.lng, "manual", null, d.distritoName, false);
      });
      if (state.showNationalDistricts) poly.addTo(state.lmap);
      state.lmapObjects.districtPolys.set(d.code, { poly, isHighRes: false });
    });

    // 2. Hacienda PDF Moravia Overlay Polygons (11401, 11402, 11403) in dashed rose (#f43f5e)
    Object.values(PDF_MORAVIA).forEach((pm) => {
      const latlngs = pm.coordinates.map((pt) => [pt.lat, pt.lng]);
      const pdfPoly = L.polygon(latlngs, {
        renderer: canvasRenderer,
        color: "#f43f5e",
        weight: 2.2,
        dashArray: "7, 5",
        fillOpacity: 0.0,
        interactive: false,
      });
      if (state.showPdfOverlay) pdfPoly.addTo(state.lmap);
      state.lmapObjects.pdfPolys.push(pdfPoly);
    });

    updateLeafletLodGeometries();
    fitMoraviaBounds();
  }

  function updateLeafletTileLayer() {
    if (!state.lmap) return;
    if (state.lmapObjects.baseLayer) {
      state.lmap.removeLayer(state.lmapObjects.baseLayer);
    }

    if (state.mapType === "satellite") {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}&hl=es",
        { subdomains: "0123", maxZoom: 21, attribution: "Map data &copy; Google" }
      ).addTo(state.lmap);
    } else if (state.mapType === "hybrid") {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&hl=es",
        { subdomains: "0123", maxZoom: 21, attribution: "Map data &copy; Google" }
      ).addTo(state.lmap);
    } else if (state.mapType === "terrain") {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://mt{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}&hl=es",
        { subdomains: "0123", maxZoom: 20, attribution: "Map data &copy; Google" }
      ).addTo(state.lmap);
    } else if (state.mapType === "voyager") {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        { subdomains: "abcd", maxZoom: 20, attribution: "&copy; OpenStreetMap &copy; CARTO" }
      ).addTo(state.lmap);
    } else if (state.mapType === "dark") {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        { subdomains: "abcd", maxZoom: 20, attribution: "&copy; OpenStreetMap &copy; CARTO" }
      ).addTo(state.lmap);
    } else {
      state.lmapObjects.baseLayer = L.tileLayer(
        "https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=es",
        { subdomains: "0123", maxZoom: 21, attribution: "Map data &copy; Google" }
      ).addTo(state.lmap);
    }
  }

  function updateBaseMapType() {
    if (state.engine === "gmaps" && state.gmap) {
      const gmapType =
        state.mapType === "dark" || state.mapType === "voyager" ? "roadmap" : state.mapType;
      state.gmap.setMapTypeId(gmapType);
    } else {
      updateLeafletTileLayer();
    }
  }

  function syncMapStyles(refreshSidebar = true) {
    if (refreshSidebar) {
      const searchEl = document.getElementById("district-search");
      renderDistrictsList(searchEl ? searchEl.value.trim().toLowerCase() : "");
    }

    if (state.engine === "gmaps" && state.gmap) {
      ALL_DISTRICTS.forEach((d) => {
        const poly = state.gmapObjects.districtPolys.get(d.code);
        if (!poly) return;
        const isSel = state.selectedDistrictCode === d.code;
        if (!state.showNationalDistricts && !isSel) {
          poly.setMap(null);
          return;
        }
        poly.setMap(state.gmap);
        if (isSel) {
          poly.setPaths(getHighResRings(d));
          poly.setOptions({
            strokeColor: "#00e5ff",
            strokeWeight: state.strokeWeight,
            strokeOpacity: 1.0,
            fillColor: "#0ea5e9",
            fillOpacity: Math.min(0.65, state.fillOpacity + 0.12),
            zIndex: 10,
          });
        } else {
          poly.setOptions({
            strokeColor: d.color,
            strokeWeight: 1.1,
            strokeOpacity: 0.7,
            fillColor: d.color,
            fillOpacity: state.fillOpacity * 0.55,
            zIndex: 2,
          });
        }
      });

      state.gmapObjects.pdfPolys.forEach((p) => {
        p.setMap(state.showPdfOverlay ? state.gmap : null);
      });
    } else if (state.lmap) {
      const zoom = state.lmap.getZoom();
      const baseWeight = zoom <= 9 ? 0.7 : zoom <= 11 ? 1.0 : 1.4;

      ALL_DISTRICTS.forEach((d) => {
        const entry = state.lmapObjects.districtPolys.get(d.code);
        if (!entry) return;
        const isSel = state.selectedDistrictCode === d.code;

        if (!state.showNationalDistricts && !isSel) {
          if (state.lmap.hasLayer(entry.poly)) state.lmap.removeLayer(entry.poly);
          return;
        }
        if (!state.lmap.hasLayer(entry.poly)) entry.poly.addTo(state.lmap);

        if (isSel) {
          if (!entry.isHighRes) {
            entry.poly.setLatLngs(getHighResLatLngs(d));
            entry.isHighRes = true;
          }
          entry.poly.setStyle({
            color: "#00e5ff",
            weight: state.strokeWeight,
            opacity: 1.0,
            fillColor: "#0ea5e9",
            fillOpacity: Math.min(0.65, state.fillOpacity + 0.12),
          });
          entry.poly.bringToFront();
        } else {
          entry.poly.setStyle({
            color: d.color,
            weight: baseWeight,
            opacity: zoom <= 9 ? 0.55 : 0.75,
            fillColor: d.color,
            fillOpacity: state.fillOpacity * 0.55,
          });
        }
      });

      state.lmapObjects.pdfPolys.forEach((p) => {
        if (state.showPdfOverlay) {
          if (!state.lmap.hasLayer(p)) p.addTo(state.lmap);
          p.bringToFront();
        } else {
          if (state.lmap.hasLayer(p)) state.lmap.removeLayer(p);
        }
      });
    }
  }

  function fitMoraviaBounds() {
    const sv = DISTRICT_BY_CODE.get("11401");
    if (!sv) return;
    const bb = sv.bbox; // [minLng, minLat, maxLng, maxLat]
    if (state.engine === "gmaps" && state.gmap) {
      const bounds = new google.maps.LatLngBounds(
        { lat: bb[1], lng: bb[0] },
        { lat: bb[3], lng: bb[2] }
      );
      state.gmap.fitBounds(bounds, 35);
    } else if (state.lmap) {
      state.lmap.fitBounds(
        [
          [bb[1], bb[0]],
          [bb[3], bb[2]],
        ],
        { padding: [30, 30] }
      );
    }
  }

  function fitCostaRicaBounds() {
    // Mainland Costa Rica bounding box (8.03° N to 11.22° N, -85.95° W to -82.55° W)
    const south = 8.03,
      north = 11.22,
      west = -85.95,
      east = -82.55;
    if (state.engine === "gmaps" && state.gmap) {
      const bounds = new google.maps.LatLngBounds({ lat: south, lng: west }, { lat: north, lng: east });
      state.gmap.fitBounds(bounds, 20);
    } else if (state.lmap) {
      state.lmap.fitBounds(
        [
          [south, west],
          [north, east],
        ],
        { padding: [20, 20] }
      );
    }
  }

  // Developer Exports
  function downloadGeoJson() {
    const sel = DISTRICT_BY_CODE.get(state.selectedDistrictCode || "11401") || ALL_DISTRICTS[0];
    const hiRings = getHighResRings(sel);
    const fc = {
      type: "FeatureCollection",
      name: `Distrito_${sel.code}_${sel.distritoName.replace(/\s+/g, "_")}`,
      features: [
        {
          type: "Feature",
          id: sel.code,
          properties: {
            codigo_postal: sel.code,
            codigo_distrito: sel.code,
            provincia: sel.provinciaName,
            canton: sel.cantonName,
            distrito: sel.distritoName,
            area_km2: sel.area_km2,
            perimeter_km: sel.perimeter_km,
            fuente: "IGN / SNIT / GeoTEC + PorCostaRica.com",
          },
          geometry: {
            type: hiRings.length === 1 ? "Polygon" : "MultiPolygon",
            coordinates:
              hiRings.length === 1
                ? [hiRings[0].map((pt) => [pt.lng, pt.lat])]
                : hiRings.map((r) => [r.map((pt) => [pt.lng, pt.lat])]),
          },
        },
      ],
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: "application/geo+json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `distrito_${sel.code}.geojson`;
    link.click();
  }

  function populateCodeSnippet() {
    const sel = DISTRICT_BY_CODE.get(state.selectedDistrictCode || "11401") || ALL_DISTRICTS[0];
    const hiRings = getHighResRings(sel);
    const firstRing = hiRings[0] || [];
    const sampleCoords = firstRing
      .slice(0, 5)
      .map((c) => `  { lat: ${c.lat.toFixed(5)}, lng: ${c.lng.toFixed(5)} }`)
      .join(",\n");

    const snippet = `// Google Maps JavaScript API v3 — Distrito ${sel.code}: ${sel.distritoName} (${sel.cantonName}, ${sel.provinciaName})
// Fuente: GeoTEC / IGN-SNIT (487 Distritos de Costa Rica) | Área: ${sel.area_km2} km²

async function initDistrictMap() {
  const { Map } = await google.maps.importLibrary("maps");

  const map = new Map(document.getElementById("map"), {
    center: { lat: ${sel.centroid.lat}, lng: ${sel.centroid.lng} },
    zoom: 14,
  });

  const districtCoords = [
${sampleCoords},
  // ... (${firstRing.length} vértices en resolución LOD-High)
  ];

  const districtPolygon = new google.maps.Polygon({
    paths: districtCoords,
    strokeColor: "#00e5ff",
    strokeOpacity: 1.0,
    strokeWeight: 3.5,
    fillColor: "#0ea5e9",
    fillOpacity: 0.22,
    map,
  });
}`;
    const el = document.getElementById("dev-code-snippet");
    if (el) el.textContent = snippet;
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
      if (window.location.protocol === "https:" || window.location.hostname === "localhost") {
        requestGpsLocation(true);
      }
    }

    if (state.apiKey) {
      bootGoogleMaps(state.apiKey);
    }
  });
})();
