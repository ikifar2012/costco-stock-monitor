import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_CLIENT_ID = "e442e6e6-2602-4a39-937b-8b28b4457ed3";
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const message = (error: unknown) => error instanceof Error ? error.message : "Unknown error";

function positiveSeconds(name: string, fallback: number): number {
  const value = Number(Bun.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 86400) {
    throw new Error(`${name} must be an integer from 1 to 86400`);
  }
  return value * 1000;
}
const interval = positiveSeconds("CHECK_INTERVAL_SECONDS", 60);
const timeout = positiveSeconds("REQUEST_TIMEOUT_SECONDS", 15);

class RequestError extends Error {
  constructor(text: string, readonly retryAfter = 0) { super(text); }
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
  } catch {
    // Do not expose the secret Hark webhook URL in network error messages.
    throw new RequestError("Network request failed or timed out");
  }
  if (!response.ok || response.status === 202) {
    const hint = response.headers.get("retry-after");
    const seconds = hint === null || hint.trim() === "" ? NaN : Number(hint);
    const retryAfter = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : hint ? Math.max(0, Date.parse(hint) - Date.now()) || 0 : 0;
    await response.body?.cancel();
    throw new RequestError(`HTTP ${response.status}`, Math.max(retryAfter, response.status === 429 ? 60000 : 0));
  }
  return response;
}

async function discoverClientId(productUrl: string): Promise<string> {
  const html = await (await request(productUrl)).text();
  // Next.js embeds JSON strings in inert Flight data. Decode strings, never execute page JS.
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
    .map(match => JSON.parse(match[1]!) as string).join("\n");
  const config = chunks.match(/"development_key":"sc_inventory_update_api_service_configuration"[\s\S]*?"required_request_headers":(\{[\s\S]*?\}),"required_request_parameters"/);
  if (!config) throw new Error("Costco inventory configuration not found; public page format may have changed");
  const id: unknown = JSON.parse(config[1]!).client_identifier?.cabc;
  if (typeof id !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) {
    throw new Error("Costco Canada client identifier is missing or malformed");
  }
  return id;
}

async function checkStock(clientId: string, item: string, warehouse: string, ffmCenter: string): Promise<boolean> {
  const url = new URL("https://www.costco.ca/AjaxSCInventoryUpdate");
  url.search = new URLSearchParams({ itemNumber: item, warehouseNo: warehouse, clientId }).toString();
  const data = await (await request(url.href)).json() as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid inventory response");
  const errors = data.errorParam;
  if (!errors || typeof errors !== "object" || Array.isArray(errors) || Object.keys(errors).length !== 0) {
    throw new Error("Inventory API returned missing, malformed or nonempty errorParam");
  }
  if (data.itemNumber !== item || data.ffmCenter !== ffmCenter || typeof data.isAvailable !== "boolean") {
    throw new Error("Inventory itemNumber, ffmCenter or isAvailable failed validation");
  }
  return data.isAvailable;
}

function required(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}; see .env.example and README.md`);
  return value;
}

function numericSetting(name: string): string {
  const value = required(name);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must contain only digits`);
  return value;
}

async function main() {
  const productUrl = required("PRODUCT_URL");
  const parsedUrl = new URL(productUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "www.costco.ca" || parsedUrl.username || parsedUrl.password) {
    throw new Error("PRODUCT_URL must be an HTTPS product link on www.costco.ca");
  }
  if (Bun.argv.includes("--discover-client-id")) {
    console.log(await discoverClientId(productUrl));
    return;
  }
  const item = numericSetting("COSTCO_ITEM_NUMBER");
  const warehouse = numericSetting("COSTCO_WAREHOUSE_NO");
  const ffmCenter = numericSetting("COSTCO_FFM_CENTER");
  const productName = required("PRODUCT_NAME");
  const promotionEnd = Bun.env.PROMOTION_END_DATE?.trim();
  if (promotionEnd && (!/^\d{4}-\d{2}-\d{2}$/.test(promotionEnd)
      || !Number.isFinite(Date.parse(promotionEnd))
      || new Date(promotionEnd).toISOString().slice(0, 10) !== promotionEnd)) {
    throw new Error("PROMOTION_END_DATE must be a real date in YYYY-MM-DD format, or empty");
  }
  const promotion = promotionEnd ? ` Promotion ends ${promotionEnd}.` : "";
  const productKey = JSON.stringify([item, warehouse, ffmCenter]);
  const clientId = Bun.env.COSTCO_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
  if (Bun.argv.includes("--check")) {
    console.log(JSON.stringify({ itemNumber: item, ffmCenter, isAvailable: await checkStock(clientId, item, warehouse, ffmCenter) }));
    return;
  }
  const webhook = Bun.env.HARK_WEBHOOK_URL?.trim();
  if (!webhook || !/^https:\/\/hark\.fyi\/hooks\/whk_[A-Za-z0-9_-]+$/.test(webhook)) {
    throw new Error("Set HARK_WEBHOOK_URL to your secret https://hark.fyi/hooks/whk_… URL");
  }
  const path = Bun.env.DATABASE_PATH || "./data/monitor.sqlite";
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS stock_state (
      product_key TEXT PRIMARY KEY, available INTEGER,
      failures INTEGER NOT NULL DEFAULT 0, failure_event TEXT,
      next_check INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS delivery (
      id INTEGER PRIMARY KEY CHECK(id = 1), next_send INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO delivery(id) VALUES(1);
  `);
  db.query("INSERT OR IGNORE INTO stock_state(product_key) VALUES (?)").run(productKey);
  type State = { available: number | null; failures: number; failure_event: string | null; next_check: number };
  type Notification = { id: string; payload: string; attempts: number; next_attempt: number };
  const state = db.query<State, [string]>("SELECT * FROM stock_state WHERE product_key = ?");
  const enqueue = db.query("INSERT INTO notifications(id, payload) VALUES (?, ?)");
  const backoff = (attempts: number) => Math.max(interval, Math.min(900000, Math.max(interval, 60000) * 2 ** Math.min(attempts - 1, 10)));
  const notification = (title: string, body: string) => JSON.stringify({ title, body: `${body}\nObserved: ${new Date().toISOString()}\n${productUrl}`, url: productUrl });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log(`Monitoring ${productName} (item ${item}, warehouse ${warehouse}, ffmCenter ${ffmCenter}); interval=${interval / 1000}s.${promotion}`);
  try {
    while (!stopping) {
      if (Date.now() >= state.get(productKey)!.next_check) {
        try {
          const available = await checkStock(clientId, item, warehouse, ffmCenter);
          db.transaction(() => {
            const previous = state.get(productKey)!;
            if (available && previous.available !== 1) {
              enqueue.run(crypto.randomUUID(), notification(`${productName} is in stock at Costco`, `${productName} (item ${item}) is available.${promotion} Buy now:`));
            }
            db.query("UPDATE stock_state SET available=?, failures=0, failure_event=NULL, next_check=? WHERE product_key=?")
              .run(Number(available), Date.now() + interval, productKey);
          })();
          log(available ? "In stock" : "Out of stock (validated response)");
        } catch (error) {
          db.transaction(() => {
            const previous = state.get(productKey)!;
            const failures = previous.failures + 1;
            let event = previous.failure_event;
            if (failures >= 3 && !event) {
              event = crypto.randomUUID();
              enqueue.run(event, notification("Costco stock monitor is failing", `Three consecutive stock checks failed for ${productName} (item ${item}). Stock is unknown; the last valid stock state has been preserved. Check container logs. Product:`));
            }
            const delay = Math.max(backoff(failures), error instanceof RequestError ? error.retryAfter : 0);
            db.query("UPDATE stock_state SET failures=?, failure_event=?, next_check=? WHERE product_key=?")
              .run(failures, event, Date.now() + delay, productKey);
            log(`Stock check failed (${failures} consecutive): ${message(error)}; retry in ${Math.ceil(delay / 1000)}s`);
          })();
        }
      }
      // Persistent outbox: send immediately after a stock transition, retry independently of inventory.
      const delivery = db.query<{ next_send: number }, []>("SELECT next_send FROM delivery WHERE id=1").get()!;
      const pending = db.query<Notification, [number]>("SELECT * FROM notifications WHERE sent_at IS NULL AND next_attempt <= ? ORDER BY rowid LIMIT 1").get(Date.now());
      if (pending && Date.now() >= delivery.next_send && !stopping) {
        try {
          const result = await (await request(webhook, {
            method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": pending.id },
            body: pending.payload,
          })).json() as { ok?: boolean; delivered?: number };
          if (result.ok !== true || !Number.isInteger(result.delivered) || result.delivered! < 1) {
            throw new Error("Hark did not confirm any accepted pushes; check registered devices and Hark activity log");
          }
          db.query("UPDATE notifications SET sent_at=? WHERE id=?").run(Date.now(), pending.id);
          log(`Notification accepted by Hark (${pending.id})`);
        } catch (error) {
          const delay = Math.max(backoff(pending.attempts + 1), error instanceof RequestError ? error.retryAfter : 0);
          db.transaction(() => {
            db.query("UPDATE notifications SET attempts=attempts+1, next_attempt=? WHERE id=?").run(Date.now() + delay, pending.id);
            // A Retry-After applies to the whole Hark service, including other queued alerts.
            db.query("UPDATE delivery SET next_send=? WHERE id=1").run(Date.now() + delay);
          })();
          log(`Hark delivery failed: ${message(error)}; retry in ${Math.ceil(delay / 1000)}s`);
        }
      }
      await Bun.sleep(1000);
    }
  } finally {
    db.close();
    log("Stopped");
  }
}

main().catch(error => { console.error(message(error)); process.exitCode = 1; });
