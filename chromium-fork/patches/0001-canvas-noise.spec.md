# Patch 0001 — Canvas Noise

**Phase**: A.3  **优先级**: P0  **难度**: ⭐⭐  **预期工时**: 4-6 周  
**依赖**: Patch 0014 Persona Bridge

## 目标

在 `<canvas>` 像素读取出口注入 per-persona PRNG 噪声，让 `getImageData` / `toDataURL` / `toBlob` 三个出口生成的 fingerprint hash 跨 persona 不同、同 persona 跨次启动稳定，绕过 BrowserScan / FingerprintJS Pro / CreepJS 的 canvas 检测。

## 噪声参数

- 振幅：每像素 RGB 三通道独立扰动 ±1 LSB（即 0 或 ±1，绝对值 ≤ 1/255）
- 选择率：每个像素 ~30% 概率被扰动（不是全部，避免均匀模糊检测）
- 种子：`xfnv1a(persona.canvas_seed + ":" + canvas_width + "x" + canvas_height)`
  - canvas_seed 由 patch 0014 通过 PersonaProfile 提供
  - 加宽高使不同尺寸 canvas 有不同 noise pattern（避免被反推 seed）
- PRNG：mulberry32（与 SDK humanize 引擎使用同一算法 → 跨 patch 输出一致性可验证）

## 触点文件（待 A.3 时确认精确行号）

```
third_party/blink/renderer/core/html/canvas/canvas_rendering_context_2d.cc
third_party/blink/renderer/core/html/canvas/canvas_async_blob_creator.cc
third_party/blink/renderer/modules/canvas/offscreencanvas/offscreen_canvas_rendering_context_2d.cc
third_party/blink/renderer/platform/graphics/static_bitmap_image.cc

# 如果走 GPU 加速 readback：
gpu/command_buffer/service/gles2_cmd_decoder.cc
```

## 实现要点

1. **三个出口共用同一个 `ApplyMosaiqNoise(SkBitmap*)` 函数**：
   - getImageData：在 SkBitmap 拷贝后、传给 V8 ImageData 前
   - toDataURL：在 PNG/JPEG encode 前
   - toBlob：在 async blob 创建前
2. **GPU 路径**：如果是 GPU canvas，readback 到 CPU 后注入；不在 GPU 端做（避免 ANGLE / Vulkan 各自适配）
3. **OffscreenCanvas 同步处理**：worker 内的 canvas 也要走同一函数

## 单元测试

```cpp
TEST(CanvasNoise, DeterministicAcrossInvocations) {
  PersonaProfile p; p.canvas_seed = "abc123";
  SkBitmap bm = MakeWhiteBitmap(100, 100);
  ApplyMosaiqNoise(&bm, p);
  uint32_t hash1 = HashBitmap(bm);
  
  SkBitmap bm2 = MakeWhiteBitmap(100, 100);
  ApplyMosaiqNoise(&bm2, p);
  uint32_t hash2 = HashBitmap(bm2);
  
  EXPECT_EQ(hash1, hash2);   // 同 persona 同 canvas → 同 hash
}

TEST(CanvasNoise, DistinctAcrossPersonas) {
  PersonaProfile p1; p1.canvas_seed = "abc123";
  PersonaProfile p2; p2.canvas_seed = "def456";
  // ... hash1 != hash2
}

TEST(CanvasNoise, VisualImperceptibility) {
  // 噪声后图像与原图 PSNR > 50 dB（视觉无感）
}
```

## 浏览器测（browser_test）

启动 chrome 用 3 个不同 persona id，依次访问 `https://browserleaks.com/canvas`，抓取页面里展示的 hash 字符串，断言三者两两不同。

## Done condition

1. **gtest 单测全过**
2. **跨 persona canvas hash 不同**：
   ```bash
   for id in p001 p002 p003; do
     ./out/Default/chrome --mosaiq-persona-id=$id \
       --headless --dump-dom \
       https://browserleaks.com/canvas \
       | grep -oP 'fingerprint":\s*"\K[^"]+'
   done
   # 输出三行不同的 hash
   ```
3. **同 persona 跨次启动 hash 一致**
4. **视觉 diff** PSNR > 50dB：肉眼不可分
5. **CreepJS** 检测页 canvas 检测项不报"hooked"

## 风险点

1. **GPU 加速绕过**：如果 canvas 走 GPU readback，CPU 端注入点漏掉 → 检测仍能拿到原始数据。要 trace 所有 readback 路径
2. **WebGL 透 canvas readback**：`gl.readPixels` 也是 fingerprint 来源，但属于 patch 0002 范围
3. **性能**：每帧 noise 注入若不优化，可能影响 canvas 重度页面（如 figma.com）。需 benchmark 决定是否仅对小尺寸 / 特定调用链注入

## 参考

- `docs/CHROMIUM-FORK-GUIDE.md` §3 Patch 0001
- 现有 fork 的 canvas patch 范例：[Brave shields/canvas](https://github.com/brave/brave-core/tree/master/browser/farbling)
- 检测原理：[CreepJS canvas trap](https://github.com/abrahamjuliot/creepjs)
