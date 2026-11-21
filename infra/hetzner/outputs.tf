output "server_name" {
  value = hcloud_server.server.name
}

output "ipv4_address" {
  value = hcloud_server.server.ipv4_address
}

output "ipv6_address" {
  value = hcloud_server.server.ipv6_address
}
