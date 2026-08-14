export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function field(
  label: string,
  control: HTMLElement,
  hint?: string,
): HTMLElement {
  const wrap = el("label", "dc-field");
  wrap.appendChild(el("span", "dc-field-label", label));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(el("span", "dc-field-hint", hint));
  return wrap;
}

export function input(
  type: string,
  value: string,
  onChange: (value: string) => void,
): HTMLInputElement {
  const node = el("input", "dc-input");
  node.type = type;
  node.value = value;
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

export function button(
  label: string,
  onClick: () => void,
  variant: "primary" | "secondary" = "secondary",
): HTMLButtonElement {
  const node = el("button", `dc-button dc-button-${variant}`, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

export function formatHectares(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes <= 0) return "under a minute";
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
