import { useEffect, useMemo, useRef, useState } from "react";

// The massing is an orientation aid beside the numbers, not the report's
// centrepiece — it was taking more vertical space than the figures it
// illustrates. The viewBox keeps the projection maths unchanged; only the
// rendered size shrinks.
const VIEW_WIDTH = 460;
const VIEW_HEIGHT = 300;
const MIN_ELEVATION = 12;
const MAX_ELEVATION = 78;
const MIN_ZOOM = 0.65;
const MAX_ZOOM = 2.2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const points = (items) => items.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");

function offsetMeasurement(start, end, center, distance = 18) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  let nx = -dy / length;
  let ny = dx / length;
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const positiveDistance = Math.hypot(
    midpoint.x + nx * distance - center.x,
    midpoint.y + ny * distance - center.y
  );
  const negativeDistance = Math.hypot(
    midpoint.x - nx * distance - center.x,
    midpoint.y - ny * distance - center.y
  );
  if (negativeDistance > positiveDistance) {
    nx *= -1;
    ny *= -1;
  }
  return {
    start: { x: start.x + nx * distance, y: start.y + ny * distance },
    end: { x: end.x + nx * distance, y: end.y + ny * distance },
    label: { x: midpoint.x + nx * (distance + 12), y: midpoint.y + ny * (distance + 12) },
  };
}

/**
 * Interactive orthographic massing viewer. The lot and floors are modeled in
 * feet, then projected for the current yaw/elevation. Dragging changes the
 * camera angle and the mouse wheel changes the projection scale.
 */
export default function BuildingPreview3D({
  lotWidthFt,
  lotDepthFt,
  floors = [],
  defaultFloorHeightFt = 10,
  lotAreaSqft,
  setbacks,
  northAngleDeg,
}) {
  const [view, setView] = useState({ yaw: -36, elevation: 34, zoom: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const drag = useRef(null);
  const viewer = useRef(null);
  const lotWidth = Math.max(1, Number(lotWidthFt) || 25);
  const lotDepth = Math.max(1, Number(lotDepthFt) || 100);
  const completeFloors = floors
    .map((floor) => ({
      widthFt: Number(floor?.widthFt),
      depthFt: Number(floor?.depthFt),
      heightFt: Number(floor?.heightFt) || defaultFloorHeightFt,
    }))
    .filter((floor) => floor.widthFt > 0 && floor.depthFt > 0 && floor.heightFt > 0)
    .map((floor) => ({
      widthFt: Math.min(lotWidth, floor.widthFt),
      depthFt: Math.min(lotDepth, floor.depthFt),
      heightFt: floor.heightFt,
    }));
  const groundWidth = completeFloors[0]?.widthFt ?? 0;
  const groundDepth = completeFloors[0]?.depthFt ?? 0;
  const totalHeight = completeFloors.reduce((sum, floor) => sum + floor.heightFt, 0);
  const proposedAreaSqft = completeFloors.reduce(
    (sum, floor) => sum + floor.widthFt * floor.depthFt,
    0
  );

  const scene = useMemo(() => {
    const yaw = (view.yaw * Math.PI) / 180;
    const elevation = (view.elevation * Math.PI) / 180;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const sinElevation = Math.sin(elevation);
    const cosElevation = Math.cos(elevation);
    const camera = ({ x, y, z = 0 }) => {
      const centeredX = x - lotWidth / 2;
      const centeredY = y - lotDepth / 2;
      const rotatedX = centeredX * cosYaw - centeredY * sinYaw;
      const rotatedY = centeredX * sinYaw + centeredY * cosYaw;
      return {
        x: rotatedX,
        y: rotatedY * sinElevation - z * cosElevation,
        depth: rotatedY * cosElevation + z * sinElevation,
      };
    };

    const lotWorld = [
      { x: 0, y: 0, z: 0 },
      { x: lotWidth, y: 0, z: 0 },
      { x: lotWidth, y: lotDepth, z: 0 },
      { x: 0, y: lotDepth, z: 0 },
    ];
    const worldFaces = [];
    const boundsWorld = [...lotWorld];
    let baseHeight = 0;

    completeFloors.forEach((floor, index) => {
      const x0 = (lotWidth - floor.widthFt) / 2;
      const x1 = x0 + floor.widthFt;
      const y0 = (lotDepth - floor.depthFt) / 2;
      const y1 = y0 + floor.depthFt;
      const z0 = baseHeight;
      const z1 = baseHeight + floor.heightFt;
      const b00 = { x: x0, y: y0, z: z0 };
      const b10 = { x: x1, y: y0, z: z0 };
      const b11 = { x: x1, y: y1, z: z0 };
      const b01 = { x: x0, y: y1, z: z0 };
      const t00 = { x: x0, y: y0, z: z1 };
      const t10 = { x: x1, y: y0, z: z1 };
      const t11 = { x: x1, y: y1, z: z1 };
      const t01 = { x: x0, y: y1, z: z1 };
      boundsWorld.push(b00, b10, b11, b01, t00, t10, t11, t01);
      worldFaces.push(
        { floor: index, kind: "wall-a", world: [b00, b10, t10, t00] },
        { floor: index, kind: "wall-b", world: [b10, b11, t11, t10] },
        { floor: index, kind: "wall-a", world: [b11, b01, t01, t11] },
        { floor: index, kind: "wall-b", world: [b01, b00, t00, t01] },
        { floor: index, kind: "top", world: [t00, t10, t11, t01] }
      );
      baseHeight = z1;
    });

    const cameraBounds = boundsWorld.map(camera);
    const xs = cameraBounds.map((point) => point.x);
    const ys = cameraBounds.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const baseScale = Math.min(
      (VIEW_WIDTH - 110) / Math.max(1, maxX - minX),
      (VIEW_HEIGHT - 105) / Math.max(1, maxY - minY)
    );
    const scale = baseScale * view.zoom;
    const middleX = (minX + maxX) / 2;
    const middleY = (minY + maxY) / 2;
    const project = (world) => {
      const point = camera(world);
      return {
        x: VIEW_WIDTH / 2 + (point.x - middleX) * scale,
        y: VIEW_HEIGHT / 2 + (point.y - middleY) * scale,
        depth: point.depth,
      };
    };

    const lot = lotWorld.map(project);
    const faces = worldFaces
      .map((face) => {
        const projected = face.world.map(project);
        return {
          ...face,
          projected,
          depth: projected.reduce((sum, point) => sum + point.depth, 0) / projected.length,
        };
      })
      .sort((a, b) => a.depth - b.depth);

    let dimensions = null;
    if (completeFloors.length > 0) {
      const x0 = (lotWidth - groundWidth) / 2;
      const x1 = x0 + groundWidth;
      const y0 = (lotDepth - groundDepth) / 2;
      const y1 = y0 + groundDepth;
      const groundCorners = [
        { x: x0, y: y0, z: 0 },
        { x: x1, y: y0, z: 0 },
        { x: x1, y: y1, z: 0 },
        { x: x0, y: y1, z: 0 },
      ].map((world) => ({ world, screen: project(world) }));
      const front = groundCorners.reduce((current, candidate) =>
        candidate.screen.y > current.screen.y ? candidate : current
      );
      const widthNeighbor = groundCorners.find(
        (corner) => corner.world.y === front.world.y && corner.world.x !== front.world.x
      );
      const depthNeighbor = groundCorners.find(
        (corner) => corner.world.x === front.world.x && corner.world.y !== front.world.y
      );
      const buildingCenter = project({ x: lotWidth / 2, y: lotDepth / 2, z: totalHeight / 2 });
      const width = offsetMeasurement(front.screen, widthNeighbor.screen, buildingCenter);
      const depth = offsetMeasurement(front.screen, depthNeighbor.screen, buildingCenter);
      const heightGround = front.screen;
      const heightTop = project({ ...front.world, z: totalHeight });
      const outwardX = heightGround.x - buildingCenter.x;
      const outwardY = heightGround.y - buildingCenter.y;
      const outwardLength = Math.max(1, Math.hypot(outwardX, outwardY));
      const ox = (outwardX / outwardLength) * 20;
      const oy = (outwardY / outwardLength) * 20;
      dimensions = {
        width,
        depth,
        height: {
          start: { x: heightGround.x + ox, y: heightGround.y + oy },
          end: { x: heightTop.x + ox, y: heightTop.y + oy },
          label: {
            x: (heightGround.x + heightTop.x) / 2 + ox * 1.8,
            y: (heightGround.y + heightTop.y) / 2 + oy * 1.8,
          },
        },
      };
    }

    // North as a world-space direction, run through the same projection as the
    // geometry. Reading the angle off the screen delta means the compass
    // follows the orbit instead of pointing at a fixed corner of the canvas.
    let northScreenAngle = null;
    if (northAngleDeg != null) {
      const radians = (northAngleDeg * Math.PI) / 180;
      const from = project({ x: 0, y: 0, z: 0 });
      const to = project({
        x: Math.sin(radians) * lotDepth,
        y: -Math.cos(radians) * lotDepth,
        z: 0,
      });
      northScreenAngle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI + 90;
    }

    return { lot, faces, dimensions, northScreenAngle };
  }, [
    northAngleDeg,
    completeFloors,
    groundDepth,
    groundWidth,
    lotDepth,
    lotWidth,
    totalHeight,
    view.elevation,
    view.yaw,
    view.zoom,
  ]);

  const changeZoom = (factor) => {
    setView((current) => ({ ...current, zoom: clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM) }));
  };
  useEffect(() => {
    const element = viewer.current;
    if (!element) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      setView((current) => ({
        ...current,
        zoom: clamp(current.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08), MIN_ZOOM, MAX_ZOOM),
      }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);
  const endDrag = (event) => {
    if (drag.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      drag.current = null;
      setIsDragging(false);
    }
  };
  const description = completeFloors.length
    ? `${completeFloors.length}-story house, ${groundWidth} feet wide by ${groundDepth} feet deep and ${totalHeight} feet high, centered inside a ${lotWidth} by ${lotDepth} foot lot. Drag to rotate and scroll to zoom.`
    : `${lotWidth} by ${lotDepth} foot lot awaiting planned house dimensions.`;

  return (
    <div className="building-preview-3d">
      <div className="building-dimension-summary" aria-live="polite">
        <span>Lot <strong>{lotWidth}′ × {lotDepth}′</strong></span>
        {lotAreaSqft > 0 && (
          <span>
            Lot area <strong>{Number(lotAreaSqft).toLocaleString("en-US", { maximumFractionDigits: 0 })} sq ft</strong>
          </span>
        )}
        {/* The setbacks are what carve the massing out of the lot, so they
            belong beside it rather than only in the table below. */}
        {setbacks?.front != null && (
          <span>Front setback <strong>{fmtNumber(setbacks.front)}′</strong></span>
        )}
        {setbacks?.side != null && (
          <span>Side setback <strong>{fmtNumber(setbacks.side)}′</strong></span>
        )}
        {setbacks?.rear != null && (
          <span>Rear setback <strong>{fmtNumber(setbacks.rear)}′</strong></span>
        )}
        {completeFloors.length > 0 ? (
          <>
            <span>House width <strong>{groundWidth}′</strong></span>
            <span>House depth <strong>{groundDepth}′</strong></span>
            <span>Total height <strong>{fmtNumber(totalHeight)}′</strong></span>
            <span>
              Proposed area <strong>{fmtArea(proposedAreaSqft)} sq ft</strong>
            </span>
          </>
        ) : (
          <span className="building-preview-prompt">Enter the number of floors to preview the house.</span>
        )}
      </div>

      <div className="building-viewer-stage" role="region" aria-label="Interactive 3D property viewer">
        <div className="building-viewer-tools">
          <span>Drag to rotate · Scroll to zoom</span>
          <button type="button" onClick={() => changeZoom(1.15)} aria-label="Zoom 3D preview in">+</button>
          <button type="button" onClick={() => changeZoom(1 / 1.15)} aria-label="Zoom 3D preview out">−</button>
        </div>
        <svg
          ref={viewer}
          className={isDragging ? "building-massing dragging" : "building-massing"}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          role="img"
          aria-label={description}
          tabIndex="0"
          onPointerDown={(event) => {
            drag.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              yaw: view.yaw,
              elevation: view.elevation,
            };
            setIsDragging(true);
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            const dx = event.clientX - drag.current.x;
            const dy = event.clientY - drag.current.y;
            setView((current) => ({
              ...current,
              yaw: drag.current.yaw + dx * 0.45,
              elevation: clamp(drag.current.elevation - dy * 0.35, MIN_ELEVATION, MAX_ELEVATION),
            }));
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={(event) => {
            const changes = {
              ArrowLeft: { yaw: -10 },
              ArrowRight: { yaw: 10 },
              ArrowUp: { elevation: 5 },
              ArrowDown: { elevation: -5 },
            };
            if (changes[event.key]) {
              event.preventDefault();
              setView((current) => ({
                ...current,
                yaw: current.yaw + (changes[event.key].yaw ?? 0),
                elevation: clamp(
                  current.elevation + (changes[event.key].elevation ?? 0),
                  MIN_ELEVATION,
                  MAX_ELEVATION
                ),
              }));
            } else if (event.key === "+" || event.key === "=") {
              event.preventDefault();
              changeZoom(1.15);
            } else if (event.key === "-") {
              event.preventDefault();
              changeZoom(1 / 1.15);
            }
          }}
        >
          <polygon className="massing-lot" points={points(scene.lot)} />
          {scene.northScreenAngle != null && (
            <g
              className="massing-compass"
              transform={`translate(${VIEW_WIDTH - 42} 42) rotate(${scene.northScreenAngle})`}
            >
              <circle r="18" />
              <polygon points="0,-14 5,4 0,0 -5,4" />
              <text y="-20" textAnchor="middle">N</text>
            </g>
          )}
          {scene.faces.map((face, index) => (
            <polygon
              className={`massing-face massing-face-${face.kind}`}
              points={points(face.projected)}
              key={`${face.floor}-${face.kind}-${index}`}
            />
          ))}
          {scene.dimensions && (
            <g className="massing-dimensions" aria-hidden="true">
              <Measurement measure={scene.dimensions.width} label={`${groundWidth}′ width`} />
              <Measurement measure={scene.dimensions.depth} label={`${groundDepth}′ depth`} />
              <Measurement measure={scene.dimensions.height} label={`${fmtNumber(totalHeight)}′ high`} />
            </g>
          )}
        </svg>
      </div>

      {completeFloors.length > 0 && (
        <>
          <ol className="massing-floor-list" aria-label="Planned floor dimensions">
            {completeFloors.map((floor, index) => (
              <li key={index}>
                Floor {index + 1}:{" "}
                <strong>
                  {floor.widthFt}′ × {floor.depthFt}′ × {fmtNumber(floor.heightFt)}′ high
                </strong>
                <span>{fmtArea(floor.widthFt * floor.depthFt)} sq ft</span>
              </li>
            ))}
            <li className="massing-floor-total">
              Total proposed build
              <span>{fmtArea(proposedAreaSqft)} sq ft</span>
            </li>
          </ol>
          <p className="massing-height-note">
            Total height is the sum of the floor heights entered above; new floors start at{" "}
            {defaultFloorHeightFt} ft.
          </p>
        </>
      )}
    </div>
  );
}

function Measurement({ measure, label }) {
  return (
    <>
      <line x1={measure.start.x} y1={measure.start.y} x2={measure.end.x} y2={measure.end.y} />
      <text x={measure.label.x} y={measure.label.y} textAnchor="middle">
        {label}
      </text>
    </>
  );
}

function fmtArea(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtNumber(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 1 });
}
