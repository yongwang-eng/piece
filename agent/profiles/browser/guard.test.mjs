import assert from "node:assert/strict";
import test from "node:test";
import { AUTH_HOSTS } from "../../lib/guards/index.ts";
import { authTypingRule, rememberUrl } from "./guard.ts";

test("browser: typing into an auth surface is blocked structurally; navigation and non-auth typing pass", () => {
  assert.ok(authTypingRule("https://acme.okta.com/login", "playwright_browser_type", '{"text":"x"}')?.block);
  assert.ok(authTypingRule("https://app.example.com/", "playwright_browser_fill_form", '{"fields":[{"name":"password","value":"x"}]}')?.block, "a credential field anywhere is enough");
  assert.equal(authTypingRule("https://acme.okta.com/login", "playwright_browser_navigate", '{"url":"x"}'), undefined, "control: not typing");
  assert.equal(authTypingRule("https://app.example.com/search", "playwright_browser_type", '{"text":"cats"}'), undefined);
  assert.ok(AUTH_HOSTS.test("https://accounts.google.com/x") && !AUTH_HOSTS.test("https://console.aws.amazon.com/ec2"));
});

test("browser: rememberUrl pulls the page URL out of a Playwright result in its common shapes", () => {
  assert.equal(rememberUrl("- Page URL: https://dashboard.acme-test.example/x\n- Page Title: y"), "https://dashboard.acme-test.example/x");
  assert.equal(rememberUrl('{"url":"https://a.okta.com/login"}'), "https://a.okta.com/login");
  assert.equal(rememberUrl("nothing here"), undefined);
});
