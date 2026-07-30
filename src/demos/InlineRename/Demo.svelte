<script>
  import InlineRename from "../../lib/InlineRename.svelte";

  // Each card owns its own name so the demo shows a real write-back: the
  // component emits, the CONSUMER assigns. Nothing is mutated by the component.
  let slideName = $state("Slide 1");
  let projectName = $state("Untitled Project");
  let commandName = $state("Layer 3");
  let styledName = $state("chapter-two.md");

  // A visible log of what was emitted, so the "blur/Escape emit NOTHING"
  // contract is observable rather than merely documented.
  let events = $state([]);
  function log(surface, name) {
    events = [...events, `${surface} → "${name}"`].slice(-6);
  }

  let commandEditor; // bound InlineRename for the programmatic-open card
</script>

<main class="demo-page">
  <h1>InlineRename</h1>
  <p class="demo-hint">
    In-place text editing for a name. The display is your own markup (a snippet);
    activating swaps it for an input pre-filled, focused, with
    <strong>all text selected</strong> — so typing replaces the whole name, while
    an arrow key first collapses the selection and typing then appends.
    <strong>Enter commits, Escape cancels, and blur (clicking away) cancels</strong>
    — a half-typed name is never committed.
  </p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <section class="grid">
    <div class="card">
      <h2>Double-click (default)</h2>
      <p class="note">
        For a display that already owns its single click — a slide card whose
        click selects the slide, so rename must be the second gesture.
      </p>
      <div class="row" data-testid="slide-row">
        <InlineRename
          value={slideName}
          onrename={(name) => { slideName = name; log("slide", name); }}
          ariaLabel="Rename slide"
        >
          {#snippet children()}
            <span class="name" data-testid="slide-name">{slideName}</span>
          {/snippet}
        </InlineRename>
      </div>
    </div>

    <div class="card">
      <h2>Single click</h2>
      <p class="note">For a display with no first gesture to lose, like a toolbar title.</p>
      <div class="row">
        <InlineRename
          value={projectName}
          trigger="click"
          onrename={(name) => { projectName = name; log("project", name); }}
          ariaLabel="Rename project"
        >
          {#snippet children()}
            <span class="title" data-testid="project-name">{projectName}</span>
          {/snippet}
        </InlineRename>
      </div>
    </div>

    <div class="card">
      <h2>Programmatic (<code>trigger="none"</code>)</h2>
      <p class="note">
        No pointer gesture of its own — opened by a button, menu item or command.
        Enter/F2 on the focused display still works.
      </p>
      <div class="row">
        <InlineRename
          bind:this={commandEditor}
          value={commandName}
          trigger="none"
          onrename={(name) => { commandName = name; log("command", name); }}
          ariaLabel="Rename layer"
        >
          {#snippet children()}
            <span class="name" data-testid="command-name">{commandName}</span>
          {/snippet}
        </InlineRename>
        <button data-testid="open-command" onclick={() => commandEditor.open()}>Rename…</button>
      </div>
    </div>

    <div class="card themed">
      <h2>Re-themed via CSS custom properties</h2>
      <p class="note">Same component, different <code>--inline-rename-*</code> vars.</p>
      <div class="row">
        <InlineRename
          value={styledName}
          trigger="click"
          onrename={(name) => { styledName = name; log("styled", name); }}
          ariaLabel="Rename file"
        >
          {#snippet children()}
            <span class="mono" data-testid="styled-name">{styledName}</span>
          {/snippet}
        </InlineRename>
      </div>
    </div>
  </section>

  <section class="log-section">
    <h2>Emitted <code>onrename</code> events</h2>
    <p class="note">
      Cancels emit NOTHING — open an editor, type, then press Escape or click
      elsewhere and no line appears here.
    </p>
    <ul class="log" data-testid="event-log">
      {#each events as e}<li>{e}</li>{:else}<li class="empty">(nothing emitted yet)</li>{/each}
    </ul>
  </section>
</main>

<style>
  /* Local layout only — the shared theme classes (.demo-page, .demo-hint,
     .demo-back, .note) come from styles/theme.css. */
  .grid {
    --card-min-width: 260px;
    --card-gap: 16px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--card-min-width), 1fr));
    gap: var(--card-gap);
  }

  .card {
    --card-padding: 14px;
    --card-radius: 6px;
    padding: var(--card-padding);
    border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
    border-radius: var(--card-radius);
  }

  .row {
    --row-gap: 8px;
    --row-min-height: 28px;
    display: flex;
    align-items: center;
    gap: var(--row-gap);
    min-height: var(--row-min-height);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title {
    --title-size: 1.15rem;
    flex: 1;
    font-size: var(--title-size);
    font-weight: 600;
  }

  .mono {
    flex: 1;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  /* Proves the input inherits its host's typography and honours the override
     hooks: this card's editor is monospace, accented and rounded. */
  .themed {
    --inline-rename-border: #7dd3fc;
    --inline-rename-bg: rgba(125, 211, 252, 0.12);
    --inline-rename-radius: 6px;
    --inline-rename-padding: 2px 6px;
  }

  .log-section {
    --log-margin-top: 24px;
    margin-top: var(--log-margin-top);
  }

  .log {
    --log-gap: 4px;
    display: flex;
    flex-direction: column;
    gap: var(--log-gap);
    padding-left: 1.2em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .log .empty {
    opacity: 0.5;
  }
</style>
