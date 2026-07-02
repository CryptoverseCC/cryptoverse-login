# No secrets in variables — the Cloudflare token is env-only (providers.tf).

variable "zone" {
  description = "Cloudflare zone (apex domain) holding this app's records."
  type        = string
}

variable "hosts" {
  description = "Subdomain labels (relative to the zone) that point at the prod ingress, e.g. [\"login\", \"login-demo\"]."
  type        = list(string)
}

variable "ingress_target" {
  description = "The OVH prod ingress LB address every host points at — a hostname (record_type = \"CNAME\") or an IPv4 (record_type = \"A\"). No default: filled via terraform.tfvars once the prod ingress exists."
  type        = string
}

variable "record_type" {
  description = "Record type matching the shape of ingress_target: CNAME for a hostname, A for an IPv4."
  type        = string
  default     = "CNAME"

  validation {
    condition     = contains(["A", "CNAME"], var.record_type)
    error_message = "record_type must be \"A\" or \"CNAME\"."
  }
}

variable "ttl" {
  description = "Record TTL in seconds (Cloudflare minimum 60, or 1 = automatic). Only meaningful while proxied = false, which is this layer's deliberate default."
  type        = number
  default     = 300
}
