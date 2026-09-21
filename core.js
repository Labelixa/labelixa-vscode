/**
 * The CORE of the Labelixa VS Code extension.
 *
 * This file does NOT know about, and never imports, the `vscode` module.
 * The reason is testability: every decision the extension makes (which
 * label the cursor is in, which editor range a server finding maps to,
 * which endpoint is called) lives here and can be run against the real
 * API. `extension.js` is glue only: it binds the VS Code API to these
 * functions and makes no decisions of its own.
 *
 * Why there is no dependency on the `labelixa` npm SDK: the SDK is ESM
 * (`"type": "module"`) while the VS Code extension host loads CommonJS;
 * taking the dependency would mean adding a bundler to the repository. The
 * price is a second client, kept small in two ways: (1) only two endpoints
 * live here, a subset of the SDK; (2) the repository tests lock the path
 * strings to the SDK's, so a contract drift breaks a test instead of
 * silently rotting the published extension.
 */
"use strict";

const wire = require("./contract");   // the API's own field names

const DEFAULT_BASE_URL = "https://api.labelixa.com";

/** Path templates SHARED with the SDK (locked by the repository tests). */
const RENDER_PATH = (dpmm, w, h, i) => `/v1/printers/${dpmm}dpmm/labels/${w}x${h}/${i}`;
const DIAGNOSTICS_PATH = "/v1/diagnostics";
const COMMANDS_PATH = "/v1/commands";

/** Python `:g` format: 4.0 -> "4", 2.25 -> "2.25" (same rule as the SDK). */
const g = (n) => String(Number(n));

// ─────────────────────────────────────────────── the cursor's block ──

/**
 * Returns the ^XA…^XZ blocks in the text WITH their source offsets.
 *
 * Two rules match the rendering engine, both deliberate:
 *
 * 1. **A second ^XA RESTARTS the block.** `^XA…^XA…^XZ` is one block whose
 *    start is the LAST ^XA. Treating the first ^XA as the start would send
 *    a preview body containing commands the printer would never print.
 * 2. **The caret is fixed (`^`).** The engine's tokenizer works the same
 *    way and does not support changing the caret with ^CC, so searching
 *    for the literal `^XA` here adds no second source of truth.
 *
 * ONE deliberate difference: an unterminated last block. The engine drops
 * it (nothing is emitted before ^XZ). Here it is returned with
 * `closed: false` instead — the user may still be TYPING the label, and
 * answering "nothing here" would leave the preview silently dead while
 * writing. The extension sees the flag and says "^XZ missing" rather than
 * attempting a preview.
 *
 * @param {string} text document body
 * @returns {{start:number, end:number, closed:boolean}[]}
 */
function labelBlocks(text) {
  const re = /\^(XA|XZ)/gi;
  const out = [];
  let start = -1;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1].toUpperCase() === "XA") {
      start = m.index;                       // restart (same as the engine)
    } else if (start !== -1) {
      out.push({ start, end: m.index + m[0].length, closed: true });
      start = -1;
    }
  }
  if (start !== -1) out.push({ start, end: text.length, closed: false });
  return out;
}

/**
 * Returns the block the cursor is INSIDE; `null` when it is in none.
 *
 * `null` is deliberate: picking the nearest block would let the user look
 * at ANOTHER label while believing they are editing it. Between two blocks
 * the honest answer is "I do not know which one".
 *
 * The upper bound is INCLUSIVE (`offset <= end`): a user who has just
 * typed `^XZ` with the cursor right after it is still inside that label.
 *
 * @param {string} text
 * @param {number} offset cursor character offset
 * @returns {{start:number, end:number, closed:boolean, body:string}|null}
 */
function blockAt(text, offset) {
  for (const b of labelBlocks(text)) {
    if (offset >= b.start && offset <= b.end) {
      return { ...b, body: text.slice(b.start, b.end) };
    }
  }
  return null;
}

// ─────────────────────────────────────────── finding → editor range ──

/**
 * Converts a server finding's position to what VS Code expects.
 *
 * The server reports 1-BASED line/column, VS Code wants 0-BASED. Passing
 * the numbers through unchanged would paint every finding one line down
 * and one column right — a defect nobody would report as an error, but
 * every marker would sit in the wrong place.
 *
 * When `end_line`/`end_col` are absent the start is used: a zero-length
 * range is still visible in VS Code, whereas an invented width would
 * claim a precision that does not exist.
 */
function toRange(finding) {
  const line = Math.max(0, (finding.line || 1) - 1);
  const col = Math.max(0, (finding.col || 1) - 1);
  const endLine = Math.max(0, (finding.end_line || finding.line || 1) - 1);
  const endCol = Math.max(0, (finding.end_col || finding.col || 1) - 1);
  return { line, col, endLine, endCol };
}

/**
 * Maps the server severity to the numeric VS Code `DiagnosticSeverity`.
 *
 * A number is returned because this file does not import `vscode`. An
 * unknown severity falls back to WARNING, not error: if the server adds a
 * new class one day the extension must neither over-dramatise it nor hide
 * it.
 */
function severity(value) {
  switch (String(value || "").toLowerCase()) {
    case "error": return 0;         // vscode.DiagnosticSeverity.Error
    case "warning": return 1;       // Warning
    case "info": return 2;          // Information
    default: return 1;
  }
}

// ───────────────────────────────────────────────────── quick-fix edit ──

/**
 * Normalises a finding's `quickfix` into one editor edit; `null` when the
 * finding carries none.
 *
 * The server's model is deliberately small: replace the character range
 * `[offset, end_offset)` with `yeni` (an insertion is `offset ===
 * end_offset`). Two rules are enforced HERE rather than trusted:
 *
 * 1. **Offsets are validated against the text that was linted.** The
 *    extension sends the WHOLE document, so a server offset is a document
 *    offset — but an out-of-range offset would make VS Code throw while
 *    applying the edit, and a thrown edit looks to the user like the
 *    quick-fix silently did nothing. An unusable range yields `null`.
 * 2. **A missing title is not invented.** The title is localised by the
 *    server (`contract.js` names the field); when it is absent the caller gets `null` and shows no action,
 *    because an unlabelled quick-fix asks the user to accept a change they
 *    cannot read.
 */
function quickfixEdit(finding, textLength) {
  const q = finding && finding[wire.FIX];
  if (!q || !q[wire.FIX_TITLE]) return null;
  const start = Number(q[wire.FIX_START]);
  const end = Number(q[wire.FIX_END]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end < start) return null;
  if (Number.isInteger(textLength) && end > textLength) return null;
  return { start, end, newText: String(q[wire.FIX_TEXT] ?? ""),
           title: q[wire.FIX_TITLE] };
}

/**
 * Turns a diagnostics response into the normalised list the editor draws.
 *
 * Everything that is a DECISION happens here, so it is tested: which text
 * the marker carries, where it sits, how severe it is, and whether it has a
 * usable quick-fix. `extension.js` only converts these plain objects into
 * `vscode.Diagnostic` / `vscode.CodeAction`.
 *
 * The message falls back to the key and then the rule code (the field
 * names are in `contract.js`). The last two are
 * not pretty, but an empty marker would be worse: the user would see a
 * squiggle with nothing to read and could not even search for the rule.
 */
function prepareFindings(report, textLength) {
  return ((report && report[wire.FINDINGS]) || []).map((f) => ({
    range: toRange(f),
    message: f[wire.MESSAGE] || f[wire.MESSAGE_KEY] || f.code || "",
    code: f.code,
    severity: severity(f.severity),
    fix: quickfixEdit(f, textLength),
  }));
}

// ────────────────────────────────────────────── command under cursor ──

/** Command codes are `^XX` or `~XX` — the caret/tilde plus TWO characters. */
const CODE_RE = /[\^~][0-9A-Za-z]{2}/g;

/**
 * Returns the command code the offset sits on, upper-cased, or `null`.
 *
 * Why a scan and not a regex anchored at the cursor: the user hovers
 * anywhere over `^FO50,50` — on the caret, on the `F`, on the `O` — and all
 * three must answer `FO`. A parameter (`50,50`) answers `null` rather than
 * the preceding command: hovering a number and being told about `^FO` would
 * suggest the number itself is documented.
 *
 * The code is returned WITHOUT its prefix because that is how the API's
 * command list keys them (`kod: "XA"`), measured, not assumed.
 */
function commandAt(text, offset) {
  CODE_RE.lastIndex = 0;
  let m;
  while ((m = CODE_RE.exec(text)) !== null) {
    if (offset >= m.index && offset < m.index + m[0].length) {
      return m[0].slice(1).toUpperCase();
    }
  }
  return null;
}

/**
 * Builds the hover text for one command record.
 *
 * Returns `null` for an unknown code — an empty hover box is worse than no
 * hover at all, because it reads as "documented, but nothing to say".
 *
 * `destekleniyor: false` is printed EXPLICITLY. The command list covers the
 * ZPL dictionary, not only what the renderer draws; a user hovering a
 * command the preview ignores must learn that here rather than from a blank
 * label later.
 */
function hoverMarkdown(commands, code) {
  const c = (commands || []).find((x) => String(x[wire.COMMAND_CODE] || "")
    .toUpperCase() === String(code || "").toUpperCase());
  if (!c) return null;
  const lines = [`**^${c[wire.COMMAND_CODE]}** — ${c[wire.COMMAND_NAME]}`];
  if (c[wire.COMMAND_TEXT]) lines.push("", c[wire.COMMAND_TEXT]);
  if (c[wire.COMMAND_FORMAT]) lines.push("", "`" + c[wire.COMMAND_FORMAT] + "`");
  const params = (c[wire.COMMAND_PARAMS] || []).map(
    (p) => `- \`${p[wire.COMMAND_NAME] || p}\`` +
           (p[wire.COMMAND_TEXT] ? " — " + p[wire.COMMAND_TEXT] : ""));
  if (params.length) lines.push("", ...params);
  if (c[wire.COMMAND_RENDERED] === false) {
    lines.push("", "_Not rendered by the preview engine._");
  }
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────── preview page ──

/**
 * The preview webview's HTML.
 *
 * It lives here, away from the `vscode` module, for the same reason as
 * everything else in this file: it is a decision (pixelated scaling so the
 * user sees the printer's real dots, white paper behind the label, the
 * editor's own background around it) and decisions are tested.
 *
 * The image is a `data:` URL, so the webview needs no network and no local
 * resource roots.
 */
function previewHtml(dataUrl, title) {
  const safe = String(title).replace(/[<>"&]/g, "");
  return `<!doctype html><meta charset="utf-8">
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;
background:var(--vscode-editor-background)}
img{max-width:100%;image-rendering:pixelated;background:#fff}</style>
<img alt="${safe}" src="${dataUrl}">`;
}

/**
 * Calls `fn` only after `ms` of quiet — the lint-while-typing gate.
 *
 * Without it every keystroke is a request, and the anonymous tier's limit
 * is 3 requests per second: the user would collect 429 warnings instead of
 * findings, i.e. a feature that punishes typing. The timer handle is kept
 * in a closure so a later call cancels the pending one.
 */
function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return wrapped;
}

// ──────────────────────────────────────────────────────────── client ──

class LabelixaError extends Error {
  constructor(status, serverMessage) {
    super(`HTTP ${status}: ${serverMessage}`);
    this.name = "LabelixaError";
    this.status = status;
    this.serverMessage = serverMessage;
    /** 402/429: quota or rate limit — callers must be able to tell. */
    this.quota = status === 402 || status === 429;
    this.retryAfter = 0;
  }
}

class Client {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey] `lbx_…`; omit for anonymous (free, rate limited) use
   * @param {string} [opts.baseUrl]
   * @param {typeof fetch} [opts.fetch] test hook
   * @param {string} [opts.version] extension version written to the User-Agent
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl,
                version = "0.0.0" } = {}) {
    this._baseUrl = String(baseUrl).replace(/\/+$/, "");
    this._fetch = fetchImpl || globalThis.fetch;
    this._headers = { "User-Agent": `labelixa-vscode/${version}` };
    if (apiKey) this._headers["X-API-Key"] = apiKey;
  }

  async _get(path) {
    const res = await this._fetch(this._baseUrl + path, {
      method: "GET", headers: this._headers,
    });
    if (res.status !== 200) {
      const text = (await res.text()).slice(0, 500);
      throw new LabelixaError(res.status, text);
    }
    return res;
  }

  async _post(path, body, extra = {}) {
    const res = await this._fetch(this._baseUrl + path, {
      method: "POST",
      headers: { ...this._headers, "Content-Type": "text/plain", ...extra },
      body,
    });
    if (res.status !== 200) {
      const text = (await res.text()).slice(0, 500);
      const err = new LabelixaError(res.status, text);
      if (err.quota) {
        const raw = res.headers.get("Retry-After");
        const n = Number.parseInt(raw || "60", 10);
        err.retryAfter = Number.isNaN(n) ? 60 : n;
      }
      throw err;
    }
    return res;
  }

  /**
   * Renders a single label to PNG. This CONSUMES label quota — which is
   * why the extension calls it only when the user explicitly asks, never
   * on a keystroke (see `extension.js`).
   */
  async renderPng(zpl, { dpmm = 8, widthIn = 4, heightIn = 6, index = 0 } = {}) {
    const res = await this._post(
      RENDER_PATH(dpmm, g(widthIn), g(heightIn), index), zpl);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Lints ZPL; returns the positioned findings.
   *
   * Does NOT consume label quota (only the rate limit) — the API contract
   * says so explicitly, so an editor can lint on every save.
   */
  async diagnostics(zpl, { dpmm = 8, widthIn = 4, heightIn = 6 } = {}) {
    const q = `?dpmm=${dpmm}&w=${g(widthIn)}&h=${g(heightIn)}`;
    const res = await this._post(DIAGNOSTICS_PATH + q, zpl);
    return JSON.parse(await res.text());
  }

  /**
   * The ZPL command dictionary, for hover help.
   *
   * Does NOT consume label quota. The list is the same one the website's
   * command pages are built from, so hover help and the public reference
   * cannot drift apart.
   *
   * `locale` is passed explicitly rather than left to the server's
   * `Referer`/cookie guess: an editor has neither, and the server would
   * silently answer in English while the user reads Turkish elsewhere.
   */
  async commands(locale = "en") {
    const res = await this._get(`${COMMANDS_PATH}?lang=${encodeURIComponent(locale)}`);
    const data = JSON.parse(await res.text());
    return data[wire.COMMAND_LIST] || [];
  }
}

module.exports = {
  DEFAULT_BASE_URL, RENDER_PATH, DIAGNOSTICS_PATH, COMMANDS_PATH,
  labelBlocks, blockAt, toRange, severity,
  quickfixEdit, prepareFindings, commandAt, hoverMarkdown,
  previewHtml, debounce,
  Client, LabelixaError,
};
