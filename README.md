# BOOTH BUDDY — Claude API + シンプルRAG

板金・塗装の相棒チャット。裏でClaude APIを呼び、`knowledge/` フォルダ内のMarkdownを**RAG**として参照して回答します。
自分のPC（localhost）でも、クラウドにデプロイして社内共有でも動きます。

> **このフォルダについて**：GitHub等にアップロードして共有するための一式です。
> 秘密情報の `.env` と巨大な `node_modules` は**わざと入れていません**（`.gitignore` で除外）。
> APIキーは `.env`（ローカル）またはデプロイ先の環境変数に設定します。コードには絶対に書きません。

---

## 仕組み（概要）

```
ブラウザ(public/index.html)
   │  fetch POST /chat
   ▼
server.js（Node / Express）
   │  ① knowledge/*.md を読み込み
   │  ② 質問に関連するチャンクを抽出（シンプルRAG）
   │  ③ キャラ人格 + 参考知識 + 履歴 でプロンプト構築
   │  ④ 合言葉(APP_PASSWORD)が設定されていれば認証
   ▼
Claude API（APIキーはサーバー内のみ。ブラウザには出さない）
   ▼
返答 → 画面表示 + 音声読み上げ
```

- **知識は全キャラ共通／人格だけキャラごと**。だからキャラを増やすのが安い。
- APIキーはサーバー側だけで使用。**index.htmlには絶対に書かない**（公開すると盗まれるため）。

---

## 必要なもの
- Node.js 18 以上（https://nodejs.org/）
- Anthropic の APIキー（https://console.anthropic.com/ → Settings → API Keys）

---

## ローカルで動かす手順

1. このフォルダでターミナル（PowerShell）を開く。
2. 依存パッケージをインストール（`package-lock.json` が無くても自動生成されます）：
   ```
   npm install
   ```
3. APIキーを設定：
   - `.env.example` をコピーして `.env` を作る。
   - `.env` を開き、`ANTHROPIC_API_KEY=` に自分のキーを貼る。
   - `ANTHROPIC_MODEL` は `claude-sonnet-4-6`（2026年6月時点の現行）。
4. 起動：
   ```
   npm start
   ```
   `http://localhost:3000` と出たら成功。
5. ブラウザで **http://localhost:3000** を開く。動作確認は **/health** が便利。

---

## 社内共有（デプロイ）

詳しい手順は **`DEPLOY_社内共有ガイド.md`** を参照。要点だけ：

- **Render（推奨）**：この `server.js` をそのまま動かせる。無料枠あり（しばらく無アクセスだとスリープ）。
- **社内LAN**：1台で `npm start` し続け、`http://（そのPCのIP）:3000` で共有（同じ事務所内のみ。マイクは不可）。
- どの方法でも、APIキー・`ANTHROPIC_MODEL`・`APP_PASSWORD` は**環境変数**に設定する。
- 公開する場合は `APP_PASSWORD`（合言葉）を必ず設定する。

---

## RAGの知識を入れ替える / 増やす

- `knowledge/` フォルダに `.md` を置くだけ。`##` 見出しごとに1チャンク。
- サンプル（`01_colors.md`, `02_process.md`）を実際の現場知識・社内マニュアルに置き換える。
- 編集後はサーバー再起動、または `（URL）/reload` にPOSTで反映。

---

## エンドポイント
- `POST /chat` … `{ message, character, history, password? }` → `{ reply }`
- `GET  /health` … 動作確認（モデル・知識件数・APIキー有無・合言葉要否）
- `GET  /config` … 合言葉が必要かどうか
- `POST /reload` … 知識MDの再読み込み

---

## 注意（安全）
技術助言の誤りは事故・損害に直結します。安全・法規・保証・安全装置に関わる内容は「断定しない／現場・メーカー指示優先」とするよう、`server.js` のプロンプト（SAFETY）に明記済み。実運用前に専門家の監修を入れてください。

---

## ファイル構成
```
booth-buddy-app/
├─ server.js                 … バックエンド（Claude API + RAG + 合言葉）
├─ package.json
├─ .gitignore                … .env と node_modules を除外
├─ .env.example              … これをコピーして .env を作る
├─ README.md
├─ DEPLOY_社内共有ガイド.md   … 共有・デプロイ手順
├─ knowledge/                … ここのMDがRAGの知識源
│   ├─ 01_colors.md
│   └─ 02_process.md
└─ public/
    └─ index.html            … フロントエンド（チャット画面・音声）
```
