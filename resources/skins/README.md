# 矢量皮肤

透明线条 SVG 由 [skin-artwork.tsx](../../src/components/skin-artwork.tsx) 导入，窗口与缩略图共用 CSS 蒙版；[window-skins.css](../../src/styles/window-skins.css) 随主题和强调色着色。

维护时保持自包含静态线稿、中心留白，复用 defs/use。新增皮肤同步 [backgrounds.ts](../../src/lib/backgrounds.ts)、绘制映射和中英名称，稳定 ID 保留；纯色不加载纹理。

脚本/外链/动画/位图、滤镜和节点预算由 [window-background.test.tsx](../../src/components/window-background.test.tsx) 检查。核对明暗、最强档位、高对比、窄屏裁剪和缩略图；共用[界面规范](../../docs/conventions.md#界面)。

随包图片见 [wallpapers](../wallpapers/README.md)，用户图库保存 Host 文件引用，归属见[架构](../../docs/architecture.md#数据归属)。品牌图标/安装器源在 `resources/branding/`，使用独立生成流程。

| 稳定 ID    | 源文件                                     |
| ---------- | ------------------------------------------ |
| aurora     | [cat-doodles.svg](./cat-doodles.svg)       |
| dune       | [coffee-break.svg](./coffee-break.svg)     |
| inkwash    | [mountain-notes.svg](./mountain-notes.svg) |
| starlight  | [star-notes.svg](./star-notes.svg)         |
| sakura     | [cloud-notes.svg](./cloud-notes.svg)       |
| moonlit    | [moon-orbits.svg](./moon-orbits.svg)       |
| botanical  | [leaf-notes.svg](./leaf-notes.svg)         |
| cloudscape | [paper-flights.svg](./paper-flights.svg)   |
