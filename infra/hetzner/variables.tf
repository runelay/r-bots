variable "hcloud_token" {
  type      = string
  sensitive = true
}

variable "tailscale_auth_key" {
  type      = string
  sensitive = true

  validation {
    condition     = can(regex("^tskey-[A-Za-z0-9-]+$", var.tailscale_auth_key))
    error_message = "tailscale_auth_key must be a Tailscale auth key (tskey-...)."
  }
}

variable "ssh_public_key" {
  type = string

  validation {
    condition     = can(regex("^(ssh-|ecdsa-|sk-)[A-Za-z0-9@.-]+ [A-Za-z0-9+/=]+( [^\"\\n]*)?$", var.ssh_public_key))
    error_message = "ssh_public_key must be a single OpenSSH public key line."
  }
}

variable "ssh_allowed_cidrs" {
  type    = list(string)
  default = []
}

variable "server_name" {
  type    = string
  default = "rbots"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,62}$", var.server_name))
    error_message = "server_name must be lowercase letters, digits and dashes."
  }
}

variable "server_type" {
  type    = string
  default = "cx33"
}

variable "location" {
  type    = string
  default = "nbg1"
}

variable "image" {
  type    = string
  default = "ubuntu-24.04"
}

variable "app_user" {
  type    = string
  default = "rbots"

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]{0,31}$", var.app_user))
    error_message = "app_user must be a valid Linux user name."
  }
}

variable "repo_url" {
  type = string

  validation {
    condition     = can(regex("^(https://|git@)[A-Za-z0-9._@:/~-]+$", var.repo_url))
    error_message = "repo_url must be an https or ssh git URL."
  }
}

variable "repo_ref" {
  type    = string
  default = "main"

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.repo_ref))
    error_message = "repo_ref must be a branch or tag name."
  }
}

variable "gateway_port" {
  type    = number
  default = 2000
}

variable "tailscale_serve_port" {
  type    = number
  default = 10447
}

variable "install_sandbox_runtime" {
  type    = bool
  default = true
}
