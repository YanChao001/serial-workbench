# 契约

本目录维护实现需要的字段语义、失败条件和验收向量。产品要求见[需求](../requirements.md)，实现与验证范围见[路线与进度](../plan.md)；已实现的 wire 类型以 Rust DTO 和同源生成结果为准，新增或变更字段同时更新契约、调用者与测试。

| 文档                                      | 职责                                        |
| ----------------------------------------- | ------------------------------------------- |
| [Host](./host-v0.md)                      | 身份、wire、目录、调用/订阅、权限和持久去重 |
| [流与操作](./stream-and-operations-v0.md) | 会话、租约、TX、结算、原始流与失败向量      |
| [Capture](./capture-container-v0.md)      | 录制容器、索引、水位、验证恢复和引用        |
| [Node 扩展](./node-extension-v0.md)       | 包与信任基础、后台/Web UI/监督的契约        |
| [runtime 分发](./runtime-distribution.md) | 既定四目标来源/hash、布局与后续离线验收     |

各入口按 Rust `ProtocolVersion::CURRENT` 精确协商 Host RPC 1.0。生成的 `HOST_PROTOCOL_VERSION`、schema 与目录沿用同一值。旧 0.1 客户端得到支持版本及升级目标。应用、协议、目录和文件格式分别版本化。破坏性变更及退役按 [Host 版本契约](./host-v0.md#附着版本与目录)更新生成物、调用方和验收向量。退役前公布替代版本与整套升级步骤，验证相邻版本升级、拒绝旧连接及原 profile 恢复。数据演进保留原件与失败证据，拒写未来格式。

文件保留历史路径。RPC 版本查 [Rust `ProtocolVersion`](../../crates/core/src/wire.rs)，签名 Node 清单的独立 SDK 兼容值查 [Node 包 DTO](../../crates/core/src/node_package.rs)。

客户端信封查 [Rust DTO](../../crates/core/src/)和[生成类型](../../packages/contracts/src/generated/types.ts)，业务 ID、参数和结果查[内置目录](../../packages/contracts/src/generated/catalog.json)。动态贡献和可见项向运行中的 Host 查询。交付状态查路线，插件开发查 [Node SDK](../../packages/plugin-sdk/README.md)。
