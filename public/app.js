// SiteDeck dashboard front-end. Plain JS, no build step.
// Talks to GET /api/summary?period=7|28|90.

import { t, applyI18n, initI18n, setLocale, getLocale } from "/i18n.js";

const state = { data: null, sortKey: "activeUsers", sortDir: "desc" };

const els = {
  period: document.getElementById("period"),
  refresh: document.getElementById("refresh"),
  status: document.getElementById("status"),
  table: document.getElementById("table"),
  tbody: document.querySelector("#table tbody"),
  meta: document.getElementById("meta"),
  headers: document.querySelectorAll("th.sortable"),
};

function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString(getLocale()) : "—";
}

function fmtWhen(value) {
  if (!value) return "—";
  const d = new Date(value);
  return isNaN(d) ? "—" : d.toLocaleString(getLocale());
}

function fmtDelta(pct) {
  if (pct === null || pct === undefined || !isFinite(pct)) {
    return '<span class="delta flat">—</span>';
  }
  const up = pct >= 0;
  return `<span class="delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}%</span>`;
}

function sparkline(values, w = 84, h = 24) {
  if (!values || values.length === 0) return "";
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`)
    .join(" ");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
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
  els.status.innerHTML = html;
  els.status.hidden = !html;
}

function sortedSites() {
  const sites = [...(state.data?.sites ?? [])];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sites.sort((a, b) => {
    if (state.sortKey === "name") {
      const av = a.displayName.toLowerCase();
      const bv = b.displayName.toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    }
    const av = a[state.sortKey]?.current ?? 0;
    const bv = b[state.sortKey]?.current ?? 0;
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
  els.tbody.innerHTML = sites
    .map(
      (s) => `
      <tr>
        <td class="name">${escapeHtml(s.displayName)}</td>
        <td class="num">${fmtNum(s.activeUsers?.current)} ${fmtDelta(s.activeUsers?.deltaPct)}</td>
        <td class="num">${fmtNum(s.sessions?.current)} ${fmtDelta(s.sessions?.deltaPct)}</td>
        <td class="num">${fmtNum(s.keyEvents?.current)} ${fmtDelta(s.keyEvents?.deltaPct)}</td>
        <td class="top" title="${escapeHtml(s.topPage ?? "")}">${escapeHtml(s.topPage ?? "—")}</td>
        <td class="top">${escapeHtml(s.topSource ?? "—")}</td>
        <td class="spark-cell">${sparkline(s.trend)}</td>
      </tr>`,
    )
    .join("");
  els.table.hidden = sites.length === 0;
}

async function load() {
  const period = els.period.value;
  setStatus(t("status.loading"), "info");
  els.table.hidden = true;
  els.meta.textContent = "";
  try {
    const res = await fetch(`/api/summary?period=${period}`);
    const data = await res.json();

    if (data.error) {
      state.data = null;
      els.tbody.innerHTML = "";
      setStatus(
        `${localizeError(data.error)} · <a href="/oauth/start">${t("link.reconnect")}</a>`,
        "error",
      );
      return;
    }

    if (!data.authenticated) {
      state.data = null;
      els.tbody.innerHTML = "";
      setStatus(
        `${t("status.needAuth")} <a href="${data.authUrl}">${t("link.connectAccount")}</a>`,
        "warn",
      );
      return;
    }

    state.data = data;
    if (!data.sites || data.sites.length === 0) {
      els.tbody.innerHTML = "";
      setStatus(t("status.noProperties"), "warn");
      return;
    }

    setStatus("", "info");
    render();
    const when = fmtWhen(data.generatedAt);
    els.meta.textContent = `${t("meta.summary", { count: data.sites.length, period: data.period, when })}${data.errors?.length ? t("meta.errorsSuffix", { count: data.errors.length }) : ""}`;
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

function toggleSort(th) {
  const key = th.dataset.sort;
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = key;
    state.sortDir = key === "name" ? "asc" : "desc";
  }
  render();
}

els.refresh.addEventListener("click", load);
els.period.addEventListener("change", load);
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

function renderInsights(data) {
  if (!data.configured) {
    insights.table.hidden = true;
    insights.tbody.innerHTML = "";
    insights.status.hidden = false;
    insights.status.className = "status warn";
    insights.status.innerHTML = t("insights.notConfigured");
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
  insights.tbody.innerHTML = sites
    .map((s) => {
      const l = s.latest ?? {};
      const when = fmtWhen(l.ts);
      return `<tr>
        <td class="name">${escapeHtml(s.displayName)}</td>
        <td class="num">${scoreCell(l.performance)}</td>
        <td class="num">${scoreCell(l.accessibility)}</td>
        <td class="num">${scoreCell(l.bestPractices)}</td>
        <td class="num">${scoreCell(l.seo)}</td>
        <td class="top">${when}</td>
        <td class="spark-cell">${sparkline(s.trend)}</td>
      </tr>`;
    })
    .join("");
  insights.meta.textContent = data.lastRunAt
    ? `${t("insights.lastMeasured", { when: fmtWhen(data.lastRunAt) })}${data.errors?.length ? t("insights.errorsSuffix", { count: data.errors.length }) : ""}`
    : "";
}

async function loadInsights() {
  try {
    const res = await fetch("/api/insights");
    const data = await res.json();
    renderInsights(data);
    if (data.isMeasuring && !insightsTimer) {
      insightsTimer = setInterval(loadInsights, 4000);
    } else if (!data.isMeasuring && insightsTimer) {
      clearInterval(insightsTimer);
      insightsTimer = null;
    }
  } catch (err) {
    insights.status.hidden = false;
    insights.status.className = "status error";
    insights.status.textContent = `${escapeHtml(err?.message ?? String(err))}`;
  }
}

insights.measure.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/insights/measure", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadInsights();
  } catch (err) {
    insights.status.hidden = false;
    insights.status.className = "status error";
    insights.status.textContent = err?.message ?? String(err);
  }
});

const settings = {
  view: document.getElementById("view-settings"),
  lang: document.getElementById("lang-select"),
  psiKey: document.getElementById("psi-key"),
  psiSave: document.getElementById("psi-save"),
  psiStatus: document.getElementById("psi-status"),
  credStatus: document.getElementById("cred-status"),
  versionCurrent: document.getElementById("version-current"),
  checkUpdate: document.getElementById("check-update"),
  updateRestart: document.getElementById("update-restart"),
  updateStatus: document.getElementById("update-status"),
  status: document.getElementById("settings-status"),
};

async function loadSettings() {
  const s = await (await fetch("/api/settings")).json();
  settings.lang.value = getLocale();
  settings.psiStatus.textContent = s.hasPsiKey ? t("settings.psiKeySet", { masked: s.psiKeyMasked }) : "";
  settings.credStatus.textContent = s.hasCredentials
    ? t("settings.credentialsFound")
    : t("settings.credentialsMissing");
  try {
    const v = await (await fetch("/api/version")).json();
    settings.versionCurrent.textContent = `v${v.current}`;
  } catch {}
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
  if (state.data) render();
  loadSettings();
  if (!views.performance.hidden) loadInsights();
}

tabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    const view = tab.dataset.view;
    views.traffic.hidden = view !== "traffic";
    views.performance.hidden = view !== "performance";
    settings.view.hidden = view !== "settings";
    if (view === "performance") loadInsights();
    if (view === "settings") loadSettings();
  }),
);

(async () => {
  let stored = null;
  try { stored = (await (await fetch("/api/settings")).json()).language; } catch {}
  if (!stored) { try { stored = localStorage.getItem("sitedeck.locale"); } catch {} }
  await initI18n(stored);
  document.documentElement.lang = getLocale();
  applyI18n();
  applyPeriodOptions();
  load();
})();
