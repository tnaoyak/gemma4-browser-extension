# サイドパネル内プロアクティブ会話機能 設計

## 1. ドキュメント情報
- 作成日: 2026-04-29
- 最終更新: 2026-04-29 21:24:10
- ステータス: ドラフト
- 対象: Chrome拡張 `gemma4-browser-extension`

## 2. 設計方針
要件定義で確定した次の条件を満たすことを最優先とする。

1. サイドパネル開中のみ話しかける
2. 発話判定は複合条件（3分滞在、アクティブタブ、スクロール/クリック、クールダウン）
3. 見た目は通常assistantメッセージと同一
4. 文体はカジュアル

## 3. 変更対象
### 3.1 `public/manifest.json`
- `permissions` に `alarms` を追加する
  - 目的: Service Workerの寿命に依存しない周期判定

### 3.2 `src/sidebar/App.tsx`
- サイドパネル初期化時に `chrome.runtime.connect({ name: "sidepanel" })` を開始
- アンマウント時に port を切断
- （任意）接続維持のため heartbeat 送信を検討

### 3.3 `src/sidebar/chat/Chat.tsx`
- 初回マウント時の無条件 `AGENT_CLEAR` を削除または条件化
  - 目的: 自発メッセージが初期化で消える問題を防止

### 3.4 `src/background/background.ts`
- サイドパネル接続状態の管理（`runtime.onConnect` / `port.onDisconnect`）
- 滞在判定用状態の管理（タブ・URL単位）
- `chrome.alarms` で定期評価
- 条件を満たしたらプロアクティブ発話を生成

### 3.5 `src/background/agent/Agent.ts`
- 「ユーザー起点ではない発話」を追加するAPIを新設
  - 例: `runProactiveAgent(prompt: string)`（名称は実装時決定）
- 既存 `runAgent()` は手動チャット用として維持

## 4. イベント設計
## 4.1 入力イベント
1. `tabs.onActivated`
   - アクティブタブ変更時に監視対象タブを切り替える
2. `tabs.onUpdated(status=complete)`
   - URL遷移完了時に滞在計測をリセットする
3. `runtime.onConnect(name=sidepanel)`
   - パネル開状態を `true` 相当に遷移
4. `runtime.onMessage(type=user_activity)`（新規）
   - content script からスクロール/クリック発生を受信
5. `alarms.onAlarm(name=proactive-check)`（新規）
   - 条件評価と発話判定を実行

## 4.2 評価周期
- `chrome.alarms.create("proactive-check", { periodInMinutes: 1 })`
- 最短1分間隔で評価し、3分到達判定を行う

## 5. 状態設計
## 5.1 メモリ状態（background）
```ts
type TabEngagementState = {
  tabId: number;
  url: string;
  activeSince: number;           // このURLがアクティブになった時刻
  lastInteractionAt: number|null;// scroll/click最終時刻
  hasInteraction: boolean;       // 滞在中に操作が1回以上あったか
};
```

```ts
type ProactiveState = {
  panelConnectionCount: number;  // runtime.connect の接続数
  lastGlobalProactiveAt: number|null;
  promptedUrlSet: Set<string>;   // 同一URL 1回/セッション制御
};
```

## 5.2 判定条件
`shouldProactivelySpeak(tabState, proactiveState, now)` は以下をすべて満たすと `true`:

1. `panelConnectionCount > 0`
2. 対象タブがアクティブで `http(s)` URL
3. `now - activeSince >= 3分`
4. `hasInteraction === true`
5. `url` が `promptedUrlSet` に未登録
6. `lastGlobalProactiveAt` が `null` または `now - lastGlobalProactiveAt >= 10分`

## 6. コンテンツスクリプト連携設計
`src/content/content.ts` に次を追加する。

- `scroll` と `click` のイベントリスナー
- イベントをそのまま高頻度送信しないため、最低限の間引き（例: 10秒に1回）
- 送信メッセージ例:
  - `{ type: "USER_ACTIVITY", event: "scroll", url, ts }`
  - `{ type: "USER_ACTIVITY", event: "click", url, ts }`

備考: 型安全化のため `shared/types.ts` にメッセージ型を追加する。

## 7. プロアクティブ発話生成設計
## 7.1 生成トリガー時の入力
- タブタイトル
- URL
- 必要に応じてページ要約（`ask_website` を1回使う案を実装時に検討）

## 7.2 プロンプト方針
- 1〜2文
- カジュアル
- ユーザーの興味を尋ねるオープンな問い
- 命令口調・断定口調を避ける

生成テンプレート（案）:
`このページをしばらく読んでいるようなので、自然な一言を日本語で1〜2文作ってください。カジュアルに、押しつけず、気になる点を聞く。`

## 8. エラーハンドリング
- 発話生成に失敗しても既存チャット機能へ影響させない
- 条件判定やメッセージ送信の例外は握りつぶさず `console.error` へ記録
- 失敗時は `promptedUrlSet` への登録を行わず、次回評価に再試行余地を残す

## 9. テスト観点
1. パネル閉時に3分経過しても発話しない
2. パネル開時に3分+操作ありで発話する
3. 同一URLで2回目の発話が起きない
4. 10分未満では別URLでも発話しない
5. `/clear` 実行時のみ履歴が消える
6. 既存の手動チャット応答が従来通り動く

## 10. 未確定事項
- 1セッションあたりの自発メッセージ上限は、初版では導入しない  
  （運用でノイズが出た場合に追加する）
