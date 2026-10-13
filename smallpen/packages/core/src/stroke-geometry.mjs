// Shared SVG/CLI geometry for rectangular strokes with independent side widths.
export function perSideStrokeWidths(stroke) {
  const width = stroke.width ?? 1;
  const sides = ["widthTop", "widthRight", "widthBottom", "widthLeft"];
  if (!sides.some(field => stroke[field] != null && stroke[field] !== width)) return null;
  return sides.map(field => Math.max(0, stroke[field] ?? width));
}

function fitRadii(radii, width, height) {
  const ratio = (size, sum) => sum > 0 ? size / sum : 1;
  const scale = Math.min(1,
    ratio(width, radii[0][0] + radii[1][0]), ratio(width, radii[3][0] + radii[2][0]),
    ratio(height, radii[0][1] + radii[3][1]), ratio(height, radii[1][1] + radii[2][1]));
  return radii.map(pair => pair.map(radius => radius * scale));
}

function roundedBoxPath(box, radii) {
  const { left, top, right, bottom } = box;
  if (right <= left || bottom <= top) return "";
  if (radii.every(pair => pair.every(radius => radius === 0)))
    return `M${left},${top}H${right}V${bottom}H${left}Z`;
  const [tl, tr, br, bl] = fitRadii(radii, right - left, bottom - top);
  const corner = ([rx, ry], x, y) => rx > 0 && ry > 0 ? `A${rx},${ry} 0 0 1 ${x},${y}` : `L${x},${y}`;
  return `M${left + tl[0]},${top}H${right - tr[0]}${corner(tr, right, top + tr[1])}` +
    `V${bottom - br[1]}${corner(br, right - br[0], bottom)}H${left + bl[0]}${corner(bl, left, bottom - bl[1])}` +
    `V${top + tl[1]}${corner(tl, left + tl[0], top)}Z`;
}

export function rectangularStrokeBand(node, stroke) {
  const widths = perSideStrokeWidths(stroke);
  if (!widths) return null;
  const [top, right, bottom, left] = widths;
  const grow = stroke.alignment === "outer" ? 1 : stroke.alignment === "center" ? 0.5 : 0;
  const shrink = 1 - grow;
  const x = node.x ?? 0, y = node.y ?? 0;
  const outer = { left: x - left * grow, top: y - top * grow,
    right: x + node.width + right * grow, bottom: y + node.height + bottom * grow };
  const inner = { left: x + left * shrink, top: y + top * shrink,
    right: x + node.width - right * shrink, bottom: y + node.height - bottom * shrink };
  const values = Array.isArray(node.cornerRadius) ? node.cornerRadius : Array(4).fill(node.cornerRadius ?? 0);
  const radii = fitRadii(values.map(radius => [Math.max(0, radius), Math.max(0, radius)]), node.width, node.height);
  const deltas = [[left, top], [right, top], [right, bottom], [left, bottom]];
  const outerRadii = radii.map((pair, index) => pair.map((radius, axis) => radius > 0 ? radius + deltas[index][axis] * grow : 0));
  const innerRadii = radii.map((pair, index) => pair.map((radius, axis) => Math.max(0, radius - deltas[index][axis] * shrink)));
  const outerPath = roundedBoxPath(outer, outerRadii);
  const innerPath = roundedBoxPath(inner, innerRadii);
  return { outerPath, innerPath, pathData: outerPath + innerPath };
}
