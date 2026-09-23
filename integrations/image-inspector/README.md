# Local image inspection prototype

This optional stdio MCP server lets a text-only Coral model ask a separate local
vision model about a saved image. The main model continues the conversation and
receives text observations; it does not gain native vision or image attachments.
The helper is a private, standalone package with its own pinned dependencies.
It is not bundled into Coral's CLI or installed by the root package.

## Setup

Use Node.js 24 or newer and a local Ollama service. The prototype was exercised
on macOS; its filesystem checks also use POSIX flags available on Linux. Windows
has not been validated.

From the repository root:

```sh
npm ci --prefix integrations/image-inspector --ignore-scripts --no-audit --no-fund
mkdir -p "$HOME/.coral/browser-files"
ollama pull qwen3.5:4b
node -p 'process.execPath'
```

The model download is explicit and approximately 3.4 GB. The helper never pulls
models, changes the main model, updates Ollama, or chooses a fallback model.
Use the absolute Node path printed above in the configuration below.

Merge this server into your **user** `~/.coral.json`, preserving existing keys and
servers. Replace `/absolute/path/to/node`, `/absolute/path/to/coral`, and
`/absolute/path/to/staged-images` with your actual paths; use the directory
created above for staged images. Coral does not expand `~` or shell variables
inside JSON strings.

```json
{
  "mcp": {
    "servers": {
      "images": {
        "command": "/absolute/path/to/node",
        "args": [
          "/absolute/path/to/coral/integrations/image-inspector/server.js",
          "--root",
          "/absolute/path/to/staged-images",
          "--model",
          "qwen3.5:4b",
          "--ollama-url",
          "http://127.0.0.1:11434"
        ],
        "enabledTools": ["inspect_image"],
        "yoloTools": ["inspect_image"],
        "startupTimeoutMs": 30000,
        "toolTimeoutMs": 120000
      }
    }
  }
}
```

Launch Coral in ask mode, send a turn, and approve its normal MCP launch-trust
prompt. Only then use `--yolo`. `/mcp` displays status but does not launch
servers. The `images` server uses one of Coral's twelve MCP tool slots. Removing
`yoloTools` keeps it out of yolo mode. See [MCP configuration](../../docs/mcp.md)
for trust, permissions, and lifecycle behavior.

The server can run directly from any working directory: all image access uses
the explicit absolute staging root. No host-specific launcher is required.

## Interface

```text
mcp__images__inspect_image({ path, question })
```

- `path`: an absolute path to a deliberately staged PNG, JPEG, or WebP file.
- `question`: a nonempty question, at most 2,000 characters.
- Result: one bounded text block containing observations and provenance.

Example prompt:

> Use inspect_image on /absolute/path/to/staged-images/chart.png. Read the
> visible labels and explain the relationship between the bars. State anything
> uncertain.

The model, staging root, and loopback Ollama origin belong to launch
configuration; tool arguments cannot change them. Remote URLs and image paths
outside the staging root are rejected. The helper rejects cloud-named models
and HTTP redirects and only accepts numeric HTTP loopback origins.

### Bounds and failure behavior

- Validate canonical paths and the opened file, reject containment escapes and
  nonregular files, and bound actual reads to 10 MiB. These are server policy
  checks, not an OS sandbox; use a staging directory you control.
- Decode a single-frame PNG, JPEG, or WebP with a 32-megapixel limit. Apply image
  orientation, remove metadata, and resize proportionally to at most 2,560
  pixels per edge without enlargement. Preserve the original file.
- Send one normalized image and the question, plus fixed image-reading
  instructions, to local Ollama. Do not send Coral's history or tools. Use
  `think: false`, an 8,192-token context, a 1,536-token generation cap, and a
  two-minute keep-alive.
- Limit HTTP responses to 128 KiB and tool output to 8,000 characters. Mark
  truncation explicitly. Include the original image's SHA-256, model tag,
  original/normalized dimensions, orientation, and vision request time. Forward
  response content only, not the model's separate thinking field or image bytes.
- Ask the model to report uncertainty; if it omits an uncertainty section, say
  it was not explicitly stated. This is not a calibrated confidence score.
- Apply a 90-second internal deadline. Invalid images, malformed or empty
  responses, unavailable models, and failed requests produce ordinary tool
  errors without retries or fallback models.
- Forward cancellation to the HTTP request. Stdin EOF and termination signals
  abort active work and close the server. The helper never unloads models or
  stops Ollama. Idle vision residency may expire normally after two minutes.

Coral retires an interrupted or timed-out MCP server for the current session;
start a new session to use it again. A saved session retains ordinary tool
arguments/results, not image bytes. Reinspection requires the file still exist;
the recorded hash identifies the image originally inspected.

## Browser handoff

Use page structure for ordinary browsing. Use image inspection for charts,
canvas content, layout, and other information missing from text snapshots:

1. Navigate and inspect the page with browser tools.
2. Capture a screenshot and obtain its absolute saved path.
3. Pass that path and a focused question to `inspect_image`.
4. Continue using browser controls and verify the resulting page state.

This was exercised with the official Playwright Chrome extension and pinned
`@playwright/mcp@0.0.82`, installed separately from Coral. The browser server used
`--extension --browser chrome --image-responses omit --file-paths absolute
--no-webmcp`, an output directory beneath the same staging root, and a launcher
whose working directory was that root. The helper does not install or configure
Playwright. Keep the extension's normal connection approval; selecting a tab
does not limit its broader access to the signed-in Chrome browser.

The exercised browser configuration admitted these eleven tools, leaving one
slot for `inspect_image`: `browser_navigate`, `browser_snapshot`, `browser_find`,
`browser_click`, `browser_fill_form`, `browser_press_key`, `browser_tabs`,
`browser_wait_for`, `browser_handle_dialog`, `browser_file_upload`, and
`browser_take_screenshot`.

With that pinned server:

- Prefer `browser_snapshot` and `browser_find`; narrow large snapshots with
  `target` or `depth`.
- Use raw element refs such as `f1e6` or unique selectors as `target`. Rendered
  prose such as `button Continue after inspection` is not a valid locator.
- Form values are strings, including `"true"` for a checkbox.
- Resolve pending dialogs first. Cancel a file chooser with
  `browser_file_upload` and omit `paths`.
- For screenshots, supply `scale: "css"` and omit `filename` to use the browser
  server's configured output directory. A targeted screenshot can preserve
  small text better than a resized full-page image.

These instructions can be added to your staging workspace's `.coral.md` while
preserving existing content. Coral loads them when started in that workspace;
they are not global instructions or enforced restrictions on available tools.
Website and image text remains untrusted source material, not authority to
override the user or issue further actions.

## Verification and observed limits

Run the three existing helper tests without Ollama or Chrome:

```sh
npm --prefix integrations/image-inspector test
```

They cover file containment/invalid input before inference, the image-to-text
wire contract and bounds, and actual stdio cancellation/EOF against a hanging
loopback HTTP fixture. CI installs this package separately and runs these tests.

The original local prototype was exercised on an Apple Silicon Mac with
128 GiB RAM and Ollama 0.34.3 on 2026-09-23. Qwen3.5 4B's installed digest was
`2a654d98e6fba55d452b7043684e9b57a947e393bbffa62485a7aac05ee4eefd`; its vision
capability was confirmed. These observations apply to that setup, not every
machine or image:

| Check                                                      | Observed result                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Known chart title, labels, values, colors, and review code | All requested answers correct                                              |
| One cold and three warm chart inspections                  | 18.32 s cold; 2.01, 1.81, 1.76 s warm                                      |
| Full-page screenshot with chart and form controls          | Requested values correct; 4.98 s                                           |
| Matched Nemotron text probes before/after vision           | Median 175.81 -> 175.93 tokens/s; no eviction                              |
| Installed Coral discovery and trust                        | All twelve tools admitted; yolo worked after ask-mode trust                |
| Combined browser flow                                      | Screenshot -> image interpretation -> button click -> verified page status |
| Interruption and shutdown                                  | Helper retired, unrelated tabs and Nemotron preserved                      |

Nemotron needed to correct an invalid prose click target and continued despite
a stop-on-error instruction. Qwen correctly read the requested full-page values
but added an incorrect positional detail about the review code. Vision answers
can be wrong; verify consequential details. Dense documents, sustained
concurrency, and unfamiliar images were not benchmarked. The checked-in copy
preserves that helper behavior; raw local session records, screenshots, and
machine configuration are intentionally excluded.

Chrome extension uploads failed with `DOM.setFileInputFiles: Not allowed` during
the browser prototype; this helper does not fix that limitation. Clipboard
paste, native image attachments, PDF parsing, and TUI attachment indicators are
not implemented.

To repeat live acceptance, use a local synthetic page containing controls and a
canvas chart whose answers are absent from accessibility snapshots. Verify the
known values independently, record one cold and three warm calls, compare three
matched main-model text probes before/after, and confirm interruption/shutdown
without closing unrelated tabs or unloading models. The original gate required
every warm call under 30 seconds, correct predefined answers, no main-model
eviction, and no greater than 20% regression in median warm generation rate.

To disable the integration, remove only its `images` server entry and restart
Coral. Preserve other settings, user images, and models unless you intend to
remove them separately.
