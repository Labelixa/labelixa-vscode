/**
 * CORE smoke test of the VS Code extension.
 *
 * tests/test_vscode_eklentisi.py starts a real uvicorn and points this
 * script at it — the same pattern as the Node SDK. No mocked responses:
 * if the API contract drifts, the published extension does not rot
 * silently; it breaks here.
 *
 * `extension.js` is NOT part of this run: the `vscode` module exists only
 * inside the extension host. That is a deliberate boundary — that file is
 * glue only and carries no decisions.
 *
 * CommonJS (the extension host loads CJS), so no top-level `await`: the
 * asynchronous part lives in `main()`.
 */
"use strict";

const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const core = require("../core.js");

const baseUrl = process.argv[2];
assert.ok(baseUrl, "usage: node smoke.js http://127.0.0.1:PORT");

const ZPL = "^XA^FO20,20^A0N,30^FDVSCODE^FS^XZ";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP = 450;                       // anonymous rate limit 3/s

// ─────────────────────────────────────────── block lookup (pure logic) ──

function blockTests() {
  const text = "^XA^FDone^FS^XZ\n\n^XA^FDtwo^FS^XZ";

  assert.equal(core.blockAt(text, text.indexOf("one")).body, "^XA^FDone^FS^XZ");
  assert.equal(core.blockAt(text, text.indexOf("two")).body, "^XA^FDtwo^FS^XZ");
  assert.equal(core.blockAt(text, 0).body, "^XA^FDone^FS^XZ");

  // Gap BETWEEN blocks -> null. Picking the nearest one would let the user
  // look at ANOTHER label while believing they are editing it.
  assert.equal(core.blockAt(text, text.indexOf("\n\n") + 1), null,
               "invented a block from the gap");

  // Right AFTER ^XZ is still that label: the user has just typed ^XZ.
  assert.equal(core.blockAt(text, text.indexOf("^XZ") + 3).body,
               "^XA^FDone^FS^XZ");

  // A second ^XA RESTARTS the block (same as the engine). Treating the first
  // ^XA as the start would send commands the printer never prints.
  const nested = "^XA^FDdropped^FS^XA^FDvalid^FS^XZ";
  const b = core.blockAt(nested, nested.indexOf("valid"));
  assert.equal(b.body, "^XA^FDvalid^FS^XZ");
  assert.ok(!b.body.includes("dropped"), "dropped commands entered the body");

  // Lower case: the engine upper-cases command codes, so do we.
  const lower = "^xa^fdlower^fs^xz";
  assert.equal(core.blockAt(lower, 5).body, lower);

  // An unterminated block is NOT dropped but flagged closed=false. The
  // engine does not print it; the extension sees the flag and says
  // "^XZ missing" instead of showing an empty preview.
  const partial = "^XA^FDtyping";
  const p = core.blockAt(partial, partial.length);
  assert.equal(p.closed, false);
  assert.equal(p.body, partial);
}

// ─────────────────────────────── finding -> editor range (0-based) ──

function rangeTests() {
  // The server is 1-BASED, VS Code wants 0-BASED. Passing through unchanged
  // would put every marker one line down and one column right.
  assert.deepEqual(core.toRange({ line: 2, col: 1, end_line: 2, end_col: 4 }),
                   { line: 1, col: 0, endLine: 1, endCol: 3 });

  // Without an end the start is used; an invented width would claim a
  // precision that does not exist.
  assert.deepEqual(core.toRange({ line: 1, col: 5 }),
                   { line: 0, col: 4, endLine: 0, endCol: 4 });

  assert.equal(core.severity("error"), 0);
  assert.equal(core.severity("warning"), 1);
  assert.equal(core.severity("info"), 2);
  // Unknown severity falls back to WARNING: neither hidden nor exaggerated.
  assert.equal(core.severity("apocalypse"), 1);
}

// ────────────────────────────────── quick-fix, hover, preview page ──

function quickfixTests() {
  const ok = core.quickfixEdit(
    { quickfix: { baslik: "Add ^FS", offset: 3, end_offset: 3, yeni: "^FS" } }, 10);
  assert.deepEqual(ok, { start: 3, end: 3, newText: "^FS", title: "Add ^FS" });

  // No quickfix -> no action offered.
  assert.equal(core.quickfixEdit({ code: "ZPL1001" }, 10), null);

  // An offset PAST the linted text is refused. VS Code would throw while
  // applying such an edit, and a thrown edit reads to the user as "the
  // quick-fix silently did nothing".
  assert.equal(core.quickfixEdit(
    { quickfix: { baslik: "x", offset: 0, end_offset: 99, yeni: "a" } }, 10), null);

  // A title-less fix is NOT offered: the user cannot read what they accept.
  assert.equal(core.quickfixEdit(
    { quickfix: { offset: 0, end_offset: 1, yeni: "a" } }, 10), null);

  // prepareFindings carries the fix through and falls back for the message.
  const prepared = core.prepareFindings(
    { diagnostics: [{ line: 1, col: 1, code: "ZPL1001", severity: "error" }] }, 5);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].message, "ZPL1001");   // no `mesaj` -> code
  assert.equal(prepared[0].severity, 0);
  assert.equal(prepared[0].fix, null);
  assert.equal(prepared[0].url, null);          // no `url` -> no link

  // A rule page address is carried through; anything that is not http(s)
  // is dropped (the value comes from the network and becomes a link).
  const linked = core.prepareFindings({ diagnostics: [
    { line: 1, col: 1, code: "ZPL2001", severity: "warning",
      url: "https://labelixa.com/zpl/rules/ZPL2001" },
    { line: 1, col: 1, code: "ZPL2001", severity: "warning",
      url: "javascript:alert(1)" },
  ] }, 5);
  assert.equal(linked[0].url, "https://labelixa.com/zpl/rules/ZPL2001");
  assert.equal(linked[1].url, null);
}

function hoverTests() {
  const text = "^XA\n^FO50,50^FDx^FS\n^XZ";
  // Anywhere ON the code answers the code: the caret and both letters.
  const at = text.indexOf("^FO");
  assert.equal(core.commandAt(text, at), "FO");
  assert.equal(core.commandAt(text, at + 1), "FO");
  assert.equal(core.commandAt(text, at + 2), "FO");
  // A PARAMETER answers null. Saying "^FO" over the number 50 would suggest
  // the number itself is documented.
  assert.equal(core.commandAt(text, at + 3), null);
  // `~` commands count too.
  assert.equal(core.commandAt("~JC", 1), "JC");

  const list = [{ kod: "FO", ad: "Field Origin", aciklama: "Sets the origin.",
                  format: "^FOx,y", parametreler: [], destekleniyor: true },
                { kod: "JC", ad: "Calibrate", destekleniyor: false }];
  const md = core.hoverMarkdown(list, "FO");
  assert.ok(md.includes("Field Origin") && md.includes("^FOx,y"));
  // An unrendered command SAYS so — otherwise the user learns it from a
  // blank label instead.
  assert.ok(core.hoverMarkdown(list, "JC").includes("Not rendered"));
  // Unknown code -> no hover box at all; an empty box reads as
  // "documented, nothing to say".
  assert.equal(core.hoverMarkdown(list, "ZZ"), null);
}

function previewPageTest() {
  const html = core.previewHtml("data:image/png;base64,AAA", 'a"<b>');
  assert.ok(html.includes("image-rendering:pixelated"));
  assert.ok(!html.includes("<b>"), "title was not neutralised");
}

async function debounceTest() {
  let calls = 0;
  const f = core.debounce(() => { calls += 1; }, 30);
  f(); f(); f();
  await sleep(80);
  // Three keystrokes, ONE request: without this the anonymous 3/s limit
  // would answer typing with 429s.
  assert.equal(calls, 1, `debounce fired ${calls} times`);
}

// ───────────────────────────────────────── against the real application ──

async function endpointTests() {
  const client = new core.Client({ baseUrl, version: "0.1.0" });

  // Preview: the cursor's block is rendered to PNG
  const png = await client.renderPng(ZPL, { widthIn: 2, heightIn: 1 });
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47],
                   "no PNG signature");
  await sleep(GAP);

  // Lint: positioned structured report
  const report = await client.diagnostics("^XA\n^QQ^FDx^XZ");
  const finding = report.diagnostics.find((d) => d.code === "ZPL1001");
  assert.ok(finding, "ZPL1001 missing");
  // The line/column FIELDS really arrive — verified end to end so that
  // toRange() never runs on empty data.
  assert.equal(typeof finding.line, "number");
  assert.equal(typeof finding.col, "number");
  assert.equal(core.toRange(finding).line, finding.line - 1);
  await sleep(GAP);

  // The label size REALLY reaches the server: an invalid size must return
  // 400. With a wrong parameter name the server would ignore it silently
  // and lint against the 4x6 default — a wrong report for a 2x1 label.
  try {
    await client.diagnostics(ZPL, { widthIn: 999, heightIn: 999 });
    assert.fail("a 999 inch label should return 400 — size not sent");
  } catch (e) {
    assert.ok(e instanceof core.LabelixaError, `expected LabelixaError: ${e}`);
    assert.equal(e.status, 400);
  }
  await sleep(GAP);

  // Hover help: the command dictionary really arrives and really contains
  // the fields hoverMarkdown() reads. Measured, not assumed — a renamed
  // field would otherwise produce empty hover boxes in the published
  // extension.
  const commands = await client.commands("en");
  assert.ok(commands.length > 0, "empty command list");
  const fo = commands.find((c) => String(c.kod).toUpperCase() === "FO");
  assert.ok(fo, "^FO missing from the command list");
  assert.ok(core.hoverMarkdown(commands, "FO").includes(fo.ad));
  await sleep(GAP);

  // Quick-fix, end to end: a finding that carries one really does, and its
  // offsets really point inside the text that was linted.
  const broken = "^XA^FDmissing terminator\n^XZ";
  const fixReport = await client.diagnostics(broken);
  const withFix = core.prepareFindings(fixReport, broken.length)
    .find((f) => f.fix);
  assert.ok(withFix, "no finding carried a usable quick-fix");
  assert.ok(withFix.fix.start >= 0 && withFix.fix.end <= broken.length);
  await sleep(GAP);

  // Errors CARRY the server's own message (400: invalid density)
  try {
    await client.renderPng(ZPL, { dpmm: 7 });
    assert.fail("dpmm=7 should throw");
  } catch (e) {
    assert.ok(e instanceof core.LabelixaError, `expected LabelixaError: ${e}`);
    assert.equal(e.status, 400);
    assert.equal(e.quota, false);
    assert.ok(e.serverMessage.length > 0, "empty server text");
  }
}

// 429 -> quota flag + Retry-After. This single case uses a fake server:
// producing a real 429 would mean deliberately exhausting the quota.
async function quotaTest() {
  const fake = createServer((req, res) => {
    res.writeHead(429, { "Retry-After": "3600" });
    res.end("Monthly quota exhausted");
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  try {
    await new core.Client({ baseUrl: `http://127.0.0.1:${fake.address().port}` })
      .diagnostics(ZPL);
    assert.fail("429 should throw");
  } catch (e) {
    assert.ok(e instanceof core.LabelixaError);
    assert.equal(e.quota, true, "429 not flagged as quota");
    assert.equal(e.retryAfter, 3600);
  } finally {
    fake.close();
  }
}

async function headerTest() {
  const seen = {};
  const fakeFetch = async (url, opts) => {
    seen.key = opts.headers["X-API-Key"];
    seen.ua = opts.headers["User-Agent"];
    return new Response("{}", { status: 200 });
  };
  await new core.Client({ apiKey: "lbx_test", baseUrl: "http://x",
                          version: "9.9.9", fetch: fakeFetch }).diagnostics(ZPL);
  assert.equal(seen.key, "lbx_test");
  assert.equal(seen.ua, "labelixa-vscode/9.9.9");
}

async function main() {
  blockTests();
  rangeTests();
  quickfixTests();
  hoverTests();
  previewPageTest();
  await debounceTest();
  await endpointTests();
  await quotaTest();
  await headerTest();
  console.log("smoke ok: 9 groups passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
