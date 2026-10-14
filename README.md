# akash.page

My personal site and blog: notes from building [OneCamp](https://onemana.dev), and the things that broke on the way. It's live at [akash.page](https://akash.page).

## How it's built

- **Jekyll on GitHub Pages:** built from `master` with the `github-pages` gem, so only that gem's plugins run (jekyll-feed, jekyll-sitemap and jemoji).
- **No framework:**
  - styles are one hand-written stylesheet, `assets/css/site.css`;
  - every page loads one small script, `assets/js/site.js`;
  - there is no build step.
- **Fonts are self-hosted** from `assets/fonts`: Inter, Bricolage Grotesque and JetBrains Mono. All three are under the SIL Open Font License, and their licences sit next to the files.
- **Tags:** their colours, and the topics the home page offers, live in `_data/topics.yml`.

To build it exactly as GitHub Pages does:

    docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
      -e GITHUB_WORKSPACE=/w -e INPUT_SOURCE=src -e INPUT_DESTINATION=out \
      -v "$PWD":/w/src:ro -v "$PWD/_site":/w/out \
      ghcr.io/actions/jekyll-build-pages:v1.0.13

## Credits

The site began on Themefisher's Northendlab Jekyll theme. The October 2026 redesign replaced all of its layouts, styles and scripts.
