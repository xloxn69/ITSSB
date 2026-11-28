import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendOverHttp2 } from "./lib/apnsTransport";

/**
 * The APNs sender's HTTP/2 exchange against a fake session: no network.
 * Each test drives what the connection does and checks the outbox result.
 */

type Listener = (...args: never[]) => void;

class FakeEmitter {
  private listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
}

class FakeStream extends FakeEmitter {
  sent: string | null = null;
  setEncoding() {
    return this;
  }
  end(body: string) {
    this.sent = body;
    return this;
  }
  /** Replies like APNs: status header, then the JSON body (if any), then end. */
  reply(status: number, body = "") {
    this.emit("response", { ":status": status });
    if (body) this.emit("data", body);
    this.emit("end");
  }
}

class FakeSession extends FakeEmitter {
  readonly stream = new FakeStream();
  headers: Record<string, string> | null = null;
  closed = 0;
  request(headers: Record<string, string>) {
    this.headers = headers;
    return this.stream;
  }
  close() {
    this.closed += 1;
  }
}

const request = {
  origin: "https://api.sandbox.push.apple.com",
  path: `/3/device/${"a1".repeat(32)}`,
  headers: { "apns-collapse-id": "alert_1" },
  body: '{"aps":{}}',
};
const TIMEOUT_MS = 10_000;

function start() {
  const session = new FakeSession();
  const origins: string[] = [];
  const result = sendOverHttp2(
    (origin) => {
      origins.push(origin);
      return session;
    },
    request,
    TIMEOUT_MS,
  );
  return { session, origins, result };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("APNs HTTP/2 exchange", () => {
  it("posts the request and maps 200 to accepted", async () => {
    const { session, origins, result } = start();
    expect(origins).toEqual([request.origin]);
    expect(session.headers).toMatchObject({ ":method": "POST", ":path": request.path, "apns-collapse-id": "alert_1" });
    expect(session.stream.sent).toBe(request.body);
    session.stream.reply(200);
    expect(await result).toEqual({ kind: "accepted" });
    expect(session.closed).toBeGreaterThan(0);
  });

  it("a send with no answer times out as retryable and closes the connection", async () => {
    const { session, result } = start();
    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    let early = false;
    void result.then(() => (early = true));
    await Promise.resolve();
    expect(early).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await result).toEqual({ kind: "retryable", reason: "timeout" });
    expect(session.closed).toBeGreaterThan(0);
  });

  it("a connection reset is retryable", async () => {
    const { session, result } = start();
    session.emit("error", new Error("read ECONNRESET"));
    expect(await result).toEqual({ kind: "retryable", reason: "network:read ECONNRESET" });
  });

  it("a stream error is retryable", async () => {
    const { session, result } = start();
    session.stream.emit("error", new Error("stream reset"));
    expect(await result).toEqual({ kind: "retryable", reason: "stream:stream reset" });
  });

  it("410 Unregistered disables the token (permanent_token)", async () => {
    const { session, result } = start();
    session.stream.reply(410, JSON.stringify({ reason: "Unregistered", timestamp: 1_795_609_000_000 }));
    expect(await result).toEqual({ kind: "permanent_token", reason: "Unregistered" });
  });

  it("400 BadDeviceToken is read from the body and disables the token (permanent_token)", async () => {
    const { session, result } = start();
    session.stream.reply(400, JSON.stringify({ reason: "BadDeviceToken" }));
    expect(await result).toEqual({ kind: "permanent_token", reason: "BadDeviceToken" });
  });

  it("an answer cancels the timeout: one result, one close", async () => {
    const { session, result } = start();
    session.stream.reply(400, "not json");
    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(await result).toEqual({ kind: "permanent", reason: "HTTP 400" });
    expect(session.closed).toBe(1);
  });
});
