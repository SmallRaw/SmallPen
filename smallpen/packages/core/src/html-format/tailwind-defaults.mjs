// INPUT:  a class prefix and the part after it (p + 4, rounded + lg)
// OUTPUT: the raw value Tailwind v4's default theme gives that class
// POS:    Tailwind habits read as what they mean there. These are raw values,
//         the same as a bracket literal (p-4 is p-[16px]), never Tokens: a
//         package Token of the same name wins, as a theme value does in
//         Tailwind. Values from tailwindcss@4.1.11 theme.css, 1rem = 16px.

// Spacing and sizes count in steps of --spacing (0.25rem = 4px).
export const SPACING_STEP = 4;

// w-md, max-w-xl: the container scale.
export const CONTAINERS = {
  "3xs": 256, "2xs": 288, xs: 320, sm: 384, md: 448, lg: 512, xl: 576,
  "2xl": 672, "3xl": 768, "4xl": 896, "5xl": 1024, "6xl": 1152, "7xl": 1280,
};

// text-sm: font size and the line height that comes with it, in px (the
// largest sizes set a line height of 1).
export const TEXT_SIZES = {
  xs: [12, 16], sm: [14, 20], base: [16, 24], lg: [18, 28], xl: [20, 28],
  "2xl": [24, 32], "3xl": [30, 36], "4xl": [36, 40],
  "5xl": [48, 48], "6xl": [60, 60], "7xl": [72, 72], "8xl": [96, 96], "9xl": [128, 128],
};

export const FONT_WEIGHTS = {
  thin: 100, extralight: 200, light: 300, normal: 400, medium: 500,
  semibold: 600, bold: 700, extrabold: 800, black: 900,
};

// Letter spacing in em: px follow from the font size.
export const TRACKING = { tighter: -0.05, tight: -0.025, normal: 0, wide: 0.025, wider: 0.05, widest: 0.1 };

// Line height as a multiple of the font size.
export const LEADING = { none: 1, tight: 1.25, snug: 1.375, normal: 1.5, relaxed: 1.625, loose: 2 };

// rounded alone is 0.25rem.
export const RADIUS = { "": 4, xs: 2, sm: 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, "4xl": 32 };

// shadow alone is shadow-sm. rgb(0 0 0 / 0.05) is #0000000d, 0.1 #0000001a,
// 0.25 #00000040.
export const SHADOWS = {
  "": "0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a",
  "2xs": "0 1px 0 0 #0000000d",
  xs: "0 1px 2px 0 #0000000d",
  sm: "0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a",
  md: "0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a",
  lg: "0 10px 15px -3px #0000001a, 0 4px 6px -4px #0000001a",
  xl: "0 20px 25px -5px #0000001a, 0 8px 10px -6px #0000001a",
  "2xl": "0 25px 50px -12px #00000040",
  inner: "inset 0 2px 4px 0 #0000000d",
};

// blur alone is 8px.
export const BLURS = { "": 8, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, "2xl": 40, "3xl": 64 };

// The only named colors: the palette (blue-500…) is not built in, since
// colors are what a design most needs to name.
export const COLORS = { white: "#ffffff", black: "#000000", transparent: "#00000000" };

const PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|[1-9]00|950)$/;

export function isPaletteColor(rest) {
  return PALETTE.test(rest);
}

// p-4, gap-0.5, w-px: a step count (whole, or in quarters) or px.
export function spacingSteps(rest) {
  if (rest === "px") return 1;
  if (!/^\d+(?:\.(?:25|5|75))?$/.test(rest)) return undefined;
  return Number(rest) * SPACING_STEP;
}
