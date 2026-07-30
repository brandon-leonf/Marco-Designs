import { useRef, useState } from "react";
import {
  envelopeRect,
  existingRect,
  defaultPlannedOrigin,
  defaultUpperFloorOrigin,
  clampOriginToLot,
  attachedOriginToExisting,
  detachedOriginFromExisting,
  floorRects as computeFloorRects,
  rectFitsEnvelope,
  rectOnTopOf,
} from "../lib/placement.js";

/**
 * Draggable 2D site plan — the primary way to place and size the building.
 *
 * Everything is modelled in feet on the axes lib/placement.js defines: x runs
 * across the lot, y runs from the street (y = 0) to the rear. SVG y grows
 * downward, so the street ends up at the bottom of the drawing, which is how
 * site plans are normally read.
 *
 * Every floor is drawn, each in its own colour, stacked back to front so the
 * ground floor reads as the base. One floor is selected at a time; that floor
 * can be moved anywhere on the lot and resized from any edge.
 *
 * Nothing is clamped to the buildable envelope, and no floor is clamped to the
 * one below it: a placement that breaks a setback or oversteps its support is
 * drawn in red and reported as not fitting, which is more use to the client
 * than a rectangle that silently refuses to go where they put it. Only the lot
 * itself is a hard boundary, and only because off the lot means nothing.
 */

const VIEW_W = 460;
const VIEW_H = 430;
const MARGIN = 52;
const HANDLE = 9;

// One hue per floor, walking up the brass palette so floor order is legible
// without reading the labels. Beyond this many floors the colours repeat,
// which is fine — the district limits are far below it.
const FLOOR_COLORS = [
  { fill: "#e3c98a", stroke: "#8a6d1f" },
  { fill: "#bcd3c4", stroke: "#3c7454" },
  { fill: "#c9d2e6", stroke: "#4a5d8a" },
  { fill: "#e7cbb9", stroke: "#96603f" },
  { fill: "#d9c9e0", stroke: "#6f4d80" },
];
export const floorColor = (index) => FLOOR_COLORS[index % FLOOR_COLORS.length];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
// Matches the 0.5 ft step on the width/depth inputs, so dragging and typing
// can express exactly the same set of sizes.
const snap = (value) => Math.round(value * 2) / 2;
const fmtFt = (value) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 1 });

export default function SitePlan2D({
  lotWidthFt,
  lotDepthFt,
  setbacks,
  zoningVerified = true,
  existingBuilding,
  placementMode = "free",
  floors = [],
  positions = [],
  maxWidthFt,
  maxDepthFt,
  selectedFloor = 0,
  streetName,
  onSelectFloor,
  onResize,
  onMove,
  onExistingMove,
  onAdditionSideChange,
  onResetPosition,
  onFillEnvelope,
  proposedLabel = "Proposed building",
}) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(null);

  const lotWidth = Math.max(1, Number(lotWidthFt) || 25);
  const lotDepth = Math.max(1, Number(lotDepthFt) || 100);
  const envelope = envelopeRect(lotWidth, lotDepth, setbacks);
  const existing = existingRect(
    lotWidth,
    lotDepth,
    existingBuilding?.footprintSqft,
    existingBuilding?.location,
    existingBuilding?.position
  );
  const additionLocation = existingBuilding?.additionLocation;
  const groundAddition = Boolean(existing) && placementMode === "addition";
  const detachedAdu = Boolean(existing) && placementMode === "adu";

  const rects = computeFloorRects({
    lotWidthFt: lotWidth,
    lotDepthFt: lotDepth,
    envelope,
    existing,
    additionLocation,
    placementMode,
    floors,
    positions,
  });
  const active = clamp(selectedFloor, 0, Math.max(0, floors.length - 1));
  const rect = rects[active] ?? null;
  const hasAnyRect = rects.some(Boolean);
  const attachmentUnavailable =
    groundAddition &&
    Number(floors[0]?.widthFt) > 0 &&
    Number(floors[0]?.depthFt) > 0 &&
    !rects[0];
  const separationUnavailable =
    detachedAdu &&
    Number(floors[0]?.widthFt) > 0 &&
    Number(floors[0]?.depthFt) > 0 &&
    !rects[0];

  // Fit the lot to the drawing area; the scale is uniform so the plan stays
  // true and the scale bar below means something.
  const s = Math.min((VIEW_W - MARGIN * 2) / lotWidth, (VIEW_H - MARGIN * 2) / lotDepth);
  const planW = lotWidth * s;
  const planH = lotDepth * s;
  const originX = (VIEW_W - planW) / 2;
  const originY = (VIEW_H - planH) / 2;
  const sx = (xFt) => originX + xFt * s;
  const sy = (yFt) => originY + (lotDepth - yFt) * s; // street at the bottom

  /** Pointer position in lot feet, via the SVG's own transform. */
  const pointerFeet = (event) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!ctm) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(ctm.inverse());
    return { x: (local.x - originX) / s, y: lotDepth - (local.y - originY) / s };
  };

  const startDrag = (handle, targetRect = rect) => (event) => {
    if (!targetRect) return;
    event.preventDefault();
    event.stopPropagation();
    const start = pointerFeet(event);
    if (!start) return;
    dragRef.current = { handle, start, rect: targetRect };
    setDragging(handle);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onDrag = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const now = pointerFeet(event);
    if (!now) return;
    const { handle, rect: from } = drag;
    const dx = now.x - drag.start.x;
    const dy = now.y - drag.start.y;
    const maxWidth = Math.max(1, Number(maxWidthFt) || lotWidth);
    const maxDepth = Math.max(1, Number(maxDepthFt) || lotDepth);

    if (handle === "existing") {
      const next = clampOriginToLot(
        { x0: snap(from.x0 + dx), y0: snap(from.y0 + dy) },
        from.x1 - from.x0,
        from.y1 - from.y0,
        lotWidth,
        lotDepth
      );
      onExistingMove?.(
        next.x0,
        next.y0,
        next.x0 - existing.x0,
        next.y0 - existing.y0
      );
      return;
    }

    if (handle === "move") {
      const desired = clampOriginToLot(
        { x0: snap(from.x0 + dx), y0: snap(from.y0 + dy) },
        from.x1 - from.x0,
        from.y1 - from.y0,
        lotWidth,
        lotDepth
      );
      const attached =
        groundAddition && active === 0
          ? attachedOriginToExisting({
              desired,
              widthFt: from.x1 - from.x0,
              depthFt: from.y1 - from.y0,
              existing,
              lotWidthFt: lotWidth,
              lotDepthFt: lotDepth,
              preferredSide: additionLocation,
          })
          : null;
      const detached =
        detachedAdu && active === 0
          ? detachedOriginFromExisting({
              desired,
              widthFt: from.x1 - from.x0,
              depthFt: from.y1 - from.y0,
              existing,
              lotWidthFt: lotWidth,
              lotDepthFt: lotDepth,
            })
          : null;
      const next = attached ?? detached ?? desired;
      if (groundAddition && active === 0 && !attached) return;
      if (detachedAdu && active === 0 && !detached) return;
      onMove?.(active, next.x0, next.y0);
      if (attached?.side) onAdditionSideChange?.(attached.side);
      return;
    }

    // Edge-anchored resize: the edge under the pointer moves, the opposite
    // edge stays put. Dragging a leading edge therefore changes the origin
    // too, which is why size and position are reported together.
    let { x0, y0, x1, y1 } = from;
    if (handle.includes("e")) x1 = clamp(snap(from.x1 + dx), x0 + 1, x0 + maxWidth);
    if (handle.includes("w")) x0 = clamp(snap(from.x0 + dx), x1 - maxWidth, x1 - 1);
    if (handle.includes("n")) y1 = clamp(snap(from.y1 + dy), y0 + 1, y0 + maxDepth);
    if (handle.includes("s")) y0 = clamp(snap(from.y0 + dy), y1 - maxDepth, y1 - 1);

    const desired = clampOriginToLot({ x0, y0 }, x1 - x0, y1 - y0, lotWidth, lotDepth);
    const attached =
      groundAddition && active === 0
        ? attachedOriginToExisting({
            desired,
            widthFt: x1 - x0,
            depthFt: y1 - y0,
            existing,
            lotWidthFt: lotWidth,
            lotDepthFt: lotDepth,
            preferredSide: additionLocation,
        })
      : null;
    const detached =
      detachedAdu && active === 0
        ? detachedOriginFromExisting({
            desired,
            widthFt: x1 - x0,
            depthFt: y1 - y0,
            existing,
            lotWidthFt: lotWidth,
            lotDepthFt: lotDepth,
          })
        : null;
    const next = attached ?? detached ?? desired;
    if (groundAddition && active === 0 && !attached) return;
    if (detachedAdu && active === 0 && !detached) return;
    onResize?.(active, x1 - x0, y1 - y0);
    onMove?.(active, next.x0, next.y0);
    if (attached?.side) onAdditionSideChange?.(attached.side);
  };

  const endDrag = (event) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handles = rect
    ? [
        { id: "w", x: rect.x0, y: (rect.y0 + rect.y1) / 2, cursor: "ew-resize" },
        { id: "e", x: rect.x1, y: (rect.y0 + rect.y1) / 2, cursor: "ew-resize" },
        { id: "s", x: (rect.x0 + rect.x1) / 2, y: rect.y0, cursor: "ns-resize" },
        { id: "n", x: (rect.x0 + rect.x1) / 2, y: rect.y1, cursor: "ns-resize" },
        { id: "sw", x: rect.x0, y: rect.y0, cursor: "nesw-resize" },
        { id: "se", x: rect.x1, y: rect.y0, cursor: "nwse-resize" },
        { id: "nw", x: rect.x0, y: rect.y1, cursor: "nwse-resize" },
        { id: "ne", x: rect.x1, y: rect.y1, cursor: "nesw-resize" },
      ]
    : [];

  // A round scale-bar length that fits comfortably under the plan.
  const barFt = [5, 10, 20, 25, 50, 100].reverse().find((ft) => ft * s <= planW * 0.55) ?? 5;

  const outsideEnvelope =
    zoningVerified &&
    rects.some((r) => r && rectFitsEnvelope(r, envelope) === false);
  const offSupport = rects.some(
    (r, index) => index > 0 && r && rects[index - 1] && rectOnTopOf(r, rects[index - 1]) === false
  );
  const moved =
    positions[active] != null &&
    rect != null &&
    (() => {
      const below = active > 0 ? rects[active - 1] : null;
      const home = below
        ? defaultUpperFloorOrigin(below, rect.x1 - rect.x0, rect.y1 - rect.y0)
        : defaultPlannedOrigin({
            envelope,
            existing,
            additionLocation,
            widthFt: rect.x1 - rect.x0,
            depthFt: rect.y1 - rect.y0,
          });
      return Math.abs(home.x0 - rect.x0) > 0.05 || Math.abs(home.y0 - rect.y0) > 0.05;
    })();

  return (
    <div className="site-plan">
      {floors.length > 1 && (
        <div className="floor-picker" role="group" aria-label="Select a floor to place">
          {floors.map((_, index) => (
            <button
              type="button"
              key={index}
              className={index === active ? "floor-chip active" : "floor-chip"}
              style={{ "--chip": floorColor(index).stroke, "--chip-fill": floorColor(index).fill }}
              onClick={() => onSelectFloor?.(index)}
              aria-pressed={index === active}
              disabled={!rects[index]}
            >
              <i aria-hidden="true" />
              Floor {index + 1}
            </button>
          ))}
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className={dragging ? "site-plan-svg dragging" : "site-plan-svg"}
        role="img"
        aria-label={`Site plan: ${fmtFt(lotWidth)} by ${fmtFt(lotDepth)} foot lot${
          rect ? `, floor ${active + 1} is ${fmtFt(rect.x1 - rect.x0)} by ${fmtFt(rect.y1 - rect.y0)} feet` : ""
        }`}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* Street band, drawn first so the lot sits on top of it. */}
        <rect x="0" y={sy(0)} width={VIEW_W} height={VIEW_H - sy(0)} className="plan-street" />
        {streetName && (
          <text x={VIEW_W / 2} y={sy(0) + 26} className="plan-street-label" textAnchor="middle">
            {streetName}
          </text>
        )}

        <rect x={sx(0)} y={sy(lotDepth)} width={planW} height={planH} className="plan-lot" />

        {zoningVerified && envelope.x1 > envelope.x0 && envelope.y1 > envelope.y0 && (
          <rect
            x={sx(envelope.x0)}
            y={sy(envelope.y1)}
            width={(envelope.x1 - envelope.x0) * s}
            height={(envelope.y1 - envelope.y0) * s}
            className="plan-envelope"
          />
        )}

        {existing && (
          <>
            <rect
              x={sx(existing.x0)}
              y={sy(existing.y1)}
              width={(existing.x1 - existing.x0) * s}
              height={(existing.y1 - existing.y0) * s}
              className="plan-existing selectable"
              onPointerDown={startDrag("existing", existing)}
            />
            <text
              x={sx((existing.x0 + existing.x1) / 2)}
              y={sy((existing.y0 + existing.y1) / 2)}
              className="plan-shape-label"
              textAnchor="middle"
            >
              Existing
            </text>
          </>
        )}

        {/* Ground floor first so upper floors read as sitting on top of it. */}
        {rects.map((r, index) => {
          if (!r) return null;
          const color = floorColor(index);
          const badPlacement =
            (zoningVerified && rectFitsEnvelope(r, envelope) === false) ||
            (index > 0 && rects[index - 1] && rectOnTopOf(r, rects[index - 1]) === false);
          const isActive = index === active;
          return (
            <rect
              key={index}
              x={sx(r.x0)}
              y={sy(r.y1)}
              width={(r.x1 - r.x0) * s}
              height={(r.y1 - r.y0) * s}
              fill={badPlacement ? "#f3c9c4" : color.fill}
              stroke={badPlacement ? "#b3261e" : color.stroke}
              className={`plan-floor${isActive ? " active" : ""} selectable`}
              onPointerDown={
                isActive
                    ? startDrag("move")
                    : (event) => {
                        event.stopPropagation();
                        onSelectFloor?.(index);
                      }
              }
            />
          );
        })}

        {/* Only the selected floor is labelled — every floor labelled at once
            is unreadable on a small stacked plan. */}
        {rect && (
          <>
            <text
              x={sx((rect.x0 + rect.x1) / 2)}
              y={sy((rect.y0 + rect.y1) / 2) - 4}
              className="plan-shape-label"
              textAnchor="middle"
            >
              {floors.length > 1 ? `Floor ${active + 1}` : proposedLabel}
            </text>
            <text
              x={sx((rect.x0 + rect.x1) / 2)}
              y={sy((rect.y0 + rect.y1) / 2) + 11}
              className="plan-shape-dims"
              textAnchor="middle"
            >
              {fmtFt(rect.x1 - rect.x0)}′ × {fmtFt(rect.y1 - rect.y0)}′
            </text>
          </>
        )}

        {handles.map((handle) => (
          <rect
            key={handle.id}
            x={sx(handle.x) - HANDLE / 2}
            y={sy(handle.y) - HANDLE / 2}
            width={HANDLE}
            height={HANDLE}
            className={dragging === handle.id ? "plan-handle active" : "plan-handle"}
            style={{ cursor: handle.cursor }}
            onPointerDown={startDrag(handle.id)}
          />
        ))}

        {/* Lot dimensions and the setbacks that carve the envelope out of it. */}
        <text x={sx(lotWidth / 2)} y={sy(lotDepth) - 10} className="plan-dim" textAnchor="middle">
          {fmtFt(lotWidth)}′
        </text>
        <text
          x={sx(0) - 12}
          y={sy(lotDepth / 2)}
          className="plan-dim"
          textAnchor="middle"
          transform={`rotate(-90 ${sx(0) - 12} ${sy(lotDepth / 2)})`}
        >
          {fmtFt(lotDepth)}′
        </text>
        {envelope.y0 > 0 && (
          <text x={sx(lotWidth / 2)} y={sy(envelope.y0) - 6} className="plan-setback" textAnchor="middle">
            Front {fmtFt(envelope.y0)}′
          </text>
        )}
        {lotDepth - envelope.y1 > 0 && (
          <text x={sx(lotWidth / 2)} y={sy(envelope.y1) + 14} className="plan-setback" textAnchor="middle">
            Rear {fmtFt(lotDepth - envelope.y1)}′
          </text>
        )}
        {envelope.x0 > 0 && (
          <text x={sx(envelope.x0) + 4} y={sy(lotDepth * 0.78)} className="plan-setback" textAnchor="start">
            Side {fmtFt(envelope.x0)}′
          </text>
        )}

        {/* North arrow. The plan is drawn on the lot's own axes, so this marks
            the street side rather than true north. */}
        <g className="plan-north" transform={`translate(${VIEW_W - 26} 26)`}>
          <path d="M0 -12 L5 8 L0 3 L-5 8 Z" />
          <text y="22" textAnchor="middle">N</text>
        </g>

        <g className="plan-scale" transform={`translate(${sx(0)} ${VIEW_H - 12})`}>
          <line x1="0" y1="0" x2={barFt * s} y2="0" />
          <line x1="0" y1="-4" x2="0" y2="4" />
          <line x1={barFt * s} y1="-4" x2={barFt * s} y2="4" />
          <text x={(barFt * s) / 2} y="-7" textAnchor="middle">{barFt} ft</text>
        </g>
      </svg>

      <div className="site-plan-footer">
        <ul className="site-plan-legend">
          {existing && (
            <li>
              <i className="swatch existing" aria-hidden="true" />
              Existing structure
            </li>
          )}
          {floors.length > 1 ? (
            rects.map((r, index) =>
              r ? (
                <li key={index}>
                  <i
                    className="swatch"
                    style={{
                      background: floorColor(index).fill,
                      borderColor: floorColor(index).stroke,
                    }}
                    aria-hidden="true"
                  />
                  Floor {index + 1}
                </li>
              ) : null
            )
          ) : (
            <li>
              <i
                className="swatch"
                style={{ background: floorColor(0).fill, borderColor: floorColor(0).stroke }}
                aria-hidden="true"
              />
              {proposedLabel}
            </li>
          )}
          {zoningVerified && (
            <li>
              <i className="swatch envelope" aria-hidden="true" />
              Buildable envelope
            </li>
          )}
        </ul>
        {attachmentUnavailable ? (
          <p className="site-plan-warning" role="status">
            <span aria-hidden="true">⚑</span> This addition size cannot fit on the lot while
            remaining attached to the existing structure.
          </p>
        ) : separationUnavailable ? (
          <p className="site-plan-warning" role="status">
            <span aria-hidden="true">⚑</span> This ADU size cannot fit on the lot while
            remaining separated from the existing structure.
          </p>
        ) : !hasAnyRect ? (
          <p className="site-plan-hint">
            Enter a floor size, or{" "}
            <button type="button" className="text-button compact" onClick={onFillEnvelope}>
              start from the maximum
            </button>{" "}
            and adjust it.
          </p>
        ) : (
          <p className="site-plan-hint">
            {floors.length > 1
              ? `Floor ${active + 1} selected — drag it to move, or its handles to resize. Click another floor to switch.`
              : groundAddition
                ? "Drag the yellow addition around the existing structure; it will remain attached."
                : detachedAdu
                  ? "Drag the yellow ADU anywhere on the lot; it will remain separated from the existing structure."
                : "Drag the building to move it, or its handles to resize."}{" "}
            {zoningVerified
              ? `Limited to ${fmtFt(maxWidthFt)}′ × ${fmtFt(maxDepthFt)}′ by zoning.`
              : `Limited to the ${fmtFt(maxWidthFt)}′ × ${fmtFt(maxDepthFt)}′ parcel workspace; zoning setbacks are not applied.`}
            {moved && (
              <>
                {" "}
                <button
                  type="button"
                  className="text-button compact"
                  onClick={() => onResetPosition?.(active)}
                >
                  Reset position
                </button>
              </>
            )}
          </p>
        )}
        {existing && (
          <p className="site-plan-hint existing-drag-hint">
            Drag the gray existing structure to adjust its position.
          </p>
        )}
        {outsideEnvelope && (
          <p className="site-plan-warning" role="status">
            <span aria-hidden="true">⚑</span> This placement crosses a setback line — it is outside
            the buildable envelope.
          </p>
        )}
        {offSupport && (
          <p className="site-plan-warning" role="status">
            <span aria-hidden="true">⚑</span> An upper floor extends past the floor below it.
          </p>
        )}
      </div>
    </div>
  );
}
