# 图标 v2 处理：Agnes 生成图（纯黑底）→ 透明背景 → 裁切字形包围盒 → 居中留 6% 边距
# 黑底反解（从黑色 unpremultiply）：alpha = max(r,g,b)/255，fg = pixel/alpha —— 光晕自然保留
from PIL import Image
import numpy as np

SRC = r"d:\ai_work\OmniGet\out\icon_v2_raw.png"

im = Image.open(SRC).convert("RGB")
arr = np.asarray(im).astype(np.float64) / 255.0

# 黑底反解
alpha = arr.max(axis=2)
safe_a = np.maximum(alpha, 1e-6)[..., None]
fg = np.clip(arr / safe_a * 255, 0, 255)
alpha8 = (alpha * 255).astype(np.uint8)

rgba = np.dstack([fg, alpha8]).astype(np.uint8)
img = Image.fromarray(rgba, "RGBA")

# 裁切字形包围盒（按 alpha > 8 判定有效像素）
ys, xs = np.where(alpha8 > 8)
box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
glyph = img.crop(box)

# 居中放入正方形画布：字形占 88%（比旧版明显更饱满）
gmax = max(glyph.size)
margin_ratio = 0.06
canvas = int(gmax / (1 - 2 * margin_ratio))
pad_x = (canvas - glyph.width) // 2
pad_y = (canvas - glyph.height) // 2
sq = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
sq.paste(glyph, (pad_x, pad_y), glyph)

# 输出各用途尺寸
sq.resize((512, 512), Image.LANCZOS).save(r"d:\ai_work\OmniGet\build\icon.png")
sq.resize((256, 256), Image.LANCZOS).save(r"d:\ai_work\OmniGet\resources\icon.png")
sq.resize((256, 256), Image.LANCZOS).save(r"d:\ai_work\OmniGet\src\renderer\src\assets\logo.png")
print(f"glyph bbox={box}, canvas={canvas}")
print("done")
