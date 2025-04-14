#!/bin/bash
docker pull moby/buildkit:buildx-stable-1
if [ $(docker buildx ls | grep js2bin-builder  | wc -l) -eq 0 ]; then
    docker buildx create --name js2bin-builder
fi
docker run --rm --privileged tonistiigi/binfmt --install all
docker buildx use js2bin-builder
BUILDER_IMAGE_VERSION="3"
ARCH=$(uname -m)
if [ "$ARCH" == "x86_64" ]; then
    echo "WARNING: You are running on an x86_64 host. Cross-compiling Python for arm64 may result in build failures or inconsistent behavior."
    echo "It is recommended to run this script on an arm64 host if possible."
fi
docker buildx build -t "cribl/js2bin-builder:${BUILDER_IMAGE_VERSION}-nonx64" --platform linux/arm64/v8 --push -f Dockerfile.centos7.arm64 .
docker buildx build -t "cribl/js2bin-builder:${BUILDER_IMAGE_VERSION}" --platform linux/amd64 --push -f Dockerfile.centos7 .

