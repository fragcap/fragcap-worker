# FragCap Worker

Cloudflare Worker that acts as the trusted intermediary between the [FragCap plugin](https://github.com/fragcap/plugin) and the [FragCap registry](https://github.com/fragcap/registry).

## Architecture

```
User (plugin) → POST /register { gist_id } → Worker → reads public Gist from GitHub → rate-limits by gist owner → writes shard to registry repo
```

The Worker holds the GitHub App installation token and is the only component with write access to the registry repository. The plugin never touches the registry directly. **No user credentials are accepted or stored** — gist ownership is established by reading the public gist metadata from GitHub's own API.

## Rate Limiting

Registrations are limited to **20 per gist owner per UTC day**, enforced via Cloudflare KV. The owner identity is read directly from the public gist's `owner.login` field returned by GitHub — no user token is required.

## API Endpoints

### `POST /register`

Registers a public Gist as a FragCap capsule in the registry.

**Headers:**
- `Content-Type: application/json`

**Body:**
```json
{ "gist_id": "abc123..." }
```

**Responses:**
- `200 { "ok": true }` — registered successfully
- `400` — missing/invalid `gist_id` or gist fails validation
- `404` — gist not found
- `429` — rate limit exceeded (20 registrations per owner per day)
- `500` — internal error

### `GET /health`

Returns worker status.

**Response:** `200 { "ok": true, "service": "fragcap-worker" }`

## Deployment

### 1. Create a GitHub App

1. Go to GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Set the app name (e.g. `fragcap-registry-bot`).
3. Under **Repository permissions**, set **Contents** to **Read & Write**.
4. Install the app on the `fragcap/registry` repository.
5. Note the **App ID** and **Installation ID**.
6. Generate and download a private key (`.pem` file).

### 2. Convert the private key to PKCS8

GitHub provides PKCS1 keys; Cloudflare Workers requires PKCS8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem
```

### 3. Create the KV namespace

```bash
wrangler kv namespace create RATE_LIMIT
```

Copy the `id` from the output and add it to `wrangler.toml` (already pre-filled for the production deployment):

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "<your-namespace-id>"
```

### 4. Set secrets

```bash
wrangler secret put APP_ID
wrangler secret put PRIVATE_KEY        # paste the contents of key-pkcs8.pem
wrangler secret put INSTALLATION_ID
```

### 5. Deploy

```bash
npm install
npx wrangler deploy
```

## Local Development

Create `.dev.vars` (see `.dev.vars.example`):

```
APP_ID=your_app_id
PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
INSTALLATION_ID=your_installation_id
```

Then run:

```bash
npx wrangler dev
```
