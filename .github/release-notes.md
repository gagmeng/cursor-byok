Download the installer for your platform from the assets below.

## Magpie gateway import

- **Magpie preset** — the model editor's preset chips gain a Magpie entry. It
  queries a local magpie gateway (`127.0.0.1:3425` by default, address
  editable), lists every model the gateway serves grouped by provider, and
  creates the ones you tick in one click.
- **Idempotent** — already-imported models are detected with the same model
  hash the insert conflict key uses, so a repeat import skips instead of
  duplicating. The dialog shows `available / existing / selected` counts.
- **Routing groups stay apart** — magpie lists its multi-provider routing
  groups as `auto/<model>` and `group/<id>`. They used to be scattered into
  their first member provider's group, which read like the same model imported
  twice. They are now collected into one trailing "Routing groups" group, are
  left unchecked by default, and their member models remain in the provider
  groups.
- **Readable groups** — each provider group folds and unfolds; model rows are
  indented under their group header so the hierarchy is visible.

## System prompt: replace

- A third composition mode, **Replace**, makes your text the entire system
  prompt instead of inserting it before or after Cursor's original. A disabled
  replacement still falls back to the Cursor prompt.
- Existing conversations keep the prompt they adopted; the change applies to
  new conversations. (Migration 0012 rebuilds `model_system_prompts` with the
  wider position set and preserves every saved row.)

## Model cards

- **One card grid** — flat and grouped views now share one card: grouped view
  is a grid under collapsible group headers instead of a row list, and plugin
  models are cards in both views.
- **Status bar spans the card** — the test state bar fills the card width,
  including the "not tested" state.
- **One-line actions** — a running test reads "停止" (stop) instead of
  "取消测试", so the five actions stay on one line at the minimum window size.
- **Group commands** — provider group headers carry icon-only commands with
  hover tooltips for group settings and group deletion. Deletion asks for
  confirmation and removes every model in the group.
- **Drag-to-reorder removed** — sorting by dragging, `sortablejs`, and the
  `/models/order` endpoint are gone; the stored `sort_order` is still what
  orders the cards.

## Fixes

- **Dialog content scrolls** — `ScrollArea` and `ScrollableContent` pass height
  down the flex chain instead of relying on `height: 100%`, so long dialog
  content (the import list, the system prompt editor) actually scrolls.
- **Content headers are not padded** — `Modal`'s title/footer padding is
  scoped to its own children, so a `<header>` inside dialog content keeps its
  own layout.

## Upgrade notes

The database migrates automatically on first start (schema 11 → 12). Saved
models, keys, and system prompts are preserved; the migration was measured on
a copy of a real database — file size and row counts unchanged.
