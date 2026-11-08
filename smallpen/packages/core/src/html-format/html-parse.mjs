// INPUT:  source text of one SmallPen HTML file
// OUTPUT: element tree with source offsets, plus parse issues
// POS:    Strict HTML-subset reader shared by check, decode and the App.
//         One pass over char codes, no regular expressions in the hot loop,
//         no dependencies: it runs the same in Node, Electron and browsers.

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "source", "track", "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);
const ESCAPABLE_RAW_TEXT_ELEMENTS = new Set(["title", "textarea"]);

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  times: "×", divide: "÷", middot: "·", bull: "•",
  euro: "€", yen: "¥", pound: "£", cent: "¢",
  deg: "°", plusmn: "±", larr: "←", rarr: "→",
  uarr: "↑", darr: "↓", check: "✓",
};

// Char codes used by the scanner.
const LT = 60, GT = 62, SLASH = 47, BANG = 33, QUESTION = 63, EQ = 61;
const DQ = 34, SQ = 39, AMP = 38, SEMI = 59, HASH = 35, DASH = 45;

function isSpace(code) {
  return code === 32 || code === 10 || code === 9 || code === 13 || code === 12;
}

function isNameStart(code) {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function isNameChar(code) {
  return isNameStart(code) || (code >= 48 && code <= 57) || code === DASH ||
    code === 95 || code === 58 || code === 46;
}

function isAttrNameChar(code) {
  return !(isSpace(code) || code === SLASH || code === GT || code === EQ ||
    code === DQ || code === SQ || code === LT || Number.isNaN(code));
}

// Line starts are built once and searched with a binary search, so turning
// offsets into line/column stays cheap even for many issues.
export function createLineIndex(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return function position(offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - starts[low] + 1 };
  };
}

function decodeEntities(text, offset, issues) {
  if (text.indexOf("&") === -1) return text;
  let result = "";
  let last = 0;
  for (let index = text.indexOf("&"); index !== -1; index = text.indexOf("&", last)) {
    result += text.slice(last, index);
    const end = text.indexOf(";", index + 1);
    const body = end === -1 ? "" : text.slice(index + 1, end);
    let decoded;
    if (end !== -1 && end - index <= 33) {
      if (body.charCodeAt(0) === HASH) {
        const hex = body[1] === "x" || body[1] === "X";
        const digits = body.slice(hex ? 2 : 1);
        const value = digits && /^[0-9a-fA-F]+$/.test(digits)
          ? Number.parseInt(digits, hex ? 16 : 10)
          : Number.NaN;
        if (Number.isInteger(value) && value > 0 && value <= 0x10ffff &&
            !(value >= 0xd800 && value <= 0xdfff)) {
          decoded = String.fromCodePoint(value);
        }
      } else if (Object.hasOwn(NAMED_ENTITIES, body)) {
        decoded = NAMED_ENTITIES[body];
      }
    }
    if (decoded === undefined) {
      issues.push({
        code: "unknown_entity",
        message: `Unknown character reference &${body || "…"}; write the character itself`,
        offset: offset + index,
      });
      result += "&";
      last = index + 1;
    } else {
      result += decoded;
      last = end + 1;
    }
  }
  return result + text.slice(last);
}

function issue(issues, code, message, offset, extra) {
  issues.push(extra ? { code, message, offset, ...extra } : { code, message, offset });
}

// Returns { root, doctype, issues }. root.children holds the top-level
// nodes; elements are { type: "element", tag, attrs, children, offset,
// end, closeOffset }, text is { type: "text", text, offset, end }.
// attrs is an array of { name, value, offset, valueOffset } in source order.
const MAX_DEPTH = 256;

export function parseHtml(source) {
  const issues = [];
  const root = { type: "root", tag: "#root", attrs: [], children: [], offset: 0, end: source.length };
  const stack = [root];
  let tooDeep = false;
  let svgDepth = 0;
  let doctype = false;
  let index = 0;
  const length = source.length;

  const current = () => stack[stack.length - 1];

  const pushText = (start, end) => {
    if (end <= start) return;
    const raw = source.slice(start, end);
    current().children.push({
      type: "text",
      text: decodeEntities(raw, start, issues),
      offset: start,
      end,
    });
  };

  const closeElement = (element, end) => {
    element.end = end;
    if (element.tag === "svg") svgDepth -= 1;
  };

  while (index < length) {
    const textStart = index;
    const next = source.indexOf("<", index);
    if (next === -1) {
      pushText(textStart, length);
      break;
    }
    pushText(textStart, next);
    index = next;
    const code = source.charCodeAt(index + 1);

    if (code === BANG) {
      if (source.startsWith("<!--", index)) {
        const end = source.indexOf("-->", index + 4);
        if (end === -1) {
          issue(issues, "html_parse_error", "Comment is not closed with -->", index);
          index = length;
        } else {
          index = end + 3;
        }
        continue;
      }
      const end = source.indexOf(">", index);
      const body = source.slice(index + 2, end === -1 ? length : end).trim();
      if (/^doctype\s+html$/i.test(body)) {
        doctype = true;
      } else {
        issue(issues, "html_parse_error", `Unsupported markup <!${body.slice(0, 20)}>`, index);
      }
      index = end === -1 ? length : end + 1;
      continue;
    }

    if (code === QUESTION) {
      const end = source.indexOf(">", index);
      issue(issues, "html_parse_error", "Processing instructions are not HTML", index);
      index = end === -1 ? length : end + 1;
      continue;
    }

    if (code === SLASH) {
      // End tag.
      let cursor = index + 2;
      const nameStart = cursor;
      while (cursor < length && isNameChar(source.charCodeAt(cursor))) cursor += 1;
      const tag = source.slice(nameStart, cursor).toLowerCase();
      const end = source.indexOf(">", cursor);
      if (!tag) {
        issue(issues, "html_parse_error", "End tag has no name", index);
        index = end === -1 ? length : end + 1;
        continue;
      }
      if (end === -1) {
        issue(issues, "html_parse_error", `End tag </${tag}> is not closed with >`, index);
        index = length;
        continue;
      }
      const tail = source.slice(cursor, end);
      if (tail.trim()) {
        issue(issues, "html_parse_error", `End tag </${tag} is missing its >, so the next tag was read into it; write </${tag}>`, index);
      }
      let match = stack.length - 1;
      while (match > 0 && stack[match].tag !== tag) match -= 1;
      if (match === 0) {
        issue(
          issues,
          "html_parse_error",
          VOID_ELEMENTS.has(tag)
            ? `<${tag}> has no end tag; remove </${tag}>`
            : `End tag </${tag}> has no matching start tag`,
          index,
        );
      } else {
        while (stack.length - 1 > match) {
          const open = stack.pop();
          issue(issues, "html_parse_error", `<${open.tag}> is not closed before </${tag}>`, open.offset, { tag: open.tag });
          closeElement(open, index);
        }
        const element = stack.pop();
        element.closeOffset = index;
        closeElement(element, end + 1);
      }
      index = end + 1;
      continue;
    }

    if (!isNameStart(code)) {
      // A lone "<" is text in HTML; ask for &lt; so text stays unambiguous.
      issue(issues, "html_parse_error", 'Write "<" in text as &lt;', index);
      current().children.push({ type: "text", text: "<", offset: index, end: index + 1 });
      index += 1;
      continue;
    }

    // Start tag.
    let cursor = index + 1;
    const nameStart = cursor;
    while (cursor < length && isNameChar(source.charCodeAt(cursor))) cursor += 1;
    const tag = source.slice(nameStart, cursor).toLowerCase();
    const attrs = [];
    // After a missing closing quote the rest of the tag reads as junk; the
    // one error says why, so the junk is not reported again.
    let brokenQuote = false;
    const seen = new Set();
    let selfClosing = false;
    let closed = false;
    while (cursor < length) {
      let c = source.charCodeAt(cursor);
      while (isSpace(c)) { cursor += 1; c = source.charCodeAt(cursor); }
      if (c === GT) { cursor += 1; closed = true; break; }
      if (c === SLASH && source.charCodeAt(cursor + 1) === GT) {
        selfClosing = true;
        cursor += 2;
        closed = true;
        break;
      }
      if (cursor >= length || c === LT) break;
      const attrStart = cursor;
      while (cursor < length && isAttrNameChar(source.charCodeAt(cursor))) cursor += 1;
      if (cursor === attrStart) {
        if (!brokenQuote) issue(issues, "html_parse_error", `Unexpected character in <${tag}>`, cursor);
        cursor += 1;
        continue;
      }
      const name = source.slice(attrStart, cursor).toLowerCase();
      let value = "";
      let valueOffset = cursor;
      let probe = cursor;
      while (isSpace(source.charCodeAt(probe))) probe += 1;
      if (source.charCodeAt(probe) === EQ) {
        probe += 1;
        while (isSpace(source.charCodeAt(probe))) probe += 1;
        const quote = source.charCodeAt(probe);
        if (quote === DQ || quote === SQ) {
          const close = source.indexOf(quote === DQ ? '"' : "'", probe + 1);
          if (close === -1) {
            issue(issues, "html_parse_error", `Attribute ${name} is not closed with a quote`, attrStart);
            value = source.slice(probe + 1);
            cursor = length;
          } else {
            valueOffset = probe + 1;
            const raw = source.slice(probe + 1, close);
            // A missing closing quote makes the value run into the next
            // attribute: data-name="Badge class=" ... reads class as words.
            const swallowed = /\s([a-z][a-z0-9-]*)=$/.exec(raw);
            if (swallowed) {
              brokenQuote = true;
              const before = raw.slice(0, swallowed.index).trimEnd();
              issue(issues, "html_parse_error", `${name}="${before.slice(0, 40)} is missing its closing quote, so ${swallowed[1]}= became part of its value; close it after ${JSON.stringify(before.slice(-20))}`, attrStart);
            }
            value = decodeEntities(raw, probe + 1, issues);
            cursor = close + 1;
          }
        } else {
          valueOffset = probe;
          let valueEnd = probe;
          while (valueEnd < length) {
            const v = source.charCodeAt(valueEnd);
            if (isSpace(v) || v === GT) break;
            valueEnd += 1;
          }
          value = decodeEntities(source.slice(probe, valueEnd), probe, issues);
          cursor = valueEnd;
        }
      }
      if (seen.has(name)) {
        issue(issues, "html_parse_error", `Attribute ${name} appears twice`, attrStart);
      } else {
        seen.add(name);
        attrs.push({ name, value, offset: attrStart, valueOffset });
      }
    }
    if (!closed) {
      issue(issues, "html_parse_error", `Start tag <${tag}> is not closed with >`, index);
      index = cursor;
      continue;
    }
    const element = {
      type: "element",
      tag,
      attrs,
      children: [],
      offset: index,
      end: cursor,
      startEnd: cursor,
      closeOffset: undefined,
      ...(brokenQuote ? { brokenQuote: true } : {}),
    };
    // Deeper elements than any design needs are reported once and left out
    // of the tree, so every later walk over it stays within the stack.
    if (stack.length > MAX_DEPTH) {
      if (!tooDeep) issue(issues, "html_too_deep", `Elements nest more than ${MAX_DEPTH} levels deep`, index);
      tooDeep = true;
    } else {
      current().children.push(element);
    }
    index = cursor;

    const foreign = svgDepth > 0 || tag === "svg";
    if (VOID_ELEMENTS.has(tag)) {
      continue;
    }
    if (selfClosing) {
      if (!foreign) {
        issue(issues, "html_parse_error", `<${tag}/> does not close <${tag}> in HTML; write <${tag}></${tag}>`, element.offset);
      }
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(tag) || ESCAPABLE_RAW_TEXT_ELEMENTS.has(tag)) {
      const closeTag = `</${tag}`;
      let close = index;
      for (;;) {
        close = source.indexOf("</", close);
        if (close === -1 || source.slice(close, close + closeTag.length).toLowerCase() === closeTag) break;
        close += 2;
      }
      if (close === -1) {
        issue(issues, "html_parse_error", `<${tag}> is not closed`, element.offset);
        pushRaw(element, source, index, length, tag, issues);
        element.end = length;
        index = length;
        continue;
      }
      pushRaw(element, source, index, close, tag, issues);
      const end = source.indexOf(">", close);
      element.closeOffset = close;
      element.end = end === -1 ? length : end + 1;
      index = element.end;
      continue;
    }
    if (tag === "svg") svgDepth += 1;
    stack.push(element);
  }

  while (stack.length > 1) {
    const open = stack.pop();
    issue(issues, "html_parse_error", `<${open.tag}> is not closed`, open.offset, { tag: open.tag });
    closeElement(open, length);
  }
  return { root, doctype, issues };
}

function pushRaw(element, source, start, end, tag, issues) {
  if (end <= start) return;
  const raw = source.slice(start, end);
  element.children.push({
    type: "text",
    text: ESCAPABLE_RAW_TEXT_ELEMENTS.has(tag) ? decodeEntities(raw, start, issues) : raw,
    offset: start,
    end,
  });
}

function attribute(element, name) {
  for (const attr of element.attrs) if (attr.name === name) return attr;
  return undefined;
}

export function attributeValue(element, name) {
  return attribute(element, name)?.value;
}

export function elementChildren(element) {
  return element.children.filter((child) => child.type === "element");
}

// The first element with this tag, searched depth first.
export function findElement(parent, tag) {
  for (const child of parent.children) {
    if (child.type !== "element") continue;
    if (child.tag === tag) return child;
    const found = findElement(child, tag);
    if (found) return found;
  }
  return undefined;
}
