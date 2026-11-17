(function () {
  "use strict";

  // ---------- Services (free OpenStreetMap-based; swap for keyed providers before heavy public use) ----------
  var GEOCODE_URL = "https://nominatim.openstreetmap.org/search";
  var ROUTE_URL = "https://router.project-osrm.org/route/v1/driving/";
  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";

  var CATS = {
    must:       { label: "Must-sees",     emo: "⭐" },
    town:       { label: "Towns",         emo: "🏘️", color: "#4f6b52" },
    lookout:    { label: "Lookouts",      emo: "🔭", color: "#2f6f8f" },
    nature:     { label: "Nature",        emo: "🌿", color: "#3f8a4f" },
    attraction: { label: "Attractions",   emo: "🎯", color: "#c2522d" },
    museum:     { label: "Museums & art", emo: "🏛️", color: "#7a4f9a" },
    history:    { label: "History",       emo: "📜", color: "#8a6a3a" },
    family:     { label: "Zoos & parks",  emo: "🦘", color: "#d08a1e" }
  };

  var $ = function (id) { return document.getElementById(id); };
  var S = {
    from: null, to: null, geoFrom: null,
    base: null,          // base route (no added stops): {coords, cum, distance, duration}
    current: null,       // route actually shown (with added stops)
    pois: [], selected: {}, filter: "all",
    servos: [], servosLoaded: false, prices: {}
  };

  // ---------- Map ----------
  var map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([-28.5, 134], 4);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  var routeLayer = L.layerGroup().addTo(map);
  var poiLayer = L.layerGroup().addTo(map);
  var allServoLayer = L.layerGroup();
  var servoLayer = L.layerGroup().addTo(map);
  var poiMarkers = {};

  // ---------- Helpers ----------
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function setStatus(msg, isErr) { var s = $("status"); s.textContent = msg || ""; s.className = "status" + (isErr ? " error" : ""); }
  function km(n) { return Math.round(n).toLocaleString("en-AU") + " km"; }
  function dur(sec) {
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    return h ? h + "h " + (m < 10 ? "0" : "") + m + "m" : m + " min";
  }
  var aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

  function hav(a, b) {
    var R = 6371, r = Math.PI / 180;
    var dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function cumulative(coords) {
    var c = [0];
    for (var i = 1; i < coords.length; i++) c.push(c[i - 1] + hav(coords[i - 1], coords[i]));
    return c;
  }
  // Thin a line so consecutive points are at least `stepKm` apart (always keeps both ends).
  function thin(coords, cum, stepKm) {
    var outC = [coords[0]], outCum = [0], next = stepKm;
    for (var i = 1; i < coords.length - 1; i++) {
      if (cum[i] >= next) { outC.push(coords[i]); outCum.push(cum[i]); next = cum[i] + stepKm; }
    }
    outC.push(coords[coords.length - 1]); outCum.push(cum[cum.length - 1]);
    return { coords: outC, cum: outCum };
  }
  // Distance (km) from point p to the polyline, and how far along the line the nearest point is.
  function locate(p, coords, cum) {
    var r = Math.PI / 180, kx = 111.32 * Math.cos(p[0] * r), ky = 110.57;
    var best = { off: Infinity, along: 0 };
    for (var i = 1; i < coords.length; i++) {
      var a = coords[i - 1], b = coords[i];
      var ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
      var bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
      var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      var t = L2 ? -(ax * dx + ay * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var x = ax + t * dx, y = ay + t * dy, d = Math.sqrt(x * x + y * y);
      if (d < best.off) best = { off: d, along: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
    }
    return best;
  }

  // ---------- Services ----------
  var STATE_ABBR = { "South Australia": "SA", "Victoria": "VIC", "New South Wales": "NSW", "Queensland": "QLD", "Western Australia": "WA",
    "Tasmania": "TAS", "Northern Territory": "NT", "Australian Capital Territory": "ACT" };
  function abbr(st) { return STATE_ABBR[st] || st || ""; }

  // Fallback when nothing was picked from the suggestions
  async function geocode(q) {
    var url = GEOCODE_URL + "?format=jsonv2&limit=1&addressdetails=1&countrycodes=au&q=" + encodeURIComponent(q);
    var res = await fetch(url, { headers: { "Accept-Language": "en-AU" } });
    if (!res.ok) throw new Error("Place search is busy. Give it a few seconds and try again.");
    var j = await res.json();
    if (!j.length) throw new Error("Couldn't find \"" + q + "\" in Australia. Pick an option from the list as you type, or add the suburb and state.");
    var a = j[0].address || {};
    var street = [a.house_number, a.road].filter(Boolean).join(" ");
    var town = a.suburb || a.town || a.city || a.village || a.hamlet || "";
    var name = (j[0].name && j[0].name !== a.road ? j[0].name : street) || town || String(j[0].display_name).split(",")[0];
    if (town && name !== town) name += ", " + town;
    return { lat: +j[0].lat, lon: +j[0].lon, name: name };
  }

  // Suggestions as you type: addresses, streets, businesses and towns (Photon, built on OpenStreetMap)
  var PHOTON_URL = "https://photon.komoot.io/api/";
  function photonLabel(pr) {
    var street = [pr.housenumber, pr.street].filter(Boolean).join(" ");
    var title = pr.name && pr.name !== pr.street ? pr.name : (street || pr.name || "");
    var town = pr.city || pr.town || pr.village || pr.district || pr.locality || pr.county || "";
    var sub = [];
    if (pr.name && pr.name !== pr.street && street) sub.push(street);
    if (town && town !== title) sub.push(town);
    var st = [abbr(pr.state), pr.postcode].filter(Boolean).join(" ");
    if (st) sub.push(st);
    return { title: title, sub: sub.join(", "), short: title + (town && town !== title ? ", " + town : "") };
  }

  var picks = { from: null, to: null };
  function setupSuggest(key) {
    var input = $(key), list = $(key + "List"), timer = null, ctrl = null, feats = [], hl = -1;
    function hide() { list.hidden = true; hl = -1; }
    function choose(i) {
      var f = feats[i]; if (!f) return;
      var lab = photonLabel(f.properties);
      picks[key] = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name: lab.short, text: lab.short };
      input.value = lab.short;
      if (key === "from") S.geoFrom = null;
      hide(); save();
    }
    async function search(q) {
      try {
        if (ctrl) ctrl.abort();
        ctrl = new AbortController();
        var c = map.getCenter();
        var url = PHOTON_URL + "?limit=7&lang=en&bbox=112.9,-43.7,153.7,-10.6&lat=" + c.lat.toFixed(3) + "&lon=" + c.lng.toFixed(3) +
          "&q=" + encodeURIComponent(q);
        var res = await fetch(url, { signal: ctrl.signal });
        var j = await res.json();
        feats = (j.features || []).filter(function (f) { return f.properties && f.properties.countrycode === "AU"; });
        hl = -1;
        list.innerHTML = feats.map(function (f, i) {
          var lab = photonLabel(f.properties);
          return '<li role="option" data-i="' + i + '"><b>' + esc(lab.title) + "</b><small>" + esc(lab.sub) + "</small></li>";
        }).join("");
        list.hidden = !feats.length || document.activeElement !== input;
      } catch (e) { /* aborted or offline: keep typing works with the fallback search */ }
    }
    input.addEventListener("input", function () {
      picks[key] = null;
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 3 || q === "My location") { hide(); return; }
      timer = setTimeout(function () { search(q); }, 300);
    });
    input.addEventListener("keydown", function (e) {
      if (list.hidden) return;
      var items = list.querySelectorAll("li");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        hl = (hl + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach(function (li, i) { li.classList.toggle("hl", i === hl); });
      } else if (e.key === "Enter" && hl >= 0) { e.preventDefault(); choose(hl); }
      else if (e.key === "Escape") hide();
    });
    // pointerdown fires before the input loses focus, so the tap always lands
    list.addEventListener("pointerdown", function (e) {
      var li = e.target.closest("li"); if (!li) return;
      e.preventDefault(); choose(+li.dataset.i);
    });
    input.addEventListener("blur", function () { setTimeout(hide, 150); });
  }

  async function getRoute(points) {
    var path = points.map(function (p) { return p.lon.toFixed(5) + "," + p.lat.toFixed(5); }).join(";");
    var res = await fetch(ROUTE_URL + path + "?overview=full&geometries=geojson&steps=false");
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok || j.code !== "Ok" || !j.routes || !j.routes.length) {
      throw new Error("Couldn't find a driving route between those places.");
    }
    var rt = j.routes[0];
    var coords = rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
    return { coords: coords, cum: cumulative(coords), distance: rt.distance / 1000, duration: rt.duration };
  }

  var OVERPASS_URLS = [OVERPASS_URL, "https://overpass.private.coffee/api/interpreter"];

  async function overpass(q, busyMsg) {
    for (var i = 0; i < OVERPASS_URLS.length; i++) {
      try {
        var res = await fetch(OVERPASS_URLS[i], {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: "data=" + encodeURIComponent(q)
        });
        if (!res.ok) continue;
        var j = await res.json();
        // Overpass reports timeouts inside a normal-looking response; treat those as failures, not "nothing found"
        if (j.remark && /timed out|runtime error|out of memory/i.test(j.remark)) continue;
        return j.elements || [];
      } catch (e) { /* try the next server */ }
    }
    throw new Error(busyMsg);
  }

  // Boxes that hug the route (south, west, north, east), padded by padKm.
  function corridorBoxes(route, padKm, maxBoxes) {
    var total = route.cum[route.cum.length - 1];
    var chunk = Math.max(30, total / maxBoxes), next = chunk, boxes = [], b = null;
    var padLat = padKm / 110.57;
    for (var i = 0; i < route.coords.length; i++) {
      var c = route.coords[i];
      if (!b) b = [c[0], c[1], c[0], c[1]];
      b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
      if (route.cum[i] >= next || i === route.coords.length - 1) {
        var padLon = padKm / (111.32 * Math.cos(c[0] * Math.PI / 180));
        boxes.push([b[0] - padLat, b[1] - padLon, b[2] + padLat, b[3] + padLon].map(function (n) { return n.toFixed(4); }).join(","));
        b = [c[0], c[1], c[0], c[1]];
        next = route.cum[i] + chunk;
      }
    }
    return boxes;
  }

  async function getStops(radiusKm) {
    var boxes = corridorBoxes(S.base, radiusKm, 30);
    var q = "[out:json][timeout:40];(" + boxes.map(function (bb) {
      return 'nwr["tourism"~"^(attraction|viewpoint|museum|gallery|zoo|aquarium|theme_park)$"]["name"](' + bb + ");" +
        'nwr["historic"~"^(monument|memorial|ruins|heritage|castle|fort)$"]["name"]["wikidata"](' + bb + ");" +
        'nwr["waterway"="waterfall"]["name"](' + bb + ");" +
        'nwr["natural"~"^(beach|cave_entrance|peak)$"]["name"]["wikidata"](' + bb + ");" +
        'node["place"~"^(town|city)$"]["name"](' + bb + ");";
    }).join("") + ");out center tags;";
    return overpass(q, "The stops finder is busy right now.");
  }

  // ---------- Every servo, cached in half-degree map cells ----------
  var CELL = 0.5, cells = {}, servoIndex = {}, nearKeys = {}, fetchChain = Promise.resolve();
  function cellOf(lat, lon) { return Math.floor(lat / CELL) + ":" + Math.floor(lon / CELL); }
  function cellBox(k) { var p = k.split(":").map(Number); return [p[0] * CELL, p[1] * CELL, (p[0] + 1) * CELL, (p[1] + 1) * CELL].join(","); }

  function addServoEl(el) {
    var lat = el.lat != null ? el.lat : el.center && el.center.lat;
    var lon = el.lon != null ? el.lon : el.center && el.center.lon;
    if (lat == null || lon == null) return;
    var id = el.type + el.id;
    if (servoIndex[id]) return;
    var nk = lat.toFixed(3) + "," + lon.toFixed(3); // same servo mapped as a point and a building
    if (nearKeys[nk]) return;
    nearKeys[nk] = 1;
    var t = el.tags || {}, brand = t.brand || "", name = t.name || brand || "Servo";
    if (brand && name.toLowerCase().indexOf(brand.toLowerCase()) === -1) name = brand + " " + name;
    servoIndex[id] = { id: id, name: name, lat: lat, lon: lon, tags: t, town: t["addr:suburb"] || t["addr:city"] || "", h24: t.opening_hours === "24/7" };
  }

  // Load the servos for a set of cells (skipping ones already loaded), a batch at a time so the server isn't swamped.
  function fetchCells(keys) {
    if (bundleReady) return Promise.resolve();
    var need = keys.filter(function (k) { return !cells[k]; });
    for (var i = 0; i < need.length; i += 30) {
      (function (batch) {
        var q = "[out:json][timeout:30];(" + batch.map(function (k) { return 'nwr["amenity"="fuel"](' + cellBox(k) + ");"; }).join("") + ");out center tags;";
        var p = fetchChain.then(function () { return overpass(q, "The servo finder is busy right now."); })
          .then(function (els) { els.forEach(addServoEl); },
                function (e) { batch.forEach(function (k) { delete cells[k]; }); throw e; });
        fetchChain = p.catch(function () {});
        batch.forEach(function (k) { cells[k] = p; });
      })(need.slice(i, i + 30));
    }
    return Promise.all(keys.map(function (k) { return cells[k]; }));
  }

  function routeCells(route) {
    var keys = {}, pad = 0.02;
    thin(route.coords, route.cum, 3).coords.forEach(function (c) {
      [-pad, pad].forEach(function (a) { [-pad, pad].forEach(function (b) { keys[cellOf(c[0] + a, c[1] + b)] = 1; }); });
    });
    return Object.keys(keys);
  }

  function fuelsSold(t) {
    var map = { "fuel:octane_91": "ULP", "fuel:e10": "E10", "fuel:octane_95": "95", "fuel:octane_98": "98", "fuel:diesel": "Diesel", "fuel:lpg": "LPG" };
    return Object.keys(map).filter(function (k) { return t[k] === "yes"; }).map(function (k) { return map[k]; }).join(", ");
  }
  function servoPopup(s, extra) {
    var f = fuelsSold(s.tags);
    return "<b>" + esc(s.name) + "</b><br><small>" + (s.town ? esc(s.town) : "") + (s.h24 ? (s.town ? " · " : "") + "Open 24/7" : "") +
      (f ? "<br>Sells: " + f : "") + (extra ? "<br>" + extra : "") + "</small>";
  }

  // ---------- Saved servo list (servos.json, rebuilt weekly by GitHub Actions) ----------
  // Downloaded once and kept on the phone, so finding fuel stops is instant and doesn't need the map server.
  var bundleReady = false, bundleVersion = null;
  function idb() {
    return new Promise(function (res, rej) {
      try {
        var r = indexedDB.open("roadtrip", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
  }
  async function idbGet(k) {
    var db = await idb();
    return new Promise(function (res, rej) {
      var q = db.transaction("kv").objectStore("kv").get(k);
      q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); };
    });
  }
  async function idbSet(k, v) {
    var db = await idb();
    return new Promise(function (res, rej) {
      var tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(v, k);
      tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); };
    });
  }

  var FUEL_BITS = [["fuel:octane_91", 1], ["fuel:e10", 2], ["fuel:octane_95", 4], ["fuel:octane_98", 8], ["fuel:diesel", 16], ["fuel:lpg", 32]];
  function loadBundle(data) {
    var ix = {}, idx = {};
    data.cols.forEach(function (k, i) { ix[k] = i; });
    data.rows.forEach(function (r) {
      var t = { name: r[ix.name] };
      if (r[ix.street]) t["addr:street"] = r[ix.street];
      if (r[ix.town]) t["addr:suburb"] = r[ix.town];
      if (r[ix.state]) t["addr:state"] = r[ix.state];
      if (r[ix.postcode]) t["addr:postcode"] = r[ix.postcode];
      FUEL_BITS.forEach(function (f) {
        if (r[ix.yes] & f[1]) t[f[0]] = "yes"; else if (r[ix.no] & f[1]) t[f[0]] = "no";
      });
      if (r[ix.h24]) t.opening_hours = "24/7";
      idx[r[ix.id]] = { id: r[ix.id], name: r[ix.name], lat: r[ix.lat], lon: r[ix.lon], tags: t, town: r[ix.town] || "", h24: !!r[ix.h24] };
    });
    servoIndex = idx;
    bundleReady = true;
    bundleVersion = data.v;
    allServoLayer.clearLayers(); allMarkers = {};
    var d = data.updated ? new Date(data.updated + "T00:00:00") : null;
    setDataStatus("⛽ " + data.rows.length.toLocaleString("en-AU") + " servos saved on this device" +
      (d ? " · updated " + d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "") + ".");
  }

  async function initServoData() {
    try { var saved = await idbGet("servos"); if (saved && saved.rows) loadBundle(saved); } catch (e) {}
    try {
      var meta = await (await fetch("servos-meta.json", { cache: "no-cache" })).json();
      if (!bundleReady || meta.v !== bundleVersion) {
        if (!bundleReady) setDataStatus("⛽ Downloading servo list…");
        var res = await fetch("servos.json", { cache: "no-cache" });
        if (!res.ok) throw new Error("no file");
        var data = await res.json();
        loadBundle(data);
        idbSet("servos", data).catch(function () {});
        if (S.current) loadServos(); // re-plan with the full list
      }
    } catch (e) {
      if (!bundleReady) setDataStatus("⛽ Finding servos live (no saved servo list yet).");
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  }

  // Grey dots for every known servo that isn't one of the route's servos
  var allMarkers = {};
  function syncAllServos() {
    var onRoute = {};
    S.servos.forEach(function (s) { onRoute[s.id] = 1; });
    Object.keys(servoIndex).forEach(function (id) {
      if (onRoute[id]) {
        if (allMarkers[id]) { allServoLayer.removeLayer(allMarkers[id]); delete allMarkers[id]; }
        return;
      }
      if (allMarkers[id]) return;
      var s = servoIndex[id];
      allMarkers[id] = L.circleMarker([s.lat, s.lon], { radius: 4, color: "#fff", weight: 1, fillColor: "#8c8580", fillOpacity: .9 })
        .bindPopup(function () { return servoPopup(s, "Off your route"); }).addTo(allServoLayer);
    });
  }

  // Show every servo once zoomed in, loading the area you're looking at
  var SHOW_ALL_ZOOM = 9, viewTimer = null;
  function onView() {
    var z = map.getZoom();
    if (z >= SHOW_ALL_ZOOM) { if (!map.hasLayer(allServoLayer)) allServoLayer.addTo(map); }
    else if (map.hasLayer(allServoLayer)) map.removeLayer(allServoLayer);
    if (z < SHOW_ALL_ZOOM) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(function () {
      var b = map.getBounds(), keys = {};
      for (var la = Math.floor(b.getSouth() / CELL); la <= Math.floor(b.getNorth() / CELL); la++)
        for (var lo = Math.floor(b.getWest() / CELL); lo <= Math.floor(b.getEast() / CELL); lo++) keys[la + ":" + lo] = 1;
      var list = Object.keys(keys);
      if (list.length > 16) return;
      fetchCells(list).then(syncAllServos, function () {});
    }, 400);
  }
  map.on("moveend zoomend", onView);

  // ---------- Servos & fuel plan ----------
  var FUEL_TAG = { ulp: "fuel:octane_91", e10: "fuel:e10", p95: "fuel:octane_95", p98: "fuel:octane_98", diesel: "fuel:diesel", lpg: "fuel:lpg" };
  var FUEL_NAME = { ulp: "unleaded", e10: "E10", p95: "premium 95", p98: "premium 98", diesel: "diesel", lpg: "LPG" };

  function vehicle() {
    var tank = parseFloat($("tank").value) || 0;
    var use = (parseFloat($("economy").value) || 0) * (1 + (parseFloat($("tow").value) || 0));
    return {
      tank: tank, use: use, type: $("fuelType").value,
      startL: tank * parseFloat($("startFuel").value),
      reserveL: tank * parseFloat($("reserve").value),
      price: parseFloat($("price").value) || 0
    };
  }

  function sells(tags, type) {
    var v = tags[FUEL_TAG[type]];
    if (v === "yes") return "yes";
    if (v === "no") return "no";
    return "unknown";
  }

  function processServos() {
    var r = S.current, near = thin(r.coords, r.cum, 0.3), out = [];
    var mnLa = Infinity, mnLo = Infinity, mxLa = -Infinity, mxLo = -Infinity;
    r.coords.forEach(function (c) { mnLa = Math.min(mnLa, c[0]); mxLa = Math.max(mxLa, c[0]); mnLo = Math.min(mnLo, c[1]); mxLo = Math.max(mxLo, c[1]); });
    Object.keys(servoIndex).forEach(function (id) {
      var s = servoIndex[id];
      if (s.lat < mnLa - .05 || s.lat > mxLa + .05 || s.lon < mnLo - .05 || s.lon > mxLo + .05) return;
      var loc = locate([s.lat, s.lon], near.coords, near.cum);
      if (loc.off > 1.5) return;
      out.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, tags: s.tags, town: s.town, h24: s.h24, along: loc.along, off: loc.off });
    });
    return out.sort(function (a, b) { return a.along - b.along; });
  }

  function servoPrice(s, v) { return S.prices[s.id] > 0 ? S.prices[s.id] : v.price; }

  // Every stop is a fill to full. Pick the stops that keep you above your reserve with the fewest stops,
  // and favour cheaper servos: each leg's fuel is costed at the servo you filled up at before it.
  var STOP_PENALTY = 4; // $-equivalent per extra stop, so it won't add a stop just to save a few cents
  function planFuel() {
    var v = vehicle();
    if (!(v.tank > 0) || !(v.use > 0) || !S.current) return null;
    var total = S.current.cum[S.current.cum.length - 1];
    var usable = v.tank - v.reserveL, range = usable / v.use * 100;
    var L = function (km) { return km * v.use / 100; };
    S.servos.forEach(function (s) {
      var sell = sells(s.tags, v.type);
      s.sell = sell;
      s.ok = sell === "yes" || (sell === "unknown" && v.type !== "lpg");
    });
    var st = S.servos.filter(function (s) { return s.ok && s.along > 0.5 && s.along < total - 0.5; });
    var price = function (s) { return servoPrice(s, v); };
    var nodes = [{ along: 0, start: true }].concat(st, [{ along: total, end: true }]);
    var n = nodes.length, best = [], prev = [];
    for (var k = 0; k < n; k++) { best.push(Infinity); prev.push(-1); }
    best[0] = 0;
    var startReach = Math.max(0, v.startL - v.reserveL) / v.use * 100;
    for (var i = 0; i < n - 1; i++) {
      if (best[i] === Infinity) continue;
      var reach = nodes[i].along + (i === 0 ? startReach : range);
      var legPrice = i === 0 ? v.price : price(nodes[i]);
      for (var j = i + 1; j < n && nodes[j].along <= reach + 1e-6; j++) {
        var c = best[i] + L(nodes[j].along - nodes[i].along) * legPrice + (nodes[j].end ? 0 : STOP_PENALTY);
        if (c < best[j] + 1e-9) { best[j] = c; prev[j] = i; } // on a tie, the later servo wins (no pointless early top-ups)
      }
    }
    var warnings = [], last = n - 1;
    if (best[n - 1] === Infinity) {
      // Can't make it: plan as far as possible, then warn about the gap
      last = 0;
      for (var q = 0; q < n - 1; q++) if (best[q] < Infinity && nodes[q].along >= nodes[last].along) last = q;
      var lr = nodes[last].along + (last === 0 ? startReach : range);
      warnings.push(gapWarning(last === 0 ? null : nodes[last], nodes[last].along, lr, st, total, lr - nodes[last].along));
    }
    var path = [];
    for (var x = last; x !== -1; x = prev[x]) path.unshift(x);
    var steps = [], fuel = v.startL, bought = 0, cost = 0;
    for (var y = 1; y < path.length; y++) {
      var from = nodes[path[y - 1]], to = nodes[path[y]];
      fuel -= L(to.along - from.along);
      if (to.end) break;
      var buy = v.tank - fuel, pr = price(to);
      steps.push({ s: to, buy: buy, price: pr, cost: buy * pr, arriveL: fuel });
      bought += buy; cost += buy * pr; fuel = v.tank;
    }

    // Longest stretch with no usable servo (including from the start and to the finish)
    var marks = [0].concat(st.map(function (s) { return s.along; }), [total]), gap = 0, gapAt = 0;
    for (var g = 1; g < marks.length; g++) if (marks[g] - marks[g - 1] > gap) { gap = marks[g] - marks[g - 1]; gapAt = marks[g - 1]; }

    return {
      steps: steps, warnings: warnings, bought: bought, cost: cost, range: range, total: total,
      endL: warnings.length ? null : fuel, longestGap: gap, gapAt: gapAt, usable: st.length, v: v
    };
  }

  // ---------- Servo addresses: from the map data, or looked up for planned stops ----------
  var addrCache = {}, addrQueue = [], addrBusy = false;
  function tagAddress(t) {
    var street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
    var town = t["addr:suburb"] || t["addr:city"] || t["addr:town"] || "";
    var st = [abbr(t["addr:state"]), t["addr:postcode"]].filter(Boolean).join(" ");
    return { text: [street, town, st].filter(Boolean).join(", "), hasStreet: !!t["addr:street"] };
  }
  function servoAddress(s) {
    if (addrCache[s.id] !== undefined) return addrCache[s.id];
    var a = tagAddress(s.tags);
    if (a.hasStreet) { addrCache[s.id] = a.text; return a.text; }
    if (!addrQueue.some(function (q) { return q.id === s.id; })) { addrQueue.push(s); pumpAddresses(); }
    return null; // still looking
  }
  async function pumpAddresses() {
    if (addrBusy) return;
    addrBusy = true;
    while (addrQueue.length) {
      var s = addrQueue.shift();
      try {
        var res = await fetch(GEOCODE_URL.replace("/search", "/reverse") + "?format=jsonv2&zoom=18&addressdetails=1&lat=" + s.lat + "&lon=" + s.lon,
          { headers: { "Accept-Language": "en-AU" } });
        var a = (await res.json()).address || {};
        var street = [a.house_number, a.road].filter(Boolean).join(" ");
        var town = a.suburb || a.town || a.city || a.village || a.hamlet || "";
        addrCache[s.id] = [street, town, [abbr(a.state), a.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ") || tagAddress(s.tags).text;
      } catch (e) { addrCache[s.id] = tagAddress(s.tags).text; }
      renderPlan();
      await sleep(1100); // the free address service allows about one lookup a second
    }
    addrBusy = false;
  }

  function gapWarning(cur, pos, reach, st, total, range) {
    var next = st.filter(function (s) { return s.along > reach; })[0];
    var gap = (next ? next.along : total) - pos;
    return "From " + (cur ? esc(cur.name) : "your start") + " (" + km(pos) + " in), the next " + FUEL_NAME[$("fuelType").value] +
      " is about " + km(gap) + " away, more than your safe range of " + km(range) +
      ". Carry spare fuel, leave with more in the tank, or check for servos the map doesn't know about.";
  }

  function renderPlan() {
    var card = $("planCard");
    if (!S.current) return;
    card.classList.remove("hidden");
    var v = vehicle();
    renderVehicleInfo();
    if (!S.servosLoaded) return;
    var r = planFuel();
    if (!r) { $("planBody").innerHTML = '<p class="empty">Add your tank size and fuel use to plan fuel stops.</p>'; return; }
    var FT = FUEL_SHORT[v.type];
    var html = '<div class="plan-sum"><b>' + (r.steps.length ? r.steps.length + " fuel stop" + (r.steps.length > 1 ? "s" : "") : "No fuel stops needed") + "</b>" +
      (r.bought > 0 ? " · about " + Math.round(r.bought) + " L to buy" : "") +
      "<br>Longest stretch without " + FUEL_NAME[v.type] + ": <b>" + km(r.longestGap) + "</b>" +
      (r.longestGap > r.range ? " ⚠️" : "") + "</div>";
    r.warnings.forEach(function (w) { html += '<div class="warn" role="alert">⚠️ ' + w + "</div>"; });
    html += '<div class="fstep"><div class="fnum start" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg></div><div>' +
      '<div class="fname">Leave ' + esc(S.from.name) + '</div><div class="fmeta">' + Math.round(v.startL) + " L in the tank</div></div><div></div></div>";
    r.steps.forEach(function (st, i) {
      var s = st.s;
      var hours = s.h24 ? '<span class="pill ok">Open 24/7</span>' :
        (s.tags && s.tags.opening_hours ? '<span class="pill info">Hours: ' + esc(s.tags.opening_hours) + "</span>" : "");
      var fuel = s.sell === "yes" ? '<span class="pill ok">Sells ' + FT + "</span>" : '<span class="pill warn">' + FT + " not confirmed</span>";
      html += '<div class="fstep"><div class="fnum" aria-label="Fuel stop ' + (i + 1) + '">' + (i + 1) + "</div><div>" +
        '<div class="fname" data-servo="' + s.id + '" role="button" tabindex="0">' + esc(s.name) + "</div>" +
        '<div class="fpills">' + fuel + hours + "</div>" +
        '<div class="faddr">' + (function () { var a = servoAddress(s); return a === null ? "Finding address…" : esc(a || "Address not listed"); })() + "</div>" +
        '<div class="fmeta">' + km(s.along) + " in · arrive with ~" + Math.round(st.arriveL) + " L</div></div>" +
        '<div class="fside"><b>~' + Math.round(st.buy) + " L</b><span>to fill</span>" +
        '<span class="pill dev" title="Live fuel prices are in development">Price in dev</span></div></div>';
    });
    if (r.endL != null) {
      html += '<div class="fstep"><div class="fnum end" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/></svg></div><div>' +
        '<div class="fname">Arrive ' + esc(S.to.name) + '</div><div class="fmeta">About ' + Math.round(r.endL) + " L left</div></div><div></div></div>";
    }
    $("planBody").innerHTML = html;
    drawServos(r);
    S.lastPlan = r;
    renderRouteTab();
  }

  function renderServoList() {
    var v = vehicle();
    $("servoCount").textContent = "(" + S.servos.length + ")";
    if (!S.servos.length) { $("servoList").innerHTML = '<p class="empty">No servos found on this route.</p>'; return; }
    $("servoList").innerHTML = S.servos.map(function (s) {
      var sell = sells(s.tags, v.type);
      return '<div class="srow"><div><div class="name" data-servo="' + s.id + '" style="font-weight:600;font-size:15px;cursor:pointer">' + esc(s.name) +
        (sell === "no" || (sell === "unknown" && v.type === "lpg") ? '<span class="badge warnb">no ' + FUEL_NAME[v.type] + "</span>" : "") + "</div>" +
        '<div class="meta">' + (s.town ? esc(s.town) + " · " : "") + km(s.along) + " in" + (s.h24 ? " · 24/7" : "") + "</div></div>" +
        '<span class="pill dev">Price in dev</span></div>';
    }).join("");
  }

  var servoLayerMarkers = {};
  function drawServos(r) {
    servoLayer.clearLayers(); servoLayerMarkers = {};
    var planIds = {};
    (r ? r.steps : []).forEach(function (st, i) { planIds[st.s.id] = i + 1; });
    S.servos.forEach(function (s) {
      var m;
      if (planIds[s.id]) {
        m = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: '<div class="fpin">⛽ ' + planIds[s.id] + "</div>", iconSize: null, iconAnchor: [18, 12] }), zIndexOffset: 500 });
      } else if (s.ok) {
        m = L.circleMarker([s.lat, s.lon], { radius: 5, color: "#fff", weight: 1.5, fillColor: "#4c8df6", fillOpacity: 1 }).setStyle({ color: "#1a56c4", weight: 2 });
      } else {
        m = L.circleMarker([s.lat, s.lon], { radius: 4, color: "#fff", weight: 1, fillColor: "#8c8580", fillOpacity: .9 });
      }
      m.bindPopup(servoPopup(s, km(s.along) + " into the trip" + (planIds[s.id] ? " · fuel stop " + planIds[s.id] : "")));
      m.addTo(servoLayer); servoLayerMarkers[s.id] = m;
    });
  }

  async function loadServos() {
    S.servosLoaded = false;
    $("planCard").classList.remove("hidden");
    $("planBody").innerHTML = '<p class="empty">' + (bundleReady ? "Planning fuel stops…" : "Finding servos along your route…") + "</p>";
    try {
      await fetchCells(routeCells(S.current));
      S.servos = processServos();
      S.servosLoaded = true;
      syncAllServos();
      renderServoList();
      renderPlan();
    } catch (err) {
      $("planBody").innerHTML = '<p class="empty">' + esc(err.message || "Couldn't load servos.") +
        ' <button type="button" class="add" id="retryServos">Try again</button></p>';
    }
  }

  function categorise(t) {
    if (t.place) return "town";
    if (t.tourism === "viewpoint") return "lookout";
    if (t.tourism === "museum" || t.tourism === "gallery") return "museum";
    if (t.tourism === "zoo" || t.tourism === "aquarium" || t.tourism === "theme_park") return "family";
    if (t.waterway === "waterfall" || t.natural) return "nature";
    if (t.historic) return "history";
    return "attraction";
  }

  function processStops(elements, radiusKm) {
    var base = S.base;
    var near = thin(base.coords, base.cum, 0.3); // lighter line for distance maths
    var out = [], seen = {};
    elements.forEach(function (el) {
      var lat = el.lat != null ? el.lat : el.center && el.center.lat;
      var lon = el.lon != null ? el.lon : el.center && el.center.lon;
      if (lat == null || lon == null || !el.tags || !el.tags.name) return;
      var name = el.tags.name.trim();
      var key = name.toLowerCase();
      var loc = locate([lat, lon], near.coords, near.cum);
      if (loc.off > radiusKm) return;
      // Skip the start and finish towns themselves
      if (loc.along < 2 || loc.along > near.cum[near.cum.length - 1] - 2) { if (el.tags.place) return; }
      if (seen[key] && Math.abs(seen[key].along - loc.along) < 5) return;
      var cat = categorise(el.tags);
      var must = cat !== "town" && !!(el.tags.wikipedia || el.tags.wikidata);
      var poi = {
        id: el.type + el.id, name: name, lat: lat, lon: lon, cat: cat, must: must,
        off: loc.off, along: loc.along,
        score: (must ? 3 : 0) + (el.tags.wikipedia ? 1 : 0) + (cat === "lookout" || cat === "nature" ? 0.5 : 0) - loc.off / 20
      };
      seen[key] = poi;
      out.push(poi);
    });
    // Keep the best ones so the list stays useful on long trips, then order by distance along the route.
    var towns = out.filter(function (p) { return p.cat === "town"; });
    var sights = out.filter(function (p) { return p.cat !== "town"; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 80);
    return sights.concat(towns.slice(0, 40)).sort(function (a, b) { return a.along - b.along; });
  }

  // ---------- Drawing ----------
  function endMarker(p, label, color) {
    return L.circleMarker([p.lat, p.lon], { radius: 9, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 })
      .bindTooltip(label + ": " + esc(p.name), { direction: "top" });
  }

  function drawRoute(fit) {
    routeLayer.clearLayers();
    var r = S.current;
    L.polyline(r.coords, { color: "#1a56c4", weight: 7, opacity: 1, lineJoin: "round" }).addTo(routeLayer);
    L.polyline(r.coords, { color: "#4c8df6", weight: 4.5, opacity: 1, lineJoin: "round" }).addTo(routeLayer);
    endMarker(S.from, "Start", "#628F75").addTo(routeLayer);
    endMarker(S.to, "Finish", "#C65B37").addTo(routeLayer);
    if (fit) fitRoute();
  }

  function popupHtml(p) {
    var on = !!S.selected[p.id];
    return "<b>" + esc(p.name) + "</b><br>" + CATS[p.cat].emo + " " + CATS[p.cat].label +
      (p.must ? ' <span class="badge">Popular</span>' : "") +
      "<br><small>" + km(p.along) + " into the trip · ~" + (p.off < 1 ? "<1" : Math.round(p.off)) + " km off route</small><br>" +
      '<button class="add' + (on ? " on" : "") + '" data-add="' + p.id + '">' + (on ? "✓ Added" : "+ Add to trip") + "</button>";
  }

  function drawStops() {
    poiLayer.clearLayers(); poiMarkers = {};
    visibleStops().forEach(function (p) {
      var on = !!S.selected[p.id];
      var m = L.circleMarker([p.lat, p.lon], {
        radius: on ? 9 : p.must ? 7 : 5, color: "#fff", weight: 2,
        fillColor: on ? "#C65B37" : CATS[p.cat].color, fillOpacity: .95
      }).bindPopup(function () { return popupHtml(p); });
      m.addTo(poiLayer); poiMarkers[p.id] = m;
    });
  }

  function visibleStops() {
    return S.pois.filter(function (p) {
      if (S.selected[p.id]) return true;
      if (S.filter === "all") return true;
      if (S.filter === "must") return p.must;
      return p.cat === S.filter;
    });
  }

  function renderChips() {
    var counts = { all: S.pois.length, must: 0 };
    S.pois.forEach(function (p) { counts[p.cat] = (counts[p.cat] || 0) + 1; if (p.must) counts.must++; });
    var keys = ["all", "must", "town", "lookout", "nature", "attraction", "museum", "history", "family"];
    $("chips").innerHTML = keys.filter(function (k) { return counts[k]; }).map(function (k) {
      var label = k === "all" ? "All" : CATS[k].emo + " " + CATS[k].label;
      return '<button type="button" class="chip" data-filter="' + k + '" aria-pressed="' + (S.filter === k) + '">' + label + " " + counts[k] + "</button>";
    }).join("");
  }

  function renderList() {
    var list = visibleStops();
    if (!S.pois.length) { $("stopList").innerHTML = '<p class="empty">No stops found this close to the route. Try a wider distance.</p>'; return; }
    $("stopList").innerHTML = list.map(function (p) {
      var on = !!S.selected[p.id];
      return '<div class="stop"><div class="emo">' + CATS[p.cat].emo + "</div><div>" +
        '<div class="name" data-view="' + p.id + '">' + esc(p.name) + (p.must ? '<span class="badge">Popular</span>' : "") + "</div>" +
        '<div class="meta">' + km(p.along) + " in · ~" + (p.off < 1 ? "<1" : Math.round(p.off)) + " km off route</div></div>" +
        '<button type="button" class="add' + (on ? " on" : "") + '" data-add="' + p.id + '">' + (on ? "✓ Added" : "+ Add") + "</button></div>";
    }).join("");
  }

  function renderSummary() {
    var r = S.current, b = S.base;
    var econ = parseFloat($("economy").value) || 0;
    var tow = parseFloat($("tow").value) || 0;
    var litres = r.distance * econ * (1 + tow) / 100;
    var stops = selectedStops();
    var title = S.from.name + " → " + S.to.name;

    $("sumTitle").textContent = title;
    $("tbTitle").textContent = title;
    $("dist").textContent = km(r.distance);
    $("time").textContent = dur(r.duration);
    $("litres").textContent = "≈ " + Math.round(litres) + " L";
    var extraKm = r.distance - b.distance, extraT = r.duration - b.duration;
    $("sumExtra").textContent = stops.length
      ? stops.length + " pitstop" + (stops.length > 1 ? "s" : "") + " added" +
        (extraKm > 0.5 ? " · +" + km(extraKm) : "") + (extraT > 60 ? " · +" + dur(extraT) : "")
      : "";
    $("dDist").textContent = km(r.distance);
    $("dTime").textContent = dur(r.duration);
    $("dFuel").textContent = "About " + Math.round(litres) + " L";
    $("breaks").textContent = String(Math.floor(r.duration / 7200));

    // Google Maps hand-off for turn-by-turn navigation
    var u = "https://www.google.com/maps/dir/?api=1&travelmode=driving" +
      "&origin=" + S.from.lat + "," + S.from.lon + "&destination=" + S.to.lat + "," + S.to.lon;
    if (stops.length) u += "&waypoints=" + encodeURIComponent(stops.slice(0, 9).map(function (p) { return p.lat + "," + p.lon; }).join("|"));
    $("gmaps").href = u;
    renderCurrentTrip();
    renderRouteTab();
    save();
  }

  function selectedStops() {
    return S.pois.filter(function (p) { return S.selected[p.id]; }).sort(function (a, b) { return a.along - b.along; });
  }

  // ---------- Flow ----------
  var busy = false;
  async function plan(e) {
    if (e) e.preventDefault();
    if (busy) return;
    var fromQ = $("from").value.trim(), toQ = $("to").value.trim();
    if (!fromQ || !toQ) { setStatus("Add where you're starting and where you're going.", true); return; }
    busy = true; $("go").disabled = true;
    try {
      setStatus("Finding places…");
      var fromPicked = (fromQ === "My location" && S.geoFrom) ? S.geoFrom : (picks.from && picks.from.text === fromQ ? picks.from : null);
      var toPicked = picks.to && picks.to.text === toQ ? picks.to : null;
      S.from = fromPicked || await geocode(fromQ);
      if (!fromPicked && !toPicked) await sleep(1100); // be polite to the free fallback search
      S.to = toPicked || await geocode(toQ);
      setStatus("Working out the route…");
      S.base = await getRoute([S.from, S.to]);
      S.current = S.base;
      S.selected = {}; S.pois = []; S.filter = "all";
      S.lastPlan = null;
      $("planBody").innerHTML = '<p class="empty">Planning fuel stops…</p>';
      openResults(true);
      drawRoute(true); poiLayer.clearLayers();
      renderSummary();
      setStatus("");
      S.prices = {};
      servoLayer.clearLayers();
      loadServos().then(loadStops);
    } catch (err) {
      setStatus(err.message || "Something went wrong. Try again.", true);
    } finally {
      busy = false; $("go").disabled = false;
    }
  }

  async function loadStops() {
    var card = $("stopsCard");
    card.classList.remove("hidden");
    $("chips").innerHTML = "";
    $("stopList").innerHTML = '<p class="empty">Finding stops along your route…</p>';
    var radius = parseFloat($("radius").value);
    try {
      var els = await getStops(radius);
      var keep = S.pois.filter(function (p) { return S.selected[p.id]; });
      S.pois = processStops(els, radius);
      keep.forEach(function (k) { if (!S.pois.some(function (p) { return p.id === k.id; })) S.pois.push(k); });
      S.pois.sort(function (a, b) { return a.along - b.along; });
      renderChips(); renderList(); drawStops();
    } catch (err) {
      $("stopList").innerHTML = '<p class="empty">' + esc(err.message || "Couldn't load stops.") +
        ' <button type="button" class="add" id="retryStops">Try again</button></p>';
    }
  }

  async function toggleStop(id) {
    if (busy) return;
    S.selected[id] = !S.selected[id];
    if (!S.selected[id]) delete S.selected[id];
    refreshStopUI(id);
    busy = true;
    try {
      var pts = [S.from].concat(selectedStops(), [S.to]);
      S.current = pts.length > 2 ? await getRoute(pts) : S.base;
      drawRoute(false);
      renderSummary();
      loadServos();
    } catch (err) {
      delete S.selected[id];
      refreshStopUI(id);
      setStatus("Couldn't add that stop to the route. Try again.", true);
    } finally { busy = false; }
  }

  function refreshStopUI(id) {
    renderList(); drawStops();
    var m = poiMarkers[id];
    if (m && m.isPopupOpen && m.isPopupOpen()) m.setPopupContent(popupHtml(S.pois.find(function (p) { return p.id === id; })));
  }

  // ---------- Events ----------
  $("tripForm").addEventListener("submit", plan);
  $("radius").addEventListener("change", function () { if (S.base) loadStops(); });
  ["economy", "price", "tow", "people", "tank", "fuelType", "startFuel", "reserve"].forEach(function (id) {
    var h = function () {
      if (S.current) { renderSummary(); renderPlan(); if (S.servosLoaded && (id === "fuelType" || id === "price")) renderServoList(); }
      else { save(); renderRangeOnly(); }
    };
    $(id).addEventListener("input", h); $(id).addEventListener("change", h);
  });
  function renderRangeOnly() { renderVehicleInfo(); }
  document.addEventListener("input", function (e) {
    var id = e.target && e.target.dataset && e.target.dataset.price;
    if (!id) return;
    var val = parseFloat(e.target.value);
    if (val > 0) S.prices[id] = val; else delete S.prices[id];
    renderPlan();
  });

  document.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("[data-servo][role=button]")) { e.preventDefault(); e.target.click(); }
  });
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-add],[data-view],[data-filter],[data-servo],#retryStops,#retryServos");
    if (!t) return;
    if (t.id === "retryStops") { loadStops(); return; }
    if (t.id === "retryServos") { loadServos(); return; }
    if (t.dataset.servo) {
      var sv = S.servos.find(function (x) { return x.id === t.dataset.servo; });
      if (sv) {
        focusOn([sv.lat, sv.lon], 14);
        if (servoLayerMarkers[sv.id]) servoLayerMarkers[sv.id].openPopup();
      }
      return;
    }
    if (t.dataset.filter) { S.filter = t.dataset.filter; renderChips(); renderList(); drawStops(); return; }
    if (t.dataset.add) { toggleStop(t.dataset.add); return; }
    if (t.dataset.view) {
      var p = S.pois.find(function (x) { return x.id === t.dataset.view; });
      if (p) {
        focusOn([p.lat, p.lon], 12);
        if (poiMarkers[p.id]) poiMarkers[p.id].openPopup();
      }
    }
  });

  $("locate").addEventListener("click", function () {
    if (!navigator.geolocation) { setStatus("Your browser can't share location.", true); return; }
    setStatus("Getting your location…");
    navigator.geolocation.getCurrentPosition(function (pos) {
      S.geoFrom = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: "My location" };
      $("from").value = "My location";
      setStatus("");
    }, function () { setStatus("Couldn't get your location. Type a town instead.", true); }, { timeout: 10000 });
  });
  $("from").addEventListener("input", function () { if ($("from").value !== "My location") S.geoFrom = null; });
  setupSuggest("from");
  setupSuggest("to");
  initServoData();

  $("copy").addEventListener("click", function () {
    if (!S.current) return;
    var r = S.current, stops = selectedStops();
    var txt = "🚗 " + S.from.name + " → " + S.to.name + "\n" + km(r.distance) + " · about " + dur(r.duration) + " driving";
    txt += "\n⛽ Fuel use: " + $("litres").textContent;
    if (stops.length) txt += "\n📍 Stops: " + stops.map(function (p) { return p.name; }).join(", ");
    var fp = S.servosLoaded ? planFuel() : null;
    if (fp && fp.steps.length) txt += "\n⛽ Fuel stops:\n" + fp.steps.map(function (st, i) {
      return (i + 1) + ". " + st.s.name + (addrCache[st.s.id] ? ", " + addrCache[st.s.id] : "") + " (" + km(st.s.along) + " in)";
    }).join("\n");
    txt += "\nGoogle Maps: " + $("gmaps").href;
    var done = function (m) { closeMenu(); toast(m); };
    try { navigator.clipboard.writeText(txt).then(function () { done("Copied, paste it in the group chat."); }, function () { done("Couldn't copy."); }); }
    catch (e) { done("Couldn't copy."); }
  });

  // ================= UI shell: screens, bottom sheet, tabs, vehicle sheet =================
  var FUEL_SHORT = { ulp: "ULP", e10: "E10", p95: "95", p98: "98", diesel: "Diesel", lpg: "LPG" };
  var FUEL_LONG = { ulp: "Unleaded 91", e10: "E10", p95: "Premium 95", p98: "Premium 98", diesel: "Diesel", lpg: "LPG" };
  var TOW_LABEL = { "0": "Not towing", "0.15": "Light trailer", "0.35": "Caravan", "0.5": "Heavy van" };

  function setDataStatus(t) { document.querySelectorAll(".data-status").forEach(function (el) { el.textContent = t; }); }

  function renderVehicleInfo() {
    var v = vehicle();
    var line = FUEL_LONG[v.type] + " · " + Math.round(v.tank) + " L tank · " + ($("economy").value || "–") + " L/100km" +
      (parseFloat($("tow").value) ? " · " + TOW_LABEL[$("tow").value] : "");
    var range = v.tank > 0 && v.use > 0
      ? "Safe range about " + km((v.tank - v.reserveL) / v.use * 100) + " per tank, keeping " + Math.round(v.reserveL) + " L in reserve"
      : "Add your tank size and fuel use";
    $("vehSummary").textContent = line; $("vehSummary2").textContent = line;
    $("rangeHint").textContent = range; $("rangeHint2").textContent = range; $("rangeHint3").textContent = range + ".";
  }

  function toast(msg) {
    var t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---------- Screens ----------
  var screenNow = "home";
  function showScreen(name) {
    screenNow = name;
    var results = name === "results";
    document.body.classList.toggle("results", results);
    ["home", "trips", "fuel", "explore", "more"].forEach(function (n) { $("screen-" + n).hidden = n !== name; });
    ["topbar", "sheet", "actionBar", "mapTools"].forEach(function (id) { $(id).hidden = !results; });
    $("bottomNav").hidden = results;
    document.querySelectorAll("#bottomNav [data-nav]").forEach(function (b) {
      if (b.dataset.nav === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    closeMenu();
    if (results) requestAnimationFrame(function () { map.invalidateSize(); layoutSheet(); });
  }

  function openResults(fresh) {
    if (screenNow !== "results") {
      try { history.pushState({ rtp: "results" }, ""); } catch (e) {}
      showScreen("results");
    }
    if (fresh) { setTab("fuel"); snapName = "half"; }
    layoutSheet();
  }
  function leaveResults() {
    if (history.state && history.state.rtp === "results") history.back();
    else showScreen("home");
  }
  window.addEventListener("popstate", function (e) {
    if (e.state && e.state.rtp === "results" && S.current) showScreen("results");
    else if (screenNow === "results") showScreen("home");
  });
  try { history.replaceState({ rtp: "home" }, ""); } catch (e) {}

  // ---------- Bottom sheet (3 snap points, dragged only by its handle/summary area) ----------
  var sheet = $("sheet"), sheetBody = $("sheetBody"), grab = $("sheetGrab"), tabsBar = sheet.querySelector(".tabs");
  var snapName = "half", sheetH = 0, snaps = { collapsed: 0, half: 0, full: 0 }, visible = 0;
  var SNAP_LABEL = { collapsed: "collapsed", half: "half open", full: "fully open" };
  function isWide() { return window.matchMedia("(min-width: 900px)").matches; }

  function layoutSheet() {
    if (sheet.hidden) return;
    if (isWide()) {
      sheet.style.height = ""; sheet.style.transform = ""; sheetBody.style.height = ""; sheetBody.style.flex = "";
      visible = 0;
      return;
    }
    var vh = window.innerHeight;
    sheetH = vh - $("topbar").offsetHeight - 64; // fully open still leaves a strip of map showing
    sheet.style.height = sheetH + "px";
    sheetBody.style.flex = "none";
    var action = $("actionBar").offsetHeight;
    var grabH = grab.offsetHeight, tabsH = tabsBar.offsetHeight;
    snaps = {
      collapsed: Math.min(sheetH, grabH + action),
      half: Math.min(sheetH, Math.max(grabH + tabsH + action + 140, Math.round(vh * 0.52))),
      full: sheetH
    };
    setVisible(snaps[snapName], false, true);
  }

  function setVisible(px, animate, sizeBody) {
    visible = px;
    sheet.classList.toggle("animate", !!animate);
    sheet.style.transform = "translateY(" + Math.round(sheetH - px) + "px)";
    // The scrolling area has to end where the sheet's visible part ends, or the last items can't be reached
    if (sizeBody !== false) sheetBody.style.height = Math.max(0, px - grab.offsetHeight - tabsBar.offsetHeight) + "px";
  }

  function snapTo(name, animate) {
    if (isWide()) return;
    snapName = name;
    setVisible(snaps[name], animate !== false, true);
    $("sheetHandle").setAttribute("aria-label", "Results panel " + SNAP_LABEL[name] + ". Tap to resize.");
    // If the map is still showing the whole route, re-fit it around the new sheet size
    if (autoFit) setTimeout(fitRoute, animate === false ? 0 : 300);
  }

  var drag = null;
  grab.addEventListener("pointerdown", function (e) {
    if (isWide() || e.button > 0) return;
    if (e.target.closest("button:not(.handle), a, input, select")) return;
    drag = { id: e.pointerId, y: e.clientY, start: visible, lastY: e.clientY, lastT: e.timeStamp, vel: 0, moved: false };
    try { grab.setPointerCapture(e.pointerId); } catch (err) {}
  });
  grab.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dy = e.clientY - drag.y;
    if (Math.abs(dy) > 6) drag.moved = true;
    if (!drag.moved) return;
    var dt = Math.max(1, e.timeStamp - drag.lastT);
    drag.vel = (e.clientY - drag.lastY) / dt; // px per ms; positive = dragging down
    drag.lastY = e.clientY; drag.lastT = e.timeStamp;
    setVisible(Math.max(snaps.collapsed, Math.min(snaps.full, drag.start - dy)), false, false);
  });
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    var d = drag; drag = null;
    var order = ["collapsed", "half", "full"];
    if (!d.moved) { snapTo(snapName === "collapsed" ? "half" : snapName === "half" ? "full" : "half"); return; }
    var target;
    if (Math.abs(d.vel) > 0.5) { // a flick goes to the next snap point in that direction
      var up = d.vel < 0;
      var c = order.filter(function (n) { return up ? snaps[n] > visible + 1 : snaps[n] < visible - 1; });
      target = c.length ? (up ? c[0] : c[c.length - 1]) : (up ? "full" : "collapsed");
    } else {
      target = order.reduce(function (b, n) { return Math.abs(snaps[n] - visible) < Math.abs(snaps[b] - visible) ? n : b; }, "half");
    }
    snapTo(target);
  }
  grab.addEventListener("pointerup", endDrag);
  grab.addEventListener("pointercancel", endDrag);
  $("sheetHandle").addEventListener("keydown", function (e) {
    var order = ["collapsed", "half", "full"], i = order.indexOf(snapName);
    if (e.key === "ArrowUp") { e.preventDefault(); snapTo(order[Math.min(2, i + 1)]); }
    else if (e.key === "ArrowDown") { e.preventDefault(); snapTo(order[Math.max(0, i - 1)]); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); snapTo(snapName === "full" ? "half" : order[i + 1]); }
  });

  // ---------- Map framing around the sheet ----------
  var autoFit = false, progMove = false;
  function fitRoute() {
    if (!S.current) return;
    progMove = true;
    var b = L.latLngBounds(S.current.coords);
    if (isWide()) map.fitBounds(b, { paddingTopLeft: [444, 24], paddingBottomRight: [72, 24] });
    else map.fitBounds(b, { paddingTopLeft: [24, 24], paddingBottomRight: [72, visible + 24] }); // right side clears the map buttons
    setTimeout(function () { progMove = false; }, 450);
    autoFit = true;
  }
  map.on("dragstart", function () { autoFit = false; });
  map.on("zoomstart", function () { if (!progMove) autoFit = false; });

  // Centre a point in the part of the map that isn't covered by the sheet
  function focusOn(ll, zoom) {
    if (!isWide() && snapName === "full") snapTo("half");
    var vis = isWide() ? 0 : snaps[snapName];
    var shift = isWide() ? L.point(-210, 0) : L.point(0, vis / 2);
    progMove = true; autoFit = false;
    map.setView(map.unproject(map.project(ll, zoom).add(shift), zoom), zoom);
    setTimeout(function () { progMove = false; }, 450);
  }

  // ---------- Tabs ----------
  var TABS = ["fuel", "pitstops", "route", "details"];
  function setTab(name) {
    TABS.forEach(function (n) {
      var on = n === name;
      $("tabbtn-" + n).setAttribute("aria-selected", on ? "true" : "false");
      $("tabbtn-" + n).tabIndex = on ? 0 : -1;
      $("tab-" + n).hidden = !on;
    });
    sheetBody.scrollTop = 0;
    if (!isWide() && snapName === "collapsed") snapTo("half");
  }
  TABS.forEach(function (n, i) {
    var btn = $("tabbtn-" + n);
    btn.addEventListener("click", function () { setTab(n); });
    btn.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      setTab(next); $("tabbtn-" + next).focus();
    });
  });
  $("planInfoBtn").addEventListener("click", function () {
    var p = $("planInfo"); p.hidden = !p.hidden;
    this.setAttribute("aria-expanded", p.hidden ? "false" : "true");
  });

  // ---------- Route tab (built from the route, your pitstops and the fuel plan) ----------
  function renderRouteTab() {
    var el = $("routeList");
    if (!el || !S.current) return;
    var near = thin(S.current.coords, S.current.cum, 0.3);
    var total = S.current.cum[S.current.cum.length - 1];
    var items = [];
    selectedStops().forEach(function (p) {
      items.push({ type: "poi", name: p.name, along: locate([p.lat, p.lon], near.coords, near.cum).along, emo: CATS[p.cat].emo, id: p.id });
    });
    (S.lastPlan ? S.lastPlan.steps : []).forEach(function (st, i) {
      items.push({ type: "fuel", name: st.s.name, along: st.s.along, n: i + 1, id: st.s.id });
    });
    items.sort(function (a, b) { return a.along - b.along; });
    items.unshift({ type: "start", name: S.from.name, along: 0 });
    items.push({ type: "end", name: S.to.name, along: total });
    var html = "";
    items.forEach(function (it, i) {
      if (i > 0) html += '<div class="rleg">' + km(it.along - items[i - 1].along) + "</div>";
      var icon = it.type === "start" ? '<div class="ricon start" aria-hidden="true">A</div>' :
        it.type === "end" ? '<div class="ricon end" aria-hidden="true">B</div>' :
        it.type === "fuel" ? '<div class="ricon fuel" aria-hidden="true">' + it.n + "</div>" :
        '<div class="ricon poi" aria-hidden="true">' + it.emo + "</div>";
      var label = it.type === "start" ? "Start" : it.type === "end" ? "Finish · " + km(S.current.distance) + " · " + dur(S.current.duration) :
        it.type === "fuel" ? "Fuel stop " + it.n : "Pitstop";
      var tap = it.type === "fuel" ? ' data-servo="' + it.id + '" role="button" tabindex="0"' : it.type === "poi" ? ' data-view="' + it.id + '" role="button" tabindex="0"' : "";
      html += '<div class="rstep">' + icon + '<div><div class="t"' + tap + ">" + esc(it.name) + '</div><div class="m">' + label + "</div></div>" +
        '<div class="k">' + (it.type === "start" ? "0 km" : km(it.along)) + "</div></div>";
    });
    if (!S.servosLoaded) html += '<p class="empty">Fuel stops will appear here once they are planned.</p>';
    html += '<div class="route-actions"><button type="button" class="btn ghost" data-copy>Copy trip summary</button></div>';
    el.innerHTML = html;
  }

  function renderCurrentTrip() {
    var has = !!S.current;
    $("currentTrip").hidden = !has; $("currentTrip2").hidden = !has;
    if (!has) return;
    var t = S.from.name + " → " + S.to.name, m = km(S.current.distance) + " · " + dur(S.current.duration);
    $("ctTitle").textContent = t; $("ctTitle2").textContent = t;
    $("ctMeta").textContent = m; $("ctMeta2").textContent = m;
  }
  $("ctView").addEventListener("click", function () { openResults(false); });
  $("ctView2").addEventListener("click", function () { openResults(false); });

  // ---------- Top bar, menu, map buttons, action bar ----------
  function closeMenu() { $("tripMenu").hidden = true; $("menuBtn").setAttribute("aria-expanded", "false"); }
  $("menuBtn").addEventListener("click", function (e) {
    e.stopPropagation();
    var m = $("tripMenu"); m.hidden = !m.hidden;
    this.setAttribute("aria-expanded", m.hidden ? "false" : "true");
    if (!m.hidden) m.querySelector("button").focus();
  });
  document.addEventListener("click", function (e) { if (!e.target.closest("#tripMenu, #menuBtn")) closeMenu(); });
  $("backBtn").addEventListener("click", leaveResults);
  $("menuEdit").addEventListener("click", function () { closeMenu(); leaveResults(); setTimeout(function () { $("to").focus(); }, 100); });

  var meMarker = null;
  $("locateMap").addEventListener("click", function () {
    if (!navigator.geolocation) { toast("Location isn't available on this device."); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var ll = [pos.coords.latitude, pos.coords.longitude];
      if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      else meMarker.setLatLng(ll);
      focusOn(ll, 12);
    }, function () { toast("Couldn't get your location."); }, { timeout: 10000 });
  });
  if (window.matchMedia("(pointer: fine)").matches) L.control.zoom({ position: "bottomright" }).addTo(map);

  $("recalcBtn").addEventListener("click", function () {
    if (!S.current) return;
    loadServos().then(function () { toast(S.servosLoaded ? "Fuel plan recalculated." : "Couldn't recalculate. Try again."); });
  });

  // ---------- Navigation, placeholders, vehicle sheet ----------
  document.addEventListener("click", function (e) {
    var nav = e.target.closest("[data-nav]");
    if (nav) { showScreen(nav.dataset.nav); return; }
    var dev = e.target.closest("[data-dev]");
    if (dev) { toast(dev.dataset.dev + " is in development."); return; }
    if (e.target.closest("[data-open-vehicle]")) { openVehicle(); return; }
    if (e.target.closest("[data-copy]")) { $("copy").click(); }
  });

  var lastFocus = null;
  function openVehicle() {
    lastFocus = document.activeElement;
    closeMenu();
    renderVehicleInfo();
    $("vehicleModal").hidden = false;
    setTimeout(function () { $("fuelType").focus(); }, 50);
  }
  function closeVehicle() {
    $("vehicleModal").hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $("vehClose").addEventListener("click", closeVehicle);
  $("vehDone").addEventListener("click", closeVehicle);
  $("vehicleModal").addEventListener("click", function (e) { if (e.target.id === "vehicleModal") closeVehicle(); });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!$("vehicleModal").hidden) closeVehicle(); else closeMenu();
  });

  // Swap start and destination (keeps picked suggestions and "My location")
  $("swapBtn").addEventListener("click", function () {
    var f = $("from").value, t = $("to").value, pf = picks.from, pt = picks.to, g = S.geoFrom;
    $("from").value = t; $("to").value = f;
    picks.from = pt; picks.to = pf; S.geoFrom = null;
    if (f === "My location" && g) picks.to = { lat: g.lat, lon: g.lon, name: "My location", text: "My location" };
    save();
  });

  // Hide the bottom bar while typing so it doesn't sit on top of the keyboard
  document.addEventListener("focusin", function (e) { if (e.target.matches("#screen-home input")) document.body.classList.add("typing"); });
  document.addEventListener("focusout", function (e) { if (e.target.matches("#screen-home input")) document.body.classList.remove("typing"); });

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { map.invalidateSize(); layoutSheet(); }, 120);
  });

  showScreen("home");

  // ---------- Remember settings on this device ----------
  var KEY = "roadTripPlanner.v1";
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        from: $("from").value === "My location" ? "" : $("from").value, to: $("to").value,
        economy: $("economy").value, price: $("price").value, people: $("people").value, tow: $("tow").value,
        tank: $("tank").value, fuelType: $("fuelType").value, startFuel: $("startFuel").value, reserve: $("reserve").value
      }));
    } catch (e) {}
  }
  try {
    var s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s) {
      if (s.from) $("from").value = s.from;
      if (s.to) $("to").value = s.to;
      if (s.economy) $("economy").value = s.economy;
      if (s.price) $("price").value = s.price;
      if (s.people) $("people").value = s.people;
      if (s.tow) $("tow").value = s.tow;
      ["tank", "fuelType", "startFuel", "reserve"].forEach(function (k) { if (s[k]) $(k).value = s[k]; });
    }
  } catch (e) {}
  renderRangeOnly();
})();
