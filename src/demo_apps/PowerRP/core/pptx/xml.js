/**
 * A SMALL, STRICT, NAMESPACE-AWARE XML PARSER — no DOMParser (must run in bare
 * node), no external XML dependency (the app CLAUDE.md's "no invented limits,
 * no silent fallbacks" applies here as much as anywhere: a `DOMParser`-based
 * parser would work in the browser and silently not exist in `node
 * cli/render.js`-style bare-node contexts, which is exactly the two-runtime
 * requirement this whole importer is built against).
 *
 * WHAT IT PARSES: elements, attributes, text content, CDATA, comments (skipped),
 * the XML prolog (skipped), and self-closing tags. Namespaces are resolved to
 * their URI, not left as prefixes — `<p:sp>` becomes `{uri:
 * "http://schemas.openxmlformats.org/presentationml/2006/main", local: "sp"}`,
 * because OOXML readers must not care which prefix an author's tool happened to
 * pick (`mc:Fallback` in this deck's own files sets `xmlns=""` partway through a
 * document, and `p159:` for the 2015 morph extension is a prefix chosen by
 * PowerPoint itself, not a spec constant) — see xmlNodeName's doctest.
 *
 * WHAT IT DOES NOT DO: no DTD/entity expansion beyond the five predefined XML
 * entities (`&lt; &gt; &amp; &apos; &quot;`) plus numeric character references
 * (`&#39; &#x27;`), no processing instructions beyond skipping them, no
 * validation against a schema. A `.pptx` part is trusted-ish (it came from a
 * zip the caller opened) but the loud-failure rule still applies: malformed XML
 * throws with a real message (line/column), never silently drops content.
 *
 * OUTPUT SHAPE — every element node:
 *   {
 *     type: "element",
 *     ns: string | null,       // resolved namespace URI, or null if unprefixed
 *                                // with no default xmlns in scope
 *     local: string,            // local name, e.g. "sp"
 *     name: string,             // "ns_uri#local" or just "local" — a stable key
 *     attrs: [{ns, local, name, value}],  // namespaced the same way
 *     children: Node[],         // element and text nodes, document order
 *   }
 * Text nodes: { type: "text", value: string }.
 *
 * WHY A NODE LIST, NOT A SINGLE ".text" STRING: OOXML text runs
 * (`<a:t>text</a:t>`) are simple, but this parser is generic — it does not
 * special-case any element. Callers needing "the text of this element" use
 * `xmlText(node)`.
 */

const PREDEFINED_ENTITIES = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

/**
 * Pure function. Decode XML entity/character references in text content or an
 * attribute value. Throws on an unknown named entity (OOXML never legitimately
 * uses a custom DTD entity; an unknown one means the byte stream is not the XML
 * this parser is contracted to read).
 *
 * @param {string} raw - text between decode boundaries (already isolated by the tokenizer)
 * @returns {string}
 *
 * @example decodeXmlEntities("a &amp; b") // "a & b"
 * @example decodeXmlEntities("&#39;") // "'"
 * @example decodeXmlEntities("&#x2013;") // "–"
 */
export function decodeXmlEntities(raw) {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint)) throw new Error(`malformed numeric character reference: ${JSON.stringify(whole)}`);
      return String.fromCodePoint(codePoint);
    }
    if (body in PREDEFINED_ENTITIES) return PREDEFINED_ENTITIES[body];
    throw new Error(`unknown XML entity &${body}; — this parser only decodes the five predefined entities plus numeric character references`);
  });
}

/**
 * Pure function. Line and column (1-based) of a character offset in `text`,
 * for error messages that point at the actual malformed byte.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{line: number, column: number}}
 *
 * @example lineColumnAt("ab\ncd", 3) // {line: 2, column: 1}
 */
export function lineColumnAt(text, offset) {
  let line = 1, lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") { line++; lastNl = i; }
  }
  return { line, column: offset - lastNl };
}

/** Tokenizer: walks raw XML text, yielding open/close/self-close tags, text
 * runs, comments, CDATA and the prolog/PIs, with byte offsets for errors. Not
 * exported — internal to parseXml's single pass. */
function* tokenize(xmlText) {
  let i = 0;
  const n = xmlText.length;
  while (i < n) {
    if (xmlText[i] !== "<") {
      const next = xmlText.indexOf("<", i);
      const end = next === -1 ? n : next;
      yield { kind: "text", raw: xmlText.slice(i, end), offset: i };
      i = end;
      continue;
    }
    if (xmlText.startsWith("<?", i)) {
      const end = xmlText.indexOf("?>", i);
      if (end === -1) throw new Error(`unterminated processing instruction at ${JSON.stringify(lineColumnAt(xmlText, i))}`);
      i = end + 2;
      continue;
    }
    if (xmlText.startsWith("<!--", i)) {
      const end = xmlText.indexOf("-->", i);
      if (end === -1) throw new Error(`unterminated comment at ${JSON.stringify(lineColumnAt(xmlText, i))}`);
      i = end + 3;
      continue;
    }
    if (xmlText.startsWith("<![CDATA[", i)) {
      const end = xmlText.indexOf("]]>", i);
      if (end === -1) throw new Error(`unterminated CDATA section at ${JSON.stringify(lineColumnAt(xmlText, i))}`);
      yield { kind: "cdata", raw: xmlText.slice(i + 9, end), offset: i };
      i = end + 3;
      continue;
    }
    if (xmlText.startsWith("<!", i)) {
      // DOCTYPE or other markup declaration — skip to matching '>'. OOXML parts
      // never carry these, but skipping (not refusing) keeps the parser generic.
      const end = xmlText.indexOf(">", i);
      if (end === -1) throw new Error(`unterminated markup declaration at ${JSON.stringify(lineColumnAt(xmlText, i))}`);
      i = end + 1;
      continue;
    }
    if (xmlText.startsWith("</", i)) {
      const end = xmlText.indexOf(">", i);
      if (end === -1) throw new Error(`unterminated close tag at ${JSON.stringify(lineColumnAt(xmlText, i))}`);
      yield { kind: "close", raw: xmlText.slice(i + 2, end).trim(), offset: i };
      i = end + 1;
      continue;
    }
    // Open or self-closing tag. Find the matching unquoted '>'.
    let j = i + 1;
    let inQuote = null;
    while (j < n) {
      const c = xmlText[j];
      if (inQuote) {
        if (c === inQuote) inQuote = null;
      } else if (c === '"' || c === "'") {
        inQuote = c;
      } else if (c === ">") {
        break;
      }
      j++;
    }
    if (j >= n) throw new Error(`unterminated tag starting at ${JSON.stringify(lineColumnAt(xmlText, i))}`);
    const inner = xmlText.slice(i + 1, j);
    const selfClose = inner.endsWith("/");
    yield { kind: selfClose ? "selfclose" : "open", raw: (selfClose ? inner.slice(0, -1) : inner).trim(), offset: i };
    i = j + 1;
  }
}

/** Split a tag's inner text into {tagName, attrs: [{name, value}]}, honoring
 * quoted attribute values. Not exported. */
function parseTagInner(inner, xmlText, offset) {
  const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m = attrRe.exec(inner);
  const firstSpace = inner.search(/\s/);
  const tagName = (firstSpace === -1 ? inner : inner.slice(0, firstSpace)).trim();
  if (!tagName) throw new Error(`empty tag name at ${JSON.stringify(lineColumnAt(xmlText, offset))}`);
  const attrs = [];
  const seen = new Set();
  // Attribute-name validity + duplicate check via a scan that also catches
  // stray non-attribute text (malformed tags), not just accept whatever regex matched.
  const rest = firstSpace === -1 ? "" : inner.slice(firstSpace).trim();
  let consumed = 0;
  attrRe.lastIndex = 0;
  const scanned = [];
  while ((m = attrRe.exec(rest))) {
    scanned.push(m);
  }
  // Validate the whole `rest` is covered by matched attrs (allowing whitespace between).
  let cursor = 0;
  for (const match of scanned) {
    const gap = rest.slice(cursor, match.index);
    if (gap.trim() !== "") throw new Error(`malformed attribute syntax near ${JSON.stringify(gap)} at ${JSON.stringify(lineColumnAt(xmlText, offset))}`);
    const name = match[1];
    const value = match[3] !== undefined ? match[3] : match[4];
    if (seen.has(name)) throw new Error(`duplicate attribute "${name}" at ${JSON.stringify(lineColumnAt(xmlText, offset))}`);
    seen.add(name);
    attrs.push({ name, value: decodeXmlEntities(value) });
    cursor = match.index + match[0].length;
  }
  const tail = rest.slice(cursor);
  if (tail.trim() !== "") throw new Error(`malformed attribute syntax near ${JSON.stringify(tail)} at ${JSON.stringify(lineColumnAt(xmlText, offset))}`);
  return { tagName, attrs };
}

/** Resolve a possibly-prefixed name against the namespace scope stack (array of
 * {prefixes: Map<prefix,uri>, defaultUri: string|null}, innermost last). Not exported. */
function resolveName(qualifiedName, scopes) {
  const colon = qualifiedName.indexOf(":");
  if (colon === -1) {
    for (let k = scopes.length - 1; k >= 0; k--) {
      // `xmlns=""` (a real construct in this app's own real deck — mc:Fallback
      // resets the default namespace mid-document) sets defaultUri to the empty
      // string, which means "no namespace" — normalized to `null` here so it
      // matches every OTHER "no namespace" representation this parser uses
      // (an element with no default xmlns in scope at all, an unprefixed
      // attribute). Without this, `ns: ""` vs `ns: null` would be two
      // different spellings of the same thing and every xmlChild(node, null, …)
      // caller would silently stop matching under a reset scope.
      if (scopes[k].defaultUri !== undefined) return { ns: scopes[k].defaultUri === "" ? null : scopes[k].defaultUri, local: qualifiedName };
    }
    return { ns: null, local: qualifiedName };
  }
  const prefix = qualifiedName.slice(0, colon);
  const local = qualifiedName.slice(colon + 1);
  if (prefix === "xml") return { ns: "http://www.w3.org/XML/1998/namespace", local };
  for (let k = scopes.length - 1; k >= 0; k--) {
    if (scopes[k].prefixes.has(prefix)) return { ns: scopes[k].prefixes.get(prefix), local };
  }
  throw new Error(`unbound namespace prefix "${prefix}:" on "${qualifiedName}" — no xmlns:${prefix} declaration is in scope`);
}

/** {ns, local} -> a stable map/lookup key. Not exported (xmlNodeName is the
 * public doctest-bearing wrapper used by callers). */
function nodeKey(ns, local) {
  return ns ? `${ns}#${local}` : local;
}

/**
 * Pure function. The stable lookup key for a resolved element/attribute name —
 * what callers match against (`node.name === P_NS + "#sp"` style helpers build
 * on this). Namespace-URI-based, never prefix-based, because a document may
 * legally use a different prefix for the same URI than another document does
 * (this deck's own `p159:morph` is PowerPoint's own prefix choice for the 2015
 * transitions namespace — a reader keyed on the literal string "p159" would
 * break on a document that imported the same namespace as, say, "morph159").
 *
 * @param {string|null} ns - resolved namespace URI, or null if unprefixed/no default
 * @param {string} local - local (unprefixed) name
 * @returns {string}
 *
 * @example xmlNodeName("http://schemas.openxmlformats.org/presentationml/2006/main", "sp") // "http://schemas.openxmlformats.org/presentationml/2006/main#sp"
 * @example xmlNodeName(null, "sp") // "sp"
 */
export function xmlNodeName(ns, local) {
  return nodeKey(ns, local);
}

/**
 * Parse an XML document (string) into the node tree described in this file's
 * header. Throws with a line/column-bearing message on any malformed input —
 * unterminated tags, mismatched close tags, unbound namespace prefixes,
 * duplicate attributes, unknown entities. Never returns a partial tree.
 *
 * @param {string} xmlText - the full XML document text
 * @returns {{type: "element", ns: string|null, local: string, name: string, attrs: object[], children: object[]}}
 *
 * @example
 * >>> parseXml('<a:sp xmlns:a="urn:x"><a:nv>1</a:nv></a:sp>').local
 * "sp"
 * @example
 * >>> parseXml('<a:sp xmlns:a="urn:x"><a:nv>1</a:nv></a:sp>').children[0].children[0].value
 * "1"
 * @example
 * >>> parseXml('<a xmlns="urn:d"><b/></a>').children[0].ns
 * "urn:d"
 */
export function parseXml(xmlText) {
  if (typeof xmlText !== "string") throw new Error(`parseXml expects a string, got ${typeof xmlText}`);
  const stack = []; // {node, scope}
  let root = null;
  const baseScope = { prefixes: new Map([["xml", "http://www.w3.org/XML/1998/namespace"]]) };
  let scopes = [baseScope];

  const openElement = (tagName, attrs, offset, selfClosing) => {
    // Build this element's namespace scope FIRST (xmlns declarations on the
    // element apply to the element's own tag name and its attributes).
    const prefixes = new Map();
    let defaultUri; // undefined = inherit; string ("" allowed) = override
    for (const a of attrs) {
      if (a.name === "xmlns") defaultUri = a.value; // may be "" to RESET the default (mc:Fallback in real decks does this)
      else if (a.name.startsWith("xmlns:")) prefixes.set(a.name.slice(6), a.value);
    }
    const scope = { prefixes, defaultUri };
    scopes = [...scopes, scope];

    const { ns, local } = resolveName(tagName, scopes);
    const resolvedAttrs = attrs
      .filter((a) => a.name !== "xmlns" && !a.name.startsWith("xmlns:"))
      .map((a) => {
        // Unprefixed attributes NEVER take the default namespace (XML Namespaces
        // spec, §5.2) — only element names and explicitly prefixed attributes do.
        const colon = a.name.indexOf(":");
        const resolved = colon === -1 ? { ns: null, local: a.name } : resolveName(a.name, scopes);
        return { ns: resolved.ns, local: resolved.local, name: nodeKey(resolved.ns, resolved.local), value: a.value };
      });
    const node = { type: "element", ns, local, name: nodeKey(ns, local), attrs: resolvedAttrs, children: [] };
    if (stack.length === 0) {
      if (root !== null) throw new Error(`multiple root elements — second root "<${tagName}>" at ${JSON.stringify(lineColumnAt(xmlText, offset))}`);
      root = node;
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    if (!selfClosing) stack.push({ node, tagName, offset });
    else scopes = scopes.slice(0, -1); // pop the scope we just pushed; nothing inside a self-closed element
  };

  for (const tok of tokenize(xmlText)) {
    if (tok.kind === "text" || tok.kind === "cdata") {
      const value = tok.kind === "cdata" ? tok.raw : decodeXmlEntities(tok.raw);
      if (tok.kind === "cdata" || value.trim() !== "") {
        if (stack.length === 0) {
          if (value.trim() !== "") throw new Error(`text content outside the root element at ${JSON.stringify(lineColumnAt(xmlText, tok.offset))}`);
          continue;
        }
        stack[stack.length - 1].node.children.push({ type: "text", value });
      }
      continue;
    }
    if (tok.kind === "open" || tok.kind === "selfclose") {
      const { tagName, attrs } = parseTagInner(tok.raw, xmlText, tok.offset);
      openElement(tagName, attrs, tok.offset, tok.kind === "selfclose");
      continue;
    }
    if (tok.kind === "close") {
      if (stack.length === 0) throw new Error(`close tag "</${tok.raw}>" with no matching open tag at ${JSON.stringify(lineColumnAt(xmlText, tok.offset))}`);
      const top = stack.pop();
      const expected = top.tagName;
      if (expected !== tok.raw) throw new Error(`mismatched close tag: expected "</${expected}>", found "</${tok.raw}>" at ${JSON.stringify(lineColumnAt(xmlText, tok.offset))}`);
      scopes = scopes.slice(0, -1);
      continue;
    }
  }
  if (stack.length > 0) throw new Error(`unclosed element "<${stack[stack.length - 1].tagName}>" opened at ${JSON.stringify(lineColumnAt(xmlText, stack[stack.length - 1].offset))}`);
  if (root === null) throw new Error("empty document: no root element found");
  return root;
}

/**
 * Pure function. The concatenated text content of an element's direct + nested
 * text nodes, in document order — the "innerText" of an XML node.
 *
 * @param {object} node - an element node from parseXml
 * @returns {string}
 *
 * @example xmlText(parseXml("<a:t xmlns:a='urn:x'>hello</a:t>")) // "hello"
 * @example xmlText(parseXml("<a xmlns='urn:x'><b>x</b><b>y</b></a>")) // "xy"
 */
export function xmlText(node) {
  let out = "";
  for (const child of node.children) {
    if (child.type === "text") out += child.value;
    else if (child.type === "element") out += xmlText(child);
  }
  return out;
}

/**
 * Pure function. The direct element children of `node` matching namespace
 * `ns` and local name `local` (not recursive — see xmlFindAll for that).
 *
 * @param {object} node
 * @param {string|null} ns
 * @param {string} local
 * @returns {object[]}
 *
 * @example xmlChildren(parseXml("<a xmlns='urn:x'><b/><b/><c/></a>"), "urn:x", "b").length // 2
 */
export function xmlChildren(node, ns, local) {
  return node.children.filter((c) => c.type === "element" && c.ns === ns && c.local === local);
}

/**
 * Pure function. The first direct element child of `node` matching namespace
 * `ns` and local name `local`, or null if none.
 *
 * @param {object} node
 * @param {string|null} ns
 * @param {string} local
 * @returns {object|null}
 *
 * @example xmlChild(parseXml("<a xmlns='urn:x'><b>1</b></a>"), "urn:x", "b") && "found"
 * "found"
 * @example xmlChild(parseXml("<a xmlns='urn:x'></a>"), "urn:x", "b")
 * null
 */
export function xmlChild(node, ns, local) {
  return node.children.find((c) => c.type === "element" && c.ns === ns && c.local === local) ?? null;
}

/**
 * Pure function. Every descendant element (at any depth, document order,
 * pre-order/self excluded... actually includes self if it matches) matching
 * namespace `ns` and local name `local`. Used sparingly — most OOXML walking
 * in this codebase should be explicit about depth (a `p:sp` inside a `p:grpSp`
 * inside another `p:grpSp` needs depth-aware handling for chOff/chExt, not a
 * flat findAll) but this is useful for one-off lookups like `custGeom`.
 *
 * @param {object} node
 * @param {string|null} ns
 * @param {string} local
 * @returns {object[]}
 *
 * @example xmlFindAll(parseXml("<a xmlns='urn:x'><b><c/></b><c/></a>"), "urn:x", "c").length // 2
 */
export function xmlFindAll(node, ns, local) {
  const out = [];
  const walk = (n) => {
    if (n.type !== "element") return;
    if (n.ns === ns && n.local === local) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

/**
 * Pure function. An attribute's value by namespace + local name, or `fallback`
 * (default `undefined`) if absent.
 *
 * @param {object} node
 * @param {string|null} ns
 * @param {string} local
 * @param {*} [fallback]
 * @returns {string|*}
 *
 * @example xmlAttr(parseXml("<a xmlns='urn:x' n='5'/>"), null, "n") // "5"
 * @example xmlAttr(parseXml("<a xmlns='urn:x'/>"), null, "missing", "default") // "default"
 */
export function xmlAttr(node, ns, local, fallback = undefined) {
  const found = node.attrs.find((a) => a.ns === ns && a.local === local);
  return found ? found.value : fallback;
}
