import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";
import { marked } from "marked";

// Renders imported .md files to HTML at build time, so the documentation panel
// ships no markdown parser and costs nothing at runtime. The same files stay
// readable on GitHub, which is the point of keeping the library in markdown
// rather than authoring HTML by hand.

/**
 * Cross-document links are rewritten from `earth-engine-setup.md` to
 * `#doc:earth-engine-setup`, which the panel intercepts to switch guides rather
 * than navigating the host page. Anchors within a document and absolute URLs
 * are left alone.
 */
function rewriteLinks(html: string): string {
  return html.replace(
    /href="(?!https?:|#|mailto:)([^"]*?)\.md(#[^"]*)?"/g,
    (_match, path: string, hash: string | undefined) => {
      const id = path.split("/").pop() ?? path;
      return `href="#doc:${id}${hash ?? ""}"`;
    },
  );
}

const MIME: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/**
 * Inline local images as data URIs.
 *
 * GeoLibre executes a plugin entry through a blob import and applies a strict
 * CSP, so a relative `images/foo.webp` would never resolve at runtime. Reading
 * the bytes at build time keeps the bundle self-contained and keeps the same
 * markdown rendering correctly on GitHub, where the relative path is what works.
 *
 * Only images actually referenced by a guide are inlined, so adding a file to
 * docs/images/ costs nothing until a guide uses it.
 */
function inlineImages(html: string, mdPath: string): string {
  const base = dirname(mdPath);
  return html.replace(
    /src="(?!https?:|data:)([^"]+)"/g,
    (match, relative: string) => {
      const file = resolve(base, relative);
      const extension = relative.split(".").pop()?.toLowerCase() ?? "";
      const mime = MIME[extension];
      if (!mime) return match;
      try {
        const bytes = readFileSync(file);
        return `src="data:${mime};base64,${bytes.toString("base64")}"`;
      } catch {
        throw new Error(
          `${mdPath} references an image that does not exist: ${relative}`,
        );
      }
    },
  );
}

export function markdownPlugin(): Plugin {
  return {
    name: "tuvsud-markdown-to-html",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".md")) return null;
      const rendered = marked.parse(code, { async: false, gfm: true }) as string;
      const html = inlineImages(rewriteLinks(rendered), id);
      return {
        code: `export default ${JSON.stringify(html)};`,
        map: null,
      };
    },
  };
}
