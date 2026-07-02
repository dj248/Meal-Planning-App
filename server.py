import json
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from html import unescape
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.5")
RECIPE_SEARCH_ENDPOINTS = [
    "https://www.budgetbytes.com/wp-json/wp/v2/search?search={query}&per_page=8",
    "https://www.loveandlemons.com/wp-json/wp/v2/search?search={query}&per_page=8",
    "https://pinchofyum.com/wp-json/wp/v2/search?search={query}&per_page=8",
    "https://www.twopeasandtheirpod.com/wp-json/wp/v2/search?search={query}&per_page=8",
    "https://www.ambitiouskitchen.com/wp-json/wp/v2/search?search={query}&per_page=8",
]


class MealPlannerHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/api/recommend":
            self.send_error(404)
            return

        key = os.environ.get("OPENAI_API_KEY")
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or "{}")
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

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


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
    queries = build_queries(payload)
    urls = []
    for query in queries:
        urls.extend(search_recipe_sites(query))
    if not urls and queries:
        urls = search_duckduckgo(queries[0])
    recipes = []
    seen = set()
    for url in urls:
        clean_url = clean_result_url(url)
        if not clean_url or clean_url in seen:
            continue
        seen.add(clean_url)
        if not looks_like_recipe_url(clean_url):
            continue
        try:
            recipe = parse_recipe_page(clean_url, payload)
        except Exception:
            continue
        if recipe and looks_like_recipe(recipe) and matches_preferences(recipe, payload):
            recipes.append(recipe)
        if len(recipes) >= 5:
            break
    return recipes


def build_queries(payload):
    prefs = payload.get("preferences", {})
    liked = [
        recipe.get("name", "")
        for recipe in payload.get("recipes", [])
        if int(recipe.get("rating") or 0) >= 4
    ][:3]
    base_parts = [
        payload.get("idea", ""),
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
        " ".join(part for part in base_parts if part),
        payload.get("idea", ""),
        f"quick {diet}",
        f"quick {diet} dinner",
        f"{likes} {diet}",
        f"{diet} {likes} dinner",
        f"{diet} dinner",
        f"{likes} dinner",
        f"{max_minutes} minute {diet} dinner",
        "quick dinner",
    ]
    cleaned = []
    for query in candidates:
        query = re.sub(r"\s+", " ", query).strip()
        if query and query not in cleaned:
            cleaned.append(query)
    return cleaned


def search_duckduckgo(query):
    url = f"https://duckduckgo.com/html/?q={quote_plus(query)}"
    html = fetch_url(url)
    links = re.findall(r'class="result__a"[^>]+href="([^"]+)"', html)
    if not links:
        links = re.findall(r'href="(https?://[^"]+)"', html)
    return [unescape(link) for link in links]


def search_recipe_sites(query):
    urls = []
    short_query = simplify_search_query(query)
    for endpoint in RECIPE_SEARCH_ENDPOINTS:
        try:
            html = fetch_url(endpoint.format(query=quote_plus(short_query)))
            results = json.loads(html)
        except Exception:
            continue
        for item in results:
            url = item.get("url")
            title = unescape(text_value(item.get("title")))
            if not url:
                continue
            if looks_like_roundup(title, url):
                urls.extend(extract_recipe_links_from_roundup(url))
            else:
                urls.append(url)
    return urls


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
    if re.search(r"/category/|/tag/|/search|/roundups?|/feed/?$|/comments/|/wp-json/", parsed.path, re.I):
        return False
    return parsed.scheme in {"http", "https"}


def looks_like_roundup(title, url):
    value = f"{title} {url}".lower()
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
    if "vegetarian" in diet and re.search(r"\b(chicken|beef|turkey|pork|bacon|salmon|shrimp|fish|steak|sausage|ham|anchovy|tuna)\b", text):
        return False
    max_minutes = int(prefs.get("maxMinutes") or 0)
    if max_minutes and recipe.get("minutes") and int(recipe["minutes"]) > max_minutes:
        return False
    return True


def parse_recipe_page(url, payload):
    html = fetch_url(url)
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
    with urlopen(request, timeout=12) as response:
        raw = response.read(1_500_000)
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
    print(f"Weeknight Table running at http://127.0.0.1:{port}/")
    server.serve_forever()
