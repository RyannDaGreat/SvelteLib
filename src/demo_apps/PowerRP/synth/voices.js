/**
 * VOICE ALLOCATION — who plays which note, and who gets stolen.
 *
 * ── WHY THIS IS ITS OWN FILE, AND PURE ──────────────────────────────────────
 * "Polyphonic demos are important" (user, 2026-08-03). Polyphony is two separable
 * things: BUILDING several voices (AudioNodes, only provable in a browser) and
 * DECIDING which voice a note lands on (arithmetic over a small table). The second
 * is where every polyphony bug actually lives — a note that steals the voice
 * playing the note you are still holding, a note-off that releases the WRONG voice
 * because a later note reused its slot, a chord that plays four notes on three
 * voices and drops the wrong one. None of those throw; they produce a wrong sound.
 *
 * So the decision is a pure function over a plain table and is covered in bare
 * node by tests/poly_voices_test.js, exactly the split synth/dsp.js already makes
 * for the DSP arithmetic ("the parts where a silent mistake produces a WRONG SOUND
 * rather than an exception").
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 * A POOL is a fixed array of N SLOTS. A slot is either free or holds one sounding
 * note. `noteOn` returns the slot index to play on, plus whatever it had to stop
 * first; `noteOff` returns the slot to release, or null when that note is not
 * sounding. The pool never grows: a fixed voice count is what makes a poly synth's
 * CPU cost knowable, and it is what every hardware and software poly synth does.
 *
 * ── THE STEAL POLICY: OLDEST FIRST ──────────────────────────────────────────
 * When every slot is busy and a new note arrives, one sounding note must stop. The
 * choices are oldest-first, quietest-first (needs an envelope follower, which is
 * live audio state we do not have here), or refuse the note. OLDEST-FIRST is what
 * the brief specifies and it is also the right default: a held chord's earliest
 * note is the one most likely to be the tail of a previous gesture, and refusing
 * the note instead would make a keyboard feel broken — you press a key and nothing
 * happens, with nothing on screen to explain it.
 *
 * `age` is a MONOTONIC COUNTER, not a clock. That is deliberate and it is what
 * keeps this file pure: a wall clock here would make allocation non-reproducible
 * and would be a determinism-law violation the moment anything recorded it
 * (CLAUDE.md's taxonomy). A counter gives the same total order for the same note
 * sequence on every machine and in bare node.
 *
 * ── RETRIGGERING THE SAME NOTE ──────────────────────────────────────────────
 * Pressing a key that is already sounding (a repeat from a held computer key, or a
 * sequencer restriking) REUSES that note's own slot rather than allocating a
 * second one. Two voices on one pitch is not a chord, it is a doubling that gets
 * 6 dB louder and then leaves an orphan when one note-off arrives — and it burns a
 * slot the rest of the chord needs. The slot's age is refreshed, so a retriggered
 * note goes to the back of the steal queue, which is what a player expects.
 *
 * Nothing here imports an AudioContext, PowerRP, or a browser global.
 */

/**
 * Pure function. A fresh voice pool of `count` free slots.
 *
 * The pool is PLAIN DATA (`{slots, nextAge}`) and every function below returns a
 * NEW pool rather than mutating: that is what lets a test assert a whole chord
 * sequence as one expression, and it is what stops the caller from accidentally
 * sharing a pool between two modules.
 *
 * @param {number} count - how many notes may sound at once (>= 1)
 * @returns {{slots: Array<{note: number|null, age: number}>, nextAge: number}}
 *
 * @example createVoicePool(3).slots.length // 3
 * @example createVoicePool(3).slots[0].note // null
 * @example // a count below 1 would be a silent synth; it is refused loudly
 * @example try { createVoicePool(0) } catch (e) { e.message.includes("at least 1") } // true
 */
export function createVoicePool(count) {
  if (!Number.isFinite(count) || count < 1) {
    throw new RangeError(`voice pool needs at least 1 voice, got ${JSON.stringify(count)}`);
  }
  const n = Math.floor(count);
  return { slots: Array.from({ length: n }, () => ({ note: null, age: 0 })), nextAge: 1 };
}

/**
 * Pure function. Which slot is sounding `note`, or -1.
 *
 * @param {object} pool - a voice pool
 * @param {number} note - the note identity (a MIDI number, or any stable key)
 * @returns {number} slot index, or -1
 *
 * @example slotOfNote(createVoicePool(2), 60) // -1
 * @example slotOfNote(noteOn(createVoicePool(2), 60).pool, 60) // 0
 */
export function slotOfNote(pool, note) {
  return pool.slots.findIndex((s) => s.note === note);
}

/**
 * Pure function. Which slot a new note should take: the first FREE one, else the
 * OLDEST sounding one.
 *
 * Free slots are preferred in INDEX order rather than by age, and that is a real
 * choice: a pool that reused the least-recently-freed slot would spread a slow
 * arpeggio across every voice in turn, which sounds identical but makes a rendered
 * voice display jump around for no reason. Index order keeps a two-note pattern on
 * two voices.
 *
 * @param {object} pool - a voice pool
 * @returns {number} slot index (always valid — a pool has at least one slot)
 *
 * @example nextSlot(createVoicePool(3)) // 0
 * @example // with slot 0 busy the next free one is taken
 * @example nextSlot(noteOn(createVoicePool(3), 60).pool) // 1
 * @example // full pool: the OLDEST note's slot is the answer
 * @example nextSlot(noteOn(noteOn(createVoicePool(2), 60).pool, 64).pool) // 0
 */
export function nextSlot(pool) {
  const free = pool.slots.findIndex((s) => s.note === null);
  if (free >= 0) return free;
  let oldest = 0;
  for (let i = 1; i < pool.slots.length; i++) if (pool.slots[i].age < pool.slots[oldest].age) oldest = i;
  return oldest;
}

/**
 * Pure function. Allocate `note`, reporting the slot to play it on and the note
 * (if any) that had to be stopped to make room.
 *
 * THE `stolen` FIELD IS THE WHOLE POINT OF RETURNING A RECORD rather than an
 * index. The caller must stop the old note's voice BEFORE starting the new one on
 * the same slot, and a bare index would leave it guessing whether the slot was
 * free. A steal is also the one event worth showing on a keyboard's face (the
 * stolen key un-lights), which needs the note identity, not the slot.
 *
 * `stolen` is null both when the slot was free AND when the note was already
 * sounding (a retrigger reuses its own slot — nothing is displaced).
 *
 * @param {object} pool - a voice pool
 * @param {number} note - the note identity
 * @returns {{pool: object, slot: number, stolen: number|null, retrigger: boolean}}
 *
 * @example noteOn(createVoicePool(4), 60).slot // 0
 * @example noteOn(createVoicePool(4), 60).stolen // null
 * @example // a THIRD note into a two-voice pool steals the first
 * @example noteOn(noteOn(noteOn(createVoicePool(2), 60).pool, 64).pool, 67).stolen // 60
 * @example noteOn(noteOn(noteOn(createVoicePool(2), 60).pool, 64).pool, 67).slot // 0
 * @example // re-pressing a sounding note reuses ITS OWN slot and steals nothing
 * @example noteOn(noteOn(createVoicePool(4), 60).pool, 60).retrigger // true
 * @example noteOn(noteOn(createVoicePool(4), 60).pool, 60).slot // 0
 */
export function noteOn(pool, note) {
  const existing = slotOfNote(pool, note);
  const slot = existing >= 0 ? existing : nextSlot(pool);
  const stolen = existing >= 0 ? null : pool.slots[slot].note;
  const slots = pool.slots.map((s, i) => (i === slot ? { note, age: pool.nextAge } : s));
  return { pool: { slots, nextAge: pool.nextAge + 1 }, slot, stolen, retrigger: existing >= 0 };
}

/**
 * Pure function. Release `note`, reporting which slot to stop.
 *
 * A note-off for a note that is NOT sounding returns `slot: null` and an unchanged
 * pool. That is an ordinary event rather than an error: a note that was STOLEN
 * while its key was still held will send its note-off later, and the key that
 * stole it must not be silenced by it. This is the classic poly bug, and it is
 * prevented here by identity — the slot is only released if it still holds THIS
 * note.
 *
 * @param {object} pool - a voice pool
 * @param {number} note - the note identity
 * @returns {{pool: object, slot: number|null}}
 *
 * @example noteOff(noteOn(createVoicePool(2), 60).pool, 60).slot // 0
 * @example noteOff(createVoicePool(2), 60).slot // null
 * @example // THE STOLEN-NOTE BUG, prevented: 60 was stolen by 67, so 60's late
 * @example // note-off must not stop the voice now playing 67
 * @example noteOff(noteOn(noteOn(createVoicePool(1), 60).pool, 67).pool, 60).slot // null
 */
export function noteOff(pool, note) {
  const slot = slotOfNote(pool, note);
  if (slot < 0) return { pool, slot: null };
  const slots = pool.slots.map((s, i) => (i === slot ? { note: null, age: 0 } : s));
  return { pool: { slots, nextAge: pool.nextAge }, slot };
}

/**
 * Pure function. Every sounding note, in slot order.
 *
 * @param {object} pool - a voice pool
 * @returns {number[]}
 *
 * @example soundingNotes(createVoicePool(3)) // []
 * @example soundingNotes(noteOn(noteOn(createVoicePool(3), 60).pool, 64).pool) // [60, 64]
 */
export function soundingNotes(pool) {
  return pool.slots.filter((s) => s.note !== null).map((s) => s.note);
}

/**
 * Pure function. A pool with every slot freed, and the slots that were sounding.
 *
 * The caller needs the list to stop those voices: "all notes off" that silenced
 * the table without telling anyone which AudioNodes to release is how a panic
 * button leaves a drone playing forever.
 *
 * @param {object} pool - a voice pool
 * @returns {{pool: object, slots: number[]}}
 *
 * @example allNotesOff(noteOn(createVoicePool(3), 60).pool).slots // [0]
 * @example soundingNotes(allNotesOff(noteOn(createVoicePool(3), 60).pool).pool) // []
 */
export function allNotesOff(pool) {
  const slots = pool.slots.map((s, i) => (s.note === null ? -1 : i)).filter((i) => i >= 0);
  return { pool: { slots: pool.slots.map(() => ({ note: null, age: 0 })), nextAge: pool.nextAge }, slots };
}

/**
 * The DEFAULT voice count for a poly module, and its ceiling.
 *
 * EIGHT is the default because it is one more than a two-handed keyboard gesture
 * needs (a four-note chord in each hand is seven with a thumb shared) while
 * staying cheap: a poly pad voice is a small oscillator stack, and eight of them
 * is comparable to one existing pad module, which is a cost this engine already
 * pays without complaint.
 *
 * SIXTEEN is the ceiling, and it is a real limit rather than a shrug: every voice
 * is built eagerly at construction (see synth/modules.js polyPadModule — a voice
 * built on demand would allocate on the audio path), so the count is CPU spent
 * whether or not it is played. A user who wants more can place a second module.
 */
export const DEFAULT_POLY_VOICES = 8;
export const MAX_POLY_VOICES = 16;
export const MIN_POLY_VOICES = 1;
