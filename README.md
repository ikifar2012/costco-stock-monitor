# Costco Canada stock monitor

A single Bun/TypeScript process watching one Costco Canada product configured through environment variables. Sends push notifications using [Hark](https://hark.fyi/docs). No runtime dependencies or exposed ports.

Product names, purchase links, inventory routing, and optional promotion reminders are configured privately in `.env`. The monitor continues after a configured promotion date; stop it when finished.

## Run locally

Install Bun 1.4+, then:

```sh
cp .env.example .env
# Fill in the product settings and your Hark service webhook in .env.
bun install --frozen-lockfile
bun run check      # One live inventory read; no DB writes or notifications.
bun start
```

Bun loads `.env` automatically. In Hark, register your iPhone, create a service, and copy its secret webhook URL. Keep the URL private. No Hark SDK is needed.

## Docker / Dokploy

```sh
cp .env.example .env
# Fill in the product settings and your Hark webhook in .env.
docker compose up -d --build
docker compose logs -f monitor
docker compose down
```

For [Dokploy](https://docs.dokploy.com/docs/core/docker-compose):

1. Push this directory to your Git repository.
2. Create a **Docker Compose** service, connect the repository, and set the Compose path to `./compose.yaml`. Use Compose mode (the file uses `build`).
3. Copy the settings from `.env.example` into Environment, including all required product settings, and replace `HARK_WEBHOOK_URL` with your secret webhook.
4. Deploy and inspect the monitor logs. No domain or port configuration is needed.

Keep **one running instance** and preserve the `monitor-data` named volume across deployments. SQLite stores stock state, failure streaks, retry deadlines, and pending/sent alerts. Changing the Compose project name creates a different volume. `docker compose down -v` deletes this history and allows alerts to be sent again. Docker runs as the image's `bun` user.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PRODUCT_NAME` | Required | Human-readable product/variant name for logs and alerts |
| `PRODUCT_URL` | Required | HTTPS purchase link on `www.costco.ca` |
| `COSTCO_ITEM_NUMBER` | Required | Item number for the exact selected variant |
| `COSTCO_WAREHOUSE_NO` | Required | `warehouseNo` query parameter from the inventory request |
| `COSTCO_FFM_CENTER` | Required | Expected `ffmCenter` in a successful inventory response |
| `PROMOTION_END_DATE` | Empty | Optional `YYYY-MM-DD` reminder in stock alerts; does not stop polling |
| `HARK_WEBHOOK_URL` | Required | Secret `https://hark.fyi/hooks/whk_…` service URL |
| `CHECK_INTERVAL_SECONDS` | `60` | Delay after a successful stock read |
| `REQUEST_TIMEOUT_SECONDS` | `15` | Timeout for each HTTP request |
| `COSTCO_CLIENT_ID` | `e442e6e6-2602-4a39-937b-8b28b4457ed3` | Optional override for the built-in Costco Canada client identifier |
| `DATABASE_PATH` | `./data/monitor.sqlite` | Local path; Compose fixes this to `/data/monitor.sqlite` |

Seconds settings accept integers from 1 through 86400. Keep the stock interval at 60 seconds or longer for normal use.

## Find the product settings

Copy `.env.example` to `.env` and fill in the blank product settings. Keep `.env` private; it is excluded from Git and Docker build contexts:

1. Open the product on Costco.ca, select the exact colour/size/model, and copy its purchase link into `PRODUCT_URL`. Set `PRODUCT_NAME` to a name that includes that variant. A shared product URL may show several variants, so confirm the item number separately.
2. Copy the displayed **Item** number into `COSTCO_ITEM_NUMBER`. This is the selected variant's item number, not necessarily the parent product ID at the end of the URL.
3. In your browser's developer tools, open **Network**, filter for `AjaxSCInventoryUpdate`, then reload the page or change the selected variant. Inspect the request for your item. Copy its `warehouseNo` query parameter into `COSTCO_WAREHOUSE_NO` and compare its `clientId` with the default in the configuration table. If it differs, add `COSTCO_CLIENT_ID=<value>` to `.env` (or Dokploy Environment). This warehouse value is the site's inventory routing value; do not substitute the number of your local Costco store.
4. In that request's response, verify `errorParam` is `{}` and `itemNumber` matches your selected item. Copy `ffmCenter` into `COSTCO_FFM_CENTER`. Availability may be `true` or `false`; an API error is not a valid source for these settings.
5. If needed, set `PROMOTION_END_DATE` to the promotion's end date (format: `YYYY-MM-DD`), or leave it empty. Run `bun run check` to confirm a validated response without sending notifications. Restart/redeploy after changes.

If no `AjaxSCInventoryUpdate` request appears, that page may use a different fulfillment API. Do not guess its warehouse or fulfillment center. This monitor supports the supplied inventory endpoint; other Costco products may need a different integration. `bun run discover` can also extract the Canada client identifier from the configured `PRODUCT_URL`, as described below.

SQLite keeps separate stock/failure state for each item, warehouse, and fulfillment-center combination, so switching products cannot inherit another product's availability. Switching back resumes that product's saved state. Previously queued alerts keep their original product name and link and may still be delivered. Run only one monitor instance per database.

## Behavior

- Check immediately at startup, then every 60 seconds by default. A persisted retry deadline is honored after restart.
- Accept stock only if `errorParam` is an empty object, `itemNumber` matches `COSTCO_ITEM_NUMBER`, `ffmCenter` matches `COSTCO_FFM_CENTER`, and `isAvailable` is a boolean. HTTP failures, timeouts, invalid JSON, and validation failures mean **unknown**, preserving the last valid stock state.
- Queue a stock alert immediately on the first `true`, including if the first ever observation is available. Repeated `true` responses and restarts do not create another alert. Only a validated `false` rearms the next stock alert. API failures cannot rearm it.
- After three consecutive failed inventory requests, queue one failure notification per outage. A successful inventory read resets the streak. Failure streaks survive restarts; delivery errors are logged separately.
- Retry inventory and notification failures automatically with exponential delays: normally 60, 120, 240 seconds, up to 15 minutes. Longer configured intervals are respected. HTTP `Retry-After` (seconds or date) can extend that delay without a cap; HTTP 429 waits at least 60 seconds. Hark backoff applies to its entire delivery queue. Retries do not block inventory polling with sleeps.
- Pending alerts survive crashes. Every alert has a persistent UUID sent as Hark's `Idempotency-Key`, and a fixed payload including the product purchase link. SQLite records delivery only after Hark returns `ok: true` and at least one accepted push. An accepted push does not prove the phone displayed it.
- Hark `202`, errors, and zero accepted pushes remain pending. Register a device before starting: an idempotent replay of an already accepted event with `delivered: 0` may keep returning zero; inspect Hark's activity log and resolve the device/service configuration. Delivery retries cannot fix device registration.
- Delayed stock alerts describe an observation at the time shown in their body; inventory may have changed while delivery was unavailable. Failure alerts can likewise arrive after recovery. No recovery pushes or startup pushes are sent.
- SIGTERM/SIGINT stop after the current bounded request and close SQLite. There is no web server, dashboard, or automated test suite. `bun run typecheck` checks TypeScript.

## Where Costco's clientId comes from

The public product HTML can be fetched with plain HTTP requests, without cookies or authentication. The inspected page contains Next.js Flight data (`self.__next_f.push`) with a service configuration whose:

- `development_key` is `sc_inventory_update_api_service_configuration`
- `endpoint` is `/AjaxSCInventoryUpdate`
- `required_request_headers.client_identifier.cabc` contains the public Canada storefront identifier
- `required_request_parameters.warehouse_contract_id.cabc` contains the inventory routing value

The same Canada identifier also occurs in product data and other frontend configuration. This is evidence of a configured storefront/application identifier, rather than a visitor-generated UUID. The configuration labels it as a header, but the supplied inventory endpoint accepts it as the `clientId` query parameter without extra security headers. A valid response must have `errorParam: {}` and matching configured item and fulfillment-center values.

It **can be discovered dynamically** from `PRODUCT_URL`, without downloading bundles or running browser JavaScript (load your `.env` settings first):

```sh
bun run discover
# Or from the built image:
docker compose run --rm monitor bun run src/monitor.ts --discover-client-id
```

This decodes the page's JSON string data and extracts the Canada identifier specifically from the inventory service configuration. It never evaluates frontend code or picks an arbitrary UUID. If Costco changes the page structure, the command fails explicitly. The example omits `COSTCO_CLIENT_ID` because the monitor has a built-in default. If discovery returns a different value, add `COSTCO_CLIENT_ID=<output>` to `.env` (or Dokploy Environment) and restart/redeploy. Normal monitoring uses the verified identifier directly, avoiding a product-page dependency on every poll. The identifier is public storefront configuration, not a personal credential. Generating random identifiers is not a discovery strategy.
