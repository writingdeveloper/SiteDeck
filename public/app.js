// SiteDeck dashboard front-end. Plain JS, no build step.
// Talks to GET /api/summary?period=7|28|90.

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
  return typeof n === "number" ? n.toLocaleString("ko-KR") : "—";
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
    th.classList.toggle("sorted", key === state.sortKey);
    if (key === state.sortKey) th.dataset.dir = state.sortDir;
    else th.removeAttribute("data-dir");
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
  setStatus("불러오는 중…", "info");
  els.table.hidden = true;
  els.meta.textContent = "";
  try {
    const res = await fetch(`/api/summary?period=${period}`);
    const data = await res.json();

    if (data.error) {
      state.data = null;
      els.tbody.innerHTML = "";
      setStatus(
        `불러오기 오류: ${escapeHtml(data.error)} · <a href="/oauth/start">재연결</a>`,
        "error",
      );
      return;
    }

    if (!data.authenticated) {
      state.data = null;
      els.tbody.innerHTML = "";
      setStatus(
        `Google 계정 연결이 필요합니다. <a href="${data.authUrl}">계정 연결하기</a>`,
        "warn",
      );
      return;
    }

    state.data = data;
    if (!data.sites || data.sites.length === 0) {
      els.tbody.innerHTML = "";
      setStatus("접근 가능한 GA4 속성이 없습니다.", "warn");
      return;
    }

    setStatus("", "info");
    render();
    const when = new Date(data.generatedAt).toLocaleString("ko-KR");
    const errNote = data.errors?.length ? ` · ${data.errors.length}개 속성 오류` : "";
    els.meta.textContent = `${data.sites.length}개 사이트 · 최근 ${data.period}일 · ${when}${errNote}`;
  } catch (err) {
    setStatus(
      `불러오기 실패: ${escapeHtml(err?.message ?? String(err))} · <a href="/oauth/start">재연결</a>`,
      "error",
    );
  }
}

els.refresh.addEventListener("click", load);
els.period.addEventListener("change", load);
els.headers.forEach((th) =>
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = key === "name" ? "asc" : "desc";
    }
    render();
  }),
);

load();

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
    insights.status.innerHTML =
      "PageSpeed API 키가 설정되지 않았습니다. <code>~/.sitedeck/config.json</code>의 <code>psiApiKey</code>를 설정하세요.";
    return;
  }
  const sites = data.sites ?? [];
  insights.table.hidden = sites.length === 0;
  insights.status.hidden = sites.length > 0 && !data.isMeasuring;
  if (data.isMeasuring) {
    insights.status.hidden = false;
    insights.status.className = "status info";
    insights.status.textContent = "측정 중…";
  } else if (sites.length === 0) {
    insights.status.className = "status info";
    insights.status.textContent = "아직 측정 결과가 없습니다. '지금 측정'을 눌러 시작하세요.";
  }
  insights.tbody.innerHTML = sites
    .map((s) => {
      const l = s.latest ?? {};
      const when = l.ts ? new Date(l.ts).toLocaleString("ko-KR") : "—";
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
  const errNote = data.errors?.length ? ` · ${data.errors.length}개 오류` : "";
  insights.meta.textContent = data.lastRunAt
    ? `마지막 측정 ${new Date(data.lastRunAt).toLocaleString("ko-KR")}${errNote}`
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
    insights.status.textContent = `불러오기 실패: ${escapeHtml(err?.message ?? String(err))}`;
  }
}

insights.measure.addEventListener("click", async () => {
  await fetch("/api/insights/measure", { method: "POST" });
  loadInsights();
});

tabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    const view = tab.dataset.view;
    views.traffic.hidden = view !== "traffic";
    views.performance.hidden = view !== "performance";
    if (view === "performance") loadInsights();
  }),
);
