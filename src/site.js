function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const root = document.querySelector("[data-catalog]");
if (root) {
  const input = document.querySelector("#q");
  const typeSelect = document.querySelector("#type");
  const params = new URLSearchParams(location.search);
  if (input && params.get("q")) input.value = params.get("q");
  if (typeSelect && params.get("type")) typeSelect.value = params.get("type");

  const response = await fetch("/catalog.json");
  const catalog = await response.json();

  const render = () => {
    const q = (input?.value || "").trim().toLowerCase();
    const type = typeSelect?.value || "";
    const hits = catalog.items.filter((item) => {
      if (type && item.type !== type) return false;
      if (!q) return true;
      return item.search.includes(q);
    });
    const url = new URL(location.href);
    if (q) url.searchParams.set("q", q);
    else url.searchParams.delete("q");
    if (type) url.searchParams.set("type", type);
    else url.searchParams.delete("type");
    history.replaceState(null, "", url);

    if (!hits.length) {
      root.innerHTML = `<p class="empty">Nothing on the shelf matches.</p>`;
      return;
    }
    root.innerHTML = `<div class="shelf">${hits
      .map(
        (item) => `<a class="card" href="${esc(item.path)}">
          <div class="card-kicker"><span class="kind">${esc(item.type)}</span><span>${esc(item.dateDisplay)}</span></div>
          <h2>${esc(item.title)}</h2>
          <p>${esc(item.summary)}</p>
        </a>`
      )
      .join("")}</div>`;
  };

  input?.addEventListener("input", render);
  typeSelect?.addEventListener("change", render);
  render();
}
