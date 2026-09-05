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
  // Case-insensitive and tolerant of extra spaces, since small models are
  // inconsistent about exact formatting.
  const re = /<<<\s*FILE\s*:\s*(.+?)\s*>>>\s*\r?\n([\s\S]*?)<<<\s*END\s*>>>/gi;
  let m;
  while ((m = re.exec(text))) {
    edits.push({ path: m[1].trim().replace(/^`+|`+$/g, ""), content: m[2] });
  }
  return edits;
}

// True if the reply contains an opening <<<FILE:...>>> marker with no matching
// <<<END>>> after it — almost always means the model's output got cut off
// before it finished writing the file.
function looksTruncated(text) {
  const opens = (text.match(/<<<\s*FILE\s*:/gi) || []).length;
  const ends = (text.match(/<<<\s*END\s*>>>/gi) || []).length;
  return opens > ends;
}

function stripCodeFence(content) {
  // Models sometimes wrap file contents in a markdown fence even inside the
  // <<<FILE>>> block. Strip a leading/trailing ``` line if present.
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && /^```/.test(lines[0].trim())) lines.shift();
  if (lines.length > 0 && /^```\s*$/.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join("\n");
}

app.post("/api/chat", async (req, res) => {
  try {
    const { repo, message, model } = req.body || {};
    const dir = workspacePath(repo);
    if (!fss.existsSync(path.join(dir, ".git"))) {
      return res.status(400).json({ error: "This workspace isn't a git repo — clone it again via the extension." });
    }
    const meta = await readMeta(dir);
    const listing = await buildContext(dir, meta);

    const systemPrompt = [
      "You are a local coding assistant working directly on a cloned git repository.",
      "Repository file listing (relative paths):",
      listing,
      "",
      "When you want to create or modify a file, include a block EXACTLY in this form for each file:",
      "<<<FILE: relative/path/to/file.ext>>>",
      "(full new contents of the file, nothing else — no markdown code fences)",
      "<<<END>>>",
      "You may include several such blocks. Write a brief plain-English summary of your changes outside the blocks.",
      "Only include blocks for files you are actually changing or creating.",
      "Example:",
      "<<<FILE: src/greet.js>>>",
      'export function greet(name) {\n  return `Hello, ${name}!`;\n}',
      "<<<END>>>",
    ].join("\n");

    const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        stream: false,
        // -1 = no artificial cap on output length. The default limit is short
        // enough that full-file rewrites routinely got cut off mid-file,
        // silently dropping the edit (no closing <<<END>>> to match on).
        options: { num_predict: -1 },
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
    const truncated = data.done_reason === "length" || looksTruncated(reply);

    const edits = parseFileEdits(reply);
    const applied = [];
    const writeErrors = [];
    for (const edit of edits) {
      try {
        const filePath = safeJoin(dir, edit.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, stripCodeFence(edit.content));
        applied.push(edit.path);
      } catch (writeErr) {
        writeErrors.push(`${edit.path}: ${writeErr.message}`);
      }
    }

    // Don't just trust our own regex — ask git what it actually sees changed
    // on disk, so the UI reflects ground truth rather than our parser's guess.
    const git = simpleGit(dir);
    const status = await git.status();
    const gitChangedFiles = [...status.not_added, ...status.modified, ...status.created];

    res.json({ reply, appliedFiles: applied, writeErrors, truncated, gitChangedFiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Commit / push back to GitHub -----------------------------------------

async function hasGitIdentity(git) {
  try {
    const name = (await git.raw(["config", "user.name"])).trim();
    const email = (await git.raw(["config", "user.email"])).trim();
    return Boolean(name && email);
  } catch {
    return false;
  }
}

app.post("/api/git/commit", async (req, res) => {
  try {
    const { repo, message } = req.body || {};
    const dir = workspacePath(repo);
    if (!fss.existsSync(path.join(dir, ".git"))) {
      return res.status(400).json({ error: "This workspace isn't a git repo — clone it again via the extension." });
    }
    const git = simpleGit(dir);

    const status = await git.status();
    if (status.files.length === 0) {
      return res.json({
        committed: false,
        message: "Nothing to commit — git sees no changes in the working tree. Ask the model to make an edit first (check the chat for an 'Updated:' confirmation before committing).",
      });
    }

    if (!(await hasGitIdentity(git))) {
      return res.status(400).json({
        error:
          "git doesn't know who you are yet. Run once in a terminal: " +
          'git config --global user.email "you@example.com" && git config --global user.name "Your Name"',
      });
    }

    await git.add(["-A"]);
    const summary = await git.commit(message || "Edits via Open with Ollama");
    res.json({ committed: true, summary, filesChanged: status.files.map((f) => f.path) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/git/push", async (req, res) => {
  try {
    const { repo } = req.body || {};
    const dir = workspacePath(repo);
    if (!fss.existsSync(path.join(dir, ".git"))) {
      return res.status(400).json({ error: "This workspace isn't a git repo — clone it again via the extension." });
    }
    const git = simpleGit(dir);
    const status = await git.status();
    const branch = status.current;

    if (!status.tracking) {
      // First push of a branch that has no upstream yet.
      const result = await git.push(["-u", "origin", branch]);
      return res.json({ result, branch, pushed: true, note: "Set up tracking against origin/" + branch + "." });
    }

    if (status.ahead === 0) {
      return res.json({
        pushed: false,
        branch,
        message:
          status.behind > 0
            ? `Nothing to push — your local branch is ${status.behind} commit(s) behind origin/${branch}. Pull first.`
            : "Nothing to push — local branch already matches origin.",
      });
    }

    const result = await git.push("origin", branch);
    res.json({ result, branch, pushed: true });
  } catch (err) {
    const msg = String(err.message || "");
    let friendly = msg;
    if (/rejected|non-fast-forward|fetch first/i.test(msg)) {
      friendly = "Push rejected — origin has commits you don't have locally. Pull/rebase, then push again.\n\n" + msg;
    } else if (/could not read username|authentication|permission denied|publickey/i.test(msg)) {
      friendly = "Git couldn't authenticate to GitHub. Confirm `git push` works from a terminal in this workspace first (SSH key or `gh auth login`).\n\n" + msg;
    }
    res.status(500).json({ error: friendly });
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
