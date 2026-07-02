# The Cloudflare token comes ONLY from the CLOUDFLARE_API_TOKEN env var — the
# provider reads it natively, so it never appears in code, tfvars, plan output
# or logs. The plan + drift jobs inject the READ-ONLY zone/DNS token under
# that same env name; the manual apply job is the only place the DNS:Edit
# token exists.
provider "cloudflare" {}
