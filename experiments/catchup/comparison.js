// Native fragment links remain usable without JavaScript. This only supplies
// focus and a return path to the summary the reader actually came from.
(() => {
  function currentTarget() {
    return document.getElementById(decodeURIComponent(location.hash.slice(1)));
  }

  function focusTarget() {
    const target = currentTarget();
    if (target?.matches("article")) target.focus({ preventScroll: true });
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-summary]");
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const related = new Set(link.dataset.sources.split(" "));
    for (const source of document.querySelectorAll(".source-card")) {
      const isRelated = related.has(source.id.slice("source-".length));
      source.classList.toggle("is-related", isRelated);
      if (isRelated) {
        const returnLink = source.querySelector(".return-link");
        returnLink.href = `#${link.dataset.summary}`;
      }
    }
    // Repeated clicks on the same hash do not emit hashchange.
    requestAnimationFrame(focusTarget);
  });

  window.addEventListener("hashchange", focusTarget);
  if (location.hash) focusTarget();
})();
