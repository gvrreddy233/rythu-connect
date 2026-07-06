// ================= Rythu Connect — app logic =================

const HYD_CENTER = [17.4, 78.49];
const RATE_SOLO = 10;    // ₹/km — individual hired transport, round trip
const VEHICLE_TIERS = [
  { max: 400,      key: "auto",  rate: 14 },
  { max: 1200,     key: "tempo", rate: 20 },
  { max: Infinity, key: "truck", rate: 30 },
];

let lang = localStorage.getItem("rc_lang") || "te";

// Pin corrections: user-dragged positions override the shipped (approximate) coords
const ORIG_COORDS = {};
[...BAZARS, ...COLLECTION_POINTS].forEach((p) => { ORIG_COORDS[p.id] = { lat: p.lat, lng: p.lng }; });
let pinOverrides = {};
try { pinOverrides = JSON.parse(localStorage.getItem("rc_pins") || "{}"); } catch (e) { pinOverrides = {}; }
[...BAZARS, ...COLLECTION_POINTS].forEach((p) => {
  const o = pinOverrides[p.id];
  if (o) { p.lat = o.lat; p.lng = o.lng; }
});
let editMode = false;

let db = loadDb();
let mainMap = null, regMap = null, regMapInited = false;
let regLocation = null, regMarker = null;
let selectedProduce = new Set();

const $ = (id) => document.getElementById(id);
const t = (key) => I18N[lang][key] || key;
const name = (obj) => obj[lang] || obj.en;
function todayStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// ---------- persistence + seed ----------
function loadDb() {
  try {
    const raw = localStorage.getItem("rc_db");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.farmers)) return parsed;
    }
  } catch (e) { /* corrupted storage — reseed */ }
  return seedDb();
}

function seedDb() {
  const fresh = { farmers: [], trips: [] };
  SEED_FARMERS.forEach((s, i) => {
    const farmer = {
      id: "f" + (i + 1), name: s.name, phone: s.phone, scale: s.scale,
      village: s.village, lat: s.lat, lng: s.lng,
    };
    fresh.farmers.push(farmer);
    const cp = nearestCP(s.lat, s.lng);
    fresh.trips.push({
      id: "t" + (i + 1), farmerId: farmer.id, date: todayStr(),
      cpId: cp.id, items: s.items.map(([pid, kg]) => ({ produceId: pid, kg })),
    });
  });
  localStorage.setItem("rc_db", JSON.stringify(fresh));
  return fresh;
}

function saveDb() { localStorage.setItem("rc_db", JSON.stringify(db)); }

// ---------- geo helpers ----------
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestCP(lat, lng) {
  let best = null, bestD = Infinity;
  for (const cp of COLLECTION_POINTS) {
    const d = haversine(lat, lng, cp.lat, cp.lng);
    if (d < bestD) { bestD = d; best = cp; }
  }
  return { ...best, dist: bestD };
}

const bazarById = (id) => BAZARS.find((b) => b.id === id);
const cpById = (id) => COLLECTION_POINTS.find((c) => c.id === id);
const farmerById = (id) => db.farmers.find((f) => f.id === id);
const produceById = (id) => PRODUCE.find((p) => p.id === id);

// ---------- i18n ----------
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  $("langToggle").textContent = lang === "te" ? "English" : "తెలుగు";
  document.documentElement.lang = lang;
  renderChips();
  renderQtyInputs();
  renderTransport();
  renderMarket();
  renderMapMarkers();
  if (regLocation) showMatch(regLocation.lat, regLocation.lng);
  const loc = $("locStatus");
  loc.textContent = regLocation ? t("locSet") : t("locNotSet");
  loc.classList.toggle("ok", !!regLocation);
}

// ---------- maps ----------
function makePin(kind, emoji) {
  return L.divIcon({
    className: "",
    html: `<div class="emoji-pin ${kind}"><span>${emoji}</span></div>`,
    iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28],
  });
}

let markerLayer = null;
function renderMapMarkers() {
  if (!mainMap) return;
  if (markerLayer) markerLayer.remove();
  markerLayer = L.layerGroup().addTo(mainMap);

  BAZARS.forEach((b) => {
    const m = L.marker([b.lat, b.lng], { icon: makePin("bazar", "🥬"), draggable: editMode })
      .bindPopup(`<b>${name(b)}</b><br>${t("timings")}: ${BAZAR_TIMINGS[lang]}<br><small>${t("approxNote")}</small>`)
      .addTo(markerLayer);
    if (editMode) m.on("dragend", () => savePinMove(b.id, m));
  });

  COLLECTION_POINTS.forEach((cp) => {
    const dest = bazarById(cp.bazarId);
    const kg = todaysTrips().filter((tr) => tr.cpId === cp.id)
      .reduce((s, tr) => s + tr.items.reduce((a, i) => a + i.kg, 0), 0);
    const m = L.marker([cp.lat, cp.lng], { icon: makePin("cp", "📦"), draggable: editMode })
      .bindPopup(
        `<b>${name(cp)}</b><br>${t("proposedCP")}<br>` +
        `${t("highway")}: ${lang === "te" ? cp.hwyTe : cp.hwyEn}<br>` +
        `${t("destBazar")}: ${name(dest)}<br>` +
        `${t("incomingToday")}: <b>${kg} kg</b>`
      ).addTo(markerLayer);
    if (editMode) m.on("dragend", () => savePinMove(cp.id, m));
  });

  db.farmers.forEach((f) => {
    L.marker([f.lat, f.lng], { icon: makePin("farmer", "👨‍🌾") })
      .bindPopup(`<b>${f.name}</b><br>${f.village}`)
      .addTo(markerLayer);
  });
}

function initMainMap() {
  mainMap = L.map("mainMap").setView(HYD_CENTER, 10);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap",
  }).addTo(mainMap);
  renderMapMarkers();
}

function initRegMap() {
  regMap = L.map("regMap").setView(HYD_CENTER, 9);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap",
  }).addTo(regMap);

  COLLECTION_POINTS.forEach((cp) => {
    L.marker([cp.lat, cp.lng], { icon: makePin("cp", "📦") })
      .bindPopup(`<b>${name(cp)}</b>`).addTo(regMap);
  });

  regMap.on("click", (e) => {
    regLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (regMarker) regMarker.remove();
    regMarker = L.marker([regLocation.lat, regLocation.lng], { icon: makePin("farmer", "👨‍🌾") })
      .bindPopup(`<b>${t("yourVillage")}</b>`).addTo(regMap);
    const loc = $("locStatus");
    loc.textContent = t("locSet");
    loc.classList.add("ok");
    showMatch(regLocation.lat, regLocation.lng);
  });
  regMapInited = true;
}

// ---------- pin correction ----------
function savePinMove(id, marker) {
  const ll = marker.getLatLng();
  pinOverrides[id] = { lat: ll.lat, lng: ll.lng };
  localStorage.setItem("rc_pins", JSON.stringify(pinOverrides));
  const p = BAZARS.find((x) => x.id === id) || COLLECTION_POINTS.find((x) => x.id === id);
  p.lat = ll.lat; p.lng = ll.lng;
  renderTransport(); renderMarket();
  updatePinButtons();
}

function updatePinButtons() {
  $("resetPinsBtn").classList.toggle("hidden", Object.keys(pinOverrides).length === 0);
}

// ---------- collection point matching ----------
function showMatch(lat, lng) {
  const cp = nearestCP(lat, lng);
  const dest = bazarById(cp.bazarId);
  const distToBazar = haversine(lat, lng, dest.lat, dest.lng);
  const savedKm = Math.max(0, distToBazar - cp.dist);
  const savedRs = Math.round(savedKm * 2 * RATE_SOLO);

  $("matchResult").innerHTML = `
    <p class="big">📦 ${name(cp)}</p>
    <div class="row">🛣️ <b>${t("highway")}:</b> ${lang === "te" ? cp.hwyTe : cp.hwyEn}</div>
    <div class="row">📏 <b>${t("distVillage")}:</b> ${cp.dist.toFixed(1)} km</div>
    <div class="row">🏪 <b>${t("destBazar")}:</b> ${name(dest)}</div>
    <div class="savings">💰 ${t("youSave")}: <b>₹${savedRs}</b><br>
      <small>${savedKm.toFixed(1)} ${t("kmCloser")} × 2 — ${t("insteadOf")}</small></div>`;
}

// ---------- produce chips ----------
function renderChips() {
  $("produceChips").innerHTML = PRODUCE.map((p) =>
    `<button type="button" class="chip ${selectedProduce.has(p.id) ? "on" : ""}" data-pid="${p.id}">
       ${p.emoji} ${name(p)}</button>`).join("");
  document.querySelectorAll(".chip").forEach((el) => {
    el.onclick = () => {
      const pid = el.dataset.pid;
      if (selectedProduce.has(pid)) selectedProduce.delete(pid);
      else selectedProduce.add(pid);
      el.classList.toggle("on");
      renderQtyInputs();
    };
  });
}

function renderQtyInputs() {
  const existing = {};
  document.querySelectorAll(".qty-row input").forEach((inp) => {
    existing[inp.dataset.pid] = inp.value;
  });
  $("qtyInputs").innerHTML = [...selectedProduce].map((pid) => {
    const p = produceById(pid);
    return `<div class="qty-row"><span>${p.emoji} ${name(p)}</span>
      <input type="number" min="1" data-pid="${pid}" value="${existing[pid] || ""}" placeholder="kg">
      <span class="unit">kg</span></div>`;
  }).join("");
}

// ---------- registration ----------
function handleRegister(ev) {
  ev.preventDefault();
  if (!regLocation) { alert(t("needLocation")); return; }

  const items = [];
  document.querySelectorAll(".qty-row input").forEach((inp) => {
    const kg = parseFloat(inp.value);
    if (kg > 0) items.push({ produceId: inp.dataset.pid, kg });
  });
  if (items.length === 0) { alert(t("needProduce")); return; }

  const farmer = {
    id: "f" + (db.farmers.length + 1) + "_" + Date.now().toString(36),
    name: $("fName").value.trim(),
    phone: $("fPhone").value.trim(),
    scale: document.querySelector('input[name="scale"]:checked').value,
    village: $("fVillage").value.trim(),
    lat: regLocation.lat, lng: regLocation.lng,
  };
  db.farmers.push(farmer);

  const cp = nearestCP(farmer.lat, farmer.lng);
  db.trips.push({
    id: "t" + (db.trips.length + 1) + "_" + Date.now().toString(36),
    farmerId: farmer.id, date: todayStr(), cpId: cp.id, items,
  });
  saveDb();

  $("regForm").reset();
  selectedProduce.clear();
  regLocation = null;
  if (regMarker) { regMarker.remove(); regMarker = null; }
  renderChips(); renderQtyInputs();
  const loc = $("locStatus");
  loc.textContent = t("locNotSet");
  loc.classList.remove("ok");

  renderTransport(); renderMarket(); renderMapMarkers();
  alert(t("regSuccess"));
}

// ---------- transport groups ----------
const todaysTrips = () => db.trips.filter((tr) => tr.date === todayStr());

function vehicleFor(totalKg) {
  return VEHICLE_TIERS.find((v) => totalKg <= v.max);
}

function renderTransport() {
  const trips = todaysTrips();
  const box = $("transportGroups");
  if (trips.length === 0) {
    box.innerHTML = `<div class="empty-state">${t("noTrips")}</div>`;
    return;
  }
  const byCp = {};
  trips.forEach((tr) => { (byCp[tr.cpId] = byCp[tr.cpId] || []).push(tr); });

  box.innerHTML = Object.entries(byCp).map(([cpId, group]) => {
    const cp = cpById(cpId);
    const dest = bazarById(cp.bazarId);
    const cpToBazar = haversine(cp.lat, cp.lng, dest.lat, dest.lng);
    const totalKg = group.reduce((s, tr) => s + tr.items.reduce((a, i) => a + i.kg, 0), 0);
    const veh = vehicleFor(totalKg);
    const sharedTotal = Math.round(cpToBazar * 2 * veh.rate);
    const perFarmer = Math.round(sharedTotal / group.length);

    const rows = group.map((tr) => {
      const f = farmerById(tr.farmerId);
      const kg = tr.items.reduce((a, i) => a + i.kg, 0);
      const itemsTxt = tr.items.map((i) => {
        const p = produceById(i.produceId);
        return `${p.emoji} ${name(p)}`;
      }).join(", ");
      return `<tr><td>${f ? f.name : "?"}</td><td>${f ? f.village : ""}</td><td>${itemsTxt}</td><td>${kg}</td></tr>`;
    }).join("");

    const soloAvg = Math.round(group.reduce((s, tr) => {
      const f = farmerById(tr.farmerId);
      return s + (f ? haversine(f.lat, f.lng, dest.lat, dest.lng) * 2 * RATE_SOLO : 0);
    }, 0) / group.length);

    const waLines = [
      `🌾 ${t("waHeader")} (${todayStr()})`,
      `📦 ${name(cp)} → 🏪 ${name(dest)}`,
      ...group.map((tr) => {
        const f = farmerById(tr.farmerId);
        const kg = tr.items.reduce((a, i) => a + i.kg, 0);
        return `• ${f ? f.name : "?"} (${f ? f.village : ""}) — ${kg} kg`;
      }),
      `🚚 ${t("waVehicle")}: ${t(veh.key)}`,
      `💰 ${t("waCostEach")}: ₹${perFarmer}`,
    ];
    const waUrl = "https://wa.me/?text=" + encodeURIComponent(waLines.join("\n"));

    return `<div class="group-card">
      <h3>📦 ${name(cp)} — ${group.length} ${t("farmers")}, ${totalKg} kg</h3>
      <div class="route">🛣️ ${lang === "te" ? cp.hwyTe : cp.hwyEn} → 🏪 ${name(dest)} (${cpToBazar.toFixed(0)} km)</div>
      <table><thead><tr><th>${t("colFarmer")}</th><th>${t("colVillage")}</th><th>${t("colItems")}</th><th>${t("colKg")}</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="vehicle-tip">🚚 <b>${t("vehicle")}:</b> ${t(veh.key)}<br>
        💰 <b>${t("sharedCost")}:</b> ₹${perFarmer} &nbsp;|&nbsp; ${t("soloCost")}: ₹${soloAvg}</div>
      <a class="wa-btn" target="_blank" rel="noopener" href="${waUrl}">${t("shareWa")}</a>
    </div>`;
  }).join("");
}

// ---------- market demand ----------
function marketAggregation() {
  const byBazar = {};
  todaysTrips().forEach((tr) => {
    const cp = cpById(tr.cpId);
    const bId = cp.bazarId;
    byBazar[bId] = byBazar[bId] || {};
    tr.items.forEach((i) => {
      const cell = (byBazar[bId][i.produceId] = byBazar[bId][i.produceId] || { kg: 0, cps: new Set(), farmers: 0 });
      cell.kg += i.kg;
      cell.cps.add(cp.id);
      cell.farmers += 1;
    });
  });
  return byBazar;
}

function exportMarketCsv() {
  const byBazar = marketAggregation();
  const rows = [["Bazar", "Produce", "Kg", "Collection points", "Farmers"]];
  Object.entries(byBazar).forEach(([bId, produce]) => {
    const b = bazarById(bId);
    Object.entries(produce).forEach(([pid, cell]) => {
      const p = produceById(pid);
      rows.push([
        `${b.en} / ${b.te}`, `${p.en} / ${p.te}`, cell.kg,
        [...cell.cps].map((cid) => cpById(cid).en).join("; "), cell.farmers,
      ]);
    });
  });
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "market-demand-" + todayStr() + ".csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderMarket() {
  const box = $("marketDemand");
  const byBazar = marketAggregation();

  if (Object.keys(byBazar).length === 0) {
    box.innerHTML = `<div class="empty-state">${t("noTrips")}</div>`;
  } else {
    box.innerHTML = Object.entries(byBazar).map(([bId, produce]) => {
      const b = bazarById(bId);
      const rows = Object.entries(produce)
        .sort((x, y) => y[1].kg - x[1].kg)
        .map(([pid, cell]) => {
          const p = produceById(pid);
          const cps = [...cell.cps].map((cid) => name(cpById(cid))).join(", ");
          return `<tr><td>${p.emoji} ${name(p)}</td><td>${cell.kg}</td><td>${cps}</td><td>${cell.farmers}</td></tr>`;
        }).join("");
      const total = Object.values(produce).reduce((s, c) => s + c.kg, 0);
      return `<div class="demand-card">
        <h3>🏪 ${name(b)} — ${t("incomingToday")}: ${total} kg</h3>
        <table><thead><tr><th>${t("colProduce")}</th><th>${t("colQty")}</th><th>${t("colFrom")}</th><th>${t("colFarmers")}</th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>`;
    }).join("");
  }

  $("bazarDirectory").innerHTML = BAZARS.map((b) =>
    `<div class="bazar-tile"><b>🥬 ${name(b)}</b>${t("timings")}: ${BAZAR_TIMINGS[lang]}</div>`).join("");
}

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "map" && mainMap) setTimeout(() => mainMap.invalidateSize(), 50);
    if (btn.dataset.tab === "register") {
      if (!regMapInited) initRegMap();
      setTimeout(() => regMap.invalidateSize(), 50);
    }
  };
});

// ---------- boot ----------
$("langToggle").onclick = () => {
  lang = lang === "te" ? "en" : "te";
  localStorage.setItem("rc_lang", lang);
  applyI18n();
};
$("regForm").addEventListener("submit", handleRegister);

$("editPinsBtn").onclick = () => {
  editMode = !editMode;
  $("editPinsBtn").classList.toggle("active", editMode);
  $("editHint").classList.toggle("hidden", !editMode);
  renderMapMarkers();
};

$("resetPinsBtn").onclick = () => {
  pinOverrides = {};
  localStorage.removeItem("rc_pins");
  [...BAZARS, ...COLLECTION_POINTS].forEach((p) => {
    const o = ORIG_COORDS[p.id];
    p.lat = o.lat; p.lng = o.lng;
  });
  renderMapMarkers(); renderTransport(); renderMarket(); updatePinButtons();
};

$("exportCsvBtn").onclick = exportMarketCsv;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* offline install is best-effort */ });
}

initMainMap();
renderChips();
applyI18n();
updatePinButtons();
