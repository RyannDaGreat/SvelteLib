/**
 * Undo/redo as a document snapshot log (annotator pattern). Documents are
 * immutable plain-JSON trees, so a "snapshot" is just holding the reference —
 * no cloning needed. Documents are immutable
 * plain trees, so holding references is free; receipts-style undo was never
 * ported from LIAC (a possible future optimization).
 */

export function createUndo(initialDoc) {
  let past = [];
  let present = initialDoc;
  let future = [];
  return {
    /** Query. Current document. */
    get doc() {
      return present;
    },
    /** Command. Commits a new document state as one undoable transaction. */
    commit(doc) {
      if (doc === present) return;
      past.push(present);
      present = doc;
      future = [];
    },
    /** Command. Steps back; returns the new current doc (or unchanged). */
    undo() {
      if (past.length) {
        future.push(present);
        present = past.pop();
      }
      return present;
    },
    /** Command. Steps forward; returns the new current doc (or unchanged). */
    redo() {
      if (future.length) {
        past.push(present);
        present = future.pop();
      }
      return present;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
  };
}
