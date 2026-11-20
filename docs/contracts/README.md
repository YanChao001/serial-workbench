# 契约

本目录维护实现需要的字段语义、失败条件和验收向量。产品要求见[需求](../requirements.md)，实现与验证范围见[路线与进度](../plan.md)；已实现的 wire 类型以 Rust DTO 和同源生成结果为准，新增或变更字段同时更新契约、调用者与测试。

| 文档                                      | 职责                                        |
| ----------------------------------------- | ------------------------------------------- |
| [Host](./host-v0.md)                      | 身份、wire、目录、调用/订阅、权限和持久去重 |
| [流与操作](./stream-and-operations-v0.md) | 会话、租约、TX、结算、原始流与失败向量      |
| [Capture](./capture-container-v0.md)      | 录制容器、索引、水位、验证恢复和引用        |
| [Node 扩展](./node-extension-v0.md)       | 包与信任基础、后台/Web UI/监督的契约        |
| [runtime 分发](./runtime-distribution.md) | 既定四目标来源/hash、布局与后续离线验收     |

当前 v0 协议值为 0.1，精确匹配；应用、协议、目录和文件格式版本分别管理。破坏性变化同步协议值、生成物、调用者与向量，M3 参考场景通过后定义 v1 支持窗口和退役策略。数据格式演进保持未来格式拒写、原件和失败证据。

接客户端时，先从 [Rust DTO](../../crates/core/src/) 或[生成类型](../../packages/contracts/src/generated/types.ts)确定信封，再用[内置目录](../../packages/contracts/src/generated/catalog.json)核对业务 ID、必填参数和领域结果；动态插件贡献及调用者实际可见项要向运行中的 Host 查询。契约还描述未来场景，不是已实现清单或通过记录。插件作者见 [Node SDK](../../packages/plugin-sdk/README.md)。
