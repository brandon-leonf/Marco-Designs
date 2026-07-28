// Where north is, relative to the massing model's axes.
//
// The 3D preview draws an axis-aligned box: width runs along the model's X
// axis, depth along Y. The real parcel is rotated against true north by
// whatever angle the street grid happens to sit at, so an arrow drawn straight
// up the screen would be decoration, not information.
//
// The method, as specified:
//   1. take the parcel centroid, in WGS84
//   2. take a second point directly north of it
//   3. express both in the model's coordinate system
//   4. the angle between them is where north points in the model
//
// Step 3 is the part that needs care. The model's axes are not arbitrary: its
// depth axis runs along the parcel's own long dimension, because that is how
// the lot rectangle is derived. So "convert into the model coordinate system"
// means rotating geographic bearings by the parcel's own heading.

import * as turf from "@turf/turf";

/** Every vertex of a Polygon or MultiPolygon, flattened. */
function ringVertices(geometry) {
  const out = [];
  const push = (rings) => rings?.forEach((ring) => ring?.forEach((pt) => out.push(pt)));
  if (geometry.type === "Polygon") push(geometry.coordinates);
  else if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(push);
  return out;
}

/**
 * Compass bearing of the parcel's long axis, 0–180°, by principal component
 * analysis of its vertices.
 *
 * The longest single edge would be cheaper, but a notched or many-sided lot
 * can have its longest edge running across the short dimension. PCA weighs
 * every vertex, so the axis it returns is the one the lot actually extends
 * along. Longitude is scaled by cos(latitude) first — a degree of longitude
 * is shorter than a degree of latitude here, and skipping that tilts the axis.
 */
function parcelHeadingDeg(geometry, meanLat) {
  const points = ringVertices(geometry);
  if (points.length < 3) return null;

  const kx = Math.cos((meanLat * Math.PI) / 180);
  let sumX = 0;
  let sumY = 0;
  for (const [lng, lat] of points) {
    sumX += lng * kx;
    sumY += lat;
  }
  const cx = sumX / points.length;
  const cy = sumY / points.length;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [lng, lat] of points) {
    const dx = lng * kx - cx;
    const dy = lat - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 && syy === 0) return null;

  // Angle of the major axis, measured counter-clockwise from east.
  const axisRad = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const axisDeg = (axisRad * 180) / Math.PI;
  // Compass bearings run clockwise from north, so swap the reference.
  const bearing = 90 - axisDeg;
  // Direction, not sense: 20° and 200° describe the same lot. Fold to a
  // half-circle so the arrow never flips at random.
  return ((bearing % 180) + 180) % 180;
}

/**
 * Angle, in degrees clockwise from the model's "up" (its −Y / depth axis),
 * at which true north lies. Null when there is no parcel polygon to measure.
 *
 * Returns 0 for a lot whose long axis already runs north–south, which is the
 * same answer the naive straight-up arrow would give — the difference only
 * shows on a rotated grid, which is most of Hudson County.
 */
export function northAngleFromParcel(parcelGeojson) {
  if (!parcelGeojson) return null;
  let feature;
  try {
    feature = parcelGeojson.type === "Feature"
      ? parcelGeojson
      : turf.feature(parcelGeojson);
    if (!feature?.geometry) return null;
  } catch {
    return null;
  }

  let centroid;
  try {
    centroid = turf.centroid(feature); // step 1
  } catch {
    return null;
  }
  const [lng, lat] = centroid.geometry.coordinates;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  // Step 2: a point directly north. Bearing from the centroid to it is 0 by
  // construction, so the geographic half of the problem is settled — what is
  // left is expressing that direction in the model's frame.
  const heading = parcelHeadingDeg(feature.geometry, lat); // step 3
  if (heading == null) return null;

  // The model's depth axis is drawn along the parcel's long axis. North sits
  // at -heading from it; normalise into 0–360 for the renderer.
  return ((-heading % 360) + 360) % 360;
}
