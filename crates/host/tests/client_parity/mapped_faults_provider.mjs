// Deterministic faults through the signed reference TCP transport.
import { register as registerTransport } from "./transport.mjs";

export function register(context) {
  return registerTransport({
    ...context,
    transports: {
      register(id, open) {
        return context.transports.register(id, async (options) => {
          const connection = await open(options);
          return {
            ...connection,
            async write(input) {
              const payload = Buffer.from(input.bytes);
              if (payload.equals(Buffer.from("\r\n")))
                return connection.write({
                  ...input,
                  bytes: payload.subarray(0, 1),
                });
              const sent = await connection.write(input);
              if (payload.equals(Buffer.from("Q\r\n")))
                throw new Error("Fixture lost the write acknowledgement");
              return sent;
            },
          };
        });
      },
    },
  });
}
