# Repository Instructions

These instructions apply to the entire repository and are mandatory.

## Repository Automation Policy

- GitHub is used by default only for remote version control, code collaboration, branches, tags, and releases.
- Do not create, restore, or commit `.github/workflows/`, Dependabot, Renovate, or any other hosted CI/CD automation configuration.
- Run builds, tests, packaging, and release verification locally and manually as needed.
- A push, pull request, tag, release, or build-script change does not authorize enabling remote automation.
- Obtain the user's explicit authorization before enabling any remote build, test, dependency-update, packaging, deployment, or release automation.
- Preserve all existing user changes. Do not commit build artifacts, runtime data, secrets, databases, or dependency directories.
