// Pin delivery: the call succeeds only when a field has content, the port
// accepts it, and the write lands. A failed write leaves no in-memory note.

import { describe, expect, test } from "bun:test";

import { createPinOff, createPinOn } from "../src/features/pin/index.mjs";
import { handlePinCall } from "../src/station/controls.mjs";
import { scopeContextParameters } from "../src/tools/descriptions.mjs";
import { scopeContextTicket } from "../src/tools/tickets.mjs";

function stationWith({ persist = () => true, port = null, description } = {}) {
  const state = { pins: [] };
  const station = {
    state,
    pinPort: () => port ?? createPinOn({ notes: state.pins }),
    persist,
    noteError: () => {},
    description,
  };
  return station;
}

function pinCall(fields) {
  return { id: "pin-call", name: "pin", arguments: fields };
}

describe("pin arguments", () => {
  test("a call with no field is refused", () => {
    const station = stationWith();
    const out = handlePinCall(station, pinCall({}));
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("INVALID_ARGUMENT");
    expect(station.state.pins).toEqual([]);
  });

  test("a field made only of spaces is refused", () => {
    const station = stationWith();
    const out = handlePinCall(station, pinCall({ finding: "   " }));
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("INVALID_ARGUMENT");
    expect(station.state.pins).toEqual([]);
  });

  test("the schema requires a non-blank field", () => {
    const pin = scopeContextParameters.properties.pin;
    expect(pin.additionalProperties).toBe(false);
    expect(pin.anyOf).toHaveLength(5);
    for (const field of ["assumption", "deduction", "induction", "finding", "conclusion"]) {
      expect(pin.anyOf).toContainEqual({ required: [field] });
      expect(pin.properties[field].pattern).toBe("\\S");
      expect(pin.properties[field].minLength).toBe(1);
    }
  });

  test("a disabled port keeps its refusal code", () => {
    const station = stationWith({ port: createPinOff() });
    const out = handlePinCall(station, pinCall({ finding: "the parser leaves the lexer open" }));
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("PIN_UNAVAILABLE");
  });
});

describe("pin persistence", () => {
  test("a successful write keeps exactly one note", () => {
    const station = stationWith();
    const out = handlePinCall(station, pinCall({ finding: "the parser leaves the lexer open" }));
    expect(out.isError).toBeUndefined();
    expect(station.state.pins).toHaveLength(1);
    expect(station.state.pins[0]).toContain("**Finding:**");
  });

  test("the saved receipt sends the caller to the todo ledger now", () => {
    const station = stationWith();
    const out = handlePinCall(station, pinCall({ conclusion: "ship the smaller fix" }));
    expect(out.isError).toBeUndefined();
    const text = out.content[0].text;
    expect(text).toMatch(/^OK\./);
    expect(text).toContain("`todo`");
    expect(text).toContain("now");
  });

  test("persist() === false rolls the note back and refuses", () => {
    const station = stationWith({ persist: () => false });
    const out = handlePinCall(station, pinCall({ finding: "the parser leaves the lexer open" }));
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("PIN_UNAVAILABLE");
    expect(station.state.pins).toEqual([]);
  });

  test("a thrown persist rolls the note back and reports an internal error", () => {
    const station = stationWith({
      persist: () => {
        throw new Error("disk gone");
      },
    });
    const out = handlePinCall(station, pinCall({ finding: "the parser leaves the lexer open" }));
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("PIN_INTERNAL_ERROR");
    expect(station.state.pins).toEqual([]);
  });
});

describe("scope_context ticket boundary", () => {
  test("a throwing execute is an internal error, never OK", async () => {
    const ticket = {
      executeContext() {
        throw new Error("disk gone");
      },
    };
    const out = await scopeContextTicket(ticket, "pin-call", {
      pin: { finding: "the parser leaves the lexer open" },
    });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("PIN_INTERNAL_ERROR");
  });

  test("a call with neither half is refused before any work", async () => {
    let called = 0;
    const ticket = {
      executeContext() {
        called += 1;
        return { content: [{ type: "text", text: "OK" }] };
      },
    };
    const out = await scopeContextTicket(ticket, "empty", {});
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("scope_context-empty");
    expect(called).toBe(0);
  });
});
