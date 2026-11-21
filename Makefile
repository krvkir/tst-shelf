# Build pipeline for tst-shelf (mirrors tst-workspace).
# `make run` + `make watch` is the edit-and-test loop: web-ext reloads the
# add-on in the dev Firefox whenever dist/ changes.
#
# TWO BUILD FLAVORS, TWO DIRECTORIES:
#   dist/      production.  The ONLY tree web-ext may pack.
#   dist-e2e/  test build (smoke page, -e2e version, downloads permission).
# Keeping them apart is not cosmetic: `make e2e` used to leave the test
# build in dist/, and `make release` then packaged it.
#
# Isolation targets (tests/fixture.sh = clean profile + Tree Style Tab only):
#   make iso-tst - clean profile copy with ONLY TST plus this extension
#   make e2e     - the E2E run (stock Tree Style Tab from AMO), rebuilding
#                  dist-e2e/ first.  The run is headless Marionette: it
#                  installs the E2E build, the smoke page drives the shelf
#                  against the TST fixture, TST's own sidebar page is opened
#                  in a tab to assert the rendered shadow DOM, the add-on is
#                  reinstalled mid-session (the restart-persistence path),
#                  and a JSON report is downloaded.
#                  Exit code 0 = every assertion passed.
#   make release - tests, the E2E run, then a CLEAN production build that
#                  scripts/verify-dist.mjs checks before web-ext packs it.

DIST := dist
E2E_DIST := dist-e2e
E2E_DRIVER := node tests/e2e-drive.mjs --port 2829 --timeout 150

SRC := $(DIST)

.PHONY: deps build watch run xpi lint test fixture iso-tst e2e \
	perf verify-dist release clean

# `release` runs ordered steps that share dist/; never interleave them.
.NOTPARALLEL:

deps:
	npm install

build:
	node build.mjs --out $(DIST)

watch:
	node build.mjs --out $(DIST) --watch

run: build
	npx web-ext run -s $(SRC)

verify-dist:
	node scripts/verify-dist.mjs $(DIST)

xpi: build verify-dist
	npx web-ext build -s $(SRC) -a web-ext-artifacts --overwrite-dest

lint: build
	npx web-ext lint -s $(SRC)

test:
	node --test tests/

perf:
	node tests/perf.mjs

fixture: tests/fixture.sh
	tests/fixture.sh

iso-tst: fixture build
	npx web-ext run -s $(SRC) --firefox-profile tests/fixture-profile

e2e-build:
	E2E=1 node build.mjs --out $(E2E_DIST)

e2e: fixture e2e-build
	rm -f tests/e2e-downloads/tst-shelf-e2e.json
	$(E2E_DRIVER) --dist $(E2E_DIST)

# Ordered by recipe, not by prerequisites: the packaged tree must be the
# production build made AFTER every test run touched dist-e2e/.
release: test perf e2e
	$(MAKE) clean
	$(MAKE) build lint verify-dist
	npx web-ext build -s $(DIST) -a web-ext-artifacts --overwrite-dest
	@ls -l web-ext-artifacts/

clean:
	rm -rf $(DIST) $(E2E_DIST) web-ext-artifacts tests/e2e-downloads
