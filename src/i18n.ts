export type Catalog = Record<string, string>;

export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

export function translate(
  catalog: Catalog,
  fallback: Catalog,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const template = catalog[key] ?? fallback[key] ?? key;
  return interpolate(template, params);
}
