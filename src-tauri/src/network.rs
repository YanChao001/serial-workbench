//! 宿主原生 HTTP 的连接偏好；每次请求读取已提交设置，不修改进程代理环境。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum NetworkMode {
    #[default]
    System,
    Direct,
}
