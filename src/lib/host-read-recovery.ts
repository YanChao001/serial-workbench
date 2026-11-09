import { HostRequestError } from "@serial-workbench/host-client";

const READ_ATTEMPTS = 3;
/** Only for read-only queries; never grants permission or resends an invoke. */
export async function readWithAuthorizationRecovery<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const aborted = () => new DOMException("Waiting was aborted", "AbortError");
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw aborted();
    try {
      const result = await read();
      if (signal?.aborted) throw aborted();
      return result;
    } catch (error) {
      if (signal?.aborted) throw aborted();
      if (
        !(error instanceof HostRequestError) ||
        error.code !== "PERMISSION_DENIED" ||
        attempt + 1 >= READ_ATTEMPTS
      )
        throw error;
    }
  }
}
