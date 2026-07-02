# DNS-layer state lives in OVH Object Storage (eu-west-par — the region OVH
# confirms supports S3 conditional writes, so native `use_lockfile` locking
# works), in this project's OWN state bucket. Only the cryptoverse-login
# per-layer S3 users are scoped to it: the plan job's RO keypair reads state,
# the manual apply job's RW keypair writes it (same split as the platform's
# base layer — see HeavyOperations docs/INFRA_CICD.md).
terraform {
  backend "s3" {
    bucket = "heavyops-tfstate-cryptoverse-login"
    key    = "terraform.tfstate"
    region = "eu-west-par"

    endpoints = {
      s3 = "https://s3.eu-west-par.io.cloud.ovh.net/"
    }

    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
