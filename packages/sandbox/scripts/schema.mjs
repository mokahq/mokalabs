// Writes dist/moka.schema.json so editors can autocomplete moka.json.
import { writeFileSync, mkdirSync } from "node:fs";
import { mokaJsonSchema } from "@mokalabs/core";
mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("../dist/moka.schema.json", import.meta.url), `${JSON.stringify(mokaJsonSchema(), null, 2)}\n`);
console.log("wrote dist/moka.schema.json");
