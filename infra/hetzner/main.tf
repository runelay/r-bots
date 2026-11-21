provider "hcloud" {
  token = var.hcloud_token
}

resource "hcloud_ssh_key" "admin" {
  name       = "${var.server_name}-admin"
  public_key = var.ssh_public_key
}

resource "hcloud_firewall" "server" {
  name = "${var.server_name}-firewall"

  dynamic "rule" {
    for_each = length(var.ssh_allowed_cidrs) > 0 ? [1] : []
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = "22"
      source_ips = var.ssh_allowed_cidrs
    }
  }

  rule {
    direction  = "in"
    protocol   = "udp"
    port       = "41641"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

data "cloudinit_config" "server" {
  gzip          = false
  base64_encode = false

  part {
    content_type = "text/cloud-config"
    content = templatefile("${path.module}/cloud-init.yaml.tftpl", {
      app_user                = var.app_user
      ssh_public_key          = var.ssh_public_key
      tailscale_auth_key      = var.tailscale_auth_key
      tailscale_hostname      = var.server_name
      repo_url                = var.repo_url
      repo_ref                = var.repo_ref
      gateway_port            = var.gateway_port
      tailscale_serve_port    = var.tailscale_serve_port
      install_sandbox_runtime = var.install_sandbox_runtime
    })
  }
}

resource "hcloud_server" "server" {
  name         = var.server_name
  server_type  = var.server_type
  location     = var.location
  image        = var.image
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.server.id]
  user_data    = data.cloudinit_config.server.rendered

  labels = {
    app = "runelay-bots"
  }

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  lifecycle {
    ignore_changes = [user_data, ssh_keys, image]
  }
}
