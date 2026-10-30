VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
AGENT_DIR ?= $(or $(PI_CODING_AGENT_DIR),$(HOME)/.pi/agent)

.PHONY: build web check install-guard install

build: web
	go build -ldflags "-s -w -X main.version=$(VERSION)" -o bin/pimu ./cmd/pimu

web:
	cd web && npm ci && npm run build

check:
	gofmt -l . | (! grep .) && go vet ./... && cd web && npx tsc -b --noEmit

install-guard:
	mkdir -p $(AGENT_DIR)/extensions
	cp extensions/pimu-guard.ts $(AGENT_DIR)/extensions/

install: build
	install -m755 bin/pimu $(HOME)/.local/bin/pimu
