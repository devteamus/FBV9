#!/usr/bin/env node
/**
 * get-permanent-token.mjs — separate, standalone tool. NOT part of the
 * web or worker app, doesn't run in Docker, doesn't touch the database.
 * Run it manually, once per Page, whenever you need a fresh long-lived
 * Page token to paste into the "Add Account" form in the dashboard.
 *
 * WHY THIS IS NEEDED
 * ───────────────────
 * Facebook access tokens come in three tiers:
 *   1. Short-lived USER token   — from Graph API Explorer, expires in ~1-2 hours
 *   2. Long-lived USER token    — exchanged from #1, expires in ~60 days
 *   3. Page token from #2       — a Page token minted from a long-lived
 *                                  USER token INHERITS "no expiry" as long
 *                                  as the user token was long-lived AND the
 *                                  user remains an admin of the Page.
 * Facebook does not hand out a permanent token directly — you always
 * start from a short-lived user token and exchange upward. This script
 * automates steps 2 and 3.
 *
 * PREREQUISITES (one-time, in Facebook's own UI — this script can't do these for you)
 * 1. Create/use a Facebook App at https://developers.facebook.com/apps
 * 2. Get your App ID and App Secret from the app's Settings → Basic
 * 3. Get a SHORT-LIVED user access token with `pages_show_list` and
 *    `pages_manage_posts` permissions from Graph API Explorer:
 *    https://developers.facebook.com/tools/explorer/
 *    (select your app, select the Page in "User or Page" if offered,
 *    or just generate a User token with those permissions)
 *
 * USAGE
 *   node scripts/get-permanent-token.mjs \
 *     --app-id 1234567890 \
 *     --app-secret YOUR_APP_SECRET \
 *     --short-token SHORT_LIVED_USER_TOKEN \
 *     --page-id YOUR_PAGE_ID
 *
 * OUTPUT
 *   Prints the long-lived PAGE access token. Paste that (not the user
 *   token) into the dashboard's "Add Account" → fb_page_access_token field.
 *
 * No dependencies — plain Node 18+ (uses built-in fetch).
 */

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const appId = getArg("app-id");
const appSecret = getArg("app-secret");
const shortToken = getArg("short-token");
const pageId = getArg("page-id");

if (!appId || !appSecret || !shortToken || !pageId) {
  console.error(
    "Usage: node get-permanent-token.mjs --app-id <id> --app-secret <secret> --short-token <token> --page-id <id>"
  );
  process.exit(1);
}

const GRAPH_VERSION = "v20.0";

async function main() {
  // Step 1: exchange short-lived USER token → long-lived USER token (~60 days)
  console.log("Step 1/2: exchanging short-lived user token for a long-lived one...");
  const exchangeUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token` +
    `?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(shortToken)}`;

  const exchangeResp = await fetch(exchangeUrl);
  const exchangeData = await exchangeResp.json();
  if (!exchangeResp.ok || !exchangeData.access_token) {
    console.error("Failed to exchange token:", JSON.stringify(exchangeData, null, 2));
    process.exit(1);
  }
  const longLivedUserToken = exchangeData.access_token;
  console.log("  Got long-lived user token (expires in ~60 days, that's expected).");

  // Step 2: use the long-lived USER token to fetch the Page token.
  // A Page token minted from a long-lived user token does NOT itself
  // expire, as long as the user stays an admin of the Page and doesn't
  // revoke the app's access.
  console.log("Step 2/2: fetching the never-expiring Page token...");
  const pageUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}` +
    `?fields=access_token,name` +
    `&access_token=${encodeURIComponent(longLivedUserToken)}`;

  const pageResp = await fetch(pageUrl);
  const pageData = await pageResp.json();
  if (!pageResp.ok || !pageData.access_token) {
    console.error("Failed to fetch page token:", JSON.stringify(pageData, null, 2));
    console.error(
      "Common cause: the user token doesn't have pages_show_list / pages_manage_posts permission, or isn't an admin of this page."
    );
    process.exit(1);
  }

  console.log("\n✅ Done. This Page token effectively does not expire:\n");
  console.log(`Page: ${pageData.name} (${pageId})`);
  console.log(`Token: ${pageData.access_token}\n`);
  console.log(
    "Paste this into the dashboard's Add Account form as fb_page_access_token."
  );
  console.log(
    "Note: it can still stop working if the user revokes the app, the app is deleted/disabled, or the user loses Page admin rights — nothing is truly forever on Facebook's side."
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
