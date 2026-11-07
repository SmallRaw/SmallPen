// Regressions from a blind CLI run that built a design system: Token names
// that are both a Token and a group, Instances left on a deleted variant,
// errors without the received value, and gaps in `smallpen schema`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OPERATION_SCHEMAS } from "@smallpen/core";

import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

function runCli(args, cwd) {
  // Schema and full-value checks opt into stdout; fixed-file transport is tested separately.
  if (
    (args[0] === "schema" || args.includes("--full")) &&
    !args.includes("--stdout")
  )
    args = [...args, "--stdout"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "", LC_MESSAGES: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code, json: parse(stdout), stdout }),
    );
  });
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function scratch(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-blind-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

async function initAcme(root, layout) {
  await writeFile(
    join(root, "answers.json"),
    JSON.stringify(INIT_ANSWERS_EXAMPLE),
  );
  const result = await runCli(
    [
      "project",
      "init",
      "acme",
      "--answers",
      "answers.json",
      "--confirm",
      "--json",
      ...(layout ? ["--layout", layout] : []),
    ],
    root,
  );
  assert.equal(result.code, 0, result.stdout);
  return layout
    ? {
        foundation: join(root, "acme", "acme-foundation.smallpen"),
        product: join(root, "acme", "acme.smallpen"),
      }
    : {
        foundation: join(root, "acme", "acme.smallpen"),
        product: join(root, "acme", "acme.smallpen"),
      };
}

let intentCount = 0;
// Token operations go through `advanced apply`, the exact batch route.
function token(root, packagePath, operations) {
  return apply(root, packagePath, operations);
}

// Adds Instance nodes under a Screen's base Presentation root, the batch
// the removed `page --intent` route used to compile.
function addToScreen(root, packagePath, nodes) {
  return apply(
    root,
    packagePath,
    nodes.map((node) => ({
      node,
      parentId: "node_home_root",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "add-presentation-node",
    })),
  );
}

async function apply(root, packagePath, operations) {
  const inspected = await runCli(["project", "show", packagePath, "--json"], root);
  const file = join(root, `batch-${(intentCount += 1)}.json`);
  await writeFile(
    file,
    JSON.stringify({
      baseRevision: inspected.json.revision,
      batchId: `blind-${intentCount}`,
      operations,
    }),
  );
  return runCli(["advanced", "apply", packagePath, "--batch", file, "--json"], root);
}

function setToken(setId, id, name, value = "#ff0000") {
  return {
    setId,
    token: { id, name, type: "color", value },
    type: "put-set-token",
  };
}

test("a Token cannot go inside a Token, nor replace a group of Tokens", async (context) => {
  const root = await scratch(context);
  const { foundation } = await initAcme(root, "foundation-product");

  // The seeded color.brand is a Token; color.brand.base would sit inside it.
  const inside = await token(root, foundation, [
    setToken("tset_base", "tok_color_brand_base", "color.brand.base"),
  ]);
  assert.equal(inside.code, 1, inside.stdout);
  assert.equal(inside.json.error.code, "token_name_collision");
  assert.deepEqual(
    inside.json.error.details.collidesWith.map(({ id }) => id),
    ["tok_color_brand"],
  );
  assert.match(
    inside.json.error.message,
    /inside Token color\.brand \(tok_color_brand, set base\)/,
  );
  assert.match(inside.json.error.message, /color\.brand-base/);

  // Another set collides too: Penpot drops one of them when both are active.
  const dark = await token(root, foundation, [
    setToken("tset_theme_dark", "tok_color_brand_strong", "color.brand.strong"),
  ]);
  assert.equal(dark.json.error.code, "token_name_collision", dark.stdout);

  // The reverse: a Token where a group of Tokens exists.
  assert.equal(
    (
      await token(root, foundation, [
        setToken("tset_base", "tok_color_accent_base", "color.accent.base"),
      ])
    ).code,
    0,
  );
  const group = await token(root, foundation, [
    setToken("tset_base", "tok_color_accent", "color.accent"),
  ]);
  assert.equal(group.json.error.code, "token_name_collision", group.stdout);
  assert.match(
    group.json.error.message,
    /already a group of Tokens: color\.accent\.base/,
  );

  // put-token-set checks its Tokens against each other and the library.
  const set = await token(root, foundation, [
    {
      set: {
        id: "tset_extra",
        name: "extra",
        tokens: [
          {
            id: "tok_extra_a",
            name: "extra.a",
            type: "color",
            value: "#000000",
          },
          {
            id: "tok_extra_a_b",
            name: "extra.a.b",
            type: "color",
            value: "#000000",
          },
        ],
      },
      type: "put-token-set",
    },
  ]);
  assert.equal(set.json.error.code, "token_name_collision", set.stdout);

  // Renaming the seeded Token by its id frees the group.
  const renamed = await token(root, foundation, [
    setToken("tset_base", "tok_color_brand", "color.brand.default", "#6750a4"),
    setToken("tset_base", "tok_color_brand_base", "color.brand.base"),
  ]);
  assert.equal(renamed.code, 0, renamed.stdout);
});

test("put-token rejects a DTCG Token nested in a Token and validate warns about old collisions", async (context) => {
  const root = await scratch(context);
  const { foundation } = await initAcme(root);
  const definition = (id) => ({
    $extensions: { smallpen: { id } },
    $type: "color",
    $value: "#ff0000",
  });
  const putToken = (id, path) => ({
    definition: definition(id),
    filePath: "tokens/dtcg.json",
    path,
    tokenId: id,
    type: "put-token",
  });
  assert.equal(
    (await token(root, foundation, [putToken("tok_ink", "ink")])).code,
    0,
  );
  const nested = await token(root, foundation, [
    putToken("tok_ink_soft", "ink.soft"),
  ]);
  assert.equal(nested.json.error.code, "token_name_collision", nested.stdout);
  assert.match(
    nested.json.error.message,
    /inside Token ink \(tok_ink, tokens\/dtcg\.json\)/,
  );

  // A collision written before the check loads, and validate names it.
  const file = join(foundation, "tokens", "tokens.json");
  const library = JSON.parse(await readFile(file, "utf8"));
  library.sets[0].tokens.push({
    description: "",
    id: "tok_color_brand_base",
    name: "color.brand.base",
    type: "color",
    value: "#ff0000",
  });
  await writeFile(file, JSON.stringify(library));
  const validated = await runCli(["validate", foundation, "--json"], root);
  assert.equal(validated.code, 0, validated.stdout);
  const warning = validated.json.warnings.find(
    ({ code }) => code === "token_name_collision",
  );
  assert.ok(warning, validated.stdout);
  assert.deepEqual(warning.tokens, ["color.brand", "color.brand.base"]);
});

const CARD_SET = {
  componentSet: {
    axes: [],
    id: "cmp_card",
    name: "Card",
    variants: [
      {
        id: "var_card_default",
        nodes: {
          node_card_action: {
            children: [],
            height: 40,
            id: "node_card_action",
            instance: {
              component: { assetId: "cmp_button", packageId: "pkg_acme" },
              variant: { axis_style: "primary" },
            },
            name: "Action",
            type: "INSTANCE",
            width: 120,
            x: 16,
            y: 16,
          },
          node_card_root: {
            children: ["node_card_action"],
            height: 72,
            id: "node_card_root",
            name: "Card",
            type: "COMPONENT",
            width: 200,
            x: 0,
            y: 0,
          },
        },
        rootId: "node_card_root",
        selection: {},
      },
    ],
    visibility: "public",
  },
  type: "put-component-set",
};

function buttonWithSecondary() {
  const example = structuredClone(
    OPERATION_SCHEMAS["put-component-set"].example,
  );
  const primary = example.componentSet.variants[0];
  example.componentSet.variants.push({
    ...structuredClone(primary),
    id: "var_button_secondary",
    selection: { axis_style: "secondary" },
  });
  return example;
}

test("a write that leaves a nested Instance on a deleted variant is rejected", async (context) => {
  const root = await scratch(context);
  const { foundation } = await initAcme(root);
  assert.equal(
    (await apply(root, foundation, [buttonWithSecondary(), CARD_SET])).code,
    0,
  );

  const deleted = await apply(root, foundation, [
    {
      componentId: "cmp_button",
      type: "delete-variant",
      variantId: "var_button_primary",
    },
  ]);
  assert.equal(deleted.code, 1, deleted.stdout);
  assert.equal(deleted.json.error.code, "stale_instance_variant");
  const [instance] = deleted.json.error.details.instances;
  assert.equal(instance.nodeId, "node_card_action");
  assert.deepEqual(instance.selection, { axis_style: "primary" });
  assert.deepEqual(instance.validSelections, [{ axis_style: "secondary" }]);
  assert.match(
    deleted.json.error.message,
    /Action uses Button with Style=primary, which it no longer has/,
  );
  // The message fixes by name; an apply batch also gets the exact operation.
  assert.match(deleted.json.error.message, /component define/);
  assert.match(instance.operationFix, /update-component-node/);

  // A Package that is already stale still takes unrelated writes, and
  // validate lists the stale Instance.
  const file = join(foundation, "components", "components.json");
  const components = JSON.parse(await readFile(file, "utf8"));
  const button = components.componentSets.find(({ id }) => id === "cmp_button");
  button.variants = button.variants.filter(
    ({ id }) => id !== "var_button_primary",
  );
  await writeFile(file, JSON.stringify(components));
  const unrelated = await token(root, foundation, [
    setToken("tset_base", "tok_color_extra", "color.extra"),
  ]);
  assert.equal(unrelated.code, 0, unrelated.stdout);
  const validated = await runCli(["validate", foundation, "--json"], root);
  assert.equal(validated.code, 1, validated.stdout);
  assert.equal(validated.json.error.code, "stale_instance_variant");
  // validate replies leave out nodeId; the stored path names the Instance.
  assert.equal(validated.json.error.details.instances[0].nodeId, undefined);
  const [orphan] = validated.json.error.details.instances;
  assert.match(orphan.where, /^Card \(.*\) \/ /, orphan.where);
  assert.match(orphan.fix, /component define/);
  assert.equal(orphan.path, undefined, "the stored path spells ids");
});

test("validate and repair list every Product Instance a Foundation change orphaned", async (context) => {
  const root = await scratch(context);
  const { foundation, product } = await initAcme(root, "foundation-product");
  // Replies leave out ids; the batch below needs the stored Package id.
  const foundationId = JSON.parse(
    await readFile(join(foundation, "manifest.json"), "utf8"),
  ).packageId;
  const button = buttonWithSecondary();
  const retarget = (value) =>
    JSON.parse(
      JSON.stringify(value).replaceAll('"pkg_acme"', `"${foundationId}"`),
    );
  assert.equal((await apply(root, foundation, [retarget(button)])).code, 0);
  const nodes = ["node_a", "node_b"].map((id, index) => ({
    children: [],
    height: 40,
    id,
    instance: {
      component: { assetId: "cmp_button", packageId: foundationId },
      variant: { axis_style: "secondary" },
    },
    name: id,
    type: "INSTANCE",
    width: 120,
    x: 16,
    y: 16 + index * 48,
  }));
  const added = await addToScreen(root, product, nodes);
  assert.equal(added.code, 0, added.stdout);
  assert.equal((await runCli(["validate", product, "--json"], root)).code, 0);

  // The Foundation cannot see its Products, so this write succeeds.
  const deleted = await apply(root, foundation, [
    {
      componentId: "cmp_button",
      type: "delete-variant",
      variantId: "var_button_secondary",
    },
  ]);
  assert.equal(deleted.code, 0, deleted.stdout);

  const validated = await runCli(["validate", product, "--json"], root);
  assert.equal(validated.json.error.code, "repair_required", validated.stdout);
  const stale = validated.json.error.details.staleInstances;
  // validate replies leave out nodeId; each stored path names its Instance.
  assert.ok(stale.every(({ nodeId }) => nodeId === undefined));
  // Each copy is named by page, version and element, with a name-based fix.
  assert.deepEqual(stale.map(({ where }) => where).sort(), ["Home (mobile) / node_a", "Home (mobile) / node_b"]);
  assert.ok(stale.every(({ fix, path }) => /page draw/.test(fix) && path === undefined));
  for (const entry of stale) {
    assert.equal(entry.code, "stale_instance_variant");
    assert.deepEqual(entry.variants, ["Style=primary"]);
    assert.equal(entry.validSelections, undefined, "selections keyed by axis ids stay out");
  }
  const repair = await runCli(["project", "repair", product, "--json"], root);
  assert.equal(repair.json.status, "repair", repair.stdout);
  assert.equal(repair.json.staleInstances.length, 2);
});

test("value errors show what was received and the allowed values", async (context) => {
  const root = await scratch(context);
  const { product } = await initAcme(root);
  const update = (changes) => ({
    changes,
    nodeId: "node_home_root",
    presentationId: "pres_home_mobile",
    screenId: "scr_home",
    type: "update-presentation-node",
  });
  const cases = [
    [{ fills: [{ type: "solid" }] }, "invalid_fill_color", /received nothing/],
    [
      { fills: [{ color: 255, type: "solid" }] },
      "invalid_fill_color",
      /received 255 \(number\)/,
    ],
    [
      {
        strokes: [
          { capEnd: "arrow", color: "#000000", type: "solid", width: 1 },
        ],
      },
      "invalid_stroke_cap",
      /must be one of circle-marker, diamond-marker, line-arrow, round, square, square-marker, triangle-arrow; received "arrow"/,
    ],
    [
      {
        strokes: [
          { alignment: "inside", color: "#000000", type: "solid", width: 1 },
        ],
      },
      "invalid_stroke_alignment",
      /center, inner, outer; received "inside"/,
    ],
    [
      { "constraints-h": "middle" },
      "invalid_node_constraints",
      /left, right, leftright, center, scale; received "middle"/,
    ],
    [
      { "constraints-v": "left" },
      "invalid_node_constraints",
      /top, bottom, topbottom, center, scale/,
    ],
    [{ opacity: 2 }, "invalid_opacity", /received 2 \(number\)/],
    [{ width: "wide" }, "invalid_node_number", /received "wide" \(string\)/],
    [
      { shadow: 4 },
      "invalid_shadow_shape",
      /offsetX, offsetY, blur, spread, color.*received 4/,
    ],
    [
      { shadow: { blur: "big" } },
      "invalid_shadow_shape",
      /blur must be a number \(px\); received "big"/,
    ],
  ];
  for (const [changes, code, message] of cases) {
    const result = await apply(root, product, [update(changes)]);
    assert.equal(
      result.json?.error?.code,
      code,
      `${JSON.stringify(changes)}: ${result.stdout}`,
    );
    assert.match(result.json.error.message, message);
  }
  const cap = await apply(root, product, [
    update({
      strokes: [{ capEnd: "arrow", color: "#000000", type: "solid", width: 1 }],
    }),
  ]);
  assert.ok(cap.json.error.details.allowedValues.includes("triangle-arrow"));
  // Constraints Penpot accepts still pass.
  assert.equal(
    (
      await apply(root, product, [
        update({ "constraints-h": "leftright", "constraints-v": "scale" }),
      ])
    ).code,
    0,
  );

  const ellipse = structuredClone(
    OPERATION_SCHEMAS["put-component-set"].example,
  );
  ellipse.componentSet.variants[0].nodes.node_button_label.type = "ELLIPSE";
  delete ellipse.componentSet.variants[0].nodes.node_button_label.text;
  delete ellipse.componentSet.variants[0].nodes.node_button_label.textStyle;
  const rejected = await apply(root, product, [ellipse]);
  assert.equal(
    rejected.json.error.code,
    "unsupported_node_type",
    rejected.stdout,
  );
  assert.match(
    rejected.json.error.message,
    /allowed only in Screen Presentations/,
  );
});

test("schema states variant node types, node ids, shadow shape, caps, constraints and lineHeight", async (context) => {
  const root = await scratch(context);
  const schema = async (...args) =>
    (await runCli(["schema", ...args, "--json"], root)).json;
  const componentSet = await schema("component-set");
  assert.match(
    componentSet.variantNodeTypes,
    /^COMPONENT, COMPONENT_SET, FRAME, IMAGE, INSTANCE, RECTANGLE, TEXT only/,
  );
  assert.match(componentSet.instancesAfterChanges, /stale_instance_variant/);
  const node = await schema("node");
  assert.match(node.required.id, /must start with node_/);
  assert.match(node.required.type, /Inside a Component variant only/);
  assert.match(node.fields.shadow, /offsetX, offsetY, blur, spread, color/);
  assert.match(node.fields.strokes, /triangle-arrow/);
  assert.match(node.fields["constraints-h"], /leftright/);
  assert.match(node.fields["constraints-v"], /topbottom/);
  assert.match(node.textStyle.lineHeight, /multiplier of fontSize/);
  assert.match(node.textStyle.fonts, /Source Sans Pro.*asset font import/);
  const tokenTopic = await schema("token");
  assert.match(tokenTopic.setToken.name, /token_name_collision/);
  assert.match(tokenTopic.dtcgFiles, /must not be the token library entry/);
  const tokenTypes = await schema("token-types");
  assert.equal(tokenTypes.types["font-family"].example, "Source Sans Pro");
  assert.equal(
    tokenTypes.types.typography.example.fontFamily,
    "Source Sans Pro",
  );
  assert.match(tokenTypes.types.typography.shape, /lineHeight\?: multiplier/);
  const putToken = await schema("operation", "put-token");
  assert.notEqual(
    putToken.example.operations[0].filePath,
    "tokens/foundation.json",
  );
  assert.match(putToken.fields.filePath.description, /put-set-token/);
});

test("a Repair conflict points at the Screen whose Instance failed when node ids repeat", async (context) => {
  const root = await scratch(context);
  const { foundation, product } = await initAcme(root, "foundation-product");
  // Replies leave out ids; the batch below needs the stored Package id.
  const foundationId = JSON.parse(
    await readFile(join(foundation, "manifest.json"), "utf8"),
  ).packageId;
  const button = JSON.parse(
    JSON.stringify(buttonWithSecondary()).replaceAll(
      '"pkg_acme"',
      `"${foundationId}"`,
    ),
  );
  assert.equal((await apply(root, foundation, [button])).code, 0);
  const instanceNode = (style) => ({
    children: [],
    height: 40,
    id: "node_btn",
    instance: {
      component: { assetId: "cmp_button", packageId: foundationId },
      variant: { axis_style: style },
    },
    name: "Button",
    type: "INSTANCE",
    width: 120,
    x: 16,
    y: 16,
  });
  // node_btn on the first Screen stays valid; the second Screen's node_btn
  // loses its variant. The first Screen's entry sorts first.
  assert.equal(
    (await addToScreen(root, product, [instanceNode("primary")])).code,
    0,
  );
  const settings = structuredClone(OPERATION_SCHEMAS["put-screen"].example);
  const presentation = settings.screen.presentations[0];
  presentation.nodes.node_settings_root.children = ["node_btn"];
  presentation.nodes.node_btn = instanceNode("secondary");
  const added = await apply(root, product, [settings]);
  assert.equal(added.code, 0, added.stdout);
  const manifest = JSON.parse(
    await readFile(join(product, "manifest.json"), "utf8"),
  );
  const settingsEntry = manifest.entries.screens.find(
    (entry) => entry !== "screens/first-design.json",
  );
  assert.ok(settingsEntry > "screens/first-design.json", settingsEntry);

  assert.equal(
    (
      await apply(root, foundation, [
        {
          componentId: "cmp_button",
          type: "delete-variant",
          variantId: "var_button_secondary",
        },
      ])
    ).code,
    0,
  );
  const validated = await runCli(["validate", product, "--json"], root);
  assert.equal(validated.json.error.code, "repair_required", validated.stdout);
  const [conflict] = validated.json.error.details.conflicts;
  assert.equal(conflict.code, "missing_variant");
  assert.equal(
    conflict.path,
    `${settingsEntry}.presentations[0].nodes.node_btn.instance.component`,
  );
  assert.ok(
    conflict.choices.some(
      ({ referencePath }) =>
        referencePath === `${settingsEntry}.presentations[0].nodes.node_btn`,
    ),
    JSON.stringify(conflict.choices),
  );
});
