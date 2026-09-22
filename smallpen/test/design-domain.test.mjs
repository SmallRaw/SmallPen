import assert from "node:assert/strict";
import test from "node:test";

import {
  asciiWireframe,
  createCatalog,
  createCompareView,
  createDiscoveryGuide,
  createSemanticTree,
  diffSemanticTrees,
  findComponentVariant,
  loadPackageFromValues,
  projectDesignView,
  projectScenario,
  projectScreen,
  readDesignView,
  resolveDesignView,
} from "@smallpen/core";

function entries(overrides = {}) {
  return {
    assets: [],
    components: [],
    contexts: [],
    requirements: [],
    scenarios: [],
    screens: [],
    tokens: [],
    ...overrides,
  };
}

function componentNode(id, name, type = "COMPONENT") {
  return {
    children: [],
    height: 40,
    id,
    name,
    type,
    width: 120,
    x: 0,
    y: 0,
  };
}

function foundationValues() {
  return new Map([
    [
      "manifest.json",
      {
        entries: entries({
          components: ["components/button.json"],
          scenarios: ["scenarios/button.json"],
        }),
        formatVersion: 1,
        name: "Foundation",
        packageId: "pkg_foundation",
        role: "foundation",
      },
    ],
    [
      "components/button.json",
      {
        componentSets: [
          {
            axes: [
              {
                domain: ["sm", "lg"],
                id: "axis_size",
                name: "Size",
                role: "configuration",
              },
              {
                domain: ["idle", "pressed"],
                id: "axis_state",
                name: "State",
                role: "state",
              },
            ],
            id: "cmp_button",
            name: "Button",
            variants: [
              {
                id: "var_button_sm_idle",
                nodes: {
                  node_button_sm_idle: componentNode(
                    "node_button_sm_idle",
                    "Button / Small / Idle",
                  ),
                },
                rootId: "node_button_sm_idle",
                selection: { axis_size: "sm", axis_state: "idle" },
              },
              {
                id: "var_button_sm_pressed",
                nodes: {
                  node_button_sm_pressed: componentNode(
                    "node_button_sm_pressed",
                    "Button / Small / Pressed",
                  ),
                },
                rootId: "node_button_sm_pressed",
                selection: { axis_size: "sm", axis_state: "pressed" },
              },
              {
                id: "var_button_lg_idle",
                nodes: {
                  node_button_lg_idle: componentNode(
                    "node_button_lg_idle",
                    "Button / Large / Idle",
                  ),
                },
                rootId: "node_button_lg_idle",
                selection: { axis_size: "lg", axis_state: "idle" },
              },
            ],
            visibility: "public",
          },
        ],
      },
    ],
    [
      "scenarios/button.json",
      {
        scenarios: [
          {
            actions: [],
            context: {},
            expectedVisibleNodeIds: ["node_button_sm_idle"],
            fixture: {},
            id: "scn_button_idle",
            name: "Button / Idle",
            target: {
              component: {
                assetId: "cmp_button",
                packageId: "pkg_foundation",
              },
              kind: "component",
              variant: { axis_size: "sm", axis_state: "idle" },
            },
            viewport: { height: 120, scale: 1, width: 240 },
          },
        ],
      },
    ],
  ]);
}

function productValues() {
  return new Map([
    [
      "manifest.json",
      {
        defaultScreenId: "scr_home",
        dependencies: [
          { packageId: "pkg_foundation", path: "foundation.smallpen" },
        ],
        entries: entries({
          requirements: ["requirements/product.json"],
          scenarios: ["scenarios/product.json"],
          screens: ["screens/home.json"],
        }),
        formatVersion: 1,
        name: "Product",
        packageId: "pkg_product",
        role: "product",
      },
    ],
    [
      "screens/home.json",
      {
        basePresentationId: "pres_home_desktop",
        counterparts: [
          {
            from: {
              nodeId: "node_root",
              presentationId: "pres_home_desktop",
            },
            id: "counterpart_home_root",
            to: {
              nodeId: "node_mobile_root",
              presentationId: "pres_home_mobile",
            },
          },
        ],
        id: "scr_home",
        name: "Home",
        presentations: [
          {
            id: "pres_home_desktop",
            interactions: [
              {
                action: {
                  presentationId: "pres_home_mobile",
                  screen: { assetId: "scr_home", packageId: "pkg_product" },
                  type: "navigate",
                },
                id: "int_continue",
                intentId: "intent_continue",
                name: "Continue",
                sourceNodeId: "node_button",
                trigger: "activate",
              },
            ],
            name: "Desktop",
            nodes: {
              node_button: {
                ...componentNode("node_button", "Continue", "INSTANCE"),
                instance: {
                  component: {
                    assetId: "cmp_button",
                    packageId: "pkg_foundation",
                  },
                  overrides: {},
                  variant: { axis_size: "sm", axis_state: "idle" },
                },
              },
              node_root: {
                ...componentNode("node_root", "Home", "FRAME"),
                children: ["node_button"],
                height: 480,
                width: 320,
              },
            },
            platform: "desktop",
            rootId: "node_root",
            viewport: { height: 480, width: 320 },
          },
          {
            id: "pres_home_mobile",
            interactions: [],
            name: "Mobile",
            nodes: {
              node_mobile_root: {
                ...componentNode("node_mobile_root", "Home Mobile", "FRAME"),
                height: 844,
                width: 390,
              },
            },
            platform: "mobile",
            rootId: "node_mobile_root",
            viewport: { height: 844, width: 390 },
          },
        ],
      },
    ],
    [
      "scenarios/product.json",
      {
        scenarios: [
          {
            actions: [
              {
                nodeId: "node_button",
                type: "set-visibility",
                visible: false,
              },
            ],
            context: {},
            expectedVisibleNodeIds: ["node_root"],
            fixture: { signedIn: true },
            id: "scn_home_signed_in",
            name: "Home / Signed In",
            target: {
              kind: "screen",
              presentationId: "pres_home_desktop",
              screen: { assetId: "scr_home", packageId: "pkg_product" },
            },
            viewport: { height: 480, scale: 1, width: 320 },
          },
        ],
      },
    ],
    [
      "requirements/product.json",
      {
        annotations: [
          {
            description: "Primary action",
            id: "ann_continue",
            role: "button",
            tags: ["primary"],
            target: {
              kind: "node",
              nodeId: "node_button",
              presentationId: "pres_home_desktop",
              screen: { assetId: "scr_home", packageId: "pkg_product" },
            },
          },
        ],
        flows: [
          {
            id: "flow_continue",
            interactionIds: ["int_continue"],
            name: "Continue",
          },
        ],
        requirements: [
          {
            id: "req_continue",
            links: [
              { interactionId: "int_continue", kind: "interaction" },
              { flowId: "flow_continue", kind: "flow" },
            ],
            markdown: "The user must be able to continue.",
            title: "Continue from Home",
          },
        ],
      },
    ],
  ]);
}

test("Component Sets keep sparse variants and Component Scenarios", async () => {
  const foundation = await loadPackageFromValues(
    "memory://foundation.smallpen",
    foundationValues(),
  );
  const button = foundation.domain.componentSets.get("cmp_button");
  assert.equal(button.variants.length, 3);
  assert.equal(
    findComponentVariant(button, {
      axis_size: "sm",
      axis_state: "pressed",
    }).variant.id,
    "var_button_sm_pressed",
  );
  assert.deepEqual(
    findComponentVariant(button, {
      axis_size: "lg",
      axis_state: "pressed",
    }),
    { fallbackUsed: false, variant: null },
  );
  assert.equal(
    foundation.domain.scenarios.get("scn_button_idle").target.kind,
    "component",
  );
});

test("Screens validate multiple independent Presentations and declarative product logic", async () => {
  const product = await loadPackageFromValues(
    "memory://product.smallpen",
    productValues(),
  );
  const screen = product.entries["screens/home.json"];
  assert.equal(screen.basePresentationId, "pres_home_desktop");
  assert.equal(screen.presentations.length, 2);
  assert.equal(screen.counterparts.length, 1);
  assert.equal(product.domain.scenarios.size, 1);
  assert.equal(product.domain.flows.get("flow_continue").interactionIds[0], "int_continue");
  assert.equal(product.domain.requirements.get("req_continue").links.length, 2);
  assert.equal(product.domain.annotations.get("ann_continue").role, "button");
});

test("Screen and Scenario projections expand exact variants and execute finite actions", async () => {
  const foundation = await loadPackageFromValues(
    "memory://foundation.smallpen",
    foundationValues(),
  );
  const product = await loadPackageFromValues(
    "memory://product.smallpen",
    productValues(),
  );
  const projected = projectScreen(product, "scr_home", { foundation });
  assert.equal(projected.presentationId, "pres_home_desktop");
  assert.equal(projected.nodes.node_button.componentId, "cmp_button");
  assert.equal(projected.nodes.node_button.variantId, "var_button_sm_idle");
  assert.equal(projected.fallbackUsed, false);

  const scenario = projectScenario(product, "scn_home_signed_in", {
    foundation,
  });
  assert.equal(scenario.nodes.node_button.visible, false);
  assert.deepEqual(scenario.diagnostics, []);

  const componentScenario = projectScenario(foundation, "scn_button_idle");
  assert.equal(componentScenario.rootId, "node_button_sm_idle");
  assert.equal(componentScenario.nodes.node_button_sm_idle.type, "COMPONENT");
  assert.deepEqual(componentScenario.diagnostics, []);
});

test("nested Component instances expand recursively and reject cycles", async () => {
  const values = foundationValues();
  const componentFile = values.get("components/button.json");
  componentFile.componentSets.push({
    axes: [],
    id: "cmp_icon",
    name: "Icon",
    variants: [
      {
        id: "var_icon_default",
        nodes: {
          node_icon_glyph: {
            ...componentNode("node_icon_glyph", "Glyph", "RECTANGLE"),
            height: 16,
            width: 16,
          },
          node_icon_root: {
            ...componentNode("node_icon_root", "Icon"),
            children: ["node_icon_glyph"],
            height: 16,
            width: 16,
          },
        },
        rootId: "node_icon_root",
        selection: {},
      },
    ],
    visibility: "public",
  });
  const buttonVariant = componentFile.componentSets[0].variants[0];
  buttonVariant.nodes.node_button_sm_idle.children = ["node_button_icon"];
  buttonVariant.nodes.node_button_icon = {
    ...componentNode("node_button_icon", "Button Icon", "INSTANCE"),
    height: 16,
    instance: {
      component: { assetId: "cmp_icon", packageId: "pkg_foundation" },
      variant: {},
    },
    width: 16,
    x: 8,
    y: 12,
  };
  const foundation = await loadPackageFromValues(
    "memory://nested-foundation.smallpen",
    values,
  );
  const product = await loadPackageFromValues(
    "memory://nested-product.smallpen",
    productValues(),
  );
  const projected = projectScreen(product, "scr_home", { foundation });
  assert.equal(
    projected.nodes.node_button__node_button_icon.componentId,
    "cmp_icon",
  );
  assert.equal(
    projected.nodes.node_button__node_button_icon__node_icon_glyph.type,
    "RECTANGLE",
  );
  assert.deepEqual(projected.nodes.node_button.children, [
    "node_button__node_button_icon",
  ]);

  const cyclicValues = foundationValues();
  const cyclicVariant = cyclicValues.get("components/button.json").componentSets[0]
    .variants[0];
  cyclicVariant.nodes.node_button_sm_idle.children = ["node_button_cycle"];
  cyclicVariant.nodes.node_button_cycle = {
    ...componentNode("node_button_cycle", "Cycle", "INSTANCE"),
    instance: {
      component: { assetId: "cmp_button", packageId: "pkg_foundation" },
      variant: { axis_size: "sm", axis_state: "idle" },
    },
  };
  const cyclicFoundation = await loadPackageFromValues(
    "memory://cyclic-foundation.smallpen",
    cyclicValues,
  );
  assert.throws(
    () => projectScreen(product, "scr_home", { foundation: cyclicFoundation }),
    (error) => error?.code === "component_instance_cycle",
  );
});

test("Default Design View, Discovery, semantic, wireframe, and Compare share one projection", async () => {
  const foundation = await loadPackageFromValues(
    "memory://foundation.smallpen",
    foundationValues(),
  );
  const product = await loadPackageFromValues(
    "memory://product.smallpen",
    productValues(),
  );
  const resolved = resolveDesignView(product, { foundation });
  assert.deepEqual(resolved.selection, {
    context: {},
    presentationId: "pres_home_desktop",
    screenId: "scr_home",
    viewFormat: "structure",
  });
  const projection = projectDesignView(product, resolved, { foundation });
  const semantic = createSemanticTree(product, projection, {
    selection: resolved.selection,
  });
  assert.equal(semantic.root.name, "Home");
  assert.equal(semantic.root.children[0].component.assetId, "cmp_button");
  assert.match(
    asciiWireframe(semantic),
    /\[02\] INSTANCE "Continue" #node_button/,
  );
  assert.deepEqual(diffSemanticTrees(semantic, structuredClone(semantic)), []);

  const discovery = createDiscoveryGuide(product, resolved, {
    foundation,
    locale: "zh-TW",
  });
  assert.ok(
    discovery.entries.some(
      ({ id, kind }) => id === "pres_home_mobile" && kind === "presentation",
    ),
  );
  assert.ok(
    discovery.entries.some(
      ({ id, kind }) => id === "scn_home_signed_in" && kind === "scenario",
    ),
  );
  assert.ok(
    discovery.entries.every(
      ({ command, copyableCommand, nextOperation, selectorParameters }) =>
        command.operation === "smallpen.read" &&
        copyableCommand.startsWith("smallpen read-view") &&
        nextOperation === "smallpen.read" &&
        Array.isArray(selectorParameters),
    ),
  );
  const scenarioResolved = resolveDesignView(product, {
    foundation,
    selector: {
      scenarioId: "scn_home_signed_in",
      viewFormat: "semantic",
    },
  });
  const scenarioDiscovery = createDiscoveryGuide(product, scenarioResolved, {
    foundation,
  });
  const wireframeCommand = scenarioDiscovery.entries.find(
    ({ id, kind }) => id === "wireframe" && kind === "view-format",
  ).copyableCommand;
  assert.match(wireframeCommand, /--scenario scn_home_signed_in/);
  assert.match(wireframeCommand, /--presentation pres_home_desktop/);
  assert.match(wireframeCommand, /--screen scr_home/);
  const mobileCommand = scenarioDiscovery.entries.find(
    ({ id, kind }) => id === "pres_home_mobile" && kind === "presentation",
  ).copyableCommand;
  assert.doesNotMatch(mobileCommand, /--scenario/);
  assert.match(mobileCommand, /--format semantic/);

  const read = readDesignView(product, {
    foundation,
    selector: { scenarioId: "scn_home_signed_in", viewFormat: "semantic" },
  });
  assert.equal(read.selection.scenarioId, "scn_home_signed_in");
  assert.equal(read.result.root.children[0].visible, false);

  const compare = createCompareView(
    product,
    [
      { presentationId: "pres_home_desktop" },
      { presentationId: "pres_home_mobile" },
    ],
    { foundation },
  );
  assert.deepEqual(
    compare.items.map(({ selection }) => selection.presentationId),
    ["pres_home_desktop", "pres_home_mobile"],
  );
  assert.throws(
    () => createCompareView(product, [{ presentationId: "pres_home_desktop" }]),
    (error) => error?.code === "invalid_compare_count",
  );
});

test("ASCII wireframe preserves spatial relationships and labels every layer", () => {
  const textStyle = {
    fontFamily: "Source Sans Pro",
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.2,
    textAlign: "center",
    verticalAlign: "center",
  };
  const tree = {
    root: {
      bounds: { height: 600, width: 1000, x: 0, y: 0 },
      children: [
        {
          bounds: { height: 80, width: 1000, x: 0, y: 0 },
          children: [],
          id: "node_header",
          name: "Header",
          tokenBindings: {},
          type: "FRAME",
          visible: true,
        },
        {
          bounds: { height: 520, width: 240, x: 0, y: 80 },
          children: [],
          id: "node_sidebar",
          name: "Sidebar",
          tokenBindings: {},
          type: "FRAME",
          visible: true,
        },
        {
          bounds: { height: 520, width: 760, x: 240, y: 80 },
          children: [
            {
              bounds: { height: 40, width: 360, x: 320, y: 160 },
              children: [],
              id: "node_title",
              name: "Page title",
              text: "Welcome back",
              textStyle,
              tokenBindings: {
                fill: { assetId: "tok_text", packageId: "pkg_product" },
              },
              type: "TEXT",
              visible: true,
            },
          ],
          id: "node_main",
          name: "Main content",
          tokenBindings: {},
          type: "FRAME",
          visible: true,
        },
        {
          bounds: { height: 30, width: 120, x: 840, y: 540 },
          children: [],
          id: "node_hidden",
          name: "Hidden helper",
          tokenBindings: {},
          type: "TEXT",
          visible: false,
        },
      ],
      id: "node_root",
      name: "Dashboard",
      tokenBindings: {},
      type: "FRAME",
      visible: true,
    },
  };

  const wireframe = asciiWireframe(tree);
  const canvas = wireframe.slice(
    wireframe.indexOf("CANVAS\n"),
    wireframe.indexOf("\nLAYER KEY "),
  );
  const position = (marker) => {
    const rows = canvas.split("\n");
    const row = rows.findIndex((line) => line.includes(marker));
    return { column: rows[row]?.indexOf(marker) ?? -1, row };
  };

  assert.match(wireframe, /^ASCII WIREFRAME\nviewport: 1000x600 @ 0,0/m);
  assert.match(wireframe, /CANVAS\n\+/);
  assert.ok(position("[02]").row < position("[03]").row);
  assert.ok(position("[03]").column < position("[04]").column);
  for (const marker of ["[01]", "[02]", "[03]", "[04]", "[05]", "(06)"]) {
    assert.ok(canvas.includes(marker), `${marker} is missing from the canvas`);
  }
  assert.match(
    wireframe,
    /\[05\] TEXT "Page title" #node_title/,
  );
  assert.match(
    wireframe,
    /\(06\) HIDDEN TEXT "Hidden helper" #node_hidden/,
  );
  assert.doesNotMatch(wireframe, /\bparent=/);
  assert.doesNotMatch(wireframe, /\balign=/);
  assert.doesNotMatch(wireframe, /\btokens=/);

  const semantic = createSemanticTree(
    { manifest: { packageId: "pkg_product" }, revision: 1 },
    {
      nodes: {
        node_title: {
          children: [],
          height: 40,
          id: "node_title",
          name: "Page title",
          text: "Welcome back",
          textStyle,
          type: "TEXT",
          width: 360,
          x: 320,
          y: 160,
        },
      },
      rootId: "node_title",
    },
  );
  assert.deepEqual(semantic.root.textStyle, textStyle);
  assert.deepEqual(semantic.root.bounds, {
    height: 40,
    width: 360,
    x: 320,
    y: 160,
  });
});

test("Catalog derives legal variants, inherited assets, Scenarios, and requirement coverage", async () => {
  const foundation = await loadPackageFromValues(
    "memory://foundation.smallpen",
    foundationValues(),
  );
  const product = await loadPackageFromValues(
    "memory://product.smallpen",
    productValues(),
  );
  const catalog = createCatalog(product, { foundation });
  assert.deepEqual(catalog.inherited.components, ["cmp_button"]);
  assert.deepEqual(
    catalog.components.map(({ id, packageId, source }) => ({
      id,
      packageId,
      source,
    })),
    [
      {
        id: "cmp_button",
        packageId: "pkg_foundation",
        source: "foundation",
      },
    ],
  );
  assert.equal(catalog.requirements[0].coverage, "linked");
  assert.equal(catalog.scenarios[0].id, "scn_home_signed_in");
  assert.equal(catalog.screens[0].presentations.length, 2);
  assert.deepEqual(catalog.warnings, []);
});

test("declarative product logic rejects scripts and dangling stable references", async () => {
  const scripted = productValues();
  scripted.get("scenarios/product.json").scenarios[0].actions = [
    { code: "fetch()", type: "script" },
  ];
  await assert.rejects(
    loadPackageFromValues("memory://scripted.smallpen", scripted),
    (error) => error?.code === "unsupported_scenario_action",
  );

  const dangling = productValues();
  dangling.get("requirements/product.json").requirements[0].links[0] = {
    interactionId: "int_missing",
    kind: "interaction",
  };
  await assert.rejects(
    loadPackageFromValues("memory://dangling.smallpen", dangling),
    (error) => error?.code === "missing_interaction",
  );
});

test("Counterpart Links and Base Presentation references are strict", async () => {
  const invalidCounterpart = productValues();
  invalidCounterpart.get(
    "screens/home.json",
  ).counterparts[0].to.nodeId = "node_missing";
  await assert.rejects(
    loadPackageFromValues(
      "memory://invalid-counterpart.smallpen",
      invalidCounterpart,
    ),
    (error) => error?.code === "missing_counterpart_endpoint",
  );

  const invalidBase = productValues();
  invalidBase.get("screens/home.json").basePresentationId = "pres_missing";
  await assert.rejects(
    loadPackageFromValues("memory://invalid-base.smallpen", invalidBase),
    (error) => error?.code === "invalid_base_presentation",
  );
});
