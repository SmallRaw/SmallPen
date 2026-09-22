// Extend an existing package with real, editable component sources and a
// composed screen. The generated Design System sheet is never serialized.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listPackageEntries, loadPackageFromValues } from "@smallpen/core";

export function buildCommonComponentsDemo(base) {
  const values = structuredClone(base);
  const manifest = values.get("manifest.json");
  const packageId = manifest.packageId;
  const ref = (assetId) => ({ packageId, assetId });
  const colors = {
    light: {
      ink: "#25232c",
      muted: "#74717d",
      border: "#d7d3df",
      danger: "#b42318",
      success: "#16794b",
      canvas: "#f5f3f8",
    },
    dark: {
      ink: "#f2eef7",
      muted: "#aaa4b3",
      border: "#625b71",
      danger: "#ffb4ab",
      success: "#83d9ae",
      canvas: "#121015",
    },
  };
  const library = values.get(manifest.entries.tokens[0]);
  for (const theme of ["light", "dark"]) {
    const set = library.sets.find((item) => item.id === `tset_color_${theme}`);
    for (const [name, value] of Object.entries(colors[theme])) {
      set.tokens.push({
        id: `tok_demo_${theme}_${name}`,
        name: `demo.${name}`,
        description: "",
        type: "color",
        value,
      });
    }
  }
  const typography = library.sets.find(
    (item) => item.id === "tset_typography_md",
  );
  for (const [name, size, weight] of [
    ["page", 28, 600],
    ["section", 22, 600],
    ["dialog", 20, 600],
    ["label", 14, 500],
  ]) {
    typography.tokens.push({
      id: `tok_demo_type_${name}`,
      name: `demo.${name}`,
      description: "",
      type: "typography",
      value: {
        fontFamily: "Inter",
        fontId: "gfont-inter",
        fontSize: size,
        fontWeight: weight,
        lineHeight: 1.2,
      },
    });
  }
  const colorId = (name) =>
    ["surface", "surface_variant", "primary", "on_primary"].includes(name)
      ? `tok_color_light_${name}`
      : `tok_demo_light_${name}`;
  const fill = (node, name) => ({
    ...node,
    fills: [{ type: "solid", color: colors.light[name] ?? "#ffffff" }],
    tokenBindings: { ...node.tokenBindings, fill: ref(colorId(name)) },
  });
  const box = (id, name, x, y, width, height, color, type = "RECTANGLE") =>
    fill(
      {
        id,
        name,
        type,
        x,
        y,
        width,
        height,
        children: [],
        cornerRadius: 8,
        tokenBindings: { cornerRadius: ref("tok_radius_md_base") },
      },
      color,
    );
  const text = (id, content, x, y, width, style = "label", color = "ink") => {
    const token = typography.tokens.find(
      (item) => item.id === `tok_demo_type_${style}`,
    );
    return fill(
      {
        id,
        name: content,
        type: "TEXT",
        text: content,
        x,
        y,
        width,
        height: Math.ceil(token.value.fontSize * 1.3),
        children: [],
        textStyle: {
          ...token.value,
          fontVariantId: String(token.value.fontWeight),
        },
        tokenBindings: { typography: ref(token.id) },
      },
      color,
    );
  };
  const axis = (id, name, domain, role = "configuration") => ({
    id: `axis_demo_${id}`,
    name,
    domain,
    role,
  });
  const selectionIds = (selection) =>
    Object.fromEntries(
      Object.entries(selection).map(([key, value]) => [
        `axis_demo_${key}`,
        value,
      ]),
    );
  const sets = [];
  const makeSet = (id, name, axes) => {
    const set = { id, name, axes, visibility: "public", variants: [] };
    sets.push(set);
    return set;
  };
  const variant = (set, key, selection, root, children) => {
    root.componentId = set.id;
    root.type = "COMPONENT";
    root.children = children.map((node) => node.id);
    const result = {
      id: `var_demo_${key}`,
      selection: selectionIds(selection),
      rootId: root.id,
      nodes: Object.fromEntries(
        [root, ...children].map((node) => [node.id, node]),
      ),
    };
    set.variants.push(result);
    return result;
  };
  const instance = (id, set, selected, x, y, overrides = {}) => {
    selected = selectionIds(selected);
    const source = set.variants.find((item) =>
      Object.entries(selected).every(([k, v]) => item.selection[k] === v),
    );
    const root = source.nodes[source.rootId];
    return {
      id,
      name: `${set.name} instance`,
      type: "INSTANCE",
      x,
      y,
      width: root.width,
      height: root.height,
      children: [],
      instance: { component: ref(set.id), variant: selected, overrides },
    };
  };

  const button = makeSet("cmp_demo_button", "Button", [
    axis("style", "Style", ["primary", "secondary", "ghost"]),
    axis("content", "Content", ["text", "leading", "trailing", "icon"]),
    axis(
      "state",
      "State",
      ["default", "hover", "pressed", "disabled"],
      "state",
    ),
  ]);
  // Every declared combination is rendered. State variants are kept for all
  // styles/content arrangements, not sampled from the Cartesian product.
  for (const style of ["primary", "secondary", "ghost"]) {
    for (const content of ["text", "leading", "trailing", "icon"]) {
      for (const state of ["default", "hover", "pressed", "disabled"]) {
        const key = `button_${style}_${content}_${state}`;
        const width = content === "icon" ? 44 : 152;
        const background = style === "primary" ? "primary" : "surface_variant";
        const foreground = style === "primary" ? "on_primary" : "primary";
        const root = box(
          `node_${key}`,
          `Button / ${style}`,
          0,
          0,
          width,
          44,
          background,
        );
        if (style === "ghost" && state === "default") {
          // Explicit transparency avoids the native frame's default white fill.
          root.fills = [{ type: "solid", color: "#ffffff", opacity: 0 }];
          delete root.tokenBindings.fill;
        }
        if (state === "hover") root.opacity = 0.82;
        if (state === "pressed") root.opacity = 0.65;
        if (state === "disabled") root.opacity = 0.35;
        const children = [];
        if (content !== "icon")
          children.push(
            text(
              `node_${key}_label`,
              "Continue",
              content === "leading" ? 42 : 20,
              13,
              94,
              "label",
              foreground,
            ),
          );
        if (content !== "text") {
          const x = content === "trailing" ? 120 : 14;
          // Native rectangles form a plus icon; no font-dependent glyph.
          for (const [part, dx, dy, w, h] of [
            ["h", 0, 6, 16, 2],
            ["v", 7, 0, 2, 16],
          ]) {
            const icon = box(
              `node_${key}_${part}`,
              "Add icon",
              x + dx,
              14 + dy,
              w,
              h,
              foreground,
            );
            icon.cornerRadius = 0;
            delete icon.tokenBindings.cornerRadius;
            children.push(icon);
          }
        }
        variant(button, key, { style, content, state }, root, children);
      }
    }
  }
  const title = makeSet("cmp_demo_title", "Title", [
    axis("level", "Level", ["page", "section", "dialog"]),
  ]);
  for (const level of ["page", "section", "dialog"]) {
    const root = box(
      `node_title_${level}`,
      `Title / ${level}`,
      0,
      0,
      320,
      76,
      "surface",
    );
    variant(title, `title_${level}`, { level }, root, [
      text(
        `node_title_${level}_label`,
        {
          page: "Workspace settings",
          section: "Team members",
          dialog: "Invite a teammate",
        }[level],
        16,
        12,
        290,
        level,
      ),
      text(
        `node_title_${level}_caption`,
        "A clear title with supporting context.",
        16,
        50,
        290,
        "label",
        "muted",
      ),
    ]);
  }
  const input = makeSet("cmp_demo_input", "Input", [
    axis("state", "State", ["default", "focus", "error"], "state"),
  ]);
  for (const state of ["default", "focus", "error"]) {
    const root = box(
      `node_input_${state}`,
      `Input / ${state}`,
      0,
      0,
      320,
      104,
      "surface",
    );
    const border = box(
      `node_input_${state}_border`,
      "Field border",
      16,
      32,
      288,
      44,
      state === "error" ? "danger" : state === "focus" ? "primary" : "border",
    );
    const face = box(
      `node_input_${state}_face`,
      "Field surface",
      18,
      34,
      284,
      40,
      "surface",
    );
    variant(input, `input_${state}`, { state }, root, [
      text(`node_input_${state}_label`, "Email address", 16, 8, 288),
      border,
      face,
      text(
        `node_input_${state}_value`,
        state === "error" ? "not-an-email" : "alex@example.com",
        28,
        47,
        260,
        "label",
        state === "default" ? "muted" : "ink",
      ),
      text(
        `node_input_${state}_hint`,
        state === "error"
          ? "Enter a valid email address."
          : "Use your work email address.",
        16,
        82,
        288,
        "label",
        state === "error" ? "danger" : "muted",
      ),
    ]);
  }
  const badge = makeSet("cmp_demo_badge", "Badge", [
    axis("tone", "Tone", ["neutral", "success", "danger"]),
  ]);
  for (const tone of ["neutral", "success", "danger"]) {
    const color = tone === "neutral" ? "muted" : tone;
    const root = box(
      `node_badge_${tone}`,
      `Badge / ${tone}`,
      0,
      0,
      108,
      32,
      "surface_variant",
    );
    variant(badge, `badge_${tone}`, { tone }, root, [
      text(
        `node_badge_${tone}_label`,
        { neutral: "Pending", success: "Active", danger: "Attention" }[tone],
        12,
        7,
        90,
        "label",
        color,
      ),
    ]);
  }
  const dialog = makeSet("cmp_demo_dialog", "Dialog", [
    axis("kind", "Kind", ["confirm", "form"]),
  ]);
  const buttonSelection = (style) => ({
    style,
    content: "text",
    state: "default",
  });
  for (const kind of ["confirm", "form"]) {
    const root = box(
      `node_dialog_${kind}`,
      `Dialog / ${kind}`,
      0,
      0,
      392,
      300,
      "surface",
    );
    const heading = instance(
      `node_dialog_${kind}_title`,
      title,
      { level: "dialog" },
      20,
      16,
      {
        "node_title_dialog_label:text":
          kind === "confirm" ? "Publish changes?" : "Invite a teammate",
      },
    );
    const content =
      kind === "form"
        ? instance(
            "node_dialog_form_input",
            input,
            { state: "default" },
            20,
            100,
          )
        : text(
            "node_dialog_confirm_message",
            "Your team will see the updated workspace.",
            36,
            120,
            320,
          );
    const cancel = instance(
      `node_dialog_${kind}_cancel`,
      button,
      buttonSelection("secondary"),
      28,
      232,
      { "node_button_secondary_text_default_label:text": "Cancel" },
    );
    const confirm = instance(
      `node_dialog_${kind}_confirm`,
      button,
      buttonSelection("primary"),
      208,
      232,
      {
        "node_button_primary_text_default_label:text":
          kind === "form" ? "Send invite" : "Publish",
      },
    );
    variant(dialog, `dialog_${kind}`, { kind }, root, [
      heading,
      content,
      cancel,
      confirm,
    ]);
  }
  const componentPath = "components/common-components.json";
  values.set(componentPath, { componentSets: sets });
  manifest.entries.components.push(componentPath);

  // A real screen uses instances of those exact definitions. Labels below
  // are occurrence overrides, not copies of the component source trees.
  const root = box(
    "node_demo_workspace",
    "Workspace / composed page",
    0,
    0,
    840,
    620,
    "canvas",
    "FRAME",
  );
  const nodes = [
    root,
    instance("node_demo_page_title", title, { level: "page" }, 24, 24),
    instance("node_demo_page_badge", badge, { tone: "success" }, 690, 46),
    instance("node_demo_page_input", input, { state: "focus" }, 24, 132),
    instance(
      "node_demo_page_button",
      button,
      buttonSelection("primary"),
      40,
      256,
      { "node_button_primary_text_default_label:text": "Save changes" },
    ),
    instance("node_demo_page_dialog", dialog, { kind: "form" }, 424, 132),
    text(
      "node_demo_page_note",
      "Components above are reused here as instances.",
      40,
      502,
      740,
    ),
    text(
      "node_demo_page_note2",
      "Save changes is a local label override; the source still says Continue.",
      40,
      536,
      740,
      "label",
      "muted",
    ),
  ];
  root.children = nodes.slice(1).map((node) => node.id);
  const screenPath = "screens/common-components.json";
  manifest.entries.screens.push(screenPath);
  values.set(screenPath, {
    id: "scr_common_components",
    name: "Composition example",
    basePresentationId: "pres_demo_desktop",
    counterparts: [],
    presentations: [
      {
        id: "pres_demo_desktop",
        name: "Desktop",
        platform: "desktop",
        rootId: root.id,
        interactions: [],
        viewport: { width: 840, height: 620 },
        nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
      },
    ],
  });
  return values;
}

async function main() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error(
      "Usage: node scripts/build-common-components-demo.mjs SOURCE NEW_DESTINATION",
    );
  const manifest = JSON.parse(
    await readFile(join(source, "manifest.json"), "utf8"),
  );
  const base = new Map([["manifest.json", manifest]]);
  for (const path of listPackageEntries(manifest).entries)
    base.set(path, JSON.parse(await readFile(join(source, path), "utf8")));
  const values = buildCommonComponentsDemo(base);
  const snapshot = await loadPackageFromValues(
    "memory://common-components.smallpen",
    values,
  );
  const failures = snapshot.runtime.designSystemRefs.componentSamples.filter(
    (sample) => sample.error,
  );
  if (failures.length)
    throw new Error(JSON.stringify(failures.map((sample) => sample.error)));
  // Refuse to overwrite an existing review package.
  await mkdir(destination);
  for (const [path, value] of values) {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(
      join(destination, path),
      JSON.stringify(value, null, 2) + "\n",
      { flag: "wx" },
    );
  }
  console.log(
    JSON.stringify({
      destination,
      componentSamples:
        snapshot.runtime.designSystemRefs.componentSamples.length,
      pages: snapshot.runtime.designSystemRefs.pages.length,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
