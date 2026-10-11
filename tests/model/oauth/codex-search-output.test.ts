import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCodexSearchOutput } from "../../../src/model/oauth/codex-search-output.js";

test("Codex reference expansion preserves ordinary IDs and existing Markdown destinations", () => {
  const result = normalizeCodexSearchOutput(
    "[Existing](HTTPS://example.test/turn0search0) [Local](#turn0search0) mailto:turn0search0@example.test turn0search0.",
    [{ type: "text_result", ref_id: "turn0search0", url: "https://example.test/source", title: "Source" }],
  );
  assert.equal(result.content,
    "[Existing](HTTPS://example.test/turn0search0) [Local](#turn0search0) mailto:turn0search0@example.test turn0search0.");
});

test("Codex reference expansion uses Markdown context to preserve literal and linked markers", () => {
  const literal = "`citeturn0search0`\n\n```text\n【turn0search0】\nciteturn0search0\n```\n\n[citeturn0search0](https://example.test/existing)";
  const result = normalizeCodexSearchOutput(literal + "\n\n> Citation.citeturn0search0", [
    { type: "text_result", ref_id: "turn0search0", url: "https://example.test/source", title: "Source" },
  ]);
  assert.equal(result.content.slice(0, literal.length), literal);
  assert.match(result.content.slice(literal.length), /^\n\n> Citation\. \[Source\]\(/u);
  assert.doesNotMatch(result.content.slice(literal.length), /|turn0search/);
});

test("Codex reference expansion preserves shortcut reference-label identity", () => {
  const output = "[【turn0search0】]\n\n[【turn0search0】]: https://example.test/existing\n\nProse.citeturn0search0";
  const result = normalizeCodexSearchOutput(output, [
    { type: "text_result", ref_id: "turn0search0", url: "https://example.test/source", title: "Source" },
  ]);
  const unchanged = "[【turn0search0】]\n\n[【turn0search0】]: https://example.test/existing\n\n";
  assert.equal(result.content.slice(0, unchanged.length), unchanged);
  assert.doesNotMatch(result.content.slice(unchanged.length), /|turn0search/);
});

test("Codex reference expansion uses only bounded validated source URLs", () => {
  const result = normalizeCodexSearchOutput(
    "Known.citepage/source#1page/source#1turn0search1turn0search2 Unknown.citeturn0search9",
    [
      { type: "text_result", ref_id: "page/source#1", url: "https://example.test/path_(1)", title: "**Analysis** <img>" },
      { type: "text_result", ref_id: "turn0search1", url: "https://user:secret@example.test/", title: "Credentials" },
      { type: "text_result", ref_id: "turn0search2", url: "javascript:alert(1)", title: "Script" },
    ],
  );
  assert.equal(result.content, "Known. [&#42;&#42;Analysis&#42;&#42; &#60;img&#62;](<https&#58;&#47;&#47;example&#46;test&#47;path&#95;&#40;1&#41;>) Unknown.");
  assert.deepEqual(result.sources, [{ url: "https://example.test/path_(1)", title: "**Analysis** <img>" }]);
});
