/* Applies a stored theme before first paint, so reloading in dark mode does not
   flash white. Deliberately a separate tiny file rather than an inline script:
   that keeps the pages free of inline JavaScript and identical across the stack. */
try {
    var saved = localStorage.getItem("pi-home-theme");
    if (saved === "light" || saved === "dark") {
        document.documentElement.setAttribute("data-theme", saved);
    }
} catch (e) { /* storage blocked - fall back to the system preference */ }
