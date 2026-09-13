import * as fs from "node:fs";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

export async function compileUiStyles(
  source: string | URL,
  optimize: boolean,
): Promise<string> {
  const filename = source instanceof URL ? fileURLToPath(source) : source;
  const result = await postcss([
    tailwindcss({
      base: cwd(),
      optimize,
      transformAssetUrls: false,
    }),
  ]).process(fs.readFileSync(filename, "utf8"), { from: filename });
  return result.css;
}
