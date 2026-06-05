# collab • grok

Real-time collaborative chat for up to 4 humans + Grok as a thoughtful participant (bring your own Grok API key).

Modern, low-latency web UI. Designed for fast throw-together MVPs and remote collaboration (different cities/states, same country).

## Core Features (MVP)

- **Shared conversation** — Everyone sees the same thread in real time via WebSockets.
- **Personas** — Each collaborator declares their lens/perspective. Grok sees them and respects different viewpoints.
- **Grok as participant** — Uses your own Grok API key (from xAI). Grok is explicitly prompted **not** to reply to everything. It only speaks when it has ideas, objections, synthesis, or questions. (You control all costs.)
- **Typing indicators** — See "Alice is typing..." and **"Grok is thinking..."**.
- **Summon button** — Force Grok to contribute right now.
- **Auto vs manual** — Toggle Grok auto-participation.
- **Export** — Full transcript (Markdown or JSON).
- **Build notes** — Ask Grok to produce clean structured notes highlighting decisions, ideas, solutions, open questions.
- **Catch-up context pack** — Generates a dense future-proof context file (`.md` + `.json`) saved on the server so a future Grok session can pick up exactly where you left off with zero loss of signal.
- **Smart context** — Running summary compaction for long threads + recent window sent to Grok so it stays fast and cheap even on long discussions.
- **Remote friendly** — Run the server on one machine, share the URL (via ngrok/cloudflared) + room code.

## Quick Start

1. **Get a Grok API key** (from xAI)
   - Go to https://x.ai/api or https://console.grok.com (or wherever the current console lives).
   - Create a key. This is the only recurring cost.

2. **Clone / use this folder**
   ```bash
   cd /path/to/collab_grok
   ```

3. **Install**
   ```bash
   npm install
   ```

4. **Configure key**
   ```bash
   cp .env.example .env
   # edit .env and put your real key
   XAI_API_KEY=sk-...
   ```

5. **Run (dev — two processes, hot reload)**
   ```bash
   npm run dev
   ```
   - Open the client: `http://localhost:5173`
   - Backend + Socket.IO on `http://localhost:3000` (client proxies API/ws automatically)

6. **Or run production-like (single port, serves UI + backend)**
   ```bash
   npm run build
   npm run preview   # or just `npm start`
   ```
   Opens everything on port 3000 and serves the built UI + WebSocket backend. Perfect for tunneling.

## How to Collaborate Remotely

- The person with the API key runs the server (the "host").
- For friends in other states:
  - Use a tunnel:
    ```bash
    # example with ngrok
    ngrok http 3000
    ```
    or cloudflared, etc.
  - Share the resulting public https URL + the 8-char room code.
- Others just open the URL in their browser, enter name + persona, and paste the room code.
- Everything is low-latency over the tunnel (as good as your internet).

No accounts, no central service. Your data, your key, your machine (or VPS).

## Using the App

- **Create** → instantly get a room code.
- **Join** → paste code (or open a shared tunnel URL that already has `?room=XXXX`).
- In chat:
  - Edit your own persona anytime (pencil icon).
  - Grok will usually stay quiet. Use **Summon Grok** when you want its take.
  - Toggle "Grok auto" if you want it to decide on its own after messages.
- **Export / Notes / Context** buttons are in the header and sidebar.

## Context & Long Threads

- Every Grok call uses: (running compacted summary of the past) + last ~18 messages.
- When things get long, the server occasionally asks Grok to produce/update a dense running summary (transparent, you can see it in exports).
- **Generate catch-up context pack** is the main "save for later" button. It produces:
  - A human-readable dense MD summary
  - A structured JSON with decisions, facts, open questions, per-persona views, etc.
- Files land in `./context-packs/` on the machine running the server.
- To resume later: just start a brand new room (or same one) and paste the context pack content as the first "system" message to a fresh Grok, or simply continue in the persistent room (full history is saved in the SQLite DB at DB_PATH).

## Tech Notes (for hackers)

- Node + TypeScript + Express + Socket.IO (backend)
- Vite + React 19 + Tailwind (frontend)
- OpenAI SDK pointed at `https://api.x.ai/v1` (full compatibility)
- Model default: `grok-3` (override with `XAI_MODEL` in .env)
- Persistence: SQLite via better-sqlite3 (DB_PATH, e.g. /data/collab.db on Render disk). Rooms/users/messages survive deploys.
- Accounts via email + verification code, 30d JWT stay-logged-in, per-chat role context on join.
- Smart context (summary + recent N) for Grok to control token usage on long threads.
- Max 4 human collaborators enforced lightly.

## Environment

```
XAI_API_KEY=...          # required (your Grok key)
XAI_MODEL=grok-3         # optional
PORT=3000

# For persistence on Render (see Deployment section)
DB_PATH=/data/collab.db
JWT_SECRET=long-random-string-here

# For emails (verification codes + optional notifications). See SMTP section below.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@loganwright.tech
PUBLIC_URL=https://your-custom-domain
```

## Tips for Best Experience

- Write good personas up front (e.g. "Skeptical backend engineer who cares about operational simplicity and cost").
- Grok's silence logic is prompt-based. If it talks too much or too little, you can tweak the prompt in `server/grokClient.ts` or `roomManager.ts`.
- For very long sessions, periodically hit "Generate catch-up context pack".
- The full raw history is always kept for exports even when compacted for the model.

## Future Polish Ideas (out of MVP scope)

- Streaming Grok responses (token-by-token bubbles)
- @-mentions that force Grok attention
- Visual graph view of the context JSON (decisions as nodes)
- Persistent user profiles across rooms
- Better presence (last-seen, online dots)
- Markdown rendering + code blocks in messages
- Multi-room dashboard

Enjoy the discussion.

Built as a fast, high-signal MVP.

## Deployment (Free Tier + Custom Domain)

We want **zero extra paid hosting** (only the Grok API key costs money). Here's the recommended free path that supports WebSockets, custom domains, and a self-contained Docker image.

### Recommended: Render.com (Easiest + Free Tier)

Render's free tier is perfect for this:
- Full Node + WebSocket support
- Automatic deploys from GitHub
- Free custom domains (CNAME)
- Dockerfile support
- Instance sleeps after ~15 min of inactivity (wakes on first visit — acceptable for a collab tool)

#### Steps

1. **Push to GitHub**
   - Make sure `.env` is **not** committed (it's in `.gitignore` — good).
   - The real `XAI_API_KEY` will be set as an environment variable on the platform, not in code.

2. **Create a Render Web Service**
   - Go to [render.com](https://render.com) and sign up (free).
   - Click **New +** → **Web Service**.
   - Connect your GitHub repo.
   - Settings:
     - **Name**: `collab-grok` (or whatever)
     - **Environment**: `Docker` (recommended for self-contained image) **or** `Node`
     - If using Docker: Render will auto-detect the `Dockerfile`
     - If Node:
       - Build Command: `npm install && npm run build`
       - Start Command: `npm start`
   - **Plan**: Free
   - Add Environment Variable:
     - `XAI_API_KEY` = your real key (paste it here)
     - (Optional) `XAI_MODEL` = `grok-3` or `grok-4.3` etc.
     - `JWT_SECRET` = a long random string (for 30-day login cookies)
   - Deploy.

3. **Add Persistent Disk for the database (critical — accounts, rooms, and history must survive deploys/rebuilds)**
   - After the first successful deploy, go to your service in the Render dashboard.
   - Go to **Disks** (or search "Add Disk" / Persistent Storage in the sidebar/settings).
   - Add a disk:
     - Name: e.g. `collab-data`
     - Size: 1 GB (free tier allows this; tiny for chat history)
     - Mount Path: `/data`
   - Save. Render will attach it (may trigger a redeploy).
   - Then add this Environment Variable (so the app writes the SQLite file to the disk instead of ephemeral storage):
     - `DB_PATH` = `/data/collab.db`
   - Redeploy if needed. The `server/db.js` code automatically `mkdir -p` the dirname of DB_PATH on startup.
   - Result: rooms, users, memberships, messages, and your "Your chats" list persist even when Render rebuilds the container image on git push.

4. **Custom Domain** (loganwright.tech recommended)
   - Once deployed, you'll get a `*.onrender.com` URL.
   - In the service → **Settings** → **Custom Domains** → Add domain, e.g.:
     - `collab.loganwright.tech`
     - or `grok.loganwright.tech`
   - Render will tell you what DNS record to create (usually a CNAME).
   - At your domain registrar (for loganwright.tech or gitpalette.com), add the CNAME.
   - Render provisions HTTPS automatically.

4. **Access**
   - You and your friend just visit `https://collab.loganwright.tech`
   - Share the room code (or the full URL with `?room=XXXX`).

**Why loganwright.tech over gitpalette.com?**
- `loganwright.tech` feels like a personal tech/experiment domain.
- `gitpalette.com` sounds more like a design/git tool (palette of colors or git branches). We can use it later if you want a separate branded thing.

**Limitations of free tier**
- Sleeps after 15 minutes of no traffic (first visitor waits a few seconds for wake-up).
- Fine for casual collab. If you want always-on later, upgrade to a cheap paid instance (~$7/mo).

### Email / SMTP setup (required for accounts + verification codes)
Accounts use email + 6-digit code. Room activity notifications are optional (per-user toggle).

**Important for your Cloudflare + loganwright.tech setup**
- Cloudflare (DNS + Email Routing) lets you *receive* mail at noreply@loganwright.tech and contact@loganwright.tech.
- It does **not** provide an SMTP server for *sending* outbound mail.
- You need a separate transactional email / SMTP relay provider that supports custom From: domains (after you add a few DNS records for DKIM/SPF).

**Recommended (free tier, easy for this volume): Brevo (brevo.com)**
1. Create free account at https://www.brevo.com
2. Add and verify your domain `loganwright.tech` in Brevo (they give you 2-3 TXT records for DKIM + SPF advice).
3. Since your DNS is managed at Cloudflare, log into CF → DNS and add those exact TXT records (set Proxy status to "DNS only" / grey cloud for the DKIM ones if Brevo says so).
4. In Brevo, go to SMTP & API or Transactional → SMTP, generate an "SMTP key" (this is your password).
5. In Render Environment Variables for your service, add:
   ```
   SMTP_HOST=smtp-relay.brevo.com
   SMTP_PORT=587
   SMTP_USER=your-brevo-login-email (often the one you signed up with)
   SMTP_PASS=the-smtp-key-you-generated-in-brevo
   SMTP_FROM=noreply@loganwright.tech
   ```
   (You can also use contact@loganwright.tech if you add it as a sender in Brevo.)
6. (Strongly recommended) Also set:
   ```
   PUBLIC_URL=https://collab.loganwright.tech
   ```
   This makes the links in verification emails and "new message in room" notifications point to your real domain.

**Other provider options**
- Resend.com (very dev-friendly, generous free tier)
- Mailgun (free tier for small volume)
- Your existing Google Workspace / Microsoft 365 if the domain is routed there (use their SMTP settings)

If you leave SMTP_* unset, the server will log verification codes to the Render logs (fine for testing, but you won't be able to complete signup from the web UI without checking logs).

Once SMTP is configured and the domain verified with the provider, signups will email real codes and the "Your chats" + account features work end-to-end.

### Self-Contained Docker Image

A `Dockerfile` is already included in the repo.

```bash
# Build
docker build -t collab-grok .

# Run locally (with your key)
docker run -p 3000:3000 -e XAI_API_KEY=sk-your-key-here collab-grok
```

You can:
- Use this image on Render (select "Docker" when creating the service).
- Push to GitHub Container Registry (`ghcr.io`) and run it on any free Docker host.
- Run it on a free Oracle Cloud Always-Free VM (Ampere) for true always-on + no sleep (more setup but very powerful).

### Alternative: Oracle Cloud Always Free (Truly Always-On, No Sleep)

If the sleep behavior bothers you:
1. Create a free Oracle Cloud account (always-free tier includes 2 VMs forever).
2. Launch an Ampere A1 VM.
3. Install Docker.
4. `docker run` the image above (or use docker-compose).
5. Point your domain at the VM's public IP (A record) + use Cloudflare for free TLS if wanted.
6. No cold starts, full control.

This is the most "free forever + powerful" option, but requires more initial setup than Render.

### Environment Variables on Any Platform

Never commit your real key. Always inject at runtime (via Render dashboard, docker -e, etc.):

Required for core:
- `XAI_API_KEY` (required)
- `JWT_SECRET` (required for logins in prod; long random string)

For persistent DB (Render disk):
- `DB_PATH=/data/collab.db` (only after attaching a disk at mount path `/data`)

For accounts / email:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `PUBLIC_URL` (for links in emails)

Optional:
- `XAI_MODEL` (default grok-3)
- `PORT`

The app reads `process.env` directly (dotenv is just a local convenience). See .env.example for full list + comments.

### Quick Local Test After Adding Key

```bash
npm start
# open http://localhost:3000
```

Then deploy as above.

Let me know if you want me to help generate a `render.yaml` for one-click deploys, improve the Dockerfile (e.g. multi-stage + smaller image, compile server), or walk through Oracle Cloud setup!
