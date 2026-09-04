# Open with Ollama

Adds an **"Open with Ollama"** item to GitHub's green **Code** dropdown. Clicking it:

1. Tells a small local app (the "companion server") to `git clone` (or pull) that repo —
   including the branch/subfolder you were viewing.
2. Opens a workspace tab where you can chat with a **local Ollama model** about the code.
   When the model proposes changes, the companion server writes them straight to the
   cloned files.
3. Lets you **Commit** and **Push** from that same tab, using your machine's existing
   git credentials (SSH key / `gh auth login` / credential manager) — same as running
   `git push` from a terminal.

A browser extension by itself can't touch your filesystem or run `git`, which is why
this ships as two parts: the extension (runs in Chrome) and the companion server (runs
on your machine, one `node server.js` away).

## 1. Set up the companion server

Requires Node.js 18+ and [Ollama](https://ollama.com) installed and running locally,
with at least one model pulled, e.g.:

```bash
ollama pull qwen2.5-coder:7b
```

Then:

```bash
cd companion-server
npm install
node server.js
```

It listens on `http://localhost:8765` and talks to Ollama on `http://localhost:11434`
(both configurable via the `PORT` and `OLLAMA_URL` env vars, and the model via
`OLLAMA_MODEL` or the field in the workspace UI). Cloned repos land in
`companion-server/workspaces/`.

Leave this running in a terminal while you use the extension.

## 2. Install the Chrome extension

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `chrome-extension` folder.

## 3. Use it

Open any GitHub repo (or a subfolder via the `tree/branch/path` view), click the green
**Code** button, and choose **Open with Ollama** — it appears right after "Download ZIP".
A toast in the corner confirms the clone; a new tab opens with the file tree and chat.

## Notes / limitations

- **Pushing** requires that `git push` already works for you from a terminal on this
  machine (SSH key added, or `gh auth login` done, etc.) — the companion server just
  shells out to your local `git`, it doesn't handle GitHub auth itself.
- The model is told the repo's file listing and asked to reply with
  `<<<FILE: path>>> ... <<<END>>>` blocks for anything it wants to create or change;
  it also chats normally in prose. Large repos are truncated to the first ~60 files
  in the prompt.
- Only one Ollama request is made per message — for very large or many-file changes,
  it may help to ask for one file at a time.
- The extension finds the menu item by looking for a "Download ZIP" link and inserting
  a copy next to it, since GitHub doesn't expose a documented extension point for that
  dropdown. If GitHub changes that menu's wording, the injection may need a tweak in
  `content.js`.

Made with Claude

https://claude.ai/share/d387d18f-2ccb-4893-8077-a968a3143881
