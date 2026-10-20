import { describe, expect, test } from "bun:test";
import { RecentCache } from "../recent-cache.ts";

function countingCompute() {
  let calls = 0;
  return {
    compute: () => ++calls,
    calls: () => calls,
  };
}

describe("recent results cache", () => {
  test("asking again for the same text returns the earlier result", () => {
    const cache = new RecentCache<number>(3);
    const counter = countingCompute();
    const first = cache.get("abnf", "a = b", counter.compute);

    const second = cache.get("abnf", "a = b", counter.compute);

    expect(second).toBe(first);
    expect(counter.calls()).toBe(1);
  });

  test("the same text under another scope is computed separately", () => {
    const cache = new RecentCache<number>(3);
    const counter = countingCompute();
    cache.get("abnf", "a = b", counter.compute);

    cache.get("bnf", "a = b", counter.compute);

    expect(counter.calls()).toBe(2);
  });

  test("the oldest text is forgotten once the entry limit is passed", () => {
    const cache = new RecentCache<number>(2);
    const counter = countingCompute();
    cache.get("s", "one", counter.compute);
    cache.get("s", "two", counter.compute);
    cache.get("s", "three", counter.compute);

    cache.get("s", "one", counter.compute);

    expect(counter.calls()).toBe(4);
  });

  test("large texts are forgotten once the total size budget is passed", () => {
    const cache = new RecentCache<number>(10, 100);
    const counter = countingCompute();
    cache.get("s", "a".repeat(60), counter.compute);
    cache.get("s", "b".repeat(60), counter.compute);

    cache.get("s", "a".repeat(60), counter.compute);

    expect(counter.calls()).toBe(3);
  });

  test("the newest text is kept even when it alone exceeds the budget", () => {
    const cache = new RecentCache<number>(10, 100);
    const counter = countingCompute();
    cache.get("s", "x".repeat(500), counter.compute);

    cache.get("s", "x".repeat(500), counter.compute);

    expect(counter.calls()).toBe(1);
  });

  test("small texts stay cached together within the budget", () => {
    const cache = new RecentCache<number>(10, 100);
    const counter = countingCompute();
    cache.get("s", "a".repeat(40), counter.compute);
    cache.get("s", "b".repeat(40), counter.compute);

    cache.get("s", "a".repeat(40), counter.compute);

    expect(counter.calls()).toBe(2);
  });
});
