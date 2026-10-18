# Margins — web version

Read EPUB and PDF books on iPad, iPhone and Mac, highlight in 4 colours, add notes, and export them to **Apple Notes**. Works **fully offline** once installed — made for long-haul flights.

- Free, no Apple Developer account, never expires
- Your books never leave your device (nothing is uploaded anywhere)
- No build tools: these are plain files you put on a free web host once

---

## Step 1 — Put Margins online (one time, ~10 minutes, on your Mac)

You'll use **GitHub Pages**, a free hosting service. Think of it as a shelf on the internet where your app sits so your devices can download it once.

1. Unzip `margins-web.zip`. You get a folder `margins-web` with `index.html`, `app.css`, `sw.js`, and the folders `js`, `icons`, `vendor`.
2. Go to **github.com** and create a free account (or sign in).
3. Click the **+** at the top right → **New repository**.
   - **Repository name:** `margins`
   - Choose **Public** (free Pages hosting needs this; only the app's code is in it — never your books)
   - Click **Create repository**.
4. On the new, empty repository page, click the link **“uploading an existing file”**.
5. Open the `margins-web` folder in Finder, select **everything inside it** (⌘A — the files *and* the `js`, `icons`, `vendor` folders) and drag it onto the GitHub page.
6. Wait until all files are listed (about 36), then click **Commit changes** at the bottom.
7. Go to the repository's **Settings** tab → **Pages** (left menu).
   - Under **Build and deployment → Source**, choose **Deploy from a branch**.
   - Branch: **main**, folder: **/ (root)** → **Save**.
8. Wait about a minute and refresh. GitHub shows your address:
   **`https://YOUR-USERNAME.github.io/margins/`**

> Check: `index.html` must be at the top level of the repository (not inside a `margins-web` subfolder). If you see a folder, open it and drag its contents up instead.

---

## Step 2 — Install on your iPad (then iPhone)

1. On the iPad, open **Safari** and go to `https://YOUR-USERNAME.github.io/margins/`.
2. Wait for the message **“Margins is ready to work offline”**.
3. Tap the **Share** button → **Add to Home Screen** → **Add**.
4. **Always open Margins from its Home Screen icon** from now on (not from a Safari tab).
5. Tap **Import** and choose your EPUB/PDF files from the Files app, iCloud Drive or Downloads.
6. Repeat on your iPhone (and on your Mac in Safari: **File ▸ Add to Dock**, if you like).

**Test before your first flight:** turn on **Airplane Mode**, open Margins from its icon, open a book. It should work exactly the same.

---

## Using it

| To… | Do this |
|---|---|
| Highlight | Select text (press and hold, drag the handles) → tap a **colour** in the bar at the bottom |
| Highlight + note | Select text → tap **Note** → type → **Done** |
| Edit / delete | Tap a highlight in the text |
| See all highlights | Tap the **pen icon** (top right) — tap one to jump to it |
| **Export to Apple Notes** | Highlights list → **Export to Notes** → choose **Notes** → pick a folder → **Save** |
| Contents / text size | **≡** and **Aa** icons (EPUB) |
| Zoom a PDF | **–** / **+** at the bottom |
| Back up highlights | Library → **⋯** → *Back up highlights & notes* → *Save to Files* (iCloud Drive) |

---

## Good to know

- **Each device has its own library.** Import books on each device. To bring highlights over, make a backup on one device and *Restore from a backup* on the other (import the same books first).
- **Back up now and then.** Your books and highlights live only on the device. If you delete the Home Screen icon, its data is deleted too.
- **DRM-free only.** Books bought in Apple Books, Kindle or Kobo are copy-protected and can't be opened by any other app. DRM-free EPUBs and any normal PDF work.
- **Scanned PDFs** (photos of pages with no real text) can't be highlighted.

## Updating the app later

If you receive a newer version: on GitHub open the repository → **Add file ▸ Upload files** → drag the new files in → **Commit changes**. Your devices pick up the update the next time Margins opens with internet. Your books and highlights are kept.

---

*PDF rendering by Mozilla PDF.js (Apache 2.0 licence, in `vendor/pdfjs`).*
