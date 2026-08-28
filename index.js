#!/usr/bin/env node
//
// Recraft as a Leo package, over MCP — image generation, vectorizing and
// background removal.
//
// This is the first extracted package that is BOTH a tool provider and a
// subsystem provider, so it does two things at once:
//
//   • it fills the `image_gen` provider role, which is what Leo's own gallery
//     calls when something asks it for an image. The gallery does the database
//     write (`leo-gallery/src/api.rs`); this server only produces bytes.
//   • it keeps the three tools the compiled `leo-recraft` package exposed, for
//     an agent driving Recraft directly.
//
// `generate` (the role) and `recraft_generate` (the tool) are deliberately
// separate rather than one tool wearing two hats. The role has a fixed contract
// Leo depends on — prompt in, base64 out — while the tool carries Recraft's own
// vocabulary of models, styles and palettes, which is far wider than the role
// and changes with the vendor.
//
// Plain JavaScript: this ships as a git tarball, and npm does not reliably run
// build steps for a tarball URL.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";

const BASE = "https://external.api.recraft.ai/v1";

// Leo hands an entitled setting to the subprocess under its *settings key*,
// verbatim and lower-case — see `Entitlements::resolve_env_secrets`.
const SETTING_KEY = "recraft_api_key";

const DEFAULT_MODEL = "recraftv3";

// ---------------------------------------------------------------------------
// Pure helpers — where this server can be wrong without anything throwing
// ---------------------------------------------------------------------------

/**
 * `#RRGGBB` -> `{rgb: [r,g,b]}`, or undefined.
 *
 * Recraft takes a palette as integer triples, and a model writes hex. A
 * half-parsed colour is worse than none: `parseInt("zz", 16)` is NaN, which
 * serializes to `null` and has the API either reject the whole request or
 * quietly render a different palette than the one asked for.
 */
export function hexToRgb(hex) {
  if (typeof hex !== "string") return undefined;
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return undefined;
  return {
    rgb: [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ],
  };
}

/**
 * The JSON body for `/images/generations`.
 *
 * Absent stays absent: Recraft's v4 models reject a `style` outright, and
 * sending `null` for one is not the same as omitting it. Exported because this
 * mapping is the whole of what a wrong request looks like.
 */
export function generationBody({ prompt, model, style, size, n, colors }) {
  const body = {
    prompt,
    model: typeof model === "string" && model !== "" ? model : DEFAULT_MODEL,
    response_format: "url",
  };
  if (typeof style === "string" && style !== "") body.style = style;
  if (typeof size === "string" && size !== "") body.size = size;
  if (Number.isInteger(n) && n >= 1 && n <= 6) body.n = n;

  if (Array.isArray(colors)) {
    // Only the colours that actually parsed. A palette of one good hex and one
    // typo should render in the good one, not fail the whole generation.
    const parsed = colors.map(hexToRgb).filter(Boolean);
    if (parsed.length > 0) body.controls = { colors: parsed };
  }
  return body;
}

/**
 * `{data: [{url}]}` -> the urls.
 *
 * `Array.isArray` rather than `?? []`: a `data` that is present but not an
 * array — which is what an error body or a changed response shape looks like —
 * survives the nullish coalesce and then throws on `.map`, turning a bad
 * response into a crashed tool instead of an empty result.
 */
export function urlsFrom(payload) {
  const data = payload?.data;
  if (!Array.isArray(data)) return [];
  return data.map((d) => d?.url).filter((u) => typeof u === "string" && u !== "");
}

/** `{image: {url}}` -> the url. Vectorize and removeBackground share it. */
export function imageUrlFrom(payload) {
  const url = payload?.image?.url;
  return typeof url === "string" && url !== "" ? url : undefined;
}

// ---------------------------------------------------------------------------
// Recraft calls
// ---------------------------------------------------------------------------

function apiKey() {
  const key = process.env[SETTING_KEY] ?? "";
  if (!key) {
    throw new Error(
      `No ${SETTING_KEY} configured. Add it in Settings → Packages → Recraft.`,
    );
  }
  return key;
}

async function recraft(path, init) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey()}`, ...init.headers },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Recraft API ${response.status}: ${detail.slice(0, 200)}`);
  }
  return await response.json();
}

async function postJson(path, body) {
  return recraft(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Multipart upload — vectorize and removeBackground take the same shape. */
async function postImage(path, imagePath) {
  const bytes = await readFile(imagePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), basename(imagePath));
  form.append("response_format", "url");
  return recraft(path, { method: "POST", body: form });
}

/** Recraft hands back a URL; the role's contract is bytes. */
async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch the generated image (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Save a result next to the others and return the path.
 *
 * The compiled package wrote into Leo's data dir and returned a path. This one
 * has no data dir, so it uses a temp directory — the point is the same, that a
 * multi-megabyte image should not travel back through the model's context as
 * base64 when the caller only wants somewhere to find it.
 */
async function saveToTemp(bytes, ext) {
  const dir = join(tmpdir(), "leo-recraft");
  await mkdir(dir, { recursive: true });
  // Named from the content, so the same image twice is the same file rather
  // than two — and no clock is needed, which keeps this testable.
  const { createHash } = await import("node:crypto");
  const stamp = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const path = join(dir, `recraft-${stamp}${ext}`);
  await writeFile(path, bytes);
  return path;
}

const TOOLS = {
  // ── the `image_gen` provider role ─────────────────────────────────────────
  generate: {
    description:
      "Generate an image from a prompt. Fills Leo's image-generation role; " +
      "the gallery files the result.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: { type: "string", description: "WxH, e.g. 1024x1024." },
        quality: { type: "string" },
        // Hints the hub forwards when the caller had a preference. Optional by
        // design — a caller with no opinion sends neither and gets the default.
        model: { type: "string", description: "Recraft model id." },
        style: { type: "string", description: "Recraft style name." },
      },
      required: ["prompt"],
    },
    run: async ({ prompt, size, model, style }) => {
      const answer = await postJson(
        "/images/generations",
        generationBody({ prompt, size, model, style }),
      );
      const [url] = urlsFrom(answer);
      if (!url) throw new Error("Recraft returned no image URL");
      const bytes = await fetchBytes(url);
      // The format is read from the model that was actually used, not assumed:
      // a `_vector` model answers with SVG, and the caller rasterizes on the
      // strength of this field. Saying "png" for an SVG produces a file that is
      // named right and cannot be decoded.
      const isVector = typeof model === "string" && model.endsWith("_vector");
      return {
        image_base64: bytes.toString("base64"),
        format: isVector ? "svg" : "png",
      };
    },
  },

  // ── Recraft's own vocabulary ──────────────────────────────────────────────
  recraft_generate: {
    description:
      "Generate images with Recraft — raster or vector, with model, style, " +
      "size and palette control. Returns file paths.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the image." },
        model: {
          type: "string",
          description:
            "_vector suffix models output SVG. Icons/pictograms: " +
            "recraftv2_vector with an icon style. Default: recraftv3.",
        },
        style: {
          type: "string",
          description:
            "V3 raster: Photorealism, Illustration, Hand-drawn, Pixel art. " +
            "V3 vector: Vector art, Line art, Engraving. V2 vector: Icon, " +
            "Outline, Pictogram, Flat 2.0. V4 models do not support styles.",
        },
        size: { type: "string", description: "WxH ('1024x1024') or a ratio ('16:9')." },
        n: { type: "integer", minimum: 1, maximum: 6, description: "How many. Default 1." },
        colors: {
          type: "array",
          items: { type: "string" },
          description: "Palette as hex codes, e.g. ['#FF5733', '#1A1A2E'].",
        },
      },
      required: ["prompt"],
    },
    run: async (a) => {
      const answer = await postJson("/images/generations", generationBody(a));
      const urls = urlsFrom(answer);
      if (urls.length === 0) throw new Error("Recraft returned no image URLs");
      const vector = typeof a.model === "string" && a.model.endsWith("_vector");
      const paths = [];
      for (const url of urls) {
        paths.push(await saveToTemp(await fetchBytes(url), vector ? ".svg" : ".png"));
      }
      return { paths, urls };
    },
  },

  recraft_vectorize: {
    description: "Convert a raster image (PNG/JPG/WEBP) to SVG. Returns the SVG path.",
    inputSchema: {
      type: "object",
      properties: { image_path: { type: "string" } },
      required: ["image_path"],
    },
    run: async ({ image_path }) => {
      const answer = await postImage("/images/vectorize", image_path);
      const url = imageUrlFrom(answer);
      if (!url) throw new Error("Recraft returned no vectorized image");
      return { path: await saveToTemp(await fetchBytes(url), ".svg"), url };
    },
  },

  recraft_remove_background: {
    description: "Remove an image's background. Returns the path to the cut-out PNG.",
    inputSchema: {
      type: "object",
      properties: { image_path: { type: "string" } },
      required: ["image_path"],
    },
    run: async ({ image_path }) => {
      const answer = await postImage("/images/removeBackground", image_path);
      const url = imageUrlFrom(answer);
      if (!url) throw new Error("Recraft returned no image");
      const ext = extname(image_path) === ".jpg" ? ".png" : ".png";
      return { path: await saveToTemp(await fetchBytes(url), ext), url };
    },
  },
};

export function missingRequired(name, args) {
  const required = TOOLS[name]?.inputSchema?.required ?? [];
  return required.filter((k) => {
    const v = args?.[k];
    return v === undefined || v === null || v === "";
  });
}

const server = new Server(
  { name: "leo-recraft-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = TOOLS[name];
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
  const missing = missingRequired(name, args);
  if (missing.length > 0) {
    return {
      isError: true,
      content: [{ type: "text", text: `${name} requires: ${missing.join(", ")}` }],
    };
  }
  try {
    return { content: [{ type: "text", text: JSON.stringify(await tool.run(args ?? {})) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: String(error?.message ?? error) }],
    };
  }
});

if (process.env.LEO_RECRAFT_MCP_NO_SERVE !== "1") {
  await server.connect(new StdioServerTransport());
}
