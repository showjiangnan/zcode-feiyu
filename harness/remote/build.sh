#!/bin/bash
docker build \
  --build-arg SSH_PUBLIC_KEY="$(cat ~/.ssh/*.pub)" \
  -t my-ssh-server \
  .
