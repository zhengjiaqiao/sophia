SHELL := /bin/bash
.PHONY: test test-core build project format

test: test-core build

test-core:
	cd SymSyncCore && swift test

build: SymSync.xcodeproj
	set -o pipefail; xcodebuild -project SymSync.xcodeproj -scheme SymSync -configuration Debug \
	  -derivedDataPath build CODE_SIGN_IDENTITY=- build | tail -20

SymSync.xcodeproj: project.yml
	xcodegen generate

project:
	xcodegen generate

format:
	swift format -i -r SymSyncCore/Sources SymSyncCore/Tests SymSync
