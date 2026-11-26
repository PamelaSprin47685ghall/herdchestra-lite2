// Waiting on a peer is not this branch's work.
//
// `scope_request` parks the caller's script until the target answers, and that
// wait can be long. The branch clock must not run while it waits — otherwise a
// scope that asks a slow peer goes over its own budget for time it did not
// spend. These cases pin the pause/resume pair around every exit, including a
// throwing handler, and the fact that concurrent waits nest instead of
// cancelling each other.

import { describe, expect, test } from "bun:test";

import { textResult } from "../src/tools/results.mjs";
import { replyTicket, requestTicket } from "../src/tools/tickets.mjs";

/** A station that records the clock bookkeeping and answers from a script. */
function clockStation(handler) {
  const log = [];
  return {
    log,
    station: {
      noteRootWait: (delta) => log.push(`wait:${delta}`),
      pauseBranchClock: () => log.push("pause"),
      resumeBranchClock: () => log.push("resume"),
      handleScopeRequest: handler,
    },
  };
}

describe("the branch clock pauses while the caller waits", () => {
  test("a request pauses, waits, and resumes on the same line", async () => {
    const { log, station } = clockStation(async () =>
      textResult("accessToken", { result: { ok: true, from: "/worker", reply: "accessToken" } }),
    );
    const out = await requestTicket(station, "call-req-1", {}, {});
    expect(out.details.result.reply).toBe("accessToken");
    // Root is waiting on a child: the join bookkeeping sees it, and the clock
    // is stopped for exactly the wait.
    expect(log).toEqual(["wait:1", "pause", "wait:-1", "resume"]);
  });

  test("a handler that throws still resumes the clock", async () => {
    const { log, station } = clockStation(async () => {
      throw new Error("registry exploded");
    });
    const out = await requestTicket(station, "call-req-2", {}, {});
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("REQUEST_INTERNAL_ERROR");
    expect(out.content[0].text).toMatch(/registry exploded/);
    // An abandoned request must not leave the branch's clock stopped: that
    // would hand the scope unlimited time as a reward for failing.
    expect(log).toEqual(["wait:1", "pause", "wait:-1", "resume"]);
  });

  test("concurrent waits nest: two pauses need two resumes", async () => {
    const resolvers = [];
    const { log, station } = clockStation(
      () => new Promise((resolve) => resolvers.push(() => resolve(textResult("ok")))),
    );
    const first = requestTicket(station, "call-req-3", {}, {});
    const second = requestTicket(station, "call-req-4", {}, {});
    await Promise.resolve();
    expect(log.filter((entry) => entry === "pause")).toHaveLength(2);
    expect(log.filter((entry) => entry === "resume")).toHaveLength(0);

    resolvers[0]();
    await first;
    expect(log.filter((entry) => entry === "resume")).toHaveLength(1);
    resolvers[1]();
    await second;
    expect(log.filter((entry) => entry === "resume")).toHaveLength(2);
    expect(log.filter((entry) => entry === "wait:1")).toHaveLength(2);
    expect(log.filter((entry) => entry === "wait:-1")).toHaveLength(2);
  });

  test("a station without the clock hooks still answers", async () => {
    const station = { handleScopeRequest: async () => textResult("fine") };
    const out = await requestTicket(station, "call-req-5", {}, {});
    expect(out.content[0].text).toBe("fine");
  });

  test("a station that cannot request says so instead of hanging", async () => {
    const out = await requestTicket({}, "call-req-6", {}, {});
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("REQUEST_UNAVAILABLE");
  });
});

describe("scope_reply is the answer half of the same contract", () => {
  test("a reply returns ok:true once the station answered the queue head", async () => {
    const station = {
      handleScopeReply: () => textResult("done", { result: { ok: true } }),
    };
    const out = await replyTicket(station, "call-rep-1", { reply: "done" }, {});
    expect(out.details.result).toEqual({ ok: true });
  });

  test("a station with nothing to answer refuses", async () => {
    const out = await replyTicket({}, "call-rep-2", "anything", {});
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("REPLY_UNAVAILABLE");
  });
});
