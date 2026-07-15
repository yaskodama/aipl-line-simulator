# レポート

`dofbot_report.pdf` —— DOFBOT 6軸アームの AIPL 実装。Capability 推論・TinyML 視覚認識・
強化学習によるサイクル最適化と、その検証。

## 組版

```bash
cd report && latexmk -xelatex dofbot_report.tex
```

XeLaTeX + xeCJK（`docs/AIPL_Agent_Language_Paper.tex` と同じ方式）。
丸数字①〜⑪・矢印・― は `\xeCJKDeclareCharClass` で CJK フォントへ回している
（既定だと欧文フォントに落ちて字が消える）。

## 図表の出所

| ファイル | 生成元 |
|---|---|
| `fig/allsix.png` | シミュレータの実スクリーンショット（サーボ番号入り） |
| `fig/wrist_noise.png` | 手首カメラの実レンダ画像（上=劣化なし、中下=実機相当の劣化） |
| `rl_curve.dat` | `rl/rl_results.csv`（CEM 120 世代の実測）→ pgfplots が組版時に作図 |

本文中の数値はすべて `rl/rl_policy.json`・`aipl/tinyml_model.json`・`test/` の実行結果に紐づく。
再現手順は本文 §8。
