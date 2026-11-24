import { builtinRfc2217ProviderId } from "./builtin-endpoint.ts";
import { registerRfc2217Transport } from "./main.ts";

export const register = registerRfc2217Transport(builtinRfc2217ProviderId);
