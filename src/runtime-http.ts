import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";

/** Each request owns its socket: an old child must never lend a connection to its replacement. */
export const fetchRuntime: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Runtime transport requires loopback HTTP");
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise<Response>((resolve, reject) => {
    const connection = httpRequest(url, {
      agent: false,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      signal: request.signal,
    }, (incoming) => {
      // Keep cancellation bound to the response body after the request has finished writing.
      const abortBody = (): void => { incoming.destroy(new Error("Owned runtime response aborted")); };
      request.signal.addEventListener("abort", abortBody, { once: true });
      incoming.once("close", () => request.signal.removeEventListener("abort", abortBody));
      if (request.signal.aborted) abortBody();
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else if (value !== undefined) headers.set(key, value);
      }
      const status = incoming.statusCode ?? 500;
      resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status, statusText: incoming.statusMessage, headers,
      }));
    });
    connection.once("error", reject);
    connection.end(body);
  });
};
