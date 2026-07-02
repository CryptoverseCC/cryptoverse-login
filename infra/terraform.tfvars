# Committed ON PURPOSE — the pipeline plans from git, and these are non-secret
# identifiers only. The Cloudflare token is env-only (CLOUDFLARE_API_TOKEN)
# and must NEVER appear here.

zone  = "cryptoverse.cc"
hosts = ["login", "login-demo"] # the prod IdP + the demo RP (deploy/overlays/prod)

# The OVH prod ingress LB does not exist yet. RFC 2606 placeholder so the plan
# renders the record creates; the operator swaps in the real LB hostname (or
# IP + record_type = "A") in a follow-up PR. DO NOT dispatch tf-dns-apply
# while this placeholder is in place.
ingress_target = "prod-ingress-pending.invalid"
