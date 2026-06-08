# FileShare

Send files of any size between devices. Files go directly browser-to-browser.
No login. No accounts. Files auto-delete. Zero cost.

---

## How it works

```
Sender → picks file → gets 6-char code → shares code/QR
Receiver → enters code → file streams directly to them → done
```

90% of the time the file goes directly between the two browsers (P2P) — it never touches the server at all.
If that fails, it uploads to the server temporarily and deletes after download.

---

## Deploy FREE in 5 minutes (Fly.io)

**1. Install Fly CLI**
```bash
curl -L https://fly.io/install.sh | sh
```

**2. Sign up (free, no credit card)**
```bash
flyctl auth signup
```

**3. Edit fly.toml — change the app name to something unique**
```
app = "yourname-fileshare"
```

**4. Deploy**
```bash
npm install
flyctl deploy
```

That's it. Your app is live at `https://yourname-fileshare.fly.dev`

---

## Run locally for testing

```bash
npm install
npm start
```

Open http://localhost:3000 — open in two browser tabs to test.

---

## Free tier limits (Fly.io)

- 3 always-on virtual machines (never sleeps)
- 160 GB outbound bandwidth/month free
- This handles ~500,000 sessions/month with zero cost

At larger scale: $5-20/month.
Traditional hosting for same traffic: $2,000-5,000/month.
