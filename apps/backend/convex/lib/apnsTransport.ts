/**
 * The HTTP/2 exchange for one APNs request (docs/10 §9), with the connection
 * injected: the Node action passes `node:http2`'s `connect`, and tests pass
 * a fake session, so timeout, network-error and response mapping are tested
 * without a network.
 */
import { classifyApnsResponse } from "./apns";
import type { PushResult } from "./push";

/** The parts of a Node `ClientHttp2Stream` this exchange uses. */
export interface Http2StreamLike {
  on(event: "response", listener: (headers: Record<string, unknown>) => void): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (e: Error) => void): unknown;
  setEncoding(encoding: "utf8"): unknown;
  end(body: string): unknown;
}

/** The parts of a Node `ClientHttp2Session` this exchange uses. */
export interface Http2SessionLike {
  on(event: "error", listener: (e: Error) => void): unknown;
  request(headers: Record<string, string>): Http2StreamLike;
  close(): unknown;
}

export type Http2Connect = (origin: string) => Http2SessionLike;

export interface ApnsHttpRequest {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export async function sendOverHttp2(
  connect: Http2Connect,
  request: ApnsHttpRequest,
  timeoutMs: number,
): Promise<PushResult> {
  return await new Promise<PushResult>((resolve) => {
    const session = connect(request.origin);
    const done = (result: PushResult) => {
      clearTimeout(timer);
      session.close();
      resolve(result);
    };
    // An ambiguous timeout: APNs may have accepted it. Retrying reuses
    // the same collapse ID, which limits but does not prevent a duplicate.
    const timer = setTimeout(() => done({ kind: "retryable", reason: "timeout" }), timeoutMs);
    session.on("error", (e) => done({ kind: "retryable", reason: `network:${e.message}` }));
    const stream = session.request({ ":method": "POST", ":path": request.path, ...request.headers });
    let status = 0;
    let body = "";
    stream.on("response", (headers) => {
      status = Number(headers[":status"]);
    });
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += chunk;
    });
    stream.on("end", () => {
      let reason: string | null = null;
      try {
        reason = body ? ((JSON.parse(body) as { reason?: string }).reason ?? null) : null;
      } catch {
        reason = null;
      }
      done(classifyApnsResponse(status, reason));
    });
    stream.on("error", (e) => done({ kind: "retryable", reason: `stream:${e.message}` }));
    stream.end(request.body);
  });
}
