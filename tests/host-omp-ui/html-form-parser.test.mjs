// `ask` ships a model-authored HTML form. The Web must render it without ever
// executing it, and it must enforce the same constraints omp enforces on the
// way back: an invalid answer fails the whole tool call, with no correction
// round. Parsing and validation therefore live in one pure module.

import { expect, test } from "bun:test";

const MODULE = "../../host-omp-ui/src/station/domain/html-form-parser.mjs";

async function load() {
	return import(MODULE);
}

const HTML = `
<form>
  <p>Pick a color and tell me about yourself.</p>
  <ul><li>One</li><li>Two</li></ul>
  <table><tr><th>Key</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>
  <pre>const a = 1;</pre>
  <script>alert(1)</script>
  <style>.x { color: red }</style>
  <a href="javascript:alert(2)">bad link</a>
  <img src="x" onerror="alert(3)">
  <fieldset>
    <legend>Details</legend>
    <label><input type="radio" name="color" value="red" checked> Red</label>
    <label><input type="radio" name="color" value="blue"> Blue</label>
    <label><input type="radio" name="solo" value="only"> Only</label>
    <label>Name <input type="text" name="name" placeholder="Your name" required></label>
    <label>Age <input type="number" name="age" min="1" max="120"></label>
    <label>Date <input type="date" name="when"></label>
    <label>Email <input type="email" name="email"></label>
    <label>Site <input type="url" name="site"></label>
    <label>Code <input type="text" name="code" pattern="[A-Z]{3}"></label>
    <input type="hidden" name="token" value="abc">
    <label><input type="checkbox" name="features" value="a" checked> A</label>
    <label><input type="checkbox" name="features" value="b"> B</label>
    <label>Size <select name="size"><option value="s">S</option><option value="m" selected>M</option></select></label>
    <label>Tags <select name="tags" multiple><option value="x">X</option><option value="y">Y</option></select></label>
    <label>Notes <textarea name="notes" required></textarea></label>
  </fieldset>
</form>`;

function field(parsed, name) {
	const found = parsed.fields.find((item) => item.name === name);
	expect(found).toBeDefined();
	return found;
}

test("parses context blocks and every supported control", async () => {
	const { parseAskHtmlForm } = await load();
	const parsed = parseAskHtmlForm(HTML);

	expect(parsed.contexts.length).toBeGreaterThanOrEqual(4);
	expect(parsed.contexts.map((context) => context.type)).toContain("paragraph");
	expect(parsed.contexts.map((context) => context.type)).toContain("list");
	expect(parsed.contexts.map((context) => context.type)).toContain("table");
	expect(parsed.contexts.map((context) => context.type)).toContain("pre");

	const color = field(parsed, "color");
	expect(color.type).toBe("radio");
	expect(color.options.map((option) => option.value)).toEqual(["red", "blue"]);
	expect(color.allowOther).toBe(true);

	const features = field(parsed, "features");
	expect(features.type).toBe("checkbox");
	expect(features.options.map((option) => option.value)).toEqual(["a", "b"]);
	expect(features.allowOther).toBe(true);
	expect(features.value).toEqual(["a"]);

	const name = field(parsed, "name");
	expect(name.type).toBe("text");
	expect(name.required).toBe(true);
	expect(name.placeholder).toBe("Your name");

	expect(field(parsed, "age")).toMatchObject({ type: "number", min: "1", max: "120" });
	expect(field(parsed, "when").type).toBe("date");
	expect(field(parsed, "email").type).toBe("email");
	expect(field(parsed, "site").type).toBe("url");
	expect(field(parsed, "code").pattern).toBe("[A-Z]{3}");
	expect(field(parsed, "token")).toMatchObject({ type: "hidden", value: "abc" });
	expect(field(parsed, "size")).toMatchObject({ type: "select", value: "m" });
	expect(field(parsed, "tags").multiple).toBe(true);
	expect(field(parsed, "notes")).toMatchObject({ type: "textarea", required: true });
});

test("strips executable markup instead of forwarding it", async () => {
	const { parseAskHtmlForm } = await load();
	const serialized = JSON.stringify(parseAskHtmlForm(HTML));
	expect(serialized).not.toContain("alert(1)");
	expect(serialized).not.toContain("alert(2)");
	expect(serialized).not.toContain("alert(3)");
	expect(serialized).not.toContain("onerror");
	expect(serialized).not.toContain("javascript:");
});

test("a two-option radio or checkbox group gets Other; a single option does not", async () => {
	const { parseAskHtmlForm } = await load();
	const parsed = parseAskHtmlForm(HTML);
	expect(field(parsed, "color").allowOther).toBe(true);
	expect(field(parsed, "features").allowOther).toBe(true);
	expect(field(parsed, "solo").allowOther).toBe(false);
});

test("defaults come from checked, selected and value attributes", async () => {
	const { parseAskHtmlForm, buildDefaultFormData } = await load();
	const defaults = buildDefaultFormData(parseAskHtmlForm(HTML));
	expect(defaults.color).toBe("red");
	expect(defaults.features).toEqual(["a"]);
	expect(defaults.size).toBe("m");
	expect(defaults.token).toBe("abc");
});

test("accepts a fully valid submission", async () => {
	const { parseAskHtmlForm, validateFormSubmission } = await load();
	const parsed = parseAskHtmlForm(HTML);
	const result = validateFormSubmission(parsed, {
		color: "blue",
		name: "Ada",
		age: "30",
		when: "2026-01-01",
		email: "ada@example.com",
		site: "https://example.com",
		code: "ABC",
		token: "abc",
		features: ["a"],
		size: "m",
		tags: ["x"],
		notes: "hello",
	});
	expect(result.ok).toBe(true);
	expect(result.normalized.color).toBe("blue");
});

test("rejects whitespace required, out-of-range, malformed and unknown fields", async () => {
	const { parseAskHtmlForm, validateFormSubmission } = await load();
	const parsed = parseAskHtmlForm(HTML);

	const blank = validateFormSubmission(parsed, { name: "   ", notes: "ok" });
	expect(blank.ok).toBe(false);
	expect(blank.errors.name).toBeTruthy();

	const low = validateFormSubmission(parsed, { name: "Ada", notes: "ok", age: "0" });
	expect(low.ok).toBe(false);
	expect(low.errors.age).toBeTruthy();

	const high = validateFormSubmission(parsed, { name: "Ada", notes: "ok", age: "121" });
	expect(high.ok).toBe(false);
	expect(high.errors.age).toBeTruthy();

	const badEmail = validateFormSubmission(parsed, { name: "Ada", notes: "ok", email: "bad" });
	expect(badEmail.ok).toBe(false);
	expect(badEmail.errors.email).toBeTruthy();

	const badUrl = validateFormSubmission(parsed, { name: "Ada", notes: "ok", site: "ftp://example.com" });
	expect(badUrl.ok).toBe(false);
	expect(badUrl.errors.site).toBeTruthy();

	const badPattern = validateFormSubmission(parsed, { name: "Ada", notes: "ok", code: "ab" });
	expect(badPattern.ok).toBe(false);
	expect(badPattern.errors.code).toBeTruthy();

	const unknown = validateFormSubmission(parsed, { name: "Ada", notes: "ok", nope: "x" });
	expect(unknown.ok).toBe(false);
	expect(unknown.errors.nope).toBeTruthy();
});

test("drops a hidden-value echo from a checkbox array", async () => {
	const { parseAskHtmlForm, validateFormSubmission } = await load();
	const parsed = parseAskHtmlForm(HTML);
	const result = validateFormSubmission(parsed, {
		name: "Ada",
		notes: "ok",
		token: "abc",
		features: ["a", "abc"],
	});
	expect(result.ok).toBe(true);
	expect(result.normalized.features).toEqual(["a"]);
});

test("Other free text is legal only where Other is offered", async () => {
	const { parseAskHtmlForm, validateFormSubmission } = await load();
	const parsed = parseAskHtmlForm(HTML);

	const otherRadio = validateFormSubmission(parsed, { name: "Ada", notes: "ok", color: "green" });
	expect(otherRadio.ok).toBe(true);

	const otherCheckbox = validateFormSubmission(parsed, { name: "Ada", notes: "ok", features: ["a", "custom"] });
	expect(otherCheckbox.ok).toBe(true);

	const noOther = validateFormSubmission(parsed, { name: "Ada", notes: "ok", solo: "other" });
	expect(noOther.ok).toBe(false);
	expect(noOther.errors.solo).toBeTruthy();
});
