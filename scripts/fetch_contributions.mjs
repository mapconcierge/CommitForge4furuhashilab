// config/members.yaml に記載された GitHub アカウントの活動量（コミット/PR/Issue/レビュー）を
// GitHub GraphQL API (contributionsCollection) から取得し、docs/data/contributions.json に出力する。
//
// Web ダッシュボード側で「任意の期間」を選べるようにするため、履歴を月単位のバケットに分けて
// 種別（コミット/Issue/PR/レビュー）ごとの内訳を取得する（contributionsCollection の from/to は
// 1年までしか受け付けないため、月単位に区切れば必ず制限内に収まる）。
// 日次の合計値（種別内訳なし）は contributionCalendar からあわせて取得し、推移グラフに使う。
// 月次バケットごとに commitContributionsByRepository も取得し、どのリポジトリ（個人名義/
// Organization名義、フォーク含む）にコミットしたかを保持する。これは「活動リポジトリ数」の
// 算出と、settings.organizations 配下リポジトリの作成者推定の両方に使う。
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
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner }
        contributions { totalCount }
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

const OWNED_REPOS_QUERY = `
query($login: String!, $cursor: String) {
  user(login: $login) {
    repositories(first: 100, ownerAffiliations: OWNER, privacy: PUBLIC, orderBy: {field: PUSHED_AT, direction: DESC}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner
        isFork
        stargazerCount
        forkCount
        createdAt
        pushedAt
      }
    }
  }
}
`;

// 所有している公開リポジトリを「最終 push が新しい順」に取得し、historyStart より
// 古い push しかない（＝それより前のページも全て historyStart より古い）ページに
// 到達した時点で打ち切る。フォークも含めて全件保持する — GitHub の公式 contribution
// 集計はフォーク上の作業を基本的にカウントしないため、その欠落を score 算出側で
// 補うのに使う（config/members.yaml の repo_active を参照）。
async function fetchOwnedRepositories(login, historyStart) {
  const repos = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const data = await graphql(OWNED_REPOS_QUERY, { login, cursor });
    const conn = data.user.repositories;
    for (const n of conn.nodes) {
      repos.push({
        name: n.nameWithOwner,
        isFork: n.isFork,
        stars: n.stargazerCount,
        forks: n.forkCount,
        createdAt: n.createdAt.slice(0, 10),
        pushedAt: n.pushedAt.slice(0, 10),
      });
    }
    const lastPushedAt = conn.nodes.length > 0
      ? new Date(conn.nodes[conn.nodes.length - 1].pushedAt)
      : null;
    if (!conn.pageInfo.hasNextPage || !lastPushedAt || lastPushedAt < historyStart) {
      break;
    }
    cursor = conn.pageInfo.endCursor;
  }
  return repos;
}

const ORG_REPOS_QUERY = `
query($org: String!, $cursor: String) {
  organization(login: $org) {
    repositories(first: 100, privacy: PUBLIC, isFork: false, orderBy: {field: CREATED_AT, direction: DESC}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner
        stargazerCount
        forkCount
        createdAt
        pushedAt
      }
    }
  }
}
`;

// Organization配下の非フォーク公開リポジトリを「作成日が新しい順」に取得し、
// historyStart より古い作成日のページに到達した時点で打ち切る。
async function fetchOrgRepositories(org, historyStart) {
  const repos = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const data = await graphql(ORG_REPOS_QUERY, { org, cursor });
    if (!data.organization) {
      throw new Error(`organization not found: ${org}`);
    }
    const conn = data.organization.repositories;
    for (const n of conn.nodes) {
      const createdAt = new Date(n.createdAt);
      if (createdAt < historyStart) continue;
      repos.push({
        name: n.nameWithOwner,
        isFork: false,
        stars: n.stargazerCount,
        forks: n.forkCount,
        createdAt: n.createdAt.slice(0, 10),
        pushedAt: n.pushedAt.slice(0, 10),
      });
    }
    const lastCreatedAt = conn.nodes.length > 0
      ? new Date(conn.nodes[conn.nodes.length - 1].createdAt)
      : null;
    if (!conn.pageInfo.hasNextPage || !lastCreatedAt || lastCreatedAt < historyStart) {
      break;
    }
    cursor = conn.pageInfo.endCursor;
  }
  return repos;
}

// Organization配下の各リポジトリについて、メンバー全員の月次コミット内訳
// (monthly[].repos、全期間分)を突き合わせ、全期間を通じて「このリポジトリに
// コミットしたのが1名だけ」であるリポジトリのみ、その1名に新規作成の帰属を
// 認める。複数メンバーが関与している場合は共同プロジェクトとみなし、
// 個人への帰属は行わない（コミット数自体は各人のcommits集計に含まれ続ける）。
function attributeOrgRepos(results, orgRepos) {
  const commitsByRepo = new Map(); // repoName -> Map(login -> totalCommits)
  for (const member of results) {
    for (const bucket of member.monthly) {
      for (const r of bucket.repos) {
        if (!commitsByRepo.has(r.name)) commitsByRepo.set(r.name, new Map());
        const m = commitsByRepo.get(r.name);
        m.set(member.login, (m.get(member.login) ?? 0) + r.count);
      }
    }
  }

  const attributedByLogin = new Map(); // login -> repo[]
  let attributedCount = 0;
  for (const repo of orgRepos) {
    const contributors = commitsByRepo.get(repo.name);
    if (!contributors || contributors.size !== 1) continue;
    const [login] = contributors.keys();
    if (!attributedByLogin.has(login)) attributedByLogin.set(login, []);
    attributedByLogin.get(login).push(repo);
    attributedCount += 1;
  }

  return { attributedByLogin, attributedCount };
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

    const repos = cc.commitContributionsByRepository
      .filter((e) => e.contributions.totalCount > 0)
      .map((e) => ({ name: e.repository.nameWithOwner, count: e.contributions.totalCount }));

    monthly.push({ month: bucket.key, commits, issues, pullRequests, reviews, repos });
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

  const repos = await fetchOwnedRepositories(login, historyStart);

  return { totals, monthly, daily, topRepositories, repos };
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

  const organizations = settings.organizations ?? [];
  const orgSummary = [];
  for (const org of organizations) {
    process.stdout.write(`Organization取得中: ${org} ... `);
    try {
      const orgRepos = await fetchOrgRepositories(org, historyStart);
      const { attributedByLogin, attributedCount } = attributeOrgRepos(results, orgRepos);
      for (const member of results) {
        const attributed = attributedByLogin.get(member.login) ?? [];
        member.repos.push(...attributed);
      }
      orgSummary.push({ org, repoCount: orgRepos.length, attributedCount });
      console.log(`OK (対象リポジトリ${orgRepos.length}件中${attributedCount}件を個人に帰属)`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      errors.push({ login: `org:${org}`, message: err.message });
    }
  }

  const output = {
    generated_at: now.toISOString(),
    history_start: settings.history_start,
    settings: {
      default_period: settings.default_period,
      academic_year_start_month: settings.academic_year_start_month,
      academic_year_start_day: settings.academic_year_start_day,
      organizations,
      scoring: settings.scoring,
    },
    member_count_configured: members.length,
    member_count_fetched: results.length,
    organization_summary: orgSummary,
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
