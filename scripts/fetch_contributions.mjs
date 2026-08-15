// config/members.yaml に記載された GitHub アカウントの活動量（コミット/PR/Issue/レビュー）を
// GitHub GraphQL API (contributionsCollection) から取得し、docs/data/contributions.json に出力する。
//
// Web ダッシュボード側で「任意の期間」を選べるようにするため、履歴を月単位のバケットに分けて
// 種別（コミット/Issue/PR/レビュー）ごとの内訳を取得する（contributionsCollection の from/to は
// 1年までしか受け付けないため、月単位に区切れば必ず制限内に収まる）。
// 日次の合計値（種別内訳なし）は contributionCalendar からあわせて取得し、推移グラフに使う。
//
// 実行には GITHUB_TOKEN 環境変数が必要（public な contribution 情報の取得のみなので
// GitHub Actions のデフォルト GITHUB_TOKEN で動作する）。
//
// 使い方: GITHUB_TOKEN=xxxx node scripts/fetch_contributions.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "members.yaml");
const OUTPUT_PATH = path.join(ROOT, "docs", "data", "contributions.json");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN が設定されていません。");
  process.exit(1);
}

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const YEAR_WINDOW_DAYS = 365; // リポジトリ内訳集計用の最大ウィンドウ（GraphQL制限）

function monthStartUTC(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// [from, to) の範囲を暦月単位のバケットに分割する。
function buildMonthBuckets(fromDate, toDate) {
  const buckets = [];
  let cursor = monthStartUTC(fromDate);
  while (cursor < toDate) {
    const nextMonth = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)
    );
    const bucketFrom = cursor < fromDate ? fromDate : cursor;
    const bucketTo = nextMonth < toDate ? nextMonth : toDate;
    buckets.push({ key: monthKey(cursor), from: bucketFrom, to: bucketTo });
    cursor = nextMonth;
  }
  return buckets;
}

// [from, to) の範囲を最大1年ごとのウィンドウに分割する（リポジトリ内訳集計用）。
function buildYearWindows(fromDate, toDate) {
  const windows = [];
  let cursor = new Date(fromDate);
  while (cursor < toDate) {
    const windowEnd = new Date(
      Math.min(
        cursor.getTime() + YEAR_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        toDate.getTime()
      )
    );
    windows.push({ from: new Date(cursor), to: windowEnd });
    cursor = windowEnd;
  }
  return windows;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GitHub の GraphQL API は、大きなクエリを短間隔で連続実行すると二次レート制限
// (secondary rate limit / abuse detection, HTTP 403) を返すことがあるため、
// リクエスト間に間隔を空け、403発生時は指数バックオフで再試行する。
const REQUEST_INTERVAL_MS = 1500;
const MAX_RETRIES = 5;

async function graphql(query, variables) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "CommitForge4furuhashilab",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 403 || res.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`HTTP ${res.status} (retries exhausted)`);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = retryAfter > 0
        ? retryAfter * 1000
        : REQUEST_INTERVAL_MS * 2 ** attempt;
      await sleep(waitMs);
      continue;
    }

    const body = await res.json();
    if (!res.ok || body.errors) {
      const message = body.errors
        ? body.errors.map((e) => e.message).join("; ")
        : `HTTP ${res.status}`;
      throw new Error(message);
    }
    await sleep(REQUEST_INTERVAL_MS);
    return body.data;
  }
}

function buildMonthlyQuery(buckets) {
  const fields = buckets
    .map(
      (b, i) => `
    m${i}: contributionsCollection(from: "${b.from.toISOString()}", to: "${b.to.toISOString()}") {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      contributionCalendar {
        weeks { contributionDays { date contributionCount } }
      }
    }`
    )
    .join("\n");
  return `query($login: String!) { user(login: $login) {\n${fields}\n} }`;
}

function buildRepoQuery(windows) {
  const fields = windows
    .map(
      (w, i) => `
    y${i}: contributionsCollection(from: "${w.from.toISOString()}", to: "${w.to.toISOString()}") {
      commitContributionsByRepository(maxRepositories: 25) {
        repository { nameWithOwner }
        contributions { totalCount }
      }
    }`
    )
    .join("\n");
  return `query($login: String!) { user(login: $login) {\n${fields}\n} }`;
}

async function fetchMemberContributions(login, historyStart, now) {
  const monthBuckets = buildMonthBuckets(historyStart, now);
  const yearWindows = buildYearWindows(historyStart, now);

  const monthlyData = await graphql(buildMonthlyQuery(monthBuckets), {
    login,
  });
  if (!monthlyData.user) {
    throw new Error("user not found");
  }

  const monthly = [];
  const dailyMap = new Map(); // date -> count（種別内訳なしの合計値）
  const totals = { commits: 0, issues: 0, pullRequests: 0, reviews: 0 };

  monthBuckets.forEach((bucket, i) => {
    const cc = monthlyData.user[`m${i}`];
    const commits = cc.totalCommitContributions;
    const issues = cc.totalIssueContributions;
    const pullRequests = cc.totalPullRequestContributions;
    const reviews = cc.totalPullRequestReviewContributions;

    monthly.push({ month: bucket.key, commits, issues, pullRequests, reviews });
    totals.commits += commits;
    totals.issues += issues;
    totals.pullRequests += pullRequests;
    totals.reviews += reviews;

    for (const week of cc.contributionCalendar.weeks) {
      for (const day of week.contributionDays) {
        if (day.contributionCount === 0) continue;
        dailyMap.set(
          day.date,
          (dailyMap.get(day.date) ?? 0) + day.contributionCount
        );
      }
    }
  });

  const repoData = await graphql(buildRepoQuery(yearWindows), { login });
  const repoCounts = new Map();
  yearWindows.forEach((_, i) => {
    const cc = repoData.user[`y${i}`];
    for (const entry of cc.commitContributionsByRepository) {
      const name = entry.repository.nameWithOwner;
      repoCounts.set(
        name,
        (repoCounts.get(name) ?? 0) + entry.contributions.totalCount
      );
    }
  });

  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, count]) => ({ date, count }));

  const topRepositories = [...repoCounts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  return { totals, monthly, daily, topRepositories };
}

async function main() {
  const configRaw = await fs.readFile(CONFIG_PATH, "utf8");
  const config = yaml.load(configRaw);
  const { settings, members } = config;
  const historyStart = new Date(`${settings.history_start}T00:00:00Z`);
  const now = new Date();

  console.log(
    `対象アカウント: ${members.length}件 / 取得期間: ${settings.history_start} 〜 ${now.toISOString().slice(0, 10)}`
  );

  const results = [];
  const errors = [];

  for (const member of members) {
    process.stdout.write(`取得中: ${member.login} ... `);
    try {
      const data = await fetchMemberContributions(
        member.login,
        historyStart,
        now
      );
      results.push({
        login: member.login,
        name: member.name ?? null,
        ...data,
      });
      console.log(`OK (commits=${data.totals.commits})`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      errors.push({ login: member.login, message: err.message });
    }
  }

  const output = {
    generated_at: now.toISOString(),
    history_start: settings.history_start,
    settings: {
      default_period: settings.default_period,
      academic_year_start_month: settings.academic_year_start_month,
      academic_year_start_day: settings.academic_year_start_day,
    },
    member_count_configured: members.length,
    member_count_fetched: results.length,
    members: results,
    errors,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log(
    `\n完了: ${results.length}/${members.length} 件取得成功 (${errors.length}件エラー)`
  );
  console.log(`出力先: ${path.relative(ROOT, OUTPUT_PATH)}`);

  if (errors.length > 0) {
    console.log("エラー詳細:", JSON.stringify(errors, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
