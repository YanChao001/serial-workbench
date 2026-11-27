# 串口工作台界面全局预规划

界面预规划从 [主导航与工作台](#导航与数据归属) 定位到 [界面位置](#界面位置)，再由 [需求落位表](#需求落位表) 查具体控件、反馈与关联入口。[打开可切换宽窄的草稿](./ui-wireframes.html)。需求矩阵的 244 项纳入范围和 3 项范围边界都有对应行。38 个草稿是定位用的布局样例，包括常显区、页签、工具窗、状态和设置项，合并或扩展时沿同一任务路径评审。

预留位置表示后续接入时应使用的页面、区块和状态。可用能力、入口显示条件及交付按 [需求矩阵](./requirements.md)、[状态账本](./feature-status.json) 和 [路线](./plan.md) 执行。具体场景优先参考 [已有的宽窄稿](./ui-design.md)，包括 Modbus、文件拖放、接管、独立扩展窗口及安装向导。

## 导航与数据归属

| 稳定入口                   | 用户要完成的事                                 | 内容跟随的对象                                                                   |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| 串口工作台 `/`             | 连接设备、观察或发送、使用当前会话的工具       | 当前 Host、设备、会话与代次。Raw、字段和图表的同一处选择关联到源事件和字节范围。 |
| 插件 `/plugins`            | 查看、安装、更新、启用扩展及入口               | 来源、版本、兼容性与执行信任。专业工具可从已授权会话直达。                       |
| 设置 `/settings`           | 调整全局偏好、管理本机对外入口、查看系统与更新 | 现有偏好或本机控制身份。更新、恢复、桌面与诊断沿用既有次级路由。                 |
| 工作台内的工具、任务与活动 | 进入当前会话的专项工具或查已受理动作的结果     | 打开工具时携带目标。任务和活动通过原操作定位，关闭视图后仍按 Host 回执更新。     |
| 平台原生界面               | 选择文件、处理系统授权、安装与卸载             | 发起动作的客户端和目标。对话框关闭后回到原字段、焦点和结果区。                   |

继承 [AppShell](../src/layouts/app-shell.tsx)、[路由元数据](../src/routes.tsx) 与命令目录。连接、观察和发送保留常显的位置。功能的配置、预览、确认与结果放在能完成同一个任务的容器。原界面的直接按钮、更多菜单和命令面板可以同时定位到该容器，名称、当前目标和可用条件从同一个入口定义取得。应用级偏好和本机权限在设置与本机确认处处理。

### 工作台工具的分组

更多菜单先呈现任务组，细项在同一列展开。工具内部再用现有页签和正文分区。已常显的设备库、录制等入口变窄时移到同名组。命令面板继续从现有命令与 Host 能力发现入口。会话对比用两个显式数据源，从观察组打开，接收视图切换区只承载当前视图。 [现有连接栏与更多菜单](../src/features/workbench/workbench-connection.tsx) · [命令绑定](../src/features/workbench/workbench-commands.tsx)

| 任务组       | 首选入口及下钻位置                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 连接与会话   | 设备库、会话控制、工作区配置与会话模板。局域网远端连接从当前连接入口选 Host，本机共享权限从设置管理。                                    |
| 观察与协议   | 会话对比、指标、协议分帧。字段只读结果留在数据区，协议构造与寄存器写回在对应的协议工具内确认。                                           |
| 传输与自动化 | 文件传输、序列、定时发送、广播、规则及测试。立即发送、命令库和发送配置保留在发送区。设备文件管理和烧录共享设备定位，各有操作表单和回执。 |
| 录制与回放   | 录制工具承载写盘配置，打开录制进入只读回放。导出和发送式回放各用明确的预览与确认。                                                       |
| 任务与诊断   | 任务查进度、停止和回执，活动查来源与跟随。当前会话诊断在原目标处打开，系统诊断和更新从设置进入。                                         |

```text
应用外壳与导航         串口工作台     插件     设置
串口工作台的连接栏     工作区 / 会话 / 端口 / 参数 / 连接
当前会话的内容         Raw / 终端 / 字段与图表    原数据、来源、选区
当前会话的工具         协议 / 文件 / 录制回放 / 自动化 / 诊断
当前操作的后续         进度 / 停止 / 详情 / 真实回执
工作台发送区           草稿 / 模式 / 最终字节 / 发送
```

## 宽窄布局骨架

草稿提供 1240×760、840×600 和 420×460 三种检查窗口。宽稿展示展开导航用于检视空间，产品沿用默认收纳和用户保存的展开状态。产品以容器的实际可用宽度为准。缩窄时依次将次要操作收进菜单、详情移至正文之后或同一内容位、表单变一列。宽数据在自身区域滚动。字号增大、长英文标签和窄短视口同时出现时，连接、发送、关闭和停止依其所属容器保持可达。工具窗打开期间保留原草稿，操作焦点交给工具。

```text
宽工作台                                                     窄短工作台
[应用菜单]   串口工作台      [命令] [主题]                   [应用菜单]  串口工作台
[工作区 ▾] [COM7 ▾] [参数] [连接]  [工具] [任务]             [COM7 ▾] [参数] [连接] [更多]
[COM7] [Virtual Echo]   当前目标和状态                       [COM7] [Virtual Echo]  ← 标签横滚
[文本] [HEX] [终端] [查找] [冻结]                            [观察视图 ▾] [查找] [更多]
接收正文、解析结果或图表   │ 可选来源／详情                  接收正文、结果或图表
正文独立滚动              │ 详情独立滚动                    正文独立滚动，次操作留在对应菜单
[HEX ▾] [草稿  FE 23         2 B] [发送]                    [HEX ▾] [草稿 2 B] [发送]
```

```text
宽工具与报告                                   窄工具与报告
任务名称 · 当前会话                  [关闭]   任务名称 · 当前会话       [关闭]
目标及适用页签                                 同一目标及页签，可横向浏览
标签      [控件]      标签  [控件]              标签
预览      数据区      来源／结果                [控件]     另一字段下排
正文区可滚动                                   预览、结果、详情按同顺序滚动
状态／验证错误              [主要动作]          状态与动作，短窗仍可到达
```

```text
宽插件与设置                                   窄插件与设置
[搜索]  列表／分类  │ 选中项、版本和权限        [搜索] [分类 ▾]
列表保持定位       │ 字段、作用域、预览         选中项、字段及就近状态
                  │ 反馈、详情和应用             [返回列表]  [应用]
```

尺寸、对齐和字体引用 [GUI 规范](./gui-design.md#控件文字与材质)。标题栏、工具行分别取 `--app-chrome-height`、`--app-toolbar-control-size`，普通页用共享表单和按钮，紧凑菜单用已有小尺寸。标签和控件按同一基线，窄窗标签挪到本控件上方。发送按钮与草稿框顶边和样例高度对齐，字节数留在框内右下。界面继承应用字体，终端和字节按终端字体或等宽，量值及时间采用等宽数字。草稿用白、浅中性和深中性区分阅读与控件，颜色仅辅助焦点、连通性和错误；主题和材质仍从 [主题刻度](../src/index.css) 及 [共享样式](../src/styles/control-styles.css) 获取。

## 界面位置

表中顺序从稳定入口到具体内容区。草稿支持切换位置、视口、语言、主题和示例状态。共用行为与范围边界以下表和需求矩阵为准。

<!-- prettier-ignore -->
| 区域 | 入口 | 宽窗 | 窄窗 | 参考 |
| --- | --- | --- | --- | --- |
| 应用外壳／[窗口与命令](./ui-wireframes.html#shell) | 应用标题栏、导航及帮助 | 应用菜单、命令面板、窗口状态 | 原位置保留单行，折叠菜单及侧栏 | [对照](../src/layouts/app-shell.tsx) |
| 工作台／[连接栏与会话标签](./ui-wireframes.html#session) | 顶部连接栏、下方会话标签 | 工作区、端口、参数、连接、会话及状态 | 次操作进菜单，连接与发送可达，标签独立滚动 | [对照](../src/features/workbench/workbench-connection.tsx) |
| 工作台／[设备库](./ui-wireframes.html#device) | 端口选择旁的设备管理入口 | 设备清单、最近／收藏、身份明细、重绑定 | 清单与详情顺序纵排，确认保留当前所选目标 | [对照](../src/features/workbench/device-library.tsx) |
| 工作台／[连接配置](./ui-wireframes.html#connection) | 连接栏的参数与连接配置 | 设备后端、基础参数、按类型展开的高级字段、实际读回 | 字段从共享标签列变为标签在上，反馈就近 | [对照](../src/features/workbench/serial-configuration-fields.tsx) |
| 工作台／[会话控制](./ui-wireframes.html#line) | 当前会话工具 → 会话控制 | 控制线、读入状态、Break、排空、清空、动作回执 | 各组降为单列，实际状态保持靠近动作 | [对照](../src/features/workbench/session-controls.tsx) |
| 工作台／[工作区与视图布局](./ui-wireframes.html#workspace) | 工作区菜单 → 编辑／布局 | 视图、会话模板、绑定、名称与颜色、导入预览、版本 | 结构导航收成选择器，次列移到当前视图后 | [对照](../src/features/workbench/workspace-editor.tsx) |
| 工作台／[原始流](./ui-wireframes.html#raw) | 中央接收区 → 文本／HEX | 方向时间、字节、查找过滤、选区、跟随、缺口 | 查找使用区内预留位，次动作进菜单，数据区独立滚动 | [对照](../src/features/workbench/stream-view.tsx) |
| 工作台／[终端](./ui-wireframes.html#terminal) | 当前会话的终端视图 | 屏幕、键盘模式、回滚搜索、连接及安全提示 | 终端保留字号和可用列，模式动作收进同组菜单 | [对照](../src/features/workbench/ansi-screen.tsx) |
| 工作台／[会话对比](./ui-wireframes.html#compare) | 当前会话工具 → 双会话对比 | 左右目标、对齐方式、两份独立数据和差异 | A、B 顺序纵排，各自可聚焦滚动 | [对照](./ui-design.md#双会话拆屏草稿disp-17) |
| 工作台／[字段与寄存器](./ui-wireframes.html#fields) | 接收区解码结果，写回从已授权的协议工具进入 | 字段、值、单位、质量、字节来源，支持从观察跳到对应工具的所选行 | 表格在数据区横滚，写回的目标和确认留在协议工具 | [对照](../src/features/workbench/modbus-register-tool.tsx) |
| 工作台／[图表与监控](./ui-wireframes.html#chart) | 当前会话的图表视图 | 数据源、范围、曲线或仪表、选点、读数、导出 | 保留图表与坐标，统计和来源下移 | [对照](../src/features/workbench/field-chart.tsx) |
| 工作台／[发送区](./ui-wireframes.html#send) | 常显底栏 | 模式、草稿、字节数、发送、失败及本次回执 | 次操作入菜单，草稿与主按钮保留可达 | [对照](../src/features/workbench/send-panel.tsx) |
| 工作台／[命令库与发送历史](./ui-wireframes.html#library) | 发送区 → 命令库／历史 | 分组、搜索、命令条目、正文、变量、预览、使用 | 列表先行，点选后进入编辑，返回保留草稿来源 | [对照](../src/features/workbench/command-library.tsx) |
| 工作台／[发送配置](./ui-wireframes.html#transform) | 发送区的配置菜单 | 行尾、编码、转义、字符映射、校验及前处理和最终样本 | 步序纵列，错误紧跟单步，预览与回执收进本组 | [对照](./ui-design.md#发送前预处理草稿io-15) |
| 工作台／[分帧与协议定义](./ui-wireframes.html#protocol) | 当前会话工具 → 协议分帧 | 分帧、字段、校验、模板、样本、未解析数据 | 配置先行，原字节与解析结果分别在内部滚动 | [对照](../src/features/workbench/framing-tool.tsx) |
| 工作台／[Modbus](./ui-wireframes.html#modbus) | 协议分帧中的 Modbus 工具区 | 报文、主站时序、寄存器与监视、从站模拟 | 保留页签顺序，实时写入、模拟和离线输出各有目标 | [对照](./ui-design.md#modbus-工作台入口与宽窄草稿) |
| 工作台／[协议候选与草案](./ui-wireframes.html#infer) | 协议分帧 → 样本分析／草案预览 | 样本范围、候选边界、依据、人工编辑与应用差异 | 样本摘要后按候选、依据、编辑、确认纵排 | [对照](../src/features/workbench/protocol-fields-tool.tsx) |
| 工作台／[文件传输](./ui-wireframes.html#transfer) | 更多工具 → 传输与自动化 → 文件传输，发送区保留同源快捷入口 | 源文件、字节范围、协议或裸传、速率、预览、进度 | 文件行与范围降列。当前目标、范围和短样本或样本状态与确认一起可见 | [对照](./ui-design.md#桌面文件拖放发送草稿) |
| 工作台／[设备文件与烧录](./ui-wireframes.html#flash) | 按支持能力进入设备文件管理或固件烧录，两者共用当前设备定位 | 文件管理选择固件接口、目录与对象，烧录选择配方、交接和逐台回执 | 各自先显示目标。文件操作结果在所选对象下，烧录结果展开在对应设备下 | [烧录交接基础](../crates/host/src/transmission/tool_handoff.rs) |
| 工作台／[发送任务与自动化](./ui-wireframes.html#schedule) | 当前会话工具 → 定时发送／命令序列／广播／规则／日历 | 目标、触发或步骤、发送预览、逐轮状态和停止 | 条件与结果依序纵排，步骤操作仍可键盘触达 | [对照](../src/features/workbench/command-sequence-tool.tsx) |
| 工作台／[脚本编辑与调试](./ui-wireframes.html#script) | 自动化工具内的脚本入口 | 脚本和运行时、工具权限、编辑、调试结果与输出 | 编辑居首，输出和变量移到正文后或同级切换位 | [对照](../packages/plugin-sdk/README.md) |
| 工作台／[测试套件与夹具](./ui-wireframes.html#suite) | 当前会话工具 → 测试用例与报告 | 用例、样本、输入行、断言、运行、报告与导出 | 用例选择与详情依序显示，长结果本区滚动 | [对照](../src/features/workbench/test-suite-tool.tsx) |
| 工作台／[录制](./ui-wireframes.html#capture) | 当前会话录制入口 → 录制工具 | 来源、文件、容量／分卷、脱敏、写入和验证水位 | 文件行降列，状态在操作下方，停止动作仍可达 | [对照](./ui-design.md#录制任务和证据草稿) |
| 工作台／[回放与证据导出](./ui-wireframes.html#replay) | 录制工具 → 打开录制／回放栏 | 录制来源、只读回放、索引、定位、导出与独立发送预览 | 搜索与定位进回放工具菜单，保持回放控制与退出 | [对照](./ui-design.md#录制内搜索草稿) |
| 工作台／[复现实验与共享](./ui-wireframes.html#experiment) | 工作区菜单 → 模板／复现实验包 | 配置与样本、版本依赖、差异和敏感正文预览、导入结果 | 清单、差异及确认按原顺序纵排 | [对照](./ui-design.md#复现实验包草稿) |
| 工作台／[任务与回执](./ui-wireframes.html#task) | 任务面板／当前操作的详情 | 目标、接纳、进度、停止等待、终态、真实回执 | 主项先显示名称与状态，详情下一行伸展 | [对照](../src/features/workbench/operation-panel.tsx) |
| 工作台／[活动跟随与接管](./ui-wireframes.html#activity) | 活动面板与任务原入口 | 来源、跟随窗口、输入、过程与结果、暂停及接管 | 进度与控制置于选中活动，层叠详情逐层退出 | [对照](../src/features/workbench/activity-panel.tsx) |
| 工作台／[指标与缺口](./ui-wireframes.html#metrics) | 会话状态栏 → 指标详情 | 字节、帧、队列、磁盘、时间源、读者与设备来源 | 常显指标保留少量关键项，分源详情按组折行 | [对照](../src/features/workbench/metrics-panel.tsx) |
| 工作台／[诊断与自检](./ui-wireframes.html#diagnostics) | 当前会话工具 → 诊断／环回自检，也可从设置打开全局诊断 | 目标、检查建议、接线、样本、报告及验证动作 | 按检查步骤纵排，异常靠近原步骤，报告单区滚动 | [对照](./ui-design.md#环回自检草稿diag-01line-15) |
| 工作台／[UART 波形与仪器](./ui-wireframes.html#waveform) | 诊断工具 → 波形／仪器来源 | 文件或仪器、采样率、方向、时间轴、位解码和证据 | 来源在上，波形区独立横滚，位详情顺接 | [对照](../packages/plugin-sdk/examples/uart-gold.ts) |
| 插件／[插件列表与详情](./ui-wireframes.html#plugin) | 主导航的插件 | 已安装、可用扩展、详情、来源、版本、信任、能力及管理 | 列表在前，详情进入同一路由内容区，支持返回定位 | [对照](../src/pages/plugins.tsx) |
| 插件／[插件视图与专业分析](./ui-wireframes.html#plugin-view) | 受信插件详情／当前工作台对应工具 | 插件内容、来源、范围、图表、专业结果与导出 | 插件接管正文后仍保留关闭，统计和报告下移 | [对照](./ui-design.md#m5-专业分析草稿) |
| 设置／[浏览器访问与接管确认](./ui-wireframes.html#access) | 设置 → 浏览器访问／本机确认 | 实际授权、下一次配对、一次性码、撤权和目标影响 | 标签、字段和复制纵排，关闭与拒绝始终可达 | [对照](./ui-design.md#浏览器配对与写入接管草稿) |
| 设置／[局域网共享与远端连接](./ui-wireframes.html#lan) | 设置 → LAN 访问，连接栏选择远端 Host | 本机共享、设备、对端身份、信任、读写租约和断网状态 | 共享与连接顺序纵排，目标及权限各自可读 | [对照](../src/features/lan/lan-access-settings.tsx) |
| 设置／[权限与来源管理](./ui-wireframes.html#security) | 设置中的安全项／相关插件或请求的本机确认 | 当前身份、目标范围、凭据引用、执行信任、授权和撤销 | 用户先看到作用目标及范围，确认前显示实际影响 | [对照](./architecture.md#安全与恢复) |
| 设置／[外观、输入与应用偏好](./ui-wireframes.html#preferences) | 设置搜索 → 对应设置项 | 主题、透明度、字体、编码默认值、语言、快捷键、通知、托盘 | 列数随实际容器降，错误和保存状态留在原设置项 | [对照](../src/pages/settings.tsx) |
| 设置／[系统状态、恢复与更新](./ui-wireframes.html#recovery) | 设置 → 更新／恢复／诊断入口 | 当前版本、就绪状态、回滚、原件、便携目录及接续动作 | 状态先行、操作下排，技术路径断行并提供复制 | [对照](./ui-design.md#启动恢复与发行草稿) |
| 系统界面／[平台原生交互](./ui-wireframes.html#native) | 应用触发的系统对话框、通知与安装向导 | 系统目标、文件或操作范围、确认或取消、应用接回结果 | 沿平台缩放与焦点，应用侧的来源、进度与终态仍靠近原入口 | [对照](./ui-design.md#m6-系统安装与卸载草稿) |
| 共用行为／共享契约与可观测行为 | 无独立页面，使用对应入口的状态、结果或证据 | 真实 API 回执、权限拒绝、性能、资源和无障碍证据 | 随所在容器走同一路径 | [对照](./requirements.md#全局要求) |
| 范围边界／范围外 | 保留矩阵中的排除或延期说明 | 在矩阵查出处 | 按后续范围评审安排 | [对照](./requirements.md#范围边界) |

## 交互与反馈

| 状态或动作                       | 固定位置与反馈                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 未连接、无样本或没有扩展         | 在所属区域保留目标与可继续的打开、选择、配置入口。支持的真实入口随当前能力可达。                                                                                   |
| 读取、查询或加载                 | 原处说明进度。已有结果仍对应同一有效目标时可保留并标明刷新状态。宽窄切换维持位置。                                                                                 |
| 错误、权限不足和撤权             | 字段错误就近显示，持续详情留在模块。撤权清掉该作用域失效的正文和预览，原因靠近动作。会话访问、本地偏好和设备的实际连接各自呈现，失去查询权限时连接状态为不可查询。 |
| 准备写入、破坏性操作或执行脚本   | 有固定操作栏时，把会影响确认判断的目标、范围、最终样本或影响留在动作旁。其余参数在正文滚动。样本不可用时替换为实际状态，继续按既有动作资格处理。                   |
| 已接纳、正在运行、等待停止、终态 | 原操作显示进度和停止，任务区查询同一操作。发起停止后显示等待；终态按真实回执区分已停止、部分写入和无法确认。切换会话或失去观察权限时，后台结果按原任务归属结算。   |
| 键盘、关闭和焦点                 | 主工作台从应用导航、连接目标、会话、数据、发送区依序到达。工具窗打开到合适的可操作字段，选取文件或关闭最内层详情后返回对应触发处。危险确认先保留取消路径。         |
| 宽表、长正文和窄短窗口           | 表格、HEX、波形在自身区域横滚，工具正文承担纵向滚动。长普通文本自然换行，文件路径和证据能完整查看或复制。                                                          |

源会话、权限、目标和作用域来自动作实际结果。UI 草稿中的目标和回执为固定样例。真实发送、保存、安装、撤权及恢复的确认与证据遵守 [专项验收](./acceptance.md)。

## 需求落位表

每行的首个区域优先定位主任务或状态，其后的区域给出同源快捷入口、前置配置或结果。需求包含两个不同用户意图时，在本行分别写明完成位置，例如 IO-18 的文件发送和命令正文导入。布局样例用于核对承载方式，实际控件、权限和平台行为沿用对应场景及验收。共用行为项在所在真实场景取证，范围外项保留排除或延期原因。

### 设备与连接（CONN）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `CONN-01` 端口枚举与友好名 | [连接栏与会话标签](./ui-wireframes.html#session) · [设备库](./ui-wireframes.html#device) | 端口选择项并排给出 COM7、设备名和连接类型。设备详情展开厂商、驱动和字段缺失说明。 |
| `CONN-02` 热插拔实时刷新 | [设备库](./ui-wireframes.html#device) · [连接栏与会话标签](./ui-wireframes.html#session) | 设备列表原地增删，行以稳定身份定位。移除的当前设备在原连接位置显示断开和待重连状态。 |
| `CONN-03` 设备指纹与稳定标识 | [设备库](./ui-wireframes.html#device) | 所选设备详情显示 VID/PID、序列号、路径与匹配依据。多个候选时保留差异对照和确认。 |
| `CONN-04` 最近使用与收藏 | [设备库](./ui-wireframes.html#device) · [连接栏与会话标签](./ui-wireframes.html#session) | 端口选择的最近和收藏分组。设备行保留收藏切换和上次配置摘要，失效时进入重绑定。 |
| `CONN-05` 多端口并行 | [连接栏与会话标签](./ui-wireframes.html#session) · [工作区与视图布局](./ui-wireframes.html#workspace) | 连接栏下每个物理会话一个标签，打开到新窗从标签菜单进入。切换只更新当前目标，各标签显示各自连通性。 |
| `CONN-06` 会话配置保存与加载 | [工作区与视图布局](./ui-wireframes.html#workspace) · [复现实验与共享](./ui-wireframes.html#experiment) | 编辑器按连接、视图和命令／脚本引用排组。保存修订与加载预览在底部，冲突和缺依赖紧邻对应项。 |
| `CONN-07` 自动重连 | [连接配置](./ui-wireframes.html#connection) · [连接栏与会话标签](./ui-wireframes.html#session) | 连接配置高级区填次数、间隔和退避。连接栏显示正在重连及手动停止，详情给出实际轮次和代次。 |
| `CONN-08` 端口占用检测与解释 | [连接栏与会话标签](./ui-wireframes.html#session) · [诊断与自检](./ui-wireframes.html#diagnostics) | 连接失败紧挨连接动作，详情显示占用、访问被拒或驱动问题。仅在有证据时展示占用者，保留排查入口。 |
| `CONN-09` 权限与驱动引导 | [诊断与自检](./ui-wireframes.html#diagnostics) | 选中系统的分步驱动和权限指南置于已失败的连接详情。列实际状态、用户要执行的步骤与返回原目标复查。 |
| `CONN-10` 连接时序编排 | [连接配置](./ui-wireframes.html#connection) · [发送任务与自动化](./ui-wireframes.html#schedule) | 连接配置负责选用和预览该时序。步骤编辑复用自动化的等待、控制线和就绪字节预览，执行详情逐步标记终态。 |
| `CONN-11` 虚拟串口对 | [设备库](./ui-wireframes.html#device) · [诊断与自检](./ui-wireframes.html#diagnostics) | 设备库中的虚拟端口区选择后端、两端名称与权限。创建结果显示两个端点、释放及失败清理状态。 |
| `CONN-12` 远程串口 | [连接配置](./ui-wireframes.html#connection) | 设备类型和客户端／监听角色置于连接配置顶部。主机、端口或 URL 按类型展开，协商及实际连接结果靠近字段。 |
| `CONN-13` 无线串口 | [连接配置](./ui-wireframes.html#connection) | 连接类型中的无线分支依能力呈现 SPP、BLE 或透传。发现、选择和连接状态按同一块设备表单展示。 |
| `CONN-14` USB 接口直连 | [连接配置](./ui-wireframes.html#connection) · [设备库](./ui-wireframes.html#device) | 设备详情显示 USB 接口类别、绑定驱动及权限，配置后只在适用设备上提供直连选项。 |
| `CONN-15` 统一连接抽象 | [连接栏与会话标签](./ui-wireframes.html#session) · 共享契约与可观测行为 | 各通道共用连接和会话位置，类型及已声明能力就近标示。只读文件／回放保留观察入口及不可用原因。 |
| `CONN-16` 运行中改参数 | [连接配置](./ui-wireframes.html#connection) · [会话控制](./ui-wireframes.html#line) | 从当前会话选应用参数，在每个修改字段对照请求和实际读回。部分或未知状态留在原处并说明后续 TX 条件。 |
| `CONN-17` 只读监听 / 共享打开 | [连接配置](./ui-wireframes.html#connection) · [连接栏与会话标签](./ui-wireframes.html#session) | 连接配置在支持的后端显示旁路监听方式和影响。监听标签显示来源及读写能力，无可用后端时给出原因。 |
| `CONN-18` 设备重绑定确认 | [设备库](./ui-wireframes.html#device) · [连接栏与会话标签](./ui-wireframes.html#session) | 重绑定确认显示原身份、候选和不同字段，用户确认后更新当前绑定，旁边展示是否恢复设备操作。 |
| `CONN-19` 移动端连接生命周期 | 范围外 | 移动端连接生命周期排除，桌面与配对浏览器按各自纳入条目落位。 |

### 线路参数与信号（LINE）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `LINE-01` 波特率预设 + 自定义 | [连接配置](./ui-wireframes.html#connection) | 基础参数首行复用可输入的波特率组合框，旁边预设。读回及外部测速在结果区分来源。 |
| `LINE-02` 数据位 5/6/7/8 | [连接配置](./ui-wireframes.html#connection) | 波特率下的「数据位」下拉列有效位宽，组合无效提示贴字段。 |
| `LINE-03` 校验位 None/Even/Odd/Mark/Space | [连接配置](./ui-wireframes.html#connection) | 同组「校验」下拉完整列出模式，驱动不支持时保持真实拒绝和上次读回。 |
| `LINE-04` 停止位 1/1.5/2 | [连接配置](./ui-wireframes.html#connection) | 同组「停止位」下拉随位宽展示组合约束，失败紧邻该行。 |
| `LINE-05` 流控 RTS-CTS / XON-XOFF / DSR-DTR / 无 | [连接配置](./ui-wireframes.html#connection) · [会话控制](./ui-wireframes.html#line) | 参数组的「流控」下拉就近显示占用的控制线。控制线动作区域沿用同一说明。 |
| `LINE-06` DTR/RTS 手动控制 | [会话控制](./ui-wireframes.html#line) | DTR 和 RTS 各占一行，置位／复位与目标对齐。待确认和实际输出来自同一动作回执。 |
| `LINE-07` 信号线实时状态面板 | [会话控制](./ui-wireframes.html#line) | 控制线区下方显示实际输入采样与时间，支持时展开边沿。读入与输出设定分别题注。 |
| `LINE-08` Break 信号收发 | [会话控制](./ui-wireframes.html#line) | Break 行提供时长和发送动作，显示置位、清除和未知终态。收到的 Break 在观测事件中可定位。 |
| `LINE-09` RS-485 方向控制 | [连接配置](./ui-wireframes.html#connection) · [会话控制](./ui-wireframes.html#line) | 高级连接配置的方向控制组提供后端模式、发送前后延时和回显抑制。应用前显示 RTS 归属和冲突。 |
| `LINE-10` 字符重映射 | [发送配置](./ui-wireframes.html#transform) · [原始流](./ui-wireframes.html#raw) | 发送配置和接收工具各显示自己的映射规则。两区共用规则编辑及前后样本，接收可回原字节，发送预览最终字节。 |
| `LINE-11` 收发模式独立 | [原始流](./ui-wireframes.html#raw) · [发送区](./ui-wireframes.html#send) | 接收栏和发送栏各有模式选择器。转换时保留各自稿件、字节语义和错误位置。 |
| `LINE-12` 输出节流 | [文件传输](./ui-wireframes.html#transfer) · [发送任务与自动化](./ui-wireframes.html#schedule) | 分片任务的高级组放字符／行／块间隔，靠近待写入字节和预计节流。执行按已确认字节与取消回执显示。 |
| `LINE-13` 自动波特率探测 | [连接配置](./ui-wireframes.html#connection) | 波特率字段旁放探测动作。选择候选轮试或线级采样，结果显示样本、置信依据并由用户应用候选。 |
| `LINE-14` 线路错误统计 | [指标与缺口](./ui-wireframes.html#metrics) · [会话控制](./ui-wireframes.html#line) | 指标详情的线路区列 driver／仪器来源和各错误计数。无事件能力显示原因，协议 CRC 仍留在协议结果。 |
| `LINE-15` 环回与误码自测 | [诊断与自检](./ui-wireframes.html#diagnostics) | 环回自检显示 TX/RX 接线和来源、种子、帧数与强度。逐帧结果可定位实际发送、比较和误码。 |
| `LINE-16` 排空清空与取消 | [会话控制](./ui-wireframes.html#line) · [任务与回执](./ui-wireframes.html#task) | 排空和 RX/TX 清空各有动作及范围。等候超时、已清范围、未知结果和原历史连续性留在详情。 |
| `LINE-17` 多种超时语义 | [连接配置](./ui-wireframes.html#connection) · [发送任务与自动化](./ui-wireframes.html#schedule) | 串口读取、发送和连接复试放各自配置组。分帧空闲与协议应答分别归对应工具，字段贴明单位和起算点。 |

### 终端（TERM）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `TERM-01` VT100/ANSI 基础序列 | [终端](./ui-wireframes.html#terminal) | 终端阅读区呈现 ANSI 屏幕，原始记录入口仍可达。模式说明位于终端工具栏。 |
| `TERM-02` 全屏应用兼容 | [终端](./ui-wireframes.html#terminal) | 终端正文支持备用屏幕及滚动区域，状态区保留观察尺寸及事件供回放。全屏应用继续使用同一终端。 |
| `TERM-03` 窗口尺寸协商 | [终端](./ui-wireframes.html#terminal) | 终端工具栏的尺寸详情展示当前行列、对端约定及最近结果，普通 UART 明确按 shell 或设备约定执行。 |
| `TERM-04` 键盘映射 | [终端](./ui-wireframes.html#terminal) · [窗口与命令](./ui-wireframes.html#shell) | 终端聚焦后才启用终端键模式。键位帮助从同一工具栏进入，冲突标明当前命令及焦点范围。 |
| `TERM-05` 多字符编码 | [终端](./ui-wireframes.html#terminal) · [原始流](./ui-wireframes.html#raw) | 接收显示工具条选当前解码，支持的 UTF-16 端序在选项或详情明示。换选后原字节位置可恢复。 |
| `TERM-06` 增量解码 | [终端](./ui-wireframes.html#terminal) · 共享契约与可观测行为 | 增量状态随接收和回放原处工作。非法或不完整序列在解码详情提示，保留对应字节范围。 |
| `TERM-07` 编码自动识别与乱码修复 | [原始流](./ui-wireframes.html#raw) · [终端](./ui-wireframes.html#terminal) | 编码菜单中的样本识别提供候选、依据、原样本与当前预览，显式更换解码后留存搜索选择。 |
| `TERM-08` 换行策略 | [终端](./ui-wireframes.html#terminal) · [发送配置](./ui-wireframes.html#transform) | 终端显示区配置接收换行／折行。发送配置单列追加行尾及最终样本，两区保留各自选择。 |
| `TERM-09` 本地回显 | [终端](./ui-wireframes.html#terminal) | 终端查看选项中的本地回显开关显示生效会话。键入与设备 RX 用方向语义区分。 |
| `TERM-10` 粘贴保护 | [终端](./ui-wireframes.html#terminal) · [任务与回执](./ui-wireframes.html#task) | 终端粘贴按目标展示字节量、分片或括号模式，需确认时焦点在预览。执行分片和停止结果进入任务。 |
| `TERM-11` 鼠标与超链接 | [终端](./ui-wireframes.html#terminal) · [权限与来源管理](./ui-wireframes.html#security) | 终端菜单按会话接通鼠标模式，聚焦才发送。可访问链接带宿主外链确认和实际结果。 |
| `TERM-12` 终端类型上报 | [终端](./ui-wireframes.html#terminal) | 终端工具栏的 Shell 配置组放 TERM、色彩、尺寸。生成的命令经预览和显式插入后进入发送流程。 |
| `TERM-13` 真彩色与 256 色 | [终端](./ui-wireframes.html#terminal) · [外观、输入与应用偏好](./ui-wireframes.html#preferences) | 终端屏幕和主题预览共用 ANSI 色板；原样本和选中位置在换主题时保留。 |
| `TERM-14` 可调字体与连字 | [外观、输入与应用偏好](./ui-wireframes.html#preferences) · [终端](./ui-wireframes.html#terminal) | 设置中的终端字体组用实时片段预览字号、行高与连字。终端本地缩放仍走同一设置。 |
| `TERM-15` 回滚缓冲 | [终端](./ui-wireframes.html#terminal) | 终端历史栏显示上限、保留范围、淘汰和返回最新；磁盘历史入口与实时滚动区分标示。 |
| `TERM-16` 会话内搜索 | [终端](./ui-wireframes.html#terminal) | 终端查找占同一搜索位，输入后显示匹配数、上一项和下一项；关闭恢复原阅读位置或焦点，另可查原始流。 |

### 发送与编辑（IO）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `IO-01` 多行编辑器 | [发送区](./ui-wireframes.html#send) | 发送底栏的草稿占最大宽度，行号缩进与注释在内部，编辑增高有上限，发送键与草稿顶边对齐。 |
| `IO-02` ASCII/HEX/混合输入 | [发送区](./ui-wireframes.html#send) | 模式切换保留草稿，编辑区预览 ASCII／HEX／混合语法的最终字节数和选区。 |
| `IO-03` 转义序列 | [发送区](./ui-wireframes.html#send) | 转义写法在编辑区选区帮助中可查，解析异常标草稿字符范围与更正方式。 |
| `IO-04` 输入合法性校验 | [发送区](./ui-wireframes.html#send) | 在无效 HEX 或转义的那一段显示即时错误，保留输入，发送入口说明不可提交原因。 |
| `IO-05` 行尾自动追加 | [发送配置](./ui-wireframes.html#transform) · [命令库与发送历史](./ui-wireframes.html#library) | 发送配置的行尾组展示默认值和合成顺序。命令详情显式标覆盖值，最终样本就近刷新。 |
| `IO-06` 发送历史 | [命令库与发送历史](./ui-wireframes.html#library) | 历史列表带搜索、固定、时间和目标。选中历史先回填并预览，批量项走命令序列的动作入口。 |
| `IO-07` 预定义命令库 | [命令库与发送历史](./ui-wireframes.html#library) | 命令库左侧分组分页，右侧命令标题、备注、正文和变量。排序、导入结果、导出及保存冲突留在所属组。 |
| `IO-08` 一键与热键发送 | [发送区](./ui-wireframes.html#send) · [外观、输入与应用偏好](./ui-wireframes.html#preferences) | 单次与按住动作归发送区。全局热键在快捷键配置注册／解决冲突，真实结果回当前草稿及任务。 |
| `IO-09` 定时与循环发送 | [发送任务与自动化](./ui-wireframes.html#schedule) | 定时发送页依序为周期、次数、抖动及起止条件，预览和逐轮应答、实际间隔及停止相邻。 |
| `IO-10` 命令序列 / 脚本化发送 | [发送任务与自动化](./ui-wireframes.html#schedule) | 命令序列页的步骤清单可排序及展开延时、变量、分支、循环与期望，执行后同一位置显示每步结果。 |
| `IO-11` 文件发送 | [文件传输](./ui-wireframes.html#transfer) · [任务与回执](./ui-wireframes.html#task) | 文件传输选择文件、范围、块及间隔，预览后显式发送，已读与已写范围及停止状态在共享回执可查。 |
| `IO-12` 大块粘贴分片 | [终端](./ui-wireframes.html#terminal) · [任务与回执](./ui-wireframes.html#task) | 与 TERM-10 同一粘贴预览和分片任务。分片编号、总量及取消后的真实写入范围置于结果详情。 |
| `IO-13` 校验自动追加 | [发送配置](./ui-wireframes.html#transform) | 发送配置的校验折叠组放算法、端序、计算范围和是否包含帧尾。预览展示最终追加字节。 |
| `IO-14` 帧模板拼装 | [分帧与协议定义](./ui-wireframes.html#protocol) · [发送区](./ui-wireframes.html#send) | 协议分帧的帧模板区呈现头、长、序号、负载、校验和尾，离线往返结果明确后再显式加入发送草稿。 |
| `IO-15` 发送前预处理 | [发送配置](./ui-wireframes.html#transform) | 预处理页按执行顺序列启用步骤、参数和所属扩展，显示每步输入／输出及错误。专业扩展可用时进入同组。 |
| `IO-16` 响应匹配与重试 | [发送任务与自动化](./ui-wireframes.html#schedule) · [任务与回执](./ui-wireframes.html#task) | 等待应答步骤内放匹配范围、超时、次数与幂等开关。逐次记录真实 TX、迟到应答及停止原因。 |
| `IO-17` 多端口广播 | [发送任务与自动化](./ui-wireframes.html#schedule) · [任务与回执](./ui-wireframes.html#task) | 广播页预览所选会话和共同负载。列表按目标显示独立回执、停止和拒绝原因。 |
| `IO-18` 拖拽发送 | [文件传输](./ui-wireframes.html#transfer) · [命令库与发送历史](./ui-wireframes.html#library) | 文件发送从「源文件」行进入，确认旁显示目标、范围和 HEX 样本。正文导入从命令编辑进入，先预览替换、应用到草稿、再保存。两处都保留等价的键盘选取入口。 |

### 显示与检索（DISP）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `DISP-01` 文本 / HEX 双视图 | [原始流](./ui-wireframes.html#raw) | 接收工具条固定文本／HEX 切换项，可选同源并排。窄屏保留单视图切换和原偏移。 |
| `DISP-02` HEX 格式化 | [原始流](./ui-wireframes.html#raw) | HEX 视图菜单放大小写、分组、地址栏、ASCII 和每行宽度。格式变化保持同一选区字节。 |
| `DISP-03` 多进制显示 | [原始流](./ui-wireframes.html#raw) · [字段与寄存器](./ui-wireframes.html#fields) | 选区数值解释显示位宽、符号、端序及 DEC/HEX/BIN/OCT，结果可回原区间。 |
| `DISP-04` 时间戳 | [原始流](./ui-wireframes.html#raw) · [指标与缺口](./ui-wireframes.html#metrics) | 时间戳列固定，格式从数据工具条内切换。精度、偏移误差与来源展开在时间详情。 |
| `DISP-05` 收发方向标记 | [原始流](./ui-wireframes.html#raw) | 记录每行先给方向与来源再给字节，主题色只是辅助，复制和朗读也能辨识来源。 |
| `DISP-06` ANSI 颜色透传 | [终端](./ui-wireframes.html#terminal) · [原始流](./ui-wireframes.html#raw) | 切到终端观察控制序列效果，接收工具条可回到原始视图，保留会话位置。 |
| `DISP-07` 自定义高亮规则 | [原始流](./ui-wireframes.html#raw) | 高亮规则面板统一编辑模式、顺序和样式，并显示匹配试样和预算错误。 |
| `DISP-08` 协议分色 | [字段与寄存器](./ui-wireframes.html#fields) · [原始流](./ui-wireframes.html#raw) | 解析结果字段点击定位原接收字节。颜色、边界和可读名称同屏，选择失败保留未解释数据。 |
| `DISP-09` 静默分帧 | [分帧与协议定义](./ui-wireframes.html#protocol) · [原始流](./ui-wireframes.html#raw) | 分帧工具内填静默阈值并预览包长。流内包号、时间及来源精度留在记录边界。 |
| `DISP-10` 自动与暂停滚动 | [原始流](./ui-wireframes.html#raw) | 滚动时状态行区别追尾和暂停跟随，「返回最新」在正文外的固定位置。 |
| `DISP-11` 视图冻结 | [原始流](./ui-wireframes.html#raw) | 接收动作条的冻结独立切换，状态行显示仍在接收／录制和原读点是否淘汰。 |
| `DISP-12` 查找与过滤 | [原始流](./ui-wireframes.html#raw) | 查找和方向过滤同一区域展开，匹配计数、结果跳转及清除紧邻条件，原录制保持可追溯。 |
| `DISP-13` 多格式复制 | [原始流](./ui-wireframes.html#raw) | 选区上下文菜单提供复制格式，预览明确所选范围及时间戳。复制失败回同一选区。 |
| `DISP-14` 行号与包号 | [原始流](./ui-wireframes.html#raw) | 记录首列可显示行、事件、包号及跳转，选择其一时详情保留原事件标识。 |
| `DISP-15` 大缓冲渲染 | [原始流](./ui-wireframes.html#raw) · [指标与缺口](./ui-wireframes.html#metrics) | 超长会话保持接收区独立滚动，容量、淘汰和搜索进度在辅助状态留位，性能按原基准取证。 |
| `DISP-16` 字体缩放 | [外观、输入与应用偏好](./ui-wireframes.html#preferences) · [原始流](./ui-wireframes.html#raw) | 共享终端字体设置及会话内缩放控制，实时选区、行号和对齐示例在原流阅读区。 |
| `DISP-17` 拆屏对比 | [会话对比](./ui-wireframes.html#compare) | 同一对比工具两端目标选择、对齐口径和各自时间／偏移。缺一侧样本在该侧显示空态。 |
| `DISP-18` 结构化表格视图 | [字段与寄存器](./ui-wireframes.html#fields) | 结构化字段表的首列显示名称，值、单位和质量位置一致。写回从所在行进入确认并显示应答。 |
| `DISP-19` 长帧折叠 | [原始流](./ui-wireframes.html#raw) | 长记录原位显示长度、异常和展开，预览按需读取，收起后保留原滚动。 |
| `DISP-20` 选区导出 | [原始流](./ui-wireframes.html#raw) | 选区菜单用一处导出入口选择文本、HTML 或图像，预览范围、主题、分页及文件结果。 |

### 录制与回放（LOG）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `LOG-01` 原始字节日志 | [录制](./ui-wireframes.html#capture) · [任务与回执](./ui-wireframes.html#task) | 选择会话与原始录制目标。状态区区分采集／存储／读者缺口，TX 行能展开写入范围和操作回执。 |
| `LOG-02` 文本日志 | [回放与证据导出](./ui-wireframes.html#replay) | 录制导出向导选择文本、编码、时间及方向。预览对无效字节提示原区间，可返回原始录制。 |
| `LOG-03` 结构化日志 | [回放与证据导出](./ui-wireframes.html#replay) · [插件列表与详情](./ui-wireframes.html#plugin) | 同一导出面板切换 CSV、JSONL，SQLite 作为可用扩展选项。字段、批量和失败位置在导出结果内查看。 |
| `LOG-04` 自动命名与分卷 | [录制](./ui-wireframes.html#capture) | 录制的命名和分卷组放变量、体积、时间和最终文件名样本。状态显示当前卷、序号和跳转。 |
| `LOG-05` 追加与覆盖策略 | [录制](./ui-wireframes.html#capture) | 创建目标后显式选择新建、追加或覆盖，冲突显示目标格式和会话。覆盖确认在实际写入之前。 |
| `LOG-06` 异步写入 | [录制](./ui-wireframes.html#capture) · [指标与缺口](./ui-wireframes.html#metrics) | 常显录制进度下展开已写入、已刷新、已同步、独立验证的水位与慢盘终态。 |
| `LOG-07` 日志脱敏 | [录制](./ui-wireframes.html#capture) · [权限与来源管理](./ui-wireframes.html#security) | 录制的脱敏页先给规则、命中字段和样本。另存原件单独选择和授权，进度注明当前录制模式。 |
| `LOG-08` 回放 | [回放与证据导出](./ui-wireframes.html#replay) | 只读回放工具栏放播放、速度、单步、断点和位置。数据区保留缺口和未知 TX 结果。 |
| `LOG-09` 录制-回放联调 | [回放与证据导出](./ui-wireframes.html#replay) · [测试套件与夹具](./ui-wireframes.html#suite) | 工作区菜单分别提供「打开回放」和「模拟录制对端」。交互模式显示录制来源、匹配进度、差异位置和相应字节。 |
| `LOG-10` 日志内搜索 | [回放与证据导出](./ui-wireframes.html#replay) | 回放工具栏的查找位填写内容与方向。索引建立、取消和重建共用进度位置，结果可跳到源偏移。 |
| `LOG-11` 磁盘保护 | [录制](./ui-wireframes.html#capture) · [指标与缺口](./ui-wireframes.html#metrics) | 容量及磁盘预留与录制目标在同组。告警和停止、切卷状态从此处追查，旧证据仍可打开。 |
| `LOG-12` 崩溃安全 | [回放与证据导出](./ui-wireframes.html#replay) · [系统状态、恢复与更新](./ui-wireframes.html#recovery) | 打开受损录制时展示可验证前缀和失败边界。恢复另存对话框预览目标冲突及原件保留。 |
| `LOG-13` 日志来源和时间基准 | [录制](./ui-wireframes.html#capture) · [回放与证据导出](./ui-wireframes.html#replay) | 记录源信息区按设备、方向、配置版本、序号及断连缺口展示，可展开主机和采样时钟。 |
| `LOG-14` 发送式回放保护 | [回放与证据导出](./ui-wireframes.html#replay) · [任务与回执](./ui-wireframes.html#task) | 普通回放继续只读，独立的发送预览列目标、方向、调速与最终字节。显式授权提交后回到任务回执。 |

### 协议（PROTO）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `PROTO-01` 通用分帧器 | [分帧与协议定义](./ui-wireframes.html#protocol) | 分帧规则编辑区列六种模式及组合顺序。样本结果给帧边界、未识别片段及重同步位置。 |
| `PROTO-02` 字段定义 | [分帧与协议定义](./ui-wireframes.html#protocol) · [字段与寄存器](./ui-wireframes.html#fields) | 按字段顺序编辑类型、位域、字序、比例、枚举、单位等，结果列同一原字节范围和派生值。 |
| `PROTO-03` CRC 识别与验证 | [分帧与协议定义](./ui-wireframes.html#protocol) | CRC 工具输入候选报文和校验样例，结果表列匹配项、参数和需补样本的理由。 |
| `PROTO-04` 协议模板库 | [分帧与协议定义](./ui-wireframes.html#protocol) · [插件列表与详情](./ui-wireframes.html#plugin) | 协议模板列表按协议、版本、角色、所需硬件或扩展筛选。已选模板在本工具预览示例与能力。 |
| `PROTO-05` 声明式协议描述 | [分帧与协议定义](./ui-wireframes.html#protocol) | 自定义定义页有 JSON/YAML 导入、版本与逐字段错误，确认前在结果区预览解析和构造。 |
| `PROTO-06` 脚本编解码 | [脚本编辑与调试](./ui-wireframes.html#script) · [分帧与协议定义](./ui-wireframes.html#protocol) | 解析器编辑用脚本入口的运行时与信任组，编解码样本使用协议结果区，运行失败定位到脚本和字节。 |
| `PROTO-07` 双向编解码 | [分帧与协议定义](./ui-wireframes.html#protocol) | 同一定义下可切「解析／构造」，往返结果并列看字段与字节差异，错误指回原字段。 |
| `PROTO-08` 异常检测 | [分帧与协议定义](./ui-wireframes.html#protocol) · [字段与寄存器](./ui-wireframes.html#fields) | 异常结果列按来源显示长度校验、缺帧、重复或序号跳变，展开输入及期望证据。 |
| `PROTO-09` 请求-响应时序图 | [分帧与协议定义](./ui-wireframes.html#protocol) · [Modbus](./ui-wireframes.html#modbus) | 协议事务结果有可复用的时间线，Modbus 主站时序是已有对照。按请求显示配对、超时和迟到应答，保留会话、时间源与统计口径。 |
| `PROTO-10` 寄存器 / 内存视图 | [Modbus](./ui-wireframes.html#modbus) · [字段与寄存器](./ui-wireframes.html#fields) | 首批寄存器操作从 Modbus 工具配置数据区、地址、功能码和字序。观测视图定位到对应行，写回在协议工具明确目标、值和设备确认。 |
| `PROTO-11` 会话对比 | [会话对比](./ui-wireframes.html#compare) · [回放与证据导出](./ui-wireframes.html#replay) | 从实时或录制对比选两个源，对齐键同组，结果可单看字节、字段或时间差。 |
| `PROTO-12` 学习模式 | [协议候选与草案](./ui-wireframes.html#infer) | 抓包样本选区进入候选列表。点选后显示边界、类型、依据和人工编辑，显式保存为协议草案。 |
| `PROTO-13` 错误注入 | [测试套件与夹具](./ui-wireframes.html#suite) · [诊断与自检](./ui-wireframes.html#diagnostics) | 测试用例的变异步骤选择类型和输入输出样本。外部线级注入依仪器能力呈现，结果注明恢复状态。 |
| `PROTO-14` 自动应答 | [发送任务与自动化](./ui-wireframes.html#schedule) · [分帧与协议定义](./ui-wireframes.html#protocol) | 自动化规则预设的请求条件后配置应答内容和延时，列收到请求、预览及实际写入结果。 |
| `PROTO-15` 状态机视图 | [分帧与协议定义](./ui-wireframes.html#protocol) | 协议结果的状态视图显示当前状态和触发事件。选择状态可定位录制，未知和错误仍有名称及原始证据。 |
| `PROTO-16` 单位换算与标定 | [分帧与协议定义](./ui-wireframes.html#protocol) · [字段与寄存器](./ui-wireframes.html#fields) | 字段定义的标定组设公式或查表来源、单位和版本，结果同时给原值、转换值及无效状态。 |
| `PROTO-17` 主从模拟器 | [Modbus](./ui-wireframes.html#modbus) | 用 Modbus 主站／从站已有分区，按角色呈现封装、地址、功能码和延时，启停状态及实际应答就近。 |
| `PROTO-18` 多解析器并行 | [分帧与协议定义](./ui-wireframes.html#protocol) · [字段与寄存器](./ui-wireframes.html#fields) | 同一数据源下的解析器选择区显示各解析器和预算，结果页签分别显示输出、缺口、失败和重试入口。 |
| `PROTO-19` 数值报文编辑器 | [分帧与协议定义](./ui-wireframes.html#protocol) · [发送区](./ui-wireframes.html#send) | 数值字段组件按宽度、符号、浮点和端序编辑，预览显示构造字节及往返差异。向草稿转入须明确动作。 |
| `PROTO-20` 工业协议事务参数 | [Modbus](./ui-wireframes.html#modbus) · [字段与寄存器](./ui-wireframes.html#fields) | 各角色共享封装、单元号、地址基准、功能码、字序和等待字段，结果显示广播、异常、重试与源时间。 |

### 可视化与分析（VIZ）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `VIZ-01` 实时折线 | [图表与监控](./ui-wireframes.html#chart) | 图表正文显示多通道、量程和游标，筛选及暂停在头部。选点读数带单位和源字节范围。 |
| `VIZ-02` 高采样性能 | [图表与监控](./ui-wireframes.html#chart) · [指标与缺口](./ui-wireframes.html#metrics) | 图表侧列注明当前采样、降采样、显示窗口和可见延迟。基准与资源实测放性能证据。 |
| `VIZ-03` 仪表与状态控件 | [图表与监控](./ui-wireframes.html#chart) · [工作区与视图布局](./ui-wireframes.html#workspace) | 仪表、进度、状态及控制元件作为视图组件。滑块、按钮放操作组，展示目标和值的实际回执。 |
| `VIZ-04` 频谱与直方图 | [插件视图与专业分析](./ui-wireframes.html#plugin-view) | 专业分析的频谱结果分频谱、瀑布图和分布，顶部保留源范围、采样率、窗和缺样。 |
| `VIZ-05` 统计指标 | [图表与监控](./ui-wireframes.html#chart) · [插件视图与专业分析](./ui-wireframes.html#plugin-view) | 基础统计放图表读数侧列。扩展打开高级窗口，明确指标、样本分母和丢点。 |
| `VIZ-06` XY / 散点 / 李萨如 | [图表与监控](./ui-wireframes.html#chart) · [插件视图与专业分析](./ui-wireframes.html#plugin-view) | 图表的分析选择里预留 XY、散点及李萨如。不同源的对齐、误差及插值证据并入专业来源详情。 |
| `VIZ-07` 3D 姿态 | [插件视图与专业分析](./ui-wireframes.html#plugin-view) | 姿态扩展正文居中放姿态图，来源侧列选坐标系、四元数顺序与单位，读数可追源。 |
| `VIZ-08` 地图轨迹 | [插件视图与专业分析](./ui-wireframes.html#plugin-view) · [回放与证据导出](./ui-wireframes.html#replay) | 地图扩展用主画布显示轨迹，侧列设置来源、坐标和离线／用户配置的图源，回放共享时间定位。 |
| `VIZ-09` 图像流 | [插件视图与专业分析](./ui-wireframes.html#plugin-view) | 图像扩展正文按帧边界展现像素内容。源尺寸、编码、丢帧和滤镜在侧栏，导出紧邻帧。 |
| `VIZ-10` 总线负载 | [指标与缺口](./ui-wireframes.html#metrics) · [图表与监控](./ui-wireframes.html#chart) | 会话指标中以时间窗显示吞吐、帧及错误，必要时图表展开，分别标示源数据。 |
| `VIZ-11` 拖拽式布局 | [工作区与视图布局](./ui-wireframes.html#workspace) | 布局编辑的当前页包含可放置控件、数据绑定与分区预览。提供拖动及键盘移动，按修订保存。 |
| `VIZ-12` 工程模板共享 | [复现实验与共享](./ui-wireframes.html#experiment) | 共享工程导出预览 schema、依赖、布局和凭据引用。导入在同一依赖及差异区说明缺包或旧格式。 |
| `VIZ-13` 图表导出 | [图表与监控](./ui-wireframes.html#chart) · [插件视图与专业分析](./ui-wireframes.html#plugin-view) | 图表导出显示所选范围、来源及格式，专业 MDF4 走扩展选项。离屏结果在任务同一回执。 |
| `VIZ-14` 阈值报警 | [图表与监控](./ui-wireframes.html#chart) · [发送任务与自动化](./ui-wireframes.html#schedule) | 阈值由规则配置条件、滞回及动作。图表显示告警点和可读状态，声音、通知和事件引用同一告警。 |
| `VIZ-15` 多设备同屏 | [图表与监控](./ui-wireframes.html#chart) · [会话对比](./ui-wireframes.html#compare) | 选择多设备到图表布局并保留每块的源。公共时间轴标偏移、同步方法及缺少对齐证据的设备。 |
| `VIZ-16` 字节字段图表联动 | [图表与监控](./ui-wireframes.html#chart) · [字段与寄存器](./ui-wireframes.html#fields) · [原始流](./ui-wireframes.html#raw) | 原始行、字段和图表点共用来源定位。当前过滤、回放或降采样下回到实际字节范围，缺口单独呈现。 |

### 传输与烧录（XFER）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `XFER-01` X/Y/ZMODEM | [文件传输](./ui-wireframes.html#transfer) | 文件传输的协议页按实际支持列 X/Y/ZMODEM，发送与接收分别预览；自动接收先选保存策略，续传显示协商位置。 |
| `XFER-02` Kermit / ASCII 传输 | [文件传输](./ui-wireframes.html#transfer) | 协议或模式下拉提供 Kermit 和 ASCII，按所选项显示对端、行尾、速率和取消。 |
| `XFER-03` 原始流传输 | [文件传输](./ui-wireframes.html#transfer) · [任务与回执](./ui-wireframes.html#task) | 与文件发送共用裸传表单、样本和操作。结果明确 Host 已送范围及设备独立校验结果。 |
| `XFER-04` 传输进度与速率 | [文件传输](./ui-wireframes.html#transfer) · [任务与回执](./ui-wireframes.html#task) | 范围下方分别呈现读取、送出、确认、速率和剩余时间。取消时保留已发生量。 |
| `XFER-05` 传后校验 | [文件传输](./ui-wireframes.html#transfer) | 传输验证分区选择摘要、设备回读接口和重传范围。按来源列本机与设备的实际摘要。 |
| `XFER-06` 设备文件系统 | [设备文件与烧录](./ui-wireframes.html#flash) | 目标设备入口内的文件页选择真实固件和目录，显示读写、删除及逐对象回执，路径标其端点。 |
| `XFER-07` 固件烧录集成 | [设备文件与烧录](./ui-wireframes.html#flash) · [任务与回执](./ui-wireframes.html#task) | 烧录页显示工具、版本、来源、路径和许可，按阶段展示交接、实际执行、取消及证据。 |
| `XFER-08` ISP / Bootloader 流程 | [设备文件与烧录](./ui-wireframes.html#flash) · [会话控制](./ui-wireframes.html#line) | 烧录配方选型号、Bootloader、接线，预览 DTR/RTS 步骤与目标，提供失败恢复入口。 |
| `XFER-09` 批量烧录 | [设备文件与烧录](./ui-wireframes.html#flash) · [任务与回执](./ui-wireframes.html#task) | 设备列表支持选择多个目标和并发上限。逐设备显示交接、进度、失败及汇总。 |
| `XFER-10` 文件协议独占会话 | [文件传输](./ui-wireframes.html#transfer) · [任务与回执](./ui-wireframes.html#task) | 协议传输显示独占原因、冲突任务与暂停状态，释放后恢复观察。需重启的其他任务由用户从其入口确认。 |

### 自动化与测试（AUTO）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `AUTO-01` 脚本引擎 | [脚本编辑与调试](./ui-wireframes.html#script) · [插件列表与详情](./ui-wireframes.html#plugin) | 脚本页明确当前运行时和 SDK，扩展向导展示所需按需包和兼容性。运行前检查真实目标及信任。 |
| `AUTO-02` 脚本编辑器 | [脚本编辑与调试](./ui-wireframes.html#script) | 编辑区左侧脚本或片段清单，正文补全与逐行错误，运行输出在原编辑视图内隔行分隔。 |
| `AUTO-03` 脚本调试 | [脚本编辑与调试](./ui-wireframes.html#script) · [任务与回执](./ui-wireframes.html#task) | 调试页编辑器显示断点、单步与当前行。调用栈、变量与暂停状态关联到任务，采集继续。 |
| `AUTO-04` 录制生成脚本 | [发送任务与自动化](./ui-wireframes.html#schedule) · [活动跟随与接管](./ui-wireframes.html#activity) | 从手工发送区进入显式录制，结束后到命令序列预览所捕获动作和引用，编辑并单独运行。 |
| `AUTO-05` 测试用例与断言 | [测试套件与夹具](./ui-wireframes.html#suite) | 用例页字段放断言、等待、重试规则。每轮结果列证据及部分写入中止原因。 |
| `AUTO-06` 测试套件与报告 | [测试套件与夹具](./ui-wireframes.html#suite) | 套件页安排顺序、版本和运行，结果页分趋势、逐项状态和报告导出。 |
| `AUTO-07` 规则触发 | [发送任务与自动化](./ui-wireframes.html#schedule) | 规则页从数据源、作用域、匹配到动作，动作栏内列授权、去重或循环防护，结果可定位事件。 |
| `AUTO-08` 定时任务 | [发送任务与自动化](./ui-wireframes.html#schedule) | 日历页按时区、规则、下次运行及错过策略排列，从同一页核对已安排、漏跑、停用和实际执行。 |
| `AUTO-09` 参数化与数据驱动 | [测试套件与夹具](./ui-wireframes.html#suite) | 参数化页先选 CSV／表，再映射列与类型、预览轮次。结果按输入行定位。 |
| `AUTO-10` 长稳与压力测试 | [测试套件与夹具](./ui-wireframes.html#suite) · [指标与缺口](./ui-wireframes.html#metrics) | 长稳用例有循环、已知序列、采样、资源图和报告。已有截图条件和允许范围在用例中明确。 |
| `AUTO-11` 无头模式 | 共享契约与可观测行为 · [任务与回执](./ui-wireframes.html#task) | CLI 自有运行入口。GUI 任务面板可依权限查看同源任务的模式、日志和实际结果。 |
| `AUTO-12` API 控制 | [权限与来源管理](./ui-wireframes.html#security) · 共享契约与可观测行为 | 外部访问设置依适配器展示启用、身份与范围，业务回执和能力目录保持共用。 |
| `AUTO-13` 插件 SDK | [插件列表与详情](./ui-wireframes.html#plugin) · 共享契约与可观测行为 | 插件详情列四类能力及后台、视图入口，SDK 示例和文档使用现有帮助链接位置。 |
| `AUTO-14` 事件钩子 | [脚本编辑与调试](./ui-wireframes.html#script) · [活动跟随与接管](./ui-wireframes.html#activity) | 脚本条件选择列连接、断开、RX、TX、错误。事件详情显示来源、会话代次、缺口和处理结果。 |
| `AUTO-15` 配置即代码 | [复现实验与共享](./ui-wireframes.html#experiment) · [工作区与视图布局](./ui-wireframes.html#workspace) | 版本化文本的导入预览给版本、环境覆盖、字段差异和密钥引用，未来格式或冲突保留原件。 |
| `AUTO-16` 团队共享 | [复现实验与共享](./ui-wireframes.html#experiment) | 共享清单选择配置、脚本及模板，按版本导出／导入并显示依赖与范围，文件留给用户自行共享。 |
| `AUTO-17` 无头运行退出契约 | 共享契约与可观测行为 · [任务与回执](./ui-wireframes.html#task) | CLI 输出保持退出码和机器可读契约。GUI 仅在同源任务记录已披露的超时、取消、部分和未知状态。 |
| `AUTO-18` 端口租借与烧录交接 | [设备文件与烧录](./ui-wireframes.html#flash) · [任务与回执](./ui-wireframes.html#task) | 烧录的交接步骤连续显示冻结、结算、关闭、工具运行、重开及核对身份，每阶段可查失败依据。 |
| `AUTO-19` 离线确定性测试夹具 | [测试套件与夹具](./ui-wireframes.html#suite) · [复现实验与共享](./ui-wireframes.html#experiment) | 夹具编辑器选择录制、虚拟端口、时钟、种子、版本和断言。运行与导出保留可重现输入和失败定位。 |

### 网络（NET）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `NET-01` TCP 客户端 / 服务端 | [连接配置](./ui-wireframes.html#connection) | TCP 类型表单按客户端或监听角色展示地址和端口，状态详情区分半关闭及实际连接。 |
| `NET-02` UDP 单播 / 广播 / 组播 | [连接配置](./ui-wireframes.html#connection) · [原始流](./ui-wireframes.html#raw) | UDP 表单选接口、单播／组播／广播与可用地址。接收区显示报文边界及来源。 |
| `NET-03` WebSocket | [连接配置](./ui-wireframes.html#connection) | 设备 WebSocket 表单按角色展示 URL、监听地址和帧模式。浏览器访问仍由独立设置位置配置。 |
| `NET-04` MQTT 发布订阅 | [连接配置](./ui-wireframes.html#connection) · [发送任务与自动化](./ui-wireframes.html#schedule) | MQTT 按设备网络适配配置 broker、主题、QoS、遗嘱和凭据引用，桥接规则区显示来源及防回环反馈。 |
| `NET-05` HTTP / REST 推送 | [发送任务与自动化](./ui-wireframes.html#schedule) · [权限与来源管理](./ui-wireframes.html#security) | 外发规则的 POST 动作组填写用户 URL 与授权引用、积压和重试策略，状态返回任务及失败详情。 |
| `NET-06` RFC2217 | [连接配置](./ui-wireframes.html#connection) · [会话控制](./ui-wireframes.html#line) | RFC 2217 表单正确归类，与裸 TCP 分项。会话控制显示实际协商、逐字段拒绝及线状态。 |
| `NET-07` 串口 ↔ 网络桥 | [局域网共享与远端连接](./ui-wireframes.html#lan) · [连接配置](./ui-wireframes.html#connection) | 共享设备设置保留多读与写租约。协议桥配置在目标连接／规则，状态能辨识两侧来源和控制权。 |
| `NET-08` TLS 与证书管理 | [连接配置](./ui-wireframes.html#connection) · [权限与来源管理](./ui-wireframes.html#security) | 加密连接高级组选证书引用、指纹和认证方式，权限页管理引用；连接状态呈现拒绝与更换结果。 |
| `NET-09` IPv6 | [连接配置](./ui-wireframes.html#connection) · [局域网共享与远端连接](./ui-wireframes.html#lan) | 地址字段支持 IPv6 带 scope，连接状态标实际地址族和重连路径，表单保留用户原输入。 |
| `NET-10` 数据上云 | [发送任务与自动化](./ui-wireframes.html#schedule) · [插件列表与详情](./ui-wireframes.html#plugin) | 规则的专业外发动作选择已安装的数据或网关适配，凭据引用、批量、重试及失败原因在目标组。 |
| `NET-11` 多客户端写入仲裁 | [局域网共享与远端连接](./ui-wireframes.html#lan) · [活动跟随与接管](./ui-wireframes.html#activity) · [任务与回执](./ui-wireframes.html#task) | 会话共享详情呈现观察者、有效写租约、控制转移及操作者。事务占用和排队结果进入任务详情。 |
| `NET-12` BLE 服务与特征选择 | [连接配置](./ui-wireframes.html#connection) · [设备库](./ui-wireframes.html#device) | BLE 子表单按发现顺序列服务、特征、通知、写入类型与绑定状态，连接失败保留选定设备。 |
| `NET-13` 浏览器逐站点设备授权 | 范围外 | 零安装 Web Serial 及逐站点设备授权延期。现有配对浏览器沿用 Host 访问设置。 |

### 会话与工作区（SESS）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `SESS-01` 多标签 / 多窗口 | [连接栏与会话标签](./ui-wireframes.html#session) · [窗口与命令](./ui-wireframes.html#shell) | 会话标签可切换和拖出，菜单提供键盘「在新窗口打开」。恢复窗口位置，关闭视图时分别提供结束会话入口。 |
| `SESS-02` 工作区 | [工作区与视图布局](./ui-wireframes.html#workspace) | 工作区选择器列名称、视图和连接摘要。恢复配置后由用户分别决定连接和脚本启动。 |
| `SESS-03` 会话模板 | [工作区与视图布局](./ui-wireframes.html#workspace) · [复现实验与共享](./ui-wireframes.html#experiment) | 模板入口按用户用途陈列预设、角色、依赖和示例。缺包反馈指向插件详情和重新打开。 |
| `SESS-04` 标签命名与着色 | [工作区与视图布局](./ui-wireframes.html#workspace) · [连接栏与会话标签](./ui-wireframes.html#session) | 视图属性区配置名称、颜色、图标及置顶，标签保留可读名称，保存后由 Host 同步。 |
| `SESS-05` 会话克隆 | [工作区与视图布局](./ui-wireframes.html#workspace) · [连接栏与会话标签](./ui-wireframes.html#session) | 标签菜单进入克隆配置，确认设备及视图参数。同物理设备提示附着现有会话并保留独立阅读偏好。 |
| `SESS-06` 崩溃恢复 | [系统状态、恢复与更新](./ui-wireframes.html#recovery) · [回放与证据导出](./ui-wireframes.html#replay) | 恢复页显示上次配置、缓存边界和原件归档，选择恢复结果和原会话定位。任务启动仍显式操作。 |
| `SESS-07` 只读模式 | [连接栏与会话标签](./ui-wireframes.html#session) · [权限与来源管理](./ui-wireframes.html#security) | 标签和目标栏持久标示当前只读状态，发送、复位及写入就近说明原因。接管入口按能力出现。 |
| `SESS-08` 布局持久化 | [工作区与视图布局](./ui-wireframes.html#workspace) | 布局编辑统一面板、列、比例和可见性。保存与恢复显示版本、冲突和缺插件的替代位，各窗保留自己的焦点和阅读位置。 |
| `SESS-09` 复现实验包 | [复现实验与共享](./ui-wireframes.html#experiment) | 复现实验包预览工程、依赖、固件、录制引用和结果，显示移除密钥／敏感正文及导入缺项。 |

### 界面交互（UX）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `UX-01` 命令面板 | [窗口与命令](./ui-wireframes.html#shell) | 命令面板通过共享注册表搜索页面、设置和工具。结果解释当前目标或权限不可用，确认后聚焦真实入口。 |
| `UX-02` 全键盘操作 | [窗口与命令](./ui-wireframes.html#shell) · [外观、输入与应用偏好](./ui-wireframes.html#preferences) | 从每个容器首个可操作项建立键盘顺序。改键和冲突在快捷键设置，菜单及弹层返回原入口。 |
| `UX-03` 主题 | [外观、输入与应用偏好](./ui-wireframes.html#preferences) | 外观页上方选浅、深或跟随系统，预览共享语义色。导入、导出及对比度错误留在同组。 |
| `UX-04` 高 DPI 与多屏 | [窗口与命令](./ui-wireframes.html#shell) · [平台原生交互](./ui-wireframes.html#native) | 外壳按可用空间恢复窗口与侧栏位置。系统 DPI 与屏幕移除作为验收场景，在实际窗口查位置与可达性。 |
| `UX-05` 可停靠面板 | [工作区与视图布局](./ui-wireframes.html#workspace) | 布局中的停靠和折叠提供键盘调整及恢复默认，主连接和发送仍在工作台固定位置。 |
| `UX-06` 状态栏仪表 | [指标与缺口](./ui-wireframes.html#metrics) · [连接栏与会话标签](./ui-wireframes.html#session) | 状态栏显示速率、字节、帧、错误及连接时长。点开区分 Host、协议和线路来源。 |
| `UX-07` 通知与托盘 | [外观、输入与应用偏好](./ui-wireframes.html#preferences) · [发送任务与自动化](./ui-wireframes.html#schedule) · [平台原生交互](./ui-wireframes.html#native) | 设置里统一管理通知、托盘和系统权限。规则命中沿同一事件发送可听和可读反馈，点击可回所属任务。 |
| `UX-08` 右键上下文 | [原始流](./ui-wireframes.html#raw) · [发送区](./ui-wireframes.html#send) | 接收选区菜单共用复制、准备发送、书签和分屏。相关动作固定原事件、目标和预览范围。 |
| `UX-09` 示例工程 | [复现实验与共享](./ui-wireframes.html#experiment) · [测试套件与夹具](./ui-wireframes.html#suite) | 示例入口放可运行工程、所需角色、固件或模拟来源。运行前显式选目标，完成后显示记录与结果。 |
| `UX-10` 无障碍 | 共享契约与可观测行为 | 各区域按共同顺序提供可读标签、控制状态、可见焦点及动态宣告。用原操作链路验证屏读和对比度。 |
| `UX-11` 便携模式 | [系统状态、恢复与更新](./ui-wireframes.html#recovery) · [权限与来源管理](./ui-wireframes.html#security) | 系统状态的存储组说明当前数据路径及便携目录可写性。迁移时提示凭据重新授权，结果回到同组。 |
| `UX-12` 撤销重做 | [发送区](./ui-wireframes.html#send) · [命令库与发送历史](./ui-wireframes.html#library) | 发送草稿和命令编辑分别保留撤销与重做，历史作用于当前编辑器，已提交 TX 仍可查回执。 |
| `UX-13` 中英文与本地化 | [外观、输入与应用偏好](./ui-wireframes.html#preferences) · [插件视图与专业分析](./ui-wireframes.html#plugin-view) | 语言设置在共用偏好，已开窗口与插件更新标签，用户数据名称和会话解码设置维持原归属。 |
| `UX-14` 可访问性验收矩阵 | 共享契约与可观测行为 · [插件视图与专业分析](./ui-wireframes.html#plugin-view) | 已开插件和工作台套用同一键盘、可读状态、对比度、缩放与多窗矩阵，证据放各功能专项。 |

### 性能与稳定性（PERF）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `PERF-01` 高波特率不丢包 | [指标与缺口](./ui-wireframes.html#metrics) · 共享契约与可观测行为 | 高速收发由当前会话的实际速率、源序号及缺口显示。独立发生器、逐字节对照和持久化证据归实机。 |
| `PERF-02` IO 与 UI 解耦 | [指标与缺口](./ui-wireframes.html#metrics) · 共享契约与可观测行为 | 状态详情分设备采集、读者与录制水位。慢视图时连接、停止和任务仍可达，控制延迟按基准取证。 |
| `PERF-03` 环形缓冲与零拷贝 | [原始流](./ui-wireframes.html#raw) · [指标与缺口](./ui-wireframes.html#metrics) | 读取游标、过期或淘汰回退进入原流历史控件。拷贝次数和运行时资源证据进入性能报告。 |
| `PERF-04` 背压与流控 | [指标与缺口](./ui-wireframes.html#metrics) · [录制](./ui-wireframes.html#capture) | 各消费者的预算及实际水位在同一详情下按源列出。慢盘停止与源端流控原因分别显示。 |
| `PERF-05` 大日志写入 | [录制](./ui-wireframes.html#capture) · 共享契约与可观测行为 | 录制详情显示写盘批次、索引、空间和失败位置。写入机制沿验收证据查，用户可选项依实际格式。 |
| `PERF-06` 百万行渲染 | [原始流](./ui-wireframes.html#raw) · 共享契约与可观测行为 | 大日志继续在原流区滚动、搜索和保持位置。并发录制和百万行预算使用同一现场验收。 |
| `PERF-07` 内存上限 | [指标与缺口](./ui-wireframes.html#metrics) · [外观、输入与应用偏好](./ui-wireframes.html#preferences) | 适用缓冲项在设置或工具预算组，详情标配置、占用与淘汰。异常超长帧在数据源保留缺口。 |
| `PERF-08` 长稳运行 | [测试套件与夹具](./ui-wireframes.html#suite) · [指标与缺口](./ui-wireframes.html#metrics) | 长稳任务报告按时间画 RSS、句柄、队列和重连事件。常态工作台复用指标，验收时长由现有矩阵指定。 |
| `PERF-09` USB 拔插恢复 | [连接栏与会话标签](./ui-wireframes.html#session) · [设备库](./ui-wireframes.html#device) | 插拔恢复沿用当前会话状态与设备匹配详情，待确认身份清楚可见，恢复后回原接收位置。 |
| `PERF-10` 数据缺口可观测性 | [指标与缺口](./ui-wireframes.html#metrics) · [原始流](./ui-wireframes.html#raw) | 指标详情列队列水位、丢弃、解析丢帧、写盘失败和恢复点，图表或原流用明确种类标降采样和源缺失。 |
| `PERF-11` 时间戳精度分级 | [指标与缺口](./ui-wireframes.html#metrics) · [UART 波形与仪器](./ui-wireframes.html#waveform) | 时间详情显示主机读块、设备采样、线级时钟、单位、分辨率与延迟来源。偏差估计及未知同步照实展示。 |

### 安全与合规（SEC）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `SEC-01` 完全离线 | [外观、输入与应用偏好](./ui-wireframes.html#preferences) · [权限与来源管理](./ui-wireframes.html#security) | 有外部出口的设置说明地址、权限与启用动作。离线工作使用现有入口，默认网络行为归实际验证。 |
| `SEC-02` 日志脱敏 | [录制](./ui-wireframes.html#capture) · [权限与来源管理](./ui-wireframes.html#security) | 沿用录制脱敏规则，详情标本次数据可见范围。查询、错误及文件引用在失去权限后反馈失效。 |
| `SEC-03` 可信脚本执行 | [插件列表与详情](./ui-wireframes.html#plugin) · [权限与来源管理](./ui-wireframes.html#security) | 首次脚本运行或插件启用前显示执行信任、来源与作用域，停止和进程回收在当前任务及插件详情。 |
| `SEC-04` 更新签名 | [系统状态、恢复与更新](./ui-wireframes.html#recovery) · [平台原生交互](./ui-wireframes.html#native) | 更新页显示校验、版本组合、在途任务、等待和失败恢复，安装器保留系统向导交互。 |
| `SEC-05` 密钥与证书加密存储 | [权限与来源管理](./ui-wireframes.html#security) · [系统状态、恢复与更新](./ui-wireframes.html#recovery) | 凭据组展示名称、引用、可用性与系统重建入口，不回显秘密。换机导入失败关联原引用。 |
| `SEC-06` 许可合规 | [插件列表与详情](./ui-wireframes.html#plugin) · [系统状态、恢复与更新](./ui-wireframes.html#recovery) | 包详情及发行信息的许可区给归属、工具版本和清单链接。许可评审直接检查发行产物证据。 |
| `SEC-07` 按能力授权扩展 | [权限与来源管理](./ui-wireframes.html#security) · [插件列表与详情](./ui-wireframes.html#plugin) · [任务与回执](./ui-wireframes.html#task) | 来源签名、执行信任和资源授权各有标签及撤销。停用后在受影响任务核对回收结果。 |
| `SEC-08` 不可信终端序列处理 | [终端](./ui-wireframes.html#terminal) · [权限与来源管理](./ui-wireframes.html#security) | OSC52、自动外链及文件动作的允许项按能力和目标就近确认。导入的日志始终通过安全阅读组件。 |
| `SEC-09` 解析器资源隔离 | [插件列表与详情](./ui-wireframes.html#plugin) · [指标与缺口](./ui-wireframes.html#metrics) · [任务与回执](./ui-wireframes.html#task) | 解析进程详情显示帧、输出、队列、资源与进度。中断、回收或重新打开在原解析器的任务处反馈。 |
| `SEC-10` 完整性与认证分离 | [分帧与协议定义](./ui-wireframes.html#protocol) · [权限与来源管理](./ui-wireframes.html#security) · [系统状态、恢复与更新](./ui-wireframes.html#recovery) | 字节校验失败回到协议结果，身份拒绝回到连接授权，签名失败回到包或更新来源。各处用明确原因。 |
| `SEC-11` 可审计更新与依赖版本 | [插件列表与详情](./ui-wireframes.html#plugin) · [系统状态、恢复与更新](./ui-wireframes.html#recovery) | 版本、来源、摘要、许可及签名放紧邻组件记录。更新切换、离线及失败恢复使用同一版本证据。 |
| `SEC-12` Agent 默认只读 | [权限与来源管理](./ui-wireframes.html#security) · [活动跟随与接管](./ui-wireframes.html#activity) | Agent 初始以只读范围呈现。按目标分别授权正文与动作，结果区持续反映撤权和引用失效。 |

### 诊断（DIAG）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `DIAG-01` 内置自检 | [诊断与自检](./ui-wireframes.html#diagnostics) | 环回自检页按目标、种子、帧数、发送量、可比较样本及结果顺序显示，虚拟和实物有各自标识。 |
| `DIAG-02` 故障向导 | [诊断与自检](./ui-wireframes.html#diagnostics) | 故障类型选择器提供打不开、乱码、丢数据和断连路径。逐步显示查证结果，回原会话复验。 |
| `DIAG-03` 设备信息面板 | [设备库](./ui-wireframes.html#device) · [诊断与自检](./ui-wireframes.html#diagnostics) | 所选设备详情列系统、驱动、USB 树和固件信息，供电读数只依实际遥测并附来源。 |
| `DIAG-04` 线路质量报告 | [诊断与自检](./ui-wireframes.html#diagnostics) · [指标与缺口](./ui-wireframes.html#metrics) | 线路报告预览按样本、接线、时间源和统计口径排组，保留错误、重传、抖动及导出。 |
| `DIAG-05` 快捷键速查 | [窗口与命令](./ui-wireframes.html#shell) · [外观、输入与应用偏好](./ui-wireframes.html#preferences) | 帮助或命令面板打开可搜索的快捷键速查，标当前模式和冲突，修改后返回原条目。 |
| `DIAG-06` 诊断包导出 | [诊断与自检](./ui-wireframes.html#diagnostics) | 导出诊断先展示时间、版本、包含范围和脱敏预览，下方复制／保存，实际成功位置可查。 |
| `DIAG-07` 固件符号与崩溃解码 | [诊断与自检](./ui-wireframes.html#diagnostics) | 崩溃解码表单选择固件文件和崩溃记录，确认哈希与工具版本。结果表逐地址展示符号、源位置或未知。 |
| `DIAG-08` 物理 UART 波形解码 | [UART 波形与仪器](./ui-wireframes.html#waveform) | 离线入口选择 VCD 或带采样率数字 CSV，时间轴标 RX/TX 起止位、校验、BREAK 及原样本范围。 |

### 扩展能力（FUT）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `FUT-01` AI 生成解析器 | [协议候选与草案](./ui-wireframes.html#infer) · [活动跟随与接管](./ui-wireframes.html#activity) | 外部建议进入协议草案预览，核对样本、定义或脚本和差异，确认后保存，执行授权单独处理。 |
| `FUT-02` AI 日志诊断 | [诊断与自检](./ui-wireframes.html#diagnostics) · [活动跟随与接管](./ui-wireframes.html#activity) | 获准日志的分析结果定位到诊断正文的样本引用与验证步骤。每条建议可跳回证据及动作。 |
| `FUT-03` AI 自然语言操作 | [活动跟随与接管](./ui-wireframes.html#activity) · [任务与回执](./ui-wireframes.html#task) | 活动面板显示当前跟随窗口、会话、动作、进度、结果和人工草稿。暂停导航与接管保持各自动作和反馈。 |
| `FUT-04` MCP / Agent 接口 | 共享契约与可观测行为 · [活动跟随与接管](./ui-wireframes.html#activity) | MCP 工具由外部客户端入口发现。GUI 活动与权限处呈现可披露的目标、取消和拒绝，与外部 schema 验收关联。 |
| `FUT-05` 协议自动逆向 | [协议候选与草案](./ui-wireframes.html#infer) | 与 PROTO-12 共用样本和候选工具，加上已匹配边界、枚举和校验依据，含人工采纳和返回源字节。 |
| `FUT-06` 协作调试 | [局域网共享与远端连接](./ui-wireframes.html#lan) · [活动跟随与接管](./ui-wireframes.html#activity) | LAN 共享会话详情列观察者、写入者和接管，标注附原事件、创建者和同步状态。 |
| `FUT-07` 插件市场 | [插件列表与详情](./ui-wireframes.html#plugin) | 插件页预留同一路由中的市场分区。搜索详情显示来源签名、兼容版本、评价来源和更新时间，升级状态沿安装回执。 |
| `FUT-08` 浏览器工作台 | [浏览器访问与接管确认](./ui-wireframes.html#access) · [窗口与命令](./ui-wireframes.html#shell) | 从本机设置配对后进入同源工作台，显示当前 Host、角色及权限，使用共用收发和跟随布局。 |
| `FUT-09` 与仪器联动 | [UART 波形与仪器](./ui-wireframes.html#waveform) · [插件列表与详情](./ui-wireframes.html#plugin) | 波形工具的仪器来源选输入与触发条件，图上标串口事件和仪器同步，结果保留两种时间来源。 |
| `FUT-10` 移动端 | 范围外 | 移动客户端及 OTG 排除，按矩阵记录。 |

### 局域网共享（LAN）

<!-- prettier-ignore -->
| 需求 | 主位置及相关位置 | 预留控件、内容与反馈 |
| --- | --- | --- |
| `LAN-01` 两台电脑间像本地一样使用共享串口 | [局域网共享与远端连接](./ui-wireframes.html#lan) · [连接栏与会话标签](./ui-wireframes.html#session) | B 在设置选共享串口与权限，A 在连接栏选已配对 Host 和设备。工作台继续复用收发等入口并显示源 Host。 |

## 后续接入

开工先按 ID 找到主位置，沿用现有场景稿和共享控件。针对该项给出具体字段、宽窄布局、当前目标、错误和回执，确认与相邻功能的关系后再实现。同一任务可以覆盖共用入口的多个 ID。若实际需要换位置，先更新本表的入口与相邻关系，再核对旧路由、命令发现、焦点和会话恢复。改变范围、兼容边界、公共契约、权限或验收标准时按现有流程确认。 [先设计后编码](./gui-design.md#先设计后编码) · [交付前自审](./ui-design.md#交付前自审)

用户能在宽窗、窄短窗及较大字体下按原入口完成任务，核对中英、明暗、长文本、显示内容、状态和键盘路径。后续产品专项按 [Windows 本地优先安排](./plan.md#windows-本地验收优先) 和 [桌面边界](./testing.md#桌面边界) 执行，软件、实机与发行分别记录。
