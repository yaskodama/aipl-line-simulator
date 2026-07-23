# 次回セッションの再開メモ

最終更新: 2026-07-23 / **スタンドアロン版は未コミット**（下記「2026-07-23」節を先に読む）

## 2026-07-23 セッション — サーバー不要版と Web 公開

**やったこと**: :8022 と同じシミュレーションを **Web サーバー無し**（`file://` のダブルクリック、
外部通信ゼロ）で動く 1 枚 HTML にまとめ、研究室サイトへ公開した。

```bash
node scripts/build_standalone.mjs   # → standalone.html (834KB) を生成
node test/standalone.mjs            # file:// で実走行検証（外部リクエスト0・エラー0）
open standalone.html
```

- **公開先**: <https://kodama-lab.com/genai/dofbot/> 。ポインタは
  <https://kodama-lab.com/genai/> の「作品一覧」**先頭カード**（サムネ `genai/img/dofbot.png`）。
  サイトの編集元は `~/kodama-lab_mirror/`、デプロイは
  `lftp ... mirror -R --only-newer genai/ public_html/kodama-lab.com/genai/`（手順の詳細は
  ~/.claude の kodama-lab デプロイ・メモ）。
- **仕組み**: `file://` では相対パスの ES モジュール import が CORS で禁止されるため、
  ビルド時に全モジュールを文字列として埋め込み、実行時に **Blob URL 化して依存順に import** する
  ミニバンドラを噛ませている。three.js/OrbitControls は CDN をやめて `vendor/` に同梱、
  `fetch` していた `aipl/dofbot_xinu.abcl` と `aipl/tinyml_model.json` は fetch シムが返す。
- ⚠ **`standalone.html` はビルド生成物**。`src/` `aipl/` `styles.css` `index.html` を編集したら
  **必ず再生成してサイトにも上げ直す**（自動追従しない）。公開版だけ古くなるのが一番の事故。
- 落とし穴: `String.replace` の置換文字列に three.min/CSS 由来の `$&` が混ざるので**関数リプレーサ**必須。
  埋め込みソース中の `</script>` は `<\/script>` へ退避。
- 落とし穴（検証）: XREA は **HeadlessChrome の UA に 403** を返す（curl は 200 で食い違う）。
  puppeteer で本番を確認するときは `page.setUserAgent(通常の Chrome UA)` を必ず設定する。
  これを忘れると「本番でだけ動かない」と誤診する。実ブラウザには影響しない。

**未コミット**（このセッションの成果物、`~/aipl_line_simulator`）:
`scripts/build_standalone.mjs` / `test/standalone.mjs` / `vendor/`(three 674KB + OrbitControls) /
`standalone.html`(生成物) / `README.md` 修正。
→ 次回の判断事項: `vendor/` と `standalone.html` を git に含めるか（含めれば「clone してすぐ開ける」、
`vendor/` は 700KB、`standalone.html` は生成物なので `.gitignore` する手もある）。

---

（以下は 2026-07-15 時点のメモ）

## いまの状態

**DOFBOT 6軸アームの AIPL ライン作業シミュレータ。** コンベアの部品を手首カメラで撮像 →
TinyML で認識 → 逆運動学で把持 → 認識した色の棚へ格納、を繰り返す。

| repo | branch | 状態 |
|---|---|---|
| `~/aipl_line_simulator` | main | push 済 (`e58c5f9`)。github.com/yaskodama/aipl-line-simulator |
| `~/ocaml-app/abclcp-project` (aios-claude) | feat/xinu-jit-target | push 済 (`6a67344`)。DOFBOT/TinyML プリミティブを追加した分だけ |

> aios-claude 側には**私が触っていない未コミットの変更**（docs/*.tex, manet_fire_dash 等 +
> 未追跡 63 件）が残っている。これはユーザさんの作業中のもの。私のコミットは
> `aipl_dofbot.py`(新規) / `aipl_interp.py` / `aipl_parser.py` / `aipl_typeck.py` / `BUILTINS.md` の 5 ファイルのみ。

## 起動

```bash
./run.sh                          # 3Dシミュレータ → localhost:8022
./aipl/run_aipl.sh check          # AIPL の型+効果検査 → "[type] no issues." が正
./aipl/run_aipl.sh                # AIPL を実処理系で実行（サーボ指令が出る）
open report/dofbot_report.pdf     # 全体レポート(8頁)
```

## 触る前に必ず読むこと

- **`.abcl` を変えたら** → `node test/aipl_sync.mjs`。main.js と AIPL は**正規表現＝字面で結合**
  しており、ずれても例外が出ず「効果チップが消える／行が光らない」だけになる。実際にそれで
  パネルを丸ごと壊し、気づかず「動いている」と報告した。
- **`src/layout.js` を変えたら** → `node test/cell.mjs`。棚の重なり・サーボの可動域張り付き・
  グリッパが背板を貫通、はいずれも**画面では見えない**。
- **「動いた」の判定は画面でなく `test/` で行う。** `verify.mjs` の「AIPL 行追従: 待機中」は
  故障のサイン（正常なら行番号が出る）。

## 検証一式

```bash
node test/cell.mjs        # 幾何: 到達性・干渉（ブラウザ不要・一瞬）
node test/aipl_sync.mjs   # main.js ↔ AIPL の字面結合（同上）
node test/verify.mjs      # 実走行: 把持誤差0.000mm・認識・色一致
node test/cycle_time.mjs  # サイクル時間の実測 vs 設定
node test/fault.mjs       # カメラ障害注入 → 排出 → 復帰
```

## TinyML / 強化学習

```bash
node rl/capture_dataset.mjs   # 手首カメラの実レンダ画像 → rl/dataset.json
python3 rl/train_tinyml.py    # 純Python学習 → aipl/tinyml_model.json (2355 params)
python3 rl/dofbot_rl.py       # CEM → rl/rl_policy.json
python3 rl/apply_policy.py    # 方策を src/layout.js と aipl/dofbot_xinu.abcl へ書き戻す
python3 rl/apply_policy.py --restore   # 手調整ベースラインへ戻す
```

現在の適用済み方策: サイクル **5.164 秒**（手調整 6.300 秒から -18.0%）、制約違反 0。
`HOVER=0.239 / CARRY={u:0.722, y:1.539}`。

## 次にやれること（未着手）

1. **実機接続**。物理 DOFBOT がネットワーク上に無いため未検証。用意はある:
   `DOFBOT_BACKEND=armlib`（DOFBOT の Pi 上で Yahboom Arm_Lib を叩く）/
   `DOFBOT_BACKEND=http DOFBOT_URL=...`（LAN 越し）。**AIPL ソースは 1 行も変えずに実機が回る**設計。
2. **`VMAX_DEG_S=180` の裏取り**。これは仮定でデータシート値ではない（無負荷 300°/s を derate）。
   レポート §5.3 の「手調整ベースラインは実機で動かない」という結論はこの仮定に依存する。
   実機の実測に置き換えれば結論が変わりうる（300°/s なら⑥旋回は成立し⑪ホームのみ違反）。
3. **強化学習は下界の 132%**。まだ 1.26 秒ぶんの余地がある。力学モデルは min-jerk の
   ピーク速度による近似で、トルク・慣性・バックラッシュを含まない。
4. **視覚課題を難しくする**なら、同色で形違い、部分遮蔽、複数個同時など。現状 test acc 100% は
   課題の平易さの反映であって TinyML の能力の証明ではない。
5. **AICE ポータル (:8888) の dofbot カード** (`src/aice_home.py`) は aios-claude に未コミットのまま。
6. `str_sub` のシグネチャに後置 optional の偽陽性が残っている（`env_get` は修正済）。

## 主要な数値（レポート §7）

把持誤差 0.000mm / 設置誤差 0.000mm / TinyML 実走行 6/6 正解 / 色一致 全数 /
サーボ指令角 ID1-ID6 すべて 0-180° 内 / AIPL 6サイクル完走・サーボ指令 258 回。

## 効かせている制約（レポート §2）

`PlannerActor` は **`!{ai, net}`** しか持たない = 駆動も永続化もできない。
駆動できるのは `ServoMotor` と `ConveyorActor` のみ、永続化は `SafetyActor` のみ。
規約ではなく型で強制されており、実際に `ShelfActor.alloc` の `fs` 申告漏れを処理系が検出した。
