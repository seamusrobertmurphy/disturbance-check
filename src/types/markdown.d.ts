// Markdown files in docs/ are rendered to HTML at build time by
// vite-plugins/markdown.ts and imported as strings.
declare module "*.md" {
  const html: string;
  export default html;
}
