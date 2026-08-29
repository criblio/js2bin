#!/usr/bin/env bash
set -ex

NVM_VERSION="v0.40.1"

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash
