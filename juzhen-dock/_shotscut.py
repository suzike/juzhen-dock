# -*- coding: utf-8 -*-
"""把截图裁成 README 用的图，并压到合理体积。两批：

  A. 浏览器原型（_shots21/）—— 面板是 fixed 在右侧 580px 的浮层（_css.txt:133），
     1600 宽视口里左边 1000px 全是虚化壁纸。裁到 [950,1600]：
       · 留 58px 桌面 —— 面板阴影还完整，看得出"浮在桌面上"；
       · 不再往左 —— 页面级 .dock 占 x∈[680,920]（left:50% 居中），
         裁到 880 时会露出它的残缺一角，很怪。

  B. Electron 自检（userData/juzhen-dock-diag/）—— 1023x1530 = 680x1020 @1.5x DPI
     的整个窗口，已是纯面板，无需裁切，等比缩到同一宽度即可。

为什么不用 JPEG：截图全是小字与 1px 描边，JPEG 的块效应会把字糊掉。
改用调色板量化（UI 截图颜色数本来就少），体积降到 1/8 且文字锐利。
"""
import os
from PIL import Image

# 仓库根 = 本脚本上两级（juzhen-dock/juzhen-dock/ → 仓库根）。
# 原先写死在作者旧工作区的绝对路径上，换一台机器就拍不出 README 配图。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_BROWSER = os.path.join(ROOT, 'juzhen-dock', '_shots21')
SRC_DESK = os.path.join(os.environ['APPDATA'], 'juzhen-dock-diag')
DST = os.path.join(ROOT, 'docs', 'screenshots')
os.makedirs(DST, exist_ok=True)

W = 650            # 输出统一宽度
BROWSER_CROP_L = 950

BROWSER = [
    ('01_today.png',      '01-today.png'),
    ('02_folders.png',    '02-folders.png'),
    ('03_staging.png',    '03-staging.png'),
    ('04_calc.png',       '04-calc.png'),
    ('05_themes.png',     '05-themes.png'),
    ('06_search.png',     '06-search.png'),
    ('08_theme_blue.png', '08-theme-blue.png'),
    ('13_theme_dark.png', '13-theme-dark.png'),
]
# 桌面版专有：浏览器里根本不渲染（DESK 分流），只能取自检截图
DESK = [
    ('_desk_term2.png',    '09-terminal.png'),
    ('_desk_term_more.png', '10-terminal-more.png'),
    ('_desk_zones.png',    '11-zones.png'),
    ('_desk_ai_chips.png', '12-ai-models.png'),
]

def emit(im, dst_name):
    scale = W / im.size[0]
    im = im.resize((W, round(im.size[1] * scale)), Image.LANCZOS)
    q = im.quantize(colors=256, method=Image.FASTOCTREE, dither=Image.FLOYDSTEINBERG)
    dst = os.path.join(DST, dst_name)
    q.save(dst, 'PNG', optimize=True)
    sz = os.path.getsize(dst)
    print('%-24s %4dx%-5d %5d KB' % (dst_name, im.size[0], im.size[1], sz / 1024))
    return sz

total = 0
print('── 浏览器原型 ' + SRC_BROWSER)
for a, b in BROWSER:
    p = os.path.join(SRC_BROWSER, a)
    if not os.path.exists(p):
        print('★ 缺 ' + a); continue
    im = Image.open(p).convert('RGB')
    im = im.crop((BROWSER_CROP_L, 0, im.size[0], im.size[1]))
    total += emit(im, b)

print('── Electron 自检 ' + SRC_DESK)
for a, b in DESK:
    p = os.path.join(SRC_DESK, a)
    if not os.path.exists(p):
        print('★ 缺 ' + a); continue
    total += emit(Image.open(p).convert('RGB'), b)

print('──── 合计 %.2f MB / %d 张' % (total / 1024 / 1024, len(os.listdir(DST))))
