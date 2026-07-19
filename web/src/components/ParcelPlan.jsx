/**
 * SVG plan view of a real parcel polygon and its buildable envelope.
 * Geometry arrives as GeoJSON in EPSG:3424 (NJ State Plane, US survey feet),
 * so coordinates are already planar feet — we just fit them to the viewBox
 * and flip Y (state plane Y grows north, SVG y grows down).
 */

function polys(geojson) {
  if (!geojson) return [];
  if (geojson.type === "Polygon") return [geojson.coordinates];
  if (geojson.type === "MultiPolygon") return geojson.coordinates;
  return [];
}

function toPath(polygons, tx, ty, s) {
  return polygons
    .flatMap((rings) =>
      rings.map(
        (ring) =>
          "M" +
          ring.map(([x, y]) => `${((x - tx) * s).toFixed(1)},${((ty - y) * s).toFixed(1)}`).join("L") +
          "Z"
      )
    )
    .join(" ");
}

export default function ParcelPlan({ parcelGeojson, envelopeGeojson }) {
  const parcel = polys(parcelGeojson);
  if (!parcel.length) return null;
  const envelope = polys(envelopeGeojson);

  const pts = parcel.flat(2);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const wFt = maxX - minX, dFt = maxY - minY;

  const maxDim = 260, pad = 14;
  const s = maxDim / Math.max(wFt, dFt);
  const w = wFt * s, d = dFt * s;

  return (
    <svg
      viewBox={`${-pad} ${-pad} ${w + pad * 2} ${d + pad * 2}`}
      className="diagram"
      role="img"
      aria-label="Parcel with buildable envelope"
    >
      <path d={toPath(parcel, minX, maxY, s)} className="lot" fillRule="evenodd" />
      {envelope.length > 0 && (
        <path d={toPath(envelope, minX, maxY, s)} className="envelope" fillRule="evenodd" />
      )}
      <text x={w / 2} y={-4} textAnchor="middle" className="dim">
        {Math.round(wFt)}′
      </text>
      <text
        x={-5}
        y={d / 2}
        textAnchor="middle"
        className="dim"
        transform={`rotate(-90 -5 ${d / 2})`}
      >
        {Math.round(dFt)}′
      </text>
    </svg>
  );
}
