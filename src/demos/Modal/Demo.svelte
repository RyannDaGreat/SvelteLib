<script>
  import Modal from "../../lib/Modal.svelte";

  let basicOpen = $state(false);
  let scrollOpen = $state(false);
  let imageOpen = $state(false);
  let formOpen = $state(false);
  let videoOpen = $state(false);
  let noBackdropOpen = $state(false);

  let lastClose = $state("—");

  // Self-contained placeholder image (data URI) — no network dependency, so
  // the demo (and the puppeteer test's "zero console errors" bar) never
  // depends on an external asset loading.
  const PLACEHOLDER_IMAGE =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270">
        <rect width="480" height="270" fill="#3a3a52"/>
        <circle cx="240" cy="135" r="60" fill="#7aa2f7"/>
        <text x="240" y="230" fill="#e0e0e0" font-family="sans-serif" font-size="16" text-anchor="middle">preview.svg</text>
      </svg>`,
    );

  // Small public-domain-style sample video for the asset-preview use case.
  // Remote, matching the SyncPlayer demo's precedent for streamed demo media.
  const SAMPLE_VIDEO =
    "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
</script>

<main class="demo-page">
  <h1>Modal</h1>
  <p class="demo-hint">
    Generic modal dialog: backdrop dims the page, Escape/backdrop-click close (each
    togglable), focus moves in on open and is trapped while open (<kbd>Tab</kbd> cycles),
    focus returns to the opener on close, and body scroll locks while open.
  </p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <section class="grid">
    <div class="card">
      <h2>Basic open/close</h2>
      <p class="note">
        Escape or backdrop click closes. Last close reason: <code>{lastClose}</code>.
      </p>
      <button
        class="demo-btn"
        data-testid="open-basic"
        onclick={() => (basicOpen = true)}
      >
        Open modal
      </button>
      <Modal
        bind:open={basicOpen}
        title="Basic Modal"
        onclose={() => (lastClose = "basic")}
      >
        <p>A minimal modal with a title, close button, and some body text.</p>
        <p>Click outside the panel, press <kbd>Escape</kbd>, or use the × button.</p>
      </Modal>
    </div>

    <div class="card">
      <h2>Long scrolling body</h2>
      <p class="note">Content taller than <code>--modal-max-height</code> scrolls inside the panel.</p>
      <button class="demo-btn" data-testid="open-scroll" onclick={() => (scrollOpen = true)}>
        Open long modal
      </button>
      <Modal bind:open={scrollOpen} title="Terms &amp; Conditions">
        {#each Array(40) as _, i}
          <p data-testid="scroll-para">Paragraph {i + 1} of filler content to force scrolling.</p>
        {/each}
      </Modal>
    </div>

    <div class="card">
      <h2>Image inside</h2>
      <p class="note">An asset-preview style layout — no title header, image fills the panel.</p>
      <button class="demo-btn" data-testid="open-image" onclick={() => (imageOpen = true)}>
        Open image preview
      </button>
      <Modal bind:open={imageOpen} title="Image Preview">
        <img class="preview-media" data-testid="preview-image" src={PLACEHOLDER_IMAGE} alt="Placeholder preview" />
      </Modal>
    </div>

    <div class="card">
      <h2>Video inside</h2>
      <p class="note">The asset-preview use case: a <code>&lt;video&gt;</code> element as panel content.</p>
      <button class="demo-btn" data-testid="open-video" onclick={() => (videoOpen = true)}>
        Open video preview
      </button>
      <Modal bind:open={videoOpen} title="Video Preview">
        <video
          class="preview-media"
          data-testid="preview-video"
          src={SAMPLE_VIDEO}
          controls
          muted
        ></video>
      </Modal>
    </div>

    <div class="card">
      <h2>Nested focusable controls (focus trap)</h2>
      <p class="note">
        Three inputs plus the close button. <kbd>Tab</kbd> cycles among only these —
        never escaping to the page behind.
      </p>
      <button class="demo-btn" data-testid="open-form" onclick={() => (formOpen = true)}>
        Open form modal
      </button>
      <Modal bind:open={formOpen} title="Nested Controls">
        <label class="form-row">
          <span>Name</span>
          <input type="text" data-testid="field-name" />
        </label>
        <label class="form-row">
          <span>Email</span>
          <input type="email" data-testid="field-email" />
        </label>
        <button type="button" data-testid="field-submit">Submit</button>
      </Modal>
    </div>

    <div class="card">
      <h2><code>closeOnBackdrop=false</code></h2>
      <p class="note">Backdrop clicks are ignored; only Escape or the × button close it.</p>
      <button
        class="demo-btn"
        data-testid="open-no-backdrop"
        onclick={() => (noBackdropOpen = true)}
      >
        Open (backdrop click disabled)
      </button>
      <Modal bind:open={noBackdropOpen} title="Backdrop Click Disabled" closeOnBackdrop={false}>
        <p>Clicking outside this panel does nothing. Use Escape or the × button.</p>
      </Modal>
    </div>
  </section>
</main>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 1rem;
    width: 80vw;
    margin-top: 1rem;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem;
    background: var(--bg-surface);
  }

  h2 {
    font-size: 1rem;
    margin-bottom: 0.25rem;
  }
  .note {
    color: var(--fg-dim);
    font-size: 0.8rem;
    margin-bottom: 0.75rem;
  }
  code {
    color: var(--accent);
    font-size: 0.85em;
  }
  kbd {
    font-size: 0.8em;
    padding: 1px 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
  }

  .demo-btn {
    background: var(--control-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--control-pad);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .demo-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .preview-media {
    display: block;
    width: 100%;
    height: auto;
  }

  .form-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 0.75rem;
    font-size: 0.85rem;
    color: var(--fg-dim);
  }
  .form-row input {
    font: inherit;
    padding: 6px 8px;
    background: var(--control-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
</style>
