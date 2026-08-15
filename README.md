# CommitForge4furuhashilab

古橋研究室（青山学院大学 地球社会共生学部）用 GitHub 活動量集計・可視化ツール。

*A GitHub activity aggregation & visualization dashboard for the Furuhashi Lab (Aoyama Gakuin University, School of Global Studies and Collaboration).*

**ダッシュボード（GitHub Pages）**: https://mapconcierge.github.io/CommitForge4furuhashilab/

## 概要

研究室メンバーの GitHub 上での活動（コミット・プルリクエスト・Issue・レビュー・リポジトリ作成・スター/フォーク獲得）を GitHub GraphQL API から定期的に集計し、静的な Web ダッシュボードとして可視化する。

- 集計対象アカウントは [`config/members.yaml`](config/members.yaml) で管理（メンバーの追加・削除はこのファイルを編集するだけ）
- GitHub Actions が毎日自動で最新データを取得し、`docs/data/contributions.json` を更新
- Web ダッシュボードは期間を自由に指定可能。デフォルトは大学の授業成績集計に合わせた**年度区切り（4/1〜翌3/31）**
- ランキングは単純なコミット数ではなく、リポジトリ作成・活動リポジトリ数・獲得スター/フォークまで加味した**重み付けスコア**で行う（後述）
- 生成される数値・グラフは常に「その時点で取得できた実データ」に基づく。取得に失敗したアカウントがあれば画面上部にエラーバナーで明示する

## 使い方

### ダッシュボードを見る

上記の GitHub Pages URL を開くだけ。期間プリセット（今年度 / 全期間）またはカスタム日付で集計期間を切り替えられる。

### メンバーを追加・削除する

`config/members.yaml` の `members:` に GitHub のユーザー名（`login`）を追加・削除して commit するだけでよい。`name` は GitHub プロフィールに公開されている表示名が確認できた場合のみ記載（未設定なら省略可）。次回の自動実行（または手動実行）で反映される。

### データ集計を手動実行する

```bash
npm install
GITHUB_TOKEN=<個人アクセストークンまたは gh auth token> npm run fetch
```

`docs/data/contributions.json` が更新される。GitHub Actions（[`.github/workflows/update-data.yml`](.github/workflows/update-data.yml)）は毎日 JST 0:00 に自動実行されるほか、Actions タブから `workflow_dispatch` で手動実行も可能。

### 集計ロジックの注意点

- コミット/PR/Issue/レビューの種別内訳は GitHub GraphQL API の制限（`contributionsCollection` は最大1年の期間指定まで）に合わせて**月単位**で取得している。そのため画面で任意の日付範囲を指定しても、内部的には指定範囲を含む月単位に丸めて集計する（画面上の「集計期間」表示で実際に使われた範囲を確認できる）
- 日次の推移グラフのみ日単位のデータ（種別内訳なし）を使用
- 集計対象は各アカウントの**公開**活動のみ。非公開リポジトリでの作業や、コミット・PR・Issue・レビュー以外の貢献（議論、資料作成、現地調査など）は反映されない

### 総合活動スコアについて

GitHub の公式 `contributionsCollection`（コントリビューショングラフ）は、**フォーク上での作業を基本的にカウントしない**（フォーク元へのマージ済みPRがある場合を除く）。そのため、自分のフォークで積極的に開発・検証しているメンバーほど、単純なコミット数集計では過小評価されてしまう問題があった。

これに対応するため、次の指標もあわせて重み付け加算した「総合活動スコア」でランキングしている（[`config/members.yaml`](config/members.yaml) の `settings.scoring` で重みを調整可能）。

| 指標 | 内容 | 既定の重み |
|---|---|---|
| コミット | `contributionsCollection` の集計値（Organization配下リポジトリでのコミットも含む） | 1 |
| Issue | 同上 | 2 |
| プルリクエスト | 同上 | 3 |
| レビュー | 同上 | 3 |
| 新規リポジトリ | 期間内に作成した非フォークの公開リポジトリ数。個人アカウント名義に加え、`settings.organizations` 配下で本人単独の作成と判定できたリポジトリを含む（後述） | 15 |
| 活動リポジトリ | 期間内にコミット実績のあるリポジトリ数（**フォーク・Organization配下を含む**）。フォーク上の自主的な開発や、個人には帰属させていない共同開発中の Organization リポジトリでの活動を拾うための指標 | 3 |
| 獲得スター | 期間内に作成したリポジトリの現在の合計スター数。`log(1+n)` でスケール | 10 |
| 獲得フォーク | 同上（フォーク数） | 8 |

**Organization配下リポジトリの扱い**: 古橋研究室では卒論・ゼミ論などの個人リポジトリも `furuhashilab` Organization 配下に作成される運用になっている（例: `furuhashilab/2026gsc_XxxYyy`）。個人アカウント名義のリポジトリだけを見ていると、こうした Organization 配下の新規作成実績が完全に漏れてしまうため、`settings.organizations`（既定値: `furuhashilab`）に列挙した Organization の公開リポジトリも新規作成・活動リポジトリの集計対象に含めている。

ただし GitHub には「このリポジトリを作成したのは誰か」を公開APIから直接取得する手段がない。そこで本ツールでは、対象期間を通じて**そのリポジトリにコミットしたのが集計対象メンバーのうちちょうど1名だけ**の場合に限り、その人物の新規作成実績として帰属させている（複数メンバーが関与しているリポジトリは共同プロジェクトとみなし、個人への新規作成の帰属は行わない。ただし各人のコミット数自体には引き続き計上される）。この帰属ロジックはヒューリスティックであり、例えば「作成はしたが一度もコミットしていない」ケースは捕捉できない。

**重要な限界（検証済み事項として明記する）**:
- GitHub は公式の「貢献度スコア」を公開していない。このスコアは本リポジトリ独自のヒューリスティックであり、唯一の正解ではない。重みの妥当性は研究室の判断で継続的に見直すこと
- スター・フォーク数は取得時点のスナップショットであり、いつ獲得したかの履歴は追跡していない
- Organization配下リポジトリの新規作成者推定は「コミットした人が1名だけかどうか」に基づく後付けの推定であり、GitHubが記録する実際の作成者情報そのものではない

## データソース・ライセンス

- **データソース**: [GitHub GraphQL API](https://docs.github.com/en/graphql) の `contributionsCollection`（公開 contribution 情報、コミットしたリポジトリの内訳を含む）、`User.repositories`（所有する公開リポジトリのメタデータ）、`Organization.repositories`（`settings.organizations` 配下の公開リポジトリのメタデータ）。GitHub の利用規約に従う。
- **コード・データのライセンス**: 本リポジトリの [LICENSE](LICENSE)（CC0 1.0 Universal）に従う。
- 本ツールが可視化する数値は貢献度の完全な指標ではない。判断材料として利用する際は、非公開作業やコード以外の貢献が反映されない点に留意すること。

## 著者

古橋研究室 (Furuhashi Lab), 青山学院大学 地球社会共生学部

## 関連リンク

- [古橋研究室](https://github.com/mapconcierge)
