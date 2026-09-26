export type FooterPart = {
  key: string;
  variants: string[];
  required?: boolean;
};

type FitOptions = {
  separator?: string;
  measure?: (text: string) => number;
  truncate?: (text: string, width: number) => string;
};

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]/g;

export function visibleWidth(text: string): number {
  return Array.from(text.replace(ANSI, "")).length;
}

function truncatePlain(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width === 1) return "…";
  return `${chars.slice(0, width - 1).join("")}…`;
}

export function fitFooter(parts: FooterPart[], width: number, options: FitOptions = {}): string {
  const separator = options.separator ?? " │ ";
  const measure = options.measure ?? visibleWidth;
  const truncate = options.truncate ?? truncatePlain;
  const active = parts.map((part) => ({ ...part, variant: 0, visible: true }));
  const render = () =>
    active
      .filter((part) => part.visible)
      .map((part) => part.variants[part.variant] ?? part.variants.at(-1) ?? "")
      .join(separator);

  const remove = (key: string) => {
    const part = active.find((candidate) => candidate.key === key && !candidate.required);
    if (!part?.visible) return false;
    part.visible = false;
    return true;
  };
  const compact = (key: string) => {
    const part = active.find((candidate) => candidate.key === key);
    if (!part || part.variant >= part.variants.length - 1) return false;
    part.variant += 1;
    return true;
  };

  const reductions = [
    () => remove("cost"),
    () => compact("context"),
    () => remove("thinking"),
    () => remove("branch"),
    () => compact("context"),
  ];

  let output = render();
  for (const reduce of reductions) {
    if (measure(output) <= width) return output;
    reduce();
    output = render();
  }
  return measure(output) <= width ? output : truncate(output, width);
}
