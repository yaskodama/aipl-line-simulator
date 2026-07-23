# AIPL 3D Line Work Simulator

Mac上で動作する、AIPL/AICE研究用の3Dライン作業シミュレータです。

## 起動

```bash
cd aipl_line_simulator
./start.command
```

または

```bash
./scripts/start.sh
```

既定では `http://localhost:8080` を開きます。
別ポートを使う場合:

```bash
PORT=9000 ./scripts/start.sh
```

## 構成

- `aipl/line_work.abcl`: Actor構成を記述したAIPLソース
- `src/aipl_runtime.js`: AIPL風Actorランタイム
- `src/simulator.js`: Three.js 3Dシミュレータ
- `src/main.js`: ActorとCGの接続
- `scripts/start.sh`: ターミナル起動スクリプト
- `start.command`: macOS Finder/Terminal用起動スクリプト

## 機能

- 6DOF風ロボットアーム
- ベルトコンベア
- 赤/青部品の分類
- Actorメッセージログ
- Capability表示
- CameraActor障害注入
- 成功/失敗/メッセージ数の表示

## 注意

Three.jsをCDNから読み込むため、初回起動時にはインターネット接続が必要です。

## スタンドアロン版（サーバー不要・オフライン可）

`standalone.html` は Web サーバーを起動せず、ファイルをダブルクリック（`file://`）するだけで
同じシミュレーションが動く 1 枚 HTML です。CSS・全 JS モジュール・three.js（`vendor/`）・
AIPL ソース・TinyML 重みをすべて埋め込んであるため、外部通信は一切ありません。

```sh
node scripts/build_standalone.mjs    # src/ を編集したら再生成すること
node test/standalone.mjs             # file:// で実走行させて検証（外部リクエスト0・エラー0を確認）
open standalone.html
```

`file://` では相対パスの ES モジュール import が CORS で禁止されるため、ビルド時に各モジュールを
文字列として埋め込み、実行時に Blob URL 化して依存順に import している（`scripts/build_standalone.mjs`）。
`fetch` していた `aipl/dofbot_xinu.abcl` と `aipl/tinyml_model.json` は fetch シムが埋め込み文字列を返す。
