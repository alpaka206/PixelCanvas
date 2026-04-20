# OpenPixel Beta

Public beta MVP for a collaborative `r/place`-style board built as a single Cloudflare Workers project.

## Stack

- React + Vite for the client
- Cloudflare Vite plugin for local dev and builds
- Cloudflare Worker for API routes
- Durable Object with SQLite-backed storage for the board state and WebSocket fanout
- Cloudflare Turnstile for optional public-beta abuse control

## What this version includes

- One shared board
- Free color picking with a native color input
- Real-time pixel updates over WebSockets
- Persistent board state inside a Durable Object
- Session cooldown enforcement
- Turnstile verification flow for public beta usage
- No separate backend repository

## Local development

1. Install dependencies:

```bash
npm install
```

2. Add local secrets for Turnstile if you want the full public-beta flow.

Create a `.dev.vars` file in the project root:

```bash
TURNSTILE_SITE_KEY=your_site_key
TURNSTILE_SECRET=your_secret
COOKIE_SECRET=your_random_cookie_secret
```

If `TURNSTILE_SITE_KEY` or `TURNSTILE_SECRET` is missing, the app falls back to development mode and skips the CAPTCHA requirement.

3. Start the app:

```bash
npm run dev
```

## Build and preview

```bash
npm run build
npm run preview
```

## Deploy

1. Log in to Cloudflare:

```bash
npx wrangler login
```

2. Add production secrets:

```bash
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put COOKIE_SECRET
```

3. Deploy:

```bash
npm run cf:deploy
```

## Config knobs

The core board settings live in `wrangler.jsonc`:

- `BOARD_WIDTH`
- `BOARD_HEIGHT`
- `PLACEMENT_COOLDOWN_MS`
- `VERIFICATION_TTL_MS`
- `RECENT_PLACEMENTS_LIMIT`

## Notes for public beta

- This is intentionally a single-board MVP.
- Cooldown and Turnstile are designed to reduce abuse, not eliminate all attacks.
- If traffic outgrows the free tier, the first pressure points will be Worker requests and Durable Object usage.
