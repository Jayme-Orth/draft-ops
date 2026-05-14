# Draft.Ops — Deployment Guide

A live fantasy football draft board you can run on your own domain, on your phone, or anywhere. Free forever.

---

## What you're getting

This is a complete Vite + React project with:

- The full Draft.Ops app (rankings, ADP, targets, draft board, live dashboard)
- All data stored in your browser's localStorage — nothing leaves your device
- PWA-ready (installable to iOS/Android home screen as a real app icon)
- Zero monthly cost on Vercel/Netlify free tier

---

## Option A — Vercel (recommended, ~10 min)

The simplest path. You'll end up with a URL like `draft-ops.vercel.app`.

### One-time setup

1. **Install Node.js** if you don't have it: https://nodejs.org/ (LTS version)
2. **Sign up for free accounts** at:
   - GitHub: https://github.com/signup
   - Vercel: https://vercel.com/signup (sign in with GitHub)

### Deploy steps

1. Unzip this folder somewhere on your computer.

2. Open a terminal in that folder and run:
   ```bash
   npm install
   npm run dev
   ```
   This starts a local dev server. Open the URL it prints (usually http://localhost:5173) to test. If everything looks right, stop the server (Ctrl+C).

3. Push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   ```
   Then create a new empty repo on GitHub (don't initialize with a README), and follow GitHub's instructions to push:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/draft-ops.git
   git branch -M main
   git push -u origin main
   ```

4. Go to **vercel.com**, click "Add New → Project", and import your GitHub repo. Vercel auto-detects Vite — just click **Deploy**. You'll get a live URL in about 60 seconds.

5. Bookmark the URL on your phone, or **add it to your home screen** (see below) for the best experience.

---

## Option B — Netlify (alternative, also free)

Same idea, different host. The `netlify.toml` file in this folder is already configured.

1. Push to GitHub (same as Option A steps 1–3).
2. Go to **app.netlify.com**, click "Add new site → Import an existing project", connect GitHub, pick the repo. Deploy is automatic.

---

## Option C — StackBlitz (zero install, instant)

If you don't want to install Node or use GitHub at all:

1. Go to https://stackblitz.com/
2. Click "Create a new project" → pick the **Vite + React** template
3. Replace the generated `src/App.jsx` content with the contents of `src/DraftApp.jsx` from this folder
4. Replace `index.html` and `src/main.jsx` with the versions in this folder
5. Add Tailwind: in the file tree, create `tailwind.config.js`, `postcss.config.js`, and replace `src/index.css` with the versions in this folder. Add `tailwindcss`, `autoprefixer`, `postcss`, and `lucide-react` from the Dependencies panel.
6. StackBlitz gives you a live URL automatically. Click "Connect Repository" to push to GitHub if you want it permanent.

This route is fastest but the URL is less polished (something like `stackblitz.com/edit/your-project`). Use Vercel/Netlify for a cleaner URL.

---

## Add to your phone's home screen (iOS — best mobile experience)

Once your URL is live:

1. Open it in **Safari** on your iPhone (must be Safari, not Chrome)
2. Tap the **Share** button (square with up-arrow)
3. Scroll down and tap **Add to Home Screen**
4. Name it "Draft.Ops" and tap Add

Now you have an app icon on your home screen. Tap it and it opens fullscreen — no browser UI — exactly like a native app. Your draft data persists between sessions because localStorage survives.

### Android equivalent

Open the URL in Chrome → menu (three dots) → "Add to Home screen" or "Install app". Same effect.

---

## Updating the app later

If you want to change something:

1. Edit `src/DraftApp.jsx` locally
2. Commit and push to GitHub
3. Vercel/Netlify auto-deploys within ~30 seconds. The URL stays the same.

---

## Data privacy & portability

All your rankings, ADP, targets, and draft state live in your browser's localStorage. That means:

- **Nothing is sent to a server** — no account, no login, no tracking
- **Per-device** — your data on your laptop is separate from your phone. If you want to use both, you'll need to re-paste rankings on each
- **Survives reloads** but is **per-browser** — clearing Safari data wipes the app's state, so don't do that mid-draft
- If you want to share a draft live with someone else, you'd need a real backend (out of scope here)

---

## Custom domain (optional, ~$12/year)

If you want `draftops.yourname.com` instead of `draft-ops.vercel.app`:

1. Buy a domain from Namecheap, Cloudflare, or Porkbun
2. In Vercel → your project → Settings → Domains → add your domain
3. Vercel gives you DNS records to copy into your domain registrar's settings

The hosting stays free; you're just paying for the name.

---

## Troubleshooting

**`npm install` fails**: Make sure you have Node 18+. Run `node --version`.

**Page is blank in production**: Check the browser console (F12). Usually a missing dependency. Run `npm install` again.

**Mobile view feels cramped**: The app is designed for desktop primarily. On phone, rotate to landscape for the full dashboard view, or use it portrait for the Quick Pick bar + Top Available stack.

**Lost my data**: localStorage is browser-specific. If you cleared Safari history or switched browsers, the data is gone. Always export rankings/ADP elsewhere as a backup before clearing.
