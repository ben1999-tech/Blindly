// Blindly – Server ohne externe Pakete (nur Node.js >= 18)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ACTIVE_MS = 3 * 60 * 1000;     // so lange gilt ein Nutzer als aktiv
const MAX_PROFILES = 2000;

const SIGNS = { Widder:"F", Stier:"E", Zwillinge:"L", Krebs:"W", Löwe:"F", Jungfrau:"E",
  Waage:"L", Skorpion:"W", Schütze:"F", Steinbock:"E", Wassermann:"L", Fische:"W" };
const GENDERS = ["weiblich", "männlich", "divers"];
const SEEK = [...GENDERS, "alle"];
const HOBBIES = ["Wandern","Lesen","Gaming","Kochen","Reisen","Fotografie","Musik","Sport","Kino",
  "Tanzen","Malen","Yoga","Radfahren","Gärtnern","Programmieren","Brettspiele"];

const profiles = new Map(); // id -> Profil (nur im Arbeitsspeicher)
const page = fs.readFileSync(path.join(__dirname, "index.html"));

function signScore(a, b) {
  const x = SIGNS[a], y = SIGNS[b];
  if (x === y) return 80;
  const p = [x, y].sort().join("");
  return p === "FL" || p === "EW" ? 100 : 40;
}
const wants = (p, q) => p.seek === "alle" || p.seek === q.gender;

function score(a, b) {
  const common = a.hobbies.filter(h => b.hobbies.includes(h));
  const union = new Set([...a.hobbies, ...b.hobbies]).size || 1;
  return { pct: Math.round(60 * common.length / union + 40 * signScore(a.sign, b.sign) / 100), common };
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 10000) { reject(new Error("too big")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// einfache Begrenzung: 120 Anfragen pro Minute und IP
const hits = new Map();
function limited(ip) {
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  return n > 120;
}
setInterval(() => hits.clear(), 60 * 1000).unref();

// inaktive Profile entfernen
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of profiles) if (now - p.lastSeen > ACTIVE_MS) profiles.delete(id);
}, 30 * 1000).unref();

const validId = id => typeof id === "string" && /^[\w-]{8,64}$/.test(id);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });

    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (limited(ip)) return json(res, 429, { error: "zu viele Anfragen" });

    if (req.method === "POST" && url.pathname === "/api/profile") {
      const b = JSON.parse(await readBody(req));
      const name = String(b.name || "Anonym").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24) || "Anonym";
      if (!validId(b.id) || !(b.sign in SIGNS) || !GENDERS.includes(b.gender) || !SEEK.includes(b.seek))
        return json(res, 400, { error: "ungültige Angaben" });
      const hobbies = [...new Set((Array.isArray(b.hobbies) ? b.hobbies : []).filter(h => HOBBIES.includes(h)))];
      if (!profiles.has(b.id) && profiles.size >= MAX_PROFILES) return json(res, 503, { error: "voll" });
      profiles.set(b.id, { name, sign: b.sign, gender: b.gender, seek: b.seek, hobbies, lastSeen: Date.now() });
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/matches") {
      const id = url.searchParams.get("id");
      const me = validId(id) && profiles.get(id);
      if (!me) return json(res, 404, { error: "unknown" });
      const now = Date.now();
      me.lastSeen = now; // Lebenszeichen
      const matches = [...profiles.entries()]
        .filter(([oid, p]) => oid !== id && now - p.lastSeen < ACTIVE_MS && wants(me, p) && wants(p, me))
        .map(([, p]) => ({ name: p.name, sign: p.sign, gender: p.gender, ...score(me, p) }))
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 4);
      return json(res, 200, { matches, active: profiles.size });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: "bad request" });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log("Blindly läuft auf Port " + PORT));
