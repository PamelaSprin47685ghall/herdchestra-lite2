// The `ask` tool ships a model-authored HTML form. This module turns that HTML
// into a safe, structured form model. It never forwards executable markup: the
// browser receives data, not an `innerHTML` string.

const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_HREF = /\s+href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi;

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripTags(text) {
  return decodeEntities(
    String(text)
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function sanitize(html) {
  return String(html)
    .replace(SCRIPT, "")
    .replace(STYLE, "")
    .replace(EVENT_ATTR, "")
    .replace(JS_HREF, "");
}

function parseAttrs(text) {
  const attrs = {};
  const pattern =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(text))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function has(attrs, name) {
  return Object.prototype.hasOwnProperty.call(attrs, name);
}

function contextsOf(html) {
  const contexts = [];
  for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripTags(match[1]);
    if (text) contexts.push({ type: "paragraph", text });
  }
  for (const match of html.matchAll(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi)) {
    const items = Array.from(match[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi), (item) =>
      stripTags(item[1]),
    ).filter(Boolean);
    if (items.length) contexts.push({ type: "list", items });
  }
  for (const match of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = Array.from(match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), (row) =>
      Array.from(row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi), (cell) =>
        stripTags(cell[1]),
      ),
    ).filter((row) => row.length > 0);
    if (rows.length) contexts.push({ type: "table", rows });
  }
  for (const match of html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)) {
    const text = decodeEntities(match[1]).replace(/<[^>]*>/g, "").trim();
    if (text) contexts.push({ type: "pre", text });
  }
  return contexts;
}

function labelAfter(html, tagEnd, tagStart) {
  const close = html.indexOf("</label>", tagEnd);
  if (close !== -1) {
    const after = stripTags(html.slice(tagEnd, close));
    if (after) return after;
  }
  const open = html.lastIndexOf("<label", tagStart);
  if (open !== -1) {
    const before = stripTags(html.slice(open, tagStart).replace(/<[^>]*>/, ""));
    if (before) return before;
  }
  return "";
}

function ensureField(fields, name) {
  let field = fields.get(name);
  if (!field) {
    field = {
      name,
      type: "text",
      label: name,
      question: name,
      required: false,
      options: [],
      allowOther: false,
    };
    fields.set(name, field);
  }
  return field;
}

function addOption(field, value, label, checked) {
  field.options.push({ value, label: label || value });
  if (checked) {
    if (field.type === "checkbox") {
      field.value = Array.isArray(field.value) ? [...field.value, value] : [value];
    } else {
      field.value = value;
    }
  }
}

function parseFields(html) {
  const fields = new Map();
  const order = [];

  for (const match of html.matchAll(/<input\b([^>]*)\/?>/gi)) {
    const attrs = parseAttrs(match[1]);
    const name = attrs.name;
    if (!name) continue;
    const type = (attrs.type || "text").toLowerCase();
    const tagStart = match.index ?? 0;
    const tagEnd = tagStart + match[0].length;
    const label = labelAfter(html, tagEnd, tagStart);
    const checked = has(attrs, "checked");

    if (type === "radio" || type === "checkbox") {
      let field = fields.get(name);
      if (!field) {
        field = ensureField(fields, name);
        field.type = type;
        order.push(name);
      }
      addOption(field, attrs.value ?? "", label, checked);
      continue;
    }

    let field = fields.get(name);
    if (!field) {
      field = ensureField(fields, name);
      order.push(name);
    }
    field.type = type === "text" || type === "number" || type === "date" || type === "email" ||
      type === "url" || type === "hidden"
      ? type
      : "text";
    field.label = label || name;
    field.question = label || name;
    field.required = has(attrs, "required");
    field.placeholder = attrs.placeholder;
    field.min = attrs.min;
    field.max = attrs.max;
    field.minlength = attrs.minlength;
    field.maxlength = attrs.maxlength;
    field.pattern = attrs.pattern;
    if (attrs.value !== undefined) field.value = attrs.value;
    if (type === "hidden") field.hidden = true;
  }

  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const attrs = parseAttrs(match[1]);
    const name = attrs.name;
    if (!name) continue;
    const field = ensureField(fields, name);
    field.type = "select";
    field.multiple = has(attrs, "multiple");
    field.label = name;
    field.question = name;
    field.options = [];
    field.value = field.multiple ? [] : undefined;
    for (const option of match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const optionAttrs = parseAttrs(option[1]);
      const value = optionAttrs.value ?? stripTags(option[2]);
      const label = stripTags(option[2]) || value;
      field.options.push({ value, label });
      if (has(optionAttrs, "selected")) {
        if (field.multiple) field.value.push(value);
        else field.value = value;
      }
    }
    if (!order.includes(name)) order.push(name);
  }

  for (const match of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const attrs = parseAttrs(match[1]);
    const name = attrs.name;
    if (!name) continue;
    const field = ensureField(fields, name);
    field.type = "textarea";
    field.label = name;
    field.question = name;
    field.required = has(attrs, "required");
    field.placeholder = attrs.placeholder;
    field.value = decodeEntities(match[2]).trim();
    if (!order.includes(name)) order.push(name);
  }

  for (const field of fields.values()) {
    if (field.type === "radio" || field.type === "checkbox") {
      const hasOther = field.options.some(
        (option) => option.label.toLowerCase() === "other" || option.value.toLowerCase() === "other",
      );
      field.allowOther = field.options.length > 1 && !hasOther;
    }
  }

  return { fields: order.map((name) => fields.get(name)), byName: fields };
}

export function parseAskHtmlForm(html) {
  const clean = sanitize(html);
  const { fields, byName } = parseFields(clean);
  return {
    contexts: contextsOf(clean),
    fields,
    byName,
  };
}

export function buildDefaultFormData(parsedForm) {
  const data = {};
  for (const field of parsedForm.fields) {
    if (field.value === undefined) continue;
    if (Array.isArray(field.value)) data[field.name] = [...field.value];
    else data[field.name] = field.value;
  }
  return data;
}

function errorFor(field, value) {
  if (field.type === "hidden") return undefined;
  if (value === undefined || value === null) {
    return field.required ? "Required" : undefined;
  }

  if (field.type === "checkbox") {
    const values = Array.isArray(value) ? value : [value];
    const allowed = new Set(field.options.map((option) => option.value));
    for (const entry of values) {
      if (entry === "" || entry === undefined) continue;
      if (!allowed.has(entry) && !field.allowOther) return "Choose a listed option";
    }
    return undefined;
  }

  if (field.type === "radio") {
    if (value === "") return field.required ? "Required" : undefined;
    const allowed = new Set(field.options.map((option) => option.value));
    if (!allowed.has(value) && !field.allowOther) return "Choose a listed option";
    return undefined;
  }

  if (field.type === "select") {
    const allowed = new Set(field.options.map((option) => option.value));
    if (field.multiple) {
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) if (!allowed.has(entry)) return "Choose a listed option";
      return undefined;
    }
    if (!allowed.has(value)) return "Choose a listed option";
    return undefined;
  }

  const text = String(value);
  if (text.trim() === "") return field.required ? "Required" : undefined;
  if (field.type === "number") {
    const number = Number(text);
    if (!Number.isFinite(number)) return "Enter a number";
    if (field.min !== undefined && number < Number(field.min)) return `Minimum is ${field.min}`;
    if (field.max !== undefined && number > Number(field.max)) return `Maximum is ${field.max}`;
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return "Enter a valid email";
  }
  if (field.type === "url") {
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "Enter an http(s) URL";
    } catch {
      return "Enter a valid URL";
    }
  }
  if (field.minlength && text.length < Number(field.minlength)) {
    return `At least ${field.minlength} characters`;
  }
  if (field.maxlength && text.length > Number(field.maxlength)) {
    return `At most ${field.maxlength} characters`;
  }
  if (field.pattern) {
    try {
      if (!new RegExp(`^(?:${field.pattern})$`).test(text)) return "Does not match the pattern";
    } catch {
      // An invalid pattern is ignored, as omp does.
    }
  }
  return undefined;
}

export function validateFormSubmission(parsedForm, data) {
  const errors = {};
  const normalized = { ...data };

  for (const key of Object.keys(data)) {
    if (!parsedForm.byName.has(key)) errors[key] = "Unknown field";
  }

  const hiddenValues = new Set(
    parsedForm.fields.filter((field) => field.type === "hidden").map((field) => field.value),
  );

  for (const field of parsedForm.fields) {
    if (!Object.prototype.hasOwnProperty.call(data, field.name)) {
      if (field.required && field.type !== "hidden") errors[field.name] = "Required";
      continue;
    }
    let value = data[field.name];
    if (field.type === "checkbox" && Array.isArray(value)) {
      value = value.filter((entry) => !hiddenValues.has(entry));
      value = Array.from(new Set(value));
      normalized[field.name] = value;
    }
    const error = errorFor(field, value);
    if (error) errors[field.name] = error;
  }

  return { ok: Object.keys(errors).length === 0, normalized, errors };
}

export function formatFormAnswers(parsedForm, data) {
  const answers = [];
  for (const field of parsedForm.fields) {
    if (field.type === "hidden") continue;
    if (!Object.prototype.hasOwnProperty.call(data, field.name)) continue;
    const value = data[field.name];
    if (value === undefined) continue;
    let answer = value;
    if (field.type === "radio" || field.type === "select") {
      const option = field.options.find((item) => item.value === value);
      answer = option ? option.label : value;
    } else if (field.type === "checkbox") {
      const values = Array.isArray(value) ? value : [value];
      answer = values
        .map((entry) => field.options.find((option) => option.value === entry)?.label ?? entry)
        .join(", ");
    }
    answers.push({ name: field.name, question: field.question, answer });
  }
  return answers;
}
