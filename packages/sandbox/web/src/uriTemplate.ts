/**
 * Minimal RFC 6570 URI templates (levels 1–3), enough for MCP resource
 * templates like `file:///{+path}` or `db://{table}/rows{?limit,offset}`.
 */
const OPERATORS: Record<string, { first: string; sep: string; named: boolean; ifEmpty: string; reserved: boolean }> = {
  "": { first: "", sep: ",", named: false, ifEmpty: "", reserved: false },
  "+": { first: "", sep: ",", named: false, ifEmpty: "", reserved: true },
  "#": { first: "#", sep: ",", named: false, ifEmpty: "", reserved: true },
  ".": { first: ".", sep: ".", named: false, ifEmpty: "", reserved: false },
  "/": { first: "/", sep: "/", named: false, ifEmpty: "", reserved: false },
  ";": { first: ";", sep: ";", named: true, ifEmpty: "", reserved: false },
  "?": { first: "?", sep: "&", named: true, ifEmpty: "=", reserved: false },
  "&": { first: "&", sep: "&", named: true, ifEmpty: "=", reserved: false },
};

const EXPRESSION = /\{([+#./;?&]?)([^}]+)\}/g;

function varName(spec: string): string {
  return spec.replace(/\*$/, "").replace(/:\d+$/, "");
}

/** Variable names in a template, in order. */
export function templateVariables(template: string): string[] {
  const names: string[] = [];
  for (const [, , list] of template.matchAll(EXPRESSION)) {
    for (const spec of list!.split(",")) {
      const name = varName(spec.trim());
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

const encode = (value: string, reserved: boolean) =>
  reserved ? encodeURI(value).replace(/%25([0-9A-Fa-f]{2})/g, "%$1") : encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Fill a template; empty values are omitted like RFC 6570 undefined variables. */
export function expandTemplate(template: string, values: Record<string, string>): string {
  return template.replace(EXPRESSION, (_, op: string, list: string) => {
    const o = OPERATORS[op] ?? OPERATORS[""]!;
    const parts: string[] = [];
    for (const raw of list.split(",")) {
      const spec = raw.trim();
      const name = varName(spec);
      let value = values[name];
      if (value === undefined || value === "") continue;
      const prefix = /:(\d+)$/.exec(spec);
      if (prefix) value = value.slice(0, Number(prefix[1]));
      const encoded = encode(value, o.reserved);
      parts.push(o.named ? `${name}${encoded === "" ? o.ifEmpty : `=${encoded}`}` : encoded);
    }
    return parts.length ? o.first + parts.join(o.sep) : "";
  });
}
