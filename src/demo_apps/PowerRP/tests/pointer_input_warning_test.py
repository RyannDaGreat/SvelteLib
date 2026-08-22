# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1"]
# ///
"""
THE CROSS-LANGUAGE GATE for the ambient pointer's export warning (manifest R7-24).

server.py has to know which equation keywords mean "this deck reads the pointer", and
it cannot import core/pointer_input.js to find out -- so POINTER_INPUT_KEYWORDS is a
MIRROR, which is the drift this codebase pays for everywhere it appears. This gate is
the price of the mirror: it parses the JavaScript source of truth and fails if the two
lists ever disagree, so a fourth keyword cannot ship with an export that silently stops
warning about it.

It also runs server.py's own doctests for the warning functions, which are the
specification of what the warning says and when.

Run with no args, the same command tests/run_all.mjs uses:
    uv run tests/pointer_input_warning_test.py

The PEP 723 block above is not decoration: `uv run` is the ONLY thing that reads it,
and load_server() executes server/server.py, which imports `fire` at module scope.
With no block this file is a ModuleNotFoundError before the first assertion -- the
suite red for an environment reason, reported identically to a real defect
(run_all.mjs:277 records that exact incident for the other python suites).
"""
import doctest
import importlib.util
import os
import re
import sys

# Resolved from THIS file, never from the cwd and never absolute -- the dump is
# portable and may be renamed or moved at any time (same shape as
# tests/theme_contrast_test.py:28).
HERE = os.path.dirname(os.path.abspath(__file__))
SEAM_JS = os.path.join(HERE, "..", "core", "pointer_input.js")
SERVER_PY = os.path.join(HERE, "..", "server", "server.py")
assert os.path.isfile(SEAM_JS), f"the pointer seam is missing: {SEAM_JS}"
assert os.path.isfile(SERVER_PY), f"the server is missing: {SERVER_PY}"

# The keys of `export const POINTER_KEYWORDS = Object.freeze({ ... })`. Matching the
# BLOCK first and the keys inside it (rather than "mouse_\w+" anywhere in the file)
# is what keeps a prose mention in that file's long header out of the answer.
KEYWORDS_BLOCK = re.compile(
    r"export\s+const\s+POINTER_KEYWORDS\s*=\s*Object\.freeze\(\{(.*?)\}\);", re.S)
KEY = re.compile(r"^\s*(\w+)\s*:", re.M)


def js_pointer_keywords():
    """
    Query (reads core/pointer_input.js). The keyword names the JavaScript seam
    declares, in declaration order.

    Examples:
        >>> js_pointer_keywords()
        ['mouse_x', 'mouse_y', 'mouse_left']
    """
    with open(SEAM_JS) as f:
        source = f.read()
    block = KEYWORDS_BLOCK.search(source)
    assert block, "POINTER_KEYWORDS is no longer an Object.freeze({...}) literal in core/pointer_input.js"
    names = KEY.findall(block.group(1))
    assert names, "POINTER_KEYWORDS parsed as empty -- the gate would pass vacuously"
    return names


def load_server():
    """Query (imports server.py by path). The server module, without starting it."""
    spec = importlib.util.spec_from_file_location("powerrp_server_under_test", SERVER_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    """Command (prints; exits nonzero on failure)."""
    failures = []
    server = load_server()

    js = js_pointer_keywords()
    py = list(server.POINTER_INPUT_KEYWORDS)
    print(f"core/pointer_input.js POINTER_KEYWORDS : {js}")
    print(f"server.py POINTER_INPUT_KEYWORDS       : {py}")
    if js != py:
        failures.append(
            f"the two keyword lists disagree: JS {js} vs Python {py}. "
            f"A deck using a keyword only one side knows about renders with no export warning.")

    # The warning must actually FIRE on the JS list, not merely match it as text.
    for name in js:
        doc = {"slides": [{"delta": {"items": {"a": {"x": f"= {name}"}}}}]}
        if server.pointer_input_warning(doc) is None:
            failures.append(f"a deck reading `{name}` produced NO export warning")
        if server.export_warning(doc) is None:
            failures.append(f"export_warning() dropped the pointer warning for `{name}`")
    clean = {"slides": [{"delta": {"items": {"a": {"x": 12, "text": "the mouse"}}}}]}
    if server.export_warning(clean) is not None:
        failures.append(f"a pointer-free deck was warned anyway: {server.export_warning(clean)!r}")

    # And the doctests that specify the wording and the walk. run_docstring_examples
    # PRINTS failures and returns None, so it cannot be used here -- a broken doctest
    # would scroll past and the gate would still exit 0, which is the silent failure
    # the house rules forbid. The finder+runner pair reports a count.
    finder, runner = doctest.DocTestFinder(), doctest.DocTestRunner(verbose=False)
    checked = 0
    for fn in (server.document_reads_pointer, server.pointer_input_warning,
               server.export_warning, server.playback_clock_warning):
        for case in finder.find(fn, fn.__name__, globs={fn.__name__: fn}):
            runner.run(case)
            checked += len(case.examples)
    if runner.failures:
        failures.append(f"{runner.failures} of {checked} server.py warning doctest(s) failed (printed above)")
    print(f"server.py warning doctests: {checked} examples, {runner.failures} failed")

    if failures:
        print(f"\nFAILURES ({len(failures)}):")
        for f in failures:
            print(f"  {f}")
        sys.exit(1)
    print(f"\nOK: {len(js)} pointer keywords agree across the language boundary, "
          f"and each one raises the export warning")


if __name__ == "__main__":
    main()
