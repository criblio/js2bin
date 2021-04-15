#!/bin/bash
docker pull moby/buildkit:buildx-stable-1
if [ $(docker buildx ls | grep js2bin-builder  | wc -l) -eq 0 ]; then
    docker buildx create --name js2bin-builder
fi
docker buildx use js2bin-builder
docker buildx build -t "cribl/js2bin-builder:latest-nonx64" --platform linux/arm64/v8 --push -f Dockerfile.ubuntu .
docker build -t "cribl/js2bin-builder:latest" -f Dockerfile.centos6 .
docker push "cribl/js2bin-builder:latest"
