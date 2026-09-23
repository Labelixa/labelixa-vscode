/**
 * Labelixa VS Code extension — the GLUE layer.
 *
 * No decisions here; they all live in `core.js`, which is tested against
 * the real API. This file only binds the VS Code API to those functions.
 * The split is deliberate: the extension host (`vscode` module) cannot be
 * imitated outside VS Code, so this layer is the UNTESTED surface — and
 * for that reason it is kept as thin as possible. Every line that is not
 * thin is a decision nobody tests.
 *
 * Quota honesty (the most important rule in this file): `diagnostics`
 * (lint), `commands` (hover) and quick-fix do NOT consume label quota;
 * `renderPng` (preview) DOES. Lint may therefore run while typing, but the
 * PREVIEW IS NEVER AUTOMATIC: a request goes out only when the user runs
 * the `labelixa.onizle` command. An extension that rendered on every change
 * would burn the user's monthly quota without them noticing.
 *
 * The command identifiers `labelixa.onizle` and `labelixa.denetle` are a
 * published interface (users bind keys to them); they are kept as they are.
 * Identifiers added later are English.
 *
 * The API key lives in `SecretStorage`, never in settings. See `keyOf`.
 */
"use strict";

const vscode = require("vscode");
const core = require("./core");

const SOURCE = "labelixa";
const SECRET_KEY = "labelixa.apiKey";
const TYPING_DELAY_MS = 700;

function settings() {
  const cfg = vscode.workspace.getConfiguration("labelixa");
  return {
    baseUrl: cfg.get("baseUrl") || core.DEFAULT_BASE_URL,
    dpmm: cfg.get("dpmm") || 8,
    widthIn: cfg.get("widthIn") || 4,
    heightIn: cfg.get("heightIn") || 6,
    lintOnSave: cfg.get("lintOnSave") !== false,
    lintWhileTyping: cfg.get("lintWhileTyping") !== false,
  };
}

/**
 * Reads the key from SecretStorage, migrating a legacy plain setting once.
 *
 * The migration is not politeness: until 0.1.3 the key was an ordinary
 * setting, which meant it could be written into a workspace's
 * `.vscode/settings.json` and committed, or carried to other machines by
 * Settings Sync. Leaving it in place would keep that exposure alive, so the
 * value is moved into SecretStorage and the setting is CLEARED — globally
 * and, when present, at workspace level too.
 */
async function keyOf(secrets) {
  const stored = await secrets.get(SECRET_KEY);
  if (stored) return stored;
  const cfg = vscode.workspace.getConfiguration("labelixa");
  const legacy = cfg.get("apiKey");
  if (!legacy) return "";
  await secrets.store(SECRET_KEY, legacy);
  for (const target of [vscode.ConfigurationTarget.Global,
                        vscode.ConfigurationTarget.Workspace]) {
    try { await cfg.update("apiKey", undefined, target); } catch (e) { void e; }
  }
  vscode.window.showInformationMessage(
    "Labelixa: the API key was moved from settings into the secret store.");
  return legacy;
}

async function client(ctx) {
  const s = settings();
  return new core.Client({
    apiKey: await keyOf(ctx.secrets), baseUrl: s.baseUrl,
    version: ctx.extension?.packageJSON?.version || "0.0.0",
  });
}

/** Shows the error with the SERVER's own sentence. */
function reportError(e) {
  if (e instanceof core.LabelixaError && e.quota) {
    vscode.window.showWarningMessage(
      `Labelixa: ${e.serverMessage} (${e.retryAfter}s)`);
  } else {
    vscode.window.showErrorMessage(`Labelixa: ${e.message}`);
  }
}

// ───────────────────────────────────────────────────────────── lint ──

async function lint(document, ctx, state) {
  if (document.languageId !== "zpl") return;
  const s = settings();
  const text = document.getText();
  let report;
  try {
    // The WHOLE document is sent, not the cursor's block, so the server's
    // line/column is exactly the editor's line/column AND a quick-fix
    // offset is a document offset; sending a block and shifting offsets
    // would create a classic off-by-N risk for no gain.
    report = await (await client(ctx)).diagnostics(text, {
      dpmm: s.dpmm, widthIn: s.widthIn, heightIn: s.heightIn,
    });
  } catch (e) {
    // When the server cannot be reached the OLD markers are KEPT: a
    // transient 429 must not clear the findings the user sees and suggest
    // the code is now clean.
    reportError(e);
    return;
  }
  const fixes = [];
  const diagnostics = core.prepareFindings(report, text.length).map((f) => {
    const d = new vscode.Diagnostic(
      new vscode.Range(f.range.line, f.range.col, f.range.endLine, f.range.endCol),
      f.message, f.severity);
    // With a rule page the code becomes a link in the Problems panel.
    d.code = f.url ? { value: f.code, target: vscode.Uri.parse(f.url) } : f.code;
    d.source = SOURCE;
    if (f.fix) fixes.push({ diagnostic: d, fix: f.fix });
    return d;
  });
  state.collection.set(document.uri, diagnostics);
  state.fixes.set(document.uri.toString(), fixes);
}

/** Quick-fixes come from the LAST lint, never from a fresh request. */
const fixProvider = (state) => ({
  provideCodeActions(document, range) {
    const out = [];
    for (const { diagnostic, fix } of state.fixes.get(document.uri.toString()) || []) {
      if (!diagnostic.range.intersection(range)) continue;
      const a = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
      a.diagnostics = [diagnostic];
      a.edit = new vscode.WorkspaceEdit();
      a.edit.replace(document.uri, new vscode.Range(
        document.positionAt(fix.start), document.positionAt(fix.end)), fix.newText);
      out.push(a);
    }
    return out;
  },
});

/** Hover help. The dictionary is fetched ONCE per session and cached. */
const hoverProvider = (ctx, state) => ({
  async provideHover(document, position) {
    const code = core.commandAt(document.getText(), document.offsetAt(position));
    if (!code) return null;
    if (!state.commands) {
      try {
        state.commands = await (await client(ctx)).commands(vscode.env.language || "en");
      } catch (e) { void e; return null; }   // hover stays silent on failure
    }
    const md = core.hoverMarkdown(state.commands, code);
    return md ? new vscode.Hover(new vscode.MarkdownString(md)) : null;
  },
});

// ────────────────────────────────────────────────────────── preview ──

async function preview(ctx, panelBox) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "zpl") return;
  const text = ed.document.getText();
  const block = core.blockAt(text, ed.document.offsetAt(ed.selection.active));
  if (!block) {
    // We do not "show the nearest label": the user would look at ANOTHER
    // label while believing they are editing it.
    vscode.window.showInformationMessage(
      "Labelixa: the cursor is not inside a ^XA…^XZ label.");
    return;
  }
  if (!block.closed) {
    vscode.window.showInformationMessage(
      "Labelixa: this label has no ^XZ yet — the printer would not print it.");
    return;
  }
  const s = settings();
  let png;
  try {
    png = await (await client(ctx)).renderPng(block.body, {
      dpmm: s.dpmm, widthIn: s.widthIn, heightIn: s.heightIn,
    });
  } catch (e) {
    reportError(e);
    return;
  }
  const dataUrl = "data:image/png;base64," + Buffer.from(png).toString("base64");
  if (!panelBox.panel) {
    panelBox.panel = vscode.window.createWebviewPanel(
      "labelixaPreview", "Labelixa preview", vscode.ViewColumn.Beside, {});
    panelBox.panel.onDidDispose(() => { panelBox.panel = null; });
  }
  panelBox.panel.webview.html = core.previewHtml(dataUrl, "ZPL label preview");
  panelBox.panel.reveal(vscode.ViewColumn.Beside, true);
}

// ──────────────────────────────────────────────────────── key commands ──

async function setKey(secrets) {
  const v = await vscode.window.showInputBox({
    prompt: "Labelixa API key (lbx_…). Leave empty to use the anonymous tier.",
    password: true, ignoreFocusOut: true,
  });
  if (v === undefined) return;                      // cancelled
  if (v) await secrets.store(SECRET_KEY, v);
  else await secrets.delete(SECRET_KEY);
  vscode.window.showInformationMessage(
    v ? "Labelixa: API key saved to the secret store."
      : "Labelixa: API key removed; anonymous tier will be used.");
}

// ───────────────────────────────────────────────────────── activation ──

function activate(context) {
  const state = {
    collection: vscode.languages.createDiagnosticCollection(SOURCE),
    fixes: new Map(),
    commands: null,
  };
  const panelBox = { panel: null };
  const lintSoon = core.debounce(
    (d) => lint(d, context, state), TYPING_DELAY_MS);
  context.subscriptions.push(state.collection);

  // Untrusted workspaces send NOTHING. The document may come from a
  // repository the user has only opened to read; shipping its contents to
  // a network service is exactly the class of act workspace trust exists
  // to gate. Commands stay registered so the user sees why nothing happens.
  const trusted = () => vscode.workspace.isTrusted;
  const guard = (fn) => (...a) => {
    if (!trusted()) {
      vscode.window.showWarningMessage(
        "Labelixa: this workspace is not trusted, so nothing is sent to the API.");
      return;
    }
    return fn(...a);
  };

  const selector = { language: "zpl" };
  context.subscriptions.push(
    vscode.commands.registerCommand("labelixa.onizle",
      guard(() => preview(context, panelBox))),
    vscode.commands.registerCommand("labelixa.denetle", guard(() => {
      const ed = vscode.window.activeTextEditor;
      if (ed) lint(ed.document, context, state);
    })),
    vscode.commands.registerCommand("labelixa.setApiKey",
      () => setKey(context.secrets)),
    vscode.languages.registerCodeActionsProvider(selector, fixProvider(state), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.languages.registerHoverProvider(selector, hoverProvider(context, state)),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (trusted() && settings().lintOnSave) lint(d, context, state);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!trusted() || !settings().lintWhileTyping) return;
      if (e.document.languageId === "zpl") lintSoon(e.document);   // debounced
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      state.collection.delete(d.uri);
      state.fixes.delete(d.uri.toString());
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
