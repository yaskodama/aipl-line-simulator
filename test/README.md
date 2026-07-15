# 検証スクリプト

シミュレータの「ちゃんと掴んで、色の合った棚に置く」が本当に成立しているかを機械的に確認する。

| ファイル | 何を検証するか | 実行 |
|---|---|---|
| `cell.mjs` | 作業セルの幾何。全 12 スロット + コンベア停止位置が DOFBOT の可動域(各サーボ 0..180°)で到達可能か、棚どうし・棚とコンベア・搬送経路・グリッパと背板が干渉しないか。ブラウザ不要 | `node test/cell.mjs` |
| `verify.mjs` | 実際に走らせて、把持誤差 / 搬送中の追従 / 置いた棚の色一致 / 設置誤差 / 全フェーズ実行 / サーボ可動域を測る | `RUN_MS=90000 node test/verify.mjs` |
| `fault.mjs` | CameraActor 障害 → 不良品排出 → 復帰でサイクルが再開するか（abort 経路でラインが止まらないか） | `node test/fault.mjs` |

`verify.mjs` / `fault.mjs` は `./run.sh` でサーバを起動しておくこと。puppeteer が必要:
`npm i -D puppeteer`
