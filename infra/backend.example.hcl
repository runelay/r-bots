bucket                      = "runelay-bots-tofu-state"
key                         = "selfhost/terraform.tfstate"
region                      = "auto"
use_path_style              = true
use_lockfile                = true
skip_credentials_validation = true
skip_region_validation      = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
skip_s3_checksum            = true

endpoints = {
  s3 = "https://ACCOUNT_ID.r2.cloudflarestorage.com"
}
