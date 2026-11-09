Download the installer for your platform from the assets below.

## Zed Cloud accounts

- **New plugin: Zed** — a model provider backed by your Zed Cloud
  subscription. Claude, GPT, Gemini, and Grok models served by Zed Pro or Zed
  Student ($10/mo) appear as ordinary model cards and run through the same
  chat path as every other provider.
- **Sign in through zed.dev** — "Add account" opens zed.dev's native app
  sign-in in your browser. The callback carries the credential encrypted to a
  fresh RSA-2048 key generated for that one attempt and held only in memory,
  so the token cannot be replayed or read off the wire.
- **Import instead of signing in** — an existing Zed credential imports from a
  JSON, `.env`, `.txt`, or `.key` file: either `<user_id> <access_token>`, the
  raw LLM JWT, or a JSON/env document carrying both.
- **Quota is visible** — the account card shows the plan and the remaining
  edit-prediction quota. A Student spending limit puts the account into a
  cooling state with its retry time instead of failing each call.
- **Model catalog** — models are discovered from Zed and grouped by their
  upstream (Anthropic / OpenAI / Google / xAI), each routed through the
  protocol that upstream expects.

## Plugin OAuth hardening

- **Narrowed callback trust** — Zed's sign-in posts credentials straight to the
  loopback callback and does not send a `state`. Previously that shape would
  have required disabling state verification for every plugin. Now a plugin
  opts in per add-method (`nativeSignin`), and every other plugin keeps its
  state check. A partial callback carrying only one credential is still
  rejected.

## Upgrade notes

No database migration in this release; the schema stays at 12. The Zed plugin
is pre-installed on first start alongside the existing built-in plugins.
