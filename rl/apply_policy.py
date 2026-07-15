#!/usr/bin/env python3
"""apply_policy.py —— 学習した方策を 3Dシミュレータと AIPL に書き戻す。

rl_policy.json の HOVER / CARRY / 各フェーズ時間で src/layout.js を書き換える。
書き戻したら必ず検証すること（学習側の干渉モデルは簡略なので、正となるのは
test/cell.mjs の判定）:

    python3 rl/dofbot_rl.py
    python3 rl/apply_policy.py
    node test/cell.mjs        # 幾何（到達性・干渉）
    node test/verify.mjs      # 実走行（把持誤差・色一致）

  python3 rl/apply_policy.py --restore   # 手調整のベースラインへ戻す
"""
import json, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
LAYOUT = ROOT / "src" / "layout.js"

BASELINE = dict(carry_u=0.75, carry_y=1.90, hover=0.40,
                T=dict(open=0.30, inspect=0.70, descend=0.50, grasp=0.45, lift=0.60,
                       swing=1.00, over=0.70, place=0.50, release=0.40, retreat=0.45, home=0.70))


ABCL = ROOT / "aipl" / "dofbot_xinu.abcl"


def patch_abcl(p):
    """dofbot_xinu.abcl の ms 実引数と幾何を学習後の値へ揃える。
    ここが layout.js とずれると、sim と実機で違う動きになる。

    claw.write(180,…) は ①開く と ⑨解放 の 2 箇所、mover.to(qo,…) は ⑦枠上 と
    ⑩退避 の 2 箇所に出るので、字面ではなく「出現順」で当てる。
    """
    if not ABCL.exists():
        return
    s = ABCL.read_text()
    T = p["T"]
    ms = {k: int(round(v * 1000)) for k, v in T.items()}
    # (正規表現, [1番目に当てる値, 2番目に当てる値, ...])
    subs = [
        (r"(now claw\.write\(180, )\d+(\))",  [ms["open"], ms["release"]]),
        (r"(now mover\.to\(qa, )\d+(\))",     [ms["inspect"]]),
        (r"(now mover\.to\(qg, )\d+(\))",     [ms["descend"]]),
        (r"(now claw\.write\(105, )\d+(\))",  [ms["grasp"]]),
        (r"(now mover\.to\(cs, )\d+(\))",     [ms["lift"]]),
        (r"(now mover\.to\(cr, )\d+(\))",     [ms["swing"]]),
        (r"(now mover\.to\(qo, )\d+(\))",     [ms["over"], ms["retreat"]]),
        (r"(now mover\.to\(qp, )\d+(\))",     [ms["place"]]),
        (r"(now mover\.to\(qh, )\d+(\))",     [ms["home"]]),
    ]
    hit = 0
    want = sum(len(v) for _, v in subs)
    for pat, vals in subs:
        it = iter(vals)
        def rep(m, it=it, last=vals[-1]):
            nonlocal hit
            hit += 1
            return f"{m.group(1)}{next(it, last)}{m.group(2)}"
        s, n = re.subn(pat, rep, s)
        if n != len(vals):
            print(f"  ※ {pat} が {n} 箇所（期待 {len(vals)}）—— AIPL の書式が変わった可能性")
    # 幾何もソースに直書きしてあるので追従させる
    s = re.sub(r"(var HOVER = )[\d.]+(;)", lambda m: f'{m.group(1)}{p["hover"]:.3f}{m.group(2)}', s)
    s = re.sub(r"(var CARRY_U = )[\d.]+(;\s*var CARRY_Y = )[\d.]+(;)",
               lambda m: f'{m.group(1)}{p["carry_u"]:.3f}{m.group(2)}{p["carry_y"]:.3f}{m.group(3)}', s)
    s = re.sub(r"(var u = )[\d.]+(;\s*var y = )[\d.]+(;)",
               lambda m: f'{m.group(1)}{p["carry_u"]:.3f}{m.group(2)}{p["carry_y"]:.3f}{m.group(3)}', s)
    ABCL.write_text(s)
    print(f"aipl/dofbot_xinu.abcl: ms {hit}/{want} 箇所 + 幾何を更新")


def write(p, tag):
    s = LAYOUT.read_text()
    T = p["T"]
    patch_abcl(p)
    s = re.sub(r"export const HOVER = [\d.]+;",
               f'export const HOVER = {p["hover"]:.3f};', s)
    s = re.sub(r"export const CARRY = \{ u: [\d.]+, y: [\d.]+ \};",
               f'export const CARRY = {{ u: {p["carry_u"]:.3f}, y: {p["carry_y"]:.3f} }};', s)
    body = ("export const T = {\n"
            f'  open: {T["open"]:.3f}, inspect: {T["inspect"]:.3f}, descend: {T["descend"]:.3f}, '
            f'grasp: {T["grasp"]:.3f}, lift: {T["lift"]:.3f}, swing: {T["swing"]:.3f},\n'
            f'  over: {T["over"]:.3f}, place: {T["place"]:.3f}, release: {T["release"]:.3f}, '
            f'retreat: {T["retreat"]:.3f}, home: {T["home"]:.3f},\n'
            "};")
    s = re.sub(r"export const T = \{.*?\};", body, s, flags=re.S)
    s = re.sub(r"// 強化学習 .*?\n", f"// {tag}\n", s, count=1)
    LAYOUT.write_text(s)
    total = sum(T.values())
    print(f"src/layout.js を更新: 1 サイクル {total:.3f} 秒")
    print(f"  HOVER {p['hover']:.3f} / CARRY u={p['carry_u']:.3f} y={p['carry_y']:.3f}")
    print("\n次は必ず検証すること:")
    print("  node test/cell.mjs      # 幾何（到達性・干渉）が壊れていないか")
    print("  node test/verify.mjs    # 実走行（把持誤差・色一致）")


if __name__ == "__main__":
    if "--restore" in sys.argv:
        write(BASELINE, "強化学習 (rl/dofbot_rl.py) が最適化して書き戻す対象。既定値は手調整のベースライン。")
        sys.exit(0)
    f = HERE / "rl_policy.json"
    if not f.exists():
        sys.exit("rl_policy.json がない。先に python3 rl/dofbot_rl.py を実行すること。")
    p = json.loads(f.read_text())
    if p.get("violation", 1) > 1e-6:
        sys.exit(f"この方策は制約を破っている (violation={p['violation']}) ので適用しない。")
    write(p, f"強化学習 (rl/dofbot_rl.py) が学習した方策。{p['baseline_sec']:.2f}秒 → {p['cycle_sec']:.2f}秒。"
             f"手で書き換えず python3 rl/apply_policy.py で更新すること。")
