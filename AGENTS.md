# LexiLoop development

- Runtime: native browser modules, Python standard-library static server; no npm build.
- Run `python -B tools/ci_check.py` with Python 3.12 and Node 22 before proposing changes.
- In a Git checkout, also run `python -B tools/check_line_endings.py`. Keep text LF;
  do not normalize or re-encode binary assets. Production ZIPs must come from CI.
- Do not run legacy live tests or maintenance scripts against production by default. Some
  target the old lexiloop-16105 host, mutate shared data, or invoke billable models.
- Test accounts are supplied through environment variables; never hardcode credentials.
- For app changes, use `python tools/bump_version.py NEW_NUMBER --root lexiloop`.
- Build releases with `python -B tools/release_bundle.py --sha FULL_COMMIT_SHA` from
  the clean checkout of that commit. Deploy only archive contents, never repository root.
- Preserve the current WorkBuddy application, URL, users, and database. Schema docs are
  descriptive; do not infer or execute production migrations from them.
- Use branches and PRs. Follow docs/DEPLOYMENT.md for deployment and rollback.
