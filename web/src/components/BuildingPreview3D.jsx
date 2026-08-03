import { useEffect, useMemo, useRef, useState } from "react";
import { fetchTerrainGrid, TERRAIN_SOURCE } from "../lib/terrain.js";

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
  streetName,
  parcelGeojson,
  existingBuilding,
  // Each floor's rectangle in lot feet, as placed on the site plan. Entries
  // may be null for floors without a size. Null/empty keeps the defaults.
  plannedOriginsFt = null,
}) {
  const [view, setView] = useState({ yaw: -36, elevation: 34, zoom: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [terrain, setTerrain] = useState(null);
  const [terrainStatus, setTerrainStatus] = useState("idle");
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
      widthFt: floor.widthFt,
      depthFt: floor.depthFt,
      heightFt: floor.heightFt,
    }));
  const groundWidth = completeFloors[0]?.widthFt ?? 0;
  const groundDepth = completeFloors[0]?.depthFt ?? 0;
  const plannedHeight = completeFloors.reduce((sum, floor) => sum + floor.heightFt, 0);
  const proposedAreaSqft = completeFloors.reduce(
    (sum, floor) => sum + floor.widthFt * floor.depthFt,
    0
  );
  const existingFootprintSqft = Math.max(0, Number(existingBuilding?.footprintSqft) || 0);
  const existingScale =
    existingFootprintSqft > 0
      ? Math.min(1, Math.sqrt(existingFootprintSqft / (lotWidth * lotDepth)))
      : 0;
  const existingWidth = lotWidth * existingScale;
  const existingDepth = lotDepth * existingScale;
  const existingStories =
    Number(existingBuilding?.stories) > 0
      ? Number(existingBuilding.stories)
      : Number(existingBuilding?.totalAreaSqft) > 0 && existingFootprintSqft > 0
        ? Number(existingBuilding.totalAreaSqft) / existingFootprintSqft
        : 1;
  const existingHeight =
    existingFootprintSqft > 0
      ? Math.max(defaultFloorHeightFt, existingStories * defaultFloorHeightFt)
      : 0;
  const verticalAddition =
    existingBuilding?.placementMode != null
      ? existingBuilding.placementMode === "vertical"
      : existingBuilding?.additionLocation === "above";
  const detachedAdu = existingBuilding?.placementMode === "adu";
  const totalHeight = verticalAddition
    ? existingHeight + plannedHeight
    : Math.max(existingHeight, plannedHeight);
  useEffect(() => {
    if (!parcelGeojson || northAngleDeg == null) {
      setTerrain(null);
      setTerrainStatus("idle");
      return undefined;
    }
    const controller = new AbortController();
    setTerrainStatus("loading");
    fetchTerrainGrid({
      parcelGeojson,
      lotWidthFt: lotWidth,
      lotDepthFt: lotDepth,
      northAngleDeg,
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setTerrain(result);
          setTerrainStatus(result ? "ready" : "idle");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setTerrain(null);
          setTerrainStatus("unavailable");
        }
      });
    return () => controller.abort();
  }, [parcelGeojson, northAngleDeg, lotWidth, lotDepth]);

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
    const overflowWorldFaces = [];
    const boundsWorld = [...lotWorld];
    const sideSetback = Math.max(0, Number(setbacks?.side) || 0);
    const frontSetback = Math.max(0, Number(setbacks?.front) || 0);
    const rearSetback = Math.max(0, Number(setbacks?.rear) || 0);
    const envelopeBounds = {
      x0: sideSetback,
      x1: lotWidth - sideSetback,
      y0: frontSetback,
      y1: lotDepth - rearSetback,
    };
    const envelopeWorld =
      envelopeBounds.x1 > envelopeBounds.x0 && envelopeBounds.y1 > envelopeBounds.y0
        ? [
            { x: envelopeBounds.x0, y: envelopeBounds.y0, z: 0.12 },
            { x: envelopeBounds.x1, y: envelopeBounds.y0, z: 0.12 },
            { x: envelopeBounds.x1, y: envelopeBounds.y1, z: 0.12 },
            { x: envelopeBounds.x0, y: envelopeBounds.y1, z: 0.12 },
          ]
        : null;
    if (envelopeWorld) boundsWorld.push(...envelopeWorld);
    let existingBounds = null;
    if (existingFootprintSqft > 0) {
      const defaultX0 = (lotWidth - existingWidth) / 2;
      const defaultY0 =
        existingBuilding?.location === "front"
          ? 0
          : existingBuilding?.location === "rear"
            ? lotDepth - existingDepth
            : (lotDepth - existingDepth) / 2;
      const positionedX0 = Number(existingBuilding?.position?.x0);
      const positionedY0 = Number(existingBuilding?.position?.y0);
      const x0 = Math.min(
        Math.max(0, Number.isFinite(positionedX0) ? positionedX0 : defaultX0),
        Math.max(0, lotWidth - existingWidth)
      );
      const y0 = Math.min(
        Math.max(0, Number.isFinite(positionedY0) ? positionedY0 : defaultY0),
        Math.max(0, lotDepth - existingDepth)
      );
      const x1 = x0 + existingWidth;
      const y1 = y0 + existingDepth;
      existingBounds = { x0, x1, y0, y1 };
      const storyCount = Math.max(1, Math.ceil(existingStories));
      for (let story = 0; story < storyCount; story += 1) {
        const z0 = (existingHeight / storyCount) * story;
        const z1 = (existingHeight / storyCount) * (story + 1);
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
          { floor: `existing-${story}`, kind: "existing-wall-a", world: [b00, b10, t10, t00] },
          { floor: `existing-${story}`, kind: "existing-wall-b", world: [b10, b11, t11, t10] },
          { floor: `existing-${story}`, kind: "existing-wall-a", world: [b11, b01, t01, t11] },
          { floor: `existing-${story}`, kind: "existing-wall-b", world: [b01, b00, t00, t01] }
        );
        if (story === storyCount - 1) {
          worldFaces.push({
            floor: `existing-${story}`,
            kind: "existing-top",
            world: [t00, t10, t11, t01],
          });
        }
      }
    }

    // Centring on the *envelope* rather than the lot: with asymmetric front
    // and rear setbacks the lot's centre is not where a maximum-size house can
    // actually go, and the site plan places it here too. The two views draw
    // the same building.
    let plannedCenterX = (envelopeBounds.x0 + envelopeBounds.x1) / 2;
    let plannedCenterY = (envelopeBounds.y0 + envelopeBounds.y1) / 2;
    let baseHeight = 0;
    if (existingBounds) {
      if (verticalAddition) {
        plannedCenterX = (existingBounds.x0 + existingBounds.x1) / 2;
        plannedCenterY = (existingBounds.y0 + existingBounds.y1) / 2;
        baseHeight = existingHeight;
      } else {
        const location = existingBuilding?.additionLocation;
        if (location === "back") {
          plannedCenterX = (existingBounds.x0 + existingBounds.x1) / 2;
          plannedCenterY = existingBounds.y1 + groundDepth / 2;
        } else if (location === "front") {
          plannedCenterX = (existingBounds.x0 + existingBounds.x1) / 2;
          plannedCenterY = existingBounds.y0 - groundDepth / 2;
        } else if (location === "side_left") {
          plannedCenterX = existingBounds.x0 - groundWidth / 2;
          plannedCenterY = (existingBounds.y0 + existingBounds.y1) / 2;
        } else {
          plannedCenterX = existingBounds.x1 + groundWidth / 2;
          plannedCenterY = (existingBounds.y0 + existingBounds.y1) / 2;
        }
      }
    }
    // The site plan's placement wins over every default above: the massing has
    // to show the building where the client put it, floor by floor.
    const placedFloors = plannedOriginsFt;
    if (placedFloors?.[0]) {
      plannedCenterX = Number(placedFloors[0].x0) + groundWidth / 2;
      plannedCenterY = Number(placedFloors[0].y0) + groundDepth / 2;
    }
    const addOverflowBox = (rect, z0, z1, floor) => {
      if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return;
      const b00 = { x: rect.x0, y: rect.y0, z: z0 };
      const b10 = { x: rect.x1, y: rect.y0, z: z0 };
      const b11 = { x: rect.x1, y: rect.y1, z: z0 };
      const b01 = { x: rect.x0, y: rect.y1, z: z0 };
      const t00 = { x: rect.x0, y: rect.y0, z: z1 };
      const t10 = { x: rect.x1, y: rect.y0, z: z1 };
      const t11 = { x: rect.x1, y: rect.y1, z: z1 };
      const t01 = { x: rect.x0, y: rect.y1, z: z1 };
      overflowWorldFaces.push(
        { floor, kind: "overflow", world: [b00, b10, t10, t00] },
        { floor, kind: "overflow", world: [b10, b11, t11, t10] },
        { floor, kind: "overflow", world: [b11, b01, t01, t11] },
        { floor, kind: "overflow", world: [b01, b00, t00, t01] },
        { floor, kind: "overflow", world: [t00, t10, t11, t01] }
      );
    };

    completeFloors.forEach((floor, index) => {
      // Each floor sits where the site plan puts it; without a placement it
      // stays concentric with the ground floor, as it always did.
      const placed = placedFloors?.[index];
      const x0 = placed ? Number(placed.x0) : plannedCenterX - floor.widthFt / 2;
      const x1 = x0 + floor.widthFt;
      const y0 = placed ? Number(placed.y0) : plannedCenterY - floor.depthFt / 2;
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
      const middleX0 = Math.max(x0, envelopeBounds.x0);
      const middleX1 = Math.min(x1, envelopeBounds.x1);
      addOverflowBox({ x0, x1: Math.min(x1, envelopeBounds.x0), y0, y1 }, z0, z1, index);
      addOverflowBox({ x0: Math.max(x0, envelopeBounds.x1), x1, y0, y1 }, z0, z1, index);
      addOverflowBox(
        { x0: middleX0, x1: middleX1, y0, y1: Math.min(y1, envelopeBounds.y0) },
        z0,
        z1,
        index
      );
      addOverflowBox(
        { x0: middleX0, x1: middleX1, y0: Math.max(y0, envelopeBounds.y1), y1 },
        z0,
        z1,
        index
      );
      baseHeight = z1;
    });

    const terrainWorldFaces = [];
    if (terrain?.samples?.length === 9) {
      for (let row = 0; row < 2; row += 1) {
        for (let column = 0; column < 2; column += 1) {
          const i = row * 3 + column;
          const cell = [
            terrain.samples[i],
            terrain.samples[i + 1],
            terrain.samples[i + 4],
            terrain.samples[i + 3],
          ].map((sample) => ({ x: sample.x, y: sample.y, z: sample.z }));
          terrainWorldFaces.push(cell);
          boundsWorld.push(...cell);
        }
      }
    }

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
    const envelope = envelopeWorld?.map(project) ?? null;
    const terrainFaces = terrainWorldFaces.map((face) => face.map(project));
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
    const overflowFaces = overflowWorldFaces.map((face) => ({
      ...face,
      projected: face.world.map(project),
    }));

    let dimensions = null;
    if (completeFloors.length > 0) {
      const x0 = plannedCenterX - groundWidth / 2;
      const x1 = x0 + groundWidth;
      const y0 = plannedCenterY - groundDepth / 2;
      const y1 = y0 + groundDepth;
      const additionBaseHeight = verticalAddition ? existingHeight : 0;
      const groundCorners = [
        { x: x0, y: y0, z: additionBaseHeight },
        { x: x1, y: y0, z: additionBaseHeight },
        { x: x1, y: y1, z: additionBaseHeight },
        { x: x0, y: y1, z: additionBaseHeight },
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
      const buildingCenter = project({
        x: x0 + groundWidth / 2,
        y: y0 + groundDepth / 2,
        z: verticalAddition ? existingHeight + plannedHeight / 2 : plannedHeight / 2,
      });
      const width = offsetMeasurement(front.screen, widthNeighbor.screen, buildingCenter);
      const depth = offsetMeasurement(front.screen, depthNeighbor.screen, buildingCenter);
      const heightGround = project({ ...front.world, z: 0 });
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

    return { lot, envelope, terrainFaces, faces, overflowFaces, dimensions, northScreenAngle };
  }, [
    northAngleDeg,
    terrain,
    completeFloors,
    existingBuilding?.location,
    existingBuilding?.position?.x0,
    existingBuilding?.position?.y0,
    existingBuilding?.additionLocation,
    plannedOriginsFt,
    existingDepth,
    existingFootprintSqft,
    existingHeight,
    existingWidth,
    setbacks?.front,
    setbacks?.rear,
    setbacks?.side,
    groundDepth,
    groundWidth,
    lotDepth,
    lotWidth,
    plannedHeight,
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
    ? `${completeFloors.length}-story ${detachedAdu ? "detached ADU" : "house"}, ${groundWidth} feet wide by ${groundDepth} feet deep and ${totalHeight} feet high, inside a ${lotWidth} by ${lotDepth} foot lot. Drag to rotate and scroll to zoom.`
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
        {streetName && (
          <span>Street <strong>{streetName}</strong></span>
        )}
        {terrain && (
          <span>
            Elevation <strong>{fmtNumber(terrain.centerElevationFt)}′</strong>
            {" · "}rise <strong>{fmtNumber(terrain.riseFt)}′</strong>
            {" · "}slope <strong>{fmtNumber(terrain.slopePct)}%</strong>
          </span>
        )}
        {existingFootprintSqft > 0 && (
          <span>Existing footprint <strong>{fmtArea(existingFootprintSqft)} sq ft</strong></span>
        )}
        {completeFloors.length > 0 ? (
          <>
            <span>{detachedAdu ? "ADU width" : "House width"} <strong>{groundWidth}′</strong></span>
            <span>{detachedAdu ? "ADU depth" : "House depth"} <strong>{groundDepth}′</strong></span>
            <span>Total height <strong>{fmtNumber(totalHeight)}′</strong></span>
            {existingFootprintSqft > 0 && (
              <span>
                {verticalAddition ? "New floor height" : detachedAdu ? "ADU height" : "Addition height"}{" "}
                <strong>{fmtNumber(plannedHeight)}′</strong>
              </span>
            )}
            <span>
              Proposed area <strong>{fmtArea(proposedAreaSqft)} sq ft</strong>
            </span>
          </>
        ) : (
          <span className="building-preview-prompt">Enter the number of floors to preview the house.</span>
        )}
      </div>

      {existingFootprintSqft > 0 && (
        <div className="massing-legend" aria-label="3D preview legend">
          <span><i className="existing" />Existing structure</span>
          <span><i className="addition" />{detachedAdu ? "Proposed ADU" : "New addition"}</span>
          {scene.overflowFaces.length > 0 && (
            <span><i className="overflow" />Outside buildable envelope</span>
          )}
        </div>
      )}

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
            // Capture the active gesture before scheduling React's state
            // update. pointer-up can clear drag.current before the updater
            // runs, so reading the ref inside that callback can dereference
            // null during a fast drag/release sequence.
            const activeDrag = drag.current;
            if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
            const dx = event.clientX - activeDrag.x;
            const dy = event.clientY - activeDrag.y;
            setView((current) => ({
              ...current,
              yaw: activeDrag.yaw + dx * 0.45,
              elevation: clamp(activeDrag.elevation - dy * 0.35, MIN_ELEVATION, MAX_ELEVATION),
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
          {scene.terrainFaces.map((face, index) => (
            <polygon
              className={`massing-terrain massing-terrain-${index}`}
              points={points(face)}
              key={`terrain-${index}`}
            />
          ))}
          <polygon className="massing-lot" points={points(scene.lot)} />
          {scene.envelope && <polygon className="massing-envelope" points={points(scene.envelope)} />}
          {streetName && (
            <text
              className="massing-street-label"
              x={(scene.lot[0].x + scene.lot[1].x) / 2}
              y={(scene.lot[0].y + scene.lot[1].y) / 2 + 18}
              textAnchor="middle"
            >
              {streetName} · front
            </text>
          )}
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
          {scene.overflowFaces.map((face, index) => (
            <polygon
              className="massing-face massing-face-overflow"
              points={points(face.projected)}
              key={`overflow-${face.floor}-${index}`}
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

      {parcelGeojson && (
        <p className="terrain-note">
          {terrainStatus === "loading" && "Loading USGS 3DEP terrain…"}
          {terrainStatus === "ready" && (
            <>
              {TERRAIN_SOURCE}: {fmtNumber(terrain.centerElevationFt)}′ at parcel center
              {terrain.resolutionM && <> · {fmtNumber(terrain.resolutionM)} m source resolution</>}.
            </>
          )}
          {terrainStatus === "unavailable" && "USGS 3DEP terrain is temporarily unavailable; showing a level lot."}
          {terrainStatus === "idle" && "Terrain requires a resolved parcel and orientation."}
        </p>
      )}

      {completeFloors.length > 0 && (
        <>
          <ol className="massing-floor-list" aria-label="Planned floor dimensions">
            {completeFloors.map((floor, index) => (
              <li key={index}>
                {verticalAddition
                  ? `Floor ${Math.ceil(existingStories) + index + 1}`
                  : detachedAdu
                    ? `ADU floor ${index + 1}`
                  : index === 0
                    ? "New ground-floor addition"
                    : `Addition floor ${index + 1}`}:{" "}
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
            {verticalAddition
              ? `The new floor begins above the estimated ${fmtNumber(existingHeight)} ft existing structure.`
              : detachedAdu
                ? "The proposed ADU is detached and remains at least 1 ft from the existing structure."
              : `The ground addition is shown ${
                  {
                    side_left: "on the left side of",
                    side_right: "on the right side of",
                    front: "in front of",
                    back: "behind",
                  }[existingBuilding?.additionLocation] || "beside"
                } the existing structure.`}
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
