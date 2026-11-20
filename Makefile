# Build pipeline for tst-shelf (mirrors tst-workspace).
# `make run` + `make watch` is the edit-and-test loop: web-ext reloads the
# add-on in the dev Firefox whenever dist/ changes.
#
# Isolation targets (tests/fixture.sh = clean profile + Tree Style Tab only):
#   make iso-tst - clean profile copy with ONLY TST plus this extension
#   make e2e     - headless Marionette run: installs dist/, the smoke page
#                  drives the shelf against the TST fixture, opens TST's own
#                  sidebar page in a tab to assert the rendered shadow DOM,
#                  reinstalls mid-session (the restart-persistence path),
#                  and downloads a JSON report.  Exit code 0 = all green.

SRC := dist

.PHONY: deps build watch run xpi lint test fixture iso-tst e2e release clean

deps:
	npm install

build:
	node build.js

watch:
	node build.js --watch

run: build
	npx web-ext run -s $(SRC)

xpi: build
	npx web-ext build -s $(SRC) -a web-ext-artifacts --overwrite-dest

lint: build
	npx web-ext lint -s $(SRC)

test:
	node --test tests/

fixture: tests/fixture.sh
	tests/fixture.sh

iso-tst: fixture build
	npx web-ext run -s $(SRC) --firefox-profile tests/fixture-profile

e2e: fixture
	rm -f tests/e2e-downloads/tst-shelf-e2e.json
	E2E=1 node build.js
	node tests/e2e-drive.mjs --port 2829 --timeout 150

release: build lint test e2e xpi
	@ls -l web-ext-artifacts/

clean:
	rm -rf dist web-ext-artifacts tests/e2e-downloads
