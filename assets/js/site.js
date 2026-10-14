// akash.page: the one script every page loads. No framework, no dependencies,
// and nothing here is needed to read a page. It adds the theme switch, small
// reading aids (heading links, copy buttons, the contents rail) and, only on a
// post that has them, loads Mermaid diagrams and Disqus comments.
(function () {
  "use strict";
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  // ---- theme: a saved choice wins, otherwise the system's ----
  function current() {
    var set = root.getAttribute("data-theme");
    if (set === "light" || set === "dark") return set;
    return media && media.matches ? "dark" : "light";
  }
  function label() {
    var next = current() === "dark" ? "light" : "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.setAttribute("aria-label", "Switch to " + next + " theme");
    });
  }
  document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
    b.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) {}
      label();
    });
  });
  if (media && media.addEventListener) media.addEventListener("change", label);
  label();

  // ---- header: a hairline once the page has scrolled ----
  var header = document.querySelector("[data-header]");
  if (header) {
    var onScroll = function () { header.classList.toggle("is-scrolled", window.scrollY > 4); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ---- the small-screen menu closes on a click outside it or on Escape ----
  var menu = document.querySelector("[data-menu]");
  if (menu) {
    document.addEventListener("click", function (e) {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.open) {
        menu.open = false;
        menu.querySelector("summary").focus();
      }
    });
  }

  var content = document.querySelector(".post .content");
  if (content) {
    // ---- a link on every section heading ----
    content.querySelectorAll("h2[id], h3[id]").forEach(function (h) {
      var a = document.createElement("a");
      a.className = "anchor";
      a.href = "#" + h.id;
      a.textContent = "#";
      a.setAttribute("aria-label", "Link to the section " + h.textContent.trim());
      h.appendChild(a);
    });

    // ---- code: its language, and a copy button ----
    content.querySelectorAll("div.highlighter-rouge").forEach(function (box) {
      var m = /language-([\w+#-]+)/.exec(box.className);
      var lang = m ? m[1] : "";
      var pre = box.querySelector("pre");
      if (!pre || lang === "mermaid") return;
      var bar = document.createElement("div");
      bar.className = "code-bar";
      var name = document.createElement("span");
      name.className = "lang";
      name.dataset.lang = lang;
      name.textContent = lang && lang !== "plaintext" ? lang : "text";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Copy";
      btn.setAttribute("aria-label", "Copy this code");
      btn.addEventListener("click", function () {
        var text = pre.innerText.replace(/\n$/, "");
        var done = function (ok) {
          btn.textContent = ok ? "Copied" : "Select and copy";
          btn.classList.toggle("is-done", ok);
          setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("is-done"); }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        } else {
          done(false);
        }
      });
      bar.appendChild(name);
      bar.appendChild(btn);
      box.insertBefore(bar, box.firstChild);
    });

    // ---- a code block that scrolls sideways can be reached and scrolled by keyboard ----
    var pres = content.querySelectorAll("pre");
    var focusable = function () {
      pres.forEach(function (pre) {
        if (pre.scrollWidth > pre.clientWidth + 1) {
          pre.setAttribute("tabindex", "0");
        } else {
          pre.removeAttribute("tabindex");
        }
      });
    };
    focusable();
    var resizeTimer = null;
    window.addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(focusable, 200); });

    // ---- wide tables scroll inside their own region, never the page ----
    content.querySelectorAll("table").forEach(function (t) {
      var wrap = document.createElement("div");
      wrap.className = "table-wrap";
      wrap.setAttribute("role", "region");
      wrap.setAttribute("tabindex", "0");
      wrap.setAttribute("aria-label", "Table, scrolls sideways");
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });
  }

  // ---- contents rail: mark the section being read ----
  var toc = document.querySelector(".toc");
  if (toc) {
    var links = {};
    toc.querySelectorAll("a").forEach(function (a) { links[decodeURIComponent(a.hash.slice(1))] = a; });
    var heads = Array.prototype.filter.call(document.querySelectorAll(".content h2[id]"), function (h) { return links[h.id]; });
    var active = null, queued = false;
    var mark = function () {
      queued = false;
      var line = window.innerHeight * 0.3, id = null;
      for (var i = 0; i < heads.length; i++) {
        if (heads[i].getBoundingClientRect().top <= line) id = heads[i].id; else break;
      }
      var next = id ? links[id] : null;
      if (next === active) return;
      if (active) active.removeAttribute("aria-current");
      if (next) next.setAttribute("aria-current", "true");
      active = next;
    };
    window.addEventListener("scroll", function () {
      if (!queued) { queued = true; window.requestAnimationFrame(mark); }
    }, { passive: true });
    mark();
  }

  // ---- Mermaid: only on a page with a diagram, and only then downloaded ----
  var blocks = document.querySelectorAll("code.language-mermaid");
  if (blocks.length) {
    var nodes = [];
    blocks.forEach(function (block) {
      var target = block.closest(".highlighter-rouge") || block.parentElement;
      var wrapper = document.createElement("div");
      wrapper.className = "mermaid-wrapper";
      var hint = document.createElement("div");
      hint.className = "mermaid-hint";
      hint.textContent = "Scroll to zoom, drag to pan.";
      var full = document.createElement("button");
      full.type = "button";
      full.textContent = "Full screen";
      full.addEventListener("click", function () {
        var on = wrapper.classList.toggle("fullscreen");
        full.textContent = on ? "Exit full screen" : "Full screen";
        document.body.style.overflow = on ? "hidden" : "";
        setTimeout(function () { window.dispatchEvent(new Event("resize")); }, 50);
      });
      hint.appendChild(full);
      var div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = block.textContent;
      wrapper.appendChild(hint);
      wrapper.appendChild(div);
      target.replaceWith(wrapper);
      nodes.push(div);
    });
    import("https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs").then(function (m) {
      var mermaid = m.default;
      mermaid.initialize({ startOnLoad: false, theme: current() === "dark" ? "dark" : "default" });
      return mermaid.run({ nodes: nodes });
    }).then(function () {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js";
      s.onload = function () {
        document.querySelectorAll(".mermaid svg").forEach(function (svg) {
          var h = Math.max(svg.getBoundingClientRect().height, 450);
          svg.style.width = "100%";
          svg.style.height = h + "px";
          svg.style.maxWidth = "none";
          window.svgPanZoom(svg, { zoomEnabled: true, controlIconsEnabled: true, fit: true, center: true, minZoom: 0.5, maxZoom: 10 });
        });
      };
      document.head.appendChild(s);
    }).catch(function () {});
  }

  // ---- Disqus: loads as the reader nears the end of a post, not on arrival ----
  var thread = document.getElementById("disqus_thread");
  if (thread && thread.dataset.shortname) {
    var load = function () {
      var d = document.createElement("script");
      d.src = "https://" + thread.dataset.shortname + ".disqus.com/embed.js";
      d.setAttribute("data-timestamp", String(+new Date()));
      document.body.appendChild(d);
    };
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); load(); }
      }, { rootMargin: "600px 0px" });
      io.observe(thread);
    } else {
      load();
    }
  }
})();
