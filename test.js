// Smoke test for the request building and response reading.
//
// The API call is Recraft's to get right and its errors are loud. What is
// silent is a palette that half-parsed, a `style` sent to a model that rejects
// it, or a response shape read one key off — each returns a plausible image
// that is not the one that was asked for.
//
//   node test.js

process.env.LEO_RECRAFT_MCP_NO_SERVE = "1";

const { hexToRgb, generationBody, urlsFrom, imageUrlFrom, missingRequired } =
  await import("./index.js");
const assert = await import("node:assert/strict");

// ── hex -> rgb ──────────────────────────────────────────────────────────────
{
  assert.deepEqual(hexToRgb("#FF5733"), { rgb: [255, 87, 51] });
  assert.deepEqual(hexToRgb("ff5733"), { rgb: [255, 87, 51] });
  assert.deepEqual(hexToRgb("  #1A1A2E "), { rgb: [26, 26, 46] });

  // A half-parse is the danger: parseInt("zz", 16) is NaN, which serializes to
  // null and either fails the request or renders a different palette.
  for (const bad of ["#zzzzzz", "#FFF", "#FF57333", "", "  ", null, 16711680, {}]) {
    assert.equal(hexToRgb(bad), undefined, `should not parse: ${JSON.stringify(bad)}`);
  }
}

// ── the generation body ─────────────────────────────────────────────────────
{
  // Defaults: model falls back, response_format is always url.
  const b = generationBody({ prompt: "a lighthouse" });
  assert.equal(b.prompt, "a lighthouse");
  assert.equal(b.model, "recraftv3");
  assert.equal(b.response_format, "url");
  // Absent stays absent — v4 models REJECT a style outright, and sending null
  // is not the same as omitting the key.
  assert.equal("style" in b, false);
  assert.equal("size" in b, false);
  assert.equal("n" in b, false);
  assert.equal("controls" in b, false);
}

{
  const b = generationBody({
    prompt: "an icon",
    model: "recraftv2_vector",
    style: "Icon",
    size: "1024x1024",
    n: 3,
    colors: ["#FF5733", "#1A1A2E"],
  });
  assert.equal(b.model, "recraftv2_vector");
  assert.equal(b.style, "Icon");
  assert.equal(b.size, "1024x1024");
  assert.equal(b.n, 3);
  assert.deepEqual(b.controls, {
    colors: [{ rgb: [255, 87, 51] }, { rgb: [26, 26, 46] }],
  });
}

{
  // One good hex and one typo should render in the good one, not fail the whole
  // generation — the model wrote both and only one of them is wrong.
  const b = generationBody({ prompt: "x", colors: ["#FF5733", "not-a-colour"] });
  assert.deepEqual(b.controls, { colors: [{ rgb: [255, 87, 51] }] });

  // But a palette where NOTHING parsed must send no `controls` at all, rather
  // than an empty array the API reads as "use no colours".
  const none = generationBody({ prompt: "x", colors: ["nope", "also nope"] });
  assert.equal("controls" in none, false);
}

{
  // `n` is bounded by the API at 1..6; out-of-range is dropped so the request
  // succeeds with the default rather than being rejected wholesale.
  for (const n of [0, 7, -1, 2.5, "3", null]) {
    assert.equal("n" in generationBody({ prompt: "x", n }), false, `n=${n}`);
  }
  assert.equal(generationBody({ prompt: "x", n: 1 }).n, 1);
  assert.equal(generationBody({ prompt: "x", n: 6 }).n, 6);
}

{
  // An empty string is not a value — it would send style:"" to a model that
  // reads it as a real, unknown style.
  const b = generationBody({ prompt: "x", model: "", style: "", size: "" });
  assert.equal(b.model, "recraftv3");
  assert.equal("style" in b, false);
  assert.equal("size" in b, false);
}

// ── response shapes ─────────────────────────────────────────────────────────
{
  // generations answers {data:[{url}]}; vectorize/removeBackground answer
  // {image:{url}}. Reading one with the other's shape yields nothing, silently.
  assert.deepEqual(urlsFrom({ data: [{ url: "https://a" }, { url: "https://b" }] }), [
    "https://a",
    "https://b",
  ]);
  assert.deepEqual(urlsFrom({ data: [{ url: "https://a" }, {}, { url: "" }] }), ["https://a"]);
  for (const junk of [{}, { data: null }, { data: "x" }, null, undefined]) {
    assert.deepEqual(urlsFrom(junk), []);
  }

  assert.equal(imageUrlFrom({ image: { url: "https://c" } }), "https://c");
  for (const junk of [{}, { image: {} }, { image: { url: "" } }, { data: [{ url: "x" }] }, null]) {
    assert.equal(imageUrlFrom(junk), undefined);
  }
}

// ── required params ─────────────────────────────────────────────────────────
{
  assert.deepEqual(missingRequired("generate", {}), ["prompt"]);
  assert.deepEqual(missingRequired("recraft_generate", {}), ["prompt"]);
  assert.deepEqual(missingRequired("recraft_vectorize", {}), ["image_path"]);
  assert.deepEqual(missingRequired("recraft_remove_background", {}), ["image_path"]);
  assert.deepEqual(missingRequired("generate", { prompt: "x" }), []);
}

console.log("ok — palette, request body and response shapes hold");
