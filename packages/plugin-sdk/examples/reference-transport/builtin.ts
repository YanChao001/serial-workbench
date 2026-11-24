import { builtinTcpProviderId } from "./tcp-endpoint.ts";
import { registerTcpTransport } from "./tcp-transport.ts";

export const register = registerTcpTransport(builtinTcpProviderId);
