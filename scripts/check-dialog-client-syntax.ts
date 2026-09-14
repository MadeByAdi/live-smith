import * as fs from "node:fs";

const clientFragments = [
  "host-adapter",
  "i18n",
  "profile-editor",
  "attachments",
  "composer-input",
  "skill-manager",
  "bridge-client",
  "session-timeline",
  "action-preview",
  "bootstrap",
] as const;

const source = clientFragments
  .map((name) => fs.readFileSync(
    new URL(`../src/ui/client/${name}.script.html`, import.meta.url),
    "utf8",
  ))
  .join("\n");

new Function(source);
