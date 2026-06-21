// SiteDeck dashboard front-end. Plain JS, no build step.
// Talks to GET /api/summary?period=7|28|90.

import { t, applyI18n, initI18n, setLocale, getLocale } from "/i18n.js";
import { toCsv, matchesFilter, relTime, resolveTheme, cwvRating, cwvText, deltaClass, sortValue, geoScore } from "/format.js";

// A change of this magnitude (%) is a "big mover" worth emphasizing for triage.
const DELTA_BIG = 30;

// Tiny localStorage wrapper (private mode / disabled storage degrades gracefully).
const store = {
  get: (k) => { try { return localStorage.getItem("sitedeck." + k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem("sitedeck." + k, v); } catch {} },
};

const state = { data: null, insights: null, onpage: null, github: null, filter: "", sortKey: "activeUsers", sortDir: "desc" };

const els = {
  period: document.getElementById("period"),
  search: document.getElementById("search"),
  autorefresh: document.getElementById("autorefresh"),
  refresh: document.getElementById("refresh"),
  export: document.getElementById("export"),
  status: document.getElementById("status"),
  table: document.getElementById("table"),
  tbody: document.querySelector("#table tbody"),
  meta: document.getElementById("meta"),
  headers: document.querySelectorAll("th.sortable"),
};

// Theme: apply the saved choice right away ("system" follows the OS preference).
function applyTheme(setting) {
  document.documentElement.dataset.theme = resolveTheme(
    setting,
    matchMedia("(prefers-color-scheme: light)").matches,
  );
}
function setTheme(setting) {
  store.set("theme", setting);
  applyTheme(setting);
}
applyTheme(store.get("theme") || "system");
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if ((store.get("theme") || "system") === "system") applyTheme("system");
});

function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString(getLocale()) : "—";
}

function fmtWhen(value) {
  if (!value) return "—";
  const d = new Date(value);
  return isNaN(d) ? "—" : d.toLocaleString(getLocale());
}

function fmtDelta(pct) {
  const cls = deltaClass(pct, DELTA_BIG);
  if (cls === "none") return '<span class="delta flat">—</span>';
  const n = Math.abs(pct).toLocaleString(getLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  // ~0% is neutral (no green up-arrow); big movers get the .big emphasis class.
  if (cls === "flat") return `<span class="delta flat">${n}%</span>`;
  return `<span class="delta ${cls}">${cls.startsWith("up") ? "▲" : "▼"} ${n}%</span>`;
}

// Search Console average position: "—" when there's no matched site or no
// impressions in the period (an average position is only meaningful with impressions).
function fmtPos(search) {
  if (!search || !(search.impressions > 0)) return "—";
  return search.position.toLocaleString(getLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function sparkline(values, label = "", w = 84, h = 24) {
  if (!values || values.length === 0) return "";
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`)
    .join(" ");
  // Labelled when a description is given (screen readers announce it), otherwise
  // marked decorative so it isn't announced as a meaningless "image".
  const a11y = label ? ` role="img" aria-label="${escapeHtml(label)}"` : ' aria-hidden="true"';
  return `<svg class="spark"${a11y} width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function gaUrl(propertyId) {
  return propertyId ? `https://analytics.google.com/analytics/web/#/p${encodeURIComponent(propertyId)}` : null;
}

// Site name, linked to an external target (GA4 property, or the site URL) when one
// is known. Opens in the browser; in Electron the will-navigate handler externalizes it.
function siteLink(name, href) {
  const safe = escapeHtml(name);
  // Only link to an http(s) target — a hostile `javascript:`/`file:` defaultUri must
  // render as plain text, not a clickable link, even though escapeHtml guards the attr.
  let httpHref = null;
  try {
    if (href && /^https?:$/.test(new URL(href).protocol)) httpHref = href;
  } catch {}
  return httpHref
    ? `<a class="site-link" href="${escapeHtml(httpHref)}" target="_blank" rel="noopener noreferrer">${safe}</a>`
    : safe;
}

function trendTip(values) {
  if (!values || !values.length) return "";
  return `● ${values[values.length - 1]}   ↑ ${Math.max(...values)}   ↓ ${Math.min(...values)}`;
}

// A single full-width row shown when the search filter hides every site.
function noMatchRow(cols) {
  return `<tr><td colspan="${cols}" class="empty">${t("status.noMatch", { q: escapeHtml(state.filter) })}</td></tr>`;
}

function localizeError(error) {
  if (!error) return "";
  // detail is interpolated into innerHTML (status messages keep an <a> link),
  // so escape it — it can be an arbitrary server-supplied message.
  const detail = escapeHtml(error.detail ?? "");
  const key = `error.${error.code}`;
  const msg = t(key, { detail });
  return msg === key ? t("error.unknown", { detail: detail || escapeHtml(error.code) }) : msg;
}

function setStatus(html, kind) {
  els.status.className = `status ${kind ?? "info"}`;
  // Errors interrupt; everything else is announced politely.
  els.status.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  els.status.innerHTML = html;
  els.status.hidden = !html;
}

function sortedSites() {
  const sites = (state.data?.sites ?? []).filter((s) => matchesFilter(s.displayName, state.filter));
  const dir = state.sortDir === "asc" ? 1 : -1;
  sites.sort((a, b) => {
    if (state.sortKey === "name") {
      const av = a.displayName.toLowerCase();
      const bv = b.displayName.toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    }
    const av = sortValue(a, state.sortKey);
    const bv = sortValue(b, state.sortKey);
    return (av - bv) * dir;
  });
  return sites;
}

function render() {
  els.headers.forEach((th) => {
    const key = th.dataset.sort;
    const active = key === state.sortKey;
    th.classList.toggle("sorted", active);
    if (active) {
      th.dataset.dir = state.sortDir;
      th.setAttribute("aria-sort", state.sortDir === "asc" ? "ascending" : "descending");
    } else {
      th.removeAttribute("data-dir");
      th.setAttribute("aria-sort", "none");
    }
  });

  const sites = sortedSites();
  const total = state.data?.sites?.length ?? 0;
  const rows = sites
    .map(
      (s) => `
      <tr>
        <td class="name">${siteLink(s.displayName, gaUrl(s.propertyId))}</td>
        <td class="num">${fmtNum(s.activeUsers?.current)} ${fmtDelta(s.activeUsers?.deltaPct)}</td>
        <td class="num">${fmtNum(s.sessions?.current)} ${fmtDelta(s.sessions?.deltaPct)}</td>
        <td class="num">${fmtNum(s.keyEvents?.current)} ${fmtDelta(s.keyEvents?.deltaPct)}</td>
        <td class="num">${fmtNum(s.aiSessions?.current)} ${fmtDelta(s.aiSessions?.deltaPct)}</td>
        <td class="num">${fmtNum(s.search?.impressions)}</td>
        <td class="num">${fmtNum(s.search?.clicks)}</td>
        <td class="num">${fmtPos(s.search)}</td>
        <td class="top" title="${escapeHtml(s.topPage ?? "")}">${escapeHtml(s.topPage ?? "—")}</td>
        <td class="top">${escapeHtml(s.topSource ?? "—")}</td>
        <td class="spark-cell" title="${escapeHtml(trendTip(s.trend))}">${sparkline(s.trend, `${s.displayName} ${t("col.trend")}`)}</td>
      </tr>`,
    )
    .join("");
  els.tbody.innerHTML = rows || (total && state.filter ? noMatchRow(11) : "");
  els.table.hidden = total === 0;
}

const SETUP_URL = "https://github.com/writingdeveloper/SiteDeck#google-cloud-setup-one-time-5-min";

async function load() {
  const period = els.period.value;
  setStatus(t("status.loading"), "info");
  els.table.hidden = true;
  els.meta.textContent = "";
  try {
    const res = await fetch(`/api/summary?period=${period}`);
    const data = await res.json().catch(() => null);
    if (!data) throw new Error(`HTTP ${res.status}`);

    if (data.error) {
      state.data = null;
      els.tbody.innerHTML = "";
      const setupLink = String(data.error.code ?? "").startsWith("credentials_")
        ? ` · <a href="${SETUP_URL}" target="_blank" rel="noopener noreferrer">${t("link.setupGuide")}</a>`
        : "";
      setStatus(
        `${localizeError(data.error)} · <a href="/oauth/start">${t("link.reconnect")}</a>${setupLink}`,
        "error",
      );
      return;
    }

    if (!data.authenticated) {
      state.data = null;
      els.tbody.innerHTML = "";
      setStatus(
        `${t("status.needAuth")} <a href="${escapeHtml(data.authUrl)}">${t("link.connectAccount")}</a> · <a href="${SETUP_URL}" target="_blank" rel="noopener noreferrer">${t("link.setupGuide")}</a>`,
        "warn",
      );
      return;
    }

    state.data = data;
    if (!data.sites || data.sites.length === 0) {
      els.tbody.innerHTML = "";
      if (data.errors && data.errors.length) {
        // Every property failed (quota / token / network) — don't claim "no properties".
        setStatus(
          `${t("status.allFailed", { count: data.errors.length })} · <a href="/oauth/start">${t("link.reconnect")}</a>`,
          "error",
        );
      } else {
        setStatus(t("status.noProperties"), "warn");
      }
      return;
    }

    setStatus("", "info");
    render();
    renderMeta();
  } catch (err) {
    setStatus(
      `${escapeHtml(err?.message ?? String(err))} · <a href="/oauth/start">${t("link.reconnect")}</a>`,
      "error",
    );
  }
}

function applyPeriodOptions() {
  els.period.querySelectorAll("option").forEach((o) => {
    o.textContent = t("period.option", { n: o.value });
  });
}

// Meta line with a live "updated x ago" (absolute time on hover). Re-run on a timer.
function renderMeta() {
  if (!state.data) {
    els.meta.textContent = "";
    els.meta.removeAttribute("title");
    return;
  }
  const d = state.data;
  const when = relTime(new Date(d.generatedAt).getTime(), Date.now(), getLocale(), t("meta.justNow"));
  els.meta.title = fmtWhen(d.generatedAt);
  const filtered = state.filter
    ? t("meta.filtered", {
        shown: d.sites.filter((s) => matchesFilter(s.displayName, state.filter)).length,
        total: d.sites.length,
      })
    : "";
  // Morning-triage signal: how many sites' active users dropped sharply.
  const drops = d.sites.filter(
    (s) => typeof s.activeUsers?.deltaPct === "number" && s.activeUsers.deltaPct <= -DELTA_BIG,
  ).length;
  const dropSuffix = drops ? t("meta.sharpDrops", { count: drops }) : "";
  els.meta.textContent = `${t("meta.summary", { count: d.sites.length, period: d.period, when })}${
    d.errors?.length ? t("meta.errorsSuffix", { count: d.errors.length }) : ""
  }${dropSuffix}${filtered}`;
}

function toggleSort(th) {
  const key = th.dataset.sort;
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = key;
    // Average position is "lower is better", so default it to ascending like names.
    state.sortDir = key === "name" || key === "searchPosition" ? "asc" : "desc";
  }
  render();
  store.set("sortKey", state.sortKey);
  store.set("sortDir", state.sortDir);
}

els.refresh.addEventListener("click", load);
els.period.addEventListener("change", () => {
  store.set("period", els.period.value);
  load();
});
els.headers.forEach((th) => {
  th.addEventListener("click", () => toggleSort(th));
  th.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleSort(th);
    }
  });
});

const tabs = document.querySelectorAll(".tab");
const views = {
  traffic: document.getElementById("view-traffic"),
  performance: document.getElementById("view-performance"),
  geo: document.getElementById("view-geo"),
  repos: document.getElementById("view-repos"),
};
const insights = {
  status: document.getElementById("insights-status"),
  table: document.getElementById("insights-table"),
  tbody: document.querySelector("#insights-table tbody"),
  meta: document.getElementById("insights-meta"),
  measure: document.getElementById("measure"),
};
let insightsTimer = null;

function scoreCell(v) {
  if (v === null || v === undefined) return '<span class="score na">—</span>';
  const cls = v >= 90 ? "good" : v >= 50 ? "avg" : "poor";
  return `<span class="score ${cls}">${v}</span>`;
}

// A Core Web Vital cell, coloured by the good/needs-improvement/poor thresholds.
function cwvCell(value, kind) {
  return `<span class="score ${cwvRating(value, kind)}">${cwvText(value, kind)}</span>`;
}

function renderInsights(data) {
  insights.measure.disabled = Boolean(data.isMeasuring);
  if (data.isMeasuring) insights.measure.setAttribute("aria-busy", "true");
  else insights.measure.removeAttribute("aria-busy");
  if (!data.configured) {
    insights.table.hidden = true;
    insights.tbody.innerHTML = "";
    insights.status.hidden = false;
    insights.status.className = "status warn";
    insights.status.innerHTML = `${t("insights.notConfigured")} <a href="#" class="link-settings">${t("link.openSettings")}</a>`;
    return;
  }
  const sites = data.sites ?? [];
  insights.table.hidden = sites.length === 0;
  insights.status.hidden = sites.length > 0 && !data.isMeasuring;
  if (data.isMeasuring) {
    insights.status.hidden = false;
    insights.status.className = "status info";
    insights.status.textContent = t("insights.measuring");
  } else if (sites.length === 0) {
    insights.status.className = "status info";
    insights.status.textContent = t("insights.empty");
  }
  const visibleRows = sites
    .filter((s) => matchesFilter(s.displayName, state.filter))
    .map((s) => {
      const l = s.latest ?? {};
      const when = fmtWhen(l.ts);
      return `<tr>
        <td class="name">${siteLink(s.displayName, s.url || null)}</td>
        <td class="num">${scoreCell(l.performance)}</td>
        <td class="num">${scoreCell(l.accessibility)}</td>
        <td class="num">${scoreCell(l.bestPractices)}</td>
        <td class="num">${scoreCell(l.seo)}</td>
        <td class="num">${cwvCell(l.lcpMs, "lcp")}</td>
        <td class="num">${cwvCell(l.cls, "cls")}</td>
        <td class="num">${cwvCell(l.inpMs, "inp")}</td>
        <td class="top">${when}</td>
        <td class="spark-cell" title="${escapeHtml(trendTip(s.trend))}">${sparkline(s.trend, `${s.displayName} ${t("col.trend")}`)}</td>
      </tr>`;
    })
    .join("");
  insights.tbody.innerHTML = visibleRows || (sites.length && state.filter ? noMatchRow(10) : "");
  insights.meta.textContent = data.lastRunAt
    ? `${t("insights.lastMeasured", { when: fmtWhen(data.lastRunAt) })}${data.errors?.length ? t("insights.errorsSuffix", { count: data.errors.length }) : ""}`
    : "";
}

function stopInsightsPolling() {
  if (insightsTimer) {
    clearInterval(insightsTimer);
    insightsTimer = null;
  }
}

async function loadInsights() {
  // Show a loading hint only on first open (no rows yet) — not on every 4s poll.
  if (!insights.tbody.children.length && insights.status.hidden) {
    insights.status.hidden = false;
    insights.status.className = "status info";
    insights.status.textContent = t("status.loading");
  }
  try {
    const res = await fetch("/api/insights");
    const data = await res.json();
    state.insights = data;
    renderInsights(data);
    if (data.isMeasuring && !insightsTimer) {
      insightsTimer = setInterval(loadInsights, 4000);
    } else if (!data.isMeasuring) {
      stopInsightsPolling();
    }
  } catch (err) {
    insights.status.hidden = false;
    insights.status.className = "status error";
    insights.status.textContent = `${escapeHtml(err?.message ?? String(err))}`;
  }
}

insights.measure.addEventListener("click", async () => {
  insights.measure.disabled = true;
  insights.measure.setAttribute("aria-busy", "true");
  try {
    const res = await fetch("/api/insights/measure", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadInsights();
  } catch (err) {
    insights.status.hidden = false;
    insights.status.className = "status error";
    insights.status.textContent = err?.message ?? String(err);
    insights.measure.disabled = false;
    insights.measure.removeAttribute("aria-busy");
  }
});

// --- GEO tab: on-page SEO / AI-readiness checks (on-demand, stateless) ---
const geo = {
  status: document.getElementById("geo-status"),
  table: document.getElementById("geo-table"),
  tbody: document.querySelector("#geo-table tbody"),
  meta: document.getElementById("geo-meta"),
  check: document.getElementById("geo-check"),
};

function checkCell(ok) {
  return `<span class="score ${ok ? "good" : "poor"}">${ok ? "✓" : "✗"}</span>`;
}

function geoScoreCell(n) {
  const cls = n >= 5 ? "good" : n >= 3 ? "avg" : "poor";
  return `<span class="score ${cls}">${n}/6</span>`;
}

function renderOnpage(data) {
  const sites = data?.sites ?? [];
  geo.table.hidden = sites.length === 0;
  const rows = sites
    .filter((s) => matchesFilter(s.displayName, state.filter))
    .map((s) => {
      if (!s.checks) {
        return `<tr><td class="name">${siteLink(s.displayName, s.url || null)}</td><td colspan="7" class="empty">${escapeHtml(s.error || "—")}</td></tr>`;
      }
      const c = s.checks;
      return `<tr>
        <td class="name">${siteLink(s.displayName, s.url || null)}</td>
        <td class="num">${checkCell(c.title)}</td>
        <td class="num">${checkCell(c.description)}</td>
        <td class="num">${checkCell(c.canonical)}</td>
        <td class="num">${checkCell(c.openGraph)}</td>
        <td class="num">${checkCell(c.structuredData)}</td>
        <td class="num">${checkCell(s.llmsTxt)}</td>
        <td class="num">${geoScoreCell(geoScore(s))}</td>
      </tr>`;
    })
    .join("");
  geo.tbody.innerHTML = rows || (sites.length && state.filter ? noMatchRow(8) : "");
  geo.meta.textContent = data?.generatedAt ? t("insights.lastMeasured", { when: fmtWhen(data.generatedAt) }) : "";
}

async function loadOnpage(force) {
  // Stateless + on-demand: reuse the cached result across tab switches; only the
  // explicit "Check now" button (force) re-fetches every homepage.
  if (state.onpage && !force) {
    renderOnpage(state.onpage);
    return;
  }
  geo.status.hidden = false;
  geo.status.className = "status info";
  geo.status.textContent = t("status.loading");
  geo.check.disabled = true;
  geo.check.setAttribute("aria-busy", "true");
  try {
    const res = await fetch("/api/onpage");
    const data = await res.json().catch(() => null);
    if (!data) throw new Error(`HTTP ${res.status}`);
    if (data.error) {
      // A server error (e.g. the GA Admin API failing to list sites) — show the real
      // reason, not a misleading "connect account" prompt with a broken link.
      geo.table.hidden = true;
      geo.tbody.innerHTML = "";
      geo.status.hidden = false;
      geo.status.className = "status error";
      geo.status.innerHTML = `${localizeError(data.error)} · <a href="/oauth/start">${t("link.reconnect")}</a>`;
      return;
    }
    if (!data.authenticated) {
      geo.table.hidden = true;
      geo.tbody.innerHTML = "";
      geo.status.hidden = false;
      geo.status.className = "status warn";
      geo.status.innerHTML = `${t("status.needAuth")} <a href="${escapeHtml(data.authUrl)}">${t("link.connectAccount")}</a>`;
      return;
    }
    state.onpage = data;
    geo.status.hidden = true;
    renderOnpage(data);
  } catch (err) {
    geo.status.hidden = false;
    geo.status.className = "status error";
    geo.status.textContent = escapeHtml(err?.message ?? String(err));
  } finally {
    geo.check.disabled = false;
    geo.check.removeAttribute("aria-busy");
  }
}

geo.check.addEventListener("click", () => loadOnpage(true));

// --- Repos tab: GitHub repo traffic (accumulated daily, polled while measuring) ---
const repos = {
  status: document.getElementById("repos-status"),
  table: document.getElementById("repos-table"),
  tbody: document.querySelector("#repos-table tbody"),
  meta: document.getElementById("repos-meta"),
  measure: document.getElementById("repos-measure"),
};
let reposTimer = null;

function repoDetail(label, items, render) {
  if (!items || !items.length) return "";
  return `<div class="repo-detail"><b>${label}</b> <span class="muted">(${t("repos.last14d")})</span><ul>${items.map(render).join("")}</ul></div>`;
}

function renderRepos(data) {
  repos.measure.disabled = Boolean(data.isMeasuring);
  if (data.isMeasuring) repos.measure.setAttribute("aria-busy", "true");
  else repos.measure.removeAttribute("aria-busy");
  if (!data.configured) {
    repos.table.hidden = true;
    repos.tbody.innerHTML = "";
    repos.status.hidden = false;
    repos.status.className = "status warn";
    repos.status.textContent = t("repos.notConfigured");
    return;
  }
  const list = data.repos ?? [];
  const errs = data.errors ?? [];
  repos.table.hidden = list.length === 0 && errs.length === 0;
  repos.status.hidden = (list.length > 0 || errs.length > 0) && !data.isMeasuring;
  if (data.isMeasuring) {
    repos.status.hidden = false;
    repos.status.className = "status info";
    repos.status.textContent = t("repos.measuring");
  } else if (list.length === 0 && errs.length === 0) {
    repos.status.className = "status info";
    repos.status.textContent = t("repos.empty");
  }
  const rows = list
    .filter((r) => matchesFilter(r.displayName, state.filter))
    .map((r) => {
      const tt = r.totals14d ?? {};
      const detail =
        repoDetail(t("repos.referrers"), r.referrers, (x) => `<li>${escapeHtml(x.referrer)} <span class="muted">${fmtNum(x.count)}</span></li>`) +
        repoDetail(t("repos.paths"), r.paths, (x) => `<li>${escapeHtml(x.title || x.path)} <span class="muted">${fmtNum(x.count)}</span></li>`);
      const rowAttrs = detail ? ` tabindex="0" role="button" aria-expanded="false"` : "";
      return `<tr class="repo-row"${rowAttrs}>
        <td class="name">${siteLink(r.displayName, `https://github.com/${r.fullName}`)}</td>
        <td class="num">${fmtNum(tt.views)}</td>
        <td class="num">${fmtNum(tt.uniqueViews)}</td>
        <td class="num">${fmtNum(tt.clones)}</td>
        <td class="num">${fmtNum(tt.uniqueClones)}</td>
        <td class="spark-cell" title="${escapeHtml(trendTip(r.trend))}">${sparkline(r.trend, `${r.displayName} ${t("col.trend")}`)}</td>
        <td class="top">${fmtWhen(r.snapshotAt)}</td>
      </tr>${detail ? `<tr class="repo-detail-row" hidden><td colspan="7">${detail}</td></tr>` : ""}`;
    })
    .join("");
  const errorRows = errs
    .filter((e) => matchesFilter(e.repo, state.filter))
    .map((e) => `<tr><td class="name">${escapeHtml(e.repo)}</td><td colspan="6" class="empty">${escapeHtml(e.message)}</td></tr>`)
    .join("");
  repos.tbody.innerHTML = rows + errorRows || ((list.length || errs.length) && state.filter ? noMatchRow(7) : "");
  repos.meta.textContent = data.lastRunAt
    ? `${t("insights.lastMeasured", { when: fmtWhen(data.lastRunAt) })}${data.errors?.length ? t("insights.errorsSuffix", { count: data.errors.length }) : ""}`
    : "";
}

function stopReposPolling() {
  if (reposTimer) {
    clearInterval(reposTimer);
    reposTimer = null;
  }
}

async function loadRepos() {
  if (!repos.tbody.children.length && repos.status.hidden) {
    repos.status.hidden = false;
    repos.status.className = "status info";
    repos.status.textContent = t("status.loading");
  }
  try {
    const res = await fetch("/api/github");
    const data = await res.json();
    state.github = data;
    renderRepos(data);
    if (data.isMeasuring && !reposTimer) reposTimer = setInterval(loadRepos, 4000);
    else if (!data.isMeasuring) stopReposPolling();
  } catch (err) {
    repos.status.hidden = false;
    repos.status.className = "status error";
    repos.status.textContent = escapeHtml(err?.message ?? String(err));
  }
}

// Expand/collapse a repo row to reveal its 14-day referrers + popular paths.
repos.tbody.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("a")) return;
  const row = e.target.closest && e.target.closest(".repo-row");
  if (!row) return;
  const detail = row.nextElementSibling;
  if (detail && detail.classList.contains("repo-detail-row")) {
    detail.hidden = !detail.hidden;
    row.setAttribute("aria-expanded", String(!detail.hidden));
  }
});
repos.tbody.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("repo-row")) {
    e.preventDefault();
    const detail = e.target.nextElementSibling;
    if (detail && detail.classList.contains("repo-detail-row")) {
      detail.hidden = !detail.hidden;
      e.target.setAttribute("aria-expanded", String(!detail.hidden));
    }
  }
});

repos.measure.addEventListener("click", async () => {
  repos.measure.disabled = true;
  repos.measure.setAttribute("aria-busy", "true");
  try {
    const res = await fetch("/api/github/measure", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadRepos();
  } catch (err) {
    repos.status.hidden = false;
    repos.status.className = "status error";
    repos.status.textContent = err?.message ?? String(err);
    repos.measure.disabled = false;
    repos.measure.removeAttribute("aria-busy");
  }
});

const settings = {
  view: document.getElementById("view-settings"),
  lang: document.getElementById("lang-select"),
  theme: document.getElementById("theme-select"),
  psiKey: document.getElementById("psi-key"),
  psiSave: document.getElementById("psi-save"),
  psiStatus: document.getElementById("psi-status"),
  setupSteps: document.getElementById("setup-steps"),
  gscField: document.getElementById("gsc-field"),
  gscStatus: document.getElementById("gsc-status"),
  versionCurrent: document.getElementById("version-current"),
  checkUpdate: document.getElementById("check-update"),
  updateRestart: document.getElementById("update-restart"),
  updateStatus: document.getElementById("update-status"),
  status: document.getElementById("settings-status"),
};

async function loadSettings() {
  const s = await (await fetch("/api/settings")).json();
  settings.lang.value = getLocale();
  settings.theme.value = store.get("theme") || "system";
  settings.psiStatus.textContent = s.hasPsiKey ? t("settings.psiKeySet", { masked: s.psiKeyMasked }) : "";
  renderSetup(s);
  renderGsc(s.searchConsole);
  try {
    const v = await (await fetch("/api/version")).json();
    settings.versionCurrent.textContent = `v${v.current}`;
  } catch {}
}

// Onboarding checklist: live ✓/✗ for credentials (valid/invalid/missing) + PSI key.
function renderSetup(s) {
  const cs = s.credentialsStatus || (s.hasCredentials ? "valid" : "missing");
  const credOk = cs === "valid";
  const credText =
    cs === "valid"
      ? t("settings.credentialsFound")
      : cs === "invalid"
        ? t("settings.credentialsInvalid")
        : t("settings.credentialsMissing");
  const psiOk = Boolean(s.hasPsiKey);
  const psiText = psiOk
    ? t("settings.psiKeySet", { masked: escapeHtml(s.psiKeyMasked ?? "") })
    : t("settings.psiKeyOptional");
  const guide = `<a href="${SETUP_URL}" target="_blank" rel="noopener noreferrer">${t("link.setupGuide")}</a>`;
  settings.setupSteps.innerHTML =
    `<li class="${credOk ? "ok" : "bad"}"><span class="mark">${credOk ? "✓" : "✗"}</span> ` +
    `<b>${t("settings.credentialsLabel")}</b> — ${credText} ${credOk ? "" : guide}</li>` +
    `<li class="${psiOk ? "ok" : "opt"}"><span class="mark">${psiOk ? "✓" : "○"}</span> ` +
    `<b>${t("settings.psiKeyLabel")}</b> — ${psiText}</li>`;
}

// Show a one-time "reconnect to enable Search Console" prompt only when the cached
// token predates the webmasters scope (server reports searchConsole === "reconnect").
function renderGsc(status) {
  if (!settings.gscField) return;
  const show = status === "reconnect";
  settings.gscField.hidden = !show;
  if (show) settings.gscStatus.textContent = t("settings.searchReconnect");
}

settings.lang.addEventListener("change", async () => {
  await setLocale(settings.lang.value);
  await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language: settings.lang.value }),
  });
  try { localStorage.setItem("sitedeck.locale", settings.lang.value); } catch {}
  rerenderAll();
});

settings.theme.addEventListener("change", () => setTheme(settings.theme.value));

function showSettingsStatus(text, kind) {
  settings.status.hidden = !text;
  settings.status.className = `status ${kind}`;
  settings.status.textContent = text;
}

settings.psiSave.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ psiApiKey: settings.psiKey.value }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error?.detail ?? `HTTP ${res.status}`);
    settings.psiKey.value = "";
    showSettingsStatus(t("settings.saved"), "info");
    loadSettings();
  } catch (err) {
    showSettingsStatus(t("error.unknown", { detail: err?.message ?? String(err) }), "error");
  }
});

const electronUpdate =
  typeof window !== "undefined" && window.sitedeck && window.sitedeck.isElectron ? window.sitedeck : null;

function applyUpdateStatus(s) {
  if (!s) return;
  switch (s.status) {
    case "checking":
      settings.updateStatus.textContent = t("settings.checking");
      break;
    case "available":
      settings.updateStatus.textContent = t("settings.updateAvailable", { version: `v${s.version}` });
      break;
    case "not-available":
      settings.updateStatus.textContent = t("settings.upToDate");
      break;
    case "progress":
      settings.updateStatus.textContent = t("settings.downloading", { percent: Math.round(s.percent) });
      break;
    case "downloaded":
      settings.updateStatus.textContent = t("settings.updateReady", { version: `v${s.version}` });
      if (settings.updateRestart) settings.updateRestart.hidden = false;
      break;
    case "error":
      settings.updateStatus.textContent = t("settings.updateError", { detail: s.message ?? "" });
      break;
  }
}

async function checkForUpdatesBrowser() {
  try {
    const v = await (await fetch("/api/version")).json();
    settings.versionCurrent.textContent = `v${v.current}`;
    settings.updateStatus.textContent = v.updateAvailable
      ? t("settings.updateAvailable", { version: `v${v.latest}` })
      : t("settings.upToDate");
  } catch (err) {
    settings.updateStatus.textContent = t("error.unknown", { detail: err?.message ?? String(err) });
  }
}

if (electronUpdate) {
  // Installed app: drive the real updater and reflect its progress live.
  electronUpdate.onUpdateStatus(applyUpdateStatus);
  electronUpdate.getUpdateStatus().then(applyUpdateStatus).catch(() => {});
  settings.checkUpdate.addEventListener("click", async () => {
    settings.updateStatus.textContent = t("settings.checking");
    try {
      await electronUpdate.checkForUpdates();
    } catch (err) {
      settings.updateStatus.textContent = t("settings.updateError", { detail: err?.message ?? String(err) });
    }
  });
  if (settings.updateRestart) {
    settings.updateRestart.addEventListener("click", () => electronUpdate.quitAndInstall());
  }
} else {
  // Browser / dev server: fall back to a one-shot version comparison.
  settings.checkUpdate.addEventListener("click", checkForUpdatesBrowser);
}

function rerenderAll() {
  document.documentElement.lang = getLocale();
  applyI18n();
  applyPeriodOptions();
  if (state.data) {
    render();
    renderMeta();
  }
  loadSettings();
  if (!views.performance.hidden) loadInsights();
}

function activateTab(view) {
  tabs.forEach((b) => {
    const active = b.dataset.view === view;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  views.traffic.hidden = view !== "traffic";
  views.performance.hidden = view !== "performance";
  views.geo.hidden = view !== "geo";
  views.repos.hidden = view !== "repos";
  settings.view.hidden = view !== "settings";
  if (view === "performance") loadInsights();
  else stopInsightsPolling(); // don't keep polling a hidden tab
  if (view === "geo") loadOnpage();
  if (view === "repos") loadRepos(); else stopReposPolling();
  if (view === "settings") loadSettings();
}

tabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    activateTab(tab.dataset.view);
    store.set("tab", tab.dataset.view);
  }),
);

// --- Search / filter (live, applies to whichever table is visible) ---
els.search.addEventListener("input", () => {
  state.filter = els.search.value;
  if (!views.traffic.hidden && state.data) render();
  if (!views.performance.hidden && state.insights) renderInsights(state.insights);
  if (!views.geo.hidden && state.onpage) renderOnpage(state.onpage);
  if (!views.repos.hidden && state.github) renderRepos(state.github);
});

// --- CSV export of the current view ---
function downloadCsv(filename, csv) {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM → Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

els.export.addEventListener("click", () => {
  if (!views.traffic.hidden && state.data) {
    const headers = [t("col.site"), t("col.activeUsers"), "Δ%", t("col.sessions"), "Δ%", t("col.keyEvents"), "Δ%", t("col.aiTraffic"), "Δ%", t("col.searchImpressions"), t("col.searchClicks"), t("col.searchPosition"), t("col.topPage"), t("col.topSource")];
    const rows = sortedSites().map((s) => [
      s.displayName,
      s.activeUsers?.current ?? "", s.activeUsers?.deltaPct ?? "",
      s.sessions?.current ?? "", s.sessions?.deltaPct ?? "",
      s.keyEvents?.current ?? "", s.keyEvents?.deltaPct ?? "",
      s.aiSessions?.current ?? "", s.aiSessions?.deltaPct ?? "",
      s.search?.impressions ?? "", s.search?.clicks ?? "", s.search?.position ?? "",
      s.topPage ?? "", s.topSource ?? "",
    ]);
    downloadCsv(`sitedeck-traffic-${state.data.period}d.csv`, toCsv(headers, rows));
  } else if (!views.performance.hidden && state.insights) {
    const headers = [t("col.site"), t("col.performance"), t("col.accessibility"), t("col.bestPractices"), t("col.seo"), t("col.lcp"), t("col.cls"), t("col.inp"), t("col.measuredAt")];
    const rows = (state.insights.sites ?? [])
      .filter((s) => matchesFilter(s.displayName, state.filter))
      .map((s) => {
        const l = s.latest ?? {};
        return [s.displayName, l.performance ?? "", l.accessibility ?? "", l.bestPractices ?? "", l.seo ?? "", l.lcpMs ?? "", l.cls ?? "", l.inpMs ?? "", l.ts ?? ""];
      });
    downloadCsv("sitedeck-performance.csv", toCsv(headers, rows));
  } else if (!views.geo.hidden && state.onpage) {
    const headers = [t("col.site"), t("col.title"), t("col.description"), t("col.canonical"), t("col.openGraph"), t("col.structuredData"), t("col.llmsTxt"), t("col.geoScore")];
    const rows = (state.onpage.sites ?? [])
      .filter((s) => matchesFilter(s.displayName, state.filter))
      .map((s) => {
        const c = s.checks;
        if (!c) return [s.displayName, "", "", "", "", "", "", ""];
        const n = (v) => (v ? 1 : 0);
        return [s.displayName, n(c.title), n(c.description), n(c.canonical), n(c.openGraph), n(c.structuredData), n(s.llmsTxt), geoScore(s)];
      });
    downloadCsv("sitedeck-geo.csv", toCsv(headers, rows));
  }
});

// --- Auto-refresh the visible data view ---
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let autoTimer = null;
function applyAutoRefresh() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (els.autorefresh.checked) {
    autoTimer = setInterval(() => {
      if (!views.traffic.hidden) load();
      else if (!views.performance.hidden) loadInsights();
    }, AUTO_REFRESH_MS);
  }
  store.set("autorefresh", els.autorefresh.checked ? "1" : "0");
}
els.autorefresh.addEventListener("change", applyAutoRefresh);

// Keep the "updated x ago" label fresh without re-fetching.
setInterval(renderMeta, 30000);

// Inline "Open Settings" links (e.g. the PageSpeed not-configured hint).
document.addEventListener("click", (e) => {
  const link = e.target.closest && e.target.closest(".link-settings");
  if (link) {
    e.preventDefault();
    activateTab("settings");
    store.set("tab", "settings");
  }
});

// Press "/" to jump to the search box (unless already typing in a field).
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = e.target && e.target.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
      e.preventDefault();
      els.search.focus();
    }
  }
});

(async () => {
  let stored = null;
  try { stored = (await (await fetch("/api/settings")).json()).language; } catch {}
  if (!stored) { try { stored = localStorage.getItem("sitedeck.locale"); } catch {} }
  await initI18n(stored);
  document.documentElement.lang = getLocale();
  applyI18n();
  applyPeriodOptions();

  // Restore remembered preferences.
  const savedPeriod = store.get("period");
  if (savedPeriod && [...els.period.options].some((o) => o.value === savedPeriod)) {
    els.period.value = savedPeriod;
  }
  const savedSortKey = store.get("sortKey");
  if (savedSortKey) {
    state.sortKey = savedSortKey;
    state.sortDir = store.get("sortDir") === "asc" ? "asc" : "desc";
  }
  els.autorefresh.checked = store.get("autorefresh") === "1";
  applyAutoRefresh();
  const savedTab = store.get("tab");
  if (savedTab && savedTab !== "traffic") activateTab(savedTab);

  load();
})();
