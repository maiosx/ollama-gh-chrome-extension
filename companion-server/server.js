const path = require("path");
const fs = require("fs/promises");
const fss = require("fs");
const express = require("express");
const cors = require("cors");
const simpleGit = require("simple-git");

const PORT = process.env.PORT || 8765;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
const WORKSPACES_ROOT = path.join(__dirname, "workspaces");
const MAX_FILES_IN_PROMPT = 60;
const MAX_FILE_BYTES_IN_PROMPT = 20000;

const app = express();
app.use(cors({ origin: "https://github.com" }));
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

fss.mkdirSync(WORKSPACES_ROOT, { recursive: true });

function slugFor(owner, repo) {
  return `${owner}__${repo}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function workspacePath(slug) {
  const resolved = path.resolve(WORKSPACES_ROOT, slug);
  if (!resolved.startsWith(WORKSPACES_ROOT)) {
    throw new Error("invalid workspace name");
  }
  return resolved;
}

// Resolve a user-supplied relative path safely inside a workspace.
function safeJoin(base, relPath) {
  const resolved = path.resolve(base, "." + path.sep + (relPath || ""));
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error("path escapes workspace");
  }
  return resolved;
}

async function readMeta(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, ".owo-meta.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeMeta(dir, meta) {
  await fs.writeFile(path.join(dir, ".owo-meta.json"), JSON.stringify(meta, null, 2));
}

// ---- Clone / update a repo -------------------------------------------------

app.post("/api/clone", async (req, res) => {
  try {
    const { owner, repo, branch, subpath, cloneUrl } = req.body || {};
    if (!owner || !repo || !cloneUrl) {
      return res.status(400).json({ error: "owner, repo and cloneUrl are required" });
    }
    const slug = slugFor(owner, repo);
    const dir = workspacePath(slug);

    if (fss.existsSync(path.join(dir, ".git"))) {
      const git = simpleGit(dir);
      if (branch) {
        await git.fetch("origin", branch);
        await git.checkout(branch);
        await git.pull("origin", branch);
      } else {
        await git.pull();
      }
    } else {
      await fs.mkdir(dir, { recursive: true });
      const git = simpleGit();
      const args = branch ? ["--branch", branch] : [];
      await git.clone(cloneUrl, dir, args);
    }

    await writeMeta(dir, { owner, repo, branch: branch || null, subpath: subpath || "", cloneUrl });
    res.json({ workspace: slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- File tree / file content ---------------------------------------------

async function buildTree(dir, relDir = "", depth = 0) {
  if (depth > 6) return [];
  const entries = await fs.readdir(path.join(dir, relDir), { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".owo-meta.json") continue;
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      items.push({ type: "dir", path: rel, children: await buildTree(dir, rel, depth + 1) });
    } else {
      items.push({ type: "file", path: rel });
    }
  }
  return items;
}

app.get("/api/meta", async (req, res) => {
  try {
    const dir = workspacePath(req.query.repo);
    const meta = await readMeta(dir);
    if (!meta) return res.status(404).json({ error: "unknown workspace" });
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tree", async (req, res) => {
  try {
    const dir = workspacePath(req.query.repo);
    res.json({ tree: await buildTree(dir) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    const dir = workspacePath(req.query.repo);
    const filePath = safeJoin(dir, req.query.path);
    const content = await fs.readFile(filePath, "utf8");
    res.json({ path: req.query.path, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Chat with local Ollama, applying any file edits it proposes ----------

function flattenFiles(tree, out = []) {
  for (const node of tree) {
    if (node.type === "file") out.push(node.path);
    else flattenFiles(node.children, out);
  }
  return out;
}

async function buildContext(dir, meta) {
  const tree = await buildTree(dir);
  const files = flattenFiles(tree).slice(0, MAX_FILES_IN_PROMPT);
  let listing = files.join("\n");
  if (meta && meta.subpath) {
    listing = `(User is focused on subdirectory: ${meta.subpath})\n` + listing;
  }
  return listing;
}

function parseFileEdits(text) {
  const edits = [];
  const re = /<<<FILE:\s*(.+?)>>>\r?\n([\s\S]*?)<<<END>>>/g;
  let m;
  while ((m = re.exec(text))) {
    edits.push({ path: m[1].trim(), content: m[2] });
  }
  return edits;
}

app.post("/api/chat", async (req, res) => {
  try {
    const { repo, message, model } = req.body || {};
    const dir = workspacePath(repo);
    const meta = await readMeta(dir);
    const listing = await buildContext(dir, meta);

    const systemPrompt = [
      "You are a local coding assistant working directly on a cloned git repository.",
      "Repository file listing (relative paths):",
      listing,
      "",
      "When you want to create or modify a file, include a block EXACTLY in this form for each file:",
      "<<<FILE: relative/path/to/file.ext>>>",
      "(full new contents of the file)",
      "<<<END>>>",
      "You may include several such blocks. Write a brief plain-English summary of your changes outside the blocks.",
      "Only include blocks for files you are actually changing or creating.",
    ].join("\n");

    const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
      }),
    });

    if (!ollamaRes.ok) {
      const text = await ollamaRes.text();
      throw new Error(`Ollama error: ${text}`);
    }
    const data = await ollamaRes.json();
    const reply = data.message ? data.message.content : "";

    const edits = parseFileEdits(reply);
    const applied = [];
    for (const edit of edits) {
      const filePath = safeJoin(dir, edit.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, edit.content);
      applied.push(edit.path);
    }

    res.json({ reply, appliedFiles: applied });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Commit / push back to GitHub -----------------------------------------

app.post("/api/git/commit", async (req, res) => {
  try {
    const { repo, message } = req.body || {};
    const dir = workspacePath(repo);
    const git = simpleGit(dir);
    await git.add(["-A"]);
    const summary = await git.commit(message || "Edits via Open with Ollama");
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/git/push", async (req, res) => {
  try {
    const { repo } = req.body || {};
    const dir = workspacePath(repo);
    const git = simpleGit(dir);
    const status = await git.status();
    const branch = status.current;
    const result = await git.push("origin", branch);
    res.json({ result, branch });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/status", async (req, res) => {
  try {
    const dir = workspacePath(req.query.repo);
    const git = simpleGit(dir);
    res.json(await git.status());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Open with Ollama companion app listening on http://localhost:${PORT}`);
  console.log(`Using Ollama at ${OLLAMA_URL}, default model "${DEFAULT_MODEL}"`);
});
