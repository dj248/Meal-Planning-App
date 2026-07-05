const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");

const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const PORT = Number(process.env.PORT || 8080);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const STATE_FILE = path.join(DATA_DIR, "app-state.json");

const RECIPE_SEARCH_ENDPOINTS = [
  "https://www.budgetbytes.com/wp-json/wp/v2/search?search={query}&per_page=8",
  "https://www.loveandlemons.com/wp-json/wp/v2/search?search={query}&per_page=8",
  "https://pinchofyum.com/wp-json/wp/v2/search?search={query}&per_page=8",
  "https://www.twopeasandtheirpod.com/wp-json/wp/v2/search?search={query}&per_page=8",
  "https://www.ambitiouskitchen.com/wp-json/wp/v2/search?search={query}&per_page=8"
];

const MAX_RECIPES = 5;
const MAX_URLS_TO_PARSE = 10;
const MAX_ENDPOINTS_PER_QUERY = 3;
const MAX_RESULTS_PER_ENDPOINT = 4;
const RECOMMENDATION_BUDGET_MS = 6000;
const MAX_FULL_PARSE_ATTEMPTS = 4;
const pageCache = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/state") {
      const state = await readState();
      return sendJson(res, { exists: Boolean(state), state: state || {} });
    }

    if (req.method === "POST" && url.pathname === "/api/state") {
      const payload = await readJsonBody(req);
      await writeState(payload);
      return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/recommend") {
      const payload = await readJsonBody(req);
      const recipes = await searchAndParseRecipes(payload);
      if (recipes.length) return sendJson(res, { recipes });

      const key = process.env.OPENAI_API_KEY;
      if (key) return sendJson(res, await askOpenAI(key, payload));
      return sendJson(res, { recipes: [] });
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { error: String(error.message || error) }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`On the Table running at http://127.0.0.1:${PORT}/`);
});

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(ROOT_DIR, requested));
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function ensureRuntimeDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function readState() {
  try {
    const text = await fsp.readFile(STATE_FILE, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeState(state) {
  await ensureRuntimeDirs();
  const tempPath = path.join(DATA_DIR, `app-state-${Date.now()}.json`);
  await fsp.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, STATE_FILE);
}

async function askOpenAI(key, payload) {
  const instructions = [
    "You are a practical meal-planning assistant. Recommend real recipes from the web, not invented recipes.",
    "Use the user's saved preferences, ratings, notes, and idea.",
    "Return strict JSON with a recipes array.",
    "Each recipe must have name, source, url, minutes, prepMinutes, servings, reason, tags, and ingredients.",
    "ingredients must be objects with name and category."
  ].join(" ");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      reasoning: { effort: "low" },
      instructions,
      tools: [{ type: "web_search_preview" }],
      input: JSON.stringify(payload, null, 2)
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  const text = extractOutputText(data);
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    if (Array.isArray(parsed.recipes)) return { recipes: parsed.recipes };
  } catch {
    // Return text below when the model did not produce strict JSON.
  }
  return { text };
}

async function searchAndParseRecipes(payload) {
  const started = Date.now();
  const queries = buildQueries(payload);
  const candidates = [];

  for (const query of queries) {
    candidates.push(...await searchRecipeSites(query));
    if (candidates.length >= MAX_URLS_TO_PARSE) break;
  }

  const recipes = [];
  const fallbackRecipes = [];
  const seen = new Set();
  let parseAttempts = 0;

  for (const candidate of candidates) {
    if (Date.now() - started > RECOMMENDATION_BUDGET_MS && (recipes.length || fallbackRecipes.length)) break;
    const cleanUrl = cleanResultUrl(candidate.url);
    if (!cleanUrl || seen.has(cleanUrl)) continue;
    seen.add(cleanUrl);
    if (!looksLikeRecipeUrl(cleanUrl)) continue;

    const fallback = fallbackRecipeFromCandidate(candidate, cleanUrl, payload);
    if (fallback && matchesPreferences(fallback, payload)) fallbackRecipes.push(fallback);

    if (parseAttempts >= MAX_FULL_PARSE_ATTEMPTS) continue;
    try {
      parseAttempts += 1;
      const recipe = await parseRecipePage(cleanUrl, payload);
      if (recipe && looksLikeRecipe(recipe) && matchesPreferences(recipe, payload)) recipes.push(recipe);
    } catch {
      // Ignore individual page failures.
    }

    if (recipes.length >= MAX_RECIPES) break;
  }

  for (const recipe of fallbackRecipes) {
    if (!recipes.some((item) => item.url === recipe.url)) recipes.push(recipe);
    if (recipes.length >= MAX_RECIPES) break;
  }

  return recipes;
}

function buildQueries(payload) {
  const prefs = payload.preferences || {};
  const idea = payload.idea || "";
  const liked = (payload.recipes || [])
    .filter((recipe) => Number(recipe.rating || 0) >= 4)
    .slice(0, 3)
    .map((recipe) => recipe.name);
  const ideaParts = splitIdea(idea);
  const diet = prefs.diet || "";
  const likes = prefs.likes || "";
  const maxMinutes = prefs.maxMinutes || 40;

  const baseParts = [idea, diet, likes, `${maxMinutes} minute recipe`, "recipe"];
  if (liked.length) baseParts.push(`similar to ${liked.join(" ")}`);
  if (prefs.avoid) {
    baseParts.push(...String(prefs.avoid).split(",").map((item) => `-${item.trim()}`).filter(Boolean));
  }

  const candidates = [
    ...ideaParts.map((part) => `${part} ${diet} ${likes} ${maxMinutes} minute recipe`),
    ...ideaParts.map((part) => `${part} ${diet} dinner`),
    ...ideaParts.map((part) => `quick ${part}`),
    baseParts.filter(Boolean).join(" "),
    idea,
    `quick ${diet}`,
    `${likes} ${diet}`,
    `${diet} ${likes} dinner`,
    `${diet} dinner`,
    `${likes} dinner`,
    `${maxMinutes} minute ${diet} dinner`
  ];

  const cleaned = [];
  for (const query of candidates) {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (normalized && !cleaned.includes(normalized)) cleaned.push(normalized);
  }
  return cleaned;
}

function splitIdea(idea) {
  const text = String(idea || "").toLowerCase().replace(/\b(and|or|also|plus|with)\b/g, ",");
  const generic = new Set(["quick", "easy", "dinner", "dinners", "lunch", "lunches", "recipe", "recipes", "meal", "meals"]);
  const parts = text.split(/[,;/\n]+/).map((part) => part.trim().replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const focused = parts
    .map((part) => part.split(/\s+/).filter((word) => !generic.has(word)).slice(0, 5).join(" "))
    .filter(Boolean);
  return focused.slice(0, 4).length ? focused.slice(0, 4) : [idea];
}

async function searchRecipeSites(query) {
  const candidates = [];
  const shortQuery = simplifySearchQuery(query);
  for (const endpoint of RECIPE_SEARCH_ENDPOINTS.slice(0, MAX_ENDPOINTS_PER_QUERY)) {
    try {
      const url = endpoint.replace("{query}", encodeURIComponent(shortQuery));
      const results = JSON.parse(await fetchUrl(url));
      for (const item of results.slice(0, MAX_RESULTS_PER_ENDPOINT)) {
        const recipeUrl = item.url;
        const title = cleanupTitle(textValue(item.title));
        if (!recipeUrl || looksLikeRoundup(title, recipeUrl)) continue;
        candidates.push({ url: recipeUrl, title });
      }
    } catch {
      // Ignore site search failures.
    }
  }
  return candidates;
}

function simplifySearchQuery(query) {
  const stop = new Set(["recipe", "minutes", "minute", "less", "similar", "to"]);
  return String(query || "")
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !word.startsWith("-") && !stop.has(word.toLowerCase()))
    .slice(0, 8)
    .join(" ") || "quick dinner";
}

function fallbackRecipeFromCandidate(candidate, url, payload) {
  const title = cleanupTitle(candidate.title || path.basename(new URL(url).pathname).replace(/-/g, " "));
  if (!title || looksLikeRoundup(title, url)) return null;
  return {
    name: title,
    source: new URL(url).hostname.replace(/^www\./, ""),
    url,
    minutes: Number(payload.preferences?.maxMinutes || 30),
    prepMinutes: 0,
    servings: 4,
    reason: reasonFor(payload),
    tags: tagsFrom({}, payload),
    ingredients: []
  };
}

async function parseRecipePage(url, payload) {
  let html = pageCache.get(url);
  if (!html) {
    html = await fetchUrl(url);
    pageCache.set(url, html);
  }
  const data = extractJsonLdRecipe(html);
  const recipe = data ? recipeFromJsonLd(data, url, payload) : recipeFromHtml(html, url, payload);
  return recipe && recipe.name && recipe.url ? recipe : null;
}

function extractJsonLdRecipe(html) {
  const matches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis);
  for (const match of matches) {
    try {
      const recipe = findRecipeJson(JSON.parse(decodeHtml(match[1].trim())));
      if (recipe) return recipe;
    } catch {
      // Continue.
    }
  }
  return null;
}

function findRecipeJson(data) {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipeJson(item);
      if (found) return found;
    }
  }
  if (data && typeof data === "object") {
    const type = data["@type"];
    if (type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))) return data;
    if (data["@graph"]) return findRecipeJson(data["@graph"]);
  }
  return null;
}

function recipeFromJsonLd(data, url, payload) {
  let ingredients = data.recipeIngredient || [];
  if (typeof ingredients === "string") ingredients = [ingredients];
  return {
    name: textValue(data.name),
    source: new URL(url).hostname.replace(/^www\./, ""),
    url,
    minutes: durationToMinutes(data.totalTime) || durationToMinutes(data.cookTime),
    prepMinutes: durationToMinutes(data.prepTime) || 0,
    servings: servingsValue(data.recipeYield),
    reason: reasonFor(payload),
    tags: tagsFrom(data, payload),
    ingredients: ingredients.slice(0, 18).map((item) => ({
      name: simplifyIngredient(item),
      category: guessCategory(item)
    }))
  };
}

function recipeFromHtml(html, url, payload) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = cleanupTitle(decodeHtml(ogTitle?.[1] || titleMatch?.[1] || ""));
  if (looksLikeRoundup(title, url)) return null;
  if (!/recipe|food|cook|kitchen|meal|dinner/i.test(html)) return null;
  return {
    name: title,
    source: new URL(url).hostname.replace(/^www\./, ""),
    url,
    minutes: Number(payload.preferences?.maxMinutes || 40),
    prepMinutes: 0,
    servings: 4,
    reason: reasonFor(payload),
    tags: tagsFrom({}, payload),
    ingredients: []
  };
}

async function fetchUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OnTheTable/1.0; +local)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return text.slice(0, 900000);
  } finally {
    clearTimeout(timeout);
  }
}

function cleanResultUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
      return parsed.searchParams.get("uddg") || "";
    }
    return ["http:", "https:"].includes(parsed.protocol) ? url : "";
  } catch {
    return "";
  }
}

function looksLikeRecipeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("duckduckgo.com")) return false;
    if (/\/category\/|\/tag\/|\/search|\/roundups?|\/feed\/?$|\/comments\/|\/wp-json\/|xmlrpc\.php|wp-content|\/uploads\//i.test(parsed.pathname)) return false;
    if (/\.(png|jpe?g|gif|webp|svg|xml|json|css|js)$/i.test(parsed.pathname)) return false;
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function looksLikeRoundup(title, url) {
  const titleValue = String(title || "").trim().toLowerCase();
  const value = `${titleValue} ${url}`.toLowerCase();
  if (/(^|\s)\d+\s+.*\b(meals|recipes|ideas)\b/.test(titleValue)) return true;
  if (/\b(recipes|meals|ideas)\b$/.test(titleValue)) return true;
  return /\b(ideas|roundup|round-up|collection|best|easy .*recipes|dinner recipes|recipe ideas)\b/.test(value);
}

function looksLikeRecipe(recipe) {
  if (looksLikeRoundup(recipe.name, recipe.url)) return false;
  return Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0;
}

function matchesPreferences(recipe, payload) {
  const prefs = payload.preferences || {};
  const text = [
    recipe.name || "",
    ...(recipe.tags || []),
    ...(recipe.ingredients || []).map((item) => item.name || "")
  ].join(" ").toLowerCase();
  const avoid = String(prefs.avoid || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (avoid.some((word) => text.includes(word))) return false;
  const diet = String(prefs.diet || "").toLowerCase();
  if (diet.includes("vegetarian") && /\b(chicken|beef|turkey|pork|bacon|salmon|shrimp|fish|steak|sausage|ham|anchovy|tuna|rib|ribs)\b/.test(text)) return false;
  const maxMinutes = Number(prefs.maxMinutes || 0);
  if (maxMinutes && recipe.minutes && Number(recipe.minutes) > maxMinutes) return false;
  return true;
}

function textValue(value) {
  if (Array.isArray(value)) return value.length ? textValue(value[0]) : "";
  if (value && typeof value === "object") return textValue(value.name || value["@value"] || "");
  return String(value || "").trim();
}

function durationToMinutes(value) {
  if (!value) return 0;
  const text = String(value);
  const iso = text.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (iso) return Number(iso[1] || 0) * 60 + Number(iso[2] || 0);
  const digits = text.match(/\d+/);
  return digits ? Number(digits[0]) : 0;
}

function servingsValue(value) {
  const digits = textValue(value).match(/\d+/);
  const servings = digits ? Number(digits[0]) : 4;
  return servings > 20 ? 4 : servings;
}

function simplifyIngredient(value) {
  return textValue(value).replace(/\s+/g, " ").trim().slice(0, 120);
}

function cleanupTitle(title) {
  return decodeHtml(String(title || "").replace(/\s+/g, " ").trim()).split(/\s+[-|]\s+/)[0].trim();
}

function tagsFrom(data, payload) {
  const tags = [];
  for (const key of ["recipeCuisine", "recipeCategory"]) {
    const value = textValue(data[key]);
    if (value) tags.push(value);
  }
  const prefs = payload.preferences || {};
  for (const value of [prefs.diet, prefs.likes]) {
    String(value || "").split(",").map((part) => part.trim()).filter(Boolean).forEach((part) => tags.push(part));
  }
  return [...new Set(tags)].slice(0, 6);
}

function reasonFor(payload) {
  return `Matched to: ${payload.idea || "your meal request"}`;
}

function guessCategory(name) {
  const value = String(name || "").toLowerCase();
  if (/\b(milk|cheese|yogurt|cream|butter|feta|parmesan)\b/.test(value)) return "Dairy";
  if (/\b(chicken|beef|turkey|salmon|tofu|egg|eggs|pork|shrimp|fish|beans|lentils)\b/.test(value)) return "Protein";
  if (/\b(spinach|lemon|onion|onions|garlic|tomato|cucumber|carrot|carrots|kale|broccoli|pepper|lettuce|lime|cabbage|cauliflower|herb|butternut|squash|zucchini|sweet potato)\b/.test(value)) return "Produce";
  if (/\bfrozen\b/.test(value)) return "Frozen";
  return "Pantry";
}

function extractOutputText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n\n") || "No recommendation text was returned.";
}

function stripCodeFence(text) {
  return String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, "-");
}
