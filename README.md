# CommitForge4furuhashilab

古橋研究室（青山学院大学 地球社会共生学部）用 GitHub 活動量集計・可視化ツール。

*A GitHub activity aggregation & visualization dashboard for the Furuhashi Lab (Aoyama Gakuin University, School of Global Studies and Collaboration).*

**ダッシュボード（GitHub Pages）**: https://mapconcierge.github.io/CommitForge4furuhashilab/

## 概要

研究室メンバーの GitHub 上での活動（コミット・プルリクエスト・Issue・レビュー）を GitHub GraphQL API から定期的に集計し、静的な Web ダッシュボードとして可視化する。

- 集計対象アカウントは [`config/members.yaml`](config/members.yaml) で管理（メンバーの追加・削除はこのファイルを編集するだけ）
- GitHub Actions が毎日自動で最新データを取得し、`docs/data/contributions.json` を更新
- Web ダッシュボードは期間を自由に指定可能。デフォルトは大学の授業成績集計に合わせた**年度区切り（4/1〜翌3/31）**
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

## データソース・ライセンス

- **データソース**: [GitHub GraphQL API](https://docs.github.com/en/graphql) の `contributionsCollection`（各アカウントが公開している contribution 情報）。GitHub の利用規約に従う。
- **コード・データのライセンス**: 本リポジトリの [LICENSE](LICENSE)（CC0 1.0 Universal）に従う。
- 本ツールが可視化する数値は貢献度の完全な指標ではない。判断材料として利用する際は、非公開作業やコード以外の貢献が反映されない点に留意すること。

## 著者

古橋研究室 (Furuhashi Lab), 青山学院大学 地球社会共生学部

## 関連リンク

- [古橋研究室](https://github.com/mapconcierge)
