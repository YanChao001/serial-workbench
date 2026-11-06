# 扩展界面 SDK

SDK 为 Serial Workbench 的隔离 HTML 插件界面提供全局对象 `starter`。包格式、权限、隔离和消息限额由 [扩展指南](../docs/extensions.md) 维护；默认产品范围见 [产品范围](../docs/product-scope.md)。

清单的视图命令声明 `ui.document: "main"`，文档放在 `ui/main.html`，打包时传入 `--ui-dir <目录>`。CSS、JavaScript、图片和框架构建结果均内嵌，打包步骤见 [自定义界面](../docs/extensions.md#自定义界面)。

宿主在文档开始时注入 [extension-ui.js](./extension-ui.js)，插件无需复制或加载运行时 SDK。外部作者将 `sdk/` 复制到独立项目即可使用 [extension-ui.d.ts](./extension-ui.d.ts)；至少保留该文件和 [generated/protocol.d.ts](./generated/protocol.d.ts)，无需检出宿主 `src/` 或安装 Tauri。公开 DTO 仍以 Rust 为类型来源，从生成绑定提取传递依赖，不携带宿主命令实现。

SDK 编译进 Rust，修改后须重新构建并重启桌面进程；新宿主会向已安装插件注入新 SDK。维护者修改 Rust DTO 后运行 `pnpm bindings:generate`，同时更新 IPC 与 SDK 公共类型；仅调整 SDK 引用范围时运行 `pnpm extension:sdk:generate`。对应的 `pnpm bindings:check` 和 `pnpm extension:sdk:check` 检查生成结果。

下面的界面显示当前视图，并运行它返回的首个可用动作：

```html
<button id="run" type="button" aria-disabled="true">运行动作</button>
<pre id="result"></pre>
<p id="status" role="status"></p>
<script>
  const button = document.querySelector("#run");
  const status = document.querySelector("#status");
  let actionId = null;
  let running = false;
  starter.onChange((snapshot) => {
    const action = snapshot.view?.groups
      .flatMap((group) => group.actions)
      .find((item) => !item.disabled);
    actionId = !snapshot.busy && snapshot.active !== false ? action?.id : null;
    button.textContent = action?.label ?? "暂无可用动作";
    button.setAttribute("aria-disabled", String(running || !actionId));
    document.querySelector("#result").textContent =
      snapshot.view?.display ?? "";
  });
  button.onclick = async () => {
    if (running || !actionId) return;
    const selectedAction = actionId;
    running = true;
    button.setAttribute("aria-disabled", "true");
    status.textContent = "";
    try {
      await starter.run(selectedAction);
    } catch {
      status.textContent = "运行失败，请检查输入后重试。";
    } finally {
      running = false;
      button.setAttribute("aria-disabled", String(!actionId));
    }
  };
  void starter.ready.catch(() => {
    status.textContent = "界面连接失败，请通过扩展工具重新加载。";
  });
</script>
```

| API                                  | 作者应处理的行为                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `ready`                              | 首次连接和快照可用时完成；不代表插件自己的异步业务已完成                                             |
| `onChange(listener)`                 | 订阅完整快照，返回取消订阅函数；包含视图、字段、检查点、活动状态、语言、主题、授权、忙碌和未保存状态 |
| `run(action, fields?)`               | 将提供的字段合并到当前已声明字段，调用本命令的 Wasm 函数                                             |
| `setFields(fields)`                  | 更新当前窗口的字段草稿，不运行 Wasm                                                                  |
| `checkpoint(value, dirty)`           | 登记 JSON 草稿及未保存状态；界面重建后从快照恢复，额度见[草稿契约](../docs/extensions.md#自定义界面) |
| `saveArtifact(index)`                | 保存当前视图的指定产物，用户选择系统路径；取消返回 `false`                                           |
| `notify(message, { tone }?)`         | 在宿主右下角显示纯文本 toast；`tone` 为 `info`（默认）、`success` 或 `error`                         |
| `applyStyles(shadowRoot)`            | 为本插件文档内的 Shadow DOM 接入默认控件样式和 select 增强，返回清理函数                             |
| `services.request(service, request)` | 调用下文的固定原生服务，不运行 Wasm                                                                  |

`run` 与 `setFields` 可一起提交父字段和关联选择；新选择可能不在上一轮 `options` 中，插件须按新上下文校验或规范化。字段声明、类型、额度及返回视图的完整边界见[视图与字段契约](../docs/extensions.md#开发带界面的应用插件)。

快照相互隔离，内部增量传输由 SDK 合并，作者无需处理协议。首个快照前通道关闭或解码失败会拒绝 `ready`，这些故障也会拒绝未完成请求；发送失败会拒绝对应调用。宿主返回的错误带稳定 `code` / `retryable`，按 `code` 映射本地化反馈，同时处理本地编码或通道异常，不解析错误文本。失败应保留输入，成功提示应等待真实回执。

每次 `run` 使用新的 Wasm 实例，跨动作状态通过协议传递，详见 [执行生命周期](../docs/extensions.md#执行存储与生命周期)。

`notify` 文本须非空、不含 NUL，UTF-8 最多 2 KiB；宿主标明插件名，同一会话的新提示替换上一条。这是应用 toast，不能发送操作系统通知。常驻说明、校验和重试入口遵循 [说明与布局稳定](../docs/conventions/ui-guidelines.md#说明与布局稳定)。

通过字段和检查点登记需要恢复的输入，业务保存完成后才报告 `dirty: false`。会话导入 / 导出与身份校验见 [会话契约](../docs/extensions.md#开发带界面的应用插件)。

隔离文档禁止表单提交、直接网络、跳转、弹窗、直接下载和浏览器存储；使用 `type="button"`、显式键盘事件和 SDK，不依赖默认 submit 或 `requestSubmit()`。外部字符串使用 `textContent` 或框架文本节点。自定义右键菜单须阻止默认行为，并处理键盘、Esc 和焦点恢复；默认右键与文本编辑行为遵循 [组件约定](../docs/conventions/ui-guidelines.md#组件选择顺序)。

原生宿主取消 Ctrl + `wheel`、`gesturestart` / `gesturechange` / `gestureend` 与页面缩放快捷键的默认动作，普通滚动保持默认行为。图片 / 画布仍可接收这些事件并缩放局部内容，处理器应接收 `defaultPrevented: true` 的手势。平台设置与硬件验收见 [宿主自定义界面](../docs/extensions.md#自定义界面)。

语言变化时，快照更新 `locale`，SDK 同步文档 `lang`；在 `onChange` 中重绘固定文案。宿主等待当前动作完成，再以 `action: null` 携带已有 state / fields 刷新活动页面的 Wasm 视图；隐藏页面恢复时刷新。插件应将 `action: null` 处理为保留会话、字段和检查点的纯渲染。

## 活动状态与页面保留

离页可能保留 iframe。`snapshot.active` 表示页面当前可见且可交互，使用 `snapshot.active !== false` 处理可选字段；独立窗口仍需结合文档可见性暂停工作。

页面不活动时，作者停止自己的动画帧、Web Animations、定时器和轮询；恢复后沿用模型继续，卸载时释放资源。SDK 同步根元素 `data-active`，自动暂停普通 DOM 与已登记 Shadow DOM 的 CSS animation、关闭增强 select 并停止主题过渡；作者的 JavaScript 循环由作者管理。`data-motion` 继续表示减少动效偏好。

隐藏时 SDK 和宿主桥均拒绝新请求，返回 `EXTENSION_UNAVAILABLE`；在途请求继续收到真实回执。编辑发生时及时登记字段 / 检查点，失败保留输入，恢复后由用户决定是否重试有副作用的操作。

超出保留范围或安装身份 / 权限失效时释放文档，重开从已登记状态恢复。宿主的保留额度、租约和回收规则见 [自定义界面](../docs/extensions.md#自定义界面)，取舍见 [ADR 0016](../docs/adr/0016-retain-extension-surfaces.md)。

## 默认外观与动效

通用界面复用宿主的 [共同外观规范](../docs/conventions/ui-guidelines.md#宿主与插件的共同外观)；业务专用视觉区域按该规范确定范围。作者维护布局与内容，共享控件 CSS 由宿主提供。

[surface-tokens.css](../src/styles/surface-tokens.css) 和 [control-styles.css](../src/styles/control-styles.css) 经 [ui-theme.ts](../src/lib/ui-theme.ts) 装配为 `theme.styles`，SDK 注入 `starter-defaults` layer。完整规则也适用于后插入的标准元素，普通作者 CSS 在该 layer 之上；共享样式更新随宿主交付，无需重打插件包。标准按钮支持 `data-variant`，材质容器使用 `data-surface`；具体角色见 [语义 token](../docs/conventions/ui-guidelines.md#颜色与材质)，尺寸和选择规则直接复用共享 CSS。

默认样式覆盖普通 DOM；Web Components 在创建 ShadowRoot 后调用 `starter.applyStyles(root)`，卸载时调用返回的清理函数，重复登记按引用计数释放。登记的 root 同步共享样式、主题和 select 增强，后插入控件无需重新登记。版本要求见 [兼容范围](../docs/extensions.md#架构与兼容范围)。

```javascript
const element = document.createElement("div");
document.body.append(element);
const root = element.attachShadow({ mode: "open" });
const disposeStyles = starter.applyStyles(root);
const button = document.createElement("button");
button.type = "button";
button.textContent = "Refresh";
root.append(button);
// 组件卸载时调用 disposeStyles()。
```

第三方自绘控件、Canvas / SVG 和平台子弹窗由作者负责接入。扩展外壳与文档默认透明，沿用宿主阅读保护；使用独立背景的业务区域负责文字和控件对比，iframe 模糊只能采样当前文档。

内容框占满侧栏右侧或独立窗口标题栏下的空间，文档默认 padding 为 1rem，以文档承担整页滚动。居中布局在内部容器设置 `max-width`、自动外边距和 padding；隔离文档按需出现滚动槽。独立窗口默认尺寸通过清单 `ui.windowSize` 声明，范围与记忆规则见 [应用窗口](../docs/extensions.md#开发带界面的应用插件)。

普通单选 `select` 默认增强为主题弹层，原 DOM 继续提供值、表单状态、reset、`input` / `change`、fieldset 禁用与 optgroup 语义。`multiple`、`size > 1` 或 `data-starter-select="native"` 使用原生交互。

`theme.tokens` 收集根元素公开主题变量并排除内部 `--tw-*`，同时提供 `--host-font-family` / `--host-font-size`；公开根变量用于外观，业务数据放模型或存储。`theme.styles` 仅随主题引用变化传递。字体、字号和语言继承宿主设置，输入字号断点以宿主窗口为准；代码输出可用等宽字体。

`theme.mode` 为 `light` / `dark` 并同步根 class，`theme.motion` 为 `full` / `reduced` 并同步 `data-motion`，SDK 同时遵循系统减少动效。活动界面及已登记 ShadowRoot 接收实时外观更新，隐藏页恢复时同步最新设置。持续动画还须处理 [活动状态](#活动状态与页面保留)、离屏、文档隐藏和卸载；主题过渡不可用或不适合播放时直接应用主题。

首次加载的骨架在非空视图、主题和 DOM 首轮呈现握手后解除，握手停滞时宿主提供重试，后台 / 离屏暂停等待计时。后续忙碌保持内容可见。作者的异步业务另外显示真实加载与失败反馈；样式检查入口见 [自定义扩展界面](../docs/testing.md#自定义扩展界面)。

## 注册的宿主服务

`starter.services.request(service, request)` 调用固定注册的服务。图片资源、图库单图预览、应用背景设置回执、外链和自身窗口有具体返回类型；`lan` 及其他 `wallpaper` 动作返回 `unknown`，须自行收窄。完整能力矩阵、动作、授权和额度见 [受控桌面服务](../docs/extensions.md#受控桌面服务)。

| 服务        | 调用方式与界面责任                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources` | `fetch-image` 传 `url` 和可选 `networkMode` / `preview` / `requestId`；返回元数据与句柄，供 `preview` / `save` / `release` 使用；`cancel-fetch` 合作取消 |
| `wallpaper` | 管理应用背景图库：元数据 `list`、按项 `preview`、本机 `import`、`import-resource`、`apply`、`rename`、`remove`、`open-settings`                          |
| `links`     | `{ url }` 请求打开 HTTPS 来源页，成功返回 `null`                                                                                                         |
| `lan`       | 局域网公告发现、手动连接、消息与受控附件传输、真实本机回环测试；多个窗口共享服务，明确停止会影响其他窗口                                                 |
| `window`    | `get-state` 读取自身独立原生窗口状态；`set-always-on-top` 传 `enabled` 切换置顶，均返回 `{ alwaysOnTop }`                                                |

应用背景 `apply` 返回保存回执，可直接更新已有图库的当前项与 revision：

```javascript
async function applyWallpaper(id, expectedRevision) {
  const result = await starter.services.request("wallpaper", {
    action: "apply",
    id,
    expectedRevision,
    fit: "cover",
  });
  return { activeId: result.activeId, revision: result.revision };
}
```

请求类型为 `ExtensionWallpaperApplyRequest`，返回 `ExtensionWallpaperApplyResult`。图库 `list` 只返回元数据，按可见卡片请求 `preview`，核对 ID / `previewKey` 后逐项填入缩略图。保存回执与预览各自更新，缩略图缺失也可继续使用列表。完整字段和并发规则见 [壁纸服务契约](../docs/extensions.md#壁纸图库与图片搜索)。

图片列表使用默认缩略图，用户查看大图时再请求 `size: "large"`；也可用 `fetch-image.preview` 一次取得句柄与预览。切图或关闭预览时以 `requestId` 调用 `cancel-fetch`，不再使用的句柄及时 `release`。另存、导入、取消回执和句柄寿命见 [图片资源契约](../docs/extensions.md#壁纸图库与图片搜索)。HTTP 与图片请求通常省略 `networkMode`，继承 [宿主网络偏好](../docs/extensions.md#来源与授权)。

LAN 界面按需调用 `start`，以 `status` 读取联系人、附近设备和消息；保留手动 IP 连接入口。列表按可见范围请求 `thumbnailAttachment`，用户查看大图时再请求 `previewAttachment`。附件通过原生对话框选择 / 另存，SDK 传消息 ID 与元数据。连接由原生窗口持有，切页和重建 iframe 后继续接收，多个窗口共享服务，明确停止会影响其他窗口。

附件进度使用独立的 `transferStatus` 查询，同一时间最多保留一个进度请求，可与 `sendAttachment` 并行。进度按阶段计数，送达以对端持久保存回执为准。清理历史前让用户确认本机会话范围；清理保留联系人和在途传输。动作字段、清理范围与终态规则见 [LAN 契约](../docs/extensions.md#局域网通信)。

服务请求不自动改变整个插件的 `busy`。将后台查询与用户操作分别管理，忽略早于业务操作的过期查询结果，保留新草稿、焦点和选区。按[消息桥额度与背压](../docs/extensions.md#自定义界面)限制请求并发；桥或 SDK 因超额返回 `EXTENSION_BUSY` 时该请求未执行，恢复容量后可重新发起，SDK 不自动重试。

原生对话框可等待用户选择，SDK 没有统一前端请求超时。停止等待不等于原生取消；未获回执时先核对操作结果，再决定是否显式重试。原生活动与回收见 [服务生命周期](../docs/extensions.md#受控桌面服务)，测试选择见 [验证入口](../docs/extensions.md#验证)。
