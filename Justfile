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
#   just prune    keep only the newest <keep> tags PER component in the registry
#
# `just deploy` is the full pipeline and what the post-commit hook runs on every
# commit to main/master (install once with `just hooks-install`).

set shell := ["bash", "-uc"]

# ── Config ────────────────────────────────────────────────────────────────────
app           := "cryptoverse-login"   # app == k8s namespace == gitops repo == Argo CD app
registry      := "localhost:5000"
image_base    := registry / app        # per-component repos are <image_base>/<component>
overlay       := "deploy/overlays/local"
gitops_remote := "gitops"              # git remote -> gitops-repos/cryptoverse-login.git (Argo CD's source)
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
      git commit -q -m "deploy({{app}}): ${tag} [skip-deploy]"
    fi
    echo "    push HEAD -> {{gitops_remote}}/main"
    git push -q "{{gitops_remote}}" HEAD:main

    echo "==> [4/6] wait for Argo CD (timeout {{wait_timeout}}s)"
    just _wait "$(git rev-parse HEAD)"

    echo "==> [5/6] e2e acceptance — full SIWE login through the demo RP"
    just e2e

    echo "==> [6/6] prune"
    just prune
    echo "✓ deployed {{app}} ${tag}"

# Wait until Argo CD has synced the given revision AND the app is Healthy. Reads
# Application status via kubectl (no `argocd login` needed); non-zero on timeout.
_wait revision:
    #!/usr/bin/env bash
    set -euo pipefail
    kc() { kubectl --context "{{kube_context}}" -n "{{argocd_ns}}" "$@"; }
    kc annotate application "{{app}}" argocd.argoproj.io/refresh=hard --overwrite >/dev/null 2>&1 || true
    deadline=$(( $(date +%s) + {{wait_timeout}} ))
    while :; do
      # NB: the trailing {"\n"} is load-bearing — without it kubectl emits no final
      # newline, so `read` hits EOF and returns non-zero, which `set -e` turns into
      # an immediate recipe abort (before the loop ever polls). The platform template
      # omits it; keep it here.
      read -r sync health rev < <(kc get application "{{app}}" \
        -o jsonpath='{.status.sync.status} {.status.health.status} {.status.sync.revision}{"\n"}' 2>/dev/null || echo "  ")
      echo "    sync=${sync:-?} health=${health:-?} rev=${rev:0:7}"
      if [[ "${sync}" == Synced && "${health}" == Healthy && "${rev}" == "{{revision}}" ]]; then
        echo "    ✓ ${rev:0:7} synced & healthy"; break
      fi
      if (( $(date +%s) >= deadline )); then
        echo "    ✗ timeout: {{app}} did not sync {{revision}} within {{wait_timeout}}s" >&2
        kc get application "{{app}}" -o jsonpath='{range .status.conditions[*]}{.type}: {.message}{"\n"}{end}' >&2 || true
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

# ── git hook ──────────────────────────────────────────────────────────────────
# The hook runs `just deploy` in the background on every commit to main/master
# (single-flight via flock; log -> .git/deploy.log). It skips deploy's own
# "[skip-deploy]" tag commits, so it never loops.

# Install the post-commit auto-deploy hook.
hooks-install:
    #!/usr/bin/env bash
    set -euo pipefail
    hook="$(git rev-parse --git-dir)/hooks/post-commit"
    {
      printf '%s\n' '#!/usr/bin/env bash'
      printf '%s\n' '# HeavyOperations auto-deploy (installed by `just hooks-install`).'
      printf '%s\n' 'case "$(git rev-parse --abbrev-ref HEAD)" in main|master) ;; *) exit 0 ;; esac'
      printf '%s\n' 'case "$(git log -1 --pretty=%B)" in *"[skip-deploy]"*) exit 0 ;; esac'
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
