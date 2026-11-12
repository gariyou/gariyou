"""autowalk.py の出力を機械的に点検する。

使い方 : python3 check.py <出力フォルダ>
各コマについて、立ち絵には無かった「1ドットの飛び出し」と「1ドットの穴」、
頭が動いていないか、立ち絵と同じまま(動いていない)でないかを調べる。
0件でも見た目の合格ではない。拡大画像と再生での確認は別に行う。
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image
DIRS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE']
def n4(m, y, x):
    return int(m[y-1, x]) + int(m[y+1, x]) + int(m[y, x-1]) + int(m[y, x+1])
bad = 0
files = sorted(Path(sys.argv[1]).glob('char*_walk.png'))
for c, path in enumerate(files):
    a = np.array(Image.open(path).convert('RGBA'))
    for r in range(8):
        st = a[r*48:(r+1)*48, 48:96]; ms = st[..., 3] > 0
        for k in (0, 2):
            f = a[r*48:(r+1)*48, k*48:(k+1)*48]; m = f[..., 3] > 0
            spikes = holes = 0
            for y in range(1, 47):
                for x in range(1, 47):
                    if m[y, x] and n4(m, y, x) <= 1 and not (ms[y, x] and n4(ms, y, x) <= 1):
                        spikes += 1; print('   spike at', (y, x))
                    if not m[y, x] and n4(m, y, x) == 4 and not (not ms[y, x] and n4(ms, y, x) == 4):
                        holes += 1; print('   hole at', (y, x))
            def eq(p, q):
                return (p[..., 3] == q[..., 3]).all() and (p[p[..., 3] > 0] == q[q[..., 3] > 0]).all()
            head_same = eq(f[:24], st[:24])
            same = eq(f, st)
            if spikes or holes or not head_same or same:
                bad += 1
                print(f'{path.name} {DIRS[r]} frame{k}: spikes={spikes} holes={holes} head_unchanged={head_same} identical_to_stand={same}')
print('problems:', bad)
sys.exit(1 if bad else 0)
