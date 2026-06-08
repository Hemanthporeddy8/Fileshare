# FileShare — Setup Steps

## What is in this zip

```
test/
  index.html              Open this in Chrome to test on your computer

signal-server/
  server.js               The signaling server
  package.json
  Dockerfile
  fly.toml                Edit app name then deploy to Fly.io

website/
  app/share/
    page.tsx              Copy this into your editroy.com Next.js project
```

---

## PART 1 — Test on your computer first

### Step 1 — Install Node.js
Go to nodejs.org → Download LTS → Install

### Step 2 — Run the signal server
Open Terminal in the signal-server folder:
```
npm install
npm start
```
You should see: Signal server running on :8080

### Step 3 — Open the test page
Open test/index.html in Chrome

### Step 4 — Test it
Open test/index.html in a second Chrome tab
One tab clicks Send, picks a file, shares the code
Other tab clicks Receive, enters the code
File transfers directly — done

---

## PART 2 — Add to editroy.com

### Step 1 — Create Fly.io account
Go to fly.io → Sign Up — no credit card needed

### Step 2 — Install Fly CLI
Mac/Linux:
```
curl -L https://fly.io/install.sh | sh
```
Windows PowerShell:
```
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

### Step 3 — Login
```
flyctl auth login
```

### Step 4 — Edit fly.toml
Open signal-server/fly.toml
Change this line:
```
app = "fileshare-signal"
```
To something unique:
```
app = "editroy-signal"
```

### Step 5 — Deploy signal server
```
cd signal-server
npm install
flyctl deploy
```
You get a URL like: https://editroy-signal.fly.dev
Test it: curl https://editroy-signal.fly.dev/health

### Step 6 — Copy page.tsx to your project
Copy website/app/share/page.tsx into your project at:
your-project/app/share/page.tsx

### Step 7 — Add env variable in Vercel
Go to vercel.com → your project → Settings → Environment Variables
Add:
  Name:  NEXT_PUBLIC_SIGNAL_URL
  Value: wss://editroy-signal.fly.dev

### Step 8 — Push to Git
```
git add .
git commit -m "add fileshare"
git push
```

Done. Your feature is live at editroy.com/share
