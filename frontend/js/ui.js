const RING_CIRCUMFERENCE = 2 * Math.PI * 88; // matches r="88" in the SVG

const el = (id) => document.getElementById(id);

export function showToast(message, variant = "default") {
  const toast = el("toast");
  toast.textContent = message;
  toast.className = "toast show" + (variant !== "default" ? ` ${variant}` : "");
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => (toast.hidden = true), 300);
  }, 2600);
}

export function setGreeting() {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  el("greeting-date").textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  document.querySelector(".greeting").textContent = greeting;
}

export function renderDashboard(targets, todaysLogs, water) {
  const totals = todaysLogs.reduce(
    (acc, log) => {
      acc.calories += log.calories;
      acc.protein += log.protein;
      acc.carbs += log.carbs;
      acc.fats += log.fats;
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fats: 0 }
  );

  // Calorie ring
  const calProgress = Math.min(totals.calories / (targets.daily_calories || 1), 1);
  const offset = RING_CIRCUMFERENCE * (1 - calProgress);
  const ring = el("ring-calories");
  ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  ring.style.strokeDashoffset = String(offset);
  ring.style.stroke = totals.calories > targets.daily_calories ? "var(--c-danger)" : "var(--c-calories)";

  const remaining = Math.max(Math.round(targets.daily_calories - totals.calories), 0);
  el("cal-remaining").textContent = remaining.toLocaleString();
  el("cal-consumed-of-target").textContent = `${Math.round(totals.calories)} / ${Math.round(targets.daily_calories)} kcal`;

  // Macro bars
  setMacroBar("protein", totals.protein, targets.daily_protein);
  setMacroBar("carbs", totals.carbs, targets.daily_carbs);
  setMacroBar("fats", totals.fats, targets.daily_fats);

  // Water
  const waterPct = Math.min((water.total_ml / (water.target_ml || 1)) * 100, 100);
  el("water-liquid").style.height = `${waterPct}%`;
  el("water-current").textContent = water.total_ml.toLocaleString();
  el("water-target").textContent = water.target_ml.toLocaleString();

  renderLogList(todaysLogs);
}

function setMacroBar(key, current, target) {
  const pct = Math.min((current / (target || 1)) * 100, 100);
  el(`bar-${key}`).style.width = `${pct}%`;
  el(`${key}-current`).textContent = Math.round(current);
  el(`${key}-target`).textContent = Math.round(target);
}

export function renderLogList(logs) {
  const list = el("log-list");
  const empty = el("log-empty");
  list.querySelectorAll(".log-item").forEach((n) => n.remove());

  if (!logs.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  logs.forEach((log) => {
    const li = document.createElement("li");
    li.className = "log-item";
    li.dataset.id = log.id;
    li.innerHTML = `
      <div class="log-item-icon">${(log.food_name || "?").slice(0, 1).toUpperCase()}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(log.food_name)}</div>
        <div class="log-item-meta">${Math.round(log.weight_g)}g · P${Math.round(log.protein)} C${Math.round(log.carbs)} F${Math.round(log.fats)}</div>
      </div>
      <div class="log-item-cal">${Math.round(log.calories)}</div>
      <div class="log-item-actions">
        <button data-action="edit" aria-label="Edit"><svg viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `;
    list.appendChild(li);
  });
}

export function renderSavedMeals(meals) {
  const list = el("saved-meals-list");
  const empty = el("saved-empty");
  list.querySelectorAll(".log-item").forEach((n) => n.remove());

  if (!meals.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  meals.forEach((meal) => {
    const li = document.createElement("li");
    li.className = "log-item";
    li.dataset.id = meal.id;
    li.innerHTML = `
      <div class="log-item-icon">${(meal.name || "?").slice(0, 1).toUpperCase()}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(meal.name)}</div>
        <div class="log-item-meta">${Math.round(meal.weight_g)}g · ${Math.round(meal.calories)} kcal</div>
      </div>
      <button class="saved-log-btn" data-action="log-saved">Log</button>
      <div class="log-item-actions">
        <button data-action="delete-saved" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `;
    list.appendChild(li);
  });
}

export function openSheet(id) {
  el(id).hidden = false;
}
export function closeSheet(id) {
  el(id).hidden = true;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
