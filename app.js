const STORAGE_KEY = "weeknight-table-v2";
const LEGACY_KEY = "weeknight-table-v1";
const dayMs = 24 * 60 * 60 * 1000;

let state = loadState();

const elements = {
  storageBadge: document.querySelector("#storageBadge"),
  calendarGrid: document.querySelector("#calendarGrid"),
  historyList: document.querySelector("#historyList"),
  rankedLibrary: document.querySelector("#rankedLibrary"),
  recipeDetail: document.querySelector("#recipeDetail"),
  groceryList: document.querySelector("#groceryList"),
  searchLinks: document.querySelector("#searchLinks"),
  ideaInput: document.querySelector("#ideaInput"),
  ideaOutput: document.querySelector("#ideaOutput"),
  preferencesBody: document.querySelector("#preferencesBody"),
  togglePreferencesButton: document.querySelector("#togglePreferencesButton"),
  dietInput: document.querySelector("#dietInput"),
  preferenceInput: document.querySelector("#preferenceInput"),
  avoidInput: document.querySelector("#avoidInput")
};

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".tab-page").forEach((page) => page.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#${tab.dataset.tab}Page`).classList.add("active");
  });
});

document.querySelector("#previousWeekButton").addEventListener("click", () => shiftWeek(-7));
document.querySelector("#todayButton").addEventListener("click", () => {
  state.currentWeekStart = getWeekStart(new Date()).toISOString();
  saveState();
  render();
});
document.querySelector("#nextWeekButton").addEventListener("click", () => shiftWeek(7));
document.querySelector("#savePreferencesButton").addEventListener("click", savePreferences);
document.querySelector("#buildSearchButton").addEventListener("click", () => {
  savePreferences();
  renderSearchLinks();
});
document.querySelector("#importRecipeForm").addEventListener("submit", importRecipe);
document.querySelector("#addGroceryForm").addEventListener("submit", addCustomGrocery);
document.querySelector("#ideaForm").addEventListener("submit", requestMealIdeas);
elements.ideaInput.addEventListener("keydown", handleIdeaKeydown);
elements.togglePreferencesButton.addEventListener("click", togglePreferences);
document.querySelector("#resetButton").addEventListener("click", resetData);
document.querySelectorAll("[data-grocery-view]").forEach((button) => {
  button.addEventListener("click", () => {
    state.groceryView = button.dataset.groceryView;
    saveState();
    renderGroceries();
    document.querySelectorAll("[data-grocery-view]").forEach((item) => item.classList.toggle("active", item === button));
  });
});

hydratePreferences();
render();
syncServerState();

function defaultState() {
  return {
    preferences: {
      diet: "",
      likes: "",
      avoid: "",
      maxMinutes: 40
    },
    recipes: [],
    mealPlan: {},
    selectedRecipeId: "",
    currentWeekStart: getWeekStart(new Date()).toISOString(),
    groceryView: "recipe",
    customGroceries: [],
    checkedGroceries: {}
  };
}

function loadState() {
  const fresh = defaultState();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) return mergeState(fresh, saved);
  } catch {
    return fresh;
  }

  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (!legacy) return fresh;
    return mergeState(fresh, {
      preferences: legacy.preferences,
      recipes: (legacy.savedRecipes || []).map(normalizeRecipe),
      customGroceries: legacy.customGroceries || [],
      checkedGroceries: legacy.checkedGroceries || {}
    });
  } catch {
    return fresh;
  }
}

async function syncServerState() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) return;
    const payload = await response.json();
    if (payload.exists) {
      state = mergeState(defaultState(), payload.state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      hydratePreferences();
      render();
      elements.storageBadge.textContent = "Loaded from server";
    } else {
      persistStateToServer();
    }
  } catch {
    elements.storageBadge.textContent = "Saved in browser";
  }
}

function mergeState(base, saved) {
  return {
    ...base,
    ...saved,
    preferences: { ...base.preferences, ...(saved.preferences || {}) },
    recipes: (saved.recipes || []).map(normalizeRecipe),
    mealPlan: normalizeMealPlan(saved.mealPlan || {}),
    customGroceries: saved.customGroceries || [],
    checkedGroceries: saved.checkedGroceries || {}
  };
}

function normalizeRecipe(recipe) {
  const ingredients = (recipe.ingredients || []).map((item) => {
    if (typeof item === "string") return { name: item, category: guessCategory(item) };
    return { name: item.name, category: item.category || guessCategory(item.name) };
  });

  return {
    id: recipe.id || `recipe-${Date.now()}`,
    name: recipe.name || "Untitled recipe",
    url: recipe.url || "",
    minutes: Number(recipe.minutes) || 0,
    prepMinutes: Number(recipe.prepMinutes) || 0,
    servings: Number(recipe.servings) || 1,
    tags: recipe.tags || [],
    ingredients,
    rating: Number(recipe.rating) || 0,
    ease: Number(recipe.ease) || 0,
    actualMinutes: Number(recipe.actualMinutes) || 0,
    notes: recipe.notes || "",
    source: "web"
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  persistStateToServer();
  elements.storageBadge.textContent = `Saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

async function persistStateToServer() {
  try {
    await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
  } catch {
    // Browser storage remains the fallback if the local server is unavailable.
  }
}

function hydratePreferences() {
  elements.dietInput.value = state.preferences.diet;
  elements.preferenceInput.value = state.preferences.likes;
  elements.avoidInput.value = state.preferences.avoid;
}

function savePreferences() {
  state.preferences = {
    diet: elements.dietInput.value.trim(),
    likes: elements.preferenceInput.value.trim(),
    avoid: elements.avoidInput.value.trim(),
    maxMinutes: state.preferences.maxMinutes || 40
  };
  saveState();
  renderSearchLinks();
}

function render() {
  renderCalendar();
  renderHistory();
  renderLibrary();
  renderRecipeDetail();
  renderGroceries();
  renderSearchLinks();
}

function getWeekStart(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const offset = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - offset);
  return copy;
}

function shiftWeek(days) {
  const date = new Date(state.currentWeekStart);
  date.setDate(date.getDate() + days);
  state.currentWeekStart = date.toISOString();
  saveState();
  render();
}

function renderCalendar() {
  const start = new Date(state.currentWeekStart);
  elements.calendarGrid.innerHTML = "";
  for (let index = 0; index < 7; index += 1) {
    const date = new Date(start.getTime() + index * dayMs);
    const dateKey = toDateKey(date);
    const dayPlan = getDayPlan(dateKey);
    const lunchRecipe = getRecipe(dayPlan.lunch);
    const dinnerRecipe = getRecipe(dayPlan.dinner);
    const card = document.createElement("article");
    card.className = "day-card";
    card.innerHTML = `
      <div class="day-heading">
        <p class="eyebrow">${date.toLocaleDateString([], { weekday: "short" })}</p>
        <h3>${date.toLocaleDateString([], { month: "short", day: "numeric" })}</h3>
      </div>
      ${mealSlotMarkup(dateKey, "lunch", lunchRecipe)}
      ${mealSlotMarkup(dateKey, "dinner", dinnerRecipe)}
    `;
    card.querySelectorAll("select").forEach((select) => select.addEventListener("change", updatePlan));
    elements.calendarGrid.appendChild(card);
  }
}

function mealSlotMarkup(dateKey, meal, recipe) {
  const label = meal[0].toUpperCase() + meal.slice(1);
  return `
    <div class="meal-slot">
      <label>
        <span>${label}</span>
        <select data-plan-date="${dateKey}" data-plan-meal="${meal}" aria-label="${label} recipe for ${dateKey}">
          <option value="">No ${meal} planned</option>
          ${state.recipes.map((item) => `<option value="${item.id}" ${item.id === recipe?.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
        </select>
      </label>
      <div class="planned-recipe">
        ${recipe ? plannedRecipeMarkup(recipe) : `<p class='empty-state'>Choose a ${meal} recipe.</p>`}
      </div>
    </div>
  `;
}

function plannedRecipeMarkup(recipe) {
  return `
    <h4>${escapeHtml(recipe.name)}</h4>
    <p>${recipe.minutes || "?"} min total - ${recipe.prepMinutes || 0} min prep - ${recipe.servings} servings</p>
    ${recipe.url ? `<a href="${escapeAttribute(recipe.url)}" target="_blank" rel="noreferrer">Open recipe website</a>` : "<span class='empty-state'>No website saved.</span>"}
  `;
}

function updatePlan(event) {
  const date = event.target.dataset.planDate;
  const meal = event.target.dataset.planMeal || "dinner";
  state.mealPlan[date] = getDayPlan(date);
  if (event.target.value) {
    state.mealPlan[date][meal] = event.target.value;
  } else {
    delete state.mealPlan[date][meal];
  }
  if (!state.mealPlan[date].lunch && !state.mealPlan[date].dinner) {
    delete state.mealPlan[date];
  }
  saveState();
  render();
}

function renderHistory() {
  const rows = Object.entries(state.mealPlan)
    .filter(([date]) => date < toDateKey(new Date()))
    .flatMap(([date, plan]) => Object.entries(getDayPlan(date, plan)).map(([meal, recipeId]) => ({ date, meal, recipeId })))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 14);

  elements.historyList.innerHTML = rows.length ? "" : "<p class='empty-state'>Past planned recipes will appear here after their dates pass.</p>";
  rows.forEach(({ date, meal, recipeId }) => {
    const recipe = getRecipe(recipeId);
    if (!recipe) return;
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `
      <strong>${formatDate(date)}</strong>
      <span>${meal}: ${escapeHtml(recipe.name)}</span>
      ${recipe.url ? `<a href="${escapeAttribute(recipe.url)}" target="_blank" rel="noreferrer">Website</a>` : "<span>No website</span>"}
    `;
    elements.historyList.appendChild(row);
  });
}

function renderLibrary() {
  const groups = [5, 4, 3, 2, 1, 0];
  elements.rankedLibrary.innerHTML = "";

  if (!state.recipes.length) {
    elements.rankedLibrary.innerHTML = "<p class='empty-state'>No stored recipes yet. Search the web above, then save the recipe link and details here.</p>";
    return;
  }

  groups.forEach((rating) => {
    const recipes = state.recipes
      .filter((recipe) => Number(recipe.rating || 0) === rating)
      .sort((a, b) => a.name.localeCompare(b.name));
    const section = document.createElement("section");
    section.className = "rating-group";
    section.innerHTML = `<h3>${rating ? `${rating} star` : "Unranked"}</h3>`;
    const list = document.createElement("div");
    list.className = "recipe-list";
    list.innerHTML = recipes.length ? "" : "<p class='empty-state'>No recipes in this group.</p>";
    recipes.forEach((recipe) => {
      const button = document.createElement("button");
      button.className = "recipe-list-item";
      button.innerHTML = `
        <strong>${escapeHtml(recipe.name)}</strong>
        <span>${recipe.minutes || "?"} min - ${recipe.servings} servings</span>
      `;
      button.addEventListener("click", () => {
        state.selectedRecipeId = recipe.id;
        saveState();
        renderRecipeDetail();
      });
      list.appendChild(button);
    });
    section.appendChild(list);
    elements.rankedLibrary.appendChild(section);
  });
}

function renderRecipeDetail() {
  const recipe = getRecipe(state.selectedRecipeId);
  if (!recipe) {
    elements.recipeDetail.innerHTML = `
      <h2>Recipe Details</h2>
      <p class="empty-state">Select a stored recipe to view rankings, notes, and its web link.</p>
    `;
    return;
  }

  elements.recipeDetail.innerHTML = `
    <div class="panel-heading">
      <h2>${escapeHtml(recipe.name)}</h2>
      ${recipe.url ? `<a class="source-link" href="${escapeAttribute(recipe.url)}" target="_blank" rel="noreferrer">Website</a>` : "<span class='empty-state'>No website</span>"}
    </div>
    <p class="recipe-meta">${recipe.minutes || "?"} min total - ${recipe.prepMinutes || 0} min prep - ${recipe.servings} servings</p>
    <div class="tag-row">${recipe.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
    <label class="field">
      <span>Ranking</span>
      <select id="detailRating">
        <option value="0" ${recipe.rating === 0 ? "selected" : ""}>Unranked</option>
        ${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${recipe.rating === value ? "selected" : ""}>${value} star</option>`).join("")}
      </select>
    </label>
    <div class="field-grid">
      <label class="field">
        <span>Ease</span>
        <input id="detailEase" type="number" min="0" max="5" value="${recipe.ease || 0}" />
      </label>
      <label class="field">
        <span>Actual minutes</span>
        <input id="detailActualMinutes" type="number" min="0" value="${recipe.actualMinutes || recipe.minutes || 0}" />
      </label>
    </div>
    <label class="field">
      <span>Notes</span>
      <textarea id="detailNotes" rows="7" placeholder="What worked, what to change, who liked it">${escapeHtml(recipe.notes)}</textarea>
    </label>
    <button class="primary-button" id="saveRecipeDetailButton">Save ranking</button>
  `;

  document.querySelector("#saveRecipeDetailButton").addEventListener("click", () => {
    recipe.rating = Number(document.querySelector("#detailRating").value);
    recipe.ease = Number(document.querySelector("#detailEase").value);
    recipe.actualMinutes = Number(document.querySelector("#detailActualMinutes").value);
    recipe.notes = document.querySelector("#detailNotes").value.trim();
    saveState();
    renderLibrary();
    renderRecipeDetail();
  });
}

function importRecipe(event) {
  event.preventDefault();
  const recipe = normalizeRecipe({
    id: `web-${Date.now()}`,
    name: document.querySelector("#importName").value.trim(),
    url: document.querySelector("#importUrl").value.trim(),
    minutes: document.querySelector("#importMinutes").value,
    prepMinutes: document.querySelector("#importPrep").value,
    servings: document.querySelector("#importServings").value,
    tags: splitList(document.querySelector("#importTags").value),
    ingredients: parseIngredients(document.querySelector("#importIngredients").value)
  });
  state.recipes.push(recipe);
  state.selectedRecipeId = recipe.id;
  event.target.reset();
  saveState();
  render();
}

function renderSearchLinks() {
  const parts = [
    state.preferences.diet,
    state.preferences.likes,
    state.preferences.avoid ? `-${state.preferences.avoid.split(",").map((item) => item.trim()).join(" -")}` : "",
    "dinner recipe"
  ].filter(Boolean);
  const query = parts.join(" ");
  const searches = [
    query || "weeknight dinner recipe",
    `site:budgetbytes.com ${query}`,
    `site:loveandlemons.com ${query}`,
    `site:seriouseats.com ${query}`,
    `site:nytimes.com/wirecutter/reviews ${query}`
  ];
  elements.searchLinks.innerHTML = searches
    .map((item) => `<a href="https://www.google.com/search?q=${encodeURIComponent(item)}" target="_blank" rel="noreferrer">${escapeHtml(item)}</a>`)
    .join("");
}

function renderGroceries() {
  document.querySelectorAll("[data-grocery-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.groceryView === state.groceryView);
  });

  const planned = Object.entries(state.mealPlan)
    .filter(([date]) => date >= toDateKey(new Date(state.currentWeekStart)) && date < toDateKey(new Date(new Date(state.currentWeekStart).getTime() + 7 * dayMs)))
    .flatMap(([date, plan]) => Object.entries(getDayPlan(date, plan)).map(([meal, recipeId]) => ({ date, meal, recipe: getRecipe(recipeId) })))
    .filter((item) => item.recipe);

  elements.groceryList.innerHTML = "";
  if (!planned.length && !state.customGroceries.length) {
    elements.groceryList.innerHTML = "<p class='empty-state'>Plan recipes or add your own items to build a grocery list.</p>";
    return;
  }

  if (state.groceryView === "category") {
    renderGroceriesByCategory(planned);
  } else {
    renderGroceriesByRecipe(planned);
  }
}

function renderGroceriesByRecipe(planned) {
  planned.forEach(({ date, meal, recipe }) => {
    const group = document.createElement("section");
    group.className = "grocery-group";
    group.innerHTML = `<h3>${formatDate(date)} - ${meal} - ${escapeHtml(recipe.name)}</h3>`;
    recipe.ingredients.forEach((item) => group.appendChild(groceryRow(item.name, item.category)));
    elements.groceryList.appendChild(group);
  });
  renderAdditionalGroceries();
}

function handleIdeaKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    document.querySelector("#ideaForm").requestSubmit();
  }
}

function togglePreferences() {
  const hidden = elements.preferencesBody.classList.toggle("collapsed");
  elements.togglePreferencesButton.textContent = hidden ? "+" : "-";
  elements.togglePreferencesButton.title = hidden ? "Show preferences" : "Hide preferences";
  elements.togglePreferencesButton.setAttribute("aria-label", hidden ? "Show preferences" : "Hide preferences");
}

function renderGroceriesByCategory(planned) {
  const categories = {};
  planned.flatMap((item) => item.recipe.ingredients).forEach((item) => {
    const category = item.category || "Other";
    categories[category] = categories[category] || [];
    categories[category].push({ name: item.name, removable: false });
  });
  state.customGroceries.forEach((item) => {
    const category = item.category || "Other";
    categories[category] = categories[category] || [];
    categories[category].push({ name: item.name, removable: true });
  });

  Object.entries(categories).sort().forEach(([category, items]) => {
    const group = document.createElement("section");
    group.className = "grocery-group";
    group.innerHTML = `<h3>${escapeHtml(category)}</h3>`;
    dedupeGroceryItems(items)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((item) => group.appendChild(groceryRow(item.name, category, item.removable)));
    elements.groceryList.appendChild(group);
  });
}

function dedupeGroceryItems(items) {
  return Object.values(items.reduce((map, item) => {
    const key = item.name.toLowerCase();
    map[key] = map[key] || { name: item.name, removable: false };
    map[key].removable = map[key].removable || item.removable;
    return map;
  }, {}));
}

function renderAdditionalGroceries() {
  if (!state.customGroceries.length) return;
  const group = document.createElement("section");
  group.className = "grocery-group";
  group.innerHTML = "<h3>Additions</h3>";
  state.customGroceries.forEach((item) => group.appendChild(groceryRow(item.name, item.category, true)));
  elements.groceryList.appendChild(group);
}

function groceryRow(name, category, removable = false) {
  const key = groceryKey(name, category);
  const row = document.createElement("div");
  row.className = `grocery-item ${state.checkedGroceries[key] ? "checked" : ""}`;
  row.innerHTML = `
    <input type="checkbox" ${state.checkedGroceries[key] ? "checked" : ""} aria-label="Mark ${escapeHtml(name)} purchased" />
    <span>${escapeHtml(name)}</span>
    <small>${escapeHtml(category || "Other")}</small>
    ${removable ? "<button class='icon-button' title='Remove item' aria-label='Remove item'>x</button>" : ""}
  `;
  row.querySelector("input").addEventListener("change", (event) => {
    if (event.target.checked) state.checkedGroceries[key] = true;
    else delete state.checkedGroceries[key];
    saveState();
    renderGroceries();
  });
  row.querySelector("button")?.addEventListener("click", () => {
    state.customGroceries = state.customGroceries.filter((item) => groceryKey(item.name, item.category) !== key);
    delete state.checkedGroceries[key];
    saveState();
    renderGroceries();
  });
  return row;
}

function addCustomGrocery(event) {
  event.preventDefault();
  const input = document.querySelector("#customGroceryInput");
  const category = document.querySelector("#customGroceryCategory").value;
  const name = input.value.trim();
  if (!name) return;
  state.customGroceries.push({ name, category });
  input.value = "";
  saveState();
  renderGroceries();
}

async function requestMealIdeas(event) {
  event.preventDefault();
  savePreferences();
  const idea = elements.ideaInput.value.trim();
  if (!idea) return;

  elements.ideaOutput.innerHTML = "<p class='empty-state'>Finding and parsing recipe pages...</p>";
  try {
    const response = await fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idea,
        preferences: state.preferences,
        recipes: state.recipes.map((recipe) => ({
          name: recipe.name,
          url: recipe.url,
          rating: recipe.rating,
          notes: recipe.notes,
          minutes: recipe.minutes,
          tags: recipe.tags
        }))
      })
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("This page is running on the static server. Open the backend server URL instead: http://127.0.0.1:8080/");
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Recipe assistant is not configured yet.");
    if (Array.isArray(data.recipes)) {
      elements.ideaOutput.innerHTML = renderRecommendedRecipes(data.recipes);
      bindRecommendationButtons(data.recipes);
    } else {
      elements.ideaOutput.innerHTML = `<div class="assistant-message">${formatAssistantText(data.text)}</div>`;
    }
  } catch (error) {
    elements.ideaOutput.innerHTML = `
      <p class="empty-state">I could not reach the local recipe parser from this page. Open http://127.0.0.1:8080/ and try again.</p>
    `;
  }
}

function renderRecommendedRecipes(recipes) {
  if (!recipes.length) {
    return "<p class='empty-state'>I searched, but did not find recipe pages I could parse. Try a simpler request like 'quick vegetarian dinners under 30 minutes'.</p>";
  }
  return `
    <div class="assistant-message">
      <p><strong>Specific recipes I found and parsed for you:</strong></p>
      <div class="idea-card-grid">
        ${recipes.map((recipe, index) => recommendationCard(recipe, index)).join("")}
      </div>
    </div>
  `;
}

function recommendationCard(recipe, index) {
  return `
    <article class="idea-card">
      <h3>${escapeHtml(recipe.name)}</h3>
      <p>${escapeHtml(recipe.source || "Recipe website")} - ${recipe.minutes || "?"} min - ${recipe.servings || "?"} servings</p>
      <p>${escapeHtml(recipe.reason || "Matched from your request and saved preferences.")}</p>
      <div class="button-row">
        <a href="${escapeAttribute(recipe.url)}" target="_blank" rel="noreferrer">Open recipe</a>
        <button class="secondary-button save-recommendation" data-recommendation-index="${index}" type="button">Save</button>
      </div>
    </article>
  `;
}

function bindRecommendationButtons(recipes) {
  document.querySelectorAll(".save-recommendation").forEach((button) => {
    button.addEventListener("click", () => {
      const recipe = recipes[Number(button.dataset.recommendationIndex)];
      saveRecommendedRecipe(recipe);
      button.textContent = "Saved";
      button.disabled = true;
    });
  });
}

function saveRecommendedRecipe(recipe) {
  const saved = normalizeRecipe({
    id: `web-${Date.now()}`,
    name: recipe.name,
    url: recipe.url,
    minutes: recipe.minutes,
    prepMinutes: recipe.prepMinutes || 0,
    servings: recipe.servings || 4,
    tags: recipe.tags || [],
    ingredients: recipe.ingredients || [],
    notes: recipe.reason || ""
  });
  state.recipes.push(saved);
  state.selectedRecipeId = saved.id;
  saveState();
  renderLibrary();
  renderRecipeDetail();
}

function parseIngredients(value) {
  return splitList(value).map((item) => {
    const [name, category] = item.split("|").map((part) => part.trim());
    return { name, category: category || guessCategory(name) };
  });
}

function splitList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function guessCategory(name) {
  const value = String(name || "").toLowerCase();
  if (/(milk|cheese|yogurt|cream|butter|feta|parmesan)/.test(value)) return "Dairy";
  if (/(chicken|beef|turkey|salmon|tofu|egg|pork|shrimp|fish)/.test(value)) return "Protein";
  if (/(spinach|lemon|onion|garlic|tomato|cucumber|carrot|kale|broccoli|pepper|lettuce|lime|cabbage)/.test(value)) return "Produce";
  if (/(frozen|peas|corn)/.test(value)) return "Frozen";
  return "Pantry";
}

function getRecipe(id) {
  return state.recipes.find((recipe) => recipe.id === id);
}

function normalizeMealPlan(mealPlan) {
  return Object.entries(mealPlan || {}).reduce((plan, [date, value]) => {
    if (typeof value === "string") {
      plan[date] = { dinner: value };
    } else {
      plan[date] = { ...(value || {}) };
    }
    return plan;
  }, {});
}

function getDayPlan(date, plan = state.mealPlan[date]) {
  if (typeof plan === "string") return { dinner: plan };
  return { ...(plan || {}) };
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function formatDate(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`);
  return date.toLocaleDateString([], { month: "short", day: "numeric", weekday: "short" });
}

function groceryKey(name, category) {
  return `${String(category || "Other").toLowerCase()}::${String(name).toLowerCase()}`;
}

function resetData() {
  state = defaultState();
  hydratePreferences();
  saveState();
  render();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value || "#");
}

function formatAssistantText(value) {
  return escapeHtml(value)
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br />")
    .replace(/^/, "<p>")
    .replace(/$/, "</p>");
}
