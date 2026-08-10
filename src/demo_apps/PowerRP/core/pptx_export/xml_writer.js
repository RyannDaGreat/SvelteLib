/**
 * A TINY XML TEXT BUILDER — the write-side counterpart of core/pptx/xml.js's
 * read-side parser. This module does NOT build a DOM and re-serialize it (no
 * writer here needs to query/rewrite an element after creating it — every
 * caller in core/pptx_export/ builds a string bottom-up once); it only
 * guarantees the one thing string-templating XML by hand always gets wrong:
 * ESCAPING. `xmlEscape`/`xmlAttrEscape` are the two functions every other
 * writer in this tree must funnel free text and attribute values through.
 *
 * DOM-FREE, RUNS IN BARE NODE (this app's hard requirement for core/): no
 * XMLSerializer, no DOMParser, just string concatenation.
 */

/**
 * Pure function. Escapes text content for XML: the five characters that are
 * ALWAYS unsafe in element text (`&`, `<`, `>`) — `>` is escaped too, even
 * though only `<`/`&` are strictly required, because `]]>` inside text would
 * otherwise be indistinguishable from a CDATA terminator to some parsers, and
 * escaping `>` universally sidesteps that without needing to detect the
 * three-character sequence specially.
 *
 * @param {string} s
 * @returns {string}
 *
 * @example xmlEscape("a & b < c > d") // "a &amp; b &lt; c &gt; d"
 * @example xmlEscape("plain") // "plain"
 */
export function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Pure function. Escapes a value for placement inside a double-quoted XML
 * attribute: text-escaping plus `"` (the quote character itself) — a `<a:t>`
 * value never needs quote-escaping, but a `name="…"` attribute does whenever
 * the source text (an item's own name/id) happens to contain one.
 *
 * @param {string} s
 * @returns {string}
 *
 * @example xmlAttrEscape('say "hi"') // "say &quot;hi&quot;"
 */
export function xmlAttrEscape(s) {
  return xmlEscape(s).replace(/"/g, "&quot;");
}

/**
 * Pure function. Builds one XML tag's attribute string from a plain object,
 * skipping any key whose value is `null`/`undefined` (the declarative way
 * every writer below omits an optional attribute rather than branching by
 * hand) — every included value is coerced to a string and attribute-escaped.
 *
 * @param {Record<string, string|number|boolean|null|undefined>} attrs
 * @returns {string} a leading-space-prefixed attribute string, or "" if empty
 *
 * @example attrs({a: 1, b: "x\"y", c: null}) // ' a="1" b="x&quot;y"'
 * @example attrs({}) // ""
 */
export function attrs(attrs) {
  let out = "";
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    out += ` ${k}="${xmlAttrEscape(String(v))}"`;
  }
  return out;
}

/**
 * Pure function. One self-closing or content-bearing element as a string.
 * `children` may be a string (already-serialized inner XML, NOT escaped —
 * callers pass nested tag() calls or pre-escaped text) or omitted/null for a
 * self-closing tag.
 *
 * @param {string} name - tag name, e.g. "a:off"
 * @param {Record<string, string|number|boolean|null|undefined>} [attrValues]
 * @param {string|null} [children] - raw inner XML, or null for self-closing
 * @returns {string}
 *
 * @example tag("a:off", {x: 0, y: 0}) // '<a:off x="0" y="0"/>'
 * @example tag("a:t", {}, xmlEscape("hi")) // '<a:t>hi</a:t>'
 * @example tag("a:p", {}, "") // '<a:p></a:p>'
 */
export function tag(name, attrValues = {}, children = null) {
  const a = attrs(attrValues);
  if (children === null) return `<${name}${a}/>`;
  return `<${name}${a}>${children}</${name}>`;
}

/** The standard XML prolog every OOXML part starts with. */
export const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * Pure function. Wraps `bodyXml` with the standard prolog — the one-liner
 * every part builder in this tree ends on.
 *
 * @param {string} bodyXml
 * @returns {string}
 *
 * @example xmlDocument("<a/>") // '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a/>'
 */
export function xmlDocument(bodyXml) {
  return XML_PROLOG + bodyXml;
}
