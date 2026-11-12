"""autowalk: 8方向の立ち絵から、歩行3コマ(左足・立ち・右足)をコードで作る。

使い方 : python3 autowalk.py <立ち絵.png> <出力フォルダ>
入力   : 1セル48pxの透明PNG。列=キャラ、行=向き(S,SW,W,NW,N,NE,E,SE)
出力   : charN_walk.png      ゲーム用シート(横3コマ x 縦8方向)
         charN_detect_x6.png 検出結果の重ね画像(赤・青=脚、緑=手)
         charN_walk_x4.gif   確認用アニメ(左足→立ち→右足→立ち)
         report.json         向きごとの検出結果

脚と手の範囲は自動検出する(キャラごとの座標指定なし)。
  脚 : 正面の絵で、足元から上へ「左右の脚の間にすき間がある行」を数えて脚の高さを決める。
       各向きで裾より下を脚とし、すき間か暗い縦線で左右に分ける。
  手 : 正面の絵で、体の両端にある肌色(なければ手袋)の塊から手の色を覚え、各向きで同じ色の塊を探す。
動かし方:
  正面・背面 : 片脚を上へ持ち上げる
  斜め       : 前に出す脚が相手の脚の側へ動く歩(交差)は、横に動かさず片脚を持ち上げる。
               離れる側へ動く歩(開き)は、前の脚を大きく、後ろの脚を小さく動かす。
               足は基準線より下へ出さない
  横         : 脚の塊を前後へ。奥の脚は一段暗い複製
  手         : 前に出た脚と反対側の手を前へ。横向きは前後に2ドット、それ以外は上下に1ドット。
               輪郭線ごと動かし、空いた所は動く向きと逆側の画素で埋める
  仕上げ     : 立ち絵に無かった1ドットの飛び出しを消し、1ドットの穴を埋める
"""
import sys, json
from pathlib import Path
import numpy as np
from PIL import Image

CELL = 48
DIRS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE']
FACE = {'S': (0, 1), 'SW': (-1, 1), 'W': (-1, 0), 'NW': (-1, -1),
        'N': (0, -1), 'NE': (1, -1), 'E': (1, 0), 'SE': (1, 1)}
# 斜め向きで、画面の左右どちらの脚が手前か
NEAR_SIDE = {'SE': 'L', 'SW': 'R', 'NE': 'R', 'NW': 'L'}


def lum(px):
    return (px[..., 0] * 3 + px[..., 1] * 6 + px[..., 2]) / 10.0


def runs(row):
    """True の連続区間 [(x0,x1),...]"""
    out, x, n = [], 0, len(row)
    while x < n:
        if row[x]:
            s = x
            while x < n and row[x]:
                x += 1
            out.append((s, x - 1))
        else:
            x += 1
    return out


def leg_height_from_front(cell):
    """正面の絵で、足元から上へ2本の脚が分かれている行数を数える。"""
    m = cell[..., 3] > 0
    ys = np.where(m.any(1))[0]
    bottom = ys.max()
    y = bottom
    while y > 0 and len(runs(m[y])) >= 2:
        y -= 1
    return bottom - y  # 行数


def split_legs(cell, top, bottom):
    """裾より下(top..bottom)を左右の脚に分ける。戻り値: (maskL, maskR) か (mask, None)"""
    m = cell[..., 3] > 0
    leg = np.zeros_like(m)
    leg[top:bottom + 1] = m[top:bottom + 1]
    xs = np.where(leg.any(0))[0]
    if len(xs) == 0:
        return None, None, 'none'
    x0, x1 = xs.min(), xs.max()
    dark = lum(cell.astype(float)) < 45
    # 1) すき間のある列(脚の上半分の行で透明)を探す
    rows = range(top, bottom + 1)
    upper = [y for y in rows if y <= top + max(0, (bottom - top) // 2)]
    best = None
    for x in range(x0 + 2, x1 - 1):
        gap = sum(1 for y in upper if not m[y, x])
        if gap == len(upper):
            best = x if best is None else best
            # すき間の中央を取る
            xe = x
            while xe + 1 < x1 and all(not m[y, xe + 1] for y in upper):
                xe += 1
            best = (x + xe) // 2
            break
    how = 'gap'
    if best is None:
        # 2) 暗い縦線(全行で暗い列)を、中央に近いところから探す
        cx = (x0 + x1) / 2
        cand = [x for x in range(x0 + 2, x1 - 1)
                if all((not m[y, x]) or dark[y, x] for y in rows)]
        if cand:
            best = min(cand, key=lambda x: abs(x - cx))
            how = 'line'
    if best is None:
        return leg, None, 'single'
    L = leg.copy(); L[:, best + 1:] = False
    R = leg.copy(); R[:, :best + 1] = False
    if how == 'line':
        # 区切りの暗い線は両方の脚の輪郭として持たせる(離したときに縁が欠けないように)
        R[:, best] = leg[:, best]
        # ただし、その行に脚の本体がない所の線は持たせない(短いほうの脚に線だけ垂れるのを防ぐ)
        for y in range(top, bottom + 1):
            if not leg[y, best - 1]:
                L[y, best] = False
            if not leg[y, best + 1]:
                R[y, best] = False
            if leg[y, best] and not (L[y, best] or R[y, best]):
                L[y, best] = True
    return L, R, how


def darker(layer, k=0.72):
    out = layer.copy()
    out[..., :3] = (out[..., :3].astype(float) * k).astype(np.uint8)
    return out


def take(cell, mask):
    out = np.zeros_like(cell)
    out[mask] = cell[mask]
    return out


def put(canvas, layer, dx, dy, top, bottom, bend=True):
    """脚の層を (dx,dy) ずらして描く。bend=True なら付け根は動かさず、下ほど大きく動かす。"""
    n = bottom - top + 1
    for i, y in enumerate(range(top, bottom + 1)):
        if bend and n > 1:
            t = min(1.0, (i + 1) / max(1.0, n / 2.0))
            ox = int(round(dx * t))
        else:
            ox = dx
        ny = y + dy
        if not (0 <= ny < CELL):
            continue
        row = layer[y]
        xs = np.where(row[..., 3] > 0)[0]
        for x in xs:
            nx = x + ox
            if 0 <= nx < CELL:
                canvas[ny, nx] = row[x]
    # 下へずらしたとき、裾との間が空かないよう一番上の行を伸ばす
    if dy > 0:
        row = layer[top]
        xs = np.where(row[..., 3] > 0)[0]
        ox = int(round(dx * min(1.0, 1 / max(1.0, n / 2.0)))) if bend else dx
        for k in range(dy):
            for x in xs:
                nx = x + ox
                if 0 <= nx < CELL and canvas[top + k, nx, 3] == 0:
                    canvas[top + k, nx] = row[x]


def over(canvas, layer):
    m = layer[..., 3] > 0
    canvas[m] = layer[m]



# ---------------------------------------------------------------- 手
def components(mask):
    """4近傍の連結成分。[[(y,x),...], ...]"""
    seen = np.zeros_like(mask, bool); out = []
    H, W = mask.shape
    for y0, x0 in zip(*np.where(mask)):
        if seen[y0, x0]:
            continue
        stack = [(y0, x0)]; seen[y0, x0] = True; pts = []
        while stack:
            y, x = stack.pop(); pts.append((y, x))
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True; stack.append((ny, nx))
        out.append(pts)
    return out


def hand_zone(cell, hem):
    m = cell[..., 3] > 0
    ys = np.where(m.any(1))[0]
    top, bottom = ys.min(), ys.max()
    return int(top + 0.58 * (bottom - top)), hem - 1


def is_skin(px):
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    # 肌色: 赤みが強い明るい色。生成りの袖(赤と緑の差が小さい)や金具(青が低い)は除く
    return (r > 190) & (r - g > 30) & (r - b > 55) & (b > 95)


def edge_blobs(front, hem, cand):
    """正面の絵で、体の左右の端に接する小さな塊を左右1つずつ返す。"""
    m = front[..., 3] > 0
    y0, y1 = hand_zone(front, hem)
    c = cand.copy(); c[:y0] = False; c[y1 + 1:] = False
    xs_all = np.where(m[y0:y1 + 1].any(0))[0]
    xl, xr = xs_all.min(), xs_all.max()
    best = {}
    for pts in components(c):
        xs = [q[1] for q in pts]; ys = [q[0] for q in pts]
        if not (3 <= len(pts) <= 20 and max(xs) - min(xs) < 6 and max(ys) - min(ys) < 6):
            continue
        side = 'L' if min(xs) - xl <= 3 else ('R' if xr - max(xs) <= 3 else None)
        if side and (side not in best or max(ys) > max(q[0] for q in best[side])):
            best[side] = pts
    return best


def learn_hand_color(front, hem):
    """正面の絵から手の色を覚える。
    顔と同じ肌色の塊が体の両端にあれば素手、なければ両端の一番下の塊(手袋)の色を使う。"""
    m = front[..., 3] > 0
    px = front.astype(float)
    ys = np.where(m.any(1))[0]
    head = np.zeros_like(m); head[ys.min():hand_zone(front, hem)[0]] = True
    face = m & head & is_skin(px)
    if face.sum() >= 6:
        skin = np.median(px[face][:, :3], 0)
        cand = m & is_skin(px) & (np.abs(px[..., :3] - skin).sum(-1) < 110)
        if len(edge_blobs(front, hem, cand)) == 2:
            return skin, -110   # 負の値は「肌色判定も併用する」の印
    # 手袋: 暗くない画素の塊のうち、両端のいちばん下のもの
    cand = m & (lum(px) >= 60)
    # 色が近い画素どうしだけをつなぐため、色を粗く量子化してから塊にする
    best = {}
    q = (px[..., :3] // 48).astype(int); key = q[..., 0] * 100 + q[..., 1] * 10 + q[..., 2]
    for k in np.unique(key[cand]):
        for side, pts in edge_blobs(front, hem, cand & (key == k)).items():
            if len(pts) >= 5 and (side not in best or max(p_[0] for p_ in pts) > max(p_[0] for p_ in best[side])):
                best[side] = pts
    if len(best) < 2:
        return None, 0
    cols = np.array([px[y, x, :3] for pts in best.values() for y, x in pts])
    return np.median(cols, 0), 40


def find_hands(cell, hem, hand, d):
    """手の塊を探す。戻り値: [mask, ...]"""
    color, tol = hand
    if color is None:
        return []
    m = cell[..., 3] > 0
    y0, y1 = hand_zone(cell, hem)
    px = cell.astype(float)
    dist = np.abs(px[..., :3] - color).sum(-1)
    cand = m & (dist < abs(tol)) & (lum(px) >= 60)
    if tol < 0:
        cand &= is_skin(px)
    cand[:y0] = False; cand[y1 + 1:] = False
    xs_all = np.where(m[y0:y1 + 1].any(0))[0]
    xl, xr = xs_all.min(), xs_all.max()
    found = []
    for pts in components(cand):
        ys = [q[0] for q in pts]; xs = [q[1] for q in pts]
        if not (2 <= len(pts) <= 20 and max(xs) - min(xs) < 6 and max(ys) - min(ys) < 6):
            continue
        side = 'L' if (min(xs) + max(xs)) / 2 < (xl + xr) / 2 else 'R'
        if d not in ('W', 'E'):
            # 横向き以外は、その行で体の端に近い塊だけ(ベルトの金具やポーチを除く)
            rows = sorted(set(ys))
            rl = min(np.where(m[y])[0].min() for y in rows)
            rr = max(np.where(m[y])[0].max() for y in rows)
            if not (min(xs) - rl <= 3 or rr - max(xs) <= 3):
                continue
        score = float(np.mean([dist[y, x] for y, x in pts])) - 0.5 * len(pts)
        found.append((score, side, pts))
    found.sort(key=lambda t: t[0])
    keep = []
    if d in ('W', 'E'):
        keep = found[:1]          # 横向きは見えている手1つ
    else:
        for side in ('L', 'R'):   # それ以外は左右1つずつ
            keep += [f for f in found if f[1] == side][:1]
    hands = []
    for _, _, pts in keep:
        hm = np.zeros_like(m)
        for y, x in pts:
            hm[y, x] = True
        hands.append(hm)
    return hands


def _nb4(y, x, H, W):
    return [(ny, nx) for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1))
            if 0 <= ny < H and 0 <= nx < W]


def grow_hand(src, hm, skin):
    """手の色に近い隣の画素も手に含める(取り残した肌色が伸びて見えるのを防ぐ)。
    手袋は服や小物と色が近いので、広げる幅を狭くする。"""
    H, W = hm.shape
    px = src.astype(float)
    dark = lum(px) < 60
    solid = src[..., 3] > 0
    mean = px[hm][:, :3].mean(0)
    hand = hm.copy()
    for _ in range(2):
        add = [q for y, x in zip(*np.where(hand)) for q in _nb4(y, x, H, W)
               if solid[q] and not hand[q] and not dark[q] and (
                   np.abs(px[q][:3] - mean).sum() < (100 if skin else 45)
                   or (skin and px[q][0] - px[q][1] > 20 and px[q][0] - px[q][2] > 35))]
        if not add or hand.sum() + len(add) > 26:
            break
        for q in add:
            hand[q] = True
    return hand


def ring_of(src, fill):
    """塗りに接する暗い画素(輪郭線)。"""
    H, W = fill.shape
    dark = (lum(src.astype(float)) < 60) & (src[..., 3] > 0)
    ring = np.zeros_like(fill)
    for y, x in zip(*np.where(fill)):
        for ny, nx in _nb4(y, x, H, W):
            if dark[ny, nx] and not fill[ny, nx]:
                ring[ny, nx] = True
    return ring


def shift_hand(img, hm, dx, dy, skin):
    """手を輪郭線ごと (dx,dy) 動かす。空いた所は、動く向きと逆側にある画素で埋める
    (下げれば上の袖が伸び、上げれば手の下にあったものが出る)。"""
    if dx == 0 and dy == 0:
        return
    src = img.copy()
    H, W = hm.shape
    hand = grow_hand(src, hm, skin)
    move = hand | ring_of(src, hand)
    for y, x in zip(*np.where(move)):
        by, bx = y - dy, x - dx
        while 0 <= by < H and 0 <= bx < W and move[by, bx]:
            by -= dy; bx -= dx
        img[y, x] = src[by, bx] if (0 <= by < H and 0 <= bx < W) else 0
    for y, x in zip(*np.where(move)):
        if 0 <= y + dy < H and 0 <= x + dx < W:
            img[y + dy, x + dx] = src[y, x]
    # 動かした跡に、体から1ドットだけ飛び出した線が残ったら消す
    ys, xs = np.where(move)
    for _ in range(2):
        for y in range(max(1, ys.min() - 3), min(H - 1, ys.max() + 4)):
            for x in range(max(1, xs.min() - 3), min(W - 1, xs.max() + 4)):
                if img[y, x, 3] == 0 or lum(img[y, x].astype(float)) >= 60:
                    continue
                now = sum(1 for q in _nb4(y, x, H, W) if img[q][3] > 0)
                before = sum(1 for q in _nb4(y, x, H, W) if src[q][3] > 0)
                if now <= 1 and (before >= 2 or src[y, x, 3] == 0):
                    img[y, x] = 0


def tidy(frame, stand):
    """仕上げ。立ち絵には無かった「1ドットだけの飛び出し」を消し、「1ドットの穴」を埋める。"""
    H, W = frame.shape[:2]
    ms = stand[..., 3] > 0

    def n4(m, y, x):
        return int(m[y - 1, x]) + int(m[y + 1, x]) + int(m[y, x - 1]) + int(m[y, x + 1])

    m = frame[..., 3] > 0
    for y in range(1, H - 1):
        for x in range(1, W - 1):
            if m[y, x] and n4(m, y, x) <= 1 and not (ms[y, x] and n4(ms, y, x) <= 1):
                frame[y, x] = 0
    m = frame[..., 3] > 0
    for y in range(1, H - 1):
        for x in range(1, W - 1):
            if not m[y, x] and n4(m, y, x) == 4 and not (not ms[y, x] and n4(ms, y, x) == 4):
                # まわりで一番暗くない色(塗り)を優先して埋める
                nb = [frame[y - 1, x], frame[y + 1, x], frame[y, x - 1], frame[y, x + 1]]
                frame[y, x] = max(nb, key=lambda c: float(lum(c.astype(float))))
    return frame


def make_frames(cell, d, leg_h, hand_color=(None, 0)):
    """戻り値: (left, stand, right, info, near_mask, far_mask)"""
    m = cell[..., 3] > 0
    bottom = np.where(m.any(1))[0].max()
    top = bottom - leg_h + 1
    L, R, how = split_legs(cell, top, bottom)
    info = dict(dir=d, top=int(top), bottom=int(bottom), split=how)
    if L is None:
        return cell, cell, cell, info, None, None
    legmask = L | (R if R is not None else False)
    body = take(cell, m & ~legmask)
    lift = 2 if leg_h >= 3 else 1
    stride = 3 if leg_h >= 5 else 2   # 脚が短い(ローブなど)ときは小さく
    fx, fy = FACE[d]
    skin = hand_color[1] < 0
    bend = leg_h >= 5   # 脚が短い(ローブなど)ときは曲げずに塊ごと動かす

    hands = find_hands(cell, top - 1, hand_color, d)
    info['hands'] = len(hands)
    cx = np.where(m.any(0))[0]; cx = (cx.min() + cx.max()) / 2.0

    def hand_side(hm):
        return 'L' if np.where(hm.any(0))[0].mean() < cx else 'R'

    def compose(parts, fwd_side):
        """parts: 脚の層と動かす量。fwd_side: 前に出ている脚の側('L'/'R')、横向きは 'near'/'far'。"""
        c = np.zeros_like(cell)
        for layer, dx, dy, bend in parts:
            put(c, layer, dx, dy, top, bottom, bend)
        b = body.copy()
        for hm in hands:
            if d in ('W', 'E'):
                # 見えている手前の腕は、手前の脚と逆に振る
                shift_hand(b, hm, (-2 if fwd_side == 'near' else 2) * fx, 0, skin)
            else:
                # 前に出た脚と反対側の手が前。前後は画面の上下で表す(手前向きなら前=下)
                fwd = hand_side(hm) != fwd_side
                shift_hand(b, hm, 0, fy if fwd else -fy, skin)
        # 持ち上げた脚が裾より上に出ないよう、胴体を最後に重ねる
        over(c, b)
        return tidy(c, cell)

    if d in ('S', 'N'):
        if R is None:  # 分けられないときは中央で割る
            xs = np.where(L.any(0))[0]; mid = (xs.min() + xs.max()) // 2
            R = L.copy(); R[:, :mid + 1] = False; L = L.copy(); L[:, mid + 1:] = False
            info['split'] = 'center'
        lL, lR = take(cell, L), take(cell, R)
        left = compose([(lR, 0, 0, False), (lL, 0, -lift, False)], 'L')
        right = compose([(lL, 0, 0, False), (lR, 0, -lift, False)], 'R')
        near, far = L, R
    elif d in ('W', 'E'):
        whole = take(cell, legmask)
        far_l = darker(whole)
        s = stride * fx
        # 手前の脚が前 / 奥の脚が前。後ろにある脚は1ドット上げる
        left = compose([(far_l, -s, -1, bend), (whole, s, 0, bend)], 'near')
        right = compose([(far_l, s, 0, bend), (whole, -s, -1, bend)], 'far')
        near, far = legmask, None
    else:
        near_side = NEAR_SIDE[d]
        far_side = 'R' if near_side == 'L' else 'L'
        if R is None:
            # 脚を分けられない向き(ローブなど): 塊と暗い複製を小さく前後へ
            whole = take(cell, L)
            far_l = darker(whole)
            left = compose([(far_l, -fx, 0, bend), (whole, fx, 0, bend)], near_side)
            right = compose([(far_l, fx, 0, bend), (whole, -fx, 0, bend)], far_side)
            near, far = L, None
        else:
            nm, fm = (L, R) if near_side == 'L' else (R, L)
            ln, lf = take(cell, nm), take(cell, fm)
            sn = -1 if near_side == 'L' else 1
            # 前に出す脚が相手の脚の側へ動く歩(交差)は、横には動かさず片脚を持ち上げる。
            # 離れる側へ動く歩(開き)は、前の脚を大きく、後ろの脚を小さく動かす。
            # 足は基準線より下へ出さない: 画面で奥になる側の脚を上げる。
            up_f, up_b = min(0, fy), min(0, -fy)

            def step(fwd_layer, back_layer, crossing):
                if crossing:
                    return [(back_layer, 0, lift * up_b, False), (fwd_layer, 0, lift * up_f, False)]
                return [(back_layer, -fx, up_b, bend), (fwd_layer, 2 * fx, up_f, bend)]

            cross1 = (fx == -sn)          # 手前の脚を前に出すと交差するか
            p1 = step(ln, lf, cross1)
            p2 = step(lf, ln, not cross1)
            # 奥の脚を先に描く
            p1 = sorted(p1, key=lambda t: t[0] is ln)
            p2 = sorted(p2, key=lambda t: t[0] is ln)
            left = compose(p1, near_side)
            right = compose(p2, far_side)
            near, far = nm, fm
    return left, cell, right, info, near, far


def main(src, outdir):
    out = Path(outdir); out.mkdir(parents=True, exist_ok=True)
    a = np.array(Image.open(src).convert('RGBA'))
    H, W = a.shape[:2]
    nchar = W // CELL
    report = []
    for c in range(nchar):
        cells = [a[r * CELL:(r + 1) * CELL, c * CELL:(c + 1) * CELL].copy() for r in range(8)]
        leg_h = leg_height_from_front(cells[0])
        fm = cells[0][..., 3] > 0
        hem0 = np.where(fm.any(1))[0].max() - leg_h
        hand_color = learn_hand_color(cells[0], hem0)
        sheet = np.zeros((8 * CELL, 3 * CELL, 4), np.uint8)
        ov = np.zeros((CELL, 8 * CELL, 4), np.uint8)
        frames = []
        for r, d in enumerate(DIRS):
            l, s, rr, info, near, far = make_frames(cells[r], d, leg_h, hand_color)
            hands = find_hands(cells[r], info['top'] - 1, hand_color, d)
            info['char'] = c; info['leg_h'] = int(leg_h); report.append(info)
            for k, f in enumerate((l, s, rr)):
                sheet[r * CELL:(r + 1) * CELL, k * CELL:(k + 1) * CELL] = f
            o = cells[r].copy()
            if near is not None:
                o[near] = (o[near] * 0.35 + np.array([255, 40, 40, 255]) * 0.65).astype(np.uint8)
            if far is not None:
                o[far] = (o[far] * 0.35 + np.array([40, 90, 255, 255]) * 0.65).astype(np.uint8)
            for hm in hands:
                o[hm] = (o[hm] * 0.3 + np.array([40, 230, 80, 255]) * 0.7).astype(np.uint8)
            ov[:, r * CELL:(r + 1) * CELL] = o
            frames.append((l, s, rr))
        Image.fromarray(sheet).save(out / f'char{c}_walk.png')
        bg = Image.new('RGBA', (8 * CELL, CELL), (90, 90, 90, 255))
        bg.alpha_composite(Image.fromarray(ov))
        bg.resize((8 * CELL * 6, CELL * 6), Image.NEAREST).save(out / f'char{c}_detect_x6.png')
        # 全コマ一覧(下半分を6倍)
        pv = Image.new('RGBA', (8 * 3 * 30, 26), (90, 90, 90, 255))
        for r in range(8):
            for k in range(3):
                crop = Image.fromarray(frames[r][k]).crop((9, 22, 39, 48))
                pv.alpha_composite(crop, ((r * 3 + k) * 30, 0))
        pv.resize((pv.width * 6, pv.height * 6), Image.NEAREST).save(out / f'char{c}_legs_x6.png')
        # GIF: 8方向を横に並べ、左足→立ち→右足→立ち
        gifs = []
        for k in (0, 1, 2, 1):
            fr = Image.new('RGBA', (8 * CELL, CELL), (90, 90, 90, 255))
            for r in range(8):
                fr.alpha_composite(Image.fromarray(frames[r][k]), (r * CELL, 0))
            gifs.append(fr.resize((8 * CELL * 4, CELL * 4), Image.NEAREST).convert('P', palette=Image.ADAPTIVE))
        gifs[0].save(out / f'char{c}_walk_x4.gif', save_all=True, append_images=gifs[1:], duration=160, loop=0)
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1))
    for r in report:
        print(r)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
