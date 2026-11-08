// INPUT:  the value of a trigger attribute (data-click, data-hover, ...)
// OUTPUT: a Penpot prototype interaction, and back
// POS:    The one interaction grammar shared by decode and encode.
//
//   data-click="Tasks/Detail"                       go to a page
//   data-click="back"                               previous page
//   data-click="overlay:Dialogs/Confirm; position: center; close-outside; backdrop"
//   data-click="toggle-overlay:Menus/Main"          open or close an overlay
//   data-click="close-overlay" / "close-overlay:Menus/Main"
//   data-click="https://example.com"                open a URL
//   data-after-delay="Onboarding/Step 2; delay: 1500ms"
//   ...; animation: slide in left 300ms ease-out offset
//
// Options follow the action after ";". Overlay positions: center (default),
// top-left, top-center, top-right, bottom-left, bottom-center, bottom-right,
// or manual X Y (px). relative-to: self, page, or the name of an enclosing
// board (pages only).

export const TRIGGERS = Object.freeze({
  click: "data-click",
  "mouse-press": "data-press",
  "mouse-over": "data-hover",
  "mouse-enter": "data-mouse-enter",
  "mouse-leave": "data-mouse-leave",
  "after-delay": "data-after-delay",
});

const OVERLAY_ACTIONS = { overlay: "open-overlay", "toggle-overlay": "toggle-overlay", "close-overlay": "close-overlay" };
const OVERLAY_PREFIX = { "open-overlay": "overlay", "toggle-overlay": "toggle-overlay", "close-overlay": "close-overlay" };
const POSITIONS = ["center", "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];
const EASINGS = ["linear", "ease", "ease-in", "ease-out", "ease-in-out"];
const DIRECTIONS = ["left", "right", "up", "down"];
const ANIMATED = new Set(["navigate", "open-overlay", "toggle-overlay", "close-overlay"]);
const URL_ACTION = /^(?:https?:\/\/|mailto:|tel:)\S+$/i;
export const DEFAULT_DELAY = 600;

function duration(text) {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  return Number.isSafeInteger(Math.round(value)) ? Math.round(value) : undefined;
}

function parseAnimation(text, action) {
  const words = text.trim().split(/\s+/);
  const type = words.shift();
  if (!["dissolve", "slide", "push"].includes(type)) return { error: "animation is dissolve, slide or push" };
  if (type === "push" && action !== "navigate") return { error: "push works only when going to a page; use slide or dissolve for overlays" };
  const animation = { "animation-type": type };
  for (const word of words) {
    if (word === "in" || word === "out") animation.way = word;
    else if (DIRECTIONS.includes(word)) animation.direction = word;
    else if (EASINGS.includes(word)) animation.easing = word;
    else if (word === "offset") animation["offset-effect"] = true;
    else if (duration(word) !== undefined) animation.duration = duration(word);
    else return { error: `animation does not take ${word}` };
  }
  // The App's defaults for a new animation.
  animation.duration ??= 300;
  animation.easing ??= "linear";
  if (type === "slide") {
    if (!animation.way || !animation.direction) return { error: "slide needs in or out and a direction: slide in left 300ms" };
    animation["offset-effect"] ??= false;
  }
  if (type === "push" && !animation.direction) return { error: "push needs a direction: push left 300ms" };
  if (type === "push") {
    delete animation.way;
    delete animation["offset-effect"];
  }
  return { animation };
}

// Returns { interaction, target?, relativeTo?, error? }. target is the page
// key a destination names; relativeTo is self, page or a board name.
export function parseInteraction(value, trigger) {
  const [actionText, ...optionTexts] = value.split(";").map((part) => part.trim());
  const action = actionText ?? "";
  const interaction = { "event-type": trigger };
  let target;
  let relativeTo;
  if (!action) return { error: "names no action; write a page such as Tasks/Detail, back, overlay:PAGE or a URL" };
  if (action === "back") interaction["action-type"] = "prev-screen";
  else if (action === "close-overlay") interaction["action-type"] = "close-overlay";
  else if (URL_ACTION.test(action)) {
    interaction["action-type"] = "open-url";
    interaction.url = action;
  } else {
    const prefixed = /^([a-z-]+):(.*)$/.exec(action);
    if (prefixed && OVERLAY_ACTIONS[prefixed[1]]) {
      interaction["action-type"] = OVERLAY_ACTIONS[prefixed[1]];
      target = prefixed[2].trim();
      if (!target) return { error: `${prefixed[1]}: needs a page, for example ${prefixed[1]}:Dialogs/Confirm` };
    } else if (prefixed && !/^[A-Za-z]$/.test(prefixed[1])) {
      return { error: `${prefixed[1]}: is not an action; use overlay:, toggle-overlay:, close-overlay:, back, a page or a URL` };
    } else {
      interaction["action-type"] = "navigate";
      target = action;
    }
  }
  const kind = interaction["action-type"];
  const overlay = kind === "open-overlay" || kind === "toggle-overlay";
  if (trigger === "after-delay") interaction.delay = DEFAULT_DELAY;
  if (overlay) {
    interaction["overlay-pos-type"] = "center";
    interaction["overlay-position"] = { x: 0, y: 0 };
    interaction["close-click-outside"] = false;
    interaction["background-overlay"] = false;
  }
  for (const optionText of optionTexts) {
    if (!optionText) continue;
    const colon = optionText.indexOf(":");
    const name = (colon === -1 ? optionText : optionText.slice(0, colon)).trim().toLowerCase();
    const optionValue = colon === -1 ? "" : optionText.slice(colon + 1).trim();
    switch (name) {
      case "delay": {
        if (trigger !== "after-delay") return { error: "delay works with data-after-delay only" };
        const ms = duration(optionValue);
        if (ms === undefined || ms < 0) return { error: "delay takes a time such as 1500ms or 2s" };
        interaction.delay = ms;
        break;
      }
      case "animation": {
        if (!ANIMATED.has(kind)) return { error: "animation works when going to a page or opening and closing overlays" };
        const parsed = parseAnimation(optionValue, kind);
        if (parsed.error) return { error: parsed.error };
        interaction.animation = parsed.animation;
        break;
      }
      case "position": {
        if (!overlay) return { error: "position works with overlay: and toggle-overlay: only" };
        const words = optionValue.split(/\s+/);
        if (POSITIONS.includes(optionValue)) interaction["overlay-pos-type"] = optionValue;
        else if (words[0] === "manual" && words.length === 3) {
          const [x, y] = words.slice(1).map((word) => /^-?\d+(?:\.\d+)?px$/.test(word) || word === "0" ? Number.parseFloat(word) : Number.NaN);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: "position: manual takes two lengths, for example manual 20px 40px" };
          interaction["overlay-pos-type"] = "manual";
          interaction["overlay-position"] = { x, y };
        } else return { error: `position is ${POSITIONS.join(", ")} or manual X Y` };
        break;
      }
      case "relative-to":
        if (!overlay) return { error: "relative-to works with overlay: and toggle-overlay: only" };
        if (!optionValue) return { error: "relative-to takes self, page or the name of an enclosing board" };
        relativeTo = optionValue;
        break;
      case "close-outside":
        if (!overlay) return { error: "close-outside works with overlay: and toggle-overlay: only" };
        interaction["close-click-outside"] = true;
        break;
      case "backdrop":
        if (!overlay) return { error: "backdrop works with overlay: and toggle-overlay: only" };
        interaction["background-overlay"] = true;
        break;
      case "preserve-scroll":
        if (kind !== "navigate") return { error: "preserve-scroll works when going to a page only" };
        interaction["preserve-scroll"] = true;
        break;
      default:
        return { error: `does not take ${name}; options are delay, animation, position, relative-to, close-outside, backdrop, preserve-scroll` };
    }
  }
  if (interaction["overlay-pos-type"] === "manual" && relativeTo === undefined) relativeTo = "self";
  return { interaction, target, relativeTo };
}

// Penpot keeps an animation's fields from its earlier type (a push may
// still hold a slide's way); push has no way or offset, so they are not
// written for it.
function formatAnimation(animation) {
  const type = animation["animation-type"];
  const words = [type];
  if (animation.way && type !== "push") words.push(animation.way);
  if (animation.direction) words.push(animation.direction);
  words.push(`${animation.duration ?? 300}ms`, animation.easing ?? "linear");
  if (animation["offset-effect"] === true && type !== "push") words.push("offset");
  return words.join(" ");
}

// interaction -> { attribute, value }. lookups: page(destinationId) -> page
// key, relativeTo(runtimeId) -> "self" | "page" | board name.
export function formatInteraction(interaction, lookups, path) {
  const trigger = interaction["event-type"] ?? "click";
  const attribute = TRIGGERS[trigger];
  if (!attribute) throw lookups.unsupported(`${path}: the ${trigger} trigger has no SmallPen HTML form`);
  const kind = interaction["action-type"] ?? "navigate";
  const parts = [];
  if (kind === "prev-screen") parts.push("back");
  else if (kind === "open-url") {
    const url = String(interaction.url ?? "").trim();
    if (!URL_ACTION.test(url)) throw lookups.unsupported(`${path}: the link opens ${url || "no URL"}; SmallPen writes http, https, mailto and tel links`);
    if (url.includes(";")) throw lookups.unsupported(`${path}: a URL with ; has no SmallPen HTML form`);
    parts.push(url);
  } else if (kind === "navigate") {
    parts.push(lookups.page(interaction.destination, path));
  } else if (OVERLAY_PREFIX[kind]) {
    if (kind === "close-overlay" && !interaction.destination) parts.push("close-overlay");
    else parts.push(`${OVERLAY_PREFIX[kind]}:${lookups.page(interaction.destination, path)}`);
  } else throw lookups.unsupported(`${path}: ${kind} links have no SmallPen HTML form`);
  if (trigger === "after-delay" && (interaction.delay ?? DEFAULT_DELAY) !== DEFAULT_DELAY) parts.push(`delay: ${interaction.delay}ms`);
  if (kind === "open-overlay" || kind === "toggle-overlay") {
    const position = interaction["overlay-pos-type"] ?? "center";
    if (position === "manual") {
      const { x = 0, y = 0 } = interaction["overlay-position"] ?? {};
      parts.push(`position: manual ${Number(x)}px ${Number(y)}px`);
    } else if (position !== "center") parts.push(`position: ${position}`);
    const relative = interaction["position-relative-to"];
    if (relative) {
      const name = lookups.relativeTo(relative, path);
      if (!(position === "manual" && name === "self")) parts.push(`relative-to: ${name}`);
    }
    if (interaction["close-click-outside"] === true) parts.push("close-outside");
    if (interaction["background-overlay"] === true) parts.push("backdrop");
  }
  if (kind === "navigate" && interaction["preserve-scroll"] === true) parts.push("preserve-scroll");
  if (interaction.animation && ANIMATED.has(kind)) parts.push(`animation: ${formatAnimation(interaction.animation)}`);
  return { attribute, value: parts.join("; ") };
}
