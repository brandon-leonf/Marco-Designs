import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const FIELD_PATTERNS = [
  {
    key: "front_yard_min_ft",
    label: "Front yard minimum",
    patterns: [
      /(?:minimum\s+)?front\s+(?:yard\s+)?(?:setback|depth|required)?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|['′])?/i,
      /front\s+building\s+line\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
    ],
  },
  {
    key: "rear_yard_min_ft",
    label: "Rear yard minimum",
    patterns: [
      /(?:minimum\s+)?rear\s+(?:yard\s+)?(?:setback|depth|required)?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|['′])?/i,
    ],
  },
  {
    key: "side_yard_one_min_ft",
    label: "One side yard minimum",
    patterns: [
      /(?:minimum\s+)?(?:one|each|single|either|individual)\s+side\s+(?:yard\s+)?(?:setback|width|required)?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|['′])?/i,
      /(?:minimum\s+)?side\s+yard\s*(?:\(?one\)?|each|individual)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
    ],
  },
  {
    key: "side_yard_total_min_ft",
    label: "Combined side yards minimum",
    patterns: [
      /(?:minimum\s+)?(?:combined|total|aggregate|both)\s+side\s+yards?\s*(?:setback|width|required)?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|['′])?/i,
      /side\s+yards?\s*(?:\(?total\)?|combined|aggregate)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
    ],
  },
  {
    key: "min_lot_area_sqft",
    label: "Minimum lot area",
    patterns: [
      /(?:minimum\s+)?lot\s+area\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(?:sq\.?\s*ft|square\s+feet|sf)/i,
    ],
  },
  {
    key: "min_lot_width_ft",
    label: "Minimum lot width",
    patterns: [/(?:minimum\s+)?lot\s+width\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|['′])?/i],
  },
  {
    key: "min_lot_depth_ft",
    label: "Minimum lot depth",
    patterns: [/(?:minimum\s+)?lot\s+depth\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|['′])?/i],
  },
  {
    key: "max_building_coverage_pct",
    label: "Maximum building coverage",
    patterns: [/(?:maximum|max\.?)\s+(?:building|lot)\s+coverage\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*%/i],
  },
  {
    key: "max_impervious_coverage_pct",
    label: "Maximum impervious coverage",
    patterns: [/(?:maximum|max\.?)\s+impervious\s+coverage\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*%/i],
  },
  {
    key: "max_height_ft",
    label: "Maximum building height",
    patterns: [/(?:maximum|max\.?)\s+(?:building\s+)?height\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|['′])?/i],
  },
  {
    key: "max_stories",
    label: "Maximum stories",
    patterns: [/(?:maximum|max\.?)\s+(?:number\s+of\s+)?stor(?:y|ies)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i],
  },
  {
    key: "max_far",
    label: "Maximum FAR",
    patterns: [/(?:maximum|max\.?)\s+(?:floor\s+area\s+ratio|far)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i],
  },
];

function pageText(items) {
  const rows = new Map();
  for (const item of items) {
    const y = Math.round(item.transform?.[5] ?? 0);
    const row = rows.get(y) ?? [];
    row.push({ x: item.transform?.[4] ?? 0, text: item.str });
    rows.set(y, row);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((part) => part.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}

const TABLE_FIELDS = [
  { key: "min_lot_area_sqft", label: "Minimum lot area", header: "Area" },
  { key: "min_lot_width_ft", label: "Minimum lot width", header: "Width" },
  { key: "min_lot_depth_ft", label: "Minimum lot depth", header: "Depth" },
  { key: "front_yard_min_ft", label: "Front yard minimum", header: "Front" },
  { key: "side_yard_one_min_ft", label: "One side yard minimum", header: "(one)" },
  { key: "side_yard_total_min_ft", label: "Combined side yards minimum", header: "(both)" },
  { key: "rear_yard_min_ft", label: "Rear yard minimum", header: "Rear" },
  { key: "max_stories", label: "Maximum stories", header: "Stories" },
  { key: "max_height_ft", label: "Maximum building height", header: "Feet" },
  { key: "max_building_coverage_pct", label: "Maximum building coverage", header: "Building" },
  { key: "max_impervious_coverage_pct", label: "Maximum lot coverage", header: "Lot" },
];

const itemPoint = (item) => ({
  text: item.str.trim(),
  x: item.transform?.[4] ?? 0,
  y: item.transform?.[5] ?? 0,
});

function tableFields(pages, districtCode) {
  const code = districtCode?.trim().toUpperCase();
  if (!code) return [];
  for (const page of pages) {
    const items = page.items.map(itemPoint).filter((item) => item.text);
    const zoneHeader = items
      .filter((item) => item.text.toLowerCase() === "zone")
      .sort((a, b) => b.y - a.y)[0];
    if (!zoneHeader) continue;
    const headers = new Map();
    for (const field of TABLE_FIELDS) {
      const candidates = items.filter((item) => item.text.toLowerCase() === field.header.toLowerCase());
      const header = candidates.sort(
        (a, b) => Math.abs(a.y - zoneHeader.y) - Math.abs(b.y - zoneHeader.y)
      )[0];
      if (header) headers.set(field.key, header);
    }
    if (headers.size < 8) continue;
    const headerY = Math.min(...[...headers.values()].map((item) => item.y));
    const zoneRows = items
      .filter(
        (item) =>
          item.text.toUpperCase() === code &&
          item.y < headerY &&
          Math.abs(item.x - zoneHeader.x) < 35
      )
      .sort((a, b) => b.y - a.y);
    const row = zoneRows[0];
    if (!row) continue;

    const orderedHeaders = TABLE_FIELDS.map((field) => ({
      ...field,
      point: headers.get(field.key),
    })).filter((field) => field.point);
    const findings = [];
    for (let index = 0; index < orderedHeaders.length; index += 1) {
      const field = orderedHeaders[index];
      const previousX = orderedHeaders[index - 1]?.point.x;
      const nextX = orderedHeaders[index + 1]?.point.x;
      const left = previousX == null ? field.point.x - 28 : (previousX + field.point.x) / 2;
      const right = nextX == null ? field.point.x + 28 : (field.point.x + nextX) / 2;
      const cellItems = items
        .filter(
          (item) =>
            item.x >= left &&
            item.x < right &&
            item.y <= row.y + 5 &&
            item.y >= row.y - 18
        )
        .sort((a, b) => a.x - b.x);
      const cellText = cellItems.map((item) => item.text).join(" ");
      const number = cellText.match(/\d[\d,]*(?:\.\d+)?/);
      if (!number) continue;
      const value = Number(number[0].replaceAll(",", ""));
      if (!Number.isFinite(value)) continue;
      findings.push({
        key: field.key,
        label: field.label,
        value,
        page: page.number,
        confidence: "high",
        excerpt: `${code} row · ${field.header}: ${cellText}`,
      });
    }

    const frontHeader = headers.get("front_yard_min_ft");
    if (frontHeader) {
      const prevailing = items.some(
        (item) =>
          /prevailing/i.test(item.text) &&
          Math.abs(item.x - frontHeader.x) < 45 &&
          item.y <= row.y + 5 &&
          item.y >= row.y - 85
      );
      if (prevailing) {
        findings.push({
          key: "front_yard_prevailing_rule",
          label: "Prevailing front yard rule",
          value: true,
          page: page.number,
          confidence: "high",
          excerpt: `${code} row · Front yard uses the prevailing setback rule`,
        });
      }
    }
    if (findings.length) return findings;
  }
  return [];
}

function districtWindows(text, districtCode) {
  const lines = text.split("\n");
  const code = districtCode?.trim();
  if (!code) return [{ text, districtMatched: false }];
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codePattern = new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, "i");
  const matches = lines.flatMap((line, index) => (codePattern.test(line) ? [index] : []));
  if (!matches.length) return [{ text, districtMatched: false }];
  return matches.map((index) => ({
    text: lines.slice(Math.max(0, index - 18), Math.min(lines.length, index + 32)).join("\n"),
    districtMatched: true,
  }));
}

function findFields(pages, districtCode) {
  const found = new Map(tableFields(pages, districtCode).map((field) => [field.key, field]));
  for (const page of pages) {
    for (const window of districtWindows(page.text, districtCode)) {
      for (const field of FIELD_PATTERNS) {
        if (found.has(field.key)) continue;
        for (const pattern of field.patterns) {
          const match = window.text.match(pattern);
          if (!match) continue;
          const value = Number(match[1].replaceAll(",", ""));
          if (!Number.isFinite(value)) continue;
          const start = Math.max(0, match.index - 80);
          const end = Math.min(window.text.length, match.index + match[0].length + 80);
          found.set(field.key, {
            key: field.key,
            label: field.label,
            value,
            page: page.number,
            confidence: window.districtMatched ? "high" : "review",
            excerpt: window.text.slice(start, end).replace(/\n+/g, " · "),
          });
          break;
        }
      }
    }
  }
  return [...found.values()];
}

export async function parseZoningPdf(file, districtCode, onProgress) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    onProgress?.(index, pdf.numPages);
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    pages.push({ number: index, text: pageText(content.items), items: content.items });
  }
  const characterCount = pages.reduce((sum, page) => sum + page.text.length, 0);
  return {
    pageCount: pdf.numPages,
    characterCount,
    fields: findFields(pages, districtCode),
    scanned: characterCount < Math.max(80, pdf.numPages * 20),
  };
}
