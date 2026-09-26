import assert from "node:assert/strict";
import test from "node:test";
import { usedVars } from "./reuse.ts";

test("usedVars: which leased vars a command names — $VAR, ${VAR}, not a prefix match, not an unleased var", () => {
  const leased = new Map([["ACME_STAGING_KEY", "staging_key"], ["DEVIN_API_KEY", "devin"]]);
  assert.deepEqual(usedVars('curl -H "Authorization: Bearer $ACME_STAGING_KEY" …', leased), ["staging_key"]);
  assert.deepEqual(usedVars("k6 run -e KEY=${DEVIN_API_KEY} x.js; echo $ACME_STAGING_KEY", leased), ["devin", "staging_key"]);
  assert.deepEqual(usedVars("echo $ACME_STAGING_KEY_2", leased), []);   // a different var
  assert.deepEqual(usedVars('echo "len=${#DEVIN_API_KEY}"', leased), ["devin"]);      // length form still names it
  assert.deepEqual(usedVars("echo $OTHER", leased), []);
  assert.deepEqual(usedVars("ls", new Map()), []);
});
