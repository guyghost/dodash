/** Local synthetic preparation only. No network, broker or campaign-start effect. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(new URL("../../packages/backtest/package.json", import.meta.url));
const { initializeP7Ledger, applyP7LedgerCommand, planP7LedgerRecovery } = await import(require.resolve("@dodash/models"));
const ZERO_HASH = "0".repeat(64);
const MAX_BYTES = 2 * 1024 * 1024;
const hash = (body) => createHash("sha256").update(body).digest("hex");
const canonical = (value, depth = 0) => {
  if (depth > 32) throw new Error("INVALID_JSON_DEPTH");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error("INVALID_JSON_ARRAY");
    const items = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw new Error("INVALID_JSON_ARRAY");
      items.push(canonical(descriptor.value, depth + 1));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object" && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value).sort();
    if (keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) throw new Error("INVALID_JSON_ACCESSOR");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("INVALID_JSON_VALUE");
};
const bounded = (value) => {
  const body = canonical(value);
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("COMMAND_TOO_LARGE");
  return body;
};

export class P7LocalLedgerStore {
  #database;
  #now;
  #failpoint;
  constructor(path, manifest, { now = Date.now, failpoint } = {}) {
    const existed = path !== ":memory:" && existsSync(path);
    this.#database = new DatabaseSync(path);
    this.#now = now; this.#failpoint = failpoint;
    try {
      if (existed && this.#database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='p7_ledger'").get() === undefined) throw new Error("FOREIGN_DATABASE");
      this.#database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS p7_ledger (
          sequence INTEGER PRIMARY KEY, command_id TEXT NOT NULL UNIQUE,
          body TEXT NOT NULL, hash TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS p7_ledger_no_update BEFORE UPDATE ON p7_ledger
          BEGIN SELECT RAISE(ABORT, 'append-only ledger'); END;
        CREATE TRIGGER IF NOT EXISTS p7_ledger_no_delete BEFORE DELETE ON p7_ledger
          BEGIN SELECT RAISE(ABORT, 'append-only ledger'); END;
      `);
      const normalized = JSON.parse(bounded(manifest));
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        if (this.#database.prepare("SELECT sequence FROM p7_ledger LIMIT 1").get() === undefined) {
          const recordedAt = this.#now(), initialized = initializeP7Ledger(normalized, recordedAt);
          if (!initialized.ok) throw new Error(initialized.error);
          const entry = { schemaVersion: 1, observation: "SYNTHETIC_LOCAL_PREPARATION", sequence: 1,
            previousHash: ZERO_HASH, recordedAt, manifest: normalized };
          this.#insert("__manifest__", entry);
        }
        if (canonical(this.#read().state.manifest) !== canonical(normalized)) throw new Error("MANIFEST_CONFLICT");
        this.#database.exec("COMMIT");
      } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
    } catch (error) { this.#database.close(); throw error; }
  }
  #insert(commandId, entry) {
    const body = canonical(entry);
    this.#database.prepare("INSERT INTO p7_ledger(sequence, command_id, body, hash) VALUES (?, ?, ?, ?)").run(entry.sequence, commandId, body, hash(body));
  }
  #read() {
    let state, lastHash = ZERO_HASH;
    const entries = [], ids = new Set();
    try {
      for (const row of this.#database.prepare("SELECT sequence, command_id, body, hash FROM p7_ledger ORDER BY sequence").iterate()) {
        if (Buffer.byteLength(row.body) > MAX_BYTES + 65_536 || row.sequence !== entries.length + 1 || hash(row.body) !== row.hash || ids.has(row.command_id)) throw new Error("LEDGER_CORRUPT");
        const entry = JSON.parse(row.body);
        if (canonical(entry) !== row.body || entry.schemaVersion !== 1 || entry.observation !== "SYNTHETIC_LOCAL_PREPARATION" || entry.sequence !== row.sequence || entry.previousHash !== lastHash) throw new Error("LEDGER_CORRUPT");
        if (row.sequence === 1) {
          if (row.command_id !== "__manifest__" || entry.command !== undefined) throw new Error("LEDGER_CORRUPT");
          const initialized = initializeP7Ledger(entry.manifest, entry.recordedAt);
          if (!initialized.ok) throw new Error("LEDGER_CORRUPT");
          state = initialized.value;
        } else {
          if (entry.manifest !== undefined || row.command_id !== entry.command?.commandId) throw new Error("LEDGER_CORRUPT");
          const result = applyP7LedgerCommand(state, entry.command, entry.recordedAt);
          if (!result.ok || canonical(result.value.receipt) !== canonical(entry.receipt)) throw new Error("LEDGER_CORRUPT");
          state = result.value.state;
        }
        ids.add(row.command_id); entries.push(entry); lastHash = row.hash;
      }
      if (state === undefined) throw new Error("LEDGER_CORRUPT");
      return { observation: "SYNTHETIC_LOCAL_PREPARATION", entries, lastHash, state };
    } catch { throw new Error("LEDGER_CORRUPT"); }
  }
  apply(command) {
    const body = bounded(command), normalized = JSON.parse(body);
    if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized) || typeof normalized.commandId !== "string") throw new Error("INVALID_COMMAND");
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const journal = this.#read();
      const previous = journal.entries.find((e) => e.command !== undefined && e.command.commandId === normalized.commandId);
      if (previous !== undefined) {
        if (canonical(previous.command) !== body) throw new Error("COMMAND_ID_CONFLICT");
        this.#database.exec("COMMIT"); committed = true;
        return previous.receipt;
      }
      const recordedAt = this.#now(), result = applyP7LedgerCommand(journal.state, normalized, recordedAt);
      if (!result.ok) throw new Error(result.error);
      const entry = { schemaVersion: 1, observation: "SYNTHETIC_LOCAL_PREPARATION", sequence: journal.entries.length + 1,
        previousHash: journal.lastHash, recordedAt, command: normalized, receipt: result.value.receipt };
      this.#insert(normalized.commandId, entry);
      this.#failpoint?.("beforeCommit");
      this.#database.exec("COMMIT"); committed = true;
      this.#failpoint?.("afterCommit");
      return result.value.receipt;
    } catch (error) {
      if (!committed) this.#database.exec("ROLLBACK");
      throw error;
    }
  }
  export() { return this.#read(); }
  recovery(productId, candleClosedAt, now = this.#now()) { return planP7LedgerRecovery(this.#read().state, productId, candleClosedAt, now); }
  close() { this.#database.close(); }
}
