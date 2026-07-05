import json
import os
import re
import tempfile
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from html import unescape
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.5")
ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
STATE_FILE = DATA_DIR / "app-state.json"
RECIPE_SEARCH_ENDPOINTS = [
    "https://www.budgetbytes.com/wp-json/wp/v2/search?search={query}&per_page=8",
    "https://www.loveandlemons.com/wp-json/wp/v2/search?search={query}&per_page=8",
    "https://pinchofyum.com/wp-json/wp/v2/search?search={query}&per_page=8",
    "https://www.twopeasandtheirpod.com/wp-json/wp/v2/search?search={query}&per_page=8",
    "https://www.ambitiouskitchen.com/wp-json/wp/v2/search?search={query}&per_page=8",
]
MAX_RECIPES = 5
MAX_URLS_TO_PARSE = 10
MAX_ENDPOINTS_PER_QUERY = 3
MAX_RESULTS_PER_ENDPOINT = 4
RECOMMENDATION_BUDGET_SECONDS = 6
MAX_FULL_PARSE_ATTEMPTS = 4
PAGE_CACHE = {}


class MealPlannerHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/state":
            state = read_state()
            self.send_json({"exists": state is not None, "state": state or {}})
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/state":
            try:
                payload = self.read_json_body()
                write_state(payload)
                self.send_json({"ok": True})
            except Exception as error:
                self.send_json({"error": str(error)}, status=500)
            return

        if self.path != "/api/recommend":
            self.send_error(404)
            return

        key = os.environ.get("OPENAI_API_KEY")
        try:
            payload = self.read_json_body()
            recipes = search_and_parse_recipes(payload)
            if recipes:
                self.send_json({"recipes": recipes})
                return
            if key:
                result = ask_openai(key, payload)
                self.send_json(result)
                return
            self.send_json({"recipes": []})
        except HTTPError as error:
            message = error.read().decode("utf-8", errors="replace")
            self.send_json({"error": f"OpenAI request failed: {message}"}, status=502)
        except (URLError, TimeoutError) as error:
            self.send_json({"error": f"Could not reach OpenAI: {error}"}, status=502)
        except Exception as error:
            self.send_json({"error": str(error)}, status=500)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or "{}")

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def ensure_runtime_dirs():
    DATA_DIR.mkdir(exist_ok=True)


def read_state():
    if not STATE_FILE.exists():
        return None
    with STATE_FILE.open("r", encoding="utf-8") as state_file:
        return json.load(state_file)


def write_state(state):
    ensure_runtime_dirs()
    fd, temp_path = tempfile.mkstemp(prefix="app-state-", suffix=".json", dir=DATA_DIR)
    with os.fdopen(fd, "w", encoding="utf-8") as temp_file:
        json.dump(state, temp_file, indent=2)
        temp_file.write("\n")
    os.replace(temp_path, STATE_FILE)


def ask_openai(key, payload):
    instructions = (
        "You are a practical meal-planning assistant. Recommend real recipes from the web, "
        "not invented recipes. Use the user's saved preferences, ratings, notes, and idea. "
        "Return strict JSON with a recipes array. Each recipe must have name, source, url, "
        "minutes, prepMinutes, servings, reason, tags, and ingredients where ingredients are "
        "objects with name and category. Favor recipes similar to highly ranked meals and "
        "avoid disliked ingredients."
    )
    input_text = json.dumps(payload, indent=2)
    body = {
        "model": MODEL,
        "reasoning": {"effort": "low"},
        "instructions": instructions,
        "tools": [{"type": "web_search_preview"}],
        "input": input_text,
    }
    request = Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urlopen(request, timeout=60) as response:
        data = json.loads(response.read().decode("utf-8"))
    text = extract_output_text(data)
    try:
        parsed = json.loads(strip_code_fence(text))
        if isinstance(parsed.get("recipes"), list):
            return {"recipes": parsed["recipes"]}
    except json.JSONDecodeError:
        pass
    return {"text": text}


def search_and_parse_recipes(payload):
    started = time.monotonic()
    queries = build_queries(payload)
    candidates = []
    for query in queries:
        candidates.extend(search_recipe_sites(query))
        if len(candidates) >= MAX_URLS_TO_PARSE:
            break
    if not candidates and queries:
        candidates = [{"url": url, "title": ""} for url in search_duckduckgo(queries[0])]
    recipes = []
    fallback_recipes = []
    seen = set()
    parse_attempts = 0
    for candidate in candidates:
        if time.monotonic() - started > RECOMMENDATION_BUDGET_SECONDS and (recipes or fallback_recipes):
            break
        clean_url = clean_result_url(candidate["url"])
        if not clean_url or clean_url in seen:
            continue
        seen.add(clean_url)
        if not looks_like_recipe_url(clean_url):
            continue
        fallback = fallback_recipe_from_candidate(candidate, clean_url, payload)
        if fallback and matches_preferences(fallback, payload):
            fallback_recipes.append(fallback)
        if parse_attempts >= MAX_FULL_PARSE_ATTEMPTS:
            continue
        try:
            parse_attempts += 1
            recipe = parse_recipe_page(clean_url, payload)
        except Exception:
            continue
        if recipe and looks_like_recipe(recipe) and matches_preferences(recipe, payload):
            recipes.append(recipe)
        if len(recipes) >= MAX_RECIPES:
            break
    if len(recipes) < MAX_RECIPES:
        for recipe in fallback_recipes:
            if recipe["url"] not in {item["url"] for item in recipes}:
                recipes.append(recipe)
            if len(recipes) >= MAX_RECIPES:
                break
    return recipes


def build_queries(payload):
    prefs = payload.get("preferences", {})
    idea = payload.get("idea", "")
    liked = [
        recipe.get("name", "")
        for recipe in payload.get("recipes", [])
        if int(recipe.get("rating") or 0) >= 4
    ][:3]
    idea_parts = split_idea(idea)
    base_parts = [
        idea,
        prefs.get("diet", ""),
        prefs.get("likes", ""),
        f"{prefs.get('maxMinutes', 40)} minute recipe",
        "recipe",
    ]
    if liked:
        base_parts.append("similar to " + " ".join(liked))
    if prefs.get("avoid"):
        base_parts.extend(f"-{item.strip()}" for item in prefs["avoid"].split(",") if item.strip())

    diet = prefs.get("diet", "")
    likes = prefs.get("likes", "")
    max_minutes = prefs.get("maxMinutes", 40)
    candidates = [
        *[f"{part} {diet} {likes} {max_minutes} minute recipe" for part in idea_parts],
        *[f"{part} {diet} dinner" for part in idea_parts],
        *[f"quick {part}" for part in idea_parts],
        " ".join(part for part in base_parts if part),
        idea,
        f"quick {diet}",
        f"{likes} {diet}",
        f"{diet} {likes} dinner",
        f"{diet} dinner",
        f"{likes} dinner",
        f"{max_minutes} minute {diet} dinner",
    ]
    cleaned = []
    for query in candidates:
        query = re.sub(r"\s+", " ", query).strip()
        if query and query not in cleaned:
            cleaned.append(query)
    return cleaned


def split_idea(idea):
    text = str(idea or "").lower()
    text = re.sub(r"\b(and|or|also|plus|with)\b", ",", text)
    parts = [part.strip(" .") for part in re.split(r"[,;/\n]+", text) if part.strip(" .")]
    generic = {
        "quick",
        "easy",
        "dinner",
        "dinners",
        "lunch",
        "lunches",
        "recipe",
        "recipes",
        "meal",
        "meals",
    }
    focused = []
    for part in parts:
        words = [word for word in part.split() if word not in generic]
        if words:
            focused.append(" ".join(words[:5]))
    return focused[:4] or [idea]


def search_duckduckgo(query):
    url = f"https://duckduckgo.com/html/?q={quote_plus(query)}"
    html = fetch_url(url)
    links = re.findall(r'class="result__a"[^>]+href="([^"]+)"', html)
    if not links:
        links = re.findall(r'href="(https?://[^"]+)"', html)
    return [unescape(link) for link in links]


def search_recipe_sites(query):
    candidates = []
    short_query = simplify_search_query(query)
    for endpoint in RECIPE_SEARCH_ENDPOINTS[:MAX_ENDPOINTS_PER_QUERY]:
        try:
            html = fetch_url(endpoint.format(query=quote_plus(short_query)))
            results = json.loads(html)
        except Exception:
            continue
        for item in results[:MAX_RESULTS_PER_ENDPOINT]:
            url = item.get("url")
            title = unescape(text_value(item.get("title")))
            if not url:
                continue
            if looks_like_roundup(title, url):
                continue
            else:
                candidates.append({"url": url, "title": cleanup_title(title)})
    return candidates


def fallback_recipe_from_candidate(candidate, url, payload):
    title = cleanup_title(candidate.get("title") or urlparse(url).path.strip("/").split("/")[-1].replace("-", " "))
    if not title or looks_like_roundup(title, url):
        return None
    return {
        "name": title,
        "source": urlparse(url).netloc.replace("www.", ""),
        "url": url,
        "minutes": int(payload.get("preferences", {}).get("maxMinutes") or 30),
        "prepMinutes": 0,
        "servings": 4,
        "reason": reason_for(payload),
        "tags": tags_from({}, payload),
        "ingredients": [],
    }


def extract_recipe_links_from_roundup(url):
    try:
        html = fetch_url(url)
    except Exception:
        return []
    host = urlparse(url).netloc
    links = re.findall(r'href=["\']([^"\']+)["\']', html, flags=re.I)
    found = []
    for link in links:
        absolute = urljoin(url, unescape(link))
        parsed = urlparse(absolute)
        if parsed.netloc != host:
            continue
        if looks_like_recipe_url(absolute) and not looks_like_roundup("", absolute):
            found.append(absolute.split("#")[0])
    return list(dict.fromkeys(found))[:10]


def simplify_search_query(query):
    words = [
        word
        for word in re.sub(r"[^a-zA-Z0-9\s-]", " ", query).split()
        if not word.startswith("-")
    ]
    keep = []
    stop = {"recipe", "minutes", "minute", "less", "similar", "to"}
    for word in words:
        if word.lower() not in stop:
            keep.append(word)
    return " ".join(keep[:8]) or "quick dinner"


def clean_result_url(url):
    parsed = urlparse(url)
    if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        return unquote(target)
    if parsed.scheme in {"http", "https"}:
        return url
    return ""


def looks_like_recipe_url(url):
    parsed = urlparse(url)
    if "duckduckgo.com" in parsed.netloc:
        return False
    if re.search(r"/category/|/tag/|/search|/roundups?|/feed/?$|/comments/|/wp-json/|xmlrpc\.php|wp-content|/uploads/", parsed.path, re.I):
        return False
    if re.search(r"\.(png|jpe?g|gif|webp|svg|xml|json|css|js)$", parsed.path, re.I):
        return False
    return parsed.scheme in {"http", "https"}


def looks_like_roundup(title, url):
    value = f"{title} {url}".lower()
    title_value = str(title or "").strip().lower()
    if re.search(r"(^|\s)\d+\s+.*\b(meals|recipes|ideas)\b", title_value):
        return True
    if re.search(r"\b(recipes|meals|ideas)\b$", title_value):
        return True
    return bool(re.search(r"\b(ideas|roundup|round-up|collection|best|easy .*recipes|dinner recipes|recipe ideas)\b", value))


def looks_like_recipe(recipe):
    title = recipe.get("name", "")
    if looks_like_roundup(title, recipe.get("url", "")):
        return False
    if recipe.get("ingredients"):
        return True
    return False


def matches_preferences(recipe, payload):
    prefs = payload.get("preferences", {})
    text = " ".join(
        [
            recipe.get("name", ""),
            " ".join(recipe.get("tags", [])),
            " ".join(item.get("name", "") for item in recipe.get("ingredients", [])),
        ]
    ).lower()
    avoid = [item.strip().lower() for item in str(prefs.get("avoid", "")).split(",") if item.strip()]
    if any(word in text for word in avoid):
        return False
    diet = str(prefs.get("diet", "")).lower()
    if "vegetarian" in diet and re.search(r"\b(chicken|beef|turkey|pork|bacon|salmon|shrimp|fish|steak|sausage|ham|anchovy|tuna|rib|ribs)\b", text):
        return False
    max_minutes = int(prefs.get("maxMinutes") or 0)
    if max_minutes and recipe.get("minutes") and int(recipe["minutes"]) > max_minutes:
        return False
    return True


def parse_recipe_page(url, payload):
    if url in PAGE_CACHE:
        html = PAGE_CACHE[url]
    else:
        html = fetch_url(url)
        PAGE_CACHE[url] = html
    data = extract_json_ld_recipe(html)
    if data:
        recipe = recipe_from_json_ld(data, url, payload)
    else:
        recipe = recipe_from_html(html, url, payload)
    return recipe if recipe and recipe.get("name") and recipe.get("url") else None


def extract_json_ld_recipe(html):
    blocks = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for block in blocks:
        try:
            data = json.loads(unescape(block).strip())
        except json.JSONDecodeError:
            continue
        recipe = find_recipe_json(data)
        if recipe:
            return recipe
    return None


def find_recipe_json(data):
    if isinstance(data, list):
        for item in data:
            found = find_recipe_json(item)
            if found:
                return found
    if isinstance(data, dict):
        item_type = data.get("@type")
        if isinstance(item_type, list) and "Recipe" in item_type:
            return data
        if item_type == "Recipe":
            return data
        graph = data.get("@graph")
        if graph:
            return find_recipe_json(graph)
    return None


def recipe_from_json_ld(data, url, payload):
    ingredients = data.get("recipeIngredient") or []
    if isinstance(ingredients, str):
        ingredients = [ingredients]
    return {
        "name": text_value(data.get("name")),
        "source": urlparse(url).netloc.replace("www.", ""),
        "url": url,
        "minutes": duration_to_minutes(data.get("totalTime")) or duration_to_minutes(data.get("cookTime")),
        "prepMinutes": duration_to_minutes(data.get("prepTime")) or 0,
        "servings": servings_value(data.get("recipeYield")),
        "reason": reason_for(payload),
        "tags": tags_from(data, payload),
        "ingredients": [
            {"name": simplify_ingredient(item), "category": guess_category(item)}
            for item in ingredients[:18]
        ],
    }


def recipe_from_html(html, url, payload):
    title = ""
    og_title = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
    if og_title:
        title = unescape(og_title.group(1))
    if not title:
        title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
        title = unescape(re.sub(r"\s+", " ", title_match.group(1)).strip()) if title_match else ""
    if looks_like_roundup(title, url):
        return None
    if not re.search(r"recipe|food|cook|kitchen|meal|dinner", html, re.I):
        return None
    return {
        "name": cleanup_title(title),
        "source": urlparse(url).netloc.replace("www.", ""),
        "url": url,
        "minutes": int(payload.get("preferences", {}).get("maxMinutes") or 40),
        "prepMinutes": 0,
        "servings": 4,
        "reason": reason_for(payload),
        "tags": tags_from({}, payload),
        "ingredients": [],
    }


def fetch_url(url):
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; WeeknightTable/1.0; +local)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urlopen(request, timeout=4) as response:
        raw = response.read(900_000)
    return raw.decode("utf-8", errors="replace")


def extract_output_text(data):
    if data.get("output_text"):
        return data["output_text"]

    chunks = []
    for item in data.get("output", []):
        for content in item.get("content", []):
            text = content.get("text")
            if text:
                chunks.append(text)
    return "\n\n".join(chunks) or "No recommendation text was returned."


def strip_code_fence(text):
    return re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.I).strip()


def text_value(value):
    if isinstance(value, list):
        return text_value(value[0]) if value else ""
    if isinstance(value, dict):
        return text_value(value.get("name") or value.get("@value") or "")
    return str(value or "").strip()


def duration_to_minutes(value):
    if not value:
        return 0
    text = str(value)
    iso = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?", text)
    if iso:
        hours = int(iso.group(1) or 0)
        minutes = int(iso.group(2) or 0)
        return hours * 60 + minutes
    digits = re.search(r"\d+", text)
    return int(digits.group(0)) if digits else 0


def servings_value(value):
    text = text_value(value)
    digits = re.search(r"\d+", text)
    servings = int(digits.group(0)) if digits else 4
    return 4 if servings > 20 else servings


def simplify_ingredient(value):
    text = re.sub(r"\s+", " ", text_value(value)).strip()
    return text[:120]


def cleanup_title(title):
    return re.split(r"\s+[-|]\s+", title)[0].strip()


def tags_from(data, payload):
    tags = []
    for key in ("recipeCuisine", "recipeCategory"):
        value = text_value(data.get(key))
        if value:
            tags.append(value)
    prefs = payload.get("preferences", {})
    for value in (prefs.get("diet"), prefs.get("likes")):
        tags.extend(part.strip() for part in str(value or "").split(",") if part.strip())
    return list(dict.fromkeys(tags))[:6]


def reason_for(payload):
    idea = payload.get("idea") or "your meal request"
    return f"Matched to: {idea}"


def guess_category(name):
    value = str(name or "").lower()
    if re.search(r"\b(milk|cheese|yogurt|cream|butter|feta|parmesan)\b", value):
        return "Dairy"
    if re.search(r"\b(chicken|beef|turkey|salmon|tofu|egg|eggs|pork|shrimp|fish|beans|lentils)\b", value):
        return "Protein"
    if re.search(r"\b(spinach|lemon|onion|onions|garlic|tomato|cucumber|carrot|carrots|kale|broccoli|pepper|lettuce|lime|cabbage|cauliflower|herb|butternut|squash|zucchini|sweet potato)\b", value):
        return "Produce"
    if re.search(r"frozen", value):
        return "Frozen"
    return "Pantry"


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("127.0.0.1", port), MealPlannerHandler)
    print(f"On the Table running at http://127.0.0.1:{port}/")
    server.serve_forever()
