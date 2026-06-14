// Lightweight client i18n. Loads /locales/<locale>.json, applies data-i18n, and t().
const LANGUAGES = ["en", "ko", "es", "zh", "ja"];
const state = { locale: "en", catalog: {}, en: {} };

function interpolate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    params && key in params ? String(params[key]) : whole,
  );
}

export function t(key, params) {
  const template = state.catalog[key] ?? state.en[key] ?? key;
  return interpolate(template, params || {});
}

export function getLocale() {
  return state.locale;
}

async function fetchCatalog(locale) {
  const res = await fetch(`/locales/${locale}.json`);
  if (!res.ok) throw new Error(`locale ${locale} ${res.status}`);
  return res.json();
}

export function resolveClientLocale(stored) {
  if (LANGUAGES.includes(stored)) return stored;
  const nav = (navigator.language || "en").slice(0, 2);
  return LANGUAGES.includes(nav) ? nav : "en";
}

/** Load en (fallback) + the chosen locale and set state. */
export async function initI18n(stored) {
  state.en = await fetchCatalog("en");
  const locale = resolveClientLocale(stored);
  state.locale = locale;
  state.catalog = locale === "en" ? state.en : await fetchCatalog(locale);
}

export async function setLocale(locale) {
  state.locale = LANGUAGES.includes(locale) ? locale : "en";
  state.catalog = state.locale === "en" ? state.en : await fetchCatalog(state.locale);
}

export function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  });
}

export { LANGUAGES };
