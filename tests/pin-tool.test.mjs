// Pin delivery: the call succeeds only when a field has content, the port
// accepts it, and the write lands. A failed write leaves no in-memory note.

import { describe, expect, test } from "bun:test";

import { createPinOff, createPinOn } from "../src/features/pin/index.mjs";
import { handlePinCall } from "../src/station/controls.mjs";
import { pinParameters } from "../src/tools/descriptions.mjs";
import { pinTicket } from "../src/tools/tickets.mjs";

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
    expect(pinParameters.additionalProperties).toBe(false);
    expect(pinParameters.anyOf).toHaveLength(5);
    for (const field of ["assumption", "deduction", "induction", "finding", "conclusion"]) {
      expect(pinParameters.anyOf).toContainEqual({ required: [field] });
      expect(pinParameters.properties[field].pattern).toBe("\\S");
      expect(pinParameters.properties[field].minLength).toBe(1);
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

describe("pin ticket boundary", () => {
  test("a throwing port add is an internal error, never OK", async () => {
    const inner = stationWith({
      port: {
        add() {
          throw new Error("disk gone");
        },
      },
    });
    const ticket = {
      executePin: (id, params) => handlePinCall(inner, { id, arguments: params }),
    };
    const first = await pinTicket(ticket, "pin-call", {
      finding: "the parser leaves the lexer open",
    });
    expect(first.isError).toBe(true);
    expect(first.details.code).toBe("PIN_INTERNAL_ERROR");
    const second = await pinTicket(ticket, "pin-call", {
      finding: "the parser leaves the lexer open",
    });
    expect(second.isError).toBe(true);
    expect(second.details.code).toBe("PIN_INTERNAL_ERROR");
    expect(inner.state.pins).toEqual([]);
  });
});
