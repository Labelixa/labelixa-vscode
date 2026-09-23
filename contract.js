/**
 * WIRE VOCABULARY — the API's own field names, in one file.
 *
 * Some fields of the Labelixa API are named in Turkish (`mesaj`,
 * `komutlar`, `quickfix.baslik`). They are PROTOCOL: renaming them here
 * would not translate anything, it would simply stop reading the server's
 * answer. So they are not translated, and they are not hidden either.
 *
 * They live in this single file for the same reason the agent keeps its
 * own wire names in one place: the publish guard can then exempt exactly
 * one file from the "no Turkish words" rule instead of losing that rule
 * across the whole package. Everything else — identifiers, comments, user
 * facing text — stays English, and the guard still checks this file for
 * ticket ids, non-English characters and audit markers.
 *
 * Adding a name here is a claim that the server really sends it. Measure
 * first (https://labelixa.com/docs/api); the smoke test then keeps the
 * claim honest against a running server.
 */
"use strict";

/** Diagnostics response. */
const FINDINGS = "diagnostics";
const MESSAGE = "mesaj";
const MESSAGE_KEY = "message_key";
/** Absolute address of the rule's documentation page; absent for codes
 * without a page (analyzer notes). */
const RULE_URL = "url";

/** Quick-fix object inside a finding. */
const FIX = "quickfix";
const FIX_TITLE = "baslik";
const FIX_START = "offset";
const FIX_END = "end_offset";
const FIX_TEXT = "yeni";

/** Command dictionary response. */
const COMMAND_LIST = "komutlar";
const COMMAND_CODE = "kod";
const COMMAND_NAME = "ad";
const COMMAND_TEXT = "aciklama";
const COMMAND_FORMAT = "format";
const COMMAND_PARAMS = "parametreler";
const COMMAND_RENDERED = "destekleniyor";

module.exports = {
  FINDINGS, MESSAGE, MESSAGE_KEY, RULE_URL,
  FIX, FIX_TITLE, FIX_START, FIX_END, FIX_TEXT,
  COMMAND_LIST, COMMAND_CODE, COMMAND_NAME, COMMAND_TEXT,
  COMMAND_FORMAT, COMMAND_PARAMS, COMMAND_RENDERED,
};
