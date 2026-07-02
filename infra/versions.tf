# DNS layer engine + provider pins. OpenTofu >= 1.10 for native S3
# `use_lockfile` locking (see backend.tf). The exact provider build is pinned
# by the committed .terraform.lock.hcl (regenerate with `tofu init -upgrade`).
terraform {
  required_version = ">= 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}
