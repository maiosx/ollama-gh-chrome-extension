(() => {
  const COMPANION_URL = "http://localhost:8765";
  const MARKER_ATTR = "data-owo-injected";

  function showToast(message, kind) {
    document.querySelectorAll(".owo-toast").forEach((el) => el.remove());
    const toast = document.createElement("div");
    toast.className = "owo-toast" + (kind ? " owo-" + kind : "");
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  }

  // Parse owner/repo/branch/subpath out of the current GitHub URL.
  function getRepoContext() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1];
    let branch = null;
    let subpath = "";
    if (parts[2] === "tree" && parts.length > 3) {
      branch = parts[3];
      subpath = parts.slice(4).join("/");
    }
    return {
      owner,
      repo,
      branch,
      subpath,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
    };
  }

  async function handleClick(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const ctx = getRepoContext();
    if (!ctx) {
      showToast("Couldn't figure out which repo this is.", "error");
      return;
    }
    showToast(`Cloning ${ctx.owner}/${ctx.repo}${ctx.subpath ? "/" + ctx.subpath : ""}…`);
    try {
      const res = await fetch(`${COMPANION_URL}/api/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ctx),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Companion app error");
      showToast(`Cloned. Opening workspace in a new tab…`, "success");
      window.open(`${COMPANION_URL}/workspace.html?repo=${encodeURIComponent(data.workspace)}`, "_blank");
    } catch (err) {
      showToast(
        `Couldn't reach the local Ollama companion app at ${COMPANION_URL}. Is it running? (${err.message})`,
        "error"
      );
    }
  }

  // Build a new dropdown item, styled like the existing "Download ZIP" item,
  // rather than guessing GitHub's current class names.
  function buildMenuItem(referenceEl) {
    const item = referenceEl.cloneNode(true);
    item.setAttribute(MARKER_ATTR, "1");
    item.removeAttribute("href");
    item.removeAttribute("download");
    item.setAttribute("role", "button");

    // Replace the visible label text without touching icon markup.
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let labelNode = null;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.textContent && node.textContent.trim().length > 0) {
        labelNode = node;
        break;
      }
    }
    if (labelNode) {
      labelNode.textContent = labelNode.textContent.replace(
        /Download ZIP|Open in GitHub Copilot app/,
        "Open with Ollama"
      );
    } else {
      item.textContent = "Open with Ollama";
    }

    item.addEventListener("click", handleClick, true);
    return item;
  }

  function findReferenceItem() {
    // "Download ZIP" is present in every version of this menu and is a stable anchor point.
    const candidates = Array.from(document.querySelectorAll("a, button"));
    return candidates.find(
      (el) =>
        el.textContent &&
        el.textContent.trim() === "Download ZIP" &&
        !el.hasAttribute(MARKER_ATTR)
    );
  }

  function inject() {
    const reference = findReferenceItem();
    if (!reference) return;
    if (reference.parentElement.querySelector(`[${MARKER_ATTR}]`)) return;
    const item = buildMenuItem(reference);
    reference.insertAdjacentElement("afterend", item);
  }

  const observer = new MutationObserver(() => inject());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // GitHub is a Turbo/SPA app; also re-check on navigation events.
  document.addEventListener("turbo:load", inject);
  document.addEventListener("pjax:end", inject);
  inject();
})();
