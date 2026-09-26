import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const profiles = new URL("../../profiles/", import.meta.url);
const rule = "decide records a choice you are entitled to make; consult asks for one you are not — if it would change your brief scope or another worker depends on it, consult.";
const crewProfiles = readdirSync(profiles, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/CREW.md`, profiles)))
  .map((entry) => entry.name);

assert.ok(crewProfiles.length > 0, "discover at least one crew profile");
for (const name of crewProfiles) {
  test(`${name} crew contract distinguishes an entitled choice from a scope change`, () => {
    const text = readFileSync(new URL(`${name}/CREW.md`, profiles), "utf8");
    assert.equal(text.split(rule).length - 1, 1, `${name}/CREW.md must state the decide-versus-consult rule exactly once`);
  });
}
