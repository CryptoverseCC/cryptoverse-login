# The app's prod DNS — and nothing else. The zone itself is NOT managed here:
# it is read via a data source (owned at the Cloudflare-account level); this
# layer only owns records inside it. DNS-only (proxied = false) on purpose:
# the IdP terminates TLS on the OVH ingress via cert-manager, so flipping a
# record behind the Cloudflare proxy (or adding WAF/rules) is a deliberate
# later change, not a v1 default.

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone
  }
}

resource "cloudflare_dns_record" "app" {
  for_each = toset(var.hosts)

  zone_id = data.cloudflare_zone.this.zone_id
  name    = "${each.value}.${var.zone}"
  type    = var.record_type
  content = var.ingress_target
  ttl     = var.ttl
  proxied = false
}
