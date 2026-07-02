# Destroy/replace guard (conftest) — VENDORED from the HeavyOperations control
# repo (infra/policy/guardrails.rego); keep in sync when the platform's copy
# changes. This DNS layer manages no protected type on purpose: the Cloudflare
# zone is consumed as a data source (never managed — managing it would mean
# adding "cloudflare_zone" below), and DNS records are routine to replace, so
# they stay unprotected. The platform types are kept verbatim so the gate is
# identical everywhere and free to inherit future protected resources.
#
# A forced-new on an immutable attribute (or an accidental var/default change)
# can turn a routine plan into "replace the MKS cluster" or "destroy the
# subnet". This fails any plan that would DELETE or REPLACE a foundational
# resource, unless the PR carries the reviewed `infra:allow-destroy` label
# (CI passes allow_destroy=true).
package main

import rego.v1

protected := {
	"ovh_cloud_project_kube", # the prod cluster
	"ovh_cloud_project_network_private", # the node subnet's network
	"ovh_vrack_cloudproject", # the shared L2 attach
	"ovh_cloud_project_containerregistry", # Harbor (all promoted images)
	"ovh_dedicated_server", # a project's egress relay (physical box)
}

# Override, set by CI only when the reviewed `infra:allow-destroy` label is present.
allow_destroy if input.allow_destroy == true

deny contains msg if {
	rc := input.resource_changes[_]
	protected[rc.type]
	rc.change.actions[_] == "delete"
	not allow_destroy
	msg := sprintf("guardrail: plan would DESTROY protected %q — requires the reviewed 'infra:allow-destroy' label", [rc.address])
}

# A replace shows up as both create and delete in the actions set (either order).
deny contains msg if {
	rc := input.resource_changes[_]
	protected[rc.type]
	"create" in rc.change.actions
	"delete" in rc.change.actions
	not allow_destroy
	msg := sprintf("guardrail: plan would REPLACE protected %q (forced-new) — review the immutable-attribute change", [rc.address])
}
