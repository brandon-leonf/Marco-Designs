/**
 * Where things sit on the lot, in lot feet.
 *
 * Axes match BuildingPreview3D: x runs across the lot, y runs from the street
 * (y = 0) toward the rear. Every rectangle is `{ x0, y0, x1, y1 }`.
 *
 * These were three copies of the same arithmetic — the massing, the site plan,
 * and the envelope check in App. Now that the client can drag the building
 * anywhere on the lot, the three have to agree exactly or the plan will show a
 * placement the calculation does not score, so they share one implementation.
 */

import { booleanWithin, feature, polygon } from "@turf/turf";

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** The buildable envelope: the lot inset by its setbacks. */
export function envelopeRect(lotWidthFt, lotDepthFt, setbacks) {
  const lotWidth = Math.max(1, num(lotWidthFt, 25));
  const lotDepth = Math.max(1, num(lotDepthFt, 100));
  const side = Math.max(0, num(setbacks?.side));
  const front = Math.max(0, num(setbacks?.front));
  const rear = Math.max(0, num(setbacks?.rear));
  return {
    x0: side,
    y0: front,
    x1: Math.max(side, lotWidth - side),
    y1: Math.max(front, lotDepth - rear),
  };
}

/** A proposed rectangular floor must be fully inside the actual parcel/envelope polygon. */
export function rectFitsGeometry(rect, geometry) {
  if (!rect || !geometry) return null;
  try {
    const shape = polygon([[
      [rect.x0, rect.y0],
      [rect.x1, rect.y0],
      [rect.x1, rect.y1],
      [rect.x0, rect.y1],
      [rect.x0, rect.y0],
    ]]);
    return booleanWithin(shape, feature(geometry));
  } catch {
    return false;
  }
}

/**
 * The existing house, approximated. MOD-IV records a footprint area but not an
 * outline, so the area is laid out with the lot's proportions and placed from
 * the answer the client gave for "where is the current structure".
 */
export function existingRect(lotWidthFt, lotDepthFt, footprintSqft, location, position = null) {
  const lotWidth = Math.max(1, num(lotWidthFt, 25));
  const lotDepth = Math.max(1, num(lotDepthFt, 100));
  const footprint = Math.max(0, num(footprintSqft));
  if (footprint <= 0) return null;
  const scale = Math.min(1, Math.sqrt(footprint / (lotWidth * lotDepth)));
  const width = lotWidth * scale;
  const depth = lotDepth * scale;
  const defaultX0 = (lotWidth - width) / 2;
  const defaultY0 =
    location === "front" ? 0 : location === "rear" ? lotDepth - depth : (lotDepth - depth) / 2;
  const origin = clampOriginToLot(
    position ?? { x0: defaultX0, y0: defaultY0 },
    width,
    depth,
    lotWidth,
    lotDepth
  );
  return { x0: origin.x0, y0: origin.y0, x1: origin.x0 + width, y1: origin.y0 + depth };
}

/**
 * Keep a ground-level addition joined to one full edge of the existing house.
 * The desired origin can move freely; this function projects it to the nearest
 * feasible left, right, front, or back wall while keeping both rectangles on
 * the lot and at least one foot of their edges overlapping.
 */
export function attachedOriginToExisting({
  desired,
  widthFt,
  depthFt,
  existing,
  lotWidthFt,
  lotDepthFt,
  preferredSide,
}) {
  if (!existing) return null;
  const width = Math.max(0, num(widthFt));
  const depth = Math.max(0, num(depthFt));
  const lotWidth = Math.max(1, num(lotWidthFt));
  const lotDepth = Math.max(1, num(lotDepthFt));
  if (width <= 0 || depth <= 0 || width > lotWidth || depth > lotDepth) return null;

  const wanted = {
    x0: num(desired?.x0),
    y0: num(desired?.y0),
  };
  const overlap = Math.min(1, width, depth, existing.x1 - existing.x0, existing.y1 - existing.y0);
  const candidates = [];
  const addCandidate = (side, x0, y0) => {
    if (
      x0 < -0.05 ||
      y0 < -0.05 ||
      x0 + width > lotWidth + 0.05 ||
      y0 + depth > lotDepth + 0.05
    ) {
      return;
    }
    const distance = (x0 - wanted.x0) ** 2 + (y0 - wanted.y0) ** 2;
    candidates.push({
      side,
      x0: Math.max(0, Math.min(lotWidth - width, x0)),
      y0: Math.max(0, Math.min(lotDepth - depth, y0)),
      distance: distance - (side === preferredSide ? 0.001 : 0),
    });
  };
  const clampRange = (value, min, max) => Math.min(max, Math.max(min, value));

  const verticalMin = Math.max(0, existing.y0 - depth + overlap);
  const verticalMax = Math.min(lotDepth - depth, existing.y1 - overlap);
  if (verticalMin <= verticalMax) {
    addCandidate(
      "side_left",
      existing.x0 - width,
      clampRange(wanted.y0, verticalMin, verticalMax)
    );
    addCandidate(
      "side_right",
      existing.x1,
      clampRange(wanted.y0, verticalMin, verticalMax)
    );
  }

  const horizontalMin = Math.max(0, existing.x0 - width + overlap);
  const horizontalMax = Math.min(lotWidth - width, existing.x1 - overlap);
  if (horizontalMin <= horizontalMax) {
    addCandidate(
      "front",
      clampRange(wanted.x0, horizontalMin, horizontalMax),
      existing.y0 - depth
    );
    addCandidate(
      "back",
      clampRange(wanted.x0, horizontalMin, horizontalMax),
      existing.y1
    );
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0] ?? null;
}

/** Whether two rectangles have at least `gapFt` of clear space between them. */
export function rectSeparatedFrom(rect, existing, gapFt = 1) {
  if (!rect || !existing) return null;
  const gap = Math.max(0, num(gapFt));
  return (
    rect.x1 <= existing.x0 - gap ||
    rect.x0 >= existing.x1 + gap ||
    rect.y1 <= existing.y0 - gap ||
    rect.y0 >= existing.y1 + gap
  );
}

/**
 * Keep a detached ADU clear of the existing structure. Free positions are
 * preserved; a colliding/touching position is projected to the nearest
 * feasible side with a one-foot separation.
 */
export function detachedOriginFromExisting({
  desired,
  widthFt,
  depthFt,
  existing,
  lotWidthFt,
  lotDepthFt,
  gapFt = 1,
}) {
  if (!existing) return null;
  const width = Math.max(0, num(widthFt));
  const depth = Math.max(0, num(depthFt));
  const lotWidth = Math.max(1, num(lotWidthFt));
  const lotDepth = Math.max(1, num(lotDepthFt));
  const gap = Math.max(0, num(gapFt));
  if (width <= 0 || depth <= 0 || width > lotWidth || depth > lotDepth) return null;

  const wanted = clampOriginToLot(desired, width, depth, lotWidth, lotDepth);
  const wantedRect = {
    x0: wanted.x0,
    y0: wanted.y0,
    x1: wanted.x0 + width,
    y1: wanted.y0 + depth,
  };
  if (rectSeparatedFrom(wantedRect, existing, gap)) return wanted;

  const candidates = [];
  const addCandidate = (x0, y0) => {
    if (
      x0 < -0.05 ||
      y0 < -0.05 ||
      x0 + width > lotWidth + 0.05 ||
      y0 + depth > lotDepth + 0.05
    ) {
      return;
    }
    candidates.push({
      x0: Math.max(0, Math.min(lotWidth - width, x0)),
      y0: Math.max(0, Math.min(lotDepth - depth, y0)),
      distance: (x0 - wanted.x0) ** 2 + (y0 - wanted.y0) ** 2,
    });
  };
  const clampedX = Math.min(lotWidth - width, Math.max(0, wanted.x0));
  const clampedY = Math.min(lotDepth - depth, Math.max(0, wanted.y0));
  addCandidate(existing.x0 - gap - width, clampedY);
  addCandidate(existing.x1 + gap, clampedY);
  addCandidate(clampedX, existing.y0 - gap - depth);
  addCandidate(clampedX, existing.y1 + gap);

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0] ?? null;
}

/**
 * Where a building of this size goes before anyone drags it: centred in the
 * envelope on a clear lot, or against the wall of the house it extends.
 */
export function defaultPlannedOrigin({
  envelope,
  existing,
  additionLocation,
  widthFt,
  depthFt,
}) {
  const width = Math.max(0, num(widthFt));
  const depth = Math.max(0, num(depthFt));
  if (!existing) {
    return {
      x0: (envelope.x0 + envelope.x1) / 2 - width / 2,
      y0: (envelope.y0 + envelope.y1) / 2 - depth / 2,
    };
  }
  const existingCenterX = (existing.x0 + existing.x1) / 2;
  const existingCenterY = (existing.y0 + existing.y1) / 2;
  if (additionLocation === "above") {
    return { x0: existing.x0, y0: existing.y0 };
  }
  if (additionLocation === "back") return { x0: existingCenterX - width / 2, y0: existing.y1 };
  if (additionLocation === "front") return { x0: existingCenterX - width / 2, y0: existing.y0 - depth };
  if (additionLocation === "side_left") return { x0: existing.x0 - width, y0: existingCenterY - depth / 2 };
  return { x0: existing.x1, y0: existingCenterY - depth / 2 };
}

/** An upper floor starts centred on the floor holding it up. */
export function defaultUpperFloorOrigin(below, widthFt, depthFt) {
  const width = Math.max(0, num(widthFt));
  const depth = Math.max(0, num(depthFt));
  return {
    x0: (below.x0 + below.x1) / 2 - width / 2,
    y0: (below.y0 + below.y1) / 2 - depth / 2,
  };
}

/**
 * Every floor's rectangle, bottom to top. Floor 1 is placed on the lot; each
 * floor above starts centred on the one below it, and any floor the client has
 * dragged keeps the position they gave it. Floors without both dimensions are
 * `null` so the array index always means the same floor.
 */
export function floorRects({
  lotWidthFt,
  lotDepthFt,
  envelope,
  existing,
  additionLocation,
  placementMode = "free",
  floors = [],
  positions = [],
}) {
  const rects = [];
  for (let index = 0; index < floors.length; index += 1) {
    const widthFt = floors[index]?.widthFt;
    const depthFt = floors[index]?.depthFt;
    const below = index > 0 ? rects[index - 1] : null;
    if (index > 0 && !below) {
      // Nothing to stand on: an upper floor cannot be placed until the floor
      // beneath it has a size.
      rects.push(null);
      continue;
    }
    const groundExisting = index === 0 ? existing : null;
    const fallback = below
      ? defaultUpperFloorOrigin(below, widthFt, depthFt)
      : defaultPlannedOrigin({
          envelope,
          existing: placementMode === "adu" ? null : groundExisting,
          additionLocation,
          widthFt,
          depthFt,
        });
    rects.push(
      plannedRect({
        lotWidthFt,
        lotDepthFt,
        envelope,
        existing: groundExisting,
        additionLocation,
        placementMode: index === 0 ? placementMode : "free",
        widthFt,
        depthFt,
        position: positions[index] ?? fallback,
      })
    );
  }
  return rects;
}

/** Whether `rect` sits entirely on top of `below`, to a half-inch tolerance. */
export function rectOnTopOf(rect, below) {
  if (!rect || !below) return null;
  const t = 0.05;
  return (
    rect.x0 >= below.x0 - t &&
    rect.x1 <= below.x1 + t &&
    rect.y0 >= below.y0 - t &&
    rect.y1 <= below.y1 + t
  );
}

/** Keep a rectangle of this size on the lot. Off the lot means nothing. */
export function clampOriginToLot(origin, widthFt, depthFt, lotWidthFt, lotDepthFt) {
  const lotWidth = Math.max(1, num(lotWidthFt, 25));
  const lotDepth = Math.max(1, num(lotDepthFt, 100));
  const width = Math.max(0, num(widthFt));
  const depth = Math.max(0, num(depthFt));
  return {
    x0: Math.min(Math.max(0, num(origin?.x0)), Math.max(0, lotWidth - width)),
    y0: Math.min(Math.max(0, num(origin?.y0)), Math.max(0, lotDepth - depth)),
  };
}

/**
 * The planned building's rectangle. `position` is the client's own placement
 * once they have moved it; until then the default above applies.
 */
export function plannedRect({
  lotWidthFt,
  lotDepthFt,
  envelope,
  existing,
  additionLocation,
  placementMode = "free",
  widthFt,
  depthFt,
  position,
}) {
  const width = Math.max(0, num(widthFt));
  const depth = Math.max(0, num(depthFt));
  if (width <= 0 || depth <= 0) return null;
  const desired =
    position ??
    defaultPlannedOrigin({
      envelope,
      existing,
      additionLocation,
      widthFt: width,
      depthFt: depth,
    });
  const attached =
    existing && placementMode === "addition"
      ? attachedOriginToExisting({
          desired,
          widthFt: width,
          depthFt: depth,
          existing,
          lotWidthFt,
          lotDepthFt,
          preferredSide: additionLocation,
        })
      : null;
  const detached =
    existing && placementMode === "adu"
      ? detachedOriginFromExisting({
          desired,
          widthFt: width,
          depthFt: depth,
          existing,
          lotWidthFt,
          lotDepthFt,
        })
      : null;
  if (existing && placementMode === "addition" && !attached) return null;
  if (existing && placementMode === "adu" && !detached) return null;
  const origin =
    attached ??
    detached ??
    clampOriginToLot(desired, width, depth, lotWidthFt, lotDepthFt);
  return { x0: origin.x0, y0: origin.y0, x1: origin.x0 + width, y1: origin.y0 + depth };
}

/** Whether a rectangle is fully inside the envelope, to a half-inch tolerance. */
export function rectFitsEnvelope(rect, envelope) {
  if (!rect || !envelope) return null;
  const t = 0.05;
  return (
    rect.x0 >= envelope.x0 - t &&
    rect.x1 <= envelope.x1 + t &&
    rect.y0 >= envelope.y0 - t &&
    rect.y1 <= envelope.y1 + t
  );
}
