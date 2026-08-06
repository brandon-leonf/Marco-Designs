// A small XML reader for KML documents and WFS capabilities.
//
// `DOMParser` would do this in the browser, but the same parsers run under Node
// in `npm run test:gis`, where it does not exist. The subset of XML that GIS
// services emit — elements, attributes, text, CDATA, comments, namespace
// prefixes — is small enough to read directly, and doing so keeps the importer's
// verification script able to exercise exactly the code the browser runs.
//
// Namespace prefixes are stripped from element and attribute names. GIS servers
// are inconsistent about them (`kml:Placemark` vs `Placemark`, `wfs:FeatureType`
// vs `FeatureType`, and every WFS version binds a different URI to `wfs`), and
// no format read here has two meaningful elements whose names differ only by
// prefix.

/**
 * Parse a document into a tree of `{ name, attributes, children, text }`.
 * Throws on the kinds of malformed input that would otherwise be read as an
 * empty document — an operator needs to know the file was rejected, not that it
 * contained no zoning.
 */
export function parseXml(text) {
  const source = stripProlog(String(text));
  const root = { name: "#document", attributes: {}, children: [], text: "" };
  const stack = [root];
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open === -1) break;

    if (open > cursor) {
      const chunk = source.slice(cursor, open);
      if (chunk.trim()) stack[stack.length - 1].text += decodeEntities(chunk);
    }

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open);
      const raw = source.slice(open + 9, end === -1 ? source.length : end);
      // CDATA is literal by definition, so it is not entity-decoded.
      stack[stack.length - 1].text += raw;
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", open) || source.startsWith("<!", open)) {
      const end = source.indexOf(">", open);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }

    const close = findTagEnd(source, open);
    if (close === -1) break;
    const tag = source.slice(open + 1, close);
    cursor = close + 1;

    if (tag.startsWith("/")) {
      const name = localName(tag.slice(1).trim());
      // Close the innermost matching element. A stray end tag that matches
      // nothing is ignored rather than unwinding the whole document.
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameMatch = body.match(/^[^\s/>]+/);
    if (!nameMatch) continue;

    const node = {
      name: localName(nameMatch[0]),
      attributes: parseAttributes(body.slice(nameMatch[0].length)),
      children: [],
      text: "",
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (root.children.length === 0) {
    throw new Error("This file contains no XML elements.");
  }
  return root;
}

/** Direct children with the given local name. */
export function childrenNamed(node, name) {
  return (node?.children ?? []).filter((child) => child.name === name);
}

/** First direct child with the given local name, or null. */
export function childNamed(node, name) {
  return (node?.children ?? []).find((child) => child.name === name) ?? null;
}

/** Every descendant with the given local name, in document order. */
export function findAll(node, name, into = []) {
  for (const child of node?.children ?? []) {
    if (child.name === name) into.push(child);
    findAll(child, name, into);
  }
  return into;
}

/** Text content of a named child, trimmed, or null when absent or empty. */
export function textOf(node, name) {
  const child = name ? childNamed(node, name) : node;
  const value = String(child?.text ?? "").trim();
  return value || null;
}

function findTagEnd(source, open) {
  // Attribute values may contain ">", so the scan has to respect quoting.
  let quote = "";
  for (let index = open + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function parseAttributes(text) {
  const attributes = {};
  const pattern = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(text);
  while (match) {
    attributes[localName(match[1])] = decodeEntities(match[3] ?? match[4] ?? "");
    match = pattern.exec(text);
  }
  return attributes;
}

function localName(name) {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function stripProlog(text) {
  // A UTF-8 BOM survives TextDecoder and would be read as document content.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decodeEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return named[entity] ?? whole;
  });
}
