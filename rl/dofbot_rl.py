#!/usr/bin/env python3
"""dofbot_rl.py —— DOFBOT の Pick&Place を「速く・安全に」する方策探索型強化学習。

  方策 φ (14次元) = 幾何 3 + 各フェーズの所要時間 11
      幾何 : 搬送時の引込半径 carry_u / 引込高さ carry_y / ホバー高さ hover
      時間 : ①開く ②撮像姿勢 ③下降 ④把持 ⑤持上 ⑥旋回 ⑦枠上 ⑧設置 ⑨解放 ⑩退避 ⑪ホーム

  報酬 = -(1サイクルの所要時間) - 罰則
      罰則 : サーボ角速度の上限超過 / 可動域(0..180)逸脱 / 到達不能
             / 旋回中の棚・既設部品との干渉 / グリッパの最小開閉時間割れ

  ・幾何を変えると全フェーズの関節変位が非線形に変わるので、時間だけを詰める
    問題ではない（そこが CEM を使う理由）。
  ・評価は 12 スロット全部を巡る決定論的タスク集合。乱数で有利不利が出ない。
  ・最後に「速度制限から決まる下界」と比べ、学習解がどこまで迫ったかを出す。

  python3 rl/dofbot_rl.py            # → rl/rl_results.csv, rl/rl_policy.json
  GEN=60 python3 rl/dofbot_rl.py
"""
import csv, json, math, os, pathlib, random

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

# ── 実機 DOFBOT の制約 ────────────────────────────────────────────────────
# 15kg シリアルバスサーボの無負荷速度は約 0.2s/60deg = 300deg/s。負荷とアーム
# 慣性を見込んで実用上限を 180deg/s とする。min-jerk 補間のピーク速度は
# 平均の 1.875 倍なので、フェーズ時間 T は 1.875*Δq/T <= VMAX を満たす必要がある。
VMAX_DEG_S = 180.0
PEAK = 1.875
GRIP_MIN_S = 0.18          # グリッパが物理的に開閉しきるのに要る最短時間
MOVE_MIN_S = 0.10

# ── 作業セル（src/layout.js と同一。変えたら test/cell.mjs を通すこと）──────
D = math.pi / 180
L1, L2, L3, SH = 1.20, 1.20, 1.05, 1.05
PLANAR_MAX = L1 + L2
OFFSET = [63.0, 85.0, 1.0, -2.0, 63.0]
STATION_YAW, STATION_U = -55 * D, 1.45
STATION = (-STATION_U * math.cos(STATION_YAW), 0.90, STATION_U * math.sin(STATION_YAW))
RACK_R, RACK_YAWS = 1.35, [0 * D, 50 * D, 100 * D]
TIERS = [(-0.22, 0.40), (0.22, 0.76)]      # (dr, top)
SLOT_T = [-0.19, 0.19]
PART_H, PART_SIZE = 0.32, 0.32
HOME = (-1.0805, 1.75, -0.3933)
RACK_INNER = RACK_R + TIERS[0][0] - 0.38 / 2      # 棚の最も手前の半径
SHELF_TOP = max(t[1] for t in TIERS) + PART_H     # 既設部品の最上端
PHASES = ["open", "inspect", "descend", "grasp", "lift", "swing",
          "over", "place", "release", "retreat", "home"]
GRIP_PHASES = {"open", "grasp", "release"}
BASELINE = dict(open=0.30, inspect=0.70, descend=0.50, grasp=0.45, lift=0.60,
                swing=1.00, over=0.70, place=0.50, release=0.40, retreat=0.45, home=0.70)
BASE_GEOM = dict(carry_u=0.75, carry_y=1.90, hover=0.40)


def polar(yaw, u, tan=0.0):
    return (-u * math.cos(yaw) + tan * math.sin(yaw), u * math.sin(yaw) + tan * math.cos(yaw))


def slot_pose(ri, tier, k):
    dr, top = TIERS[tier]
    x, z = polar(RACK_YAWS[ri], RACK_R + dr, SLOT_T[k])
    return (x, top + PART_H / 2, z)


def solve_ik(tx, ty, tz):
    """src/ik.js と同一。戻り値 (関節角[rad] 5, 到達可能か)。"""
    u = math.hypot(tx, tz)
    yaw = math.atan2(tz, -tx) if u > 1e-9 else 0.0
    wu, wv = u, (ty - SH) + L3
    d0 = math.hypot(wu, wv)
    lim = PLANAR_MAX * 0.995
    ok = d0 <= lim
    if not ok and d0 > 1e-9:
        k = lim / d0
        wu, wv = wu * k, wv * k
    d = min(d0, lim)
    cb = max(-1.0, min(1.0, (d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2)))
    beta = math.acos(cb)
    a1 = math.atan2(wu, wv) - math.atan2(L2 * math.sin(beta), L1 + L2 * math.cos(beta))
    a2 = a1 + beta
    return [yaw, a1, beta, math.pi - a2, yaw], ok


def servo_deg(q):
    return [OFFSET[i] + q[i] * 180 / math.pi for i in range(5)]


def waypoints(geom, ri, tier, k):
    """1 サイクルで通る全ポーズ（フェーズ名 -> 目標のワールド座標）。"""
    S, P = STATION, slot_pose(ri, tier, k)
    hv = geom["hover"]
    cu, cy = geom["carry_u"], geom["carry_y"]
    cs = polar(STATION_YAW, cu)
    cr = polar(RACK_YAWS[ri], cu)
    return {
        "inspect": (S[0], S[1] + hv, S[2]),
        "descend": S,
        "lift":    (cs[0], cy, cs[1]),
        "swing":   (cr[0], cy, cr[1]),
        "over":    (P[0], P[1] + hv, P[2]),
        "place":   P,
        "retreat": (P[0], P[1] + hv, P[2]),
        "home":    HOME,
    }


def rollout(phi, ri, tier, k):
    """1 サイクルを評価して (所要時間, 違反量) を返す。違反は罰則の合計。"""
    geom = {"carry_u": phi[0], "carry_y": phi[1], "hover": phi[2]}
    times = {p: phi[3 + i] for i, p in enumerate(PHASES)}
    viol = 0.0

    # 幾何の妥当性（旋回中に棚・既設部品と当たらないか）
    if geom["carry_u"] >= RACK_INNER:
        viol += 10.0 * (geom["carry_u"] - RACK_INNER + 0.01)
    if geom["carry_y"] - PART_H / 2 <= SHELF_TOP:
        viol += 10.0 * (SHELF_TOP - (geom["carry_y"] - PART_H / 2) + 0.01)
    if geom["hover"] < 0.12:
        viol += 10.0 * (0.12 - geom["hover"])        # 低すぎると把持前に部品を薙ぐ

    wp = waypoints(geom, ri, tier, k)
    prev, _ = solve_ik(*HOME)                        # サイクル開始姿勢
    total = 0.0
    for p in PHASES:
        t = times[p]
        lo = GRIP_MIN_S if p in GRIP_PHASES else MOVE_MIN_S
        if t < lo:
            viol += 20.0 * (lo - t)
            t = lo
        total += t
        if p in GRIP_PHASES:
            continue
        q, ok = solve_ik(*wp[p])
        if not ok:
            viol += 5.0
        s_now, s_prev = servo_deg(q), servo_deg(prev)
        for j in range(5):
            if not (0.0 <= s_now[j] <= 180.0):       # 可動域逸脱
                viol += 2.0 * (abs(s_now[j] - 90.0) - 90.0) / 90.0
            peak = PEAK * abs(s_now[j] - s_prev[j]) / max(t, 1e-6)
            if peak > VMAX_DEG_S:                    # 角速度の上限超過
                viol += 3.0 * (peak / VMAX_DEG_S - 1.0)
        prev = q
    return total, viol


TASKS = [(ri, tier, k) for ri in range(3) for tier in range(2) for k in range(2)]   # 12 スロット


# 違反 1 単位あたりの罰則。速度制限や干渉を少し破って時間を稼ぐ解が
# 得をしないよう、十分大きく取る（W=50 なら違反0.1で5秒ぶんの損）。
W_VIOL = 50.0
FEASIBLE_TOL = 1e-9

def reward(phi):
    tt, vv = 0.0, 0.0
    for t in TASKS:
        a, b = rollout(phi, *t)
        tt += a
        vv += b
    n = len(TASKS)
    return -(tt / n) - W_VIOL * (vv / n), tt / n, vv / n


def lower_bound(geom):
    """与えられた幾何での「速度制限から決まる最短サイクル時間」（解析解）。
    腕の動きは各関節の必要角速度で決まり、グリッパは最短開閉時間で決まる。"""
    tot = 0.0
    for t in TASKS:
        wp = waypoints(geom, *t)
        prev, _ = solve_ik(*HOME)
        s = 0.0
        for p in PHASES:
            if p in GRIP_PHASES:
                s += GRIP_MIN_S
                continue
            q, _ = solve_ik(*wp[p])
            dq = max(abs(a - b) for a, b in zip(servo_deg(q), servo_deg(prev)))
            s += max(MOVE_MIN_S, PEAK * dq / VMAX_DEG_S)
            prev = q
        tot += s
    return tot / len(TASKS)


def clamp_phi(phi):
    out = list(phi)
    out[0] = max(0.35, min(1.30, out[0]))       # carry_u
    out[1] = max(1.20, min(2.20, out[1]))       # carry_y
    out[2] = max(0.10, min(0.60, out[2]))       # hover
    for i in range(3, 14):
        out[i] = max(0.05, min(2.50, out[i]))   # 各フェーズ時間
    return out


def main():
    rng = random.Random(11)
    GEN = int(os.environ.get("GEN", 90))
    POP, ELITE, DIM = 60, 12, 14

    base = [BASE_GEOM["carry_u"], BASE_GEOM["carry_y"], BASE_GEOM["hover"]] + [BASELINE[p] for p in PHASES]
    b_r, b_t, b_v = reward(base)
    print(f"ベースライン(手調整): サイクル {b_t:.3f} 秒 / 違反 {b_v:.3f} / 報酬 {b_r:.3f}")
    print(f"速度制限からの下界  : {lower_bound(BASE_GEOM):.3f} 秒 (この幾何のとき)\n")

    mean = list(base)
    std = [0.25, 0.30, 0.12] + [0.30] * 11
    rows = []
    best_feasible = None      # 制約を 1 つも破らない解のうち最速のもの
    for g in range(GEN):
        pop = []
        for _ in range(POP):
            p = clamp_phi([mean[k] + std[k] * rng.gauss(0, 1) for k in range(DIM)])
            r, t, v = reward(p)
            pop.append((r, p, t, v))
            if v <= FEASIBLE_TOL and (best_feasible is None or t < best_feasible[0]):
                best_feasible = (t, list(p))
        pop.sort(key=lambda x: -x[0])
        elite = [e[1] for e in pop[:ELITE]]
        for k in range(DIM):
            vals = [e[k] for e in elite]
            m = sum(vals) / len(vals)
            var = sum((x - m) ** 2 for x in vals) / len(vals)
            mean[k] = m
            std[k] = max(0.01, math.sqrt(var))
        mr, mt, mv = reward(clamp_phi(mean))
        rows.append((g, round(mt, 4), round(mv, 4), round(mr, 4)))
        if g % 10 == 0 or g == GEN - 1:
            print(f"gen {g:3d}  サイクル {mt:6.3f} 秒  違反 {mv:6.3f}  報酬 {mr:7.3f}")

    # 採用するのは「制約を 1 つも破らない解」だけ。CEM の平均が違反していたら
    # 探索中に見つけた最速の実行可能解を採る。
    phi = clamp_phi(mean)
    r, t, v = reward(phi)
    if v > FEASIBLE_TOL:
        if best_feasible is None:
            print(f"\n✗ 実行可能解が 1 つも見つからなかった（最終違反 {v:.4f}）")
            return
        print(f"\n[CEM 平均は違反 {v:.4f} → 探索中の最速の実行可能解を採用]")
        phi = best_feasible[1]
        r, t, v = reward(phi)
    geom = {"carry_u": phi[0], "carry_y": phi[1], "hover": phi[2]}
    lb = lower_bound(geom)

    print(f"\n=== 学習前 → 学習後 ===")
    print(f"  サイクル時間 {b_t:.3f} 秒 → {t:.3f} 秒  ({(1-t/b_t)*100:+.1f}%)")
    print(f"  制約違反     {b_v:.3f} → {v:.3f}")
    print(f"  この幾何での下界 {lb:.3f} 秒 → 学習解は下界の {t/lb*100:.1f}%")
    print(f"\n  搬送引込半径 {BASE_GEOM['carry_u']:.2f} → {geom['carry_u']:.3f}")
    print(f"  搬送高さ     {BASE_GEOM['carry_y']:.2f} → {geom['carry_y']:.3f}")
    print(f"  ホバー高さ   {BASE_GEOM['hover']:.2f} → {geom['hover']:.3f}")
    print("\n  各フェーズの所要時間[秒]")
    for i, p in enumerate(PHASES):
        print(f"    {p:8} {BASELINE[p]:.2f} → {phi[3+i]:.3f}")

    with open(HERE / "rl_results.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["gen", "cycle_sec", "violation", "reward"])
        w.writerows(rows)
    (HERE / "rl_policy.json").write_text(json.dumps({
        "carry_u": round(phi[0], 4), "carry_y": round(phi[1], 4), "hover": round(phi[2], 4),
        "T": {p: round(phi[3 + i], 4) for i, p in enumerate(PHASES)},
        "cycle_sec": round(t, 4), "baseline_sec": round(b_t, 4),
        "violation": round(v, 5), "lower_bound_sec": round(lb, 4), "generations": GEN,
    }, indent=2, ensure_ascii=False))
    print(f"\n  → rl/rl_policy.json, rl/rl_results.csv")
    if v > 1e-6:
        print(f"  ※ 違反 {v:.4f} が残っている（制約を破る解を採用してはいけない）")


if __name__ == "__main__":
    main()
