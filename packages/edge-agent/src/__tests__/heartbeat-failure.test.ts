import { describe, expect, it } from "vitest";
import { classifyHeartbeatFailure, HeartbeatHttpError } from "../heartbeat-failure.js";

describe("classifyHeartbeatFailure", () => {
  it("treats 409 (the session is not the current one) as a lost lease", () => {
    expect(classifyHeartbeatFailure(new HeartbeatHttpError(409, "x"))).toBe("lease_lost");
  });

  it.each([400, 401, 403, 404])("treats %i as a lost lease (the backend answered and said no)", (status) => {
    expect(classifyHeartbeatFailure(new HeartbeatHttpError(status, "x"))).toBe("lease_lost");
  });

  it.each([408, 429, 500, 502, 503, 504])("treats %i as transient (the backend is busy or down)", (status) => {
    expect(classifyHeartbeatFailure(new HeartbeatHttpError(status, "x"))).toBe("transient");
  });

  it("treats a network error or a timeout as transient", () => {
    expect(classifyHeartbeatFailure(new TypeError("fetch failed"))).toBe("transient");
    expect(classifyHeartbeatFailure(Object.assign(new Error("timeout"), { name: "TimeoutError" }))).toBe("transient");
  });

  it("treats anything that is not an error as transient", () => {
    expect(classifyHeartbeatFailure(undefined)).toBe("transient");
    expect(classifyHeartbeatFailure("409")).toBe("transient");
  });

  it("keeps the status on the error", () => {
    const err = new HeartbeatHttpError(409, "another instance");
    expect(err.status).toBe(409);
    expect(err.name).toBe("HeartbeatHttpError");
    expect(err).toBeInstanceOf(Error);
  });
});
