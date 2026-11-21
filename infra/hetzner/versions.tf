terraform {
  required_version = ">= 1.12.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "1.70.2"
    }
    cloudinit = {
      source  = "hashicorp/cloudinit"
      version = "2.4.1"
    }
  }

  backend "s3" {}
}
