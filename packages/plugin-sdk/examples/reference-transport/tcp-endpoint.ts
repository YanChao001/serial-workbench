export const builtinTcpPackageId = "swb.builtin.tcp";
export const builtinTcpProviderId = "swb.builtin.tcp.transport";
export const defaultTcpHost = "127.0.0.1";
export const tcpHostPattern = /^[a-z0-9_.:%-]{1,253}$/i;
export type TcpRole = "client" | "server";
