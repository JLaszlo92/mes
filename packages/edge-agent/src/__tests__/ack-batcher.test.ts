import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AckBatcher } from "../ack-batcher.js";

describe("AckBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands the ids over together after the delay, duplicates collapsed", () => {
    const flush = vi.fn();
    const batcher = new AckBatcher(flush, undefined, 250);
    batcher.add("a");
    batcher.add("b");
    batcher.add("a");
    vi.advanceTimersByTime(249);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect([...flush.mock.calls[0]![0]].sort()).toEqual(["a", "b"]);
  });

  it("starts a new batch for ids that arrive later", () => {
    const flush = vi.fn();
    const batcher = new AckBatcher(flush, undefined, 250);
    batcher.add("a");
    vi.advanceTimersByTime(250);
    batcher.add("b");
    vi.advanceTimersByTime(250);
    expect(flush).toHaveBeenCalledTimes(2);
    expect([...flush.mock.calls[1]![0]]).toEqual(["b"]);
  });

  it("flushNow hands over at once and cancels the timer", () => {
    const flush = vi.fn();
    const batcher = new AckBatcher(flush, undefined, 250);
    batcher.add("a");
    batcher.flushNow();
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(1);
    batcher.flushNow(); // nothing pending: no call
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("reports a failing flush instead of throwing", () => {
    const onError = vi.fn();
    const batcher = new AckBatcher(() => { throw new Error("disk full"); }, onError, 250);
    batcher.add("a");
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
