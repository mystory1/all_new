/*
 * Habits Dashboard API – Cloudflare Worker
 *
 * Integrácia:
 * 1) V existujúcom Workerovi pridaj route /api/dashboard a presmeruj ju na
 *    handleDashboardApi(request).
 * 2) Alebo tento kód vlož do existujúceho Worker entrypointu a v hlavnom
 *    fetch handleri zavolaj handleDashboardApi(request) pre /api/dashboard.
 *
 * Všetky upstream požiadavky idú zo servera Worker -> odpadá browser CORS
 * aj externá proxy. Žiadne Cache API, KV ani uloženie odpovedí sa nepoužíva.
 */

const SOURCES = {
  lumiere: "https://www.citylife.sk/miesto/kino-lumiere-bratislava",
  mladost: "https://www.citylife.sk/miesto/kino-mladost",
  filmEurope: "https://www.citylife.sk/miesto/kino-film-europe",
  cinemaCity: "https://www.cinemacity.sk/static/sk/sk/offers"
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
  "Vary": "Origin"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: JSON_HEADERS});
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToLines(html) {
  return decodeEntities(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/<\/(p|div|li|article|section|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split(/\r?\n/)
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseCitylife(html) {
  const lines = htmlToLines(html);
  const groups = [];
  let current = null;

  for (const line of lines) {
    const dateMatch = line.match(/^(\d{1,2}\.\d{1,2}\.\d{4})(?:,|\s|$)/);
    if (dateMatch) {
      const date = dateMatch[1];
      if (!current || current.date !== date) {
        current = {date, items: []};
        groups.push(current);
      }
      continue;
    }

    const show = line.match(/^(\d{1,2}):([0-5]\d)\s*\|\s*(.*?)\s*\|\s*(?:\||film\b|festival\b|kidstown\b|$)/i);
    if (current && show) {
      const title = show[3].replace(/\s+/g, " ").trim();
      if (title && !/^(film|program|vstupenky)$/i.test(title)) {
        const item = {time: `${show[1].padStart(2,"0")}:${show[2]}`, title};
        if (!current.items.some(x => x.time === item.time && x.title === item.title)) current.items.push(item);
      }
    }
  }

  return groups.filter(g => g.items.length);
}

function parseCinemaCity(html) {
  const lines = htmlToLines(html);
  const joined = lines.join(" ").replace(/\s+/g, " ");
  const candidates = [
    /FILMÁNIA[\s\S]{0,500}?film:\s*([^.!?–—-]{2,120})/i,
    /FILMÁNIA[\s\S]{0,500}?akcia na film:\s*([^.!?]{2,120})/i
  ];
  for (const re of candidates) {
    const match = joined.match(re);
    if (match) return match[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

async function fetchFresh(url) {
  const u = new URL(url);
  u.searchParams.set("_habits_nocache", `${Date.now()}-${crypto.randomUUID()}`);
  const response = await fetch(u.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "Cache-Control": "no-cache, no-store, max-age=0",
      "Pragma": "no-cache",
      "User-Agent": "HabitsDashboard/1.0"
    },
    cf: {cacheTtl: 0, cacheEverything: false}
  });
  if (!response.ok) throw new Error(`Zdroj vrátil HTTP ${response.status}`);
  const text = await response.text();
  if (!text || text.length < 100) throw new Error("Zdroj vrátil prázdnu alebo neúplnú odpoveď.");
  if (/captcha|access denied|just a moment|cloudflare ray id/i.test(text.slice(0,8000))) {
    throw new Error("Zdroj zablokoval automatické načítanie.");
  }
  return text;
}

async function sourceResult(name, url, parser) {
  try {
    const html = await fetchFresh(url);
    const data = parser(html);
    if (!data || (Array.isArray(data) && data.length === 0)) {
      throw new Error("Stránka odpovedala, ale program sa nepodarilo rozpoznať.");
    }
    return {ok: true, data, fetchedAt: new Date().toISOString(), source: url};
  } catch (error) {
    return {ok: false, data: null, error: String(error?.message || error), source: url};
  }
}

async function loadWeather(lat, lon) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.search = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    current: "temperature_2m,wind_speed_10m",
    hourly: "precipitation_probability",
    forecast_days: "1", timezone: "auto"
  }).toString();
  u.searchParams.set("_habits_nocache", `${Date.now()}-${crypto.randomUUID()}`);
  const response = await fetch(u.toString(), {
    headers: {"Cache-Control":"no-cache, no-store", "Pragma":"no-cache"},
    cf: {cacheTtl: 0, cacheEverything: false}
  });
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const data = await response.json();
  if (!data.current) throw new Error("Open-Meteo nevrátil aktuálne počasie.");
  const currentTime = String(data.current.time || "").slice(0,16);
  const idx = Array.isArray(data.hourly?.time)
    ? data.hourly.time.findIndex(t => String(t).slice(0,16) === currentTime) : -1;
  return {
    temperature: data.current.temperature_2m,
    wind: data.current.wind_speed_10m,
    rainProbability: idx >= 0 ? data.hourly.precipitation_probability?.[idx] ?? null : null,
    observedAt: data.current.time,
    timezone: data.timezone
  };
}

export async function handleDashboardApi(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/dashboard") return new Response("Not found", {status:404});
  if (request.method !== "GET") return json({error:"Method not allowed"},405);

  const latRaw = Number(url.searchParams.get("lat"));
  const lonRaw = Number(url.searchParams.get("lon"));
  const validCoords = Number.isFinite(latRaw) && Number.isFinite(lonRaw)
    && Math.abs(latRaw) <= 90 && Math.abs(lonRaw) <= 180;
  const lat = validCoords ? latRaw : 48.1486;
  const lon = validCoords ? lonRaw : 17.1077;

  const [weather, lumiere, mladost, filmEurope, cinemaCity] = await Promise.all([
    loadWeather(lat,lon).then(data=>({ok:true,data,source:"Open-Meteo",fetchedAt:new Date().toISOString()}))
      .catch(error=>({ok:false,error:String(error?.message||error),source:"Open-Meteo"})),
    sourceResult("lumiere",SOURCES.lumiere,parseCitylife),
    sourceResult("mladost",SOURCES.mladost,parseCitylife),
    sourceResult("filmEurope",SOURCES.filmEurope,parseCitylife),
    sourceResult("cinemaCity",SOURCES.cinemaCity,parseCinemaCity)
  ]);

  return json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    cache: "disabled",
    weather, lumiere, mladost, filmEurope, cinemaCity
  });
}

/* Integrácia do EXISTUJÚCEHO Worker entrypointu:
 *
 * V existujúcom export default { async fetch(request, env, ctx) { ... } vlož
 * hneď po vytvorení URL túto podmienku:
 *
 *   if (url.pathname === "/api/dashboard") return handleDashboardApi(request);
 *
 * Ostatné routy (napr. /3) nechaj bez zmeny. Tento súbor je API modul/snippet,
 * nie náhrada existujúceho Worker entrypointu.
 */
