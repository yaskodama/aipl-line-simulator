#!/usr/bin/env python3
"""train_tinyml.py —— 手首カメラの実レンダ画像から部品を分類する小型NNを学習する。

  ・データ : rl/capture_dataset.mjs が実際の手首カメラ描画から作った 192 次元特徴
             (96x96 RGBA → 中央62%を切出し → 8x8 平均プーリング → RGB 正規化)
  ・構造   : 192 → H(tanh) → 3(softmax)。既定 H=12 で 2355 パラメータ。
  ・学習   : 交差エントロピー + モーメンタム付き SGD。numpy/torch 非依存(pure Python)。
             これが「TinyML」の実体 —— フレームワークなしで実機の Pi でも動く規模。
  ・出力   : aipl/tinyml_model.json （ブラウザの sim と AIPL 処理系が同じ重みを読む）

  python3 rl/train_tinyml.py
"""
import json, math, pathlib, random

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
CLASSES = ["red", "blue", "green"]
HIDDEN = 12
EPOCHS = 140
LR = 0.02
MOMENTUM = 0.9
SEED = 7


def load():
    d = json.loads((HERE / "dataset.json").read_text())
    X, y = d["X"], d["y"]
    rng = random.Random(SEED)
    idx = list(range(len(X)))
    rng.shuffle(idx)
    cut = int(len(idx) * 0.8)
    tr = [(X[i], y[i]) for i in idx[:cut]]
    te = [(X[i], y[i]) for i in idx[cut:]]
    return tr, te, len(X[0])


def forward(p, x):
    w1, b1, w2, b2, nf = p["w1"], p["b1"], p["w2"], p["b2"], p["nfeat"]
    h = [0.0] * HIDDEN
    for j in range(HIDDEN):
        s = b1[j]
        base = j * nf
        for i in range(nf):
            s += w1[base + i] * x[i]
        h[j] = math.tanh(s)
    o = [0.0] * len(CLASSES)
    for k in range(len(CLASSES)):
        s = b2[k]
        base = k * HIDDEN
        for j in range(HIDDEN):
            s += w2[base + j] * h[j]
        o[k] = s
    m = max(o)
    ex = [math.exp(v - m) for v in o]
    t = sum(ex)
    return h, [v / t for v in ex]


def accuracy(p, data):
    ok = 0
    for x, y in data:
        _, pr = forward(p, x)
        if max(range(len(pr)), key=lambda k: pr[k]) == y:
            ok += 1
    return ok / len(data)


def confusion(p, data):
    m = [[0] * len(CLASSES) for _ in CLASSES]
    for x, y in data:
        _, pr = forward(p, x)
        m[y][max(range(len(pr)), key=lambda k: pr[k])] += 1
    return m


def main():
    tr, te, nf = load()
    rng = random.Random(SEED)
    sc1 = 1.0 / math.sqrt(nf)
    sc2 = 1.0 / math.sqrt(HIDDEN)
    p = {
        "w1": [rng.gauss(0, sc1) for _ in range(HIDDEN * nf)],
        "b1": [0.0] * HIDDEN,
        "w2": [rng.gauss(0, sc2) for _ in range(len(CLASSES) * HIDDEN)],
        "b2": [0.0] * len(CLASSES),
        "nfeat": nf,
    }
    vel = {k: [0.0] * len(p[k]) for k in ("w1", "b1", "w2", "b2")}
    nparam = sum(len(p[k]) for k in ("w1", "b1", "w2", "b2"))
    print(f"学習開始: {len(tr)} 枚(train) / {len(te)} 枚(test) / 特徴 {nf} 次元")
    print(f"構造 {nf}→{HIDDEN}(tanh)→{len(CLASSES)}(softmax)  パラメータ {nparam}")

    for ep in range(EPOCHS):
        rng.shuffle(tr)
        loss = 0.0
        for x, y in tr:
            h, pr = forward(p, x)
            loss += -math.log(max(pr[y], 1e-9))
            # 出力層の勾配 dL/do = p - onehot
            do = list(pr)
            do[y] -= 1.0
            # 隠れ層へ逆伝播（tanh' = 1 - h^2）
            dh = [0.0] * HIDDEN
            for j in range(HIDDEN):
                s = 0.0
                for k in range(len(CLASSES)):
                    s += do[k] * p["w2"][k * HIDDEN + j]
                dh[j] = s * (1.0 - h[j] * h[j])
            # 更新（モーメンタム付き SGD）
            for k in range(len(CLASSES)):
                g = do[k]
                base = k * HIDDEN
                for j in range(HIDDEN):
                    gr = g * h[j]
                    vel["w2"][base + j] = MOMENTUM * vel["w2"][base + j] - LR * gr
                    p["w2"][base + j] += vel["w2"][base + j]
                vel["b2"][k] = MOMENTUM * vel["b2"][k] - LR * g
                p["b2"][k] += vel["b2"][k]
            for j in range(HIDDEN):
                g = dh[j]
                base = j * nf
                for i in range(nf):
                    gr = g * x[i]
                    vel["w1"][base + i] = MOMENTUM * vel["w1"][base + i] - LR * gr
                    p["w1"][base + i] += vel["w1"][base + i]
                vel["b1"][j] = MOMENTUM * vel["b1"][j] - LR * g
                p["b1"][j] += vel["b1"][j]
        if ep % 20 == 0 or ep == EPOCHS - 1:
            print(f"  epoch {ep:3d}  loss {loss/len(tr):.4f}  "
                  f"train {accuracy(p,tr)*100:5.1f}%  test {accuracy(p,te)*100:5.1f}%")

    tr_acc, te_acc = accuracy(p, tr), accuracy(p, te)
    print(f"\n=== 学習結果 ===\n train accuracy {tr_acc*100:.1f}%   test accuracy {te_acc*100:.1f}%")
    cm = confusion(p, te)
    print("\n混同行列 (行=正解, 列=予測)")
    print("            " + "".join(f"{c:>8}" for c in CLASSES))
    for i, c in enumerate(CLASSES):
        print(f"  {c:>8}  " + "".join(f"{v:>8}" for v in cm[i]))

    out = ROOT / "aipl" / "tinyml_model.json"
    out.write_text(json.dumps({
        "hidden": HIDDEN, "nfeat": nf, "classes": CLASSES, "nparam": nparam,
        "test_acc": round(te_acc, 4), "train_acc": round(tr_acc, 4),
        "w1": [round(v, 5) for v in p["w1"]], "b1": [round(v, 5) for v in p["b1"]],
        "w2": [round(v, 5) for v in p["w2"]], "b2": [round(v, 5) for v in p["b2"]],
    }))
    print(f"\n重みを書き出し → {out.relative_to(ROOT)}  ({out.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
