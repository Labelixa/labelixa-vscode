#!/usr/bin/env node
/**
 * Publish guard: refuses to publish when a shipped file contains
 * internal ticket ids, non-English (Turkish) characters, common Turkish
 * words written in ASCII, or unreleased/audit markers. Runs from
 * `prepublishOnly` (npm) or `vscode:prepublish` (VS Code extension).
 *
 * Scanned: every file listed in package.json `files`, plus package.json
 * and CHANGELOG.md. When the manifest has no `files` list (VS Code
 * extensions ship everything not ignored), every text file under the
 * package root is scanned except node_modules, .git, test/ and scripts/.
 * The test/ directory is never scanned. This file defines the patterns and
 * is therefore not scanned itself.
 *
 * Usage: node scripts/check-publish.mjs [package-root]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TICKET = /\b(LBL-)?[A-Z]{3}-\d{3}\b/;
const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;
const MARKERS = ["yayımlanmadı", "denetim", "ölçüm"];
// ASCII-spelled Turkish words: the character rule cannot see them, and most
// leaks are written that way. Keep this list identical across the three
// packages (tests/test_paket_dili.py locks it). API response field names that
// must stay as-is (e.g. "kod", "komutlar", "ozet") are deliberately absent.
const WORDS = ["sunucu", "yanit", "hata", "hatasi", "kota", "dosya", "istek", "olcum", "denetim", "surum", "yayin", "uretilmedi", "uretildi", "kullanin", "gecersiz", "bilinmeyen", "baslik", "basliklar", "govde", "taban", "arac", "araclar", "sozlesme", "cikti", "girdi", "deger", "uyari", "kayit", "gecmis", "sonuc", "ornek", "yazici", "etiket", "dogrula", "donustur", "bekle", "olcu", "yol", "gerekce", "yorum"];
const WORD = new RegExp("\\b(?:" + WORDS.join("|") + ")\\b", "i");

// The ONE file exempt from the WORD rule, and only from that rule: the wire
// vocabulary. Some API field names are Turkish (`quickfix.baslik`,
// `komutlar`); they are protocol, so renaming them would not translate
// anything — it would stop the client reading the server's answer. The agent
// solves this the same way (one `contract.go`), and for the same reason: an
// exemption pinned to a single file keeps the rule alive everywhere else.
// Ticket ids, non-English characters and audit markers are STILL checked here.
const WORD_EXEMPT = new Set(["contract.js"]);

const SKIP_DIRS = new Set(["node_modules", ".git", "test", "scripts", "dist", "out"]);
const BINARY = new Set([".png", ".jpg", ".gif", ".ico", ".vsix", ".tgz", ".zip", ".whl"]);

const root = process.argv[2]
  ? process.argv[2]
  : join(dirname(fileURLToPath(import.meta.url)), "..");

function expand(entry) {
  const full = join(root, entry);
  let info;
  try { info = statSync(full); } catch { return []; }
  if (info.isDirectory()) {
    return readdirSync(full)
      .filter((name) => !SKIP_DIRS.has(name))
      .flatMap((name) => expand(join(entry, name)));
  }
  return BINARY.has(extname(full)) ? [] : [full];
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const files = new Set([
  join(root, "package.json"),
  join(root, "CHANGELOG.md"),
  ...(pkg.files ? pkg.files.flatMap(expand) : expand(".")),
]);

const problems = [];
for (const file of [...files].sort()) {
  const rel = relative(root, file);
  if (rel.startsWith("test/") || rel.startsWith("test\\")) continue;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    const where = `${rel}:${i + 1}`;
    const t = TICKET.exec(line);
    if (t) problems.push(`${where}: ticket id '${t[0]}'`);
    const c = TURKISH.exec(line);
    if (c) problems.push(`${where}: non-English character '${c[0]}'`);
    for (const m of MARKERS) if (line.includes(m)) problems.push(`${where}: marker '${m}'`);
    if (!WORD_EXEMPT.has(rel.split(/[\\/]/).join("/"))) {
      const w = WORD.exec(line);
      if (w) problems.push(`${where}: Turkish word '${w[0]}'`);
    }
  });
}

if (problems.length) {
  console.error("check-publish: FAILED - internal content in published files:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`check-publish: OK (${files.size} files scanned)`);
