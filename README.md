# Insurance Claim Checker

A web app that lets people upload their health insurance documentation (policies, Summary of Benefits, Evidence of Coverage), then upload an EOB or doctor's bill and get a plain-English read on whether the charges are within their coverage. The result screen turns **green** when the claim appears covered, **red** when it appears denied, or **amber** when the policy is silent — each answer backed by verbatim quotes pulled from the policy documents.

Claim analysis runs through Claude via a Vercel serverless function (so your API key stays on the server). If the server is unreachable, the app falls back to an offline keyword/exclusion scanner so users always get an answer.

---

## Project structure

```
.
├── api/
│   └── analyze.js          Vercel serverless function — calls Claude
├── public/
│   └── favicon.svg
├── src/
│   ├── App.jsx             Main React component (upload UI + result screen)
│   ├── main.jsx            React entry point
│   └── index.css           Tailwind directives
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── vercel.json
├── .env.example
└── .gitignore
```

---

## Prerequisites

You'll need these installed on your computer:

1. **Node.js 18 or newer** — download from [nodejs.org](https://nodejs.org). Verify with `node --version`.
2. **Git** — download from [git-scm.com](https://git-scm.com).
3. **An Anthropic API key** — get one at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys). You'll need to add a few dollars of credit.
4. **A GitHub account** — [github.com/signup](https://github.com/signup).
5. **A Vercel account** — [vercel.com/signup](https://vercel.com/signup). Sign in with GitHub so the two are linked.

---

## Run it locally first

Open a terminal in this folder. If you're on **Windows**, use PowerShell or Command Prompt. On **macOS/Linux**, use Terminal.

Install dependencies:

```
npm install
```

Create your local `.env` file from the template:

**Windows (PowerShell or CMD):**

```
copy .env.example .env
```

**macOS / Linux:**

```
cp .env.example .env
```

Open `.env` in a text editor (Notepad, VS Code, whatever) and paste your real Anthropic API key on the `ANTHROPIC_API_KEY` line:

```
ANTHROPIC_API_KEY=sk-ant-your-real-key-here
```

Then start the dev server (same command on every OS):

```
npm run dev
```

Visit `http://localhost:5173` — you should see the upload page.

> **Note:** `npm run dev` only runs the frontend. To test the `/api/analyze` endpoint locally, install the Vercel CLI (`npm install -g vercel`) and run `vercel dev` instead. If you don't test the server locally, you can still click Analyze — it'll just fall back to the offline keyword scanner.

---

## Deploy it publicly (Vercel, recommended — about 10 minutes)

### Step 1 — Push to GitHub

From this folder, run each line one at a time (works on Windows, macOS, and Linux):

```
git init
git add .
git commit -m "Initial commit"
```

Then, in the GitHub website, create a new empty repository (don't add a README or license — we already have files). Copy the commands GitHub shows you under "...or push an existing repository from the command line", which will look like:

```
git remote add origin https://github.com/YOUR-USERNAME/insurance-claim-checker.git
git branch -M main
git push -u origin main
```

### Step 2 — Import to Vercel

1. Go to [vercel.com/new](https://vercel.com/new).
2. Click **Import** next to your new GitHub repo. (You may need to grant Vercel access to the repo the first time.)
3. On the configuration screen Vercel auto-detects Vite — leave all defaults.
4. **Before clicking Deploy,** expand **Environment Variables** and add:

   | Name                | Value                                           |
   | ------------------- | ----------------------------------------------- |
   | `ANTHROPIC_API_KEY` | your real `sk-ant-…` key                        |
   | `ALLOWED_ORIGIN`    | *(leave blank for now — we'll set this after)*  |

5. Click **Deploy**. In 1–2 minutes you'll have a live URL like `insurance-claim-checker.vercel.app`.

### Step 3 — Lock the API endpoint to your site (important)

Until you do this, anyone who finds your `/api/analyze` URL can use it with your API key. To prevent that:

1. In the Vercel dashboard, open your project → **Settings** → **Environment Variables**.
2. Edit `ALLOWED_ORIGIN` and set it to your deployed URL, e.g. `https://insurance-claim-checker.vercel.app` (no trailing slash).
3. Under **Deployments**, open the latest deployment and click **Redeploy**.

Now browser requests from any other origin will be blocked by CORS.

### Step 4 — (Optional) Add a custom domain

In Vercel → Project → **Settings** → **Domains**, click **Add** and follow the prompts. If you bought the domain at a registrar like Namecheap or Cloudflare, Vercel will give you the DNS records to paste in. Remember to update `ALLOWED_ORIGIN` to the new domain and redeploy.

---

## How updates work

Once linked, every push to the `main` branch of your GitHub repo triggers Vercel to rebuild and deploy automatically. To make a change, run these one at a time:

```
git add .
git commit -m "describe your change"
git push
```

Watch the deployment progress in the Vercel dashboard.

---

## Cost and safety notes

- **API cost.** Each Analyze click sends your policy documents + the claim to Claude. Long policies cost a few cents per request. Watch your Anthropic console's usage page.
- **Rate limiting.** Vercel's free tier is generous but not unlimited. If you expect heavy traffic, add rate limiting (e.g. [`@upstash/ratelimit`](https://upstash.com/docs/oss/sdks/ts/ratelimit/overview)) inside `api/analyze.js`.
- **Privacy.** Documents are sent to your server and then to Anthropic only when the user clicks Analyze. They are not stored anywhere by this app. Anthropic's API terms govern how Anthropic handles the data — review them before advertising this as "HIPAA compliant" (it isn't, out of the box).
- **Abuse.** `ALLOWED_ORIGIN` plus the fact that the key lives server-side is enough to stop casual abuse but not a determined attacker. Consider adding authentication (Vercel + Auth.js, or Clerk) if this becomes a real product.

---

## Troubleshooting

| Problem                                       | Likely fix                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Blank white screen after deploy               | Open browser devtools → Console. Usually a missing env var or a build error shown in Vercel logs. |
| "Server analysis failed" banner always shows  | Confirm `ANTHROPIC_API_KEY` is set in Vercel, then redeploy.                                     |
| Works on vercel.app but not your custom domain | Update `ALLOWED_ORIGIN` to the custom domain and redeploy.                                       |
| PDF never finishes parsing                    | Try a different PDF — some scanned PDFs have no extractable text; photograph the pages instead. |
| "Your API key does not have access to this model" | Either your account has no credit, or the model name changed. Bump credit or edit `MODEL` in `api/analyze.js`. |

---

## Disclaimer

This app is a decision-support tool, not legal, medical, or insurance advice. Insurance contracts are complex and imperfectly represented by keyword matching or even LLM analysis. Always verify coverage decisions with your insurer before acting on them.
