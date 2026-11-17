#!/usr/bin/env node
/**
 * Local PSN price proxy.
 * GET /game?id=<concept|product|url>&region=en-us|ar-sa
 * GET /health
 *
 * Disk cache first → 0 API.SH credits on hit.
 * CORS * so psn-price-compare.html can call it from file:// or any origin.
 * Key stays in key.txt — never in the HTML.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PSN_PROXY_PORT || 8787);
const HOST = process.env.PSN_PROXY_HOST || "127.0.0.1";
const ROOT = __dirname;
const CACHE_DIR = path.join(ROOT, "cache");
const KEY_FILE = path.join(ROOT, "key.txt");
const API_BASE = "https://api.api.sh/playstation/v1/game";
const HTML_PATH = path.join(ROOT, "..", "psn-price-compare.html");

// Regions the page uses → API.SH language-country codes
const REGION_MAP = {
  "en-us": "en-us",
  "ar-sa": "ar-sa",
  sa: "ar-sa",
  us: "en-us",
};

let apiKey = "";
try {
  apiKey = fs.readFileSync(KEY_FILE, "utf8").trim();
} catch (_) {
  console.error("[psn-proxy] missing key.txt");
  process.exit(1);
}
if (!apiKey) {
  console.error("[psn-proxy] empty key.txt");
  process.exit(1);
}

fs.mkdirSync(CACHE_DIR, { recursive: true });

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  // Chrome Private Network Access: file:// / non-secure → 127.0.0.1 preflight
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function log(line) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${line}`);
}

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  cors(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...(extraHeaders || {}),
  });
  res.end(payload);
}

function normalizeRegion(raw) {
  const r = String(raw || "en-us").toLowerCase().trim();
  return REGION_MAP[r] || (r.includes("-") ? r : null);
}

function cacheKeyFor(id, region) {
  // Safe filename: keep alphanumerics, dash, underscore, dot
  const safeId = String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  const safeRegion = String(region).replace(/[^A-Za-z0-9-]/g, "");
  return path.join(CACHE_DIR, `${safeRegion}__${safeId}.json`);
}

function readCache(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    if (obj && obj.ok && obj.data != null) return obj;
  } catch (_) {}
  return null;
}

function writeCache(file, data) {
  try {
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify({ ok: true, savedAt: new Date().toISOString(), data })
    );
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error("[psn-proxy] cache write failed:", err.message);
  }
}

async function fetchUpstream(id, region) {
  const url = new URL(API_BASE);
  // Prefer product/concept id; fall back to full store URL passthrough
  if (/^https?:\/\//i.test(id)) url.searchParams.set("url", id);
  else url.searchParams.set("id", id);
  url.searchParams.set("region", region);

  const res = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      Accept: "application/json",
      "User-Agent": "psn-local-proxy/1.0",
    },
  });

  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = { success: false, error: text.slice(0, 300) || ("HTTP " + res.status) };
  }

  return {
    status: res.status,
    body,
    creditsUsed: Number(res.headers.get("x-credits-used") || 0),
    creditsRemaining: res.headers.get("x-credits-remaining"),
  };
}

async function handleGame(req, res, parsed) {
  const t0 = Date.now();
  const rawId = (parsed.searchParams.get("id") || parsed.searchParams.get("url") || "").trim();
  const region = normalizeRegion(parsed.searchParams.get("region"));
  const force = parsed.searchParams.get("fresh") === "1";
  const peer = req.socket.remoteAddress || "?";

  const done = (status, cache, credits, note) => {
    const ms = Date.now() - t0;
    log(
      `GAME ${status} cache=${cache} credits=${credits} ${ms}ms region=${region || "-"} id=${rawId || "-"} from=${peer}${note ? " " + note : ""}`
    );
  };

  if (!rawId) {
    done(400, "-", 0, "err=missing-id");
    sendJson(res, 400, { success: false, error: "missing id or url" });
    return;
  }
  if (!region) {
    done(400, "-", 0, "err=bad-region");
    sendJson(res, 400, {
      success: false,
      error: "invalid region (use en-us or ar-sa)",
    });
    return;
  }

  const file = cacheKeyFor(rawId, region);

  if (!force) {
    const hit = readCache(file);
    if (hit) {
      done(200, "HIT", 0);
      sendJson(res, 200, hit.data, {
        "X-Cache": "HIT",
        "X-Credits-Used": "0",
      });
      return;
    }
  }

  let upstream;
  try {
    upstream = await fetchUpstream(rawId, region);
  } catch (err) {
    done(502, "MISS", 0, `err=${err.message}`);
    sendJson(res, 502, {
      success: false,
      error: "upstream: " + err.message,
    });
    return;
  }

  // Cache successful game payloads (including empty-ish but valid games).
  // Do not cache hard failures (401/403/5xx) so a fixed key can recover.
  let cached = "MISS";
  if (upstream.status >= 200 && upstream.status < 300 && upstream.body) {
    if (upstream.body.success !== false) {
      writeCache(file, upstream.body);
      cached = "MISS+STORED";
    }
  }

  const name =
    (upstream.body && (upstream.body.name || upstream.body.product_id)) || "";
  done(
    upstream.status,
    force ? "FRESH" : cached,
    upstream.creditsUsed || 0,
    `remaining=${upstream.creditsRemaining || "?"}${name ? " name=" + JSON.stringify(name) : ""}`
  );

  sendJson(res, upstream.status, upstream.body, {
    "X-Cache": force ? "FRESH" : "MISS",
    "X-Credits-Used": String(upstream.creditsUsed || 0),
    ...(upstream.creditsRemaining != null
      ? { "X-Credits-Remaining": String(upstream.creditsRemaining) }
      : {}),
  });
}

function handleHealth(res) {
  let files = 0;
  try {
    files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json")).length;
  } catch (_) {}
  sendJson(res, 200, {
    ok: true,
    cacheFiles: cacheFilesCount(files),
    keyLoaded: !!apiKey,
    html: fs.existsSync(HTML_PATH),
    time: new Date().toISOString(),
  });
}

function cacheFilesCount(n) {
  return n;
}

function serveHtml(res) {
  try {
    const html = fs.readFileSync(HTML_PATH);
    cors(res);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": html.length,
      "Cache-Control": "no-store",
    });
    res.end(html);
    log(`HTML 200 ${HTML_PATH} bytes=${html.length}`);
  } catch (err) {
    log(`HTML 500 err=${err.message}`);
    sendJson(res, 500, { success: false, error: "html: " + err.message });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      log(`OPTIONS ${parsed.pathname} from=${req.socket.remoteAddress || "?"} -> 204`);
      return;
    }

    // Page diagnostics beacon (POST /log) — browser saved-state summary
    if (req.method === "POST" && parsed.pathname === "/log") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").slice(0, 4000);
        log(`PAGE ${body}`);
        cors(res);
        res.writeHead(204);
        res.end();
      });
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { success: false, error: "method not allowed" });
      return;
    }

    if (parsed.pathname === "/health" || parsed.pathname === "/healthz") {
      handleHealth(res);
      return;
    }

    // Serve the compare page same-origin so the browser can call /game
    // without file:// → 127.0.0.1 CORS / Private-Network blocks.
    if (parsed.pathname === "/" || parsed.pathname === "/index.html" || parsed.pathname === "/app") {
      serveHtml(res);
      return;
    }

    if (parsed.pathname === "/game") {
      await handleGame(req, res, parsed);
      return;
    }

    log(`404 ${parsed.pathname} from=${req.socket.remoteAddress || "?"}`);
    sendJson(res, 404, { success: false, error: "not found" });
  } catch (err) {
    log(`ERROR ${err && err.message}`);
    try {
      sendJson(res, 500, { success: false, error: String(err && err.message) });
    } catch (_) {}
  }
});

server.listen(PORT, HOST, () => {
  log(`listen http://${HOST}:${PORT}/game  cache=${CACHE_DIR}`);
});
