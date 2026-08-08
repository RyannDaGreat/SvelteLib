# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1", "numpy>=1.26"]
# ///
#
# THE HEADER IS NOT DECORATION. `uv run <file>` reads THIS file's inline metadata
# (tests/run_all.mjs: "`uv run <file>` — NOT `uv run python <file>`. Only the former
# reads the file's..."), and this gate IMPORTS server.py, which imports `fire`. Its
# sibling tests/pointer_input_warning_test.py carries no header and consequently
# fails on a host whose ambient interpreter lacks those packages — MEASURED on this
# machine, where it dies with `ModuleNotFoundError: No module named 'fire'` before
# asserting anything. Mirroring server.py's own dependency list here makes this gate
# run from a bare checkout, which is the whole point of the dump's `uv run` rule.
"""
THE CROSS-LANGUAGE GATE for the MIDI clip's live-trigger export warning.

server.py has to know which widget types are MIDI CLIPS and which are LIVE CONTROLS,
and it cannot import the JavaScript plugin registry to find out -- so MIDI_TRIGGERABLE_TYPES
and LIVE_TRIGGER_TYPES are MIRRORS, the same debt POINTER_INPUT_KEYWORDS carries and
the same drift this codebase pays for everywhere a mirror appears.

THIS GATE IS THE PRICE OF THE MIRROR, and the failure it prevents is specific: a new
live control (say a footswitch node) ships, someone wires it to a clip's trigger, the
deck plays in the room, the export is SILENT, and no warning fires because server.py
has never heard of that type. So rather than restating the two lists, this loads the
REAL plugin registry in node and derives them from the declarations that actually
define the categories:

    a MIDI SOURCE is a plugin whose ports emit `midi` AND take a `trigger`
    a LIVE       is a plugin declaring `livePress` or `livePlay`

...which are the same predicates core/clip_playback.js uses, so the JavaScript side
cannot drift from itself either.

It also runs server.py's own doctests for the new functions, which are the
specification of what the warning says and when.

Run with no args.
"""
import doctest
import importlib.util
import json
import os
import subprocess
import sys

# Resolved from THIS file, never from the cwd and never absolute -- the dump is
# portable and may be renamed or moved at any time (tests/pointer_input_warning_test.py:24).
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..")
SERVER_PY = os.path.join(APP, "server", "server.py")
PLAYBACK_JS = os.path.join(APP, "core", "clip_playback.js")
assert os.path.isfile(SERVER_PY), f"the server is missing: {SERVER_PY}"
assert os.path.isfile(PLAYBACK_JS), f"the playback seam is missing: {PLAYBACK_JS}"


def js_categories():
    """
    The two type lists, DERIVED from the live plugin registry rather than parsed out
    of a source file.

    Deriving beats parsing here (where tests/pointer_input_warning_test.py parses a
    frozen object literal) because these categories are not written down as a list
    anywhere in JavaScript either -- they are a PREDICATE over every registered
    plugin. Asking the registry is therefore the only way to get the real answer, and
    it is what makes a newly added widget covered on the day it lands.
    """
    script = """
      import { createRegistry } from "./core/registry.js";
      import { allPlugins } from "./plugins/index.js";
      import { isLiveSource, isTriggerableMidiSource, TRIGGER_PORT } from "./core/clip_playback.js";
      const clips = allPlugins.filter(isTriggerableMidiSource).map((p) => p.type).sort();
      const live = allPlugins.filter(isLiveSource).map((p) => p.type).sort();
      console.log(JSON.stringify({ clips, live, port: TRIGGER_PORT }));
    """
    out = subprocess.run([  # nosec - a fixed script against the repo's own sources
        "node", "--input-type=module", "-e", script,
    ], cwd=APP, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"could not read the plugin registry in node:\n{out.stderr}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def load_server():
    """server.py as a module, without starting anything."""
    spec = importlib.util.spec_from_file_location("powerrp_server_under_test", SERVER_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    failures = []
    server = load_server()
    js = js_categories()

    # ── THE MIRROR ───────────────────────────────────────────────────────────
    if sorted(server.MIDI_TRIGGERABLE_TYPES) != js["clips"]:
        failures.append(
            f"MIDI_TRIGGERABLE_TYPES disagrees with the registry: server.py has "
            f"{sorted(server.MIDI_TRIGGERABLE_TYPES)}, triggerable midi sources are {js['clips']}")
    if sorted(server.LIVE_TRIGGER_TYPES) != js["live"]:
        failures.append(
            f"LIVE_TRIGGER_TYPES disagrees with the registry: server.py has "
            f"{sorted(server.LIVE_TRIGGER_TYPES)}, plugins declaring livePress/livePlay are {js['live']}")
    if server.MIDI_TRIGGER_PORT != js["port"]:
        failures.append(
            f"MIDI_TRIGGER_PORT is {server.MIDI_TRIGGER_PORT!r}, core/clip_playback.TRIGGER_PORT is {js['port']!r}")
    if not js["clips"]:
        failures.append("no plugin is a triggerable midi source -- the warning could never fire")
    if not js["live"]:
        failures.append("no plugin declares livePress/livePlay -- the warning could never fire")

    # ── THE BEHAVIOUR ────────────────────────────────────────────────────────
    def deck(*items):
        return {"slides": [{"delta": {"items": {k: v for d in items for k, v in d.items()}}}]}

    # EVERY live type, against EVERY clip type -- so a pair that the mirror knows
    # about but the walk cannot reach is still a failure.
    for live_type in js["live"]:
        for clip_type in js["clips"]:
            doc = deck({"src": {"type": live_type}},
                       {"c": {"type": clip_type, "inputs": {server.MIDI_TRIGGER_PORT: {"item": "src", "port": "out"}}}})
            if server.live_trigger_warning(doc) is None:
                failures.append(f"{clip_type} triggered by {live_type} raised NO warning -- it would export silent")
            if server.export_warning(doc) is None:
                failures.append(f"export_warning() dropped the live-trigger warning for {live_type} -> {clip_type}")

    # THE REPRODUCIBLE ARRANGEMENTS MUST NOT WARN. A warning that fires on the
    # correct setup teaches users to ignore it, which costs the real one its reader.
    for clip_type in js["clips"]:
        quiet = [
            ("unwired", deck({"c": {"type": clip_type}})),
            ("clock-driven", deck({"k": {"type": "audio_clock"}},
                                  {"c": {"type": clip_type, "inputs": {server.MIDI_TRIGGER_PORT: {"item": "k", "port": "out"}}}})),
            ("dangling wire", deck({"c": {"type": clip_type, "inputs": {server.MIDI_TRIGGER_PORT: {"item": "gone", "port": "out"}}}})),
            ("live control present but NOT wired to the clip",
             deck({"b": {"type": js["live"][0]}}, {"c": {"type": clip_type}})),
        ]
        for label, doc in quiet:
            got = server.live_trigger_warning(doc)
            if got is not None:
                failures.append(f"a reproducible {clip_type} ({label}) was warned anyway: {got!r}")

    # A wire authored on a LATER slide must still be seen -- items live in deltas.
    later = {"slides": [
        {"delta": {"items": {"b": {"type": js["live"][0]}, "c": {"type": js["clips"][0]}}}},
        {"delta": {"items": {"c": {"inputs": {server.MIDI_TRIGGER_PORT: {"item": "b", "port": "out"}}}}}},
    ]}
    if server.live_trigger_warning(later) is None:
        failures.append("a trigger wired on slide 2 was missed -- the walk must cover every slide's delta")

    # The sentence has to be ACTIONABLE, not merely present.
    doc = deck({"b": {"type": js["live"][0]}},
               {"c": {"type": js["clips"][0], "inputs": {server.MIDI_TRIGGER_PORT: {"item": "b", "port": "out"}}}})
    said = server.live_trigger_warning(doc)
    for needle in ("SILENT", "Clock", "Start Time", "c"):
        if needle not in said:
            failures.append(f"the warning never says {needle!r}: {said!r}")

    # ── THE DOCTESTS (the specification of the wording and the walk) ─────────
    # finder+runner rather than run_docstring_examples, which PRINTS failures and
    # returns None -- a broken doctest would scroll past and the gate would exit 0.
    finder, runner = doctest.DocTestFinder(), doctest.DocTestRunner(verbose=False)
    checked = 0
    for fn in (server.item_types_by_id, server.live_triggered_clips, server.live_trigger_warning):
        for case in finder.find(fn, fn.__name__, globs={fn.__name__: fn}):
            runner.run(case)
            checked += len(case.examples)
    if runner.failures:
        failures.append(f"{runner.failures} of {checked} live-trigger doctest(s) failed (printed above)")
    print(f"server.py live-trigger doctests: {checked} examples, {runner.failures} failed")

    if failures:
        print(f"\nFAILURES ({len(failures)}):")
        for f in failures:
            print(f"  {f}")
        sys.exit(1)
    print(f"\nOK: clip types {js['clips']} and live types {js['live']} agree across the language boundary; "
          f"every live pair warns and every reproducible arrangement stays quiet.")


if __name__ == "__main__":
    main()
