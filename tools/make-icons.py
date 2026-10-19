"""生成 lexiloop 应用图标（纯标准库 PNG，无第三方依赖）。

设计：NYU 紫底 + 三张叠放的白色卡片，最上层卡片带两条紫色文字条。
每个像素做 SS×SS 子采样，按预乘 alpha 求平均以得到平滑边缘。
"""
import math
import os
import struct
import zlib

OUT_DIR = r"C:\Users\cs198\WorkBuddy\2026-09-27-10-29-27\lexiloop"
SS = 4  # 每个像素的子采样边长

BRAND = (0x57, 0x06, 0x8C)
WHITE = (0xFF, 0xFF, 0xFF)

# 画布统一使用 48 单位坐标，与 icon.svg 保持一致
BACKGROUND = (0.0, 0.0, 48.0, 48.0, 13.0, 1.0, BRAND)
CARDS = [
    (10.0, 15.0, 34.0, 32.0, 4.0, 0.32, WHITE),
    (13.0, 11.0, 38.0, 29.0, 4.0, 0.62, WHITE),
    (16.0, 7.0, 42.0, 26.0, 4.5, 1.00, WHITE),
]
BARS = [
    (21.0, 13.0, 35.0, 15.6, 1.3, 1.00, BRAND),
    (21.0, 18.0, 30.0, 20.6, 1.3, 0.55, BRAND),
]


def rrect_dist(x, y, x0, y0, x1, y1, r):
    """点到圆角矩形边界的有符号距离（同一坐标单位）。"""
    cx = (x0 + x1) / 2.0
    cy = (y0 + y1) / 2.0
    hw = max(0.0, (x1 - x0) / 2.0 - r)
    hh = max(0.0, (y1 - y0) / 2.0 - r)
    dx = abs(x - cx) - hw
    dy = abs(y - cy) - hh
    return math.hypot(max(dx, 0.0), max(dy, 0.0)) + min(max(dx, dy), 0.0) - r


def inside(shape, x, y):
    x0, y0, x1, y1, r, alpha, _ = shape
    return alpha if rrect_dist(x, y, x0, y0, x1, y1, r) <= 0.0 else 0.0


def over(dr, dg, db, da, sr, sg, sb, sa):
    """source-over 合成，全部使用预乘 alpha。"""
    if sa <= 0.0:
        return dr, dg, db, da
    oa = sa + da * (1.0 - sa)
    return (sr * sa + dr * (1.0 - sa),
            sg * sa + dg * (1.0 - sa),
            sb * sa + db * (1.0 - sa),
            oa)


def sample(ux, uy):
    """返回该点的预乘 (r, g, b, a)。"""
    r = g = b = a = 0.0
    col = BACKGROUND[6]
    sa = inside(BACKGROUND, ux, uy)
    r, g, b, a = over(r, g, b, a, col[0] / 255.0, col[1] / 255.0, col[2] / 255.0, sa)
    for shape in CARDS + BARS:
        sa = inside(shape, ux, uy)
        col = shape[6]
        r, g, b, a = over(r, g, b, a, col[0] / 255.0, col[1] / 255.0, col[2] / 255.0, sa)
    return r, g, b, a


def clamp8(v):
    return max(0, min(255, int(round(v))))


def render(size):
    k = 48.0 / size
    total = float(SS * SS)
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            sr = sg = sb = sa = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    ux = (px + (sx + 0.5) / SS) * k
                    uy = (py + (sy + 0.5) / SS) * k
                    r, g, b, a = sample(ux, uy)
                    sr += r
                    sg += g
                    sb += b
                    sa += a
            sr /= total
            sg /= total
            sb /= total
            sa /= total
            if sa > 0:
                sr, sg, sb = sr / sa, sg / sa, sb / sa
            row += bytes([clamp8(sr * 255), clamp8(sg * 255), clamp8(sb * 255), clamp8(sa * 255)])
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


if __name__ == "__main__":
    for size in (192, 512):
        p = os.path.join(OUT_DIR, "icon-%d.png" % size)
        n = write_png(p, render(size), size)
        print("wrote %s (%d bytes)" % (p, n))
