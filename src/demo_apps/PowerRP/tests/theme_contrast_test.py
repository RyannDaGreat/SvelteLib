"""
WCAG contrast gate for PowerRP themes, read STRAIGHT FROM app.css.

Supersedes themes_contrast.py, which hardcoded each theme's hex values in a
python dict. That is a gate that can pass while the app ships something else:
its `desert` entry already disagreed with the stylesheet (keyed #8a5a0d vs the
shipped #9c3517). Parsing the source of truth removes the drift by construction.

House rule (app.css 14.11 comment): --fg-dim clears 4.3:1 and every chroma token
clears 3.4:1 against BOTH --bg and --a-panel-bg. Themes inherit unset tokens
from :root, so each block is resolved over the :root defaults before checking.

Run with no args; pass -v/--verbose for the full per-theme ratio table (a
failing theme prints its table either way — that is where the diagnosis is).
"""
import os
import re
import sys

VERBOSE = any(a in ("-v", "--verbose") for a in sys.argv[1:])

# Resolved from THIS file, never from the cwd and never absolute: the dump is
# portable and may be renamed or moved at any time. This gate previously
# hardcoded an absolute path from a different machine, so it raised
# FileNotFoundError on every other checkout while run_all.mjs still collected it
# -- a green suite that had never once parsed a stylesheet. Same shape as
# tests/frames_endpoint_test.py:45 and tests/asset_thumbnail_test.py:31.
HERE = os.path.dirname(os.path.abspath(__file__))
CSS = os.path.join(HERE, "..", "web", "app.css")
assert os.path.isfile(CSS), f"stylesheet under test is missing: {CSS}"

FG_DIM_MIN = 4.3   # smallest-text token
CHROMA_MIN = 3.4   # graphical/accent tokens
CHROMA = ("--a-selection", "--a-guide", "--a-keyed", "--a-anchor", "--a-modifier", "--accent")
SURFACES = ("--bg", "--a-panel-bg")


def srgb_to_lin(c):
    """
    Pure function. One 0-255 sRGB channel -> linear-light 0..1 (WCAG formula).

    Args:
        c (int): channel value 0-255

    Returns:
        float

    Examples:
        >>> round(srgb_to_lin(255), 4)
        1.0
        >>> round(srgb_to_lin(128), 4)
        0.2159
    """
    s = c / 255
    return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4


def luminance(hexcolor):
    """
    Pure function. WCAG relative luminance of a #rgb or #rrggbb string.

    Args:
        hexcolor (str): "#rrggbb" or shorthand "#rgb"

    Returns:
        float: 0 (black) .. 1 (white)

    Examples:
        >>> round(luminance("#ffffff"), 3)
        1.0
        >>> round(luminance("#000000"), 3)
        0.0
        >>> round(luminance("#0a0f0a"), 4)
        0.0043
    """
    h = hexcolor.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * srgb_to_lin(r) + 0.7152 * srgb_to_lin(g) + 0.0722 * srgb_to_lin(b)


def ratio(a, b):
    """
    Pure function. WCAG contrast ratio between two hex colors (1..21).

    Args:
        a (str): "#rrggbb"
        b (str): "#rrggbb"

    Returns:
        float

    Examples:
        >>> round(ratio("#ffffff", "#000000"), 1)
        21.0
        >>> round(ratio("#4ae04a", "#0a0f0a"), 1)
        11.1
    """
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def parse_themes(css):
    """
    Query (reads a stylesheet string). Extracts {theme: {token: value}} for
    :root and every :root[data-theme=...] block, keeping only plain hex values
    (a gradient or rgba() is not a <color> this gate can rate).

    Args:
        css (str): the full app.css text

    Returns:
        dict[str, dict[str, str]]: "graphite" is the :root block

    Examples:
        >>> t = parse_themes(':root {\\n  --bg: #111;\\n}\\n'
        ...                  ':root[data-theme="x"] {\\n  --bg: #eee;\\n}\\n')
        >>> t["graphite"]["--bg"], t["x"]["--bg"]
        ('#111', '#eee')
    """
    out = {}
    root = re.search(r"^:root \{(.*?)^\}", css, re.S | re.M)
    if not root:
        raise RuntimeError("app.css has no :root block — the gate cannot resolve inherited tokens")
    blocks = [("graphite", root.group(1))]
    blocks += [(m.group(1), m.group(2))
               for m in re.finditer(r'^:root\[data-theme="([\w-]+)"\] \{(.*?)^\}', css, re.S | re.M)]
    for name, body in blocks:
        decls = {}
        for tok, val in re.findall(r"(--[\w-]+):\s*([^;]+);", body):
            val = val.strip()
            if re.fullmatch(r"#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?", val):
                decls[tok] = val
        out[name] = decls
    return out


def check(name, resolved):
    """
    Query. Prints one theme's pass/fail table. Returns the list of failure
    strings (empty = the theme passes).
    """
    fails = []
    lines = []
    missing = [t for t in (SURFACES + CHROMA + ("--fg", "--fg-dim")) if t not in resolved]
    if missing:
        lines.append(f"  (not rated, non-hex or unset: {', '.join(missing)})")
    for surf in SURFACES:
        if surf not in resolved:
            continue
        sv = resolved[surf]
        for tok, floor in [("--fg", None), ("--fg-dim", FG_DIM_MIN)] + [(c, CHROMA_MIN) for c in CHROMA]:
            if tok not in resolved:
                continue
            r = ratio(resolved[tok], sv)
            bad = floor is not None and r < floor
            if bad:
                fails.append(f"{name}: {tok} vs {surf} = {r:.2f} (< {floor})")
            lines.append(f"  {tok:14} vs {surf:13} {r:5.2f}{'   << FAIL' if bad else ''}")
    # The full 16-row table per theme is 640 lines across 40 themes, which buries
    # the verdict it exists to support. Printed only when the theme FAILS (where
    # the numbers are the diagnosis) or when asked for explicitly.
    if fails or VERBOSE:
        print(f"\n== {name}")
        print("\n".join(lines))
    return fails


# ── THE FAMILY GUARD (user ruling 2026-07-30, verbatim: "We can structurally
# make sure every theme has a dark/light variant") — this section IS that
# structure. The registry pairs every theme into a FAMILY with one dark and one
# light member; the toggle flips between them. Four things can rot, and each is
# checked below rather than trusted:
#   1. a family missing a pole      → the toggle would have nowhere to go
#   2. a family with two same-kind  → the toggle would flip to the same pole
#   3. a slot contradicting reality → a "light" member whose --bg is dark, which
#      would hand Monaco the wrong palette AND draw the wrong toggle glyph
#   4. a member with no CSS block   → data-theme set to a name nothing styles,
#      i.e. the :root defaults silently wearing another theme's name
# Parsed textually (app.svelte.js is a rune module, not bare-node importable).
import re as _re

LIGHT_LUMINANCE_MIN = 0.35  # above this a --bg is a light surface, below it dark


def _families_from_registry(path=CSS.replace("app.css", "app.svelte.js")):
    """
    Query (reads app.svelte.js). Parses THEME_FAMILIES into
    [(family_id, dark_id, light_id)].

    Returns:
        list[tuple[str, str, str]]

    Examples:
        >>> fams = _families_from_registry()
        >>> ("ember", "ember", "ember-light") in fams
        True
        >>> all(len(f) == 3 for f in fams)
        True
    """
    src = open(path).read()
    block = _re.search(r"export const THEME_FAMILIES = \[(.*?)^\];", src, _re.S | _re.M)
    if not block:
        raise RuntimeError("app.svelte.js has no THEME_FAMILIES array — the family gate cannot run")
    return _re.findall(
        r'\{\s*id:\s*"([\w-]+)",\s*title:\s*"[^"]*",\s*dark:\s*"([\w-]+)",\s*light:\s*"([\w-]+)"\s*\}',
        block.group(1),
    )


def check_families(theme_bgs):
    """
    Query. Enforces the family contract against MEASURED --bg luminance.
    Returns a list of failure strings (empty = the structure holds).

    Args:
        theme_bgs (dict[str, str]): {theme id: resolved --bg hex} for every
            `:root[data-theme=…]` block found in app.css, plus "graphite" for
            the :root block itself.

    Returns:
        list[str]

    Examples:
        >>> # a family whose "light" slot holds a theme with a DARK --bg fails
        >>> check_families({"ember": "#17120f", "ember-light": "#111111"})[0]
        "ember: light member 'ember-light' has --bg #111111, which measures dark"
    """
    failures = []
    families = _families_from_registry()
    paired = set()
    for fam, dark_id, light_id in families:
        for slot, tid in (("dark", dark_id), ("light", light_id)):
            paired.add(tid)
            bg = theme_bgs.get(tid)
            if bg is None:
                failures.append(f"{fam}: {slot} member '{tid}' has NO :root[data-theme] block in app.css")
                continue
            measured = "light" if luminance(bg) > LIGHT_LUMINANCE_MIN else "dark"
            if measured != slot:
                failures.append(f"{fam}: {slot} member '{tid}' has --bg {bg}, which measures {measured}")
        if dark_id == light_id:
            failures.append(f"{fam}: both poles are the same theme '{dark_id}' — the toggle would be a no-op")
    # Rule 4's converse: a styled theme nobody's family claims is unreachable by
    # the toggle and invisible in a family-grouped picker.
    for tid in theme_bgs:
        if tid not in paired:
            failures.append(f"{tid}: has a CSS block but belongs to NO family (unreachable by the dark/light toggle)")
    # A theme id may not sit in two families, or the sibling lookup is ambiguous.
    seen = {}
    for fam, dark_id, light_id in families:
        for tid in (dark_id, light_id):
            if tid in seen:
                failures.append(f"{tid}: claimed by BOTH families '{seen[tid]}' and '{fam}'")
            seen[tid] = fam
    return failures


# ── STRUCTURAL TOKENS (user ruling 2026-07-31, verbatim: "the height of a bar
# in the command palette should be the same thing regardless of theme. Theme
# does not control that. It's one of the few things themes are not allowed to
# control.") — geometry the reader navigates by is not paint: the palette
# previews themes LIVE as you browse, so a font-metric-driven row height would
# jitter the very list being read. A theme block redefining one of these
# tokens fails the gate BY NAME. The list grows only by explicit user ruling.
STRUCTURAL_TOKENS = ["--a-palette-row-h", "--a-palette-crumbs-h", "--a-palette-input-h"]


def check_structural_tokens(css):
    """
    Pure function. Failure strings for any :root[data-theme] block that
    redefines a structural (theme-forbidden) token.

    Args:
        css (str): full app.css text

    Returns:
        list[str]

    Examples:
        >>> check_structural_tokens(':root[data-theme="x"] {\\n  --bg: #eee;\\n}\\n')
        []
        >>> check_structural_tokens(':root[data-theme="x"] {\\n  --a-palette-row-h: 40px;\\n}\\n')
        ['x: redefines STRUCTURAL token --a-palette-row-h (themes are not allowed to control it)']
    """
    fails = []
    for m in _re.finditer(r'^:root\[data-theme="([\w-]+)"\] \{(.*?)^\}', css, _re.S | _re.M):
        for tok in STRUCTURAL_TOKENS:
            if _re.search(tok + r"\s*:", m.group(2)):
                fails.append(f"{m.group(1)}: redefines STRUCTURAL token {tok} (themes are not allowed to control it)")
    return fails


def main():
    """Command. Prints the table for every theme; exits 1 if any check fails."""
    css_text = open(CSS).read()
    themes = parse_themes(css_text)
    base = themes["graphite"]
    all_fails = []
    for name, decls in themes.items():
        resolved = {**base, **decls}  # unset tokens inherit from :root
        all_fails += check(name, resolved)
    family_fails = check_families({n: {**base, **d}["--bg"] for n, d in themes.items()})
    all_fails += family_fails
    all_fails += check_structural_tokens(css_text)
    families = _families_from_registry()
    print(f"\n{'=' * 60}")
    print(f"FAMILY STRUCTURE: {len(families)} families, {len(themes)} themes")
    for fam, dark_id, light_id in families:
        print(f"  {fam:12} dark={dark_id:18} light={light_id}")
    if all_fails:
        print(f"\nFAILURES ({len(all_fails)}):")
        for f in all_fails:
            print(f"  {f}")
        sys.exit(1)
    print(f"\nALL {len(themes)} THEMES PASS "
          f"(fg-dim >= {FG_DIM_MIN}:1, chroma >= {CHROMA_MIN}:1, vs --bg AND --a-panel-bg)")
    print(f"ALL {len(families)} FAMILIES PASS "
          f"(both poles present, each member's slot matches its measured --bg)")
    print(f"STRUCTURAL TOKENS UNTOUCHED BY EVERY THEME ({', '.join(STRUCTURAL_TOKENS)})")


if __name__ == "__main__":
    main()
