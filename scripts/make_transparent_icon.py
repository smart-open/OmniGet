# 图标背景透明化：深色底（近黑圆角方块）→ 透明，保留蓝色箭头与光晕。
# 原理：图标可视为「前景以 alpha 混合在深色底上」：P = F*a + BG*(1-a)。
# 反解：a = max_c((P_c - BG_c) / (255 - BG_c))，F = BG + (P - BG)/a。
# 光晕半透明过渡自然保留，任意深浅色底上合成均正确。
from PIL import Image
import numpy as np

SRC = r"d:\ai_work\OmniGet\build\icon-raw.png"

im = Image.open(SRC).convert("RGB")
arr = np.asarray(im).astype(np.float64)

# 背景色估计：外圈 8px 环的逐通道中位数
ring = np.concatenate([
    arr[:8].reshape(-1, 3), arr[-8:].reshape(-1, 3),
    arr[:, :8].reshape(-1, 3), arr[:, -8:].reshape(-1, 3)
])
bg = np.median(ring, axis=0)
print("bg =", bg)

diff = arr - bg  # 超出背景的部分即前景贡献
denom = 255.0 - bg
alpha = (diff / denom).max(axis=2)
alpha = np.clip(alpha, 0, 1)

# 反解前景色（alpha 为 0 处任意，置 0）
safe_a = np.maximum(alpha, 1e-6)[..., None]
fg = bg + diff / safe_a
fg = np.clip(fg, 0, 255)

# 噪声抑制：低 alpha 全部置零（去旧砖体轮廓残影），并对余下 alpha 重映射保持边缘平滑
CUT = 0.18
alpha[alpha < CUT] = 0
keep = alpha > 0
alpha[keep] = (alpha[keep] - CUT) / (1 - CUT)

out = np.dstack([fg, alpha * 255]).astype(np.uint8)
res = Image.fromarray(out, "RGBA")

res.resize((512, 512), Image.LANCZOS).save(r"d:\ai_work\OmniGet\build\icon.png")
res.resize((256, 256), Image.LANCZOS).save(r"d:\ai_work\OmniGet\resources\icon.png")
res.resize((256, 256), Image.LANCZOS).save(r"d:\ai_work\OmniGet\src\renderer\src\assets\logo.png")
print("done")
