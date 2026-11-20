#!/usr/bin/env bash
# Create tests/fixture-profile: a clean Firefox profile containing ONLY
# Tree Style Tab (signed xpi from AMO) with test-friendly prefs.  Our own
# extension is installed per-run by the Marionette driver (temporary).
#
# Usage: tests/fixture.sh   (idempotent)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$HERE/fixture-profile"
DL_DIR="$HERE/e2e-downloads"

mkdir -p "$FIXTURE/extensions" "$DL_DIR"

# Tree Style Tab, current AMO release, signed (sideload works on release FF).
TST_XPI="$FIXTURE/extensions/treestyletab@piro.sakura.ne.jp.xpi"
if [ ! -s "$TST_XPI" ]; then
	url="$(curl -fsSL 'https://addons.mozilla.org/api/v4/addons/addon/treestyletab@piro.sakura.ne.jp/' | jq -r '.current_version.files[0].url')"
	curl -fsSL -o "$TST_XPI" "$url"
fi
[ -s "$TST_XPI" ] || { echo "TST xpi download failed"; exit 1; }

# prefs: sideload-allow, headless-friendly, deterministic downloads dir.
cat > "$FIXTURE/prefs.js" <<EOF
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.warnedAboutSlowStartup", 2);
user_pref("datareporting.policy.firstRunURL", "");
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("app.update.auto", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("browser.download.useDownloadDir", true);
user_pref("browser.download.folderList", 2);
user_pref("browser.download.dir", "$DL_DIR");
user_pref("browser.download.always_ask_before_saving_new_file", false);
user_pref("browser.download.improvements_to_download_panel", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.startup.page", 0);
EOF

echo "fixture ready: $FIXTURE (TST $(file -b "$TST_XPI" | cut -c1-30))"
