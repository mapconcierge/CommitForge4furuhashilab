(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  // score算出に使う8項目。weightKeyはconfig/members.yamlのsettings.scoringに対応。
  // rawはメンバーの集計済みデータから素の件数(またはlog1p前の合計)を取り出す関数。
  // logScale=trueの項目はlog1p(raw)にweightを掛ける(スター・フォークの偏りを抑えるため)。
  const CATEGORIES = [
    { key: "commits", label: "コミット", varName: "--series-commit", weightKey: "commit", unit: "件", raw: (m) => m.totals.commits },
    { key: "pullRequests", label: "プルリクエスト", varName: "--series-pr", weightKey: "pull_request", unit: "件", raw: (m) => m.totals.pullRequests },
    { key: "issues", label: "Issue", varName: "--series-issue", weightKey: "issue", unit: "件", raw: (m) => m.totals.issues },
    { key: "reviews", label: "レビュー", varName: "--series-review", weightKey: "review", unit: "件", raw: (m) => m.totals.reviews },
    { key: "reposCreated", label: "新規リポジトリ", varName: "--series-repo-created", weightKey: "repo_created", unit: "件", raw: (m) => m.reposCreated },
    { key: "reposActive", label: "活動リポジトリ", varName: "--series-repo-active", weightKey: "repo_active", unit: "件", raw: (m) => m.reposActive },
    { key: "stars", label: "獲得スター", varName: "--series-star", weightKey: "star", unit: "件", raw: (m) => m.starsSum, logScale: true },
    { key: "forks", label: "獲得フォーク", varName: "--series-fork", weightKey: "fork", unit: "件", raw: (m) => m.forksSum, logScale: true },
  ];

  const state = {
    data: null,
    fromKey: null, // "YYYY-MM"
    toKey: null,
    activePreset: "academic_year",
  };

  // ---------- date / month-key helpers ----------

  function toMonthKey(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function monthKeyToDate(key) {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1));
  }

  function lastDayOfMonthStr(key) {
    const [y, m] = key.split("-").map(Number);
    const d = new Date(Date.UTC(y, m, 0));
    return d.toISOString().slice(0, 10);
  }

  function firstDayOfMonthStr(key) {
    const [y, m] = key.split("-").map(Number);
    return `${y}-${String(m).padStart(2, "0")}-01`;
  }

  function dateToInputValue(date) {
    return date.toISOString().slice(0, 10);
  }

  function academicYearRange(today, startMonth, startDay) {
    const y = today.getUTCFullYear();
    const thisStart = new Date(Date.UTC(y, startMonth - 1, startDay));
    const start = today >= thisStart
      ? thisStart
      : new Date(Date.UTC(y - 1, startMonth - 1, startDay));
    const end = new Date(Date.UTC(start.getUTCFullYear() + 1, startMonth - 1, startDay - 1));
    return { start, end };
  }

  function clampKey(key, minKey, maxKey) {
    if (key < minKey) return minKey;
    if (key > maxKey) return maxKey;
    return key;
  }

  // ---------- nice ticks ----------

  function niceNumber(range, round) {
    const exponent = Math.floor(Math.log10(range || 1));
    const fraction = range / Math.pow(10, exponent);
    let niceFraction;
    if (round) {
      if (fraction < 1.5) niceFraction = 1;
      else if (fraction < 3) niceFraction = 2;
      else if (fraction < 7) niceFraction = 5;
      else niceFraction = 10;
    } else {
      if (fraction <= 1) niceFraction = 1;
      else if (fraction <= 2) niceFraction = 2;
      else if (fraction <= 5) niceFraction = 5;
      else niceFraction = 10;
    }
    return niceFraction * Math.pow(10, exponent);
  }

  function niceTicks(maxValue, tickCount = 4) {
    if (maxValue <= 0) return { niceMax: 1, ticks: [0, 1] };
    const range = niceNumber(maxValue, false);
    const step = niceNumber(range / Math.max(tickCount - 1, 1), true);
    const niceMax = Math.ceil(maxValue / step) * step;
    const ticks = [];
    for (let v = 0; v <= niceMax + 1e-9; v += step) ticks.push(Math.round(v));
    return { niceMax, ticks };
  }

  // ---------- SVG helpers ----------

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function roundedRightPath(x, y, w, h, r) {
    const rr = Math.min(r, w, h / 2);
    if (w <= 0) return "";
    return [
      `M ${x} ${y}`,
      `H ${x + w - rr}`,
      `Q ${x + w} ${y} ${x + w} ${y + rr}`,
      `V ${y + h - rr}`,
      `Q ${x + w} ${y + h} ${x + w - rr} ${y + h}`,
      `H ${x}`,
      "Z",
    ].join(" ");
  }

  function seriesColor(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  // ---------- tooltip ----------

  const tooltipEl = document.getElementById("tooltip");

  function showTooltip(clientX, clientY, titleText, rows) {
    tooltipEl.textContent = "";
    const title = document.createElement("div");
    title.className = "t-title";
    title.textContent = titleText;
    tooltipEl.appendChild(title);
    for (const row of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "t-row";
      const keyEl = document.createElement("span");
      keyEl.className = "t-key";
      if (row.color) {
        const sw = document.createElement("span");
        sw.className = "t-swatch";
        sw.style.background = row.color;
        keyEl.appendChild(sw);
      }
      keyEl.appendChild(document.createTextNode(row.label));
      const valEl = document.createElement("span");
      valEl.textContent = row.value;
      rowEl.appendChild(keyEl);
      rowEl.appendChild(valEl);
      tooltipEl.appendChild(rowEl);
    }
    tooltipEl.style.left = `${clientX}px`;
    tooltipEl.style.top = `${clientY}px`;
    tooltipEl.classList.add("visible");
  }

  function hideTooltip() {
    tooltipEl.classList.remove("visible");
  }

  // ---------- data aggregation ----------

  function aggregateForRange(data, fromKey, toKey) {
    const weights = data.settings.scoring;
    const fromDateStr = firstDayOfMonthStr(fromKey);
    const toDateStr = lastDayOfMonthStr(toKey);

    const perMember = data.members.map((m) => {
      const totals = { commits: 0, issues: 0, pullRequests: 0, reviews: 0 };
      // 活動リポジトリ = このメンバーが選択期間内にコミットした形跡があるリポジトリの集合。
      // 個人名義リポジトリの「最終push日時」(pushedAtベース、フォーク含む)と、
      // 月次コミット内訳(monthly[].repos、個人名義/Organization名義どちらも含む)の
      // 両方を突き合わせて和集合を取る。前者はGitHubの公式contribution集計が拾わない
      // フォーク上の作業を補うため、後者は共同開発中でreposCreatedには帰属しない
      // Organizationリポジトリでの活動を取りこぼさないため。
      const activeRepoNames = new Set();
      for (const bucket of m.monthly) {
        if (bucket.month < fromKey || bucket.month > toKey) continue;
        totals.commits += bucket.commits;
        totals.issues += bucket.issues;
        totals.pullRequests += bucket.pullRequests;
        totals.reviews += bucket.reviews;
        for (const r of bucket.repos ?? []) activeRepoNames.add(r.name);
      }

      const repos = m.repos ?? [];
      const createdInPeriod = repos.filter(
        (r) => !r.isFork && r.createdAt >= fromDateStr && r.createdAt <= toDateStr
      );
      const reposCreated = createdInPeriod.length;
      for (const r of repos) {
        if (r.pushedAt >= fromDateStr && r.pushedAt <= toDateStr) activeRepoNames.add(r.name);
      }
      const reposActive = activeRepoNames.size;
      const starsSum = createdInPeriod.reduce((s, r) => s + r.stars, 0);
      const forksSum = createdInPeriod.reduce((s, r) => s + r.forks, 0);

      const member = { login: m.login, name: m.name, totals, reposCreated, reposActive, starsSum, forksSum };

      const points = {};
      let score = 0;
      for (const c of CATEGORIES) {
        const rawValue = c.raw(member);
        const scaledValue = c.logScale ? Math.log1p(rawValue) : rawValue;
        const pts = scaledValue * (weights[c.weightKey] ?? 0);
        points[c.key] = pts;
        score += pts;
      }

      member.points = points;
      member.score = score;
      return member;
    });

    perMember.sort((a, b) => b.score - a.score);

    const overall = { commits: 0, issues: 0, pullRequests: 0, reviews: 0, reposCreated: 0, reposActive: 0, starsSum: 0, forksSum: 0, score: 0 };
    for (const m of perMember) {
      overall.commits += m.totals.commits;
      overall.issues += m.totals.issues;
      overall.pullRequests += m.totals.pullRequests;
      overall.reviews += m.totals.reviews;
      overall.reposCreated += m.reposCreated;
      overall.reposActive += m.reposActive;
      overall.starsSum += m.starsSum;
      overall.forksSum += m.forksSum;
      overall.score += m.score;
    }

    const dailyMap = new Map();
    for (const m of data.members) {
      for (const d of m.daily) {
        if (d.date < fromDateStr || d.date > toDateStr) continue;
        dailyMap.set(d.date, (dailyMap.get(d.date) ?? 0) + d.count);
      }
    }
    const daily = [...dailyMap.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, count]) => ({ date, count }));

    return { perMember, overall, daily, fromDate: fromDateStr, toDate: toDateStr };
  }

  // ---------- rendering: stat tiles ----------

  function renderStatTiles(overall, memberCount) {
    const tiles = [
      { label: "対象人数", value: memberCount, cls: "" },
      { label: "コミット", value: overall.commits, cls: "commit" },
      { label: "プルリクエスト", value: overall.pullRequests, cls: "pr" },
      { label: "Issue", value: overall.issues, cls: "issue" },
      { label: "レビュー", value: overall.reviews, cls: "review" },
      { label: "新規リポジトリ", value: overall.reposCreated, cls: "repo-created" },
      { label: "活動リポジトリ(fork含む)", value: overall.reposActive, cls: "repo-active" },
      { label: "獲得スター", value: overall.starsSum, cls: "star" },
      { label: "獲得フォーク", value: overall.forksSum, cls: "fork" },
      { label: "総合スコア合計", value: Math.round(overall.score), cls: "score" },
    ];
    const container = document.getElementById("stat-tiles");
    container.textContent = "";
    for (const t of tiles) {
      const div = document.createElement("div");
      div.className = `stat-tile ${t.cls}`.trim();
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = t.label;
      const value = document.createElement("div");
      value.className = "value";
      value.textContent = t.value.toLocaleString("ja-JP");
      div.appendChild(label);
      div.appendChild(value);
      container.appendChild(div);
    }
  }

  // ---------- rendering: legend ----------

  function renderLegend() {
    const container = document.getElementById("bar-legend");
    container.textContent = "";
    for (const c of CATEGORIES) {
      const item = document.createElement("span");
      item.className = "item";
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = `var(${c.varName})`;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(c.label));
      container.appendChild(item);
    }
  }

  // ---------- rendering: bar chart ----------

  function renderBarChart(perMember) {
    const svg = document.getElementById("bar-chart");
    svg.textContent = "";

    const width = 880;
    const marginLeft = 170;
    const marginRight = 56;
    const rowHeight = 30;
    const barHeight = 20;
    const topPad = 8;
    const axisHeight = 26;
    const plotWidth = width - marginLeft - marginRight;
    const height = topPad + perMember.length * rowHeight + axisHeight;

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const maxScore = Math.max(1, ...perMember.map((m) => m.score));
    const { niceMax, ticks } = niceTicks(maxScore, 4);
    const xScale = (v) => (v / niceMax) * plotWidth;

    const axisY = topPad + perMember.length * rowHeight;

    // gridlines
    for (const t of ticks) {
      const x = marginLeft + xScale(t);
      svg.appendChild(svgEl("line", {
        class: "gridline", x1: x, x2: x, y1: topPad, y2: axisY,
      }));
      const label = svgEl("text", {
        class: "axis", x, y: axisY + 16, "text-anchor": "middle",
      });
      label.textContent = t.toLocaleString("ja-JP");
      svg.appendChild(label);
    }

    const colors = Object.fromEntries(CATEGORIES.map((c) => [c.key, seriesColor(c.varName)]));

    perMember.forEach((m, i) => {
      const rowY = topPad + i * rowHeight;
      const barY = rowY + (rowHeight - barHeight) / 2;

      const nameLabel = svgEl("text", {
        class: "member-label", x: marginLeft - 10, y: barY + barHeight / 2 + 4,
        "text-anchor": "end",
      });
      nameLabel.textContent = m.name ? m.name : m.login;
      svg.appendChild(nameLabel);

      const totalWidth = xScale(m.score);

      if (totalWidth > 0) {
        const clipId = `bar-clip-${i}`;
        const clipPath = svgEl("clipPath", { id: clipId });
        clipPath.appendChild(svgEl("path", {
          d: roundedRightPath(marginLeft, barY, totalWidth, barHeight, 4),
        }));
        svg.appendChild(clipPath);

        const g = svgEl("g", { "clip-path": `url(#${clipId})` });
        let cx = marginLeft;
        CATEGORIES.forEach((c) => {
          const v = m.points[c.key];
          if (v <= 0) return;
          const segW = xScale(v);
          g.appendChild(svgEl("rect", {
            x: cx, y: barY, width: segW, height: barHeight, fill: colors[c.key],
          }));
          cx += segW;
        });
        svg.appendChild(g);

        // 2px surface gaps between segments (drawn on top of the clipped fills)
        cx = marginLeft;
        const activeCats = CATEGORIES.filter((c) => m.points[c.key] > 0);
        activeCats.forEach((c, idx) => {
          const segW = xScale(m.points[c.key]);
          cx += segW;
          if (idx < activeCats.length - 1) {
            svg.appendChild(svgEl("rect", {
              x: cx - 1, y: barY, width: 2, height: barHeight,
              fill: "var(--surface-1)",
            }));
          }
        });
      }

      const totalLabel = svgEl("text", {
        class: "bar-total-label", x: marginLeft + totalWidth + 8, y: barY + barHeight / 2 + 4,
      });
      totalLabel.textContent = Math.round(m.score).toLocaleString("ja-JP");
      svg.appendChild(totalLabel);

      const tooltipRows = () => CATEGORIES.map((c) => ({
        label: c.label,
        value: `${c.raw(m).toLocaleString("ja-JP")}${c.unit} (${Math.round(m.points[c.key] * 10) / 10}pt)`,
        color: colors[c.key],
      })).concat([{ label: "総合スコア", value: Math.round(m.score).toLocaleString("ja-JP") }]);

      const hit = svgEl("rect", {
        class: "hit-rect", x: 0, y: rowY, width, height: rowHeight,
        tabindex: "0", role: "img",
        "aria-label": `${m.name ?? m.login}: 総合スコア ${Math.round(m.score)}`,
      });
      hit.addEventListener("pointermove", (ev) => {
        showTooltip(ev.clientX, ev.clientY, m.name ? `${m.name} (${m.login})` : m.login, tooltipRows());
      });
      hit.addEventListener("pointerleave", hideTooltip);
      hit.addEventListener("focus", () => {
        const rect = hit.getBoundingClientRect();
        showTooltip(rect.left + rect.width / 2, rect.top, m.name ? `${m.name} (${m.login})` : m.login, tooltipRows());
      });
      hit.addEventListener("blur", hideTooltip);
      svg.appendChild(hit);
    });
  }

  // ---------- rendering: trend chart ----------

  function bucketDaily(daily, granularity) {
    if (granularity === "day") return daily.map((d) => ({ key: d.date, value: d.count }));
    const map = new Map();
    for (const d of daily) {
      const dt = new Date(`${d.date}T00:00:00Z`);
      const weekStart = new Date(dt);
      const dow = (dt.getUTCDay() + 6) % 7; // Monday=0
      weekStart.setUTCDate(dt.getUTCDate() - dow);
      const key = weekStart.toISOString().slice(0, 10);
      map.set(key, (map.get(key) ?? 0) + d.count);
    }
    return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value }));
  }

  function fillDailyGaps(daily, fromDate, toDate) {
    const map = new Map(daily.map((d) => [d.date, d.count]));
    const out = [];
    let cursor = new Date(`${fromDate}T00:00:00Z`);
    const end = new Date(`${toDate}T00:00:00Z`);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      out.push({ date: key, count: map.get(key) ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
  }

  function renderTrendChart(daily, fromDate, toDate) {
    const svg = document.getElementById("trend-chart");
    const caption = document.getElementById("trend-caption");
    svg.textContent = "";

    const filled = fillDailyGaps(daily, fromDate, toDate);
    const spanDays = filled.length;
    const granularity = spanDays > 120 ? "week" : "day";
    const points = bucketDaily(filled, granularity);
    caption.textContent = granularity === "week"
      ? "選択期間内の全メンバー合計（週次集計）"
      : "選択期間内の全メンバー合計（日次）";

    const width = 880;
    const marginLeft = 44;
    const marginRight = 12;
    const marginTop = 10;
    const axisHeight = 24;
    const plotWidth = width - marginLeft - marginRight;
    const height = 220;
    const plotHeight = height - marginTop - axisHeight;

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    if (points.length === 0) {
      const empty = svgEl("text", { class: "axis", x: width / 2, y: height / 2, "text-anchor": "middle" });
      empty.textContent = "データがありません";
      svg.appendChild(empty);
      return;
    }

    const maxValue = Math.max(1, ...points.map((p) => p.value));
    const { niceMax, ticks } = niceTicks(maxValue, 4);
    const yScale = (v) => marginTop + plotHeight - (v / niceMax) * plotHeight;
    const xScale = (i) => marginLeft + (points.length === 1 ? 0 : (i / (points.length - 1)) * plotWidth);

    const axisY = marginTop + plotHeight;
    for (const t of ticks) {
      const y = yScale(t);
      svg.appendChild(svgEl("line", { class: "gridline", x1: marginLeft, x2: width - marginRight, y1: y, y2: y }));
      const label = svgEl("text", { class: "axis", x: marginLeft - 8, y: y + 3, "text-anchor": "end" });
      label.textContent = t.toLocaleString("ja-JP");
      svg.appendChild(label);
    }

    const tickCount = Math.min(6, points.length);
    for (let i = 0; i < tickCount; i++) {
      const idx = Math.round((i / Math.max(tickCount - 1, 1)) * (points.length - 1));
      const x = xScale(idx);
      const label = svgEl("text", { class: "axis", x, y: axisY + 16, "text-anchor": "middle" });
      label.textContent = points[idx].key.slice(2); // YY-MM-DD
      svg.appendChild(label);
    }

    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(p.value)}`).join(" ");
    const areaPath = `${linePath} L ${xScale(points.length - 1)} ${axisY} L ${xScale(0)} ${axisY} Z`;

    svg.appendChild(svgEl("path", { class: "trend-area", d: areaPath }));
    svg.appendChild(svgEl("path", { class: "trend-line", d: linePath }));

    const crosshairLine = svgEl("line", { class: "crosshair-line", y1: marginTop, y2: axisY });
    const crosshairDot = svgEl("circle", { class: "crosshair-dot", r: 4 });
    svg.appendChild(crosshairLine);
    svg.appendChild(crosshairDot);

    const overlay = svgEl("rect", {
      x: marginLeft, y: marginTop, width: plotWidth, height: plotHeight,
      fill: "transparent", style: "cursor: crosshair;",
    });

    function handleMove(clientX, svgRectLeft, svgScale) {
      const localX = (clientX - svgRectLeft) / svgScale;
      let idx = Math.round(((localX - marginLeft) / plotWidth) * (points.length - 1));
      idx = Math.max(0, Math.min(points.length - 1, idx));
      const p = points[idx];
      const x = xScale(idx);
      const y = yScale(p.value);
      crosshairLine.setAttribute("x1", x);
      crosshairLine.setAttribute("x2", x);
      crosshairLine.style.display = "block";
      crosshairDot.setAttribute("cx", x);
      crosshairDot.setAttribute("cy", y);
      crosshairDot.style.display = "block";
      return { p, x, y };
    }

    overlay.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / width;
      const { p } = handleMove(ev.clientX, rect.left, scale);
      const dateLabel = granularity === "week" ? `${p.key} の週` : p.key;
      showTooltip(ev.clientX, ev.clientY, dateLabel, [
        { label: "合計アクティビティ", value: p.value.toLocaleString("ja-JP"), color: seriesColor("--series-commit") },
      ]);
    });
    overlay.addEventListener("pointerleave", () => {
      crosshairLine.style.display = "none";
      crosshairDot.style.display = "none";
      hideTooltip();
    });
    svg.appendChild(overlay);
  }

  // ---------- rendering: table ----------

  function renderTable(perMember) {
    const tbody = document.getElementById("data-table-body");
    tbody.textContent = "";
    for (const m of perMember) {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      const a = document.createElement("a");
      a.href = `https://github.com/${m.login}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = m.name ? `${m.name} (${m.login})` : m.login;
      nameTd.appendChild(a);
      tr.appendChild(nameTd);

      for (const c of CATEGORIES) {
        const td = document.createElement("td");
        td.textContent = c.raw(m).toLocaleString("ja-JP");
        tr.appendChild(td);
      }

      const scoreTd = document.createElement("td");
      scoreTd.textContent = Math.round(m.score).toLocaleString("ja-JP");
      tr.appendChild(scoreTd);

      tbody.appendChild(tr);
    }
  }

  // ---------- top-level render ----------

  function render() {
    const { data, fromKey, toKey } = state;
    const agg = aggregateForRange(data, fromKey, toKey);

    renderStatTiles(agg.overall, agg.perMember.length);
    renderLegend();
    renderBarChart(agg.perMember);
    renderTrendChart(agg.daily, agg.fromDate, agg.toDate);
    renderTable(agg.perMember);

    document.getElementById("range-note").textContent =
      `集計期間: ${agg.fromDate} 〜 ${agg.toDate}（月単位で集計。実際に取得済みのデータの範囲にあわせて調整されます）`;
  }

  function setRangeFromKeys(fromKey, toKey) {
    const { data } = state;
    const minKey = toMonthKey(new Date(`${data.history_start}T00:00:00Z`));
    const maxKey = toMonthKey(new Date(data.generated_at));
    state.fromKey = clampKey(fromKey, minKey, maxKey);
    state.toKey = clampKey(toKey, minKey, maxKey);
    document.getElementById("range-from").value = firstDayOfMonthStr(state.fromKey);
    document.getElementById("range-to").value = lastDayOfMonthStr(state.toKey);
    render();
  }

  function applyPreset(preset) {
    state.activePreset = preset;
    document.querySelectorAll("button.preset[data-preset]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.preset === preset));
    });

    const { data } = state;
    const now = new Date(data.generated_at);

    if (preset === "academic_year") {
      const { start, end } = academicYearRange(
        now, data.settings.academic_year_start_month, data.settings.academic_year_start_day
      );
      setRangeFromKeys(toMonthKey(start), toMonthKey(end));
    } else if (preset === "all") {
      setRangeFromKeys(
        toMonthKey(new Date(`${data.history_start}T00:00:00Z`)),
        toMonthKey(now)
      );
    }
  }

  function wireUpControls() {
    document.querySelectorAll("button.preset[data-preset]").forEach((b) => {
      b.addEventListener("click", () => applyPreset(b.dataset.preset));
    });
    document.getElementById("apply-range").addEventListener("click", () => {
      state.activePreset = null;
      document.querySelectorAll("button.preset[data-preset]").forEach((b) => b.setAttribute("aria-pressed", "false"));
      const fromVal = document.getElementById("range-from").value;
      const toVal = document.getElementById("range-to").value;
      if (!fromVal || !toVal) return;
      setRangeFromKeys(toMonthKey(new Date(`${fromVal}T00:00:00Z`)), toMonthKey(new Date(`${toVal}T00:00:00Z`)));
    });
  }

  async function init() {
    let data;
    try {
      const res = await fetch("data/contributions.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      document.getElementById("meta-line").textContent = "データの読み込みに失敗しました。";
      const banner = document.getElementById("error-banner");
      banner.className = "error-banner";
      banner.textContent = `data/contributions.json の取得に失敗しました: ${err.message}`;
      return;
    }

    state.data = data;

    const generatedLocal = new Date(data.generated_at).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short",
    });
    document.getElementById("meta-line").textContent =
      `最終更新: ${generatedLocal} (JST) ・ 集計対象 ${data.member_count_fetched}/${data.member_count_configured} アカウント ・ 履歴取得開始日: ${data.history_start}`;

    if (data.errors && data.errors.length > 0) {
      const banner = document.getElementById("error-banner");
      banner.className = "error-banner";
      banner.textContent =
        `${data.errors.length}件のアカウントでデータ取得に失敗しました（${data.errors.map((e) => e.login).join(", ")}）。集計結果には反映されていません。`;
    }

    wireUpControls();
    applyPreset("academic_year");
  }

  init();
})();
