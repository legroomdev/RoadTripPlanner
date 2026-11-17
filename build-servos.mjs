// Builds servos.json: every fuel station in Australia from OpenStreetMap, slimmed down for the app.
// Run by .github/workflows/update-servos.yml every week (or by hand: `node build-servos.mjs`).
// Needs Node 18+ (built-in fetch). Only rewrites the files when the servo data has actually changed.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// One query per state/territory: small enough that each answers well inside Node's 5-minute wait limit.
const REGIONS = ["AU-SA", "AU-VIC", "AU-NSW", "AU-ACT", "AU-QLD", "AU-WA", "AU-TAS", "AU-NT"];
const queryFor = (code) =>
  `[out:json][timeout:180];area["ISO3166-2"="${code}"]->.s;nwr["amenity"="fuel"](area.s);out center tags;`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bit flags for which fuels a servo sells (and which it's recorded as NOT selling). Anything else is "unknown".
const FUELS = [
  ["fuel:octane_91", 1],
  ["fuel:e10", 2],
  ["fuel:octane_95", 4],
  ["fuel:octane_98", 8],
  ["fuel:diesel", 16],
  ["fuel:lpg", 32],
];
const STATES = {
  "South Australia": "SA", Victoria: "VIC", "New South Wales": "NSW", Queensland: "QLD",
  "Western Australia": "WA", Tasmania: "TAS", "Northern Territory": "NT", "Australian Capital Territory": "ACT",
};
const COLS = ["id", "lat", "lon", "name", "street", "town", "state", "postcode", "yes", "no", "h24"];
const MIN_EXPECTED = 2000; // refuse to publish an obviously incomplete download

async function fetchRegion(code) {
  for (let round = 1; round <= 3; round++) {
    for (const url of SERVERS) {
      try {
        const els = await query(url, queryFor(code));
        if (els) return els;
      } catch (err) {
        console.warn(`  ${code} via ${url} failed: ${err.message}`);
      }
    }
    console.warn(`  ${code}: retrying in ${20 * round}s…`);
    await sleep(20000 * round);
  }
  throw new Error(`Couldn't download ${code} after 3 tries. Try again later.`);
}

async function fetchServos() {
  const all = [];
  for (const code of REGIONS) {
    const els = await fetchRegion(code);
    console.log(`  ${code}: ${els.length} map entries`);
    if (els.length === 0) throw new Error(`${code} came back empty, which can't be right. Not publishing.`);
    all.push(...els);
    await sleep(3000); // be polite to the free server
  }
  return all;
}

async function query(url, q) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "RoadTripPlanner servo data builder (GitHub Actions)",
    },
    body: "data=" + encodeURIComponent(q),
    signal: AbortSignal.timeout(240000), // give up before Node's own 5-minute limit
  });
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  const json = await res.json();
  if (json.remark && /timed out|runtime error|out of memory/i.test(json.remark)) throw new Error(json.remark);
  return json.elements || [];
}

export function buildRows(elements) {
  const rows = [];
  const near = new Map(); // same servo mapped as a point and as a building outline
  // Points first, so the point (usually the better-tagged one) wins over its building outline
  const sorted = [...elements].sort((a, b) => (a.type === "node" ? 0 : 1) - (b.type === "node" ? 0 : 1));
  for (const el of sorted) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const t = el.tags || {};
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (near.has(key)) {
      const row = near.get(key); // fill gaps in the kept entry from the duplicate
      if (!row[4] && t["addr:street"]) row[4] = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
      continue;
    }
    const brand = t.brand || "";
    let name = t.name || brand || "Servo";
    if (brand && !name.toLowerCase().includes(brand.toLowerCase())) name = `${brand} ${name}`;
    let yes = 0, no = 0;
    for (const [tag, bit] of FUELS) {
      if (t[tag] === "yes") yes |= bit;
      else if (t[tag] === "no") no |= bit;
    }
    const row = [
      el.type + el.id,
      +lat.toFixed(5),
      +lon.toFixed(5),
      name,
      [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "),
      t["addr:suburb"] || t["addr:city"] || t["addr:town"] || "",
      STATES[t["addr:state"]] || t["addr:state"] || "",
      t["addr:postcode"] || "",
      yes,
      no,
      t.opening_hours === "24/7" ? 1 : 0,
    ];
    near.set(key, row);
    rows.push(row);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // stable order = clean diffs
  return rows;
}

async function main() {
  console.log("Downloading Australian servos from OpenStreetMap…");
  const elements = await fetchServos();
  const rows = buildRows(elements);
  console.log(`Got ${elements.length} map entries → ${rows.length} servos`);
  if (rows.length < MIN_EXPECTED) throw new Error(`Only ${rows.length} servos: looks incomplete, not publishing.`);

  const version = createHash("sha1").update(JSON.stringify(rows)).digest("hex").slice(0, 12);
  if (existsSync("servos-meta.json")) {
    const old = JSON.parse(readFileSync("servos-meta.json", "utf8"));
    if (old.v === version) { console.log("No changes since last time."); return; }
  }
  const updated = new Date().toISOString().slice(0, 10);
  writeFileSync("servos.json", JSON.stringify({ v: version, updated, n: rows.length, cols: COLS, rows }));
  writeFileSync("servos-meta.json", JSON.stringify({ v: version, updated, n: rows.length }) + "\n");
  console.log(`Wrote servos.json (version ${version}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
