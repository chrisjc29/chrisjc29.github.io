# Octopus Peaks

A dashboard of what the household energy bill is made of and when it happens, built on the Octopus Energy API.

This folder is **not** published on GitHub Pages (see `exclude` in the repo's `_config.yml`). It is meant to run as a
Cloudflare Worker behind Cloudflare Access, so only named people can open it and the Octopus API key never reaches a browser.

| File | What it is |
|---|---|
| `index.html` | The whole dashboard. Uses the `/octo` backend when there is one; otherwise asks for an account number and key and keeps them in that browser. |
| `worker/index.js` | The Worker: serves the page and a read-only `/octo` proxy to Octopus. Refuses every request without a valid Cloudflare Access token. |
| `wrangler.jsonc` | Worker configuration. |

## One-time setup on Cloudflare

Cloudflare's dashboard changes often, so treat the menu names as a guide.

1. **Create the Worker from this repo.** Workers & Pages > Create > import a repository > `chrisjc29/chrisjc29.github.io`.
   Set the **root directory** to `OctopusPeaks` and the deploy command to `npx wrangler deploy`. Leave the build command empty.
2. **Switch on Access before anything else.** Worker > Settings > Domains & Routes > `workers.dev` > Enable Cloudflare Access.
   The dialog shows two values, `TEAM_DOMAIN` and `POLICY_AUD`. Keep them for step 4.
3. **Say who may sign in.** Manage Cloudflare Access > edit the policy so it includes only the two email addresses,
   with One-time PIN as the login method. Each person gets a code by email the first time they open the site on a device.
4. **Add the settings.** Worker > Settings > Variables and Secrets:

   | Name | Type | Value |
   |---|---|---|
   | `TEAM_DOMAIN` | Text | from step 2, like `https://something.cloudflareaccess.com` |
   | `POLICY_AUD` | Text | from step 2 |
   | `OCTOPUS_ACCOUNT` | Secret | `A-…` |
   | `OCTOPUS_API_KEY` | Secret | a freshly generated `sk_live_…` key |
   | `ALLOWED_EMAILS` | Text, optional | the same two emails, comma separated, as a second check |

   The first deploy also creates a small key-value store (`STORE`) by itself. It holds the appliance names you type in,
   so they are the same on every device.
5. **Open the `workers.dev` address.** You should get the Cloudflare sign-in, then the dashboard with no login form.

## If something is wrong

The page says what the backend refused. The common ones:

- *No Cloudflare Access token on the request*: Access is not switched on for the address you opened (step 2).
- *Access token is for a different application*: `POLICY_AUD` does not match the Access application.
- *OCTOPUS_API_KEY and OCTOPUS_ACCOUNT are not set*: step 4.

## What the proxy will and will not do

- Only `GET` requests to Octopus paths under `/v1/`, and GraphQL **queries**. Mutations are rejected, so it cannot change anything on the account.
- Fails closed: without `TEAM_DOMAIN` and `POLICY_AUD`, or without a valid signed token, it answers 403 and never calls Octopus.
