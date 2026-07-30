"""
WCAG contrast gate for PowerRP themes, read STRAIGHT FROM app.css.

Supersedes themes_contrast.py, which hardcoded each theme's hex values in a
python dict. That is a gate that can pass while the app ships something else:
its `desert` entry already disagreed with the stylesheet (keyed #8a5a0d vs the
shipped #9c3517). Parsing the source of truth removes the drift by construction.

House rule (app.css 14.11 comment): --fg-dim clears 4.3:1 and every chroma token
clears 3.4:1 against BOTH --bg and --a-panel-bg. Themes inherit unset tokens
from :root, so each block is resolved over the :root defaults before checking.

Run with no args.
"""
import re
import sys

CSS = "/Users/ryan/CleanCode/Sandbox/RP_Dumps/PowerRP/SvelteLib/src/demo_apps/PowerRP/web/app.css"

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
    print(f"\n== {name}")
    missing = [t for t in (SURFACES + CHROMA + ("--fg", "--fg-dim")) if t not in resolved]
    if missing:
        print(f"  (not rated, non-hex or unset: {', '.join(missing)})")
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
            print(f"  {tok:14} vs {surf:13} {r:5.2f}{'   << FAIL' if bad else ''}")
    return fails


# ── kind categorization guard (user ruling 2026-07-30): every THEMES entry
# carries kind "dark"|"light", and the label must MATCH the theme's measured
# --bg luminance — a mislabeled theme would silently give the code editor the
# wrong Monaco palette. Parsed textually (app.svelte.js is a rune module, not
# bare-node importable).
import re as _re

def _theme_kinds_from_registry(path=CSS.replace("app.css", "app.svelte.js")):
    """Query. {id: kind} parsed from the THEMES array text.

    >>> isinstance(_theme_kinds_from_registry(), dict)
    True
    """
    src = open(path).read()
    block = _re.search(r"export const THEMES = \[(.*?)\];", src, _re.S).group(1)
    return dict(_re.findall(r'id: "([a-z-]+)", kind: "(dark|light)"', block))

def check_kinds(theme_bgs):
    """Command (asserts). Every theme labeled, every label true to luminance."""
    kinds = _theme_kinds_from_registry()
    failures = []
    for theme, bg in theme_bgs.items():
        expected = "light" if luminance(bg) > 0.35 else "dark"
        got = kinds.get(theme)
        if got is None:
            failures.append(f"{theme}: NO kind in THEMES (bg {bg} reads as {expected})")
        elif got != expected:
            failures.append(f"{theme}: kind '{got}' contradicts --bg {bg} (luminance says {expected})")
    return failures


def main():
    """Command. Prints the table for every theme; exits 1 if any check fails."""
    themes = parse_themes(open(CSS).read())
    base = themes["graphite"]
    all_fails = []
    for name, decls in themes.items():
        resolved = {**base, **decls}  # unset tokens inherit from :root
        all_fails += check(name, resolved)
    all_fails += check_kinds({n: {**base, **d}["--bg"] for n, d in themes.items()})
    print(f"\n{'=' * 60}")
    if all_fails:
        print(f"FAILURES ({len(all_fails)}):")
        for f in all_fails:
            print(f"  {f}")
        sys.exit(1)
    print(f"ALL {len(themes)} THEMES PASS "
          f"(fg-dim >= {FG_DIM_MIN}:1, chroma >= {CHROMA_MIN}:1, vs --bg AND --a-panel-bg)")


if __name__ == "__main__":
    main()
