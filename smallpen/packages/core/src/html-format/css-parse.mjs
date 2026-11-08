// INPUT:  source text of a package's tokens.css
// OUTPUT: root, theme-option and @font-face blocks with declarations
// POS:    Strict reader for the tokens.css subset; no nesting, no selectors
//         beyond :root and :root[data-group="option"].

const SPACE = /\s/;

function skipComment(source, index, issues) {
  const end = source.indexOf("*/", index + 2);
  if (end === -1) {
    issues.push({ code: "css_parse_error", message: "Comment is not closed with */", offset: index });
    return source.length;
  }
  return end + 2;
}

// Finds the end of a value or prelude, honouring strings, parentheses and
// comments. stopCodes lists the characters that end it at depth 0.
function scanUntil(source, index, stops, issues) {
  let depth = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "*") {
      index = skipComment(source, index, issues);
      continue;
    }
    if (char === '"' || char === "'") {
      const close = findQuote(source, index);
      if (close === -1) {
        issues.push({ code: "css_parse_error", message: "String is not closed", offset: index });
        return source.length;
      }
      index = close + 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && stops.includes(char)) return index;
    index += 1;
  }
  return index;
}

function findQuote(source, start) {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") { index += 1; continue; }
    if (source[index] === quote) return index;
    if (source[index] === "\n") return -1;
  }
  return -1;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ");
}

const ROOT_SELECTOR = /^:root$/;
const THEME_SELECTOR = /^:root\[data-([a-z0-9-]+)=(?:"([^"]*)"|'([^']*)')\]$/;

// Returns { rules, issues }. A rule is
// { kind: "root" | "theme" | "font-face", group?, option?, declarations,
//   offset, selector }, a declaration { name, value, offset, valueOffset }.
export function parseTokensCss(source) {
  const issues = [];
  const rules = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (SPACE.test(char)) { index += 1; continue; }
    if (char === "/" && source[index + 1] === "*") {
      index = skipComment(source, index, issues);
      continue;
    }
    const preludeStart = index;
    const open = scanUntil(source, index, "{;}", issues);
    if (source[open] !== "{") {
      issues.push({
        code: "unsupported_css_rule",
        message: "tokens.css only holds :root blocks, :root[data-group=\"option\"] blocks and @font-face",
        offset: preludeStart,
      });
      index = open + 1;
      continue;
    }
    const selector = stripComments(source.slice(preludeStart, open)).trim().replace(/\s+/g, " ");
    const declarations = [];
    let cursor = open + 1;
    let closed = false;
    while (cursor < source.length) {
      const c = source[cursor];
      if (SPACE.test(c) || c === ";") { cursor += 1; continue; }
      if (c === "/" && source[cursor + 1] === "*") {
        cursor = skipComment(source, cursor, issues);
        continue;
      }
      if (c === "}") { closed = true; cursor += 1; break; }
      if (c === "{") {
        issues.push({ code: "unsupported_css_rule", message: "tokens.css does not allow nested blocks", offset: cursor });
        cursor = scanUntil(source, cursor + 1, "}", issues) + 1;
        continue;
      }
      const nameStart = cursor;
      const colon = scanUntil(source, cursor, ":;}", issues);
      if (source[colon] !== ":") {
        issues.push({ code: "css_parse_error", message: "Declaration needs name: value", offset: nameStart });
        cursor = source[colon] === "}" ? colon : colon + 1;
        continue;
      }
      const name = source.slice(nameStart, colon).trim();
      const valueStart = colon + 1;
      const valueEnd = scanUntil(source, valueStart, ";}", issues);
      const rawValue = source.slice(valueStart, valueEnd);
      const leading = rawValue.length - rawValue.trimStart().length;
      declarations.push({
        name,
        value: stripComments(rawValue).trim(),
        offset: nameStart,
        valueOffset: valueStart + leading,
      });
      cursor = source[valueEnd] === ";" ? valueEnd + 1 : valueEnd;
    }
    if (!closed) {
      issues.push({ code: "css_parse_error", message: `Block ${selector} is not closed with }`, offset: preludeStart });
    }
    const rule = { selector, declarations, offset: preludeStart };
    let theme;
    if (ROOT_SELECTOR.test(selector)) {
      rule.kind = "root";
    } else if ((theme = THEME_SELECTOR.exec(selector))) {
      rule.kind = "theme";
      rule.group = theme[1];
      rule.option = theme[2] ?? theme[3];
    } else if (selector === "@font-face") {
      rule.kind = "font-face";
    } else {
      rule.kind = "unsupported";
      issues.push({
        code: "unsupported_css_rule",
        message: `Unsupported rule ${selector}: use :root, :root[data-group="option"] or @font-face`,
        offset: preludeStart,
      });
    }
    rules.push(rule);
    index = cursor;
  }
  return { rules, issues };
}

// Splits a CSS value on top-level whitespace or commas, keeping strings and
// function arguments whole.
export function splitCssValue(value, separator = " ") {
  const parts = [];
  let depth = 0;
  let start = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0 && (separator === " " ? SPACE.test(char) : char === separator)) {
      const part = value.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

export function unquoteCss(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(?:a ?|(.))/g, (_, char) => char ?? "\n");
  }
  return undefined;
}

export function quoteCss(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`;
}
