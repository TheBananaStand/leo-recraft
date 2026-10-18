# leo-recraft

Recraft as a Leo package, over MCP — image generation, vectorizing and
background removal, from [Recraft](https://recraft.ai).

This replaces the compiled `leo-recraft` package, and is the first extracted
package that is **both** a tool provider and a subsystem provider:

- It fills Leo's **`image_gen` provider role**, which is what the gallery calls
  when something asks Leo for an image. The gallery does the database write
  (`leo-gallery/src/api.rs`); this server only produces bytes.
- It keeps the **three tools** the compiled package exposed, for an agent
  driving Recraft directly.

## Tools

| Tool | Requires | What it is |
|---|---|---|
| `generate` | `prompt` | The `image_gen` role. Returns base64; the gallery files it. |
| `recraft_generate` | `prompt` | Recraft's own vocabulary — model, style, size, palette. Returns paths. |
| `recraft_vectorize` | `image_path` | Raster → SVG. |
| `recraft_remove_background` | `image_path` | Cut-out PNG. |

`generate` and `recraft_generate` are separate on purpose rather than one tool
wearing two hats. The role has a fixed contract Leo depends on — prompt in,
base64 out — while the tool carries Recraft's models, styles and palettes, which
are far wider than the role and change with the vendor.

## Configuration

One setting, `recraft_api_key`. Leo hands it to this process under that key
**verbatim and lower-case**, so the descriptor's `settings_read` and
`process.env.recraft_api_key` have to agree or the credential silently never
arrives.

## Development

```bash
npm install
node test.js        # no network needed
```

The test covers what fails *quietly* — the API's own errors are loud:

- **The palette.** `parseInt("zz", 16)` is `NaN`, which serializes to `null` and
  either fails the request or renders a different palette than the one asked
  for. One typo among good colours renders in the good ones; a palette where
  *nothing* parsed sends no `controls` at all, rather than an empty array the
  API reads as "use no colours".
- **Absent vs empty.** Recraft's v4 models *reject* a `style` outright, so
  omitting the key and sending `""` are different requests.
- **The two response shapes.** `generations` answers `{data:[{url}]}`;
  `vectorize` and `removeBackground` answer `{image:{url}}`. Read one with the
  other's shape and you get nothing, silently — and a `data` that is present but
  not an array survives `?? []` and then throws on `.map`, turning a bad
  response into a crashed tool. (That one was a real bug, caught by this test.)
- **Error bodies.** Recraft's `message` is often empty, so a failure can be the
  whole of `{"code":"not_enough_credits","message":""}`. The known codes are
  spelled out as something the owner can act on (an account out of credits, a
  rejected key); unknown ones keep the vendor's words.

## Publishing

```bash
./store/publish.sh          # live
./store/publish.sh draft    # stage for review at admin.leoconnect.io
```
