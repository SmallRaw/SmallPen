#!/usr/bin/env node

// Static i18n gate for the SmallPen fork.
//
// Checks, from `frontend/`:
//   - every literal `(tr "key" ...)` used under src/ exists in en.po;
//   - SmallPen-owned source files never call `tr` with a dynamic key and
//     carry no CJK text in string literals (docstrings excepted);
//   - every SmallPen PO key (the entries the fork appends to the upstream
//     catalogs) is translated in zh_CN and zh_Hant, is not fuzzy, keeps the
//     same placeholders as en and the same plural shape;
//   - SmallPen call sites pass as many arguments as the en text has
//     placeholders.
//
// SmallPen PO keys are the en.po keys absent from the upstream catalog
// (`git show <base>:frontend/translations/en.po`). Without git or the base
// ref, they fall back to the keys used by SmallPen-owned files plus the keys
// named `*smallpen*`.
//
// Usage: node scripts/check-smallpen-i18n.js [--base upstream/develop]
// Exit code 1 on any error.

import getopts from "getopts";
import gt from "gettext-parser";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const opts = getopts(process.argv.slice(2), {
  string: ["base"],
  default: { base: "upstream/develop" },
});

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const locales = ["en", "zh_CN", "zh_Hant"];
const cjk = /[　-〿㐀-䶿一-鿿＀-￯]/;
// `tr` formats with cuerdas `fmt`: positional `%s`, or `%(name)s` / `$name`
// for a single map argument. Braced tokens must survive translation verbatim.
const argRe = /%s/g;
const placeholderRe =
  /%s|%d|%\([\w:-]+\)s|\$[A-Za-z_][\w:-]*|\{\{?[\w.-]+\}?\}/g;

const errors = [];
const warnings = [];

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (_) {
    return null;
  }
}

function readPo(source) {
  const data = gt.po.parse(source, "utf-8");
  const entries = [];
  for (const [msgid, entry] of Object.entries(data.translations[""])) {
    if (msgid !== "") entries.push(entry);
  }
  return {
    entries,
    byId: new Map(entries.map((e) => [e.msgid, e])),
    nplurals: Number(
      /nplurals=(\d+)/.exec(data.headers["Plural-Forms"] || "")?.[1] || 2,
    ),
  };
}

function walk(dir) {
  const out = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) out.push(...walk(full));
    else if (/\.clj[sc]$/.test(dirent.name)) out.push(full);
  }
  return out;
}

// Minimal Clojure reader: the end index of the form starting at `i`.
function skipString(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === '"') return j + 1;
  }
  return src.length;
}

// Top-level forms after `i` up to the closing paren of the enclosing list.
function countArgs(src, i) {
  let depth = 0;
  let count = 0;
  let inToken = false;
  let prefix = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ";") {
      while (i < src.length && src[i] !== "\n") i++;
      inToken = false;
      continue;
    }
    if (ch === "\\" && i + 1 < src.length) {
      if (depth === 0 && !inToken && !prefix) count++;
      prefix = false;
      inToken = true;
      i += 2;
      continue;
    }
    if (ch === '"') {
      if (depth === 0 && !inToken && !prefix) count++;
      prefix = false;
      inToken = false;
      i = skipString(src, i);
      continue;
    }
    if ("([{".includes(ch)) {
      if (depth === 0 && !inToken && !prefix) count++;
      prefix = false;
      inToken = false;
      depth++;
    } else if (")]}".includes(ch)) {
      if (depth === 0) return count;
      depth--;
      inToken = false;
    } else if (/[\s,]/.test(ch)) {
      inToken = false;
    } else if (depth === 0 && !inToken) {
      if (!prefix) count++;
      prefix = "#@'`~^".includes(ch);
      inToken = !prefix;
    }
    i++;
  }
  return count;
}

const docstringContext =
  /\((?:defn-?|def|defonce|defmacro|defmulti|ns|mf\/defc)\s+(?:\^\S+\s+)*[^\s()[\]{}"]+\s*$/;

// String literals outside comments, with their start offsets.
function stringLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ";") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === "\\") {
      i += 2;
    } else if (ch === '"') {
      const end = skipString(src, i);
      out.push({ start: i, text: src.slice(i + 1, end - 1) });
      i = end;
    } else {
      i++;
    }
  }
  return out;
}

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (src[i] === "\n") line++;
  return line;
}

function placeholders(text) {
  return (text.match(placeholderRe) || []).sort().join(" ");
}

// --- Inputs ------------------------------------------------------------------

const po = Object.fromEntries(
  locales.map((l) => [
    l,
    readPo(fs.readFileSync(path.join(root, "translations", `${l}.po`))),
  ]),
);

// Files the fork added (or owns outright) under src/.
const added = new Set(
  (
    git(["diff", "--name-only", "--diff-filter=A", opts.base, "--", "src"]) ||
    ""
  )
    .split("\n")
    .concat(
      (
        git(["ls-files", "--others", "--exclude-standard", "--", "src"]) || ""
      ).split("\n"),
    )
    .filter(Boolean)
    .map((f) => path.resolve(root, f.replace(/^frontend\//, ""))),
);

function owned(file) {
  const rel = path.relative(root, file);
  return (
    rel === "src/app/main/smallpen.cljs" ||
    rel.startsWith("src/app/main/smallpen/") ||
    added.has(file)
  );
}

// --- Source scan -------------------------------------------------------------

const used = new Map();
const trRe = /\((?:[\w.-]+\/)?tr\s+("|[^\s")])/g;

for (const file of walk(path.join(root, "src"))) {
  const src = fs.readFileSync(file, "utf-8");
  const rel = path.relative(root, file);
  const own = owned(file);
  const literals = stringLiterals(src);
  const inString = (offset) =>
    literals.some((s) => offset > s.start && offset <= s.start + s.text.length);
  const lineStart = (offset) => src.lastIndexOf("\n", offset) + 1;
  const commented = (offset) =>
    src.slice(lineStart(offset), offset).includes(";");

  for (const m of src.matchAll(trRe)) {
    if (inString(m.index)) continue;
    const where = `${rel}:${lineOf(src, m.index)}`;
    if (m[1] !== '"') {
      if (own && !commented(m.index))
        errors.push(`${where}: tr with a dynamic key`);
      continue;
    }
    const keyStart = m.index + m[0].length - 1;
    const keyEnd = skipString(src, keyStart);
    const key = src.slice(keyStart + 1, keyEnd - 1);
    const args = commented(m.index) ? null : countArgs(src, keyEnd);
    if (!used.has(key)) used.set(key, []);
    used.get(key).push({ where, own, args });
  }

  if (own) {
    for (const s of literals) {
      if (!cjk.test(s.text)) continue;
      if (docstringContext.test(src.slice(Math.max(0, s.start - 200), s.start)))
        continue;
      errors.push(
        `${rel}:${lineOf(src, s.start)}: CJK text in a string literal: "${s.text.slice(0, 40)}"`,
      );
    }
  }
}

// --- SmallPen PO keys ---------------------------------------------------------

const upstreamEn = git(["show", `${opts.base}:frontend/translations/en.po`]);
let smallpenKeys;
if (upstreamEn) {
  const upstream = readPo(Buffer.from(upstreamEn, "utf-8")).byId;
  smallpenKeys = new Set(
    po.en.entries.map((e) => e.msgid).filter((id) => !upstream.has(id)),
  );
} else {
  smallpenKeys = new Set(
    po.en.entries
      .map((e) => e.msgid)
      .filter(
        (id) =>
          id.includes("smallpen") || used.get(id)?.some((site) => site.own),
      ),
  );
  warnings.push(
    `base ref ${opts.base} unavailable: SmallPen keys limited to keys used by SmallPen files (${smallpenKeys.size})`,
  );
}

// --- Checks ------------------------------------------------------------------

for (const [key, sites] of used) {
  const en = po.en.byId.get(key);
  if (!en) {
    errors.push(`${sites[0].where}: key "${key}" missing in en.po`);
    continue;
  }
  if (!smallpenKeys.has(key)) continue;
  const forms = en.msgstr.filter(Boolean);
  const expected = Math.max(
    0,
    ...forms.map((f) => (f.match(argRe) || []).length),
  );
  for (const site of sites) {
    if (site.args !== null && site.args !== expected)
      errors.push(
        `${site.where}: "${key}" called with ${site.args} argument(s), en text has ${expected} placeholder(s)`,
      );
  }
}

for (const key of smallpenKeys) {
  const en = po.en.byId.get(key);
  const enForms = en.msgstr;
  if (enForms.every((f) => f === ""))
    errors.push(`en.po: "${key}" has an empty msgstr`);
  if (enForms.some((f) => f.includes("%d")))
    errors.push(`en.po: "${key}" uses %d; tr only formats %s`);
  if (en.msgid_plural && enForms.length !== po.en.nplurals)
    errors.push(`en.po: "${key}" needs ${po.en.nplurals} plural forms`);
  if (!used.has(key))
    warnings.push(`en.po: "${key}" is not referenced by any (tr "...") call`);

  for (const locale of locales.slice(1)) {
    const entry = po[locale].byId.get(key);
    const where = `${locale}.po: "${key}"`;
    if (!entry) {
      errors.push(`${where} missing`);
      continue;
    }
    if ((entry.comments?.flag || "").includes("fuzzy"))
      errors.push(`${where} is fuzzy`);
    if (entry.msgstr.some((f) => f === ""))
      errors.push(`${where} is untranslated`);
    if (Boolean(entry.msgid_plural) !== Boolean(en.msgid_plural)) {
      errors.push(`${where} plural shape differs from en`);
      continue;
    }
    if (en.msgid_plural && entry.msgstr.length !== po[locale].nplurals)
      errors.push(`${where} needs ${po[locale].nplurals} plural forms`);
    // Single-form locales (nplurals=1) hold the en plural form.
    entry.msgstr.forEach((form, i) => {
      const reference =
        po[locale].nplurals === 1
          ? enForms[enForms.length - 1]
          : enForms[Math.min(i, enForms.length - 1)];
      if (placeholders(form) !== placeholders(reference))
        errors.push(
          `${where} placeholders [${placeholders(form)}] differ from en [${placeholders(reference)}]`,
        );
    });
  }
}

for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
console.log(
  `check-smallpen-i18n: ${used.size} keys used, ${smallpenKeys.size} SmallPen keys, ${errors.length} error(s), ${warnings.length} warning(s)`,
);
process.exit(errors.length ? 1 : 0);
