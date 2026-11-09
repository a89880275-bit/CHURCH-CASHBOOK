# Project workflow

## Deployment policy (user instruction, 2026-11-09)

- Use this sequence: local development -> local build/tests -> GitHub save -> explicit user deployment approval -> Netlify deployment.
- Never deploy to Netlify automatically after code changes, tests, commits, or pushes. Earlier deployments/approvals do not authorize a new deployment.
- Before every GitHub push, verify whether repository integration, GitHub Actions, or deploy hooks could cause an automatic Netlify deployment. If connected, explain how to stop automatic deployment before pushing; do not silently change connection settings.
- Group completed features into a pending deployment list. Keep local work and GitHub saves moving when deployment is blocked.
- Before an approved deployment, verify the exact target site, current remaining usage/credits, and expected credit consumption. Do not invent exact estimates when provider data is unavailable; report the limitation before proceeding.
- Do not retry failed deployments automatically. Report the failure and wait for explicit instruction.
- Preserve Auth0 configuration, Neon data, and Netlify Functions secrets. Never put secrets in Git, VITE_ variables, static output, or logs.
- Do not change plans, create paid services, modify production sites, or alter production data as part of routine deployment work.

See docs/deployment-policy.md for the current deployment queue and connection observations. Recheck live state before relying on an earlier observation.
