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
  正面・背面 : 片脚を上へ持ち上げる。手は上下に1ドット
  斜め       : 手前の脚を進む向きへ、奥の脚を逆へ。手は進む向きに沿って1ドット
  横         : 脚の塊を前後へ。奥の脚は一段暗い複製。手は前後に2ドット
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
        if not (3 <= len(pts) <= 20 and max(xs) - min(xs) < 6 and max(ys) - min(ys) < 6):
            continue
        side = 'L' if (min(xs) + max(xs)) / 2 < (xl + xr) / 2 else 'R'
        if d in ('S', 'N') and not (min(xs) - xl <= 3 or xr - max(xs) <= 3):
            continue  # 正面・背面は体の端だけ(ベルトの金具などを除く)
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


def move_hand(img, hm, dx, dy):
    """手の塊(とそれに接する輪郭線)を (dx,dy) 動かす。空いた所は手の向こう側の色で埋める。"""
    if dx == 0 and dy == 0:
        return
    src = img.copy()
    H, W = hm.shape
    dark = lum(src.astype(float)) < 60
    grow = hm.copy()
    for y, x in zip(*np.where(hm)):
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < H and 0 <= nx < W and src[ny, nx, 3] > 0 and dark[ny, nx]:
                grow[ny, nx] = True
    # 空いた所を埋める: 動く向きと逆側の、手ではない画素の色
    for y, x in zip(*np.where(grow)):
        by, bx = y - dy, x - dx
        while 0 <= by < H and 0 <= bx < W and grow[by, bx]:
            by -= dy; bx -= dx
        if 0 <= by < H and 0 <= bx < W:
            img[y, x] = src[by, bx]
        else:
            img[y, x] = 0
    for y, x in zip(*np.where(grow)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < H and 0 <= nx < W:
            img[ny, nx] = src[y, x]


def make_frames(cell, d, leg_h, hand_color=(None, 0)):
    """戻り値: (left, stand, right, info)"""
    m = cell[..., 3] > 0
    bottom = np.where(m.any(1))[0].max()
    top = bottom - leg_h + 1
    L, R, how = split_legs(cell, top, bottom)
    info = dict(dir=d, top=int(top), bottom=int(bottom), split=how)
    if L is None:
        return cell, cell, cell, info, None, None
    legmask = L | (R if R is not None else False)
    body = take(cell, m & ~legmask)
    lift = 2 if leg_h >= 5 else 1
    stride = 3 if leg_h >= 5 else 2
    fx, fy = FACE[d]

    hands = find_hands(cell, top - 1, hand_color, d)
    info['hands'] = len(hands)
    cx = np.where(m.any(0))[0]; cx = (cx.min() + cx.max()) / 2.0

    def hand_side(hm):
        return 'L' if np.where(hm.any(0))[0].mean() < cx else 'R'

    def compose(parts, step):
        c = np.zeros_like(cell)
        for layer, dx, dy, bend in parts:
            put(c, layer, dx, dy, top, bottom, bend)
        b = body.copy()
        for hm in hands:
            side = hand_side(hm)
            if d in ('S', 'N'):
                # 上げた脚と反対側の手を前(上)へ、同じ側の手を後ろ(下)へ
                lifted = 'L' if step == 0 else 'R'
                move_hand(b, hm, 0, 1 if side == lifted else -1)
            elif d in ('W', 'E'):
                # 手前の脚が前のとき手は後ろへ
                move_hand(b, hm, (-2 if step == 0 else 2) * fx, 0)
            else:
                near = NEAR_SIDE[d]
                sgn = -1 if step == 0 else 1
                if side != near:
                    sgn = -sgn
                move_hand(b, hm, sgn * fx, sgn * fy)   # 進む向きに沿って前後へ
        # 持ち上げた脚が裾より上に出ないよう、胴体を最後に重ねる
        over(c, b)
        return c

    if d in ('S', 'N'):
        if R is None:  # 分けられないときは中央で割る
            xs = np.where(L.any(0))[0]; mid = (xs.min() + xs.max()) // 2
            R = L.copy(); R[:, :mid + 1] = False; L = L.copy(); L[:, mid + 1:] = False
            info['split'] = 'center'
        lL, lR = take(cell, L), take(cell, R)
        left = compose([(lR, 0, 0, False), (lL, 0, -lift, False)], 0)
        right = compose([(lL, 0, 0, False), (lR, 0, -lift, False)], 1)
        near, far = L, R
    elif d in ('W', 'E'):
        whole = take(cell, legmask)
        far_l = darker(whole)
        s = stride * fx
        # 手前の脚が前 / 奥の脚が前。後ろにある脚は1ドット上げる
        left = compose([(far_l, -s, -1, True), (whole, s, 0, True)], 0)
        right = compose([(far_l, s, 0, True), (whole, -s, -1, True)], 1)
        near, far = legmask, None
    else:
        if R is not None:
            # 片方の脚が細い切れ端しか見えていない向きは、分けずに一つの塊として扱う
            wl = np.ptp(np.where(L.any(0))[0]) + 1 if L.any() else 0
            wr = np.ptp(np.where(R.any(0))[0]) + 1 if R.any() else 0
            if min(wl, wr) < 4:
                L, R = legmask, None
                info['split'] += '>single'
        if R is None:
            whole = take(cell, L)
            far_l = darker(whole)
            v = fy if leg_h >= 5 else 0
            left = compose([(far_l, -2 * fx, -v, True), (whole, fx, v, True)], 0)
            right = compose([(far_l, 2 * fx, 0, True), (whole, -fx, -abs(v), True)], 1)
            near, far = L, None
        else:
            nm, fm = (L, R) if NEAR_SIDE[d] == 'L' else (R, L)
            ln, lf = take(cell, nm), take(cell, fm)
            k = 2 if leg_h >= 5 else 1
            v = fy if leg_h >= 5 else 0
            # 1歩目: 手前の脚が進行方向へ、奥の脚は逆へ。2歩目はその反対
            left = compose([(lf, -fx, -v, True), (ln, k * fx, v, True)], 0)
            right = compose([(lf, fx, v, True), (ln, -k * fx, -v, True)], 1)
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
