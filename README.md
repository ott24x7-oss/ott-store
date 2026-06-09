# OTT Store

Self-hosted Node.js + Express + SQLite storefront for selling OTT subscriptions (Netflix, Amazon Prime, Disney+, Sony LIV, Zee5, etc.) with account credential delivery.

## Quick Start

```bash
cd ott-store
npm install
cp .env.example .env
# Edit .env with your values
npm start
```

Open:
- **Store:** http://localhost:3000/
- **Customer Portal:** http://localhost:3000/my
- **Admin Panel:** http://localhost:3000/admin  (default password: `admin123!`)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | `http://localhost:3000` | Public URL of the store |
| `SESSION_SECRET` | *(required)* | Random 32-char secret for JWT signing |
| `ADMIN_PASSWORD` | `admin123!` | Initial admin password |
| `RAZORPAY_KEY_ID` | — | Razorpay Key ID (optional) |
| `RAZORPAY_KEY_SECRET` | — | Razorpay Key Secret (optional) |
| `SMTP_HOST` | — | SMTP host for email delivery (optional) |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `SMTP_FROM` | — | From address |
| `BOT_API_URL` | — | OTT24x7 bot public URL — enables selling the bot's catalog with auto-delivery (optional) |
| `BOT_API_TOKEN` | — | Reseller API token from the bot's reseller panel (optional) |
| `NODE_ENV` | — | Set to `production` to enable secure cookies |

## First-Time Setup

1. **Install & start:** `npm install && npm start`
2. **Login to Admin:** Go to `/admin`, use password from `ADMIN_PASSWORD` env
3. **Configure Store:** Admin → My Store → fill in name, tagline, support contacts
4. **Add Plans:** Admin → Plans → Add Plan (Netflix, Prime, etc.)
5. **Setup Payments:** Admin → Payments → configure UPI ID or Razorpay
6. **Customers register** at `/my`, top up wallet, and purchase plans
7. **Deliver credentials:** Admin → Orders → click Manage → enter credentials → set status to Delivered

## Sell your OTT24x7 bot's catalog (auto-delivery)

The store can resell the products from your OTT24x7 Telegram bot and deliver them
automatically — when a customer pays here, the store buys the key live from the bot
and emails/WhatsApps it instantly.

1. **In the bot:** open the reseller panel, generate an API token (`rs_live_…`), and
   make sure your store's reseller account is *unlimited* (the bot owner's own account,
   or an ID listed in the bot's `UNLIMITED_RESELLER_IDS`) so it isn't balance-gated.
2. **In the store `.env`:** set `BOT_API_URL` (the bot's public domain, e.g.
   `https://ottbot.example.com`) and `BOT_API_TOKEN` (the token), then restart.
3. **Import the catalog:** it auto-syncs every 10 min, or `POST /admin/api/bot/sync`
   to import now. Imported products appear in **Admin → Plans** with provider `bot`.
4. **Set your prices:** the first import seeds each product's price from the bot's
   retail price — edit each one in Admin → Plans. Re-syncs refresh stock/name only and
   **never overwrite your price**.

How it works: bot-backed plans deliver via the bot's `/reseller/purchase` API. If the
bot is out of stock, the customer is auto-refunded to their store wallet and you're
alerted. Manual-delivery bot products fall through to normal manual fulfillment.
Connection status: `GET /admin/api/bot/status`.

## Deployment

### Railway
```bash
# Set env vars in Railway dashboard, then:
railway up
```

### Render
- Connect GitHub repo
- Build: `npm install`
- Start: `npm start`
- Set env vars in dashboard

### VPS (Ubuntu)
```bash
npm install -g pm2
cd ott-store
npm install
cp .env.example .env && nano .env
pm2 start src/index.js --name ott-store
pm2 save && pm2 startup

# Nginx reverse proxy
server {
    listen 80;
    server_name store.watshop.in;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Data

SQLite database is stored at `data/store.db` — auto-saved every 5 seconds. Backup via **Admin → DB Backup → Download**.

## Tech Stack

- Node.js + Express (CommonJS)
- sql.js (SQLite WASM, zero native compilation)
- bcryptjs for password hashing
- JWT sessions in httpOnly cookies
- Vanilla JS SPA for portal and admin
- Custom CSS with dark/light theme
