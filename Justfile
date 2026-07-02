# HeavyOperations — per-app deploy contract (multi-image variant).
#
# cryptoverse-login is a FULL STACK, not a single image: three CUSTOM images
# (login, wrapper, gateway) plus upstream Postgres + Ory Hydra (pinned in base).
# The platform's stock single-image Justfile is customised here so the SAME three
# commands operate over all three custom components at once, keeping the same
# immutable "<commit-time>-<sha>" tag contract. Full reference: docs/CI.md in the
# HeavyOperations control repo.
#
#   just build    build+push all 3 custom images from the current commit -> local registry
#   just deploy   build, pin all 3 tags in deploy/, commit, push, wait for Argo CD, prune
#   just promote  on a release/tag: copy images -> Harbor, pin overlays/prod (IdP + demo), push, wait for prod
#   just prune    keep only the newest <keep> tags PER component in the registry
#
# `just deploy` is the local pipeline; `just promote` is the prod pipeline. On the
# platform Gitea Actions runs them — `.gitea/workflows/deploy.yml` runs `just
# deploy` on push to main/master, `release.yml` runs `just promote` on a tag — but
# the contract is identical by hand. The post-commit hook (`just hooks-install`)
# is the server-less fallback for the local loop.

set shell := ["bash", "-uc"]

# ── Config ────────────────────────────────────────────────────────────────────
app           := "cryptoverse-login"   # app == k8s namespace == gitops repo == Argo CD app
registry      := "localhost:5000"
image_base    := registry / app        # per-component repos are <image_base>/<component>
overlay       := "deploy/overlays/local"
# CI overrides the push remote: Gitea Actions checks the repo out as `origin`, so
# the workflows export GITOPS_REMOTE=origin. By hand / via the hook it stays "gitops".
gitops_remote := env_var_or_default("GITOPS_REMOTE", "gitops")
kube_context  := "kind-heavyops"
argocd_ns     := "argocd"
registry_ctr  := "kind-registry"       # podman container backing localhost:5000 (used for GC)
keep          := "2"                   # how many image tags `just prune` keeps PER component
# wait_timeout is 600 not 300: on this shared box Argo's repo-server fetch +
# KSOPS render + reconcile can lag >300s before the rollout even starts, which
# false-times-out an otherwise-successful deploy.
wait_timeout  := "600"                 # seconds `just deploy` waits for Argo CD to sync + heal

# The three custom images, as "<component>|<dockerfile-or-empty>|<build-context>"
# (contexts mirror tests/kind/setup.sh: login+wrapper share the login/ workspace
# context because they share the `core` crate; gateway builds from login/gateway/).
components := "login|login/login/Dockerfile|login wrapper|login/wrapper/Dockerfile|login gateway||login/gateway"

# ── Prod / Harbor (just promote) ──────────────────────────────────────────────
# Production images live in Harbor (OVH), NOT the local registry — Argo only ever
# syncs manifests, so `just promote` itself moves the image bytes. This project
# has its OWN Harbor project (per-project sub-project, NOT the platform's older
# shared "<harbor>/heavyops/<app>" path): prod refs are
# <harbor>/cryptoverse-login/<component>:<tag>. Creds come from HARBOR_USER /
# HARBOR_TOKEN in the env (Gitea repo secrets — the project's push robot);
# promote fails fast without them, never hardcode them here.
harbor_registry   := "86id9433.gra7.container-registry.ovh.net"
harbor_project    := "cryptoverse-login"
prod_overlay      := "deploy/overlays/prod"
prod_app          := app + "-prod"     # the prod Argo CD Application (cryptoverse-login-prod)
# The demo RP (tests/cryptoverse-login-demo) is promoted TOGETHER with the IdP —
# its prod overlay pins <harbor>/cryptoverse-login/demo, so every release ships a
# pair that can be verified end-to-end in prod. Its local image repo and build
# context differ from the IdP components' (see the demo's own Justfile).
demo_component    := "demo"
demo_image        := registry / "cryptoverse-login-demo"
demo_context      := "tests/cryptoverse-login-demo/demo"
demo_prod_overlay := "tests/cryptoverse-login-demo/deploy/overlays/prod"
demo_prod_app     := "cryptoverse-login-demo-prod"
# The LOCAL Argo CD reconciles prod as a second destination, so the prod
# Application objects live in the SAME local argocd namespace — `_wait` reads
# their status via the local kube_context.

# Acceptance-test targets (the locally-deployed demo RP + IdP); overridable as `just e2e` args.
e2e_demo  := "https://cryptoverse-login-demo.127.0.0.1.nip.io:18443"
e2e_login := "https://cryptoverse-login.127.0.0.1.nip.io:18443"

# List the available commands.
default:
    @just --list --unsorted

# ── build ─────────────────────────────────────────────────────────────────────
# Tag = "<UTC commit time>-<short sha>": sortable (newest sorts last) and
# deterministic per commit, so rebuilding a commit yields the same tag (no churn)
# while a new commit yields a new tag (a real GitOps change Argo CD rolls out).
# A dirty tree appends "-dirty"; the hook path runs post-commit so it's clean.
# All three components share ONE tag (one commit of this monorepo).

# Build+push all 3 custom images from the current commit -> local registry (standalone).
build:
    #!/usr/bin/env bash
    set -euo pipefail
    tag="$(just tag)"
    comp_specs="{{components}}"   # quote first: '|' is literal data here, not a shell pipe
    for spec in ${comp_specs}; do
      IFS='|' read -r name dockerfile context <<<"${spec}"
      ref="{{image_base}}/${name}:${tag}"
      echo "==> build ${ref}  (context ${context}${dockerfile:+, -f ${dockerfile}})"
      podman build -t "${ref}" ${dockerfile:+-f "${dockerfile}"} "${context}"
      echo "==> push ${ref}"
      podman push --tls-verify=false "${ref}"
    done
    echo "✓ built+pushed login wrapper gateway @ ${tag}"

# Print the deterministic image tag for the current commit.
tag:
    #!/usr/bin/env bash
    set -euo pipefail
    sha="$(git rev-parse --short=7 HEAD)"
    ts="$(TZ=UTC0 git show -s --date=format-local:%Y%m%dT%H%M%SZ --format=%cd HEAD)"
    dirty=""; git diff --quiet && git diff --cached --quiet || dirty="-dirty"
    [[ -z "${dirty}" ]] || echo "warning: working tree dirty — tagging ${ts}-${sha}${dirty}" >&2
    echo "${ts}-${sha}${dirty}"

# ── deploy ────────────────────────────────────────────────────────────────────
# The full pipeline (and what the git hook runs on every main/master commit):
#   1) build all 3  2) pin all 3 tags in the overlay  3) commit + push to gitops
#   4) wait for Argo CD to sync THAT commit and report Healthy  5) prune on success.
# Any failing step aborts the rest (non-zero exit, so the hook surfaces it).

# Build -> pin all 3 tags in deploy/ -> commit -> push -> wait for Argo CD -> prune.
deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    tag="$(just tag)"

    echo "==> [1/6] build"
    just build

    echo "==> [2/6] pin all 3 component tags (${tag}) in {{overlay}}"
    ( cd "{{overlay}}"
      comp_specs="{{components}}"   # quote first: '|' is literal data here, not a shell pipe
      for spec in ${comp_specs}; do
        IFS='|' read -r name _ _ <<<"${spec}"
        kustomize edit set image "{{image_base}}/${name}={{image_base}}/${name}:${tag}"
      done )

    if git diff --quiet -- "{{overlay}}/kustomization.yaml"; then
      echo "    image tags unchanged (already ${tag})"
    else
      echo "==> [3/6] commit deploy change"
      git add "{{overlay}}/kustomization.yaml"
      git commit -q -m "deploy({{app}}): ${tag} [skip ci]"
    fi
    echo "    push HEAD -> {{gitops_remote}}/main"
    git push -q "{{gitops_remote}}" HEAD:main

    echo "==> [4/6] wait for Argo CD (timeout {{wait_timeout}}s)"
    just _wait "{{app}}" "$(git rev-parse HEAD)"

    echo "==> [5/6] e2e acceptance — full SIWE login through the demo RP"
    just e2e

    echo "==> [6/6] prune"
    just prune
    echo "✓ deployed {{app}} ${tag}"

# ── promote ───────────────────────────────────────────────────────────────────
# The PROD pipeline — the mirror of `deploy`, fired by a release/TAG (not every
# push, only blessed builds cross over). Multi-image: every step loops over the
# three IdP components AND the demo RP image:
#   1) auth against Harbor (HARBOR_USER/HARBOR_TOKEN — fail fast if unset)
#   2) get the tagged commit's deterministic images into Harbor (crane copy the
#      tested bytes; rebuild from this commit only if prune already evicted them)
#   3) pin the Harbor refs in overlays/prod (IdP) + the demo's overlays/prod
#   4) commit + push to gitops   5) wait for BOTH prod Argo CD Applications.
# Argo CD NEVER moves image bytes — the crane copy does; prod kubelets then pull
# from Harbor with the pull-only robot (`harbor-pull` imagePullSecret).

# Copy images -> Harbor -> pin overlays/prod (IdP + demo) -> push -> wait for prod.
promote:
    #!/usr/bin/env bash
    set -euo pipefail
    tag="$(just tag)"

    echo "==> [1/5] harbor auth ({{harbor_registry}})"
    # Creds come from Gitea repo secrets (HARBOR_USER / HARBOR_TOKEN), exported
    # into the runner env — the project's own push robot. Fail fast when absent:
    # a promote that can't push to Harbor must not get as far as touching git.
    if [[ -z "${HARBOR_USER:-}" || -z "${HARBOR_TOKEN:-}" ]]; then
      echo "✗ HARBOR_USER / HARBOR_TOKEN not set — promote needs the Harbor push robot creds" >&2
      echo "  (Gitea repo secrets in CI; export them in your shell for a manual run)" >&2
      exit 1
    fi
    # `crane auth login` writes ~/.docker/config.json (podman honours it too, for
    # the rebuild fallback below).
    crane auth login "{{harbor_registry}}" -u "${HARBOR_USER}" -p "${HARBOR_TOKEN}"

    echo "==> [2/5] ensure all images exist in Harbor @ ${tag}"
    # If the tested bytes are still in the local registry, copy them verbatim so
    # prod runs the EXACT image that passed local (no rebuild drift). If `just
    # prune` already evicted the tag, rebuild from THIS (tagged) commit — the tag
    # is deterministic per commit, so we reproduce the same image straight to
    # Harbor. No --insecure on the destination: Harbor keeps TLS; crane treats the
    # localhost source as insecure automatically.
    promote_image() {
      local src="$1" dst="$2" dockerfile="$3" context="$4"
      if crane manifest --insecure "${src}" >/dev/null 2>&1; then
        echo "    crane copy ${src} -> ${dst}"
        crane copy "${src}" "${dst}"
      else
        echo "    ${src} gone from the local registry — rebuild from this commit -> ${dst}"
        podman build -t "${dst}" ${dockerfile:+-f "${dockerfile}"} "${context}"
        podman push "${dst}"
      fi
    }
    comp_specs="{{components}}"   # quote first: '|' is literal data here, not a shell pipe
    for spec in ${comp_specs}; do
      IFS='|' read -r name dockerfile context <<<"${spec}"
      promote_image "{{image_base}}/${name}:${tag}" \
        "{{harbor_registry}}/{{harbor_project}}/${name}:${tag}" "${dockerfile}" "${context}"
    done
    promote_image "{{demo_image}}:${tag}" \
      "{{harbor_registry}}/{{harbor_project}}/{{demo_component}}:${tag}" "" "{{demo_context}}"

    echo "==> [3/5] pin Harbor refs in {{prod_overlay}} + {{demo_prod_overlay}}"
    # Match the base image names; kustomize rewrites them to the Harbor refs for
    # the prod environment, leaving base/ environment-agnostic.
    ( cd "{{prod_overlay}}"
      for spec in ${comp_specs}; do
        IFS='|' read -r name _ _ <<<"${spec}"
        kustomize edit set image \
          "{{image_base}}/${name}={{harbor_registry}}/{{harbor_project}}/${name}:${tag}"
      done )
    ( cd "{{demo_prod_overlay}}" && kustomize edit set image \
        "{{demo_image}}={{harbor_registry}}/{{harbor_project}}/{{demo_component}}:${tag}" )

    if git diff --quiet -- "{{prod_overlay}}/kustomization.yaml" "{{demo_prod_overlay}}/kustomization.yaml"; then
      echo "    image tags unchanged (already ${tag})"
    else
      echo "==> [4/5] commit promote change"
      git add "{{prod_overlay}}/kustomization.yaml" "{{demo_prod_overlay}}/kustomization.yaml"
      git commit -q -m "promote({{app}}): ${tag} [skip ci]"
    fi
    echo "    push HEAD -> {{gitops_remote}}/main"
    git push -q "{{gitops_remote}}" HEAD:main

    echo "==> [5/5] wait for PROD Argo CD apps (timeout {{wait_timeout}}s each)"
    just _wait "{{prod_app}}" "$(git rev-parse HEAD)"
    just _wait "{{demo_prod_app}}" "$(git rev-parse HEAD)"
    echo "✓ promoted {{app}} + demo ${tag} -> prod"

# Wait until Argo CD has synced the given revision AND the app is Healthy. Reads
# Application status via kubectl (no `argocd login` needed); non-zero on timeout.
# Parameterised by Application name so it serves `deploy` (the local app) and
# `promote` (the prod apps — whose Application objects also live in the local
# argocd namespace, since the local Argo CD reconciles prod as a second destination).
_wait application revision:
    #!/usr/bin/env bash
    set -euo pipefail
    kc() { kubectl --context "{{kube_context}}" -n "{{argocd_ns}}" "$@"; }
    kc annotate application "{{application}}" argocd.argoproj.io/refresh=hard --overwrite >/dev/null 2>&1 || true
    deadline=$(( $(date +%s) + {{wait_timeout}} ))
    while :; do
      # NB: the trailing {"\n"} is load-bearing — without it kubectl emits no final
      # newline, so `read` hits EOF and returns non-zero, which `set -e` turns into
      # an immediate recipe abort (before the loop ever polls). The platform template
      # omits it; keep it here.
      read -r sync health rev < <(kc get application "{{application}}" \
        -o jsonpath='{.status.sync.status} {.status.health.status} {.status.sync.revision}{"\n"}' 2>/dev/null || echo "  ")
      echo "    sync=${sync:-?} health=${health:-?} rev=${rev:0:7}"
      if [[ "${sync}" == Synced && "${health}" == Healthy && "${rev}" == "{{revision}}" ]]; then
        echo "    ✓ ${rev:0:7} synced & healthy"; break
      fi
      if (( $(date +%s) >= deadline )); then
        echo "    ✗ timeout: {{application}} did not sync {{revision}} within {{wait_timeout}}s" >&2
        kc get application "{{application}}" -o jsonpath='{range .status.conditions[*]}{.type}: {.message}{"\n"}{end}' >&2 || true
        exit 1
      fi
      sleep 5
    done

# ── prune ─────────────────────────────────────────────────────────────────────
# Time-prefixed tags sort chronologically, so the newest sort last. crane delete
# untags old manifests; `registry garbage-collect` then reclaims their blobs.
# Each component repo is pruned independently (keep newest <keep> each).

# Keep only the newest <keep> tags PER component in the registry; GC the rest (standalone).
prune:
    #!/usr/bin/env bash
    set -euo pipefail
    pruned_any=0
    comp_specs="{{components}}"   # quote first: '|' is literal data here, not a shell pipe
    for spec in ${comp_specs}; do
      IFS='|' read -r name _ _ <<<"${spec}"
      img="{{image_base}}/${name}"
      mapfile -t tags < <(crane ls --insecure "${img}" 2>/dev/null | sort || true)
      n=${#tags[@]}
      if (( n <= {{keep}} )); then echo "==> ${img}: ${n} tag(s); nothing to prune (keep {{keep}})"; continue; fi
      old=("${tags[@]:0:$((n - {{keep}}))}")
      echo "==> prune ${#old[@]}/${n} tags from ${img} (keeping newest {{keep}})"
      for t in "${old[@]}"; do
        echo "    delete ${img}:${t}"
        crane delete --insecure "${img}:${t}" || true
      done
      pruned_any=1
    done
    if (( pruned_any )); then
      echo "==> garbage-collect registry blobs"
      podman exec "{{registry_ctr}}" registry garbage-collect --delete-untagged /etc/docker/registry/config.yml >/dev/null 2>&1 \
        || echo "    (GC skipped — registry not on this host / deletes disabled; tags were untagged regardless)"
    fi
    echo "✓ pruned"

# ── git hook (fallback) ───────────────────────────────────────────────────────
# Gitea Actions is the primary trigger; this post-commit hook is the server-less
# fallback. It runs `just deploy` in the background on every commit to main/master
# (single-flight via flock; log -> .git/deploy.log). It skips deploy's own
# "[skip ci]" tag commits (the same marker Gitea Actions honors natively), so it
# never loops.

# Install the post-commit auto-deploy hook.
hooks-install:
    #!/usr/bin/env bash
    set -euo pipefail
    hook="$(git rev-parse --git-dir)/hooks/post-commit"
    {
      printf '%s\n' '#!/usr/bin/env bash'
      printf '%s\n' '# HeavyOperations auto-deploy (installed by `just hooks-install`).'
      printf '%s\n' 'case "$(git rev-parse --abbrev-ref HEAD)" in main|master) ;; *) exit 0 ;; esac'
      printf '%s\n' 'case "$(git log -1 --pretty=%B)" in *"[skip ci]"*) exit 0 ;; esac'
      printf '%s\n' 'g="$(git rev-parse --git-dir)"'
      printf '%s\n' 'echo "post-commit: just deploy (log: ${g}/deploy.log)"'
      printf '%s\n' '( flock -n 9 || { echo "deploy already running; skipping" >&2; exit 0; }'
      printf '%s\n' '  just deploy >>"${g}/deploy.log" 2>&1 ) 9>"${g}/deploy.lock" &'
    } > "${hook}"
    chmod +x "${hook}"
    echo "installed ${hook}"
    echo "commits to main/master now auto-deploy; follow with:  tail -f .git/deploy.log"

# Remove the auto-deploy hook.
hooks-uninstall:
    rm -f "$(git rev-parse --git-dir)/hooks/post-commit" && echo "removed post-commit hook"

# ── acceptance ────────────────────────────────────────────────────────────────
# `just deploy` runs `just e2e` after Argo reports Healthy (step 5/6) to prove the
# just-rolled version REALLY works with the demo — not just that the pods are up.
# Two flavours:
#   e2e      — REAL browser + wallet (Playwright MetaMask extension under the
#              container Xvfb): exercises the actual frontend a user hits — wagmi
#              connect, the Comlink iframe<->parent handshake, in-browser EIP-4361
#              building, the wallet popup. This is the deploy gate.
#   e2e-api  — fast headless backend flow (curl + eth_account signer, no browser):
#              the full SIWE login through the demo asserting the ID-token claims.

# REAL browser + wallet SIWE login through the demo RP; gates `just deploy`.
e2e demo_url=e2e_demo login_url=e2e_login:
    DEMO_URL="{{demo_url}}" LOGIN_URL="{{login_url}}" tests/e2e/run-e2e.sh

# Fast headless backend SIWE login through the demo RP (no browser/display).
e2e-api demo_url=e2e_demo login_url=e2e_login:
    python3 tests/acceptance/demo_login.py "{{demo_url}}" "{{login_url}}"

# ── helpers ───────────────────────────────────────────────────────────────────

# Render the overlay locally (exactly what Argo CD will apply).
validate:
    kustomize build --enable-alpha-plugins --enable-exec {{overlay}}

# Show this app's Argo CD + pod status.
status:
    -kubectl --context {{kube_context}} -n {{argocd_ns}} get application {{app}}
    -kubectl --context {{kube_context}} -n {{app}} get pods
