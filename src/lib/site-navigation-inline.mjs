// Critical header interaction: no image, module or optional share dependency.
// Exact bytes are included in the reviewed CSP; never enable unsafe-inline.
export const siteNavigationScript = String.raw`(() => {
  const loadOptionalModules = () => {
    for (const entry of document.querySelectorAll("[data-uc-later-module]")) {
      const url = entry.getAttribute("data-uc-later-module");
      if (/^\/__ssr-client\/[a-f0-9]{40}\/[a-zA-Z0-9_-]+\.js$/.test(url)) {
        import(url).catch(() => {});
      }
    }
  };
  const scheduleOptionalModules = () => setTimeout(loadOptionalModules, 0);
  if (document.readyState === "complete") {
    scheduleOptionalModules();
  } else {
    window.addEventListener("load", scheduleOptionalModules, { once: true });
  }
  const header = document.querySelector("[data-site-header]");
  if (header && header.dataset.navigationReady !== "true") {
    header.dataset.navigationReady = "true";
    const menu = header.querySelector(".menu-button");
    const navigation = header.querySelector("#navigation");
    const mobile = window.matchMedia("(max-width: 1100px)");
    const disclosures = [...header.querySelectorAll("[data-nav-disclosure]")].map(
      (group) => ({
        group,
        trigger: group.querySelector(".site-nav-trigger"),
        panel: group.querySelector(".site-dropdown")
      })
    );
    const setDisclosure = (item, open) => {
      item.trigger.setAttribute("aria-expanded", String(open));
      item.panel.hidden = !open;
    };
    const close = (restoreFocus = false) => {
      const active = disclosures.find(
        (item) => item.trigger.getAttribute("aria-expanded") === "true"
      );
      disclosures.forEach((item) => setDisclosure(item, false));
      const wasMobileOpen = menu.getAttribute("aria-expanded") === "true";
      menu.setAttribute("aria-expanded", "false");
      header.classList.remove("menu-open");
      if (restoreFocus) (wasMobileOpen ? menu : active?.trigger)?.focus();
    };
    menu.addEventListener("click", () => {
      const open = menu.getAttribute("aria-expanded") !== "true";
      menu.setAttribute("aria-expanded", String(open));
      header.classList.toggle("menu-open", open);
      disclosures.forEach((item) => setDisclosure(item, open));
    });
    disclosures.forEach((item) => {
      item.trigger.addEventListener("click", () => {
        const open = item.trigger.getAttribute("aria-expanded") !== "true";
        if (!mobile.matches)
          disclosures.filter((other) => other !== item).forEach((other) => setDisclosure(other, false));
        setDisclosure(item, open);
      });
      item.trigger.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        if (!mobile.matches)
          disclosures.filter((other) => other !== item).forEach((other) => setDisclosure(other, false));
        setDisclosure(item, true);
        (item.panel.querySelector(".site-dropdown-link") ?? item.panel.querySelector("a"))?.focus();
      });
    });
    document.addEventListener("pointerdown", (event) => {
      if (!header.contains(event.target)) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && (menu.getAttribute("aria-expanded") === "true" || disclosures.some((item) => !item.panel.hidden))) {
        event.preventDefault();
        close(true);
      }
    });
    header.addEventListener("focusout", (event) => {
      if (!mobile.matches && event.relatedTarget instanceof Node && !header.contains(event.relatedTarget))
        close();
    });
    navigation.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => close()));
    mobile.addEventListener("change", () => {
      close();
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) close();
    });
  }
})();
`;
