// Search over every post. The index (/search.json) is fetched only when this
// page opens, so no other page carries it. Scoring is plain substring
// counting: a hit in the title counts most, then the tags, the description,
// then the body. Results update as you type, and the address keeps the query
// so a search can be shared. Text is only ever set with textContent.
(function () {
  "use strict";
  var script = document.currentScript || document.querySelector("script[data-index]");
  var box = document.getElementById("search-box");
  var status = document.getElementById("search-status");
  var list = document.getElementById("search-results");
  var form = box.form;
  var posts = null;

  function count(hay, t) {
    var n = 0, i = 0;
    while ((i = hay.indexOf(t, i)) !== -1) { n++; i += t.length; }
    return n;
  }

  // the title, with each matched term marked
  function markTitle(el, title, terms) {
    var lower = title.toLowerCase(), i = 0;
    while (i < title.length) {
      var best = -1, len = 0;
      for (var k = 0; k < terms.length; k++) {
        var at = lower.indexOf(terms[k], i);
        if (at !== -1 && (best === -1 || at < best)) { best = at; len = terms[k].length; }
      }
      if (best === -1) { el.appendChild(document.createTextNode(title.slice(i))); break; }
      if (best > i) el.appendChild(document.createTextNode(title.slice(i, best)));
      var m = document.createElement("mark");
      m.textContent = title.slice(best, best + len);
      el.appendChild(m);
      i = best + len;
    }
  }

  function render(q) {
    list.textContent = "";
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {
      status.textContent = posts.length + " posts to search, title to last line.";
      return;
    }
    var hits = [];
    for (var p = 0; p < posts.length; p++) {
      var post = posts[p], score = 0;
      var title = post.t.toLowerCase(), tags = post.g.toLowerCase(), desc = (post.s || "").toLowerCase(), body = post.b.toLowerCase();
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i];
        var s = count(title, t) * 20 + count(tags, t) * 10 + count(desc, t) * 4 + Math.min(count(body, t), 20);
        if (!s) { score = 0; break; }
        score += s;
      }
      if (score) hits.push({ p: post, score: score });
    }
    hits.sort(function (a, b) { return b.score - a.score; });
    status.textContent = hits.length
      ? hits.length + " post" + (hits.length === 1 ? "" : "s") + " match “" + q + "”."
      : "Nothing matches “" + q + "”. Try a shorter word, or browse the tags.";
    hits.slice(0, 50).forEach(function (h) {
      var li = document.createElement("li");
      li.className = "post-row m-blue";
      var time = document.createElement("time");
      time.className = "post-row-date";
      time.dateTime = h.p.i;
      time.textContent = h.p.d;
      var main = document.createElement("div");
      main.className = "post-row-main";
      var h2 = document.createElement("h2");
      var a = document.createElement("a");
      a.href = h.p.u;
      markTitle(a, h.p.t, terms);
      h2.appendChild(a);
      main.appendChild(h2);
      if (h.p.s) {
        var d = document.createElement("p");
        d.textContent = h.p.s;
        main.appendChild(d);
      }
      li.appendChild(time);
      li.appendChild(main);
      list.appendChild(li);
    });
  }

  var q = new URLSearchParams(window.location.search).get("query") || "";
  box.value = q;
  if (!q) box.focus();
  status.textContent = "Loading the index…";

  fetch(script.getAttribute("data-index"))
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (data) {
      posts = data;
      render(box.value.trim());
      var timer = null;
      box.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          var v = box.value.trim();
          var url = new URL(window.location.href);
          if (v) url.searchParams.set("query", v); else url.searchParams.delete("query");
          window.history.replaceState(null, "", url);
          render(v);
        }, 120);
      });
      form.addEventListener("submit", function (e) { e.preventDefault(); render(box.value.trim()); });
    })
    .catch(function () {
      status.textContent = "Search could not load. Every post is still in the archive.";
    });
})();
