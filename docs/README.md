# 工程文档

[首次运行](../README.md#从源码运行) · [接续点与阶段出口](./plan.md#当前执行与下一步) · [贡献流程](../CONTRIBUTING.md)

| 要解决的问题             | 入口                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 产品范围和完成标准       | [需求矩阵与验收场景](./requirements.md)、[逐项状态账本](./feature-status.json)、[需求与实现核对](./requirements-alignment.md)。 |
| 接续点、证据和未决问题   | [路线与进度](./plan.md)汇总主线交付、软件验收与剩余工作。                                                                       |
| 模块归属和实现约束       | [架构](./architecture.md)说明设计取舍，[开发规范](./conventions.md)约定实现与评审。                                             |
| 接线、构建和排障         | [开发指南](./development.md)，[契约](./contracts/README.md)及[插件 SDK](../packages/plugin-sdk/README.md)。                     |
| 改动后跑什么、失败怎么查 | [测试指南](./testing.md)收录常用命令、运行边界和 CI 复验方法。                                                                  |
| 签名包、升级和实机怎么验 | [专项验收](./acceptance.md)按场景提供命令、执行条件和证据要求。                                                                 |

界面先查[全局预规划与需求落位](./ui-layout.md)，再看[宽窄草稿预览](./ui-wireframes.html)、[GUI 设计规范](./gui-design.md#先设计后编码)和[具体场景草稿](./ui-design.md)。常用入口另有[启动排障](./development.md#环境与启动)、[分发契约](./contracts/runtime-distribution.md)和[安装验收](./acceptance.md#安装与发行验收)。

`marketplace/` 遵循子模块文档。主库宿主进度见[当前任务顺序](./plan.md#当前任务顺序)。

文档归属见[维护约定](./conventions.md#文档)，历史证据查 Git、PR 和 CI。
